import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vol } from 'memfs'
import { net } from 'electron'
import { DEFAULT_CONFIG } from '../../shared/config/config'
import { digestPolicyRequest } from '../../shared/magicAgentPlatform2'
import { initConfig, getConfig, saveConfig } from '../config/config'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence'
import { MagicAgentPolicyAuthorizationService } from '../magicAgentPlatform2/policy'
import { TerminalApprovalCoordinator } from '../magicAgentPlatform2/terminalApprovalCoordinator'
import { ProductionAgentInstanceLifecycle } from '../magicAgentPlatform2/agents/productionAgentInstanceLifecycleOwner'
import type { ManagedFirstRunDependencies, ManagedFirstRunIntent, ManagedFirstRunPreparationSource } from '../magicAgentPlatform2/agents/managedFirstRunLifecycle'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'
import { setManagedFirstRunPaneScope } from './agentThreadManagedFirstRunScope'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'

const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent }, net: { fetch: vi.fn(), request: vi.fn() }, app: { getPath: () => '.' } }))
vi.mock('node:fs', async importActual => importActual())
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: '/managed-pane-test' } }) }))
vi.mock('../magicAgentRuntime/packageResolver', () => ({ MagicAgentPackageResolver: class {} }))
vi.mock('@main/aiClients/visionClient', () => ({ createVisionChatClient: vi.fn() }))
const url = 'file:///D:/app/index.html#/canvas?id=project'
const scope = () => ({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'thread' }, conversationId: 'conversation' })
const invocation = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, frameUrl: url, senderUrl: url, isMainFrame: true })
const intent = (): ManagedFirstRunIntent => ({ instanceId: 'pane-root', runId: 'pane-run', name: 'Bounded pane run', text: 'Explicit input only', profileId: 'pane-profile', maxOutputTokens: 64, route: { channel: 'generic', scopeType: 'dm', scopeId: 'new-isolated-managed-pane' } })
let prepare: ManagedFirstRunDependencies['prepare'], sender: EventEmitter, source: ManagedFirstRunPreparationSource
const events: MagicAgentEventStore[] = []
beforeEach(async () => {
  vi.clearAllMocks(); vol.reset(); vol.mkdirSync('/managed-pane-test', { recursive: true })
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockImplementation(id => id === 71 ? sender : undefined)
  h.parent.mockImplementation(value => ({ isDestroyed: () => false, webContents: value }))
  registerMagicAgentTrustedRouteBinding(71, scope().route, { trustedUrl: url, trustedWebContents: sender as never })
  await initConfig()
  await saveConfig({ use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ id: 'pane-profile', provider: 'openai', deployment: 'local', call_type: 'local', model_use: 'agent', api_mode: 'chat-completions', base_url: 'http://127.0.0.1:1234/v1/chat/completions', api_key: 'test-secret', model_name: 'test-model', request_timeout_ms: 4000 }] } })
  const documentToken = setManagedFirstRunPaneScope({ ...scope(), active: true, lifecycleRevision: 1 }, invocation('setManagedFirstRunPaneScope')).documentToken!
  source = { pane: { ...scope(), documentToken }, invocation: invocation('startManagedFirstRun') }
  const modulePath = './agentThreadManagedFirstRunEnvironment'
  prepare = (await import(/* @vite-ignore */ modulePath)).prepareManagedFirstRunEnvironment
})
afterEach(() => { sender?.emit('destroyed'); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks(); for (const event of events.splice(0)) event.close(); vol.reset() })
const native = () => new Promise<void>(resolve => setTimeout(resolve, 15))
function joint() {
  const event = new MagicAgentEventStore(':memory:'); events.push(event)
  const approver = { kind: 'user' as const, id: 'magicpot-desktop-user' }
  const authorization = new MagicAgentPolicyAuthorizationService({ store: event, policyVersion: 'pane-test', storeId: 'pane-test', trustedApprovers: [approver], rules: [{ ruleId: 'explicit-managed-pane', priority: 100, effect: 'require-approval', match: { actions: ['agent.instance.managed.birth', 'agent.instance.managed.start'] }, explanation: 'Test rule, not production enablement.', approvalRequirement: { scopeKind: 'request', scopeValue: '*', maxUses: 1, expiresInMs: 60_000, reason: 'Explicit bounded input.' } }] })
  const approvals = new TerminalApprovalCoordinator(authorization, request => {
    const at = Date.now(), { grant } = authorization.createApprovalGrant({ grantId: `pane-grant:${digestPolicyRequest(request)}`, request, approvedBy: approver, maxUses: 1, issuedAt: at, expiresAt: at + 60_000, idempotencyKey: `pane-grant:${digestPolicyRequest(request)}` })
    return { grantId: grant.grantId, expectedGrantUseCount: 0 }
  })
  let captured: Awaited<ReturnType<typeof prepare>> | undefined
  const prepared = vi.fn(async (input: ManagedFirstRunIntent, signal: AbortSignal, context?: ManagedFirstRunPreparationSource) => {
    expect(owner.service.hasActive(input.instanceId)).toBe(true)
    captured = await prepare(input, signal, context); return captured
  })
  const owner = new ProductionAgentInstanceLifecycle({ eventStore: event, authorization, platformService: new MagicAgentPlatformSvcImpl(), runAgent: async () => { throw Error('No ordinary run') }, managedFirstRun: { approvals, prepare: prepared } })
  const approve = async () => { await vi.waitFor(() => expect(approvals.list()).toHaveLength(1)); const view = approvals.list()[0]; approvals.resolve({ approvalId: view.approvalId, expectedRevision: view.revision, approved: true }) }
  return { event, owner, approvals, approve, prepared, captured: () => captured! }
}

