import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Synthetic sender and in-memory store: real service, no Electron IPC or profile.
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), config: { use_remote_llm: false } }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/config', () => ({ getConfig: () => h.config }))
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { AgentThreadGoals } from './agentThreadGoals'
import { setAgentGoalScope } from './agentThreadGoalScope'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import type { AgentGoalMutationReq, AgentGoalScope } from '@shared/api/agentThreadGoal'

const url = 'file:///synthetic/index.html#/canvas?id=project'
const invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
const evidence = ['synthetic receipt one', 'synthetic receipt two']
let sender: EventEmitter
let store: AgentThreadGoalStore
let service: AgentThreadGoals
let user: AgentGoalScope
let goalId: string

beforeEach(async () => {
  vi.clearAllMocks()
  h.config.use_remote_llm = false
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender)
  h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, scope.route, { trustedUrl: url, trustedWebContents: sender as never })
  store = new AgentThreadGoalStore(sideTestCodec(), ':memory:')
  service = new AgentThreadGoals(async () => store)
  user = { ...scope, documentToken: setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope')).documentToken! }
  goalId = randomUUID()
  await service.mutate({ ...user, action: 'create', goalId, title: 'Synthetic goal', spec: normalizeAgentGoalSpec({ objective: 'Synthetic objective' }), expectedRevision: 0, operationId: randomUUID() }, invoke('mutateAgentGoal'))
  await service.mutate({ ...user, action: 'control', goalId, status: 'active', reason: 'Synthetic activation', expectedGeneration: 1, expectedRevision: 1, operationId: randomUUID() }, invoke('mutateAgentGoal'))
})
afterEach(() => {
  sender.emit('did-start-navigation')
  sender.emit('destroyed')
  store.close()
  clearMagicAgentTrustedRouteBindingsForTest()
  vi.restoreAllMocks()
})

async function propose(outcome: 'completed' | 'failed' = 'completed') {
  await service.mutate({ ...user, action: 'propose', goalId, outcome, summary: 'Synthetic proposal', evidence, expectedGeneration: 2, expectedRevision: 2, operationId: randomUUID() }, invoke('mutateAgentGoal'))
}
function confirm(outcome: 'completed' | 'failed' = 'completed'): Extract<AgentGoalMutationReq, { action: 'confirm' }> {
  return { ...user, action: 'confirm', goalId, outcome, expectedGeneration: 2, expectedRevision: 3, operationId: randomUUID() }
}
function reject(): Extract<AgentGoalMutationReq, { action: 'reject-proposal' }> {
  return { ...user, action: 'reject-proposal', goalId, expectedGeneration: 2, expectedRevision: 3, operationId: randomUUID() }
}

