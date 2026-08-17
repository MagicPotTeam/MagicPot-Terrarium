import type { ChatMessage, LLMImageHistoryPolicy } from './types'

export const DEFAULT_LLM_IMAGE_HISTORY_POLICY: LLMImageHistoryPolicy = 'latest-user-turn'

/** Keeps every message and non-image attachment while selecting only provider-bound images. */
export const selectMessagesForImageHistoryPolicy = <T extends ChatMessage>(
  messages: readonly T[],
  policy: LLMImageHistoryPolicy = DEFAULT_LLM_IMAGE_HISTORY_POLICY
): T[] => {
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
  return messages.map((message, index) => {
    if (message.role === 'user' && (policy === 'all' || index === latestUserIndex)) return message
    if (!message.attachments?.some((attachment) => attachment.type === 'image')) return message

    const attachments = message.attachments.filter((attachment) => attachment.type !== 'image')
    return {
      ...message,
      attachments: attachments.length > 0 ? attachments : undefined
    }
  })
}
