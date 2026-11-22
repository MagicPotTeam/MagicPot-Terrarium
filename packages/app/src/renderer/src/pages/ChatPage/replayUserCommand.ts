import type { ChatMessage } from '@shared/llm'
export type ReplayUserCommand = { kind: 'branch' } | { kind: 'regen' } | { kind: 'edit'; index: number; text: string }
export const isReplayUserCommand = (value: string) => /^\/(?:branch|regen|edit)(?:\s|$)/i.test(value.trimStart())
export function parseReplayUserCommand(value: string): ReplayUserCommand | undefined {
  if (!isReplayUserCommand(value)) return undefined
  const simple = /^\/(branch|regen)$/i.exec(value.trim())
  if (simple) return { kind: simple[1].toLowerCase() as 'branch' | 'regen' }
  const edit = /^\/edit\s+([1-9][0-9]*)\s+([\s\S]+)$/i.exec(value.trim())
  if (edit && Number.isSafeInteger(Number(edit[1])) && edit[2].length <= 6000) return { kind: 'edit', index: Number(edit[1]) - 1, text: edit[2] }
  throw new Error('Use /branch, /regen, or /edit <1-based message number> <replacement>.')
}
/** Supplied-history planning only. No request, mutation or original removal.
 * Commands replay only from a completed user turn; callers must confirm exact history,
 * profile and settings and preserve the original branch before submitting a new run.
 */
export function planReplay(messages: readonly ChatMessage[], command: Exclude<ReplayUserCommand, { kind: 'branch' }>) {
  const index = command.kind === 'edit' ? command.index : messages.findLastIndex(message => message.role === 'user')
  const user = messages[index]
  if (!user || user.role !== 'user') throw new Error('Choose an existing user message.')
  if (messages.some(message => message.toolHistory?.length)) throw new Error('Tool-bearing history requires explicit replay review; slash replay is unavailable.')
  if (user.attachments?.length || user.hiddenContext) throw new Error('Slash replay of attachments or hidden context is unavailable; use the existing editor.')
  const content = command.kind === 'edit' ? command.text : user.content
  if (/^\s*\//.test(content)) throw new Error('Slash-prefixed replay requires explicit literal-message editing; no command draft was created.')
  return { index, content, baseMessages: messages.slice(0,index), originalMessages: messages.slice() }
}
