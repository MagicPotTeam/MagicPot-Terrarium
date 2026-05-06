const DEFAULT_CONVERSATION_TITLES = new Set(['新对话', 'New Conversation'])

export const getLocalizedConversationTitle = (
  title: string | null | undefined,
  localizedTitle: string
): string => {
  const normalizedTitle = title?.trim() || ''

  if (!normalizedTitle) {
    return localizedTitle
  }

  return DEFAULT_CONVERSATION_TITLES.has(normalizedTitle) ? localizedTitle : normalizedTitle
}
