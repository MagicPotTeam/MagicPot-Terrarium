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
const skills = [
  { id: 'skill-notes', name: 'release-notes', description: 'Draft release notes' },
  { id: 'skill-review', name: 'code-review', description: 'Review the diff' },
  { id: 'skill-research', name: 'Research' },
  { id: 'skill-poster', name: '海报设计', description: '设计活动海报' }
]

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

describe('resolveComposerSuggestions with skills', () => {
  const resolve = (value: string, withCommands = commands) =>
    resolveComposerSuggestions(value, withCommands, skills)?.items.map((item) => [
      item.kind,
      item.label
    ]) ?? null

  it('lists every command, then every skill, for a lone slash', () => {
    expect(resolve('/')).toEqual([
      ...commands.map((command) => ['command', `/${command.name}`]),
      ['skill', '/release-notes'],
      ['skill', '/code-review'],
      ['skill', '/Research'],
      ['skill', '/海报设计']
    ])
  })

  it('puts skills that start with the query before skills that only contain it', () => {
    expect(resolve('/re')).toEqual([
      ['command', '/regen'],
      ['command', '/repair-images'],
      ['skill', '/release-notes'],
      ['skill', '/Research'],
      ['skill', '/code-review']
    ])
    expect(resolve('/海')).toEqual([['skill', '/海报设计']])
    expect(resolve('/设计')).toEqual([['skill', '/海报设计']])
    expect(resolve('/zzz')).toBeNull()
  })

  it('offers skills without any command, and nothing once the draft is more than one token', () => {
    expect(resolve('/', [])).toEqual(skills.map((skill) => ['skill', `/${skill.name}`]))
    expect(resolve('/release-notes now', [])).toBeNull()
    expect(resolve('@re', [])).toBeNull()
  })

  it('never treats a skill as typed in full, and carries its id and description', () => {
    const items = resolveComposerSuggestions('/research', [], skills)!.items
    expect(items).toEqual([
      { kind: 'skill', label: '/Research', skillId: 'skill-research', description: '', typedInFull: false }
    ])
  })

  it('removes only the typed token when a skill is accepted', () => {
    const suggestions = resolveComposerSuggestions('/rel', commands, skills)!
    const skill = suggestions.items.find((item) => item.kind === 'skill')!
    expect(applyComposerSuggestion('/rel', suggestions, skill)).toEqual({ value: '', caret: 0 })
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
