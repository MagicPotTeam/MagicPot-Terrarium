import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Synthetic sender/config; this exercises the real service, not Electron IPC.
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
function report(): Extract<AgentGoalMutationReq, { action: 'report' }> {
  return { ...user, action: 'report', goalId, summary: 'Synthetic progress', evidence: [], expectedGeneration: 2, expectedRevision: 2, operationId: randomUUID() }
}

describe('manual goal report through the real service with synthetic in-memory fixture', () => {
  it('persists once, replays the same operation, rejects changed payload and labels stale retry', async () => {
    const req = report()
    const first = await service.mutate(req, invoke('mutateAgentGoal'))
    expect(first).toMatchObject({ status: 'applied', operationId: req.operationId, revision: 3, goals: [{ id: goalId, generation: 2, status: 'active', progress: { summary: 'Synthetic progress', evidence: [] } }] })
    expect(await service.mutate(req, invoke('mutateAgentGoal'))).toEqual(first)
    const snapshot = store.read(scope)
    expect(snapshot.revision).toBe(3)
    await expect(service.mutate({ ...req, summary: 'Different synthetic text' }, invoke('mutateAgentGoal'))).rejects.toThrow('Goal replay conflict')
    expect(store.read(scope)).toEqual(snapshot)
    const stale = { ...req, operationId: randomUUID() }
    expect(await service.mutate(stale, invoke('mutateAgentGoal'))).toEqual({ status: 'retry-not-applied', priorOutcome: 'unknown', operationId: stale.operationId, reason: 'revision-conflict', currentRevision: 3 })
    expect(store.read(scope)).toEqual(snapshot)
  })
  it('rejects a stale goal generation without changing data', async () => {
    const before = store.read(scope)
    await expect(service.mutate({ ...report(), expectedGeneration: 1 }, invoke('mutateAgentGoal'))).rejects.toThrow('Goal generation conflict')
    expect(store.read(scope)).toEqual(before)
  })
  it('rejects report on a paused goal without changing data', async () => {
    await service.mutate({ ...user, action: 'control', goalId, status: 'paused', reason: 'Synthetic pause', expectedGeneration: 2, expectedRevision: 2, operationId: randomUUID() }, invoke('mutateAgentGoal'))
    const before = store.read(scope)
    await expect(service.mutate({ ...report(), expectedRevision: 3, expectedGeneration: 3 }, invoke('mutateAgentGoal'))).rejects.toThrow('not accepting model progress')
    expect(store.read(scope)).toEqual(before)
  })
  it('rejects a stale document lease without changing data', async () => {
    const before = store.read(scope)
    sender.emit('did-start-navigation')
    await expect(service.mutate(report(), invoke('mutateAgentGoal'))).rejects.toThrow()
    expect(store.read(scope)).toEqual(before)
  })
  it('does not claim a failed response means no commit when navigation follows the store transaction', async () => {
    const req = report()
    const mutate = store.mutateUser.bind(store)
    vi.spyOn(store, 'mutateUser').mockImplementationOnce((...args) => {
      const result = mutate(...args)
      sender.emit('did-start-navigation')
      return result
    })
    await expect(service.mutate(req, invoke('mutateAgentGoal'))).rejects.toThrow()
    expect(store.read(scope)).toMatchObject({ revision: 3, goals: [{ id: goalId, generation: 2, progress: { summary: 'Synthetic progress', evidence: [] } }] })
  })
})
