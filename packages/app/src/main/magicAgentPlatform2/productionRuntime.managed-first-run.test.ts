import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { net } from 'electron'
import { vol } from 'memfs'
import { DEFAULT_CONFIG } from '../../shared/config/config'
import { evaluatePolicy, digestPolicyRequest, type PolicyRequest } from '../../shared/magicAgentPlatform2'
import { initConfig, saveConfig } from '../config/config'
import { setManagedFirstRunPaneScope } from '../api/agentThreadManagedFirstRunScope'
import { prepareManagedFirstRunEnvironment } from '../api/agentThreadManagedFirstRunEnvironment'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
import { MagicAgentPlatformSvcImpl } from '../api/svcMagicAgentPlatformImpl'
import { ProductionAgentInstanceLifecycle } from './agents/productionAgentInstanceLifecycleOwner'
import { createManagedFirstRunStopPolicyRequest } from './agents/productionAgentInstanceLifecycle'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { getAgentSessionKey } from '../../shared/agent'
import type { ManagedFirstRunIntent, ManagedFirstRunPreparationSource } from './agents/managedFirstRunLifecycle'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from './productionRuntime'
import * as production from './productionRuntime'

const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent }, net: { fetch: vi.fn(), request: vi.fn() }, app: { getPath: () => '.' } }))
vi.mock('node:fs', async importActual => importActual())
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: '/managed-production-policy' } }) }))
vi.mock('../magicAgentRuntime/packageResolver', () => ({ MagicAgentPackageResolver: class {} }))
vi.mock('@main/aiClients/visionClient', () => ({ createVisionChatClient: vi.fn() }))
const url = 'file:///D:/app/index.html#/canvas?id=project'
const pane = () => ({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'thread' }, conversationId: 'conversation' })
const invocation = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, frameUrl: url, senderUrl: url, isMainFrame: true })
const intent = (): ManagedFirstRunIntent => ({ instanceId: 'production-policy-root', runId: 'production-policy-run', name: 'Explicit bounded run', text: 'EXPLICIT_FIRST_RUN_INPUT', profileId: 'bounded-profile', maxOutputTokens: 64, route: { channel: 'generic', scopeType: 'dm', scopeId: 'fresh-managed-production-policy' } })
let sender: EventEmitter, source: ManagedFirstRunPreparationSource
const owners: ProductionAgentInstanceLifecycle[] = [], requests: EventEmitter[] = []
beforeEach(async () => {
  vi.clearAllMocks(); vol.reset(); vol.mkdirSync('/managed-production-policy', { recursive: true })
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockImplementation(id => id === 71 ? sender : undefined)
  h.parent.mockImplementation(value => ({ isDestroyed: () => false, webContents: value }))
  registerMagicAgentTrustedRouteBinding(71, pane().route, { trustedUrl: url, trustedWebContents: sender as never })
  await initConfig()
  await saveConfig({ use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ id: 'bounded-profile', provider: 'openai', deployment: 'local', call_type: 'local', model_use: 'agent', api_mode: 'chat-completions', base_url: 'http://127.0.0.1:1234/v1/chat/completions', api_key: 'PRIVATE_NOT_FOR_APPROVAL', model_name: 'bounded-model', request_timeout_ms: 4000 }] } })
  const documentToken = setManagedFirstRunPaneScope({ ...pane(), active: true, lifecycleRevision: 1 }, invocation('setManagedFirstRunPaneScope')).documentToken!
  source = { pane: { ...pane(), documentToken }, invocation: invocation('startManagedFirstRun') }
  vi.mocked(net.request).mockImplementation(() => {
    const request = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), abort: vi.fn() })
    requests.push(request); return request as never
  })
})
afterEach(async () => {
  sender.emit('destroyed')
  const closing = owners.splice(0).map(owner => owner.close())
  for (const request of requests.splice(0)) request.emit('close')
  await Promise.allSettled(closing)
  closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks(); vol.reset()
})
const requestFor = (action: 'birth' | 'start' | 'stop'): PolicyRequest => {
  const actor = { kind: 'user', id: 'magicpot-desktop-user' } as const
  if (action === 'stop') return createManagedFirstRunStopPolicyRequest({ actor, instanceId: 'bounded-root', runId: 'bounded-run', revision: 0, ownerEpoch: randomUUID() })
  const config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.llm_config.api_profiles = [{ id: 'bounded-profile', provider: 'openai', deployment: 'local', call_type: 'local', model_use: 'agent', api_mode: 'chat-completions', base_url: 'http://127.0.0.1:1234/v1/chat/completions', api_key: '', model_name: 'bounded-model', request_timeout_ms: 4000 }]
  const facade = MagicAgentPlatformSvcImpl.createManagedTextFirstRunService(new AssistantSessionStore('/managed-production-policy/unused-policy-fixture.json'))
  const { material } = facade.prepare({ agentId: 'bounded-root', text: 'Explicit fixture only', route: { channel: 'generic', scopeType: 'dm', scopeId: 'policy-fixture' }, profileId: 'bounded-profile', maxOutputTokens: 64 }, config)
  const instance = { id: 'bounded-root', name: 'Bounded fixture', ownerId: actor.id, definitionId: 'managed-first-run:bounded-root', configVersion: 'policy-config', depth: 0, status: 'created', limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: 4000, allowedToolNames: [], workspaceRoots: [] } }
  return {
    discriminator: 'magic-agent.policy-request.v1', version: 1, requestId: `managed-first-run:bounded-run:${action}`, actor, origin: 'internal', action: `agent.instance.managed.${action}`,
    target: { kind: 'agent-instance', id: 'bounded-root' }, input: { protocol: 'managed-first-run-policy/v2', runId: 'bounded-run', document: { senderId: 71, conversationId: 'conversation', revision: 1 }, configVersion: 'policy-config', finalInput: material, ...(action === 'birth' ? { instance } : { generation: randomUUID(), instanceRevision: 0, coverageRevision: 0, sessionKey: getAgentSessionKey(material.storage.route), acceptance: { protocol: 'assistant-final-input/v1', runId: 'bounded-run', finalInputDigest: material.digest } }) } as unknown as PolicyRequest['input'],
    runId: 'bounded-run', allowedToolNames: [], effects: [{ kind: 'agent.lifecycle', risk: 'high', target: 'bounded-root' }, ...(action === 'start' ? [{ kind: 'network.write', risk: 'high', target: material.model.endpoint }] : [])], budget: { modelRequests: 1, toolCalls: 0, maxOutputTokens: 64 }
  }
}
function joint() {
  const runtime = getAssistantTerminalPolicyRuntime()
  // Reuse the EXISTING request callback and its private coordinator. No new
  // coordinator/registry or direct grant creation; normal boot stays untouched.
  const prepare = vi.fn(async (...args: Parameters<typeof prepareManagedFirstRunEnvironment>) => {
    expect(owner.service.hasActive(args[0].instanceId)).toBe(true)
    return prepareManagedFirstRunEnvironment(...args)
  })
  const ordinary = vi.fn(async () => { throw Error('Ordinary runner must not execute') })
  const owner = new ProductionAgentInstanceLifecycle({ eventStore: runtime.eventStore, authorization: runtime.authorization, platformService: new MagicAgentPlatformSvcImpl(), runAgent: ordinary,
    managedFirstRun: { approvals: { request: (request, _graphContext, signal) => runtime.requestTerminalApproval(request, signal) }, prepare } })
  owners.push(owner)
  const pending = async () => { await vi.waitFor(() => expect(runtime.listPendingTerminalApprovals()).toHaveLength(1)); return runtime.listPendingTerminalApprovals()[0] }
  const decide = async (approved = true) => { const view = await pending(); runtime.resolvePendingTerminalApproval({ approvalId: view.approvalId, expectedRevision: view.revision, approved }); return view }
  return { runtime, owner, prepare, ordinary, pending, decide }
}

