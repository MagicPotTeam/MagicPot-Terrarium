import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type {
  MagicAgentPlatformRunReq,
  MagicAgentPlatformRunResp
} from '../../../shared/api/svcMagicAgentPlatform'
import {
  POLICY_REQUEST_DISCRIMINATOR,
  POLICY_REQUEST_VERSION,
  canonicalPolicyJson,
  digestPolicyRequest,
  type PolicyActorRef,
  type PolicyRequest
} from '../../../shared/magicAgentPlatform2/policy'
import type { StoredResource } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService, PermitConsumedError } from '../policy'
import type { MagicAgentInstanceState } from '../../../shared/magicAgentPlatform2/agentInstance'
import {
  CooperativeExecutionController,
  CooperativePauseSupersededError,
  type CooperativePauseTicket
} from './cooperativeExecutionController'
import { captureAgentLifecycleCommand, PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import {
  AgentInstanceReplacementCommitFence,
  type AgentInstanceReplacementOwnership
} from './agentInstanceReplacementCommitFence'

import { captureManagedData } from './managedRuntimeSnapshot'
import { ManagedFirstRunOwnerState } from './managedFirstRunCommitFence'
import { captureManagedFirstRunIntent, runManagedFirstRun, type ManagedFirstRunDependencies, type ManagedFirstRunIntent, type ManagedFirstRunHandle, type ManagedFirstRunResult, type ManagedFirstRunPreparationSource } from './managedFirstRunLifecycle'

export type AgentInstanceRunAdapter = (
  request: MagicAgentPlatformRunReq,
  options: { signal: AbortSignal; cooperativeExecution: CooperativeExecutionController }
) => Promise<MagicAgentPlatformRunResp>

// Keep own undefined object fields: the existing approval digest distinguishes
// them from omission. JSON.stringify/parse would silently change that contract.
// Freeze only this detached data, never values owned by the caller. This is a
// lifecycle-entry snapshot, not schema validation or ledger execution authority.
function captureStartInput<T>(input: T): T {
  const ancestors = new Set<object>()
  const visit = (value: unknown, arrayItem = false): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (value === undefined && !arrayItem) return undefined
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || isProxy(value))
      throw new TypeError('Start input must contain plain data, not proxies or executable values.')
    if (ancestors.has(value)) throw new TypeError('Cyclic start input data is not allowed.')
    const prototype = Object.getPrototypeOf(value)
    const array = Array.isArray(value)
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new TypeError('Start input must contain plain objects and arrays.')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'))
      throw new TypeError('Symbol start input fields are not allowed.')
    ancestors.add(value)
    try {
      if (array) {
        const length = descriptors.length.value as number
        if (Object.keys(descriptors).length !== length + 1)
          throw new TypeError('Start input arrays must be dense with no extra fields.')
        const result: unknown[] = []
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)]
          if (!descriptor?.enumerable || !('value' in descriptor))
            throw new TypeError('Start input array fields must be enumerable data.')
          result.push(visit(descriptor.value, true))
        }
        return Object.freeze(result)
      }
      const result: Record<string, unknown> = Object.create(prototype)
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (
          ['__proto__', 'prototype', 'constructor'].includes(key) ||
          !descriptor.enumerable ||
          !('value' in descriptor)
        )
          throw new TypeError('Start input fields must be enumerable plain data, not getters.')
        result[key] = visit(descriptor.value)
      }
      return Object.freeze(result)
    } finally {
      ancestors.delete(value)
    }
  }
  if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input))
    throw new TypeError('Start command must be a plain data object.')
  return visit(input) as T
}

const stableRequest = (input: Omit<PolicyRequest, 'requestId'>): PolicyRequest => {
  const seed = { ...input, requestId: 'agent-instance-request:seed' }
  return { ...input, requestId: `agent-instance-request:${digestPolicyRequest(seed)}` }
}

export const createAgentInstanceLifecyclePolicyRequest = (input: {
  actor: PolicyActorRef
  action: 'create' | 'start' | 'pause' | 'resume' | 'stop' | 'replace' | 'remove'
  instance: StoredResource<MagicAgentInstanceState>
  requestDigest?: string
}): PolicyRequest =>
  stableRequest({
    discriminator: POLICY_REQUEST_DISCRIMINATOR,
    version: POLICY_REQUEST_VERSION,
    actor: input.actor,
    origin: 'internal',
    action: `agent-instance.${input.action}`,
    target: { kind: 'agent-instance', id: input.instance.id, source: 'dynamic-agent-fabric' },
    input: {
      instanceId: input.instance.id,
      definitionId: input.instance.state.definitionId,
      configVersion: input.instance.state.configVersion,
      revision: input.instance.revision,
      ...(input.requestDigest ? { requestDigest: input.requestDigest } : {})
    },
    effects: [
      {
        kind: 'agent.lifecycle',
        risk: 'high',
        target: `agent.lifecycle.${input.action}`,
        metadata: { action: input.action, instanceId: input.instance.id }
      }
    ],
    allowedToolNames: [...input.instance.state.limits.allowedToolNames],
    filesystem: { allowedRoots: [...input.instance.state.limits.workspaceRoots] },
    budget: { maxTimeoutMs: input.instance.state.limits.maxRuntimeMs }
  })

