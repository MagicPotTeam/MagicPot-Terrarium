import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), config: { use_remote_llm: false } }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/config', () => ({ getConfig: () => h.config }))
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { AgentThreadGoals } from './agentThreadGoals'
import { agentGoalScopeRevision, setAgentGoalScope } from './agentThreadGoalScope'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import type { AgentGoalMutationReq, AgentGoalScope } from '@shared/api/agentThreadGoal'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let sender: EventEmitter, store: AgentThreadGoalStore, service: AgentThreadGoals, user: AgentGoalScope
beforeEach(() => {
  vi.clearAllMocks(); h.config.use_remote_llm = false
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, scope.route, { trustedUrl: url, trustedWebContents: sender as never })
  store = new AgentThreadGoalStore(sideTestCodec()); service = new AgentThreadGoals(async () => store)
  user = { ...scope, documentToken: setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope')).documentToken! }
})
afterEach(() => { sender.emit('did-start-navigation'); sender.emit('destroyed'); store.close(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
const request = (): AgentGoalMutationReq => ({ ...user, action: 'create', goalId: randomUUID(), title: 'User goal <script>not executed</script>', spec: normalizeAgentGoalSpec({ objective: 'PRIVATE_GOAL_DATA' }), expectedRevision: 0, operationId: randomUUID() })
describe('explicit user goal record service and document lifecycle', () => {
  it('creates scoped data without running models, injecting context or exposing receipts', async () => {
    const req = request(), first = await service.mutate(req, invoke('mutateAgentGoal'))
    expect(first).toMatchObject({ status: 'applied', revision: 1, operationId: req.operationId, goals: [{ id: req.goalId, status: 'draft' }], grantsPermission: false, untrustedData: true })
    expect(first).not.toHaveProperty('receipts'); expect(first).not.toHaveProperty('retiredIds')
    expect(await service.mutate(req, invoke('mutateAgentGoal'))).toEqual(first)
    expect(await service.list(user, invoke('listAgentGoals'))).toMatchObject({ revision: 1, goals: [{ spec: { objective: 'PRIVATE_GOAL_DATA' } }] })
    expect(store.read({ ...scope, conversationId: 'different' }).revision).toBe(0)
    const stale = { ...request(), operationId: 'stale-new' }
    expect(await service.mutate(stale, invoke('mutateAgentGoal'))).toEqual({ status: 'retry-not-applied', priorOutcome: 'unknown', reason: 'revision-conflict', operationId: 'stale-new', currentRevision: 1 })
  })
  it.each(['navigation', 'conversation', 'remote'] as const)('rechecks %s after awaiting storage before a mutation', async mode => {
    let release!: () => void
    const pendingService = new AgentThreadGoals(() => new Promise(resolve => { release = () => resolve(store) }))
    const req = request(), pending = pendingService.mutate(req, invoke('mutateAgentGoal'))
    if (mode === 'navigation') sender.emit('did-start-navigation')
    else if (mode === 'conversation') setAgentGoalScope({ ...scope, conversationId: 'other', active: true, lifecycleRevision: 2 }, invoke('setAgentGoalScope'))
    else h.config.use_remote_llm = true
    release(); await expect(pending).rejects.toThrow()
    expect(store.read(scope).revision).toBe(0)
  })
  it('does not hide generic response-loss uncertainty, and the original ID recovers after a fresh binding', async () => {
    const req = request(), mutate = store.mutateUser.bind(store)
    vi.spyOn(store, 'mutateUser').mockImplementationOnce((...args) => { const result = mutate(...args); sender.emit('did-start-navigation'); return result })
    await expect(service.mutate(req, invoke('mutateAgentGoal'))).rejects.toThrow()
    expect(store.read(scope).revision).toBe(1)
    const revision = agentGoalScopeRevision(scope, invoke('agentGoalScopeRevision')).revision + 1
    const token = setAgentGoalScope({ ...scope, active: true, lifecycleRevision: revision }, invoke('setAgentGoalScope')).documentToken!
    expect(await service.mutate({ ...req, documentToken: token }, invoke('mutateAgentGoal'))).toMatchObject({ status: 'applied', revision: 1 })
  })
  it('labels an evicted original receipt as retry-only rejection with prior outcome still unknown', async () => {
    const req = request(); await service.mutate(req, invoke('mutateAgentGoal'))
    for (let revision = 1; revision <= 65; revision++) store.mutateUser(scope, { action: 'update', goalId: req.goalId, expectedRevision: revision, expectedGeneration: revision, operationId: `later-${revision}`, title: 'latest', spec: normalizeAgentGoalSpec({ objective: 'latest' }) })
    expect(await service.mutate(req, invoke('mutateAgentGoal'))).toEqual({ status: 'retry-not-applied', priorOutcome: 'unknown', operationId: req.operationId, reason: 'revision-conflict', currentRevision: 66 })
    expect(store.read(scope).goals).toHaveLength(1)
  })
  it('preserves retirement high water across retire-before-activate, stale reactivation and same-URL reload', () => {
    setAgentGoalScope({ ...scope, active: false, lifecycleRevision: 5 }, invoke('setAgentGoalScope'))
    expect(() => setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 5 }, invoke('setAgentGoalScope'))).toThrow('Retired')
    expect(() => setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 4 }, invoke('setAgentGoalScope'))).toThrow('Stale')
    setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 6 }, invoke('setAgentGoalScope')); sender.emit('did-start-navigation')
    expect(agentGoalScopeRevision(scope, invoke('agentGoalScopeRevision'))).toEqual({ revision: 6 })
    expect(() => setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 6 }, invoke('setAgentGoalScope'))).toThrow('Retired')
    expect(setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 7 }, invoke('setAgentGoalScope')).documentToken).toBeTruthy()
  })
  it('rejects caller actor flags, remote routing, stale tokens and forged/widened IPC', async () => {
    const req = request()
    await expect(service.mutate({ ...req, actor: 'user' } as unknown as AgentGoalMutationReq, invoke('mutateAgentGoal'))).rejects.toThrow('Invalid')
    for (const invocation of [undefined, invoke('chat'), { ...invoke('mutateAgentGoal'), senderId: 72 }, { ...invoke('mutateAgentGoal'), isMainFrame: false }]) await expect(service.mutate(req, invocation)).rejects.toThrow()
    await expect(service.mutate({ ...req, documentToken: 'forged' }, invoke('mutateAgentGoal'))).rejects.toThrow('conversation')
    await expect(service.list({ ...user, all: true } as AgentGoalScope, invoke('listAgentGoals'))).rejects.toThrow('Invalid')
    h.config.use_remote_llm = true; await expect(service.mutate(req, invoke('mutateAgentGoal'))).rejects.toThrow('local desktop')
    expect(store.read(scope).revision).toBe(0)
  })
})
