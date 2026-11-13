import type { ServiceInvocationContext } from '../../../shared/api/apiUtils/serviceInvocation'
import type { ManagedFirstRunPaneScope } from '../../../shared/api/agentThreadManagedFirstRun'
import type { Config } from '../../../shared/config/config'
import type { MagicAgentInstanceState } from '../../../shared/magicAgentPlatform2/agentInstance'
import { POLICY_REQUEST_DISCRIMINATOR, POLICY_REQUEST_VERSION, assertPolicyRequest, digestPolicyRequest, type PolicyActorRef, type PolicyRequest } from '../../../shared/magicAgentPlatform2'
import type { MagicAgentPlatformRunResp } from '../../../shared/api/svcMagicAgentPlatform'
import type { ManagedTextFirstRunPlatformFacade } from '../../magicAgentRuntime/managedTextFirstRunPlatform'
import { assertManagedTextFirstRunGuard, type ManagedTextFirstRunRuntimeContext } from '../../assistantRuntime/managedTextFirstRunRuntime'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import type { TerminalApprovalCoordinator } from '../terminalApprovalCoordinator'
import { PersistentManagedAgentInstanceStore } from './persistentManagedAgentInstanceStore'
import { ManagedFirstRunOwnerState } from './managedFirstRunCommitFence'
import { managedAgentCoverageId, MANAGED_AGENT_COVERAGE_KIND } from './managedAgentInstanceIdentity'
import { getAgentSessionKey } from '../../../shared/agent'
import { captureManagedData, managedOwnValues } from './managedRuntimeSnapshot'

export type ManagedFirstRunIntent = Readonly<{
  instanceId: string
  runId: string
  name: string
  text: string
  profileId: string
  maxOutputTokens: number
  route: NonNullable<Parameters<ManagedTextFirstRunPlatformFacade['prepare']>[0]['route']>
  systemPrompt?: string
  temperature?: number
}>
export type ManagedFirstRunPreparationSource = Readonly<{ pane: ManagedFirstRunPaneScope; invocation: ServiceInvocationContext }>
export type ManagedFirstRunEnvironment = Readonly<{
  config: Config
  configVersion: string
  document: Readonly<{ senderId: number; conversationId: string; revision: number; paneRoute?: ManagedFirstRunPaneScope['route'] }>
  actor: PolicyActorRef
  /** The MAIN factory combines original document/conversation and config revocation.
   * These trusted dependencies are NOT accepted in an IPC/intent or from a plan. */
  signal: AbortSignal
  facade: ManagedTextFirstRunPlatformFacade
  /** Trusted MAIN forward-dispatch check only; never a terminal/owner proof. */
  assertCurrent?(): void
  dispose(): void
}>
export type ManagedFirstRunDependencies = Readonly<{
  events: ConstructorParameters<typeof PersistentManagedAgentInstanceStore>[0]
  /** MAIN-owned request surface only, forwarding to the existing production
   * coordinator. No separate pending registry or direct grant issuer is needed. */
  approvals: Pick<TerminalApprovalCoordinator, 'request'>
  prepare(intent: ManagedFirstRunIntent, signal: AbortSignal, source?: ManagedFirstRunPreparationSource): Promise<ManagedFirstRunEnvironment>
}>
/** Caller response/cancellation DATA, not durable terminal or drain evidence. */
export type ManagedFirstRunResult = Readonly<{ status: 'completed' | 'cancelled' | 'failed'; response?: MagicAgentPlatformRunResp }>
/** joined alone observes original lifetime + terminal publication (and may reject
 * after result settled). Neither promise is a restart or idle lease. */
