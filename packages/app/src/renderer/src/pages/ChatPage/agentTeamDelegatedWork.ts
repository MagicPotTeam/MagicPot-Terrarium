// What the lead's view shows of a member's work: whether it has been given work, its task,
// its state and its latest reply. Read only; derived from data the page already has.
import type { ChatSession } from './chatStorage'
import { readScopedChatRun } from './chatPageShared'
import type { DelegatedRowStatus } from './components/ChatToolCalls'

export type IdSet = { has(id: string): boolean }

const lastIndexOf = (messages: ChatSession['messages'], role: 'user' | 'assistant'): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return index
  }
  return -1
}

/** A member has been given work once a message reached it, or while it runs or waits. */
export const hasDelegatedWork = (member: ChatSession, running: IdSet, waiting: IdSet): boolean =>
  running.has(member.id) || waiting.has(member.id) || lastIndexOf(member.messages, 'user') >= 0

/**
 * The member's current (or last) task: its latest incoming message on one line. A message
 * that arrived from the team channel starts with a bracketed header line, which is left out.
 */
export const delegatedTaskText = (member: ChatSession): string => {
  const index = lastIndexOf(member.messages, 'user')
  const content = index >= 0 ? (member.messages[index]?.content ?? '') : ''
  const text = /^\[[^\n]*\]\n/.test(content) ? content.slice(content.indexOf('\n') + 1) : content
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The state shown by a member's line. Running and waiting for an approval are the facts the
 * lead's stop button uses; after a run, its recorded outcome (done, failed, stopped).
 */
export const delegatedMemberStatus = (
  member: ChatSession,
  scope: string,
  running: IdSet,
  waiting: IdSet
): DelegatedRowStatus => {
  if (waiting.has(member.id)) return 'waiting'
  if (running.has(member.id)) return 'running'
  const run = readScopedChatRun(scope, member.id).status
  if (run === 'completed') return 'completed'
  if (run === 'failed') return 'failed'
  if (run === 'cancelled' || run === 'interrupted') return 'cancelled'
  // No run seen since the app started: a reply after the last task means it was answered.
  return lastIndexOf(member.messages, 'assistant') > lastIndexOf(member.messages, 'user')
    ? 'completed'
    : 'unknown'
}

/** The member's latest reply to its current task; '' while there is none. */
export const latestDelegatedReply = (member: ChatSession): string => {
  const assistant = lastIndexOf(member.messages, 'assistant')
  if (assistant < lastIndexOf(member.messages, 'user')) return ''
  return member.messages[assistant]?.content?.trim() ? member.messages[assistant].content : ''
}
