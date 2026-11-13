import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vol } from 'memfs'
import { DEFAULT_CONFIG } from '../../shared/config/config'
import { getAgentSessionKey } from '../../shared/agent'
import { digestPolicyRequest, type PolicyRequest, type PolicyJsonRecord } from '../../shared/magicAgentPlatform2'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { MagicAgentPlatformSvcImpl } from '../api/svcMagicAgentPlatformImpl'
import { managedDigest } from './agents/managedRuntimeSnapshot'
import { createManagedFirstRunStopPolicyRequest } from './agents/productionAgentInstanceLifecycle'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from './productionRuntime'
import { MagicAgentPolicyAuthorizationService } from './policy'

vi.mock('electron', () => ({ net: {}, app: { getPath: () => '.' }, BrowserWindow: { fromWebContents: vi.fn() }, webContents: { fromId: vi.fn() } }))
vi.mock('node:fs', async actual => actual())
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: '/managed-contract-fixture' } }) }))
vi.mock('../magicAgentRuntime/packageResolver', () => ({ MagicAgentPackageResolver: class {} }))
vi.mock('@main/aiClients/visionClient', () => ({ createVisionChatClient: vi.fn() }))

beforeEach(() => { vol.reset(); vol.mkdirSync('/managed-contract-fixture', { recursive: true }) })
afterEach(() => { closeAssistantTerminalPolicyRuntime(); vol.reset(); vi.restoreAllMocks() })
const actor = { kind: 'user', id: 'magicpot-desktop-user' } as const
const endpoint = 'http://127.0.0.1:1234/v1/chat/completions'
function requestFor(action: 'birth' | 'start' = 'start'): PolicyRequest {
  const config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.llm_config.api_profiles = [{ id: 'contract-profile', provider: 'openai', deployment: 'local', call_type: 'local', model_use: 'agent', api_mode: 'chat-completions', base_url: endpoint, api_key: '', model_name: 'contract-model', request_timeout_ms: 4000 }]
  const facade = MagicAgentPlatformSvcImpl.createManagedTextFirstRunService(new AssistantSessionStore('/managed-contract-fixture/unused.json'))
  const prepared = facade.prepare({ agentId: 'contract-root', text: 'one explicit question', route: { channel: 'generic', scopeType: 'dm', scopeId: 'contract-route' }, profileId: 'contract-profile', maxOutputTokens: 64 }, config)
  // Data only, never a private plan, owner association or dispatch permission.
  const { digest: _digest, ...body } = prepared.material
  const base = { ...body, model: { ...body.model, transport: { protocol: 'electron-client-request-final-close/v1' } } }
  const finalInput = { ...base, digest: managedDigest('assistant-final-input/v1', base) }
  const instance = { id: 'contract-root', name: 'Bounded run', ownerId: actor.id, definitionId: 'managed-first-run:contract-root', configVersion: 'contract-config', depth: 0, status: 'created', limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: 4000, allowedToolNames: [], workspaceRoots: [] } }
  return {
    discriminator: 'magic-agent.policy-request.v1', version: 1, requestId: `managed-first-run:contract-run:${action}`,
    actor, origin: 'internal', action: `agent.instance.managed.${action}`, target: { kind: 'agent-instance', id: 'contract-root' },
    input: { protocol: 'managed-first-run-policy/v2', runId: 'contract-run', configVersion: 'contract-config', document: { senderId: 71, conversationId: 'contract-conversation', revision: 1 }, finalInput, ...(action === 'birth' ? { instance } : { generation: 'contract-generation', instanceRevision: 0, coverageRevision: 0, sessionKey: getAgentSessionKey(finalInput.storage.route), acceptance: { protocol: 'assistant-final-input/v1', runId: 'contract-run', finalInputDigest: finalInput.digest } }) } as unknown as PolicyJsonRecord,
    effects: [{ kind: 'agent.lifecycle', risk: 'high', target: 'contract-root' }, ...(action === 'start' ? [{ kind: 'network.write', risk: 'high', target: endpoint }] : [])],
    runId: 'contract-run', allowedToolNames: [], budget: { modelRequests: 1, toolCalls: 0, maxOutputTokens: 64 }
  }
}
type MutableFinalMaterial = { digest: string; model: Record<string, unknown>; storage: { route: Record<string, unknown> } }
const finalOf = (request: PolicyRequest) => request.input.finalInput as unknown as MutableFinalMaterial
function changeFinal(request: PolicyRequest, change: (material: ReturnType<typeof finalOf>) => void, rehash = false): void {
  const material = finalOf(request); change(material)
  if (rehash) { const { digest: _digest, ...body } = material; material.digest = managedDigest('assistant-final-input/v1', body) }
}
type Mutation = (request: PolicyRequest) => void
const invalid: [string, Mutation][] = [
  ['no effects', r => { r.effects = [] }],
  ['lifecycle-only start', r => { r.effects.splice(1) }],
  ['network-only start', r => { r.effects.shift() }],
  ['duplicate effect', r => { r.effects.push(r.effects[1]) }],
  ['reordered effects', r => { r.effects.reverse() }],
  ['different lifecycle target', r => { r.effects[0].target = 'other-owner' }],
  ['different endpoint effect', r => { r.effects[1].target = 'http://other.invalid/v1/chat/completions' }],
  ['lower declared risk', r => { r.effects[1].risk = 'low' }],
  ['extra effect metadata', r => { r.effects[1].metadata = { hidden: true } }],
  ['different desktop actor', r => { r.actor.id = 'different-user' }],
  ['missing budget', r => { delete r.budget }],
  ['second model attempt', r => { r.budget!.modelRequests = 2 }],
  ['tool budget', r => { r.budget!.toolCalls = 1 }],
  ['budget output mismatch', r => { r.budget!.maxOutputTokens = 128 }],
  ['extra budget', r => { r.budget!.unlimited = true }],
  ['allowed tool', r => { r.allowedToolNames = ['terminal.run'] }],
  ['legacy unversioned policy', r => { r.input.protocol = 'managed-first-run-policy/v1' }],
  ['missing final material', r => { delete r.input.finalInput }],
  ['tampered final digest', r => { finalOf(r).digest = 'f'.repeat(64) }],
  ['unknown transport with recomputed digest', r => changeFinal(r, m => { m.model.transport = { protocol: 'unknown/v1' } }, true)],
  ['missing transport with recomputed digest', r => changeFinal(r, m => { delete m.model.transport }, true)],
  ['extra final field with recomputed digest', r => changeFinal(r, m => { Object.assign(m, { helper: 'hidden.exe' }) }, true)],
  ['wrong acceptance digest', r => { (r.input.acceptance as PolicyJsonRecord).finalInputDigest = 'a'.repeat(64) }],
  ['different run identity', r => { r.input.runId = 'other-run' }],
  ['nonfresh revision', r => { r.input.instanceRevision = 1 }],
  ['different private session', r => { r.input.sessionKey = 'generic:dm:other-session' }],
  ['missing generation', r => { delete r.input.generation }],
  ['extra intent authority', r => { r.input.authority = 'yes' }]
]

