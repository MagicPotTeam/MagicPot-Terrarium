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
  if (status.status === 'running' || !Array.isArray(value) || value.length > 64) return undefined
  const incoming = normalizeChatToolHistory(value)
  if (!incoming || incoming.length !== value.length) return undefined
  if (incoming.some((entry) => entry.runId !== status.runId || entry.status === 'running'))
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
    if (old && JSON.stringify(old) !== JSON.stringify(entry)) return undefined
    merged.set(entry.toolCallId, entry)
  }
  if (merged.size > 64) return undefined
  if (previous && merged.size === previous.length) return undefined
  return [...merged.values()]
}
