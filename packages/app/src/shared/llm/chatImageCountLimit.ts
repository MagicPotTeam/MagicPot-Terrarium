import type { ChatMessage } from './types'

export const DEFAULT_CHAT_IMAGE_COUNT_LIMIT = 50

/**
 * Limits a provider request only after the caller has strictly completed bundle
 * expansion in the same prepare operation. This function cannot verify that
 * precondition from attachment metadata. Never expand bundles again on its result.
 * System handling differs by provider; this helper does not count system images
 * and must not be used as proof of an actual provider wire count. Provider-specific
 * validation and selection remain the caller's responsibility.
 */
export function limitChatImageCount<T extends ChatMessage>(
  messages: readonly T[],
  limit = DEFAULT_CHAT_IMAGE_COUNT_LIMIT
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid image count limit')

  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const currentImages = lastUser < 0 ? 0 : (messages[lastUser].attachments ?? []).filter(a => a.type === 'image').length
  if (currentImages > limit) throw new Error('本次图片数量超过限制，请分批发送')
  const total = messages.reduce((sum, message) => sum + (message.role === 'system' ? 0 : (message.attachments ?? []).filter(a => a.type === 'image').length), 0)
  const removed = Math.max(0, total - limit)
  if (!removed) return messages.slice()
  if (lastUser < 0 || typeof messages[lastUser].content !== 'string') throw new Error('Cannot disclose omitted images without a user message')
  const earlierImages = messages.slice(0, lastUser).reduce((sum, message) => sum + (message.role === 'system' ? 0 : (message.attachments ?? []).filter(a => a.type === 'image').length), 0)
  if (earlierImages < removed) throw new Error('无法安全省略本轮后续图片，请分批发送')

  let remaining = removed
  return messages.map((message, index) => {
    let attachments = message.attachments
    if (message.role !== 'system' && index < lastUser && attachments && remaining > 0) {
      const filtered = attachments.filter(attachment => {
        if (attachment.type === 'image' && remaining > 0) { remaining--; return false }
        return true
      })
      if (filtered.length !== attachments.length) attachments = filtered
    }
    if (index === lastUser) {
      const notice = `${removed} 张较早图片本次未发送，如需请分批重新提供`
      return { ...message, ...(attachments !== message.attachments ? { attachments } : {}), content: message.content ? `${message.content}\n\n${notice}` : notice }
    }
    return attachments !== message.attachments ? { ...message, attachments } : message
  })
}
