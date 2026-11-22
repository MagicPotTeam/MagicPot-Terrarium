import type { LLMToolStatus } from '@shared/api/svcLLMProxy'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { normalizeChatToolHistory } from './chatMessageUtils'

type History = NonNullable<ChatMessage['toolHistory']>

/** A checkpoint is evidence, never authority or an instruction to replay a tool. */
export function mergeToolCheckpoint(
  previous: History | undefined,
  value: unknown,
  status: LLMToolStatus
): History | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined
  const incoming = normalizeChatToolHistory(value)
  if (!incoming || incoming.length !== value.length) return undefined
  if (incoming.some((entry) => entry.runId !== status.runId)) return undefined
  // Running records are intent only, never a completed result or proof of effects.
  if (
    incoming.some(
      (entry) =>
        entry.status === 'running' && (entry.content !== undefined || entry.error !== undefined)
    )
  )
    return undefined
  if (
    !incoming.some(
      (entry) =>
        entry.toolCallId === status.toolCallId &&
        entry.toolName === status.toolName &&
        entry.status === status.status
    )
  )
    return undefined
  const ids = new Set(incoming.map((entry) => entry.toolCallId))
  if (ids.size !== incoming.length) return undefined
  const merged = new Map((previous || []).map((entry) => [entry.toolCallId, entry]))
  if ([...merged.values()].some((entry) => entry.runId !== status.runId)) return undefined
  for (const entry of incoming) {
    const old = merged.get(entry.toolCallId)
    // A settled effect is immutable. Stale frames cannot downgrade or rewrite it.
    if (old) {
      if (old.status !== 'running' && JSON.stringify(old) !== JSON.stringify(entry))
        return undefined
      if (
        old.toolName !== entry.toolName ||
        JSON.stringify(old.args) !== JSON.stringify(entry.args)
      )
        return undefined
    }
    merged.set(entry.toolCallId, entry)
  }
  if (merged.size > 64) return undefined
  const result = [...merged.values()]
  return JSON.stringify(previous) === JSON.stringify(result) ? undefined : result
}