export const createManagedFirstRunStopPolicyRequest = (input: { actor: PolicyActorRef; instanceId: string; runId: string; revision: number; ownerEpoch: string }): PolicyRequest =>
  stableRequest({
    discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION,
    origin: 'internal', actor: input.actor, action: 'agent.instance.managed.stop',
    target: { kind: 'agent-instance', id: input.instanceId },
    input: { instanceId: input.instanceId, runId: input.runId, revision: input.revision, ownerEpoch: input.ownerEpoch },
    effects: [{ kind: 'agent.lifecycle', risk: 'high', target: input.instanceId, metadata: { action: 'stop', runId: input.runId } }],
    allowedToolNames: [], runId: input.runId
  })

export const createAgentConfigPolicyRequest = (input: {
  actor: PolicyActorRef
  action: 'create-config' | 'stage-config' | 'activate-config' | 'rollback-config'
  instance: StoredResource<MagicAgentInstanceState>
  configVersion?: string
  privilegeChange?: 'reduction' | 'equivalent' | 'expansion'
}): PolicyRequest =>
  stableRequest({
    discriminator: POLICY_REQUEST_DISCRIMINATOR,
    version: POLICY_REQUEST_VERSION,
    actor: input.actor,
    origin: 'internal',
    action: `agent-instance.${input.action}`,
    target: { kind: 'agent-instance', id: input.instance.id, source: 'dynamic-agent-fabric' },
    input: {
      instanceId: input.instance.id,
      revision: input.instance.revision,
      activeConfigVersion: input.instance.state.configVersion,
      ...(input.configVersion ? { configVersion: input.configVersion } : {}),
      ...(input.privilegeChange ? { privilegeChange: input.privilegeChange } : {})
    },
    effects: [
      {
        kind: input.privilegeChange === 'expansion' ? 'agent.lifecycle' : 'agent.config',
        risk: input.privilegeChange === 'expansion' ? 'high' : 'low',
        target: `agent.lifecycle.${input.action}`,
        metadata: { action: input.action, instanceId: input.instance.id }
      }
    ],
    allowedToolNames: [...input.instance.state.limits.allowedToolNames],
    filesystem: { allowedRoots: [...input.instance.state.limits.workspaceRoots] },
    budget: { maxTimeoutMs: input.instance.state.limits.maxRuntimeMs }
  })

type AgentExecutionOwner = {
  readonly controller: AbortController
  readonly cooperativeExecution: CooperativeExecutionController
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  phase: 'starting' | 'running' | 'finishing' | 'faulted'
  stopRequested: boolean
  publicationCompleted: boolean
  fault?: unknown
  managed?: ManagedFirstRunOwnerState
}

type ReplacementPreparation = Readonly<{
  instanceId: string
  revision: number
  owner: AgentExecutionOwner | undefined
  ticket: CooperativePauseTicket | undefined
}>

export type AgentInstanceRecoveryDiagnostic = Readonly<{
  code: 'managed-instance-quarantined'
  instanceId: string
}>

export class ProductionAgentInstanceLifecycleService {
  private readonly active = new Map<string, AgentExecutionOwner>()
  private recoveryDiagnostics: readonly AgentInstanceRecoveryDiagnostic[] = Object.freeze([])
  // Exact returned-object identity carries only private pause proof, never policy
  // authority. A resource revision or a copied DTO cannot manufacture that proof.
  private readonly replacementPreparations = new WeakMap<
    StoredResource<MagicAgentInstanceState>, ReplacementPreparation
  >()
  // Retained after settlement too: a closed/faulted service cannot start new work.
  private closing?: Promise<void>
  private readonly replacementOwnership: AgentInstanceReplacementOwnership = {
    active: this.active, closing: undefined
  }

  constructor(
    readonly store: PersistentAgentInstanceStore,
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    private readonly runAgent: AgentInstanceRunAdapter,
    private readonly now: () => number = Date.now,
    private readonly configStore?: import('./persistentAgentConfigStore').PersistentAgentConfigStore,
    private readonly managedFirstRun?: ManagedFirstRunDependencies
  ) {}

  /** Permanent closing observation only; never DB readiness, an idle lease or read authorization. */
  isClosing(): boolean { return this.closing !== undefined }

  /** Observation only; never an idle lease or admission/owner capability. */
  hasActive(instanceId: string): boolean { return this.active.has(instanceId) }

  /** MAIN-only and absent in normal boot. No renderer flag, receipt or facade
   * passed as input can establish the original lifecycle owner. */
  startManagedTextFirstRun(input: ManagedFirstRunIntent, inputSource?: ManagedFirstRunPreparationSource): ManagedFirstRunHandle {
    const deps = this.managedFirstRun
    if (!deps) throw new Error('Managed first-run is disabled.')
    const intent = captureManagedFirstRunIntent(input)
    const source = inputSource === undefined ? undefined : captureManagedData(inputSource)
    if (this.closing) throw new Error('Agent instance lifecycle is closing or closed.')
    if (this.active.has(intent.instanceId)) throw new Error('Agent instance is already active.')
    // Count the same owners, including faulted/draining ones. No timer or caller
    // cancellation restores preparation capacity before its real join.
    if ([...this.active.values()].filter(owner => owner.managed).length >= 32) throw new Error('Managed first-run owner capacity reached.')
    let resolve!: () => void, reject!: (error: unknown) => void
    const joined = new Promise<void>((done, failed) => { resolve = done; reject = failed })
    let resultResolve!: (result: ManagedFirstRunResult) => void, resultReject!: (error: unknown) => void
    const result = new Promise<ManagedFirstRunResult>((done, failed) => { resultResolve = done; resultReject = failed })
    void joined.catch(() => undefined); void result.catch(() => undefined)
    const controller = new AbortController(), root = new CooperativeExecutionController()
    const owner: AgentExecutionOwner = { controller, cooperativeExecution: root, promise: joined, resolve, reject, phase: 'starting', stopRequested: false, publicationCompleted: false }
    const state = new ManagedFirstRunOwnerState(deps.events, this.replacementOwnership, intent.instanceId, intent.runId, owner, controller, root)
    owner.managed = state
    // Reserve full join/state before any factory, config, store, approval or clock.
    this.active.set(intent.instanceId, owner)
    // Responsive caller cancellation is DATA only. The original owner/join and
    // durable terminal path are deliberately independent of this settled result.
    const cancelled = () => resultResolve(Object.freeze({ status: 'cancelled' }))
    controller.signal.addEventListener('abort', cancelled, { once: true })
    const detachCaller = () => controller.signal.removeEventListener('abort', cancelled)
    void runManagedFirstRun(intent, state, deps, this.authorization, this.now, {
      resolve: resultResolve,
      reject: error => {
        if (controller.signal.aborted || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) cancelled()
        else resultReject(error)
      }
    }, source).then(
      async value => {
        detachCaller()
        try {
          do { await root.whenQuiescent(); state.assertOriginal() } while (!root.isQuiescent())
          state.phase = 'retired'; owner.publicationCompleted = true
          this.active.delete(intent.instanceId); resultResolve(value); resolve()
        } catch (error) { state.phase = 'faulted'; resultReject(error); this.faultOwner(owner, error) }
      },
      error => { detachCaller(); state.phase = 'faulted'; resultReject(error); this.faultOwner(owner, error) }
    )
    return Object.freeze({ instanceId: intent.instanceId, runId: intent.runId, result, joined })
  }

