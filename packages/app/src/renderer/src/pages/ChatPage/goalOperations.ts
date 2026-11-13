import type { AgentGoalMutation } from '@shared/api/agentThreadGoal'

// Transient retry payloads, never localStorage/chat/model context. No tokens or
// authority. Bodies must survive a panel remount for an exact original-ID retry.
const pending = new Map<string, AgentGoalMutation>()
const key = (scope: string) => { const { route, conversationId } = JSON.parse(scope); return JSON.stringify([route.channel, route.scopeType, route.scopeId, route.threadId, conversationId]) }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
export const pendingGoalMutation = (scope: string): AgentGoalMutation | undefined => {
  const value = pending.get(key(scope)); return value ? structuredClone(value) : undefined
}
export function beginGoalMutation(scope: string, mutation: AgentGoalMutation): AgentGoalMutation {
  const owned = key(scope), old = pending.get(owned)
  if (old) throw new Error('Resolve the pending goal operation before another action.')
  const copy = structuredClone(mutation)
  if (pending.size >= 16 || bytes(copy) > 32768 || [...pending.values()].reduce((sum, item) => sum + bytes(item), 0) + bytes(copy) > 256 * 1024) throw new Error('Goal transient retry payload budget reached.')
  pending.set(owned, copy); return structuredClone(copy)
}
export function acknowledgeGoalMutation(scope: string, operationId: string): void {
  if (pending.get(key(scope))?.operationId === operationId) pending.delete(key(scope))
}
