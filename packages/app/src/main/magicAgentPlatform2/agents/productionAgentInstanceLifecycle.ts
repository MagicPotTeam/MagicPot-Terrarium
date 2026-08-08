import { createHash } from 'node:crypto'
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
import { CooperativeExecutionController } from './cooperativeExecutionController'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'

export type AgentInstanceRunAdapter = (
  request: MagicAgentPlatformRunReq,
  options: { signal: AbortSignal; cooperativeExecution: CooperativeExecutionController }
) => Promise<MagicAgentPlatformRunResp>

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

export class ProductionAgentInstanceLifecycleService {
  private readonly active = new Map<
    string,
    {
      controller: AbortController
      cooperativeExecution: CooperativeExecutionController
      promise: Promise<void>
    }
  >()

  constructor(
    readonly store: PersistentAgentInstanceStore,
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    private readonly runAgent: AgentInstanceRunAdapter,
    private readonly now: () => number = Date.now,
    private readonly configStore?: import('./persistentAgentConfigStore').PersistentAgentConfigStore
  ) {}

  authorizeLifecycleMutation(input: {
    actor: PolicyActorRef
    action: 'create' | 'replace' | 'remove'
    instance: StoredResource<MagicAgentInstanceState>
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): boolean {
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

  async requestCooperativePause(instanceId: string): Promise<void> {
    const execution = this.active.get(instanceId)
    if (!execution) throw new Error('Agent instance is not active.')
    await execution.cooperativeExecution.requestPause()
  }

  resumeCooperativeExecution(instanceId: string): void {
    const execution = this.active.get(instanceId)
    if (!execution) throw new Error('Agent instance is not active.')
    execution.cooperativeExecution.resume()
  }

  isAtSafePoint(instanceId: string): boolean {
    const execution = this.active.get(instanceId)
    return (
      !execution ||
      (execution.cooperativeExecution.isPaused() && execution.cooperativeExecution.isQuiescent())
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
    const running = this.store.start({
      instanceId: input.instanceId,
      expectedRevision: input.expectedRevision,
      transitionedAt: this.now(),
      idempotencyKey: `runtime-start:${input.idempotencyKey}`
    })
    const controller = new AbortController()
    const cooperativeExecution = new CooperativeExecutionController()
    const promise = this.runAgent(effectiveRequest, {
      signal: controller.signal,
      cooperativeExecution
    })
      .then(() => this.settle(input.instanceId, 'completed'))
      .catch(() => this.settle(input.instanceId, 'failed'))
    this.active.set(input.instanceId, { controller, cooperativeExecution, promise })
    return Promise.resolve()
  }

  async quiesceForReplacement(
    instanceId: string
  ): Promise<StoredResource<MagicAgentInstanceState>> {
    const current = this.store.get(instanceId)
    if (!current) throw new Error('Agent instance not found.')
    if (current.state.status === 'running') {
      await this.requestCooperativePause(instanceId)
      const drained = this.store.get(instanceId)!
      return this.store.pause({
        instanceId,
        expectedRevision: drained.revision,
        transitionedAt: this.now(),
        idempotencyKey: `replacement-quiesce:${instanceId}:${drained.revision}`
      })
    }
    if (!this.isAtSafePoint(instanceId))
      throw new Error('Agent instance is not at a replacement safe point.')
    return current
  }

  async pause(input: {
    instanceId: string
    expectedRevision: number
    actor: PolicyActorRef
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): Promise<StoredResource<MagicAgentInstanceState>> {
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
      authorizationId: `agent-instance-authorization:${digestPolicyRequest(policyRequest)}`,
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
    if (this.store.get(input.instanceId)?.state.status === 'paused')
      return this.store.get(input.instanceId)!
    await this.requestCooperativePause(input.instanceId)
    const current = this.store.get(input.instanceId)!
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
      authorizationId: `agent-instance-authorization:${digestPolicyRequest(policyRequest)}`,
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
    if (this.store.get(input.instanceId)?.state.status === 'running')
      return this.store.get(input.instanceId)!
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
    active?.controller.abort(new Error('Agent instance stopped.'))
    if (active) await active.promise
    const current = this.store.get(input.instanceId)
    if (current?.state.status === 'running' || current?.state.status === 'paused')
      this.store.stop({
        instanceId: input.instanceId,
        expectedRevision: current.revision,
        transitionedAt: this.now(),
        idempotencyKey: `runtime-stop:${input.idempotencyKey}`
      })
  }

  async close(): Promise<void> {
    const activeRuns = [...this.active.values()]
    for (const item of activeRuns)
      item.controller.abort(new Error('Agent instance lifecycle closed.'))
    await Promise.allSettled(activeRuns.map((item) => item.promise))
  }

  recoverInterrupted(recoveredAt = this.now()): readonly StoredResource<MagicAgentInstanceState>[] {
    return this.store
      .list()
      .filter((item) => item.state.status === 'running' || item.state.status === 'paused')
      .map((item) =>
        this.store.stop({
          instanceId: item.id,
          expectedRevision: item.revision,
          transitionedAt: recoveredAt,
          idempotencyKey: `restart-interrupted:${item.revision}`
        })
      )
  }

  private require(id: string, revision: number): StoredResource<MagicAgentInstanceState> {
    const item = this.store.get(id)
    if (!item) throw new Error('Agent instance not found.')
    if (item.revision !== revision) throw new Error('Agent instance revision conflict.')
    return item
  }

  private settle(id: string, outcome: string): void {
    this.active.delete(id)
    const current = this.store.get(id)
    if (current?.state.status === 'running')
      this.store.stop({
        instanceId: id,
        expectedRevision: current.revision,
        transitionedAt: this.now(),
        idempotencyKey: `runtime-settle:${current.revision}:${outcome}`
      })
  }
}
