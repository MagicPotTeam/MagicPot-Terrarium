import type { ChatMessage, LLMImageHistoryPolicy } from './types'
import { DEFAULT_LLM_IMAGE_HISTORY_POLICY, selectMessagesForImageHistoryPolicy } from './imageHistory'
import { DEFAULT_CHAT_IMAGE_COUNT_LIMIT } from './chatImageCountLimit'

type Accounting<T extends ChatMessage> = {
  messages: T[]
  policyOmitted: number
  countLimitOmitted: number
  /** Policy-filtered system images; provider handling is unknown, not an unsent count. */
  systemPolicyExcluded: number
}

/**
 * Accounts for attachment occurrences in already strictly expanded messages only.
 * This is an unintegrated candidate: it preserves some message and attachment
 * references and does not create a trusted or immutable request snapshot.
 * No run identity or notice deduplication is provided: call once per prepared request,
 * never expand the result again, and do not treat this as provider delivery evidence.
 */
export function accountChatImageOmissions<T extends ChatMessage>(
  messages: readonly T[],
  policy: LLMImageHistoryPolicy = DEFAULT_LLM_IMAGE_HISTORY_POLICY,
  cap = DEFAULT_CHAT_IMAGE_COUNT_LIMIT
): Accounting<T> {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError('Invalid image count limit')
  if (policy !== 'all' && policy !== 'latest-user-turn') throw new RangeError('Invalid image history policy')
  const count = (message: ChatMessage): number =>
    (message.attachments ?? []).reduce((sum, attachment) => sum + (attachment.type === 'image' ? 1 : 0), 0)
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const selected = selectMessagesForImageHistoryPolicy(messages, policy)
  let policyOmitted = 0
  let systemPolicyExcluded = 0
  for (let i = 0; i < messages.length; i++) {
    const removed = count(messages[i]) - count(selected[i])
    if (messages[i].role === 'system') systemPolicyExcluded += removed
    else {
      if (removed && (lastUser < 0 || i > lastUser)) throw new Error('无法安全说明本轮后续图片')
      policyOmitted += removed
    }
  }
  const currentImages = lastUser < 0 ? 0 : count(selected[lastUser])
  if (currentImages > cap) throw new Error('本次图片数量超过限制，请分批发送')
  const total = selected.reduce((sum, message) => sum + (message.role === 'system' ? 0 : count(message)), 0)
  const countLimitOmitted = Math.max(0, total - cap)
  const earlier = selected.reduce((sum, message, index) => sum + (message.role !== 'system' && index < lastUser ? count(message) : 0), 0)
  if (countLimitOmitted > earlier) throw new Error('无法安全省略本轮后续图片，请分批发送')
  if ((policyOmitted || countLimitOmitted) && (lastUser < 0 || typeof selected[lastUser].content !== 'string' || !selected[lastUser].content.trim())) {
    throw new Error('无法在空用户消息中说明图片省略')
  }
  let remaining = countLimitOmitted
  const result = selected.map((message, index) => {
    let attachments = message.attachments
    if (message.role !== 'system' && index < lastUser && attachments && remaining) {
      const filtered = attachments.filter(attachment => {
        if (attachment.type === 'image' && remaining) { remaining--; return false }
        return true
      })
      if (filtered.length !== attachments.length) attachments = filtered
    }
    if (index === lastUser && (policyOmitted || countLimitOmitted)) {
      const notices = [
        policyOmitted ? `图片历史策略移除了 ${policyOmitted} 张图片。` : '',
        countLimitOmitted ? `图片数量限制移除了 ${countLimitOmitted} 张较早图片。` : ''
      ].filter(Boolean)
      return { ...message, attachments, content: `${message.content}\n\n${notices.join('\n')}` }
    }
    return attachments !== message.attachments ? { ...message, attachments } : message
  })
  return { messages: result, policyOmitted, countLimitOmitted, systemPolicyExcluded }
}