  /** MAIN-only approval material for this exact active owner. The returned
   * request/epoch is DATA, never an execution or cancellation capability. */
  prepareManagedTextFirstRunStop(input: { actor: PolicyActorRef; instanceId: string }): PolicyRequest {
    const captured = captureStartInput(input), owner = this.active.get(captured.instanceId), state = owner?.managed
    if (!state) throw new Error('No active managed first-run owner.')
    const revision = this.store.get(captured.instanceId)?.revision ?? 0
    if (this.active.get(captured.instanceId) !== owner || owner?.managed !== state) throw new Error('Managed Agent stop owner changed.')
    return createManagedFirstRunStopPolicyRequest({ actor: captured.actor, instanceId: captured.instanceId, runId: state.runId, revision, ownerEpoch: state.policyEpoch })
  }

  /** Trusted cancellation is not an execution grant. A future pane boundary must
   * separately authorize stop before calling it. Inactive IDs never get an owner. */
  cancelManagedTextFirstRun(instanceId: string): Promise<void> {
    const owner = this.active.get(instanceId)
    if (!owner?.managed) throw new Error('No active managed first-run owner.')
    owner.stopRequested = true; owner.managed.revoke(new Error('Managed first-run cancelled.'))
    return this.joinOwnerAfterAbort(owner)
  }

  authorizeLifecycleMutation(input: {
    actor: PolicyActorRef
    action: 'create' | 'replace' | 'remove'
    instance: StoredResource<MagicAgentInstanceState>
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): boolean {
    this.store.assertOrdinaryIdentity(input.instance.id)
    const request = createAgentInstanceLifecyclePolicyRequest({
      actor: input.actor,
      action: input.action,
      instance: input.instance
    })
    const authorization = this.authorization.authorize({
      authorizationId: `agent-instance-authorization:${digestPolicyRequest(request)}`,
      request,
      evaluatedAt: this.now(),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount !== undefined
        ? { expectedGrantUseCount: input.expectedGrantUseCount }
        : {}),
      idempotencyKey: `agent-instance:${input.action}:authorize:${input.idempotencyKey}`
    })
    if (authorization.status !== 'authorized')
      throw new Error(`Agent instance ${input.action} ${authorization.status}.`)
    this.authorization.consumeExecutionPermit({
      permit: authorization.permit,
      request,
      consumedAt: this.now(),
      idempotencyKey: `agent-instance:${input.action}:consume:${input.idempotencyKey}`
    })
    return true
  }

  createAgentConfigVersionPolicyRequest(input: {
    actor: PolicyActorRef
    instance: StoredResource<MagicAgentInstanceState>
    configVersion: string
  }) {
    this.store.assertOrdinaryIdentity(input.instance.id)
    return createAgentConfigPolicyRequest({
      actor: input.actor,
      action: 'create-config',
      instance: input.instance,
      configVersion: input.configVersion
    })
  }

  authorizeConfigMutation(input: {
    actor: PolicyActorRef
    action: 'create-config' | 'stage-config' | 'activate-config' | 'rollback-config'
    instanceId: string
    configVersion?: string
    privilegeChange?: 'reduction' | 'equivalent' | 'expansion'
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): boolean {
    this.store.assertOrdinaryIdentity(input.instanceId)
    const instance = this.store.get(input.instanceId)
    if (!instance) throw new Error('Agent instance not found.')
    const request = createAgentConfigPolicyRequest({
      actor: input.actor,
      action: input.action,
      instance,
      ...(input.configVersion ? { configVersion: input.configVersion } : {}),
      ...(input.privilegeChange ? { privilegeChange: input.privilegeChange } : {})
    })
    const authorization = this.authorization.authorize({
      authorizationId: `agent-config-authorization:${request.requestId}`,
      request,
      evaluatedAt: this.now(),
      idempotencyKey: `agent-config:${input.action}:authorize:${input.idempotencyKey}`,
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount === undefined
        ? {}
        : { expectedGrantUseCount: input.expectedGrantUseCount })
    })
    if (authorization.status === 'already-consumed') return false
    if (authorization.status !== 'authorized')
      throw new Error(`Agent config ${input.action} ${authorization.status}.`)
    this.authorization.consumeExecutionPermit({
      permit: authorization.permit,
      request,
      consumedAt: this.now(),
      idempotencyKey: `agent-config:${input.action}:consume:${input.idempotencyKey}`
    })
    return true
  }

