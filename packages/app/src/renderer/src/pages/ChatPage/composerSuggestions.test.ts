import { describe, expect, it } from 'vitest'
import { listComposerCommands } from './composerCommandCatalog'
import { applyComposerSuggestion, resolveComposerSuggestions } from './composerSuggestions'

const commands = listComposerCommands({
  remote: false,
  canvasThread: true,
  scratchpad: true,
  boundTools: false,
  teamMember: false
})
const members = [
  { name: '设计师', detail: '界面设计' },
  { name: 'Writer', detail: 'Copy' },
  { name: 'writer2' }
]
const labels = (value: string, caret = value.length, withMembers = members) =>
  resolveComposerSuggestions(value, caret, commands, withMembers)?.items.map(
    (item) => item.label
  ) ?? null

describe('resolveComposerSuggestions', () => {
  it('lists every available command for a lone slash and filters by prefix without regard to case', () => {
    expect(labels('/')).toEqual(commands.map((command) => `/${command.name}`))
    expect(labels('/co')).toEqual(['/compact'])
    expect(labels('/S')).toEqual(['/status', '/skill', '/scratchpad', '/system_prompt'])
    expect(labels('/zzz')).toBeNull()
  })

  it('suggests an alias only when the typed prefix asks for it', () => {
    expect(labels('/p')).toEqual(['/pad', '/plugin'])
    expect(labels('/skills')).toEqual(['/skills'])
    expect(labels('/repair_')).toEqual(['/repair_images'])
    expect(labels('/r')).toEqual(['/regen', '/repair-images'])
  })

  it('stops as soon as the input is more than one slash token', () => {
    expect(labels('/btw ')).toBeNull()
    expect(labels('/btw why')).toBeNull()
    expect(labels(' /btw')).toBeNull()
    expect(labels('hello /btw')).toBeNull()
    expect(labels('/co\n')).toBeNull()
    expect(resolveComposerSuggestions('/', 1, [], members)).toBeNull()
  })

  it('marks a command that is already typed in full', () => {
    const items = resolveComposerSuggestions('/skill', 6, commands, [])!.items
    expect(items.map((item) => [item.label, item.typedInFull])).toEqual([['/skill', true]])
    expect(resolveComposerSuggestions('/STATUS', 7, commands, [])!.items[0]).toMatchObject({
      label: '/status',
      typedInFull: true
    })
    expect(resolveComposerSuggestions('/stat', 5, commands, [])!.items[0].typedInFull).toBe(false)
  })

  it('offers members only while the caret is inside a leading @ token', () => {
    expect(labels('@')).toEqual(['@设计师', '@Writer', '@writer2'])
    expect(labels('@w')).toEqual(['@Writer', '@writer2'])
    expect(labels('@设')).toEqual(['@设计师'])
    expect(labels('@nobody')).toBeNull()
    // Caret inside the token while a task already follows it.
    expect(labels('@wr draw a cat', 3)).toEqual(['@Writer', '@writer2'])
    expect(labels('@wr draw a cat', 2)).toEqual(['@Writer', '@writer2'])
    // Caret before the "@", after the token, or a selected range (-1).
    expect(labels('@wr draw a cat', 0)).toBeNull()
    expect(labels('@wr draw a cat', 4)).toBeNull()
    expect(labels('@wr', -1)).toBeNull()
    // The parser only accepts "@name" at the very start.
    expect(labels(' @w')).toBeNull()
    expect(labels('hi @w')).toBeNull()
    expect(labels('@', 1, [])).toBeNull()
  })
})

describe('applyComposerSuggestion', () => {
  const accept = (value: string, label: string, caret = value.length) => {
    const suggestions = resolveComposerSuggestions(value, caret, commands, members)!
    return applyComposerSuggestion(
      value,
      suggestions,
      suggestions.items.find((item) => item.label === label)!
    )
  }

  it('adds a trailing space only for commands that take arguments', () => {
    expect(accept('/co', '/compact')).toEqual({ value: '/compact', caret: 8 })
    expect(accept('/b', '/btw')).toEqual({ value: '/btw ', caret: 5 })
    expect(accept('/ED', '/edit')).toEqual({ value: '/edit ', caret: 6 })
  })

  it('replaces the whole @ token and keeps the task that follows', () => {
    expect(accept('@设', '@设计师')).toEqual({ value: '@设计师 ', caret: 5 })
    expect(accept('@wr draw a cat', '@writer2', 2)).toEqual({
      value: '@writer2 draw a cat',
      caret: 9
    })
    expect(accept('@w\ndraw', '@Writer', 2)).toEqual({ value: '@Writer\ndraw', caret: 8 })
  })
})
