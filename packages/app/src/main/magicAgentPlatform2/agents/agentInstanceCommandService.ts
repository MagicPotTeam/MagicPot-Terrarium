import { classifyMagicAgentConfigPrivilegeChange } from '../../../shared/magicAgentPlatform2/agentConfig'
import type { MagicAgentConfigContent } from '../../../shared/magicAgentPlatform2/agentConfig'
import type { MagicAgentPlatformRunReq } from '../../../shared/api/svcMagicAgentPlatform'
import type {
  MagicAgentInstanceLimits,
  MagicAgentInstanceState
} from '../../../shared/magicAgentPlatform2/agentInstance'
import type { PolicyActorRef } from '../../../shared/magicAgentPlatform2/policy'
import type { StoredResource } from '../persistence/eventStore'
import type { ProductionAgentInstanceLifecycleService } from './productionAgentInstanceLifecycle'
import { PersistentAgentConfigStore } from './persistentAgentConfigStore'
import type { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'

export class AgentInstanceCommandError extends Error {
  constructor(
    readonly code:
      | 'not-found'
      | 'revision-conflict'
      | 'limit-exceeded'
      | 'invalid-state'
      | 'invalid-command',
    message: string
  ) {
    super(message)
    this.name = 'AgentInstanceCommandError'
  }
}

const assertActorMayManageInstance = (
  actor: import('../../../shared/magicAgentPlatform2/policy').PolicyActorRef,
  instance: StoredResource<MagicAgentInstanceState>,
  action: string
) => {
  if (actor.kind === 'user') return
  if (actor.kind !== 'agent' || actor.id !== instance.id)
    throw new Error(`Agent may only ${action} itself.`)
}

const normalize = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error)
  const code = /not found/i.test(message)
    ? 'not-found'
    : /revision conflict|idempotency conflict|already exists/i.test(message)
      ? 'revision-conflict'
      : /limit|allowed tool|workspace root|children|depth|concurr/i.test(message)
        ? 'limit-exceeded'
        : /invalid Agent instance transition|already active/i.test(message)
          ? 'invalid-state'
          : 'invalid-command'
  throw new AgentInstanceCommandError(code, message)
}

const subset = (child: readonly string[], parent: readonly string[]): boolean =>
  child.every((value) => parent.includes(value))

const assertInheritedLimits = (
  child: MagicAgentInstanceLimits,
  parent: MagicAgentInstanceLimits
): void => {
  if (
    child.maxChildren > parent.maxChildren ||
    child.maxDepth > parent.maxDepth ||
    child.maxConcurrency > parent.maxConcurrency ||
    child.maxRuntimeMs > parent.maxRuntimeMs
  )
    throw new Error('Child Agent numeric limits cannot exceed inherited parent limits.')
  if (!subset(child.allowedToolNames, parent.allowedToolNames))
    throw new Error('Child Agent allowed tool limit exceeds its parent.')
  if (!subset(child.workspaceRoots, parent.workspaceRoots))
    throw new Error('Child Agent workspace root limit exceeds its parent.')
}

export class AgentInstanceCommandService {
  constructor(
    private readonly store: PersistentAgentInstanceStore,
    private readonly lifecycle: ProductionAgentInstanceLifecycleService,
    readonly configStore?: PersistentAgentConfigStore
  ) {}

  list(): readonly StoredResource<MagicAgentInstanceState>[] {
    return this.store.list()
  }

  get(instanceId: string): StoredResource<MagicAgentInstanceState> | undefined {
    if (!instanceId.trim())
      throw new AgentInstanceCommandError('invalid-command', 'instanceId is required.')
    return this.store.get(instanceId)
  }

