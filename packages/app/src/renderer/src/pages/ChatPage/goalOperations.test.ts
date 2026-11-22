import { describe, expect, it } from 'vitest'
import type { AgentGoalMutation } from '@shared/api/agentThreadGoal'
import { acknowledgeGoalMutation, beginGoalMutation, pendingGoalMutation } from './goalOperations'
const scope = (conversationId: string, token?: string) => JSON.stringify({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' }, conversationId, ...(token ? { documentToken: token } : {}) })
const mutation = (operationId = crypto.randomUUID()): AgentGoalMutation => ({ action: 'report', goalId: crypto.randomUUID(), expectedGeneration: 2, expectedRevision: 3, operationId, summary: 'PRIVATE_RETRY_PAYLOAD', evidence: ['receipt'] })
describe('bounded transient exact goal retry payloads', () => {
  it('clones bodies, omits authority, blocks new identities, and acknowledges only a matching scoped receipt', () => {
    const req = mutation(), original = structuredClone(req), owned = scope('clone')
    beginGoalMutation(owned, req); if (req.action === 'report') req.summary = 'changed'
    const pending = pendingGoalMutation(scope('clone', 'new-token'))!
    expect(pending).toEqual(original); expect(pending).not.toHaveProperty('documentToken')
    expect(() => beginGoalMutation(owned, mutation())).toThrow('Resolve')
    acknowledgeGoalMutation(scope('other'), original.operationId); acknowledgeGoalMutation(owned, 'wrong')
    expect(pendingGoalMutation(owned)).toEqual(original)
    acknowledgeGoalMutation(owned, original.operationId); expect(pendingGoalMutation(owned)).toBeUndefined()
  })
  it('fails closed at the outstanding-count and byte budgets without evicting unknown requests', () => {
    const entries: Array<{ scope: string; operationId: string }> = []
    try {
      for (let i = 0; i < 16; i++) { const owned = scope(`capacity-${i}`), req = mutation(); beginGoalMutation(owned, req); entries.push({ scope: owned, operationId: req.operationId }) }
      expect(() => beginGoalMutation(scope('overflow'), mutation())).toThrow('budget')
      expect(pendingGoalMutation(entries[0].scope)).toBeTruthy()
    } finally { entries.forEach(entry => acknowledgeGoalMutation(entry.scope, entry.operationId)) }
    const oversized = mutation(); if (oversized.action === 'report') oversized.summary = '😀'.repeat(20000)
    expect(() => beginGoalMutation(scope('oversize'), oversized)).toThrow('budget')
    for (let i = 0; i < 100; i++) { const owned = scope('ack-capacity'), req = mutation(); beginGoalMutation(owned, req); acknowledgeGoalMutation(owned, req.operationId) }
    expect(pendingGoalMutation(scope('ack-capacity'))).toBeUndefined()
  })
})
