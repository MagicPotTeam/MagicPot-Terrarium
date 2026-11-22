import type { ChatMessage, LLMImageHistoryPolicy } from './types'

/** Local image-tool candidates, not provider inputs or authority to read a file. */
export type ThreadImageHistoryEntry = { sha256: string; mimeType: string; sizeBytes: number }

/** Newest-first, matching image_gen's five-input limit. Never copy a URL, path,
 * chunk, or tool result. Keep unavailable slots so an edit cannot silently target
 * an older image. MAIN must still prove membership in this conversation's store.
 */
export const collectThreadImageHistory = (
  history: readonly ChatMessage[]
): (ThreadImageHistoryEntry | null)[] => {
  const candidates: (ThreadImageHistoryEntry | null)[] = []
  for (let i = history.length - 1; i >= 0 && candidates.length < 5; --i) {
    const { role, attachments } = history[i]
    if (role !== 'assistant' && role !== 'user') continue
    for (let j = (attachments?.length ?? 0) - 1; j >= 0 && candidates.length < 5; --j) {
      const image = attachments![j]
      if (image.type !== 'image') continue
      const ref = image.media
      candidates.push(
        role === 'assistant' &&
          ref?.kind === 'managed' &&
          (!ref.status || ref.status === 'ready') &&
          typeof ref.sha256 === 'string' &&
          /^[a-f0-9]{64}$/u.test(ref.sha256) &&
          typeof ref.mimeType === 'string' &&
          ['image/png', 'image/jpeg', 'image/webp'].includes(ref.mimeType) &&
          typeof ref.sizeBytes === 'number' &&
          Number.isSafeInteger(ref.sizeBytes) &&
          ref.sizeBytes > 0
          ? { sha256: ref.sha256, mimeType: ref.mimeType, sizeBytes: ref.sizeBytes }
          : null
      )
    }
  }
  return candidates
}

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

/**
 * Once the image tool has received its explicit inputs, its follow-up model step
 * only needs the textual/tool receipt. Keep the transcript attachments intact
 * for the renderer, but do not materialize historical image bytes a second time
 * in the same tool loop.
 */
export const stripImageAttachmentsForProviderFollowUp = <T extends ChatMessage>(
  messages: readonly T[]
): T[] =>
  messages.map((message) => {
    if (!message.attachments?.some((attachment) => attachment.type === 'image')) return message
    const attachments = message.attachments.filter((attachment) => attachment.type !== 'image')
    return {
      ...message,
      attachments: attachments.length > 0 ? attachments : undefined
    }
  })
