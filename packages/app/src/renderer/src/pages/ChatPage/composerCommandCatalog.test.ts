import { describe, expect, it } from 'vitest'
import {
  COMPOSER_COMMANDS,
  listComposerCommands,
  type ComposerCommandContext
} from './composerCommandCatalog'
import { parseExplicitToolCommand } from './chatToolExecution'
import toolCommandSource from './chatToolExecution.ts?raw'
import enLocale from '@shared/locales/en-US/renderer.json'
import zhLocale from '@shared/locales/zh-CN/renderer.json'

// Every "*Command.ts" parser module next to the catalogue is discovered, so a new module
// (or a new name in an existing one) is checked without touching this test.
const parserModules = import.meta.glob<Record<string, unknown>>('./*Command.ts', { eager: true })
const parserSources = import.meta.glob<string>('./*Command.ts', {
  query: '?raw',
  import: 'default',
  eager: true
})

type Recognizer = (text: string) => boolean
const recognizers: Recognizer[] = [
  ...Object.values(parserModules).flatMap((module) =>
    Object.entries(module).flatMap(([name, value]) =>
      /^is[A-Z]\w*Command$/.test(name) && typeof value === 'function' ? [value as Recognizer] : []
    )
  ),
  // "/tool" has no is*Command predicate; it needs a tool name to parse.
  (text) => parseExplicitToolCommand(`${text} probe`) !== null
]
const understood = (name: string) =>
  recognizers.filter((recognizes) => recognizes(`/${name}`)).length

/**
 * Names the parsers accept, found by probing their sources: every literal word (also with
 * "_"/"-" inside), every prefix of one ("skills?"), and neighbouring words joined by a
 * separator ("repair[_-]images").
 */
const namesUnderstoodByParsers = () => {
  const names = new Set<string>()
  const probe = (candidate: string) => {
    if (understood(candidate)) names.add(candidate)
  }
  for (const source of [...Object.values(parserSources), toolCommandSource]) {
    const text = source.toLowerCase()
    for (const word of text.match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
      for (let end = 1; end <= word.length; end++) probe(word.slice(0, end))
    }
    const plainWords = text.match(/[a-z0-9]+/g) ?? []
    plainWords.forEach((word, index) => {
      const next = plainWords[index + 1]
      if (next) {
        probe(`${word}_${next}`)
        probe(`${word}-${next}`)
      }
    })
  }
  return [...names].sort()
}

const catalogueNames = COMPOSER_COMMANDS.flatMap((command) => [
  command.name,
  ...(command.aliases ?? [])
])
const everything: ComposerCommandContext = {
  remote: false,
  canvasThread: true,
  scratchpad: true,
  boundTools: true,
  teamMember: false
}
const names = (context: ComposerCommandContext) =>
  listComposerCommands(context).map((command) => command.name)

describe('composerCommandCatalog', () => {
  it('discovers the parser modules it is compared with', () => {
    expect(Object.keys(parserModules).sort()).toEqual([
      './agentBasicCommand.ts',
      './agentConfigurationCommand.ts',
      './agentGoalCommand.ts',
      './agentInspectionCommand.ts',
      './agentScratchpadCommand.ts',
      './agentSideCommand.ts',
      './agentSkillCommand.ts',
      './repairImagesCommand.ts',
      './replayUserCommand.ts'
    ])
    expect(recognizers).toHaveLength(10)
  })

  it('lists exactly the commands the parsers understand', () => {
    expect([...catalogueNames].sort()).toEqual(namesUnderstoodByParsers())
  })

  it('maps every name and alias to exactly one parser, with or without arguments', () => {
    expect(new Set(catalogueNames).size).toBe(catalogueNames.length)
    for (const name of catalogueNames) {
      expect([name, understood(name)]).toEqual([name, 1])
      expect([name, understood(`${name} argument`)]).toEqual([name, 1])
      expect([name, understood(name.toUpperCase())]).toEqual([name, 1])
      expect([name, understood(`${name}x`)]).toEqual([name, 0])
    }
  })

  it('has every description and argument hint in both locales', () => {
    const keys = COMPOSER_COMMANDS.flatMap((command) => [
      command.descriptionKey,
      ...(command.argumentHintKey ? [command.argumentHintKey] : [])
    ])
    for (const locale of [enLocale, zhLocale]) {
      for (const key of keys) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown> | undefined)?.[part],
            locale
          )
        expect([key, typeof value === 'string' && value.trim().length > 0]).toEqual([key, true])
      }
    }
  })

  it('offers each command only where ChatPage runs it', () => {
    expect(names(everything)).toEqual(COMPOSER_COMMANDS.map((command) => command.name))
    // A plain (non-canvas) local chat has no thread goals, jobs, side questions, skills panel or notes.
    expect(names({ ...everything, canvasThread: false })).toEqual([
      'status',
      'compact',
      'branch',
      'regen',
      'edit',
      'repair-images',
      'env',
      'system_prompt',
      'plugin',
      'module',
      'video_gen',
      'tool'
    ])
    // The remote service only keeps the commands that never need the local model or files.
    expect(names({ ...everything, remote: true })).toEqual([
      'status',
      'compact',
      'env',
      'system_prompt',
      'plugin',
      'module',
      'video_gen',
      'tool'
    ])
    expect(names(everything)[0]).toBe('goal')
    expect(names({ ...everything, scratchpad: false })).not.toContain('scratchpad')
    expect(names({ ...everything, boundTools: false })).not.toContain('tool')
    // Member conversations reject compaction and direct tool calls.
    expect(names({ ...everything, teamMember: true })).toEqual(
      COMPOSER_COMMANDS.map((command) => command.name).filter(
        (name) => name !== 'compact' && name !== 'tool'
      )
    )
  })
})
