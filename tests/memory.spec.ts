import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Memory, MemoryInputSchema as INPUT, entryId, memorySection, type MemoryVersion } from '../src/app/task-memory.ts'
import { KV } from '../src/kv.ts'
import { defaultPrompts, memorySection as mainMemorySection, policySection, composePrompt } from '../src/app/prompts.ts'
import { SettingsSchema } from '../src/policy.ts'

function withMemory(body: (memory: Memory, store: Store, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'memory-')); const store = new Store(join(dir, 'db'))
  try { body(new Memory(store), store, dir) } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}
const empty = (): MemoryVersion => ({ revision: 0, savedAt: '', source: 'defaults', task_classes: [], entries: [] })

describe('the task memory', () => {
  it('remembers nothing until a worker records a class, and shows no prompt section then', () => {
    withMemory(memory => {
      expect(memory.current()).toMatchObject({ revision: 0, task_classes: [], entries: [] })
      expect(memory.section()).toBe('')
      const read = memory.read()
      expect(read.memory).toMatchObject({ revision: 0, resource: 'memory', task_classes: [], entries: [] })
      expect(read.guide).toContain('orchestrator_memory')
      expect(read).not.toHaveProperty('changes')
    })
  })
  it('counts a class once unless the call restates its count, and saves the class with the ticket as its source', () => {
    withMemory(memory => {
      const first = memory.read(INPUT.parse({ task_class: 'bugfix', entries: [] }), 'ticket:t1')
      expect(first.changes).toEqual([{ id: 'bugfix', outcome: 'saved' }])
      expect(first.memory).toMatchObject({ revision: 1, source: 'ticket:t1', task_classes: [{ name: 'bugfix', count: 1 }] })
      // The same call again, as a retried tool call, adds nothing.
      expect(memory.read(INPUT.parse({ task_class: 'bugfix' })).changes).toEqual([{ id: 'bugfix', outcome: 'saved' }])
      expect(memory.current().task_classes).toEqual([{ name: 'bugfix', count: 1 }])
      expect(memory.current().revision).toBe(2)
      expect(memory.read(INPUT.parse({ task_class: 'bugfix', class_count: 4 })).memory.task_classes).toEqual([{ name: 'bugfix', count: 4 }])
      expect(memory.read(INPUT.parse({ task_class: 'docs', class_count: 1 })).memory.task_classes)
        .toEqual([{ name: 'bugfix', count: 4 }, { name: 'docs', count: 1 }])
    })
  })
  it('saves a trait of classes and a preference about one, replaces an entry of the same id, and drops the one a later message contradicts', () => {
    withMemory(memory => {
      memory.read(INPUT.parse({ task_class: 'bugfix' }))
      const saved = memory.read(INPUT.parse({ entries: [
        { id: 'reproduces-minimally', kind: 'trait', statement: 'Asks for a reproduction before a fix.', classes: ['bugfix'] },
        { id: 'without-a-screenshot', kind: 'preference', statement: 'Without a screenshot for visual bugs.', classes: ['bugfix'] },
        { id: 'short-answers', kind: 'preference', statement: 'Prefers short answers.' },
      ] }))
      expect(saved.changes).toEqual([{ id: 'reproduces-minimally', outcome: 'saved' }, { id: 'without-a-screenshot', outcome: 'saved' },
        { id: 'short-answers', outcome: 'saved' }])
      expect(saved.memory.entries).toEqual([
        { id: 'reproduces-minimally', kind: 'trait', statement: 'Asks for a reproduction before a fix.', classes: ['bugfix'], updated_at: expect.any(String) },
        { id: 'without-a-screenshot', kind: 'preference', statement: 'Without a screenshot for visual bugs.', classes: ['bugfix'], updated_at: expect.any(String) },
        { id: 'short-answers', kind: 'preference', statement: 'Prefers short answers.', classes: ['all'], updated_at: expect.any(String) },
      ])
      // Stating it the same way again holds one entry.
      expect(memory.read(INPUT.parse({ entries: [{ id: 'short-answers', kind: 'preference', statement: 'Prefers short answers.', classes: [] }] })).changes)
        .toEqual([{ id: 'short-answers', outcome: 'duplicate' }])
      // A corrected statement replaces the entry an id names.
      const corrected = memory.read(INPUT.parse({ entries: [{ id: 'short-answers', kind: 'preference', statement: 'Prefers short answers, in Chinese.' }] }))
      expect(corrected.changes).toEqual([{ id: 'short-answers', outcome: 'saved' }])
      expect(corrected.memory.entries.filter(entry => entry.id === 'short-answers')).toEqual([expect.objectContaining({ statement: 'Prefers short answers, in Chinese.' })])
      // Another id that states the same is a duplicate, which names the one that holds it.
      expect(memory.read(INPUT.parse({ entries: [{ id: 'short-again', kind: 'preference', statement: 'Prefers short answers, in Chinese.' }] })).changes)
        .toEqual([{ id: 'short-again', outcome: 'duplicate', reason: 'An entry of another id states the same' }])
      expect(memory.read(INPUT.parse({ remove: ['short-answers', 'nothing'] })).changes)
        .toEqual([{ id: 'short-answers', outcome: 'saved' }, { id: 'nothing', outcome: 'refused', reason: 'The memory holds no such entry' }])
      expect(memory.current().entries.map(entry => entry.id)).toEqual(['reproduces-minimally', 'without-a-screenshot'])
    })
  })
  it('refuses one bad entry with why, and saves the entries beside it', () => {
    withMemory(memory => {
      memory.read(INPUT.parse({ task_class: 'bugfix' }))
      const result = memory.read(INPUT.parse({ entries: [
        { id: 'unknown-class', kind: 'trait', statement: 'One.', classes: ['visual', 'bugfix'] },
        { id: 'valid', kind: 'trait', statement: 'Two.', classes: ['bugfix'] },
      ] }))
      expect(result.changes).toEqual([{ id: 'unknown-class', outcome: 'refused', reason: 'Unknown task class: visual' }, { id: 'valid', outcome: 'saved' }])
      expect(result.memory.entries.map(entry => entry.id)).toEqual(['valid'])
    })
  })
  it('keeps the recent values of one entry, a drop included, and names none it never held', () => {
    withMemory(memory => {
      for (const statement of ['One.', 'Two.', 'Three.', 'Four.']) memory.read(INPUT.parse({ entries: [{ id: 'changing', kind: 'trait', statement }] }))
      memory.read(INPUT.parse({ remove: ['changing'] }))
      const history = memory.history('changing')!
      expect(history.id).toBe('changing')
      // Newest first: the drop, then the two values the kept snapshots still hold.
      expect(history.items.map(item => 'dropped' in item ? 'dropped' : item.entry?.statement)).toEqual(['dropped', 'Four.', 'Three.'])
      // One of a few running revisions shows the entry as it was, a later save of the same value again, and the drop.
      memory.read(INPUT.parse({ entries: [{ id: 'changing', kind: 'trait', statement: 'Five.' }] }))
      memory.read(INPUT.parse({ entries: [{ id: 'changing', kind: 'trait', statement: 'Five.' }] }))
      memory.read(INPUT.parse({ remove: ['changing'] }))
      // Revisions 5 to 7 hold the same value, which revision 8 dropped.
      expect(memory.history('changing')!.items.map(item => item.revision)).toEqual([7, 6, 4])
      // A save of another entry leaves this one as it was, which is not a value of it.
      memory.read(INPUT.parse({ entries: [{ id: 'other', kind: 'trait', statement: 'Other.' }] }))
      // The memory still holds no value of it: the drop stands, and the snapshot that saved it is its newest value.
      expect(memory.history('changing')!.items.map(item => 'dropped' in item ? 'dropped' : item.entry?.statement)).toEqual(['dropped', 'Five.', 'Four.'])
      expect(memory.history('never')).toBeUndefined()
    })
  })
  it('saves nothing when a call changes nothing, so the revision names every change', () => {
    withMemory((memory, store) => {
      memory.read(INPUT.parse({ entries: [{ id: 'one', kind: 'trait', statement: 'One.' }] }))
      const revision = store.get(KV.memory.revision), saved = store.get(KV.memory.version(revision!))
      expect(memory.read(INPUT.parse({ entries: [{ id: 'one', kind: 'trait', statement: 'One.' }] })).changes).toEqual([{ id: 'one', outcome: 'duplicate' }])
      expect(store.get(KV.memory.revision)).toBe(revision)
      expect(store.get(KV.memory.version(revision!))).toEqual(saved)
    })
  })
})

