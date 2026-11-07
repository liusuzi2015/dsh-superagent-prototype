import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { memorySection } from '../src/app/task-memory.ts'
import { memoryNotice } from '../src/executor/dsh.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('lets a worker record its ticket\'s class and a trait, and shows both in the prompt of its next turn', async () => {
  h = await startRuntime()
  const { runtime, runTool, sections } = h
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  expect(runtime.memory.current()).toMatchObject({ revision: 0, task_classes: [], entries: [] })
  // Nothing is remembered yet, so the prompt says nothing of memory.
  expect(runtime.memory.section()).toBe('')
  const changes = await runTool(sessionId, 'orchestrator_memory', { task_class: 'bugfix', class_count: 1, entries: [
    { id: 'reproduces-minimally', kind: 'trait', statement: 'Asks for a reproduction before a fix.', classes: ['bugfix'] },
    { kind: 'preference', statement: 'Without a screenshot for visual bugs.', classes: ['bugfix'] },
  ] })
  expect(changes).toEqual([{ id: 'bugfix', outcome: 'saved' }, { id: 'reproduces-minimally', outcome: 'saved' },
    { id: 'without-screenshot-visual-bugs', outcome: 'saved' }])
  expect(runtime.memory.current()).toMatchObject({ source: `ticket:${ticket.id}`, task_classes: [{ name: 'bugfix', count: 1 }] })
  // The main Session routes from what the worker records, so its notice waits, and the worker's next prompt shows the change,
  // which makes it an input of that request rather than one nothing logged.
  const section = runtime.memory.section()
  expect(section).toContain('Classes and their tickets: bugfix ×1.')
  expect(section).toContain('- Trait [bugfix] Asks for a reproduction before a fix.')
  const prompt = sections.get(sessionId)!.text({})
  expect(prompt.endsWith(`${section}\n${memoryNotice({ value: { memory_changed: ['bugfix', 'reproduces-minimally', 'without-screenshot-visual-bugs'],
    read: 'memory' }, summary: 'Task memory changed' })}`)).toBe(true)
  // The worker reads what its prompt shows, and the main Session's prompt shows the memory too.
  const read = await runTool(sessionId, 'orchestrator_read', { resource: 'memory' }) as { text: string }
  expect(JSON.parse(read.text)).toMatchObject({ memory: { revision: 1, task_classes: [{ name: 'bugfix', count: 1 }] } })
  expect(runtime.prompts.compose(runtime.prompts.current().config, 'orchestrator')).toContain('bugfix ×1')
  expect(memorySection(runtime.memory.current())).toBe(section)
})