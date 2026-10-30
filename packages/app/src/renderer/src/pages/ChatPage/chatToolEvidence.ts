import type { ChatMessage } from '@shared/api/svcLLMProxy'

export type ChatToolEvidence = {
  id: string
  toolName: string
  status: 'completed' | 'failed' | 'cancelled' | 'unknown'
}
const READ_ONLY = new Set([
  'web_search',
  'web_fetch',
  'files.read',
  'files.tree',
  'files.glob',
  'files.json.read',
  'session.status'
])

/** Stored receipts, not replay instructions or proof that the whole task succeeded. */
export function summarizeChatToolEvidence(messages: readonly ChatMessage[]) {
  const entries = new Map<string, ChatToolEvidence>()
  for (const message of messages.slice(-20)) {
    for (const item of (Array.isArray(message.toolHistory) ? message.toolHistory : []).slice(-64)) {
      if (
        !item ||
        typeof item.toolName !== 'string' ||
        typeof item.runId !== 'string' ||
        typeof item.toolCallId !== 'string'
      )
        continue
      const id = JSON.stringify([item.runId.slice(0, 256), item.toolCallId.slice(0, 256)])
      const toolName = item.toolName.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 128) || 'tool'
      const status = ['completed', 'failed', 'cancelled'].includes(item.status)
        ? (item.status as 'completed' | 'failed' | 'cancelled')
        : 'unknown'
      // A late running snapshot must not downgrade a terminal receipt.
      if (entries.has(id) && status === 'unknown' && entries.get(id)?.status !== 'unknown') continue
      entries.set(id, { id, toolName, status })
    }
  }
  const recent = [...entries.values()].slice(-64)
  return {
    entries: recent,
    hasUncertainOutcome: recent.some((entry) => entry.status === 'unknown'),
    hasCompletedEffects: recent.some(
      (entry) => entry.status === 'completed' && !READ_ONLY.has(entry.toolName)
    )
  }
}
