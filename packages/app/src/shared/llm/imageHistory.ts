import type { ChatMessage, LLMImageHistoryPolicy } from './types'

export const DEFAULT_LLM_IMAGE_HISTORY_POLICY: LLMImageHistoryPolicy = 'latest-user-turn'

/**
 * Keeps every message and non-image attachment while selecting provider-bound images.
 *
 * Generated images live on assistant messages in the app model, but Responses only
 * accepts input images on user content. Preserve the assistant turn and expose its
 * images through a synthetic user reference turn so image-generation follow-ups can
 * see prior generated images without changing the role/content of the original turn.
 */
export const selectMessagesForImageHistoryPolicy = <T extends ChatMessage>(
  messages: readonly T[],
  policy: LLMImageHistoryPolicy = DEFAULT_LLM_IMAGE_HISTORY_POLICY
): T[] => {
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
  return messages.map((message, index) => {
    if (message.role === 'user' && (policy === 'all' || index === latestUserIndex)) return message
    // Assistant image attachments are retained only for the explicit all-history
    // image policy; the latest-user-turn policy must not leak old generated media.
    if (message.role === 'assistant' && policy === 'all') return message
    if (!message.attachments?.some((attachment) => attachment.type === 'image')) return message

    const attachments = message.attachments.filter((attachment) => attachment.type !== 'image')
    return {
      ...message,
      attachments: attachments.length > 0 ? attachments : undefined
    }
  })
}
