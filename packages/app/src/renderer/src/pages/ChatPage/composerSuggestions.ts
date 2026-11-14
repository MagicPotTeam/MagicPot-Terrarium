import type { ComposerCommand, ComposerSuggestionTextKey } from './composerCommandCatalog'

export type ComposerMentionMember = {
  name: string
  /** Role, shown after the name. */
  detail?: string
  /** The member is working; a new "@name task" is refused until it finishes. */
  running?: boolean
}

export type ComposerSuggestionItem = {
  /** "/status" or "@name", exactly as it is inserted. */
  label: string
  argumentHintKey?: ComposerSuggestionTextKey
  descriptionKey?: ComposerSuggestionTextKey
  detail?: string
  running?: boolean
  /** The typed token already is this command, so Enter keeps running it as before. */
  typedInFull: boolean
}

export type ComposerSuggestions = {
  kind: 'command' | 'member'
  /** Changes whenever the list has to restart its highlight. */
  key: string
  /** End of the token that an accepted item replaces. */
  tokenEnd: number
  items: ComposerSuggestionItem[]
}

/** DOM id of one option, shared by the list and the textarea's aria-activedescendant. */
export const getComposerSuggestionOptionId = (listId: string, index: number) =>
  `${listId}-option-${index}`

const commandSuggestions = (
  value: string,
  commands: readonly ComposerCommand[]
): ComposerSuggestions | null => {
  // Parsers accept a command only as the first token; arguments end the completion.
  if (!/^\/\S*$/.test(value)) return null
  const query = value.slice(1).toLowerCase()
  const items = commands.flatMap((command): ComposerSuggestionItem[] => {
    const name = [command.name, ...(command.aliases ?? [])].find((candidate) =>
      candidate.startsWith(query)
    )
    return name
      ? [
          {
            label: `/${name}`,
            argumentHintKey: command.argumentHintKey,
            descriptionKey: command.descriptionKey,
            typedInFull: name === query
          }
        ]
      : []
  })
  return items.length ? { kind: 'command', key: `/${query}`, tokenEnd: value.length, items } : null
}

const memberSuggestions = (
  value: string,
  caret: number,
  members: readonly ComposerMentionMember[]
): ComposerSuggestions | null => {
  // resolveTeamRecipient only accepts "@name task" from the very start of the input.
  if (!value.startsWith('@') || caret < 1) return null
  const whitespace = value.search(/\s/)
  const tokenEnd = whitespace < 0 ? value.length : whitespace
  if (caret > tokenEnd) return null
  const query = value.slice(1, caret).toLowerCase()
  const items = members
    .filter((member) => member.name.toLowerCase().startsWith(query))
    .map((member) => ({
      label: `@${member.name}`,
      detail: member.detail,
      running: member.running,
      typedInFull: false
    }))
  return items.length ? { kind: 'member', key: `@${query}`, tokenEnd, items } : null
}

/** `caret` is the collapsed selection offset; pass -1 while a range is selected. */
export function resolveComposerSuggestions(
  value: string,
  caret: number,
  commands: readonly ComposerCommand[],
  members: readonly ComposerMentionMember[]
): ComposerSuggestions | null {
  if (value.startsWith('/')) return commands.length ? commandSuggestions(value, commands) : null
  return members.length ? memberSuggestions(value, caret, members) : null
}

export function applyComposerSuggestion(
  value: string,
  suggestions: ComposerSuggestions,
  item: ComposerSuggestionItem
): { value: string; caret: number } {
  const rest = value.slice(suggestions.tokenEnd)
  const needsSpace = suggestions.kind === 'member' || Boolean(item.argumentHintKey)
  const separator = needsSpace && !/^\s/.test(rest) ? ' ' : ''
  return {
    value: `${item.label}${separator}${rest}`,
    caret: item.label.length + (needsSpace ? 1 : 0)
  }
}
