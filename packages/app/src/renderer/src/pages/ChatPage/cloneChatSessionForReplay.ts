import type { ChatSession } from './chatStorage'

/** Keep metadata and the selected replay history independently cloned. */
export function cloneChatSessionForReplay(
  session: ChatSession,
  messages?: ChatSession['messages']
): ChatSession {
  const copy: ChatSession = structuredClone({ ...session, messages: [] })
  copy.messages = structuredClone(messages ?? session.messages)
  return copy
}