describe('user proposal decisions through the real service and synthetic in-memory store', () => {
  it.each(['completed', 'failed'] as const)('confirms a matching %s proposal and retains its evidence', async outcome => {
    await propose(outcome)
    const req = confirm(outcome)
    const result = await service.mutate(req, invoke('mutateAgentGoal'))
    expect(result).toMatchObject({ status: 'applied', operationId: req.operationId, revision: 4, goals: [{ id: goalId, generation: 3, status: outcome, proposal: { outcome, summary: 'Synthetic proposal', evidence } }] })
    expect(store.read(scope)).toMatchObject({ revision: 4, goals: [{ id: goalId, generation: 3, status: outcome, proposal: { outcome, evidence } }] })
  })

  it('rejects only the proposal, retaining progress and a nonterminal active goal', async () => {
    await service.mutate({ ...user, action: 'report', goalId, summary: 'Synthetic progress', evidence: ['progress evidence'], expectedGeneration: 2, expectedRevision: 2, operationId: randomUUID() }, invoke('mutateAgentGoal'))
    await service.mutate({ ...user, action: 'propose', goalId, outcome: 'completed', summary: 'Synthetic proposal', evidence, expectedGeneration: 2, expectedRevision: 3, operationId: randomUUID() }, invoke('mutateAgentGoal'))
    const req = { ...reject(), expectedRevision: 4 }
    const before = store.read(scope).goals[0]
    const result = await service.mutate(req, invoke('mutateAgentGoal'))
    expect(result).toMatchObject({ status: 'applied', operationId: req.operationId, revision: 5, goals: [{ id: goalId, generation: 3, status: 'active', progress: before.progress }] })
    const after = store.read(scope).goals[0]
    expect(after.proposal).toBeUndefined()
    expect(after.progress).toEqual(before.progress)
    expect(after.spec).toEqual(before.spec)
    expect(after.reason).toEqual(before.reason)
  })

  it('rejects mismatched outcome and stale generation without changing the proposal', async () => {
    await propose()
    const before = store.read(scope)
    await expect(service.mutate(confirm('failed'), invoke('mutateAgentGoal'))).rejects.toThrow('does not match the current proposal')
    await expect(service.mutate({ ...confirm(), expectedGeneration: 1 }, invoke('mutateAgentGoal'))).rejects.toThrow('Goal generation conflict')
    expect(store.read(scope)).toEqual(before)
  })

  it.each(['confirm', 'reject-proposal'] as const)('rejects %s without a proposal', async action => {
    const before = store.read(scope)
    const req = action === 'confirm' ? { ...confirm(), expectedRevision: 2 } : { ...reject(), expectedRevision: 2 }
    await expect(service.mutate(req, invoke('mutateAgentGoal'))).rejects.toThrow(action === 'confirm' ? 'does not match the current proposal' : 'no current proposal')
    expect(store.read(scope)).toEqual(before)
  })

  it.each(['confirm', 'reject-proposal'] as const)('returns retry-not-applied for stale revision on %s', async action => {
    await propose()
    const before = store.read(scope)
    const req = { ...(action === 'confirm' ? confirm() : reject()), expectedRevision: 2 }
    expect(await service.mutate(req, invoke('mutateAgentGoal'))).toEqual({ status: 'retry-not-applied', priorOutcome: 'unknown', operationId: req.operationId, reason: 'revision-conflict', currentRevision: 3 })
    expect(store.read(scope)).toEqual(before)
  })

  it.each(['confirm', 'reject-proposal'] as const)('rejects %s on a terminal goal', async action => {
    await propose()
    await service.mutate(confirm(), invoke('mutateAgentGoal'))
    const before = store.read(scope)
    const req = { ...(action === 'confirm' ? confirm() : reject()), expectedGeneration: 3, expectedRevision: 4 }
    await expect(service.mutate(req, invoke('mutateAgentGoal'))).rejects.toThrow('Terminal goal cannot be mutated')
    expect(store.read(scope)).toEqual(before)
  })

  it('rejects an invalid scope lease without changing the proposal', async () => {
    await propose()
    const before = store.read(scope)
    await expect(service.mutate({ ...confirm(), documentToken: 'synthetic-invalid-token' }, invoke('mutateAgentGoal'))).rejects.toThrow()
    expect(store.read(scope)).toEqual(before)
  })

  it.each(['confirm', 'reject-proposal'] as const)('does not replay %s after lease loss following commit', async action => {
    await propose()
    const req = action === 'confirm' ? confirm() : reject()
    const mutate = store.mutateUser.bind(store)
    const spy = vi.spyOn(store, 'mutateUser').mockImplementationOnce((...args) => {
      const result = mutate(...args)
      sender.emit('did-start-navigation')
      return result
    })
    // The caller sees an error, so the outcome is unknown until separately observed.
    await expect(service.mutate(req, invoke('mutateAgentGoal'))).rejects.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
    const final = store.read(scope)
    expect(final).toMatchObject({ revision: 4, goals: [{ id: goalId, generation: 3, status: action === 'confirm' ? 'completed' : 'active' }] })
    if (action === 'confirm') expect(final.goals[0].proposal).toMatchObject({ outcome: 'completed', evidence })
    else expect(final.goals[0].proposal).toBeUndefined()
  })
})