describe('the Memory section of a prompt', () => {
  const memory = (): MemoryVersion => ({ ...empty(), revision: 3, task_classes: [{ name: 'bugfix', count: 4 }, { name: 'docs', count: 1 },
    { name: 'visual polish', count: 2 }], entries: [
    { id: 'reproduces-minimally', kind: 'trait', statement: 'Asks for a reproduction before\na fix.', classes: ['bugfix'], updated_at: '' },
    { id: 'no-screenshots', kind: 'preference', statement: 'Without a screenshot for visual bugs.', classes: ['bugfix'], updated_at: '' },
    { id: 'short-answers', kind: 'preference', statement: 'Prefers short answers.', classes: [], updated_at: '' },
  ] })
  it('lists the classes by count and the entries, on one line each, as data rather than instructions', () => {
    const section = memorySection(memory())
    const lines = section.split('\n')
    expect(lines[0]).toBe('## Memory')
    expect(lines).toContain('Classes and their tickets: bugfix ×4; docs ×1; visual polish ×2.')
    expect(lines).toContain('- Trait [bugfix] Asks for a reproduction before a fix.')
    expect(lines).toContain('- Preference [bugfix] Without a screenshot for visual bugs.')
    expect(lines).toContain('- Preference [all tasks] Prefers short answers.')
    expect(section).toContain('no rule is met by memory alone')
    // No entry can pass for a section of its own.
    expect(lines.filter(line => line.startsWith('#'))).toEqual(['## Memory'])
  })
  it('caps the listed classes and says none is known yet', () => {
    const many = memory()
    many.task_classes = Array.from({ length: 12 }, (_, index) => ({ name: `class-${index}`, count: 1 }))
    const listed = memorySection(many).split('\n')[2]!
    expect(listed).toContain('class-7 ×1.')
    expect(listed).not.toContain('class-8')
    expect(memorySection({ ...empty(), task_classes: [], entries: [{ id: 'one', kind: 'trait', statement: 'One.', classes: [], updated_at: '' }] }))
      .toContain('Classes and their tickets: none yet.')
  })
  it('follows the mandate instructions in a worker prompt and the Policy in the main Session\'s, whose section a memory change leaves still last', () => {
    withMemory(memory => {
      const config = defaultPrompts(), settings = SettingsSchema.parse({})
      const policy = policySection(settings, config)
      const section = mainMemorySection(memory, config)
      expect(section.key).toBe('runtime/memory')
      expect(memorySection(memory.current())).toBe('')
      expect(section.text.startsWith('## Memory\nMemory, by which you classify what you route:')).toBe(true)
      // The Memory section precedes the Policy, which nothing follows, and a save may change the Policy alone.
      const main = composePrompt(config, 'orchestrator', 'env', policy, section)
      expect(main.endsWith(`${section.text}\n\n${policy.text}`)).toBe(true)
      expect(section.text.startsWith('## Memory\n')).toBe(true)
      expect(section.text).not.toContain('## Memory\n## Memory')
      expect(composePrompt(config, 'worker', 'env')).not.toContain('## Memory')
    })
  })
})

it('names an entry by the words of its statement, so a reworded one keeps its id and a statement of none keeps a digest', () => {
  expect(entryId('Asks for a reproduction before a fix.')).toBe('asks-reproduction-fix')
  expect(entryId('Asks for the reproduction before a fix')).toBe('asks-reproduction-fix')
  expect(entryId('The user wants the regression fixed first')).toBe('user-wants-regression-fixed-first')
  expect(entryId('修复前要先复现')).toMatch(/^item-[a-z0-9]{12}$/)
  expect(entryId('修复前要先复现')).toBe(entryId('修复前要先复现'))
  expect(entryId('a an the of')).toMatch(/^item-[a-z0-9]+$/)
  expect(entryId(Array.from({ length: 12 }, (_, index) => `word${index}`).join(' '))).toBe('word0-word1-word2-word3-word4-word5')
})