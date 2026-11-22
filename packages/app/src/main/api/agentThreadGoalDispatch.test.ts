import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), config: { use_remote_llm: false }, committed: undefined as undefined | (() => void) }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/config', () => ({ getConfig: () => h.config, onConfigCommitted: (listener: () => void) => { h.committed = listener; return () => { h.committed = undefined } } }))
import { AgentThreadGoalDispatch } from './agentThreadGoalDispatch'
import { setAgentGoalScope } from './agentThreadGoalScope'
import { ProviderInvocationLedgerDataStore } from '../llmProxy/providerDispatchLedgerStore'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
import { ProviderDispatchOwner } from '../llmProxy/providerDispatchOwner'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentGoalScope } from '@shared/api/agentThreadGoal'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invoke = (name = 'listAgentGoalDispatches') => ({ methodName: `svcLLMProxy.${name}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let sender: EventEmitter, owner: ProviderDispatchOwner, service: AgentThreadGoalDispatch, user: AgentGoalScope, root: string, codec: ReturnType<typeof sideTestCodec>
beforeEach(() => {
  vi.clearAllMocks(); h.config.use_remote_llm = false; h.committed = undefined
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, scope.route, { trustedUrl: url, trustedWebContents: sender as never })
  root = mkdtempSync(path.join(tmpdir(), 'user-dispatch-read-')); codec = sideTestCodec(); owner = new ProviderDispatchOwner(root, codec); service = new AgentThreadGoalDispatch(async () => owner)
  user = { ...scope, documentToken: setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope')).documentToken! }
})
afterEach(async () => { sender.emit('did-start-navigation'); sender.emit('destroyed'); await owner.shutdown(); rmSync(root, { force: true, recursive: true }); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
describe('explicit user-only dispatch ledger inspection, no model/start/mutation authority', () => {
  it('returns empty current-conversation data without creating a run or exposing internal replay fields', async () => {
    const value = await service.list(user, invoke())
    expect(value).toMatchObject({ revision: 0, runs: [], scopeBlocked: false, orphaned: false, budgetsEnforced: false, mode: 'data-only', grantsPermission: false })
    expect(value).not.toHaveProperty('ownerHash'); expect(value).not.toHaveProperty('receipts')
    expect(owner.readData(scope).document.revision).toBe(0)
  })
  it('shows charged pending and unknown metadata but not profile hashes, operation receipts or goal text', async () => {
    const request = owner.createAdmission({ scope, binding: { goalId: randomUUID(), generation: 2, profileHash: 'a'.repeat(64) }, expectedRevision: 0, maxProviderDispatches: 2, maxWalltimeMs: 10000, endpoint: 'https://model.test/chat', fetch: vi.fn(async () => new Response('PRIVATE_PROVIDER_RESPONSE')), signal: new AbortController().signal, assertLive: () => undefined })
    const response = await request.fetch('https://model.test/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"PRIVATE_PROMPT"}' })
    const before = owner.readData(scope).document
    const value = await service.list(user, invoke())
    expect(value).toMatchObject({ revision: 2, scopeBlocked: true, runs: [{ chargedProviderDispatches: 1, attempts: [{ state: 'pending' }] }] })
    expect(owner.readData(scope).document).toEqual(before)
    expect(JSON.stringify(value)).not.toMatch(/profileHash|operationHash|digest|ownerHash|PRIVATE_PROMPT|PRIVATE_PROVIDER_RESPONSE/)
    await response.body!.cancel()
    expect(await service.list(user, invoke())).toMatchObject({ runs: [{ status: 'unknown', attempts: [{ state: 'unknown' }] }], scopeBlocked: true })
    request.dispose()
  })
  it('reports retained owner capacity without deleting records or buying a new namespace', async () => {
    for (let i = 0; i < 4; i++) {
      const request = owner.createAdmission({ scope, binding: { goalId: randomUUID(), generation: 2, profileHash: 'a'.repeat(64) }, expectedRevision: i * 2, maxProviderDispatches: 1, maxWalltimeMs: 10000, endpoint: 'https://model.test/chat', fetch: vi.fn(async () => new Response('never called')), signal: new AbortController().signal, assertLive: () => undefined })
      request.finish()
    }
    expect(await service.list(user, invoke())).toMatchObject({ revision: 8, capacityReached: true, scopeBlocked: false, grantsPermission: false })
    expect(owner.readData(scope).document.runs).toHaveLength(4)
  })
  it('projects retained v1 and v2 unit DATA without backfilling legacy usage, hashes or a fresh v1 capability', async () => {
    const request = owner.createAdmission({ scope, binding: { goalId: randomUUID(), generation: 2, profileHash: 'a'.repeat(64) }, expectedRevision: 0, maxProviderDispatches: 1, maxWalltimeMs: 10000, endpoint: 'https://model.test/chat', fetch: vi.fn(async () => new Response('never called')), signal: new AbortController().signal, assertLive: () => undefined })
    request.finish(); const legacy = owner.readData(scope).document
    await owner.shutdown()
    const store = new ProviderInvocationLedgerDataStore(codec, path.join(root, 'ledger-v1.sqlite'))
    try {
      const now = Date.now(), upgrade = { action: 'upgrade-v2' as const, operationId: randomUUID(), expectedRevision: legacy.revision }
      store.upgradeV2(scope, upgrade, now)
      const runId = randomUUID(), modelId = randomUUID(), dispatchId = randomUUID()
      store.applyV2(scope, { action: 'begin-v2', operationId: randomUUID(), runId, expectedRevision: 3, binding: { goalId: randomUUID(), generation: 7, profileHash: 'b'.repeat(64) }, limits: { maxModelSteps: 2, maxToolInvocations: 1, maxProviderDispatches: 2 }, maxWalltimeMs: 10000 }, now)
      store.applyV2(scope, { action: 'reserve-unit', operationId: randomUUID(), runId, expectedRevision: 4, unitId: modelId, unit: 'modelStep' }, now)
      store.applyV2(scope, { action: 'reserve-unit', operationId: randomUUID(), runId, expectedRevision: 5, unitId: dispatchId, unit: 'providerDispatch', parentId: modelId }, now)
    } finally { store.close() }
    owner = new ProviderDispatchOwner(root, codec); service = new AgentThreadGoalDispatch(async () => owner)
    const before = owner.readCurrentData(scope), value = await service.list(user, invoke())
    expect(value).toMatchObject({ revision: 6, payloadVersion: 2, scopeBlocked: true, v1ExecutionUnsupported: true, orphaned: true, budgetsEnforced: false, grantsPermission: false })
    expect(value.runs).toHaveLength(2)
    expect(value.runs[0].id).toBe(legacy.runs[0].id); expect(value.runs[0]).not.toHaveProperty('unitAccounting')
    expect(value.runs[1]).toMatchObject({ generation: 7, chargedProviderDispatches: 1, unitAccounting: { chargedModelSteps: 1, maxModelSteps: 2, chargedToolInvocations: 0, maxToolInvocations: 1, units: [{ unit: 'modelStep', state: 'pending' }, { unit: 'providerDispatch', state: 'pending' }] }, attempts: [{ state: 'pending' }] })
    expect(JSON.stringify(value)).not.toMatch(/ownerHash|profileHash|operationHash|digest|upgrade|legacy/)
    expect(owner.readCurrentData(scope)).toEqual(before)
    expect(() => owner.readData(scope)).toThrow('unsupported by the v1 API')
    const send = vi.fn(async () => new Response('must not send'))
    expect(() => owner.createAdmission({ scope, binding: { goalId: randomUUID(), generation: 1, profileHash: 'b'.repeat(64) }, expectedRevision: 6, maxProviderDispatches: 1, maxWalltimeMs: 1000, endpoint: 'https://model.test/chat', fetch: send, signal: new AbortController().signal, assertLive: () => undefined })).toThrow('unsupported')
    expect(send).not.toHaveBeenCalled(); expect(owner.readCurrentData(scope)).toEqual(before)
    expect(await service.list({ ...user, conversationId: 'other' }, invoke()).catch(() => undefined)).toBeUndefined() // trusted current conversation gate
  })
  it('reports combined legacy plus v2 retained-run capacity without allowing execution for a quiescent v2 payload', async () => {
    await owner.shutdown()
    const store = new ProviderInvocationLedgerDataStore(codec, path.join(root, 'ledger-v1.sqlite'))
    try {
      let revision = 0, clock = Date.now()
      for (let i = 0; i < 3; i++) {
        const runId = randomUUID()
        store.apply(scope, { action: 'begin', operationId: randomUUID(), runId, expectedRevision: revision++, binding: { goalId: randomUUID(), generation: 1, profileHash: 'a'.repeat(64) }, maxProviderDispatches: 1, maxWalltimeMs: 10000 }, clock++)
        store.apply(scope, { action: 'finish', operationId: randomUUID(), runId, expectedRevision: revision++ }, clock++)
      }
      store.upgradeV2(scope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: revision++ }, clock++)
      const runId = randomUUID()
      store.applyV2(scope, { action: 'begin-v2', operationId: randomUUID(), runId, expectedRevision: revision++, binding: { goalId: randomUUID(), generation: 1, profileHash: 'a'.repeat(64) }, limits: { maxModelSteps: 1, maxToolInvocations: 0, maxProviderDispatches: 1 }, maxWalltimeMs: 10000 }, clock++)
      store.applyV2(scope, { action: 'finish-v2', operationId: randomUUID(), runId, expectedRevision: revision++ }, clock++)
      const db = (store as unknown as { db: NodeSQLiteAdapter }).db
      expect(db.get('SELECT count(*) AS n FROM dispatch_ledger')?.n).toBe(1)
    } finally { store.close() }
    owner = new ProviderDispatchOwner(root, codec); service = new AgentThreadGoalDispatch(async () => owner)
    const before = owner.readCurrentData(scope), value = await service.list(user, invoke())
    expect(value).toMatchObject({ revision: 9, payloadVersion: 2, capacityReached: true, orphaned: false, scopeBlocked: true, v1ExecutionUnsupported: true })
    expect(value.runs).toHaveLength(4); expect(value.runs.every(run => run.status === 'finished')).toBe(true)
    expect(value.runs.filter(run => run.unitAccounting)).toHaveLength(1)
    expect(owner.readCurrentData(scope)).toEqual(before)
  })
  it.each(['navigation', 'conversation', 'remote', 'config-roundtrip'] as const)('rechecks %s after asynchronous ownership opening and does not disclose stale data', async mode => {
    let release!: () => void
    const loading = vi.fn(() => new Promise<ProviderDispatchOwner>(resolve => { release = () => resolve(owner) })), pendingService = new AgentThreadGoalDispatch(loading)
    const read = vi.spyOn(owner, 'readCurrentData'), pending = pendingService.list(user, invoke())
    if (mode === 'navigation') sender.emit('did-start-navigation')
    else if (mode === 'conversation') setAgentGoalScope({ ...scope, conversationId: 'other', active: true, lifecycleRevision: 2 }, invoke('setAgentGoalScope'))
    else if (mode === 'remote') h.config.use_remote_llm = true
    else { h.config.use_remote_llm = true; h.committed!(); h.config.use_remote_llm = false }
    release(); await expect(pending).rejects.toThrow(); expect(read).not.toHaveBeenCalled()
  })
  it('refuses repeated pending reads from the same sender before starting duplicate storage I/O', async () => {
    let release!: () => void
    const load = vi.fn(() => new Promise<ProviderDispatchOwner>(resolve => { release = () => resolve(owner) })), pendingService = new AgentThreadGoalDispatch(load)
    const pending = pendingService.list(user, invoke())
    await expect(pendingService.list(user, invoke())).rejects.toThrow('busy'); expect(load).toHaveBeenCalledOnce()
    release(); await pending; expect(h.committed).toBeUndefined()
    load.mockResolvedValue(owner)
    expect(await pendingService.list(user, invoke())).toBeDefined()
  })
  it('rejects wrong sender/frame/method/token/route and model actor fields without loading ownership', async () => {
    const load = vi.fn(async () => owner), pendingService = new AgentThreadGoalDispatch(load)
    for (const invocation of [undefined, invoke('chat'), { ...invoke(), senderId: 72 }, { ...invoke(), isMainFrame: false }]) await expect(pendingService.list(user, invocation)).rejects.toThrow()
    await expect(pendingService.list({ ...user, documentToken: 'forged' }, invoke())).rejects.toThrow()
    await expect(pendingService.list({ ...user, actor: 'user' } as AgentGoalScope, invoke())).rejects.toThrow('Invalid')
    await expect(pendingService.list({ ...user, all: true } as AgentGoalScope, invoke())).rejects.toThrow('Invalid')
    h.config.use_remote_llm = true; await expect(pendingService.list(user, invoke())).rejects.toThrow('local desktop')
    expect(load).not.toHaveBeenCalled()
  })
  it('does not disclose a synchronous read response after its document lease is revoked', async () => {
    const read = owner.readCurrentData.bind(owner)
    vi.spyOn(owner, 'readCurrentData').mockImplementationOnce(req => { const value = read(req); sender.emit('did-start-navigation'); return value })
    await expect(service.list(user, invoke())).rejects.toThrow()
  })
})
