import type { ChatMessage } from '@shared/llm/types'
import { AGENT_SIDE_LIMITS as LIMITS, type AgentSideStartReq } from '@shared/api/agentThreadSide'

/** Visible prose only; never inherit system/hidden context, attachments or tool receipts. */
export function sideSnapshot(messages: readonly ChatMessage[]): AgentSideStartReq['snapshot'] {
  let remaining: number = LIMITS.snapshotCharacters
  const result: AgentSideStartReq['snapshot'] = []
  for (const message of messages.slice(-LIMITS.snapshotMessages).reverse()) {
    if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !remaining) continue
    const content = message.content.slice(0, Math.min(4000, remaining))
    remaining -= content.length
    if (content) result.unshift({ role: message.role as 'user' | 'assistant', content })
  }
  return result
}