describe('disabled same-owner first-run through real production policy and original approval coordinator', () => {
  it.each(['birth', 'start', 'stop'] as const)('uses an explicit bounded production rule for %s, not the generic high-risk fallback', action => {
    const rules = production.PRODUCTION_MANAGED_FIRST_RUN_POLICY_RULES
    expect(rules).toBeInstanceOf(Array)
    const decision = evaluatePolicy(requestFor(action), rules, { evaluatedAt: Date.now(), policyVersion: 'test' })
    expect(decision).toMatchObject({ effect: 'require-approval', reasonCode: 'rule-require-approval', constraints: { allowedToolNames: [], requireNoShell: true }, approvalRequirement: { scopeKind: 'request', maxUses: 1, expiresInMs: 300000 } })
    expect(decision.matchedRuleIds).toEqual([`managed-first-run-${action}-requires-explicit-approval`])
    const actual = getAssistantTerminalPolicyRuntime().authorization.authorize({ authorizationId: randomUUID(), request: requestFor(action), evaluatedAt: Date.now(), idempotencyKey: randomUUID() })
    expect(actual).toMatchObject({ status: 'awaiting-approval', decision: { matchedRuleIds: decision.matchedRuleIds } })
  })
  it.each([
    { actor: { kind: 'agent', id: 'worker' } }, { actor: { kind: 'system', id: 'sdk' } }, { origin: 'sdk' }, { origin: 'assistant' },
    { target: { kind: 'tool', id: 'terminal.run' } }, { action: 'agent.instance.managed.restart' },
    { effects: [{ kind: 'process.execute', target: 'host', risk: 'high' }] },
    { effects: [{ kind: 'agent.lifecycle', risk: 'high' }, { kind: 'process.execute', risk: 'high' }] },
    { action: 'agent.instance.managed.birth', effects: [{ kind: 'agent.lifecycle', risk: 'high' }, { kind: 'network.write', risk: 'high' }] },
    { action: 'agent.instance.managed.stop', effects: [{ kind: 'agent.lifecycle', risk: 'high' }, { kind: 'network.write', risk: 'high' }] }
  ])('denies unsupported managed request axes rather than offering fallback approval: %j', async patch => {
    const runtime = getAssistantTerminalPolicyRuntime(), request = { ...requestFor('start'), ...patch }
    expect(runtime.authorization.authorize({ authorizationId: randomUUID(), request, evaluatedAt: Date.now(), idempotencyKey: randomUUID() })).toMatchObject({ status: 'denied' })
    await expect(runtime.requestTerminalApproval(request as PolicyRequest)).rejects.toThrow(/awaiting approval/)
    expect(runtime.listPendingTerminalApprovals()).toEqual([]); expect(net.request).not.toHaveBeenCalled()
  })
  it('binds the real pending decision, one-shot grant and permit to one exact request digest', async () => {
    const runtime = getAssistantTerminalPolicyRuntime(), request = requestFor('start')
    const decision = runtime.requestTerminalApproval(request)
    expect(runtime.listPendingTerminalApprovals()).toHaveLength(1)
    const view = runtime.listPendingTerminalApprovals()[0]
    expect(view.request.requestDigest).toBe(digestPolicyRequest(request))
    runtime.resolvePendingTerminalApproval({ approvalId: view.approvalId, expectedRevision: view.revision, approved: true })
    const grant = await decision
    const forged = { ...request, input: { ...request.input, finalInput: 'SUBSTITUTED' } }
    expect(runtime.authorization.authorize({ ...grant, authorizationId: randomUUID(), request: forged, evaluatedAt: Date.now(), idempotencyKey: randomUUID() }).status).not.toBe('authorized')
    const authorized = runtime.authorization.authorize({ ...grant, authorizationId: grant.authorizationId!, request, evaluatedAt: Date.now(), idempotencyKey: randomUUID() })
    expect(authorized.status).toBe('authorized')
    if (authorized.status !== 'authorized') throw Error('Expected authorized one-shot request')
    runtime.authorization.consumeExecutionPermit({ permit: authorized.permit, request, consumedAt: Date.now(), idempotencyKey: randomUUID() })
    expect(runtime.authorization.authorize({ authorizationId: randomUUID(), request, evaluatedAt: Date.now(), grantId: grant.grantId, expectedGrantUseCount: grant.expectedGrantUseCount, idempotencyKey: randomUUID() }).status).not.toBe('authorized')
    expect(runtime.listPendingTerminalApprovals()).toEqual([]); expect(net.request).not.toHaveBeenCalled()
  })
  it('uses actual pane/config preparation, both production approvals, one native request and original dirty terminal', async () => {
    const f = joint(), handle = f.owner.service.startManagedTextFirstRun(intent(), source)
    const first = await f.pending()
    expect(first.request.request.action).toBe('agent.instance.managed.birth')
    expect(first.request.request.input).toMatchObject({ document: { senderId: 71, conversationId: 'conversation' }, finalInput: { model: { history: 'none', modelAttempts: 1, tools: [], body: { messages: [{ role: 'user', content: 'EXPLICIT_FIRST_RUN_INPUT' }], max_tokens: 64 } } } })
    expect(JSON.stringify(first)).not.toContain('PRIVATE_NOT_FOR_APPROVAL')
    expect(f.owner.store.get(intent().instanceId)).toBeUndefined(); expect(net.request).not.toHaveBeenCalled()
    await f.decide(); const second = await f.pending()
    expect(second.request.request.action).toBe('agent.instance.managed.start'); expect(net.request).not.toHaveBeenCalled()
    await f.decide(); await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(f.owner.service.hasActive(intent().instanceId)).toBe(true)
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'application/json' } })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'approved bounded response' }, finish_reason: 'stop' }] })))
    response.emit('end')
    await expect(handle.result).resolves.toMatchObject({ status: 'completed' })
    expect(f.owner.service.hasActive(intent().instanceId)).toBe(true)
    requests[0].emit('close'); await handle.joined
    expect(f.owner.store.get(intent().instanceId)?.state.status).toBe('stopped')
    expect(f.runtime.eventStore.listResources({ kind: 'managed-agent-instance-coverage' })[0]).toMatchObject({ revision: 1, state: { status: 'dirty' } })
    expect(f.runtime.eventStore.listResources({ kind: 'managed-agent-execution-attempt' })[0]).toMatchObject({ revision: 1, state: { status: 'bounded-closed', terminal: { witness: 'producer-closure' } } })
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.ordinary).not.toHaveBeenCalled(); expect(net.fetch).not.toHaveBeenCalled()
  })
  it('never redispatches the original owner from its consumed start receipt or replays after dirty terminal', async () => {
    const f = joint(), consumption = vi.spyOn(f.runtime.authorization, 'consumeExecutionPermit')
    const handle = f.owner.service.startManagedTextFirstRun(intent(), source)
    await f.decide(); await f.decide(); await vi.waitFor(() => expect(requests).toHaveLength(1))
    const start = consumption.mock.calls.map(([input]) => input).find(input => (input.request as PolicyRequest).action === 'agent.instance.managed.start')!
    expect(start).toBeDefined()
    const replay = f.runtime.authorization.consumeExecutionPermit(start)
    expect(f.runtime.authorization.isTrustedPermit(replay)).toBe(false)
    expect(() => f.owner.service.startManagedTextFirstRun(intent(), source)).toThrow(/already active/)
    expect(f.runtime.authorization.resumeAuthorization(replay.authorizationId, start.request, Date.now()).status).not.toBe('authorized')
    expect(f.runtime.listPendingTerminalApprovals()).toEqual([])
    expect(net.request).toHaveBeenCalledOnce()
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'application/json' } })
    requests[0].emit('response', response)
    response.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'one dispatch only' }, finish_reason: 'stop' }] })))
    response.emit('end'); await handle.result
    requests[0].emit('close'); await handle.joined
    const coverage = f.runtime.eventStore.listResources({ kind: 'managed-agent-instance-coverage' })[0]
    expect(coverage.state).toMatchObject({ status: 'dirty' })
    expect(f.runtime.authorization.consumeExecutionPermit(start)).toEqual(replay)
    const attemptedReplay = f.owner.service.startManagedTextFirstRun(intent(), source)
    await attemptedReplay.joined
    await expect(attemptedReplay.result).resolves.toEqual({ status: 'cancelled' })
    expect(f.runtime.eventStore.listResources({ kind: 'managed-agent-instance-coverage' })[0]).toEqual(coverage)
    expect(f.runtime.listPendingTerminalApprovals()).toEqual([])
    expect(net.request).toHaveBeenCalledOnce(); expect(f.ordinary).not.toHaveBeenCalled()
  })
  it.each(['birth', 'start'] as const)('keeps %s denial in the existing production pending queue without dispatch', async phase => {
    const f = joint(), handle = f.owner.service.startManagedTextFirstRun(intent(), source)
    if (phase === 'start') await f.decide()
    await f.decide(false); await handle.joined
    await expect(handle.result).resolves.toEqual({ status: 'cancelled' })
    expect(f.owner.store.get(intent().instanceId)?.state.status).toBe(phase === 'start' ? 'removed' : undefined)
    expect(f.runtime.listPendingTerminalApprovals()).toEqual([]); expect(net.request).not.toHaveBeenCalled(); expect(f.ordinary).not.toHaveBeenCalled()
  })
  it('revokes the original production pending approval on config commit and never creates a runnable attempt', async () => {
    const f = joint(), handle = f.owner.service.startManagedTextFirstRun(intent(), source), view = await f.pending()
    await saveConfig({ llm_config: { api_profiles: [] } }); await handle.joined
    expect(f.runtime.listPendingTerminalApprovals()).toEqual([])
    expect(() => f.runtime.resolvePendingTerminalApproval({ approvalId: view.approvalId, expectedRevision: view.revision, approved: true })).toThrow()
    expect(f.owner.store.get(intent().instanceId)).toBeUndefined(); expect(net.request).not.toHaveBeenCalled()
  })
  it.each(['birth', 'start'] as const)('retires production pending %s approval on original conversation replacement without dispatch', async phase => {
    const f = joint(), handle = f.owner.service.startManagedTextFirstRun(intent(), source)
    if (phase === 'start') await f.decide()
    const view = await f.pending()
    setManagedFirstRunPaneScope({ ...pane(), conversationId: 'replacement-conversation', active: true, lifecycleRevision: 2 }, invocation('setManagedFirstRunPaneScope'))
    await handle.joined
    expect(f.runtime.listPendingTerminalApprovals()).toEqual([])
    expect(() => f.runtime.resolvePendingTerminalApproval({ approvalId: view.approvalId, expectedRevision: view.revision, approved: true })).toThrow()
    expect(f.owner.store.get(intent().instanceId)?.state.status).toBe(phase === 'start' ? 'removed' : undefined)
    expect(net.request).not.toHaveBeenCalled()
  })
  it('authorizes exact original-owner stop through the same production queue but keeps ownership until native close', async () => {
    const f = joint(), handle = f.owner.service.startManagedTextFirstRun(intent(), source)
    await f.decide(); await f.decide(); await vi.waitFor(() => expect(requests).toHaveLength(1))
    const request = f.owner.service.prepareManagedTextFirstRunStop({ actor: { kind: 'user', id: 'magicpot-desktop-user' }, instanceId: intent().instanceId })
    const decision = f.runtime.requestTerminalApproval(request); await f.decide()
    const grant = await decision
    const stopping = f.owner.service.stop({ instanceId: intent().instanceId, expectedRevision: request.input.revision as number, actor: request.actor, idempotencyKey: 'production-exact-stop', grantId: grant.grantId, expectedGrantUseCount: grant.expectedGrantUseCount })
    await expect(handle.result).resolves.toEqual({ status: 'cancelled' })
    expect(f.owner.service.hasActive(intent().instanceId)).toBe(true); expect(f.owner.store.get(intent().instanceId)?.state.status).toBe('running')
    requests[0].emit('close'); await stopping; await handle.joined
    expect(f.owner.store.get(intent().instanceId)?.state.status).toBe('stopped')
    expect(f.runtime.eventStore.listResources({ kind: 'managed-agent-execution-attempt' })[0].state).toMatchObject({ terminal: { status: 'cancelled', witness: 'producer-closure' } })
    expect(net.request).toHaveBeenCalledOnce(); expect(f.ordinary).not.toHaveBeenCalled()
  })
})
