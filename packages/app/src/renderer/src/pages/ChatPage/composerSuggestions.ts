import type { ComposerCommand, ComposerSuggestionTextKey } from './composerCommandCatalog'

export type ComposerSuggestionItem = {
  /** "/status", exactly as it is inserted. */
  label: string
  argumentHintKey?: ComposerSuggestionTextKey
  descriptionKey: ComposerSuggestionTextKey
  /** The typed token already is this command, so Enter keeps running it as before. */
  typedInFull: boolean
}

export type ComposerSuggestions = {
  /** Changes whenever the list has to restart its highlight. */
  key: string
  /** End of the token that an accepted item replaces. */
  tokenEnd: number
  items: ComposerSuggestionItem[]
}

/** DOM id of one option, shared by the list and the textarea's aria-activedescendant. */
export const getComposerSuggestionOptionId = (listId: string, index: number) =>
  `${listId}-option-${index}`

/** Suggestions for a draft that is one "/token"; anything else (also "@name task") has none. */
export function resolveComposerSuggestions(
  value: string,
  commands: readonly ComposerCommand[]
): ComposerSuggestions | null {
  // Parsers accept a command only as the first token; arguments end the completion.
  if (!commands.length || !/^\/\S*$/.test(value)) return null
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
  return items.length ? { key: `/${query}`, tokenEnd: value.length, items } : null
}

export function applyComposerSuggestion(
  value: string,
  suggestions: ComposerSuggestions,
  item: ComposerSuggestionItem
): { value: string; caret: number } {
  const rest = value.slice(suggestions.tokenEnd)
  const needsSpace = Boolean(item.argumentHintKey)
  const separator = needsSpace && !/^\s/.test(rest) ? ' ' : ''
  return {
    value: `${item.label}${separator}${rest}`,
    caret: item.label.length + (needsSpace ? 1 : 0)
  }
}