export type ManagedFirstRunHandle = Readonly<{ instanceId: string; runId: string; result: Promise<ManagedFirstRunResult>; joined: Promise<void> }>
const fail = (detail: string): never => { throw Error(`Invalid managed first-run intent: ${detail}.`) }
export function captureManagedFirstRunIntent(input: ManagedFirstRunIntent): ManagedFirstRunIntent {
  const intent = captureManagedData(input)
  const required = ['instanceId', 'runId', 'name', 'text', 'profileId', 'maxOutputTokens', 'route']
  if (required.some(key => !Object.hasOwn(intent, key)) || Object.keys(intent).some(key => !required.includes(key) && !['systemPrompt', 'temperature'].includes(key))) fail('fields')
  for (const key of ['instanceId', 'runId', 'profileId'] as const)
    if (typeof intent[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(intent[key])) fail(key)
  if (typeof intent.name !== 'string' || !intent.name.trim() || intent.name.length > 200 || typeof intent.text !== 'string' || !intent.text.trim() || Buffer.byteLength(intent.text, 'utf8') > 32_768 || /^\s*\/[a-z]/iu.test(intent.text)) fail('bounded plain text')
  if (!Number.isSafeInteger(intent.maxOutputTokens) || intent.maxOutputTokens < 1 || intent.maxOutputTokens > 4096) fail('output budget')
  return intent
}
function approvalDigestForManagedStore(request: PolicyRequest): string {
  // Policy hashes are domain-tagged; existing durable managed identities use the
  // exact SHA-256 hex payload. Validate before removing only that fixed prefix.
  const tagged = digestPolicyRequest(request)
  if (!/^sha256:[a-f0-9]{64}$/u.test(tagged)) throw Error('Unsupported managed policy digest protocol.')
  return tagged.slice('sha256:'.length)
}
function policy(intent: ManagedFirstRunIntent, environment: ManagedFirstRunEnvironment, action: 'birth' | 'start', material: { model: { endpoint: string } }, extra: Record<string, unknown>): PolicyRequest {
  return assertPolicyRequest({
    discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION,
    requestId: `managed-first-run:${intent.runId}:${action}`, actor: environment.actor,
    origin: 'internal', action: `agent.instance.managed.${action}`, target: { kind: 'agent-instance', id: intent.instanceId },
    input: { protocol: 'managed-first-run-policy/v2', runId: intent.runId, document: environment.document, configVersion: environment.configVersion, finalInput: material, ...extra },
    effects: [{ kind: 'agent.lifecycle', target: intent.instanceId, risk: 'high' },
      ...(action === 'start' ? [{ kind: 'network.write', target: material.model.endpoint, risk: 'high' }] : [])],
    allowedToolNames: [], runId: intent.runId, budget: { modelRequests: 1, toolCalls: 0, maxOutputTokens: intent.maxOutputTokens }
  })
}
async function approve(request: PolicyRequest, state: ManagedFirstRunOwnerState, deps: ManagedFirstRunDependencies, authorization: MagicAgentPolicyAuthorizationService, now: () => number, assertCurrent: () => void): Promise<void> {
  assertCurrent()
  const reference = await deps.approvals.request(request, undefined, state.controller.signal)
  assertCurrent()
  const result = authorization.authorize({ authorizationId: reference.authorizationId!, request, evaluatedAt: now(), grantId: reference.grantId, expectedGrantUseCount: reference.expectedGrantUseCount, idempotencyKey: `managed-first-run:${state.runId}:${request.action}:authorize` })
  assertCurrent()
  if (result.status !== 'authorized') throw Error(`Managed first-run approval ${result.status}.`)
  authorization.consumeExecutionPermit({ permit: result.permit, request, consumedAt: now(), idempotencyKey: `managed-first-run:${state.runId}:${request.action}:consume` })
  assertCurrent()
}
async function drain(state: ManagedFirstRunOwnerState): Promise<void> {
  // Never retain the owner join or runtime.closed as a root child: closed awaits
  // that same root. Preparation is joined by this orchestration task itself.
  do { await state.root.whenQuiescent(); state.assertOriginal() } while (!state.root.isQuiescent())
}
/** Disabled MAIN-only orchestration; state belongs to the existing active owner. */
export async function runManagedFirstRun(intent: ManagedFirstRunIntent, state: ManagedFirstRunOwnerState, deps: ManagedFirstRunDependencies, authorization: MagicAgentPolicyAuthorizationService, now: () => number, caller: { resolve(value: ManagedFirstRunResult): void; reject(error: unknown): void }, source?: ManagedFirstRunPreparationSource): Promise<ManagedFirstRunResult> {
  const managed = new PersistentManagedAgentInstanceStore(deps.events)
  let environment: ManagedFirstRunEnvironment | undefined, cleanup: (() => void) | undefined
  let result: ManagedFirstRunResult | undefined
  try {
    state.assertOriginal()
    if (deps.events.hasResourceEvidence('agent-instance', intent.instanceId) || deps.events.hasResourceEvidence(MANAGED_AGENT_COVERAGE_KIND, managedAgentCoverageId(intent.instanceId))) throw Error('Managed first-run requires a fresh unused root identity.')
    state.controller.signal.throwIfAborted()
    environment = await deps.prepare(intent, state.controller.signal, source)
    const values = managedOwnValues(environment)
    const signal = values.signal as AbortSignal
    const revoke = () => state.revoke(signal.reason ?? Error('Managed first-run provenance revoked.'))
    signal.addEventListener('abort', revoke, { once: true }); cleanup = () => signal.removeEventListener('abort', revoke)
    if (signal.aborted) revoke()
    state.assertOriginal(); state.controller.signal.throwIfAborted()
    // Capture data separately from exact MAIN facade/signal/disposal references.
    if (values.assertCurrent !== undefined && typeof values.assertCurrent !== 'function') throw Error('Managed environment dispatch check must be MAIN-owned.')
    environment = Object.freeze({ config: captureManagedData(environment.config), configVersion: environment.configVersion, document: captureManagedData(environment.document), actor: captureManagedData(environment.actor), facade: environment.facade, signal, ...(environment.assertCurrent ? { assertCurrent: environment.assertCurrent } : {}), dispose: environment.dispose })
    const currentEnvironment = environment
    // This is additional forward checking. Concrete transaction fences still use
    // the original owner and synchronously revoked signal, never this callback.
    const assertCurrent = () => { state.assertDispatch(); if (currentEnvironment.assertCurrent) assertManagedTextFirstRunGuard(currentEnvironment.assertCurrent); state.assertDispatch() }
    if (environment.assertCurrent) assertManagedTextFirstRunGuard(environment.assertCurrent)
    if (!environment.configVersion || !Number.isSafeInteger(environment.document.senderId) || !environment.document.conversationId || !Number.isSafeInteger(environment.document.revision)) throw Error('Managed first-run requires trusted document/config provenance.')
    const request = { agentId: intent.instanceId, text: intent.text, route: intent.route, profileId: intent.profileId, maxOutputTokens: intent.maxOutputTokens, ...(intent.systemPrompt === undefined ? {} : { systemPrompt: intent.systemPrompt }), ...(intent.temperature === undefined ? {} : { temperature: intent.temperature }) }
    const prepared = environment.facade.prepare(request, environment.config)
    state.prepare(environment, environment.facade, prepared.plan, prepared.material.digest)
    const instance: MagicAgentInstanceState = { id: intent.instanceId, name: intent.name, ownerId: environment.actor.id, definitionId: `managed-first-run:${intent.instanceId}`, configVersion: environment.configVersion, depth: 0, status: 'created', limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: prepared.material.model.requestTimeoutMs, allowedToolNames: [], workspaceRoots: [] } }
    state.phase = 'awaiting-birth-approval'
    const birthRequest = policy(intent, environment, 'birth', prepared.material, { instance })
    await approve(birthRequest, state, deps, authorization, now, assertCurrent)
    state.approveBirth(instance, approvalDigestForManagedStore(birthRequest))
    const born = managed.createRoot({ instance, createdAt: now(), idempotencyKey: `managed-birth:${intent.runId}` }, state)
    state.phase = 'awaiting-start-approval'; assertCurrent()
    const acceptance = { protocol: 'assistant-final-input/v1' as const, runId: intent.runId, finalInputDigest: prepared.material.digest }
    const startRequest = policy(intent, environment, 'start', prepared.material, { generation: born.coverage.state.generation, instanceRevision: 0, coverageRevision: 0, sessionKey: getAgentSessionKey(prepared.material.storage.route), acceptance })
    await approve(startRequest, state, deps, authorization, now, assertCurrent)
    const requestDigest = approvalDigestForManagedStore(startRequest)
    state.approveStart(requestDigest, born.coverage.state.generation, getAgentSessionKey(prepared.material.storage.route), acceptance)
    const accepted = managed.startFirstAttempt({ instanceId: intent.instanceId, expectedRevision: 0, expectedCoverageRevision: 0, authorizedRequestDigest: requestDigest, sessionKey: getAgentSessionKey(prepared.material.storage.route), startedAt: now(), idempotencyKey: `managed-start:${intent.runId}`, acceptance }, state)
    state.phase = 'accepted'
    const context: ManagedTextFirstRunRuntimeContext = Object.freeze({ controller: state.controller, cooperativeExecution: state.root, runId: intent.runId,
      assertDispatchCurrent: () => { assertCurrent(); if (!state.dispatchClaimed || !['executing', 'draining'].includes(state.phase)) throw Error('Managed first-run dispatch has not been positively claimed.') },
      assertCompletionCurrent: () => { state.assertOriginal(); if (!state.dispatchClaimed || !['executing', 'draining'].includes(state.phase)) throw Error('Managed first-run original completion provenance required.') } })
    if (state.revoked) {
      state.sealNeverDispatched(); result = { status: 'cancelled' }
    } else {
      state.claimDispatch()
      const execution = environment.facade.start(prepared.plan, context)
      const response = execution.result.then(value => {
        caller.resolve({ status: value.status === 'aborted' ? 'cancelled' : value.status === 'completed' ? 'completed' : 'failed', response: value })
        return { value }
      }, error => { caller.reject(error); return { error } })
      state.phase = 'draining'
      const closure = await execution.closed
      const positive = environment.facade.consumeClosure(closure, context)
      state.sealProducer(positive)
      const reply = await response
      result = { status: positive.outcome, ...('value' in reply ? { response: reply.value } : {}) }
    }
    await drain(state)
    state.phase = 'publishing'
    managed.publishBoundedTerminal(accepted.attempt.state.identity, now(), state)
    await drain(state)
    return result
  } catch (error) {
    if (!state.canRetirePreparation()) throw error
    // Safe only if no durable call was pending/ambiguous, or the exact internal
    // transaction positively rolled back before any COMMIT attempt.
    await drain(state)
    if (state.isPublished('birth')) { state.phase = 'retiring'; managed.retireUnusedVirgin(intent.instanceId, now(), state); await drain(state) }
    return { status: 'cancelled' }
  } finally {
    cleanup?.()
    // Release only tracked preparation resources. Disposal errors keep the owner
    // faulted instead of clearing it after a partial/unknown publication.
    environment?.dispose()
  }
}
