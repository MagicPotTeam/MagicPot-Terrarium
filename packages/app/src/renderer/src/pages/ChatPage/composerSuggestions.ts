import type { ComposerCommand, ComposerSuggestionTextKey } from './composerCommandCatalog'

/** A skill the conversation can select, offered in the second group of the "/" list. */
export type ComposerSkillSuggestion = {
  id: string
  name: string
  description?: string
}

export type ComposerCommandSuggestionItem = {
  kind: 'command'
  /** "/status", exactly as it is inserted. */
  label: string
  argumentHintKey?: ComposerSuggestionTextKey
  descriptionKey: ComposerSuggestionTextKey
  /** The typed token already is this command, so Enter keeps running it as before. */
  typedInFull: boolean
}

export type ComposerSkillSuggestionItem = {
  kind: 'skill'
  /** "/<skill name>"; accepting it selects the skill instead of inserting text. */
  label: string
  skillId: string
  description: string
  typedInFull: false
}

export type ComposerSuggestionItem = ComposerCommandSuggestionItem | ComposerSkillSuggestionItem

export type ComposerSuggestions = {
  /** Changes whenever the list has to restart its highlight. */
  key: string
  /** End of the token that an accepted item replaces. */
  tokenEnd: number
  /** Commands first, then skills. */
  items: ComposerSuggestionItem[]
}

/** DOM id of one option, shared by the list and the textarea's aria-activedescendant. */
export const getComposerSuggestionOptionId = (listId: string, index: number) =>
  `${listId}-option-${index}`

const NO_SKILLS: readonly ComposerSkillSuggestion[] = []

/** Skills whose name starts with the query come first, then those that only contain it. */
const matchSkills = (
  query: string,
  skills: readonly ComposerSkillSuggestion[]
): ComposerSkillSuggestionItem[] => {
  const item = (skill: ComposerSkillSuggestion): ComposerSkillSuggestionItem => ({
    kind: 'skill',
    label: `/${skill.name}`,
    skillId: skill.id,
    description: skill.description ?? '',
    typedInFull: false
  })
  if (!query) return skills.map(item)
  const starting: ComposerSkillSuggestionItem[] = []
  const containing: ComposerSkillSuggestionItem[] = []
  for (const skill of skills) {
    const position = skill.name.toLowerCase().indexOf(query)
    if (position === 0) starting.push(item(skill))
    else if (position > 0) containing.push(item(skill))
  }
  return [...starting, ...containing]
}

/** Suggestions for a draft that is one "/token"; anything else (also "@name task") has none. */
export function resolveComposerSuggestions(
  value: string,
  commands: readonly ComposerCommand[],
  skills: readonly ComposerSkillSuggestion[] = NO_SKILLS
): ComposerSuggestions | null {
  // Parsers accept a command only as the first token; arguments end the completion.
  if ((!commands.length && !skills.length) || !/^\/\S*$/.test(value)) return null
  const query = value.slice(1).toLowerCase()
  const commandItems = commands.flatMap((command): ComposerSuggestionItem[] => {
    const name = [command.name, ...(command.aliases ?? [])].find((candidate) =>
      candidate.startsWith(query)
    )
    return name
      ? [
          {
            kind: 'command',
            label: `/${name}`,
            argumentHintKey: command.argumentHintKey,
            descriptionKey: command.descriptionKey,
            typedInFull: name === query
          }
        ]
      : []
  })
  const items = [...commandItems, ...matchSkills(query, skills)]
  return items.length ? { key: `/${query}`, tokenEnd: value.length, items } : null
}

/** The draft after an item is accepted. A skill only removes the typed token. */
export function applyComposerSuggestion(
  value: string,
  suggestions: ComposerSuggestions,
  item: ComposerSuggestionItem
): { value: string; caret: number } {
  const rest = value.slice(suggestions.tokenEnd)
  if (item.kind === 'skill') return { value: rest.replace(/^\s+/, ''), caret: 0 }
  const needsSpace = Boolean(item.argumentHintKey)
  const separator = needsSpace && !/^\s/.test(rest) ? ' ' : ''
  return {
    value: `${item.label}${separator}${rest}`,
    caret: item.label.length + (needsSpace ? 1 : 0)
  }
}
