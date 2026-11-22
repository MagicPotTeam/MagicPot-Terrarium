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
import type { AgentGoalMutationReq, AgentGoalScope, AgentModelGoalMutation } from '@shared/api/agentThreadGoal'
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
/** Two drafts created through the service; returns their ids. */
async function twoDrafts(): Promise<[string, string]> {
  const ids: [string, string] = [randomUUID(), randomUUID()]
  for (const [index, goalId] of ids.entries()) {
    const created = await service.mutate({ ...user, action: 'create', goalId, title: `Synthetic ${index}`, spec: normalizeAgentGoalSpec({ objective: 'synthetic objective' }), expectedRevision: index, operationId: randomUUID() }, invoke('mutateAgentGoal'))
    expect(created).toMatchObject({ status: 'applied', revision: index + 1 })
  }
  return ids
}
const deletion = (goalId: string, expectedRevision: number, expectedGeneration = 1): AgentGoalMutationReq => ({ ...user, action: 'delete', goalId, expectedGeneration, expectedRevision, operationId: randomUUID() })

describe('goal delete through the user service', () => {
  it('applies to the chosen draft only, without exposing retired ids or receipts, and replays the same result', async () => {
    const [a, b] = await twoDrafts(), other = store.read(scope).goals[1]
    const req = deletion(a, 2), first = await service.mutate(req, invoke('mutateAgentGoal'))
    expect(first).toEqual({ status: 'applied', operationId: req.operationId, revision: 3, goals: [other], untrustedData: true, grantsPermission: false })
    expect(first).not.toHaveProperty('retiredIds'); expect(first).not.toHaveProperty('receipts')
    expect(await service.mutate(req, invoke('mutateAgentGoal'))).toEqual(first)
    expect(store.read(scope)).toMatchObject({ revision: 3, goals: [{ id: b }], retiredIds: [a] })
  })

  it('reports a stale revision as retry-not-applied and keeps the goal', async () => {
    const [a] = await twoDrafts(), before = store.read(scope)
    const req = deletion(a, 1)
    expect(await service.mutate(req, invoke('mutateAgentGoal'))).toEqual({ status: 'retry-not-applied', priorOutcome: 'unknown', operationId: req.operationId, reason: 'revision-conflict', currentRevision: 2 })
    expect(store.read(scope)).toEqual(before)
  })

  it('rejects a delete of an active goal and changes nothing', async () => {
    const [a] = await twoDrafts()
    await service.mutate({ ...user, action: 'control', goalId: a, expectedGeneration: 1, status: 'active', reason: 'synthetic', expectedRevision: 2, operationId: randomUUID() }, invoke('mutateAgentGoal'))
    const before = store.read(scope)
    await expect(service.mutate(deletion(a, 3, 2), invoke('mutateAgentGoal'))).rejects.toThrow('Pause the goal before deleting it')
    expect(store.read(scope)).toEqual(before)
  })

  it.each(['navigation', 'conversation', 'remote'] as const)('rechecks %s after awaiting storage and keeps the goal', async mode => {
    const [a] = await twoDrafts(), before = store.read(scope)
    let release!: () => void
    const pendingService = new AgentThreadGoals(() => new Promise(resolve => { release = () => resolve(store) }))
    const pending = pendingService.mutate(deletion(a, 2), invoke('mutateAgentGoal'))
    if (mode === 'navigation') sender.emit('did-start-navigation')
    else if (mode === 'conversation') setAgentGoalScope({ ...scope, conversationId: 'other', active: true, lifecycleRevision: 2 }, invoke('setAgentGoalScope'))
    else h.config.use_remote_llm = true
    release(); await expect(pending).rejects.toThrow()
    expect(store.read(scope)).toEqual(before)
  })

  it('does not report a delete whose reply was lost as applied, and the same operation recovers without a second removal', async () => {
    const [a, b] = await twoDrafts(), mutate = store.mutateUser.bind(store)
    vi.spyOn(store, 'mutateUser').mockImplementationOnce((...args) => { const result = mutate(...args); sender.emit('did-start-navigation'); return result })
    const req = deletion(a, 2)
    await expect(service.mutate(req, invoke('mutateAgentGoal'))).rejects.toThrow()
    const committed = store.read(scope)
    expect(committed).toMatchObject({ revision: 3, goals: [{ id: b }], retiredIds: [a] })
    const revision = agentGoalScopeRevision(scope, invoke('agentGoalScopeRevision')).revision + 1
    const token = setAgentGoalScope({ ...scope, active: true, lifecycleRevision: revision }, invoke('setAgentGoalScope')).documentToken!
    expect(await service.mutate({ ...req, documentToken: token }, invoke('mutateAgentGoal'))).toMatchObject({ status: 'applied', operationId: req.operationId, revision: 3, goals: [{ id: b }] })
    expect(store.read(scope)).toEqual(committed)
  })

  it('never lets a model mutation delete, even with a current binding', async () => {
    const [a] = await twoDrafts()
    await service.mutate({ ...user, action: 'control', goalId: a, expectedGeneration: 1, status: 'active', reason: 'synthetic', expectedRevision: 2, operationId: randomUUID() }, invoke('mutateAgentGoal'))
    const before = store.read(scope)
    const forged = { action: 'delete', goalId: a, expectedGeneration: 2, expectedRevision: 3, operationId: 'model-delete' } as unknown as AgentModelGoalMutation
    expect(() => store.mutateModel(scope, forged, { goalId: a, generation: 2 })).toThrow('binding')
    expect(store.read(scope)).toEqual(before)
  })
})