  createConfigVersion(input: {
    config: MagicAgentConfigContent
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    try {
      if (!this.configStore) throw new Error('Agent config store is unavailable.')
      const replay = this.configStore.getCreateReplay(input)
      if (replay) return replay
      const instance = this.store
        .list()
        .find((candidate) => candidate.state.definitionId === input.config.definitionId)
      if (!instance) throw new Error('Agent config definition has no managed Agent instance.')
      const authorized = this.lifecycle.authorizeConfigMutation({
        actor: input.config.createdBy,
        action: 'create-config',
        instanceId: instance.id,
        configVersion: input.config.version,
        idempotencyKey: `config:${input.idempotencyKey}`,
        ...(input.grantId ? { grantId: input.grantId } : {}),
        ...(input.expectedGrantUseCount !== undefined
          ? { expectedGrantUseCount: input.expectedGrantUseCount }
          : {})
      })
      if (!authorized) return this.configStore.get(input.config.version)!
      return this.configStore.create(input)
    } catch (error) {
      return normalize(error)
    }
  }

  createRoot(input: {
    actor: PolicyActorRef
    instance: MagicAgentInstanceState
    createdAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): StoredResource<MagicAgentInstanceState> {
    try {
      const replay = this.store.getCreateReplay({
        instance: input.instance,
        createdAt: input.createdAt,
        idempotencyKey: input.idempotencyKey
      })
      if (replay) return replay
      if (input.instance.parentInstanceId !== undefined || input.instance.depth !== 0)
        throw new Error('Root Agent instance cannot name a parent and must have depth zero.')
      const candidate = {
        kind: 'agent-instance' as const,
        id: input.instance.id,
        revision: 0,
        state: input.instance,
        deleted: false,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      }
      this.lifecycle.authorizeLifecycleMutation({ ...input, action: 'create', instance: candidate })
      return this.store.create({
        instance: input.instance,
        createdAt: input.createdAt,
        idempotencyKey: input.idempotencyKey
      })
    } catch (error) {
      return normalize(error)
    }
  }

  createChild(input: {
    actor: PolicyActorRef
    parentInstanceId: string
    parentExpectedRevision: number
    instance: Omit<MagicAgentInstanceState, 'parentInstanceId' | 'depth' | 'status'>
    createdAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): StoredResource<MagicAgentInstanceState> {
    try {
      const parent = this.store.get(input.parentInstanceId)
      if (!parent) throw new Error('Parent Agent instance not found.')
      if (parent.state.status === 'removed') throw new Error('Invalid Agent instance parent state.')
      const depth = parent.state.depth + 1
      const childState: MagicAgentInstanceState = {
        ...input.instance,
        parentInstanceId: parent.id,
        depth,
        status: 'created'
      }
      const replay = this.store.getChildReservationReplay({
        parentInstanceId: input.parentInstanceId,
        parentExpectedRevision: input.parentExpectedRevision,
        child: childState,
        createdAt: input.createdAt,
        idempotencyKey: input.idempotencyKey
      })
      if (replay) return replay
      if (parent.revision !== input.parentExpectedRevision)
        throw new Error('Parent Agent instance revision conflict.')
      const children = this.store
        .list()
        .filter(
          (candidate) =>
            candidate.state.parentInstanceId === parent.id && candidate.state.status !== 'removed'
        )
      if (children.length >= parent.state.limits.maxChildren)
        throw new Error('Parent Agent maximum children limit exceeded.')
      if (depth > parent.state.limits.maxDepth)
        throw new Error('Parent Agent maximum depth limit exceeded.')
      assertInheritedLimits(input.instance.limits, parent.state.limits)
      this.lifecycle.authorizeLifecycleMutation({
        ...input,
        action: 'create',
        instance: {
          kind: 'agent-instance' as const,
          id: childState.id,
          revision: 0,
          state: childState,
          deleted: false,
          createdAt: input.createdAt,
          updatedAt: input.createdAt
        }
      })
      return this.store.reserveChild({
        parentInstanceId: parent.id,
        parentExpectedRevision: input.parentExpectedRevision,
        child: childState,
        createdAt: input.createdAt,
        idempotencyKey: input.idempotencyKey
      }).child
    } catch (error) {
      return normalize(error)
    }
  }

  async replace(input: {
    actor: import('../../../shared/magicAgentPlatform2/policy').PolicyActorRef
    instanceId: string
    expectedRevision: number
    definitionId: string
    name: string
    configVersion: string
    replacedAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    try {
      const replay = this.store.getReplaceReplay(input.instanceId, input.idempotencyKey)
      if (replay) return this.store.replace(input)
      const instance = this.store.get(input.instanceId)
      if (!instance) throw new Error('Agent instance not found.')
      if (instance.revision !== input.expectedRevision)
        throw new Error('Agent instance revision conflict.')
      assertActorMayManageInstance(input.actor, instance, 'replace')
      if (!this.configStore?.get(input.configVersion))
        throw new Error('Replacement Agent config content is unavailable.')
      this.lifecycle.authorizeLifecycleMutation({ ...input, action: 'replace', instance })
      const quiescent = await this.lifecycle.quiesceForReplacement(input.instanceId)
      return this.store.replace({ ...input, expectedRevision: quiescent.revision })
    } catch (error) {
      return normalize(error)
    }
  }

  stageConfig(input: {
    actor: import('../../../shared/magicAgentPlatform2/policy').PolicyActorRef
    instanceId: string
    expectedRevision: number
    configVersion: string
    stagedAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    try {
      if (!this.lifecycle.authorizeConfigMutation({ ...input, action: 'stage-config' }))
        return this.store.get(input.instanceId)!
      return this.store.stageConfig({
        id: input.instanceId,
        expectedRevision: input.expectedRevision,
        configVersion: input.configVersion,
        stagedAt: input.stagedAt,
        idempotencyKey: input.idempotencyKey
      })
    } catch (error) {
      return normalize(error)
    }
  }

  activateStagedConfig(input: {
    actor: import('../../../shared/magicAgentPlatform2/policy').PolicyActorRef
    instanceId: string
    expectedRevision: number
    activatedAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    try {
      const instance = this.store.get(input.instanceId)
      if (!instance?.state.pendingConfigVersion)
        throw new Error('Agent instance has no staged config version.')
      if (!this.configStore) throw new Error('Agent config store is unavailable.')
      const before = this.configStore.get(instance.state.configVersion)?.state
      const after = this.configStore.get(instance.state.pendingConfigVersion)?.state
      if (!before || !after)
        throw new Error('Active or staged Agent config content is unavailable.')
      const privilegeChange = classifyMagicAgentConfigPrivilegeChange(before, after)
      if (
        !this.lifecycle.authorizeConfigMutation({
          ...input,
          action: 'activate-config',
          configVersion: instance.state.pendingConfigVersion,
          privilegeChange
        })
      )
        return this.store.get(input.instanceId)!
      return this.lifecycle.activateStagedConfigAtSafePoint(input)
    } catch (error) {
      return normalize(error)
    }
  }

  rollbackConfig(input: {
    actor: import('../../../shared/magicAgentPlatform2/policy').PolicyActorRef
    instanceId: string
    expectedRevision: number
    rolledBackAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    try {
      if (!this.lifecycle.authorizeConfigMutation({ ...input, action: 'rollback-config' }))
        return this.store.get(input.instanceId)!
      return this.lifecycle.rollbackConfigAtSafePoint(input)
    } catch (error) {
      return normalize(error)
    }
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
    try {
      const instance = this.store.get(input.instanceId)
      if (!instance) throw new Error('Agent instance not found.')
      if (instance.state.parentInstanceId) {
        const parent = this.store.get(instance.state.parentInstanceId)
        if (!parent) throw new Error('Parent Agent instance not found.')
        const activeSiblings = this.store
          .list()
          .filter(
            (candidate) =>
              candidate.state.parentInstanceId === parent.id && candidate.state.status === 'running'
          )
        if (activeSiblings.length >= parent.state.limits.maxConcurrency)
          throw new Error('Parent Agent concurrency limit exceeded.')
      }
      await this.lifecycle.start(input)
    } catch (error) {
      return normalize(error)
    }
  }

  pause(input: Parameters<ProductionAgentInstanceLifecycleService['pause']>[0]) {
    try {
      return this.lifecycle.pause(input)
    } catch (error) {
      return normalize(error)
    }
  }

  resume(input: Parameters<ProductionAgentInstanceLifecycleService['resume']>[0]) {
    try {
      return this.lifecycle.resume(input)
    } catch (error) {
      return normalize(error)
    }
  }

  async stop(input: Parameters<ProductionAgentInstanceLifecycleService['stop']>[0]): Promise<void> {
    try {
      await this.lifecycle.stop(input)
    } catch (error) {
      return normalize(error)
    }
  }

  remove(input: {
    actor: PolicyActorRef
    instanceId: string
    expectedRevision: number
    removedAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }): StoredResource<MagicAgentInstanceState> {
    try {
      const replay = this.store.getTransitionReplay(
        input.instanceId,
        'removed',
        input.idempotencyKey
      )
      if (replay) return replay
      if (
        this.store
          .list()
          .some(
            (candidate) =>
              candidate.state.parentInstanceId === input.instanceId &&
              candidate.state.status !== 'removed'
          )
      )
        throw new Error('Agent instance with active children cannot be removed.')
      const instance = this.store.get(input.instanceId)
      if (!instance) throw new Error('Agent instance not found.')
      this.lifecycle.authorizeLifecycleMutation({ ...input, action: 'remove', instance })
      return this.store.remove({
        instanceId: input.instanceId,
        expectedRevision: input.expectedRevision,
        transitionedAt: input.removedAt,
        idempotencyKey: input.idempotencyKey
      })
    } catch (error) {
      return normalize(error)
    }
  }
}