describe('production managed exact request contract at original authorization boundary', () => {
  it.each(invalid)('denies %s before original coordinator creates pending approval or grant', async (_label, mutate) => {
    const runtime = getAssistantTerminalPolicyRuntime(), request = structuredClone(requestFor())
    mutate(request)
    const result = runtime.authorization.authorize({ authorizationId: randomUUID(), request, evaluatedAt: Date.now(), idempotencyKey: randomUUID() })
    expect(result.status).toBe('denied')
    await expect(runtime.requestTerminalApproval(request)).rejects.toThrow(/awaiting approval/)
    expect(runtime.listPendingTerminalApprovals()).toEqual([])
    expect(() => runtime.authorization.createApprovalGrant({ grantId: randomUUID(), request, approvedBy: actor, issuedAt: Date.now(), expiresAt: Date.now() + 1000, maxUses: 1, idempotencyKey: randomUUID() })).toThrow(/require-approval/)
  })
  it.each(['birth', 'start'] as const)('keeps valid actual prepared %s material on original approval path', async action => {
    const runtime = getAssistantTerminalPolicyRuntime(), request = requestFor(action)
    const decision = runtime.requestTerminalApproval(request)
    expect(runtime.listPendingTerminalApprovals()).toHaveLength(1)
    const pending = runtime.listPendingTerminalApprovals()[0]
    expect(pending.request.requestDigest).toBe(digestPolicyRequest(request))
    runtime.resolvePendingTerminalApproval({ approvalId: pending.approvalId, expectedRevision: pending.revision, approved: true })
    const reference = await decision
    const result = runtime.authorization.authorize({ ...reference, authorizationId: reference.authorizationId!, request, evaluatedAt: Date.now(), idempotencyKey: randomUUID() })
    expect(result.status).toBe('authorized')
    expect(runtime.listPendingTerminalApprovals()).toEqual([])
  })
  it('denies incomplete stop material instead of treating an owner DTO as authority', async () => {
    const runtime = getAssistantTerminalPolicyRuntime()
    const request = structuredClone(createManagedFirstRunStopPolicyRequest({ actor, instanceId: 'contract-root', runId: 'contract-run', revision: 1, ownerEpoch: 'fixed-owner-epoch' }))
    delete request.input.ownerEpoch
    expect(runtime.authorization.authorize({ authorizationId: randomUUID(), request, evaluatedAt: Date.now(), idempotencyKey: randomUUID() }).status).toBe('denied')
    await expect(runtime.requestTerminalApproval(request)).rejects.toThrow(/awaiting approval/)
    expect(runtime.listPendingTerminalApprovals()).toEqual([])
  })
  it('returns only diagnostic data from the SAME production-service consumed-idempotent fast path', async () => {
    const runtime = getAssistantTerminalPolicyRuntime(), request = requestFor()
    const decision = runtime.requestTerminalApproval(request)
    const pending = runtime.listPendingTerminalApprovals()[0]
    runtime.resolvePendingTerminalApproval({ approvalId: pending.approvalId, expectedRevision: pending.revision, approved: true })
    const reference = await decision, at = Date.now()
    const input = { ...reference, authorizationId: reference.authorizationId!, request, evaluatedAt: at, idempotencyKey: 'exact-fast-path-authorize' }
    const authorized = runtime.authorization.authorize(input)
    if (authorized.status !== 'authorized') throw Error('Expected exact production authorization')
    const consume = { permit: authorized.permit, request, consumedAt: at, idempotencyKey: 'exact-fast-path-consume' }
    const receipt = runtime.authorization.consumeExecutionPermit(consume)
    const evaluations = vi.spyOn(runtime.authorization as unknown as { evaluate(request: PolicyRequest, at: number): unknown }, 'evaluate')
    const replay = runtime.authorization.consumeExecutionPermit({ ...consume, consumedAt: at + 1 })
    expect(evaluations).not.toHaveBeenCalled() // Explicitly cover the pre-evaluate branch.
    expect(replay).toEqual(receipt)
    expect(runtime.authorization.isTrustedPermit(replay)).toBe(false)
    expect(() => runtime.authorization.consumeExecutionPermit({ ...consume, permit: replay as never })).toThrow(/Unbranded/)
    expect(() => runtime.authorization.consumeExecutionPermit({ ...consume, idempotencyKey: 'different-consume-key' })).toThrow(/already.*consumed/i)
    expect(runtime.authorization.authorize(input).status).not.toBe('authorized')
    expect(runtime.authorization.resumeAuthorization(authorized.permit.authorizationId, request, at + 1).status).not.toBe('authorized')
    expect(runtime.listPendingTerminalApprovals()).toEqual([])
  })
  it('does not acquire authority from an old generic-service permit branding or a consumed receipt', async () => {
    const runtime = getAssistantTerminalPolicyRuntime(), request = requestFor(), at = Date.now()
    const legacy = new MagicAgentPolicyAuthorizationService({ store: runtime.eventStore, storeId: ':memory:', policyVersion: 'old-policy', rules: [{ ruleId: 'old-approval', priority: 1, effect: 'require-approval', explanation: 'Old fixture only.' }], trustedApprovers: [actor] })
    const grant = legacy.createApprovalGrant({ grantId: randomUUID(), request, approvedBy: actor, issuedAt: at, expiresAt: at + 1000, maxUses: 1, idempotencyKey: randomUUID() }).grant
    const old = legacy.authorize({ authorizationId: randomUUID(), request, evaluatedAt: at, grantId: grant.grantId, expectedGrantUseCount: 0, idempotencyKey: randomUUID() })
    if (old.status !== 'authorized') throw Error('Old fixture did not issue branded permit')
    const consumed = legacy.consumeExecutionPermit({ permit: old.permit, request, consumedAt: at, idempotencyKey: 'old-consume' })
    expect(legacy.consumeExecutionPermit({ permit: old.permit, request, consumedAt: at, idempotencyKey: 'old-consume' })).toEqual(consumed)
    expect(runtime.authorization.isTrustedPermit(consumed)).toBe(false)
    expect(() => runtime.authorization.consumeExecutionPermit({ permit: old.permit, request, consumedAt: at, idempotencyKey: 'old-consume' })).toThrow(/Unbranded/)
    expect(() => runtime.authorization.resumeAuthorization(old.permit.authorizationId, request, at)).toThrow(/authorization audit|policy|decision/i)
    expect(runtime.listPendingTerminalApprovals()).toEqual([])
  })
})