describe('disabled MAIN original-pane/config preparation with actual private service', () => {
  it('captures copied config, exact pane/desktop actor and an effect-free actual facade, not a runtime permission', async () => {
    const environment = await prepare(intent(), new AbortController().signal, source)
    expect(environment.config).not.toBe(getConfig()); expect(Object.isFrozen(environment.config)).toBe(true)
    expect(environment.actor).toEqual({ kind: 'user', id: 'magicpot-desktop-user' })
    expect(environment.document).toMatchObject({ senderId: 71, conversationId: 'conversation', revision: 1, paneRoute: scope().route })
    const planned = environment.facade.prepare({ agentId: intent().instanceId, text: intent().text, profileId: intent().profileId, route: intent().route, maxOutputTokens: 64 }, environment.config)
    expect(planned.material.model.body.messages).toEqual([{ role: 'user', content: 'Explicit input only' }])
    expect(planned.material.storage.history).toBe('new-private-session')
    expect(net.request).not.toHaveBeenCalled(); expect(net.fetch).not.toHaveBeenCalled()
    expect(Object.keys(vol.toJSON()).some(file => /assistant-sessions\.json$|managed-first-runs/u.test(file))).toBe(false)
    environment.dispose(); environment.dispose(); expect(environment.signal.aborted).toBe(true)
  })
  it.each(['owner', 'config', 'conversation', 'navigation'] as const)('synchronously seals dispatch on actual %s revocation', async reason => {
    const controller = new AbortController(), environment = await prepare(intent(), controller.signal, source)
    const originalConfig = environment.config
    if (reason === 'owner') controller.abort(Error('original owner ended'))
    else if (reason === 'config') await saveConfig({ llm_config: { api_profiles: [] } })
    else if (reason === 'conversation') setManagedFirstRunPaneScope({ ...scope(), conversationId: 'different', active: true, lifecycleRevision: 2 }, invocation('setManagedFirstRunPaneScope'))
    else sender.emit('did-start-navigation')
    expect(environment.signal.aborted).toBe(true); expect(() => environment.assertCurrent?.()).toThrow()
    expect(environment.config).toBe(originalConfig); expect(originalConfig.llm_config.api_profiles[0].api_key).toBe('test-secret')
    environment.dispose()
    expect(net.request).not.toHaveBeenCalled()
  })
  it('rejects absent/forged source and already cancelled preparation before reading configuration or creating a facade', async () => {
    const facade = vi.spyOn(MagicAgentPlatformSvcImpl, 'createManagedTextFirstRunService')
    await expect(prepare(intent(), new AbortController().signal)).rejects.toThrow()
    await expect(prepare(intent(), new AbortController().signal, { ...source, pane: { ...source.pane, documentToken: 'forged' } })).rejects.toThrow()
    const controller = new AbortController(); controller.abort(Error('cancelled before preparation'))
    await expect(prepare(intent(), controller.signal, source)).rejects.toThrow()
    expect(facade).not.toHaveBeenCalled(); expect(net.request).not.toHaveBeenCalled()
  })
  it('reserves the original lifecycle before real config capture and cancels pending birth approval on actual config commit', async () => {
    const f = joint(), handle = f.owner.service.startManagedTextFirstRun(intent(), source)
    await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    await saveConfig({ llm_config: { api_profiles: [] } }); await handle.joined
    await expect(handle.result).resolves.toEqual({ status: 'cancelled' })
    expect(f.prepared).toHaveBeenCalledOnce(); expect(f.approvals.list()).toHaveLength(0)
    expect(f.event.listResources().filter(row => row.kind.startsWith('managed-') || row.kind === 'agent-instance')).toHaveLength(0)
    expect(net.request).not.toHaveBeenCalled(); await f.owner.close()
  })
  it('retires only the virgin root after conversation change while awaiting start approval', async () => {
    const f = joint(), handle = f.owner.service.startManagedTextFirstRun(intent(), source)
    await f.approve(); await vi.waitFor(() => expect(f.approvals.list()).toHaveLength(1))
    setManagedFirstRunPaneScope({ ...scope(), conversationId: 'different', active: true, lifecycleRevision: 2 }, invocation('setManagedFirstRunPaneScope'))
    await handle.joined; expect(f.owner.store.get('pane-root')?.state.status).toBe('removed')
    expect(f.event.listResources({ kind: 'managed-agent-execution-attempt' })).toHaveLength(0)
    expect(net.request).not.toHaveBeenCalled(); await f.owner.close()
  })
  it('keeps original completion-only authority after real config revoke until native close and bounded terminal', async () => {
    const requests: EventEmitter[] = []
    vi.mocked(net.request).mockImplementation(() => {
      const request = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), abort: vi.fn() }); requests.push(request); return request as never
    })
    const f = joint(), handle = f.owner.service.startManagedTextFirstRun(intent(), source)
    await f.approve(); await f.approve(); await vi.waitFor(() => expect(requests).toHaveLength(1))
    let joined = false; void handle.joined.then(() => { joined = true })
    await saveConfig({ llm_config: { api_profiles: [] } }); await expect(handle.result).resolves.toEqual({ status: 'cancelled' }); await native()
    expect(joined).toBe(false); expect(f.owner.service.hasActive('pane-root')).toBe(true)
    expect(f.owner.store.get('pane-root')?.state.status).toBe('running')
    requests[0].emit('close'); await handle.joined
    expect(f.owner.store.get('pane-root')?.state.status).toBe('stopped')
    expect(f.event.listResources({ kind: 'managed-agent-execution-attempt' })[0].state).toMatchObject({ status: 'bounded-closed', terminal: { status: 'cancelled', witness: 'producer-closure' } })
    expect(f.event.listResources({ kind: 'managed-agent-instance-coverage' })[0]).toMatchObject({ revision: 1, state: { status: 'dirty' } })
    expect(net.request).toHaveBeenCalledOnce(); expect(net.fetch).not.toHaveBeenCalled(); await f.owner.close()
  })
})