  async requestCooperativePause(instanceId: string): Promise<CooperativePauseTicket> {
    this.store.assertOrdinaryIdentity(instanceId)
    const execution = this.active.get(instanceId)
    if (!execution || execution.phase !== 'running') throw new CooperativePauseSupersededError()
    const ticket = await execution.cooperativeExecution.requestPause()
    if (this.active.get(instanceId) !== execution) throw new CooperativePauseSupersededError()
    this.assertCurrentPause(instanceId, ticket)
    return ticket
  }

  private assertCurrentPause(instanceId: string, ticket: CooperativePauseTicket): void {
    const execution = this.active.get(instanceId)
    if (!execution || execution.phase !== 'running' || execution.controller.signal.aborted || !execution.cooperativeExecution.isPauseCurrent(ticket))
      throw new CooperativePauseSupersededError()
  }

  resumeCooperativeExecution(instanceId: string): void {
    this.store.assertOrdinaryIdentity(instanceId)
    const execution = this.active.get(instanceId)
    if (!execution) throw new Error('Agent instance is not active.')
    if (execution.phase !== 'running' || execution.controller.signal.aborted)
      throw new CooperativePauseSupersededError()
    execution.cooperativeExecution.resume()
  }

  isAtSafePoint(instanceId: string): boolean {
    if (this.store.hasManagedIdentity(instanceId)) return false
    const execution = this.active.get(instanceId)
    return (
      !this.closing &&
      (!execution ||
        (execution.phase === 'running' && !execution.controller.signal.aborted &&
          execution.cooperativeExecution.isPaused() && execution.cooperativeExecution.isQuiescent()))
    )
  }

  activateStagedConfigAtSafePoint(input: {
    instanceId: string
    expectedRevision: number
    activatedAt: number
    idempotencyKey: string
  }) {
    if (!this.isAtSafePoint(input.instanceId))
      throw new Error('Agent instance is not at a config activation safe point.')
    return this.store.activateStagedConfig({
      id: input.instanceId,
      expectedRevision: input.expectedRevision,
      activatedAt: input.activatedAt,
      idempotencyKey: input.idempotencyKey
    })
  }

  rollbackConfigAtSafePoint(input: {
    instanceId: string
    expectedRevision: number
    rolledBackAt: number
    idempotencyKey: string
  }) {
    if (!this.isAtSafePoint(input.instanceId))
      throw new Error('Agent instance is not at a config rollback safe point.')
    return this.store.rollbackConfig({
      id: input.instanceId,
      expectedRevision: input.expectedRevision,
      rolledBackAt: input.rolledBackAt,
      idempotencyKey: input.idempotencyKey
    })
  }

