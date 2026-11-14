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
const labels = (value: string) =>
  resolveComposerSuggestions(value, commands)?.items.map((item) => item.label) ?? null

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
    expect(resolveComposerSuggestions('/', [])).toBeNull()
  })

  it('marks a command that is already typed in full', () => {
    const items = resolveComposerSuggestions('/skill', commands)!.items
    expect(items.map((item) => [item.label, item.typedInFull])).toEqual([['/skill', true]])
    expect(resolveComposerSuggestions('/STATUS', commands)!.items[0]).toMatchObject({
      label: '/status',
      typedInFull: true
    })
    expect(resolveComposerSuggestions('/stat', commands)!.items[0].typedInFull).toBe(false)
  })

  it('never suggests anything for an "@" draft: "@name task" is plain text for the composer', () => {
    expect(labels('@')).toBeNull()
    expect(labels('@设')).toBeNull()
    expect(labels('@设计师')).toBeNull()
    expect(labels('@设计师 画一张海报')).toBeNull()
    expect(labels('hi @w')).toBeNull()
  })
})

describe('applyComposerSuggestion', () => {
  const accept = (value: string, label: string) => {
    const suggestions = resolveComposerSuggestions(value, commands)!
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
})
