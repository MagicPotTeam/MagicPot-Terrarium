import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentGoalCollection, AgentGoalMutation, AgentModelGoalMutation } from '@shared/api/agentThreadGoal'
import { applyModelGoalMutation, applyUserGoalMutation, emptyAgentGoalCollection, normalizeAgentGoalSpec, validateAgentGoalCollection, validateAgentGoalMutation } from './agentThreadGoalPolicy'
const spec = () => normalizeAgentGoalSpec({ objective: ' Review the actual outcome ' })
const advance = (doc: AgentGoalCollection, command: AgentGoalMutation): AgentGoalCollection => {
  const result = applyUserGoalMutation(doc, command, 100)
  result.receipts = [{ operationHash: 'a'.repeat(64), digest: 'b'.repeat(64) }]
  validateAgentGoalCollection(result); return result
}
const setup = () => {
  const goalId = randomUUID(), initial = emptyAgentGoalCollection()
  const draft = advance(initial, { action: 'create', goalId, title: 'Goal', spec: spec(), expectedRevision: 0, operationId: 'create' })
  const active = advance(draft, { action: 'control', goalId, expectedRevision: 1, expectedGeneration: 1, status: 'active', reason: 'User activated data record, not execution', operationId: 'activate' })
  return { initial, draft, active, goalId, binding: { goalId, generation: 2 } }
}
describe('manual user-confirm goal data policy (not execution admission)', () => {
  it('defaults only omitted fields, rejects unsupported autonomy/policies and unknown or null fields', () => {
    expect(spec()).toEqual({ objective: 'Review the actual outcome', successCriteria: [], constraints: [], autonomy: 'manual', completionPolicy: 'user_confirm', budgets: { maxTurns: 5, maxToolCalls: 50, maxWalltimeSeconds: 300 } })
    for (const extra of [{ autonomy: 'continue_when_ready' }, { completionPolicy: 'self_propose' }, { completionPolicy: 'verifier' }, { autonomy: null }, { budgets: null }, { successCriteria: null }, { owner: 'other' }, { budgets: { maxTurns: true } }, { constraints: [' '] }, { objective: '\0' }]) expect(() => normalizeAgentGoalSpec({ objective: 'x', ...extra })).toThrow()
  })
  it('requires evidence for proposals and never treats a report/proposal as terminal confirmation', () => {
    const t = setup(), request = { action: 'propose' as const, goalId: t.goalId, expectedRevision: 2, expectedGeneration: 2, operationId: 'proposal', summary: 'Possibly done', outcome: 'completed' as const, evidence: ['historical receipt, not independently verified'] }
    expect(() => applyModelGoalMutation(t.active, { ...request, evidence: [] }, t.binding, 101)).toThrow('requires evidence')
    const proposed = applyModelGoalMutation(t.active, request, t.binding, 101)
    expect(proposed.goals[0].status).toBe('active'); expect(proposed.goals[0].proposal?.outcome).toBe('completed')
    const confirmed = advance(proposed, { action: 'confirm', goalId: t.goalId, expectedRevision: 3, expectedGeneration: 2, operationId: 'user-confirm', outcome: 'completed' })
    expect(confirmed.goals[0]).toMatchObject({ status: 'completed', generation: 3 })
    expect(() => applyUserGoalMutation(confirmed, { action: 'report', goalId: t.goalId, expectedRevision: 4, expectedGeneration: 3, operationId: 'late-report', summary: 'x', evidence: [] }, 102)).toThrow('Terminal')
  })
  it('structurally limits model mutations to the main-bound goal and generation', () => {
    const t = setup(), request = { action: 'report' as const, goalId: t.goalId, expectedRevision: 2, expectedGeneration: 2, operationId: 'report', summary: 'Progress only', evidence: [] }
    for (const binding of [{ goalId: randomUUID(), generation: 2 }, { ...t.binding, generation: 1 }]) expect(() => applyModelGoalMutation(t.active, request, binding, 101)).toThrow('binding')
    for (const action of ['confirm', 'control', 'delete', 'create']) expect(() => applyModelGoalMutation(t.active, { ...request, action } as unknown as AgentModelGoalMutation, t.binding, 101)).toThrow()
    expect(() => validateAgentGoalMutation({ ...request, actor: 'user' })).toThrow('Invalid')
  })
  it('revokes proposals and request generations on spec edits or lifecycle changes', () => {
    const t = setup(), proposal = advance(t.active, { action: 'propose', goalId: t.goalId, expectedRevision: 2, expectedGeneration: 2, operationId: 'propose', outcome: 'failed', summary: 'Blocked', evidence: ['exact observed error'] })
    const updated = advance(proposal, { action: 'update', goalId: t.goalId, expectedRevision: 3, expectedGeneration: 2, operationId: 'edit', title: 'Edited', spec: spec() })
    expect(updated.goals[0]).toMatchObject({ generation: 3, status: 'active' }); expect(updated.goals[0].proposal).toBeUndefined()
    expect(() => applyUserGoalMutation(updated, { action: 'confirm', goalId: t.goalId, expectedRevision: 4, expectedGeneration: 2, operationId: 'stale', outcome: 'failed' }, 101)).toThrow('generation')
    expect(() => applyUserGoalMutation(updated, { action: 'confirm', goalId: t.goalId, expectedRevision: 4, expectedGeneration: 3, operationId: 'new', outcome: 'failed' }, 101)).toThrow('current proposal')
    const paused = advance(updated, { action: 'control', goalId: t.goalId, expectedRevision: 4, expectedGeneration: 3, operationId: 'pause', status: 'paused', reason: 'User paused' })
    expect(() => applyUserGoalMutation(paused, { action: 'report', goalId: t.goalId, expectedRevision: 5, expectedGeneration: 4, operationId: 'late', summary: 'x', evidence: [] }, 102)).toThrow('not accepting')
  })
  it('rejects invalid transitions, blank/nonbounded input and arbitrary execution fields', () => {
    const t = setup()
    expect(() => advance(t.draft, { action: 'control', goalId: t.goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'bad', status: 'waiting', reason: 'not active' })).toThrow('transition')
    const command = { action: 'create', goalId: randomUUID(), title: 'x', spec: spec(), expectedRevision: 0, operationId: 'op' }
    for (const extra of [{ goalId: 'bad' }, { operationId: '' }, { title: ' ' }, { expectedRevision: -1 }, { permits: ['execute'] }, { profileId: 'remote' }, { spec: { ...spec(), objective: 'x'.repeat(8001) } }]) expect(() => validateAgentGoalMutation({ ...command, ...extra })).toThrow()
    expect(() => validateAgentGoalCollection({ ...t.active, authority: 'restored' })).toThrow()
    const corrupt = structuredClone(t.active); corrupt.goals[0].status = 'completed'
    expect(() => validateAgentGoalCollection(corrupt)).toThrow('semantics')
  })
  it('confirms all maximum-sized proposal summaries near the content ceiling without duplicating text', () => {
    const t = setup(), baseline = t.active.goals[0]
    const doc: AgentGoalCollection = { version: 1, revision: 100, goals: Array.from({ length: 8 }, () => ({ ...structuredClone(baseline), id: randomUUID(), proposal: { outcome: 'completed', summary: '😀'.repeat(2000), evidence: ['receipt'], proposedAt: 100 } })), retiredIds: [], receipts: [{ operationHash: 'a'.repeat(64), digest: 'b'.repeat(64) }] }
    // Valid plaintext just below the content-admission ceiling, with all 8
    // proposals. Astral summaries expose the former UTF8 duplication bug.
    for (const goal of doc.goals) {
      const room = 128 * 1024 - 24 * 1024 - Buffer.byteLength(JSON.stringify(doc)) - 2
      if (room > 0) goal.spec.objective += 'x'.repeat(Math.min(8000 - goal.spec.objective.length, room))
    }
    validateAgentGoalCollection(doc)
    expect(Buffer.byteLength(JSON.stringify(doc))).toBeGreaterThan(100 * 1024)
    let current = doc
    for (const goal of doc.goals) current = advance(current, { action: 'confirm', goalId: goal.id, expectedRevision: current.revision, expectedGeneration: 2, operationId: `confirm-${goal.id}`, outcome: 'completed' })
    expect(current.goals.every(goal => goal.status === 'completed')).toBe(true)
    expect(current.goals.every(goal => goal.reason === 'User confirmed the current proposal.')).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(current)) - Buffer.byteLength(JSON.stringify(doc))).toBeLessThan(1024)
  })
  it('retains empty collection revision and retired identity and refuses resurrection', () => {
    const t = setup(), removed = advance(t.draft, { action: 'delete', goalId: t.goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'delete' })
    expect(removed).toMatchObject({ revision: 2, goals: [], retiredIds: [t.goalId] })
    expect(() => advance(removed, { action: 'create', goalId: t.goalId, title: 'late', spec: spec(), expectedRevision: 2, operationId: 'new' })).toThrow('retired')
    expect(t.draft.goals).toHaveLength(1)
  })
})