  async start(input: {
    instanceId: string
    expectedRevision: number
    actor: PolicyActorRef
    request: MagicAgentPlatformRunReq
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): Promise<void> {
    // Capture before even the first store/clock/policy callout can mutate nested
    // request or actor data. Effective-request resolution/approval is unchanged.
    input = captureStartInput(input)
    this.store.assertOrdinaryIdentity(input.instanceId)
    if (this.closing) throw new Error('Agent instance lifecycle is closing or closed.')
    if (this.active.has(input.instanceId)) throw new Error('Agent instance is already active.')
    const instance = this.require(input.instanceId, input.expectedRevision)
    const config = this.configStore?.get(instance.state.configVersion)?.state
    if (config && config.definitionId !== instance.state.definitionId)
      throw new Error('Active Agent config definition mismatch.')
    if (config && config.memory.scope !== 'session')
      throw new Error(
        `Agent config memory scope ${config.memory.scope} is not supported by the production runtime.`
      )
    if (
      config &&
      input.request.route.channel === 'runtime-channel' &&
      !config.channels.channelIds.includes(input.request.route.scopeId)
    )
      throw new Error('Runtime Channel is not allowed by the active Agent config.')
    const configToolNames = config?.tools.allowedToolNames ?? instance.state.limits.allowedToolNames
    const requestedTools = input.request.allowedToolNames ?? configToolNames
    const effectiveRequest: MagicAgentPlatformRunReq = {
      ...input.request,
      agentId: instance.state.definitionId,
      ...(config
        ? {
            profileId: config.model.profileId,
            systemPrompt: config.systemPrompt,
            ...(config.inference.maxTokens === undefined
              ? {}
              : { maxOutputTokens: config.inference.maxTokens }),
            ...(config.budgets.maxTokens === undefined && config.inference.maxTokens === undefined
              ? {}
              : {
                  maxOutputTokens: Math.min(
                    config.inference.maxTokens ?? Number.MAX_SAFE_INTEGER,
                    config.budgets.maxTokens ?? Number.MAX_SAFE_INTEGER
                  )
                }),
            ...(config.inference.temperature === undefined
              ? {}
              : { temperature: config.inference.temperature }),
            memory: { ...config.memory, scope: 'session' as const }
          }
        : {}),
      ...(config?.inference.maxToolIterations !== undefined ||
      config?.budgets.maxToolCalls !== undefined ||
      input.request.maxToolIterations !== undefined
        ? {
            maxToolIterations: Math.min(
              input.request.maxToolIterations ?? Number.MAX_SAFE_INTEGER,
              config?.inference.maxToolIterations ?? Number.MAX_SAFE_INTEGER,
              config?.budgets.maxToolCalls ?? Number.MAX_SAFE_INTEGER
            )
          }
        : {}),
      timeoutMs: Math.min(
        input.request.timeoutMs ??
          config?.budgets.maxRuntimeMs ??
          instance.state.limits.maxRuntimeMs,
        config?.budgets.maxRuntimeMs ?? Number.MAX_SAFE_INTEGER,
        instance.state.limits.maxRuntimeMs
      ),
      allowedToolNames: requestedTools.filter(
        (name) =>
          configToolNames.includes(name) && instance.state.limits.allowedToolNames.includes(name)
      )
    }
    const requestDigest = createHash('sha256')
      .update(canonicalPolicyJson((config ? effectiveRequest : input.request) as never))
      .digest('hex')
    const policyRequest = createAgentInstanceLifecyclePolicyRequest({
      actor: input.actor,
      action: 'start',
      instance,
      requestDigest
    })
    const authorizationId = `agent-instance-authorization:${digestPolicyRequest(policyRequest)}`
    const authorized = this.authorization.authorize({
      authorizationId,
      request: policyRequest,
      evaluatedAt: this.now(),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount !== undefined
        ? { expectedGrantUseCount: input.expectedGrantUseCount }
        : {}),
      idempotencyKey: `agent-instance:start:authorize:${input.idempotencyKey}`
    })
    if (authorized.status !== 'authorized')
      throw new Error(`Agent instance start ${authorized.status}.`)
    try {
      this.authorization.consumeExecutionPermit({
        permit: authorized.permit,
        request: policyRequest,
        consumedAt: this.now(),
        idempotencyKey: `agent-instance:start:consume:${input.idempotencyKey}`
      })
    } catch (error) {
      if (error instanceof PermitConsumedError) return Promise.resolve()
      throw error
    }
    // Authorization/clock adapters may call back synchronously. Revalidate before
    // reserving this exact execution, then publish its fully initialized join
    // before the durable start or runtime dispatch can re-enter the lifecycle.
    if (this.closing) throw new Error('Agent instance lifecycle is closing or closed.')
    if (this.active.has(input.instanceId)) throw new Error('Agent instance is already active.')
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed })
    // A fault must stay observable to stop/close even when no caller is joining
    // yet. This observer neither replaces nor resolves the original join.
    void promise.catch(() => undefined)
    const owner: AgentExecutionOwner = {
      controller: new AbortController(), cooperativeExecution: new CooperativeExecutionController(),
      promise, resolve, reject, phase: 'starting', stopRequested: false, publicationCompleted: false
    }
    this.active.set(input.instanceId, owner)
    try {
      this.store.start({
        instanceId: input.instanceId,
        expectedRevision: input.expectedRevision,
        transitionedAt: this.now(),
        idempotencyKey: `runtime-start:${input.idempotencyKey}`
      })
    } catch (error) {
      // Append may have committed before throwing. Never guess, retry, dispatch,
      // or free capacity on this ambiguous accepted-start publication failure.
      this.faultOwner(owner, error)
      throw error
    }
    owner.phase = 'running'
    let result: Promise<MagicAgentPlatformRunResp>
    try {
      owner.controller.signal.throwIfAborted()
      result = this.runAgent(effectiveRequest, {
        signal: owner.controller.signal,
        cooperativeExecution: owner.cooperativeExecution
      })
    } catch (error) {
      this.finishOwner(input.instanceId, owner, 'failed')
      throw error
    }
    // Rejection of execution and failure of terminal publication are different.
    // Do not catch a publication error and turn it into a second failed-run write.
    void result.then(
      () => this.finishOwner(input.instanceId, owner, 'completed'),
      () => this.finishOwner(input.instanceId, owner, 'failed')
    )
  }

  async quiesceForReplacement(
    instanceId: string,
    expectedRevision?: number
  ): Promise<StoredResource<MagicAgentInstanceState>> {
    this.store.assertOrdinaryIdentity(instanceId)
    const owner = this.active.get(instanceId)
    const current = this.store.get(instanceId)
    if (!current) throw new Error('Agent instance not found.')
    if (expectedRevision !== undefined && current.revision !== expectedRevision)
      throw new Error('Agent instance revision conflict.')
    if (this.closing || this.active.get(instanceId) !== owner)
      throw new CooperativePauseSupersededError()
    if (current.state.status === 'removed')
      throw new Error('Agent instance is not at a replacement safe point.')

    let ticket: CooperativePauseTicket | undefined
    let prepared = current
    if (owner || current.state.status === 'running') {
      // Preserve an already-safe stopped resource with its still-live paused
      // owner, but do not turn arbitrary stopped/active work into a safe point.
      if (current.state.status !== 'running' && current.state.status !== 'paused' && !this.isAtSafePoint(instanceId))
        throw new Error('Agent instance is not at a replacement safe point.')
      ticket = await this.requestCooperativePause(instanceId)
      const drained = this.store.get(instanceId)!
      this.assertReplacementPreparationCurrent({ instanceId, revision: current.revision, owner, ticket })
      // The command's authorized revision cannot silently absorb unrelated
      // changes while awaiting drainage. Only this operation's pause advances it.
      if (expectedRevision !== undefined && drained.revision !== expectedRevision)
        throw new Error('Agent instance revision conflict.')
      if (drained.state.status === 'running') {
        const transitionedAt = this.now()
        this.assertReplacementPreparationCurrent({ instanceId, revision: drained.revision, owner, ticket })
        prepared = this.store.pause({
          instanceId,
          expectedRevision: drained.revision,
          transitionedAt,
          idempotencyKey: `replacement-quiesce:${instanceId}:${drained.revision}`
        })
      } else if (drained.state.status === 'paused' || drained.state.status === 'stopped') {
        prepared = drained
      } else throw new CooperativePauseSupersededError()
    }
    const proof = { instanceId, revision: prepared.revision, owner, ticket }
    this.assertReplacementPreparationCurrent(proof)
    // Always return a distinct object: independent preparations in the same
    // epoch must not overwrite one another, even with a caching store fixture.
    const result = Object.freeze({ ...prepared })
    this.replacementPreparations.set(result, proof)
    return result
  }

  commitReplacement(
    prepared: StoredResource<MagicAgentInstanceState>,
    input: Omit<Parameters<PersistentAgentInstanceStore['replace']>[0], 'expectedRevision'>
  ): StoredResource<MagicAgentInstanceState> {
    const proof = this.replacementPreparations.get(prepared)
    if (!proof) throw new CooperativePauseSupersededError()
    // One attempt only, including validation/publication failure. Do not retain
    // reusable authority that could be retried after a bare resume/repause.
    this.replacementPreparations.delete(prepared)
    const command = {
      instanceId: input.instanceId, definitionId: input.definitionId, name: input.name,
      configVersion: input.configVersion, replacedAt: input.replacedAt,
      idempotencyKey: input.idempotencyKey, expectedRevision: proof.revision
    }
    for (const key of ['instanceId', 'definitionId', 'name', 'configVersion', 'idempotencyKey'] as const)
      if (typeof command[key] !== 'string' || !command[key].trim() || command[key] !== command[key].trim())
        throw new Error(`Invalid replacement ${key}.`)
    if (!Number.isFinite(command.replacedAt) || command.replacedAt < 0)
      throw new Error('Invalid replacement timestamp.')
    if (command.instanceId !== proof.instanceId) throw new CooperativePauseSupersededError()
    this.store.assertOrdinaryIdentity(command.instanceId)
    const current = this.require(proof.instanceId, proof.revision)
    this.assertReplacementPreparationCurrent(proof)
    if (current.state.status === 'running' || current.state.status === 'removed')
      throw new Error('Agent instance is not at a replacement safe point.')
    // A concrete, non-callback predicate follows the exact proof through inner
    // store reads and the transaction's last supported callout before COMMIT.
    const fence = new AgentInstanceReplacementCommitFence({
      ...proof, ownership: this.replacementOwnership,
      idempotencyKey: `agent-instance:${command.instanceId}:replace:${command.idempotencyKey}`
    })
    return this.store.replace(command, fence)
  }

  private assertReplacementPreparationCurrent(proof: ReplacementPreparation): void {
    if (this.closing || this.active.get(proof.instanceId) !== proof.owner)
      throw new CooperativePauseSupersededError()
    if (proof.owner && (proof.owner.phase !== 'running' || proof.owner.controller.signal.aborted ||
      !proof.ticket || !proof.owner.cooperativeExecution.isPauseCurrent(proof.ticket)))
      throw new CooperativePauseSupersededError()
  }

  async pause(input: {
    instanceId: string
    expectedRevision: number
    actor: PolicyActorRef
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): Promise<StoredResource<MagicAgentInstanceState>> {
    const command = captureAgentLifecycleCommand('pause', input)
    input = command
    this.store.assertOrdinaryIdentity(command.instanceId)
    const noopReplay = this.store.getLifecycleNoopReplay(command)
    if (noopReplay) return noopReplay
    const replay = this.store.getTransitionReplay(
      input.instanceId,
      'paused',
      `runtime-pause:${input.idempotencyKey}`
    )
    if (replay) return replay
    const instance = this.require(input.instanceId, input.expectedRevision)
    const policyRequest = createAgentInstanceLifecyclePolicyRequest({
      actor: input.actor,
      action: 'pause',
      instance
    })
    const authorized = this.authorization.authorize({
      authorizationId: `agent-instance-pause-authorization:${createHash('sha256').update(canonicalPolicyJson([digestPolicyRequest(policyRequest), input.idempotencyKey])).digest('hex')}`,
      request: policyRequest,
      evaluatedAt: this.now(),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount !== undefined
        ? { expectedGrantUseCount: input.expectedGrantUseCount }
        : {}),
      idempotencyKey: `agent-instance:pause:authorize:${input.idempotencyKey}`
    })
    if (authorized.status !== 'authorized')
      throw new Error(`Agent instance pause ${authorized.status}.`)
    this.authorization.consumeExecutionPermit({
      permit: authorized.permit,
      request: policyRequest,
      consumedAt: this.now(),
      idempotencyKey: `agent-instance:pause:consume:${input.idempotencyKey}`
    })
    const ticket = await this.requestCooperativePause(input.instanceId)
    const current = this.store.get(input.instanceId)!
    this.assertCurrentPause(input.instanceId, ticket)
    if (current.state.status === 'paused')
      return this.store.recordLifecycleNoopCompletion({ command, result: current, completedAt: this.now() })
    if (current.state.status !== 'running') throw new CooperativePauseSupersededError()
    return this.store.pause({
      instanceId: current.id,
      expectedRevision: current.revision,
      transitionedAt: this.now(),
      idempotencyKey: `runtime-pause:${input.idempotencyKey}`
    })
  }

  resume(input: {
    instanceId: string
    expectedRevision: number
    actor: PolicyActorRef
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): StoredResource<MagicAgentInstanceState> {
    const command = captureAgentLifecycleCommand('resume', input)
    input = command
    this.store.assertOrdinaryIdentity(command.instanceId)
    const noopReplay = this.store.getLifecycleNoopReplay(command)
    if (noopReplay) return noopReplay
    const replay = this.store.getTransitionReplay(
      input.instanceId,
      'running',
      `runtime-resume:${input.idempotencyKey}`
    )
    if (replay) return replay
    const instance = this.require(input.instanceId, input.expectedRevision)
    const policyRequest = createAgentInstanceLifecyclePolicyRequest({
      actor: input.actor,
      action: 'resume',
      instance
    })
    const authorized = this.authorization.authorize({
      authorizationId: `agent-instance-resume-authorization:${createHash('sha256').update(canonicalPolicyJson([digestPolicyRequest(policyRequest), input.idempotencyKey])).digest('hex')}`,
      request: policyRequest,
      evaluatedAt: this.now(),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount !== undefined
        ? { expectedGrantUseCount: input.expectedGrantUseCount }
        : {}),
      idempotencyKey: `agent-instance:resume:authorize:${input.idempotencyKey}`
    })
    if (authorized.status !== 'authorized')
      throw new Error(`Agent instance resume ${authorized.status}.`)
    this.authorization.consumeExecutionPermit({
      permit: authorized.permit,
      request: policyRequest,
      consumedAt: this.now(),
      idempotencyKey: `agent-instance:resume:consume:${input.idempotencyKey}`
    })
    if (this.store.get(input.instanceId)?.state.status === 'running') {
      // A durable pause may still be waiting for its acknowledgement. An explicit
      // authorized resume withdraws that request even before the store says paused.
      const execution = this.active.get(input.instanceId)
      if (execution) this.resumeCooperativeExecution(input.instanceId)
      return this.store.recordLifecycleNoopCompletion({ command, result: this.store.get(input.instanceId)!, completedAt: this.now() })
    }
    this.resumeCooperativeExecution(input.instanceId)
    return this.store.resume({
      instanceId: instance.id,
      expectedRevision: instance.revision,
      transitionedAt: this.now(),
      idempotencyKey: `runtime-resume:${input.idempotencyKey}`
    })
  }

  async stop(input: {
    instanceId: string
    expectedRevision: number
    actor: PolicyActorRef
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): Promise<void> {
    input = captureStartInput(input)
    const managedOwner = this.active.get(input.instanceId)
    if (managedOwner?.managed) {
      const state = managedOwner.managed
      const current = this.store.get(input.instanceId)
      const revision = current?.revision ?? 0
      if (revision !== input.expectedRevision) throw new Error('Agent instance revision conflict.')
      const request = createManagedFirstRunStopPolicyRequest({ actor: input.actor, instanceId: input.instanceId, runId: state.runId, revision, ownerEpoch: state.policyEpoch })
      const authorized = this.authorization.authorize({
        authorizationId: `agent-instance-authorization:${digestPolicyRequest(request)}`, request,
        evaluatedAt: this.now(), grantId: input.grantId, expectedGrantUseCount: input.expectedGrantUseCount,
        idempotencyKey: `agent-instance:managed-stop:authorize:${input.idempotencyKey}`
      })
      if (authorized.status !== 'authorized') throw new Error(`Managed Agent instance stop ${authorized.status}.`)
      this.authorization.consumeExecutionPermit({ permit: authorized.permit, request, consumedAt: this.now(), idempotencyKey: `agent-instance:managed-stop:consume:${input.idempotencyKey}` })
      // Never select by ID again after joining. A synchronous authorization/clock
      // callout must not transfer cancellation to a different execution owner.
      if (this.active.get(input.instanceId) !== managedOwner || managedOwner.managed !== state || (this.store.get(input.instanceId)?.revision ?? 0) !== revision)
        throw new Error('Managed Agent stop owner or revision changed.')
      managedOwner.stopRequested = true
      state.revoke(new Error('Managed Agent instance stopped.'))
      await this.joinOwnerAfterAbort(managedOwner)
      return
    }
    this.store.assertOrdinaryIdentity(input.instanceId)
    const instance = this.require(input.instanceId, input.expectedRevision)
    const policyRequest = createAgentInstanceLifecyclePolicyRequest({
      actor: input.actor,
      action: 'stop',
      instance
    })
    const authorizationId = `agent-instance-authorization:${digestPolicyRequest(policyRequest)}`
    const authorized = this.authorization.authorize({
      authorizationId,
      request: policyRequest,
      evaluatedAt: this.now(),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount !== undefined
        ? { expectedGrantUseCount: input.expectedGrantUseCount }
        : {}),
      idempotencyKey: `agent-instance:stop:authorize:${input.idempotencyKey}`
    })
    if (authorized.status !== 'authorized')
      throw new Error(`Agent instance stop ${authorized.status}.`)
    this.authorization.consumeExecutionPermit({
      permit: authorized.permit,
      request: policyRequest,
      consumedAt: this.now(),
      idempotencyKey: `agent-instance:stop:consume:${input.idempotencyKey}`
    })
    const active = this.active.get(input.instanceId)
    if (active) {
      active.stopRequested = true
      active.controller.abort(new Error('Agent instance stopped.'))
      // The owner publishes stopped, including a paused terminal instance. After
      // joining, never mutate by ID: a new execution may already occupy that ID.
      await this.joinOwnerAfterAbort(active)
      return
    }
    const current = this.store.get(input.instanceId)
    if (current?.state.status === 'running' || current?.state.status === 'paused')
      this.store.stop({
        instanceId: input.instanceId,
        expectedRevision: current.revision,
        transitionedAt: this.now(),
        idempotencyKey: `runtime-stop:${input.idempotencyKey}`
      })
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const task = new Promise<void>((done, failed) => { resolve = done; reject = failed })
    void task.catch(() => undefined)
    this.closing = task
    this.replacementOwnership.closing = task
    const activeRuns = [...this.active.values()]
    // Publish the guard/join before abort listeners can synchronously re-enter.
    for (const item of activeRuns) {
      item.stopRequested = true
      item.controller.abort(new Error('Agent instance lifecycle closed.'))
    }
    void Promise.allSettled(activeRuns.map((item) => this.joinOwnerAfterAbort(item))).then(results => {
      // Await every captured owner; choose errors in stable owner insertion order.
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') reject(failure.reason)
      else resolve()
    })
    return task
  }

  /** Diagnostic snapshot only; it never restores an owner, retry or execution authority. */
  getRecoveryDiagnostics(): readonly AgentInstanceRecoveryDiagnostic[] {
    return this.recoveryDiagnostics
  }

  recoverInterrupted(recoveredAt = this.now()): readonly StoredResource<MagicAgentInstanceState>[] {
    if (this.closing || this.active.size)
      throw new Error('Cannot recover interrupted instances while this lifecycle owns or closes work.')
    this.recoveryDiagnostics = Object.freeze([])
    // Classification precedes every legacy mutation. No strict managed body
    // inspection: unsupported/tombstoned coverage is still permanent exclusion.
    // A database/read error propagates instead of being caught as legacy absence.
    const items = this.store.list().map(item => ({ item, managed:
      this.store.hasManagedIdentity(item.id) || this.store.hasManagedIdentity(item.state.id) ||
      (item.state.parentInstanceId !== undefined && this.store.hasManagedIdentity(item.state.parentInstanceId))
    }))
    this.recoveryDiagnostics = Object.freeze(items.filter(({ managed }) => managed).map(({ item }) =>
      Object.freeze({ code: 'managed-instance-quarantined' as const, instanceId: item.id })))
    return items.filter(({ item, managed }) => !managed && (item.state.status === 'running' || item.state.status === 'paused'))
      .map(({ item }) => this.store.stop({
        instanceId: item.id,
        expectedRevision: item.revision,
        transitionedAt: recoveredAt,
        idempotencyKey: `restart-interrupted:${item.revision}`
      }))
  }

  private require(id: string, revision: number): StoredResource<MagicAgentInstanceState> {
    const item = this.store.get(id)
    if (!item) throw new Error('Agent instance not found.')
    if (item.revision !== revision) throw new Error('Agent instance revision conflict.')
    return item
  }

  private async joinOwnerAfterAbort(owner: AgentExecutionOwner): Promise<void> {
    try {
      await owner.promise
    } finally {
      // A faulted owner's join may already have rejected before stop/close.
      // Their abort listeners can synchronously register more known work: drain
      // that too, retaining the original error, without retrying publication or
      // changing pause/admission. This is observation, not an idle lease.
      do { await owner.cooperativeExecution.whenQuiescent() }
      while (!owner.cooperativeExecution.isQuiescent())
    }
  }

  private faultOwner(owner: AgentExecutionOwner, error: unknown): void {
    if (owner.phase === 'faulted') return
    owner.phase = 'faulted'
    owner.fault = error
    // Publication can synchronously register more work and then throw. A fault
    // stays fail-closed, but stop/close must still join that work before reporting
    // the original publication failure. Never retry the write or clear the owner.
    void (async () => {
      do { await owner.cooperativeExecution.whenQuiescent() }
      while (!owner.cooperativeExecution.isQuiescent())
      owner.reject(error)
    })()
  }

  private finishOwner(id: string, owner: AgentExecutionOwner, outcome: 'completed' | 'failed'): void {
    if (owner.phase !== 'running') return
    owner.phase = 'finishing'
    void this.drainAndPublishOwner(id, owner, outcome).catch(error => this.faultOwner(owner, error))
  }

  private async drainAndPublishOwner(
    id: string,
    owner: AgentExecutionOwner,
    outcome: 'completed' | 'failed'
  ): Promise<void> {
    for (;;) {
      await owner.cooperativeExecution.whenQuiescent()
      this.assertCurrentOwner(id, owner)
      // The passive wait is an observation, not a transferable idle grant.
      if (!owner.cooperativeExecution.isQuiescent()) continue
      if (!owner.publicationCompleted) {
        const current = this.store.get(id)
        const stoppedAt = this.now()
        this.assertCurrentOwner(id, owner)
        if (!owner.cooperativeExecution.isQuiescent()) continue
        if (current?.state.status === 'running' || (owner.stopRequested && current?.state.status === 'paused')) {
          this.store.stop({
            instanceId: id,
            expectedRevision: current.revision,
            transitionedAt: stoppedAt,
            idempotencyKey: `runtime-settle:${current.revision}:${outcome}`
          })
        }
        // A normally finishing durably-paused instance stays paused. Stop/close
        // explicitly request stopped instead. No second write on any exception.
        owner.publicationCompleted = true
      }
      this.assertCurrentOwner(id, owner)
      // Synchronous publication callbacks can introduce more registered work.
      // Retain this exact owner until that work actually drains as well.
      if (!owner.cooperativeExecution.isQuiescent()) continue
      this.active.delete(id)
      owner.resolve()
      return
    }
  }

  private assertCurrentOwner(id: string, owner: AgentExecutionOwner): void {
    if (this.active.get(id) !== owner)
      throw new Error('The Agent instance execution owner is no longer current.')
  }
}
