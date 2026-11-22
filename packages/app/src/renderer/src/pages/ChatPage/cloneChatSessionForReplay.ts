import type { ChatSession } from './chatStorage'

/**
 * Keep metadata and the selected replay history independently cloned.
 *
 * A report's MAIN binding belongs to the conversation it was registered for, and MAIN refuses it
 * in any other. The copy is a new conversation, so its reports carry no binding: they show as
 * "Unverified source" instead of looking valid and blocking every send of the copy.
 */
export function cloneChatSessionForReplay(
  session: ChatSession,
  messages?: ChatSession['messages']
): ChatSession {
  const copy: ChatSession = structuredClone({ ...session, messages: [] })
  copy.messages = structuredClone(messages ?? session.messages)
  for (const message of copy.messages) {
    for (const attachment of message.attachments ?? []) {
      if ('reportBundleBinding' in attachment) delete attachment.reportBundleBinding
    }
  }
  return copy
}
