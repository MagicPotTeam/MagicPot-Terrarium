import type {
  MagicAgentInstanceState,
  MagicAgentInstanceStatus
} from '../../../shared/magicAgentPlatform2/agentInstance'
import { canonicalPolicyJson, sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentEventStore, StoredResource } from '../persistence/eventStore'

export const MAGIC_AGENT_INSTANCE_RESOURCE_KIND = 'agent-instance' as const

export type CreateAgentInstanceInput = Readonly<{
  instance: MagicAgentInstanceState
  createdAt: number
  idempotencyKey: string
}>

const assertString = (value: string, field: string): void => {
  if (!value.trim() || value !== value.trim())
    throw new Error(`${field} must be a trimmed non-empty string.`)
}

const assertInteger = (value: number, field: string): void => {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer.`)
}

const assertInstance = (instance: MagicAgentInstanceState): void => {
  assertString(instance.id, 'Agent instance id')
  assertString(instance.name, 'Agent instance name')
  assertString(instance.definitionId, 'Agent definition id')
  assertString(instance.configVersion, 'Agent config version')
  if (instance.ownerId !== undefined) assertString(instance.ownerId, 'Agent owner id')
  if (instance.parentInstanceId !== undefined)
    assertString(instance.parentInstanceId, 'Parent instance id')
  assertInteger(instance.depth, 'Agent depth')
  if ((instance.parentInstanceId === undefined) !== (instance.depth === 0))
    throw new Error('Root Agent depth must be zero and child Agents must name a parent.')
  if (instance.parentInstanceId === instance.id)
    throw new Error('Agent instance cannot parent itself.')
  if (instance.status !== 'created') throw new Error('New Agent instance status must be created.')
  for (const [field, value] of Object.entries({
    maxChildren: instance.limits.maxChildren,
    maxDepth: instance.limits.maxDepth,
    maxConcurrency: instance.limits.maxConcurrency,
    maxRuntimeMs: instance.limits.maxRuntimeMs
  }))
    assertInteger(value, field)
  if (instance.depth > instance.limits.maxDepth) throw new Error('Agent depth exceeds its limit.')
  for (const tool of instance.limits.allowedToolNames) assertString(tool, 'Allowed tool name')
  for (const root of instance.limits.workspaceRoots) assertString(root, 'Workspace root')
  if (new Set(instance.limits.allowedToolNames).size !== instance.limits.allowedToolNames.length)
    throw new Error('Allowed tool names must be unique.')
  if (new Set(instance.limits.workspaceRoots).size !== instance.limits.workspaceRoots.length)
    throw new Error('Workspace roots must be unique.')
}

const transitions: Readonly<Record<MagicAgentInstanceStatus, readonly MagicAgentInstanceStatus[]>> =
  {
    created: ['running', 'stopped', 'removed'],
    running: ['paused', 'stopped'],
    paused: ['running', 'stopped'],
    stopped: ['running', 'removed'],
    removed: []
  }

const event = (
  id: string,
  type: string,
  createdAt: number,
  revision: number,
  payload: Record<string, unknown>
) => ({
  protocolVersion: '2.0.0',
  id: `agent-instance:${id}:${type}:${createdAt}:${revision}`,
  type,
  createdAt,
  payload,
  envelopeKind: 'event' as const,
  streamId: `agent-instance:${id}:stream`,
  sequence: revision,
  resource: { kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND, id },
  revision
})

export class PersistentAgentInstanceStore {
  constructor(private readonly eventStore: MagicAgentEventStore) {}

  list(): readonly StoredResource<MagicAgentInstanceState>[] {
    return this.eventStore.listResources({
      kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND,
      limit: 1_000
    }) as readonly StoredResource<MagicAgentInstanceState>[]
  }

  get(id: string): StoredResource<MagicAgentInstanceState> | undefined {
    return this.eventStore.getResource(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, id) as
      | StoredResource<MagicAgentInstanceState>
      | undefined
  }

  getChildReservationReplay(input: {
    parentInstanceId: string
    parentExpectedRevision: number
    child: MagicAgentInstanceState
    createdAt: number
    idempotencyKey: string
  }): StoredResource<MagicAgentInstanceState> | undefined {
    const reservationKey = `agent-instance:${input.parentInstanceId}:reserve-child:${input.idempotencyKey}`
    const reservation = this.eventStore
      .listResourceMutations(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, input.parentInstanceId, 1_000)
      .find((item) => item.idempotencyKey === reservationKey)
    if (!reservation) return undefined
    const committed = this.eventStore.getEvent(reservation.eventId)
    const payload = committed?.payload as { childId?: string } | undefined
    if (
      committed?.type !== 'agent-instance.child-reserved' ||
      committed.createdAt !== input.createdAt ||
      committed.sequence !== input.parentExpectedRevision + 1 ||
      payload?.childId !== input.child.id
    )
      throw new Error('Agent child reservation idempotency conflict.')
    const child = this.getCreateReplay({
      instance: input.child,
      createdAt: input.createdAt,
      idempotencyKey: input.idempotencyKey
    })
    if (!child) throw new Error('Agent child reservation replay is incomplete.')
    return child
  }

  reserveChild(input: {
    parentInstanceId: string
    parentExpectedRevision: number
    child: MagicAgentInstanceState
    createdAt: number
    idempotencyKey: string
  }): Readonly<{
    parent: StoredResource<MagicAgentInstanceState>
    child: StoredResource<MagicAgentInstanceState>
  }> {
    assertInstance(input.child)
    if (input.child.parentInstanceId !== input.parentInstanceId)
      throw new Error('Child Agent parent identity mismatch.')
    const parent = this.get(input.parentInstanceId)
    if (!parent) throw new Error('Parent Agent instance not found.')
    if (parent.revision !== input.parentExpectedRevision)
      throw new Error('Parent Agent instance revision conflict.')
    if (this.get(input.child.id)) throw new Error('Agent instance already exists.')
    const reservationKey = `agent-instance:${parent.id}:reserve-child:${input.idempotencyKey}`
    const childKey = `agent-instance:${input.child.id}:create:${input.idempotencyKey}`
    const results = this.eventStore.mutateResourcesBatch([
      {
        operation: 'update',
        kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND,
        id: parent.id,
        expectedRevision: parent.revision,
        state: parent.state,
        createdAt: input.createdAt,
        idempotencyKey: reservationKey,
        event: event(
          parent.id,
          'agent-instance.child-reserved',
          input.createdAt,
          parent.revision + 1,
          { childId: input.child.id }
        )
      },
      {
        operation: 'create',
        kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND,
        id: input.child.id,
        state: input.child,
        createdAt: input.createdAt,
        idempotencyKey: childKey,
        event: event(input.child.id, 'agent-instance.created', input.createdAt, 0, {
          status: 'created',
          parentInstanceId: parent.id,
          stateDigest: sha256PolicyText(canonicalPolicyJson(input.child as never))
        })
      }
    ])
    const parentResult = results[0]
    const childResult = results[1]
    if (!parentResult || !childResult) throw new Error('Agent child reservation did not commit.')
    return {
      parent: parentResult.resource as StoredResource<MagicAgentInstanceState>,
      child: childResult.resource as StoredResource<MagicAgentInstanceState>
    }
  }

  getCreateReplay(
    input: CreateAgentInstanceInput
  ): StoredResource<MagicAgentInstanceState> | undefined {
    const digest = sha256PolicyText(canonicalPolicyJson(input.instance as never))
    const storedKey = `agent-instance:${input.instance.id}:create:${input.idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, input.instance.id, 1_000)
      .find((item) => item.idempotencyKey === storedKey)
    if (!replay) return undefined
    const committed = this.eventStore.getEvent(replay.eventId)
    const payload = committed?.payload as { stateDigest?: string } | undefined
    if (
      committed?.type !== 'agent-instance.created' ||
      committed.createdAt !== input.createdAt ||
      payload?.stateDigest !== digest
    )
      throw new Error('Agent instance create idempotency conflict.')
    return replay.resource as StoredResource<MagicAgentInstanceState>
  }

  create(input: CreateAgentInstanceInput): StoredResource<MagicAgentInstanceState> {
    assertInstance(input.instance)
    if (!Number.isFinite(input.createdAt) || input.createdAt < 0 || !input.idempotencyKey.trim())
      throw new Error('Invalid Agent instance create command.')
    const digest = sha256PolicyText(canonicalPolicyJson(input.instance as never))
    const storedKey = `agent-instance:${input.instance.id}:create:${input.idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, input.instance.id, 1_000)
      .find((item) => item.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as { stateDigest?: string } | undefined
      if (
        committed?.type !== 'agent-instance.created' ||
        committed.createdAt !== input.createdAt ||
        payload?.stateDigest !== digest
      )
        throw new Error('Agent instance create idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentInstanceState>
    }
    if (this.get(input.instance.id)) throw new Error('Agent instance already exists.')
    return this.eventStore.mutateResource<MagicAgentInstanceState>({
      operation: 'create',
      kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND,
      id: input.instance.id,
      state: input.instance,
      createdAt: input.createdAt,
      idempotencyKey: storedKey,
      event: event(input.instance.id, 'agent-instance.created', input.createdAt, 0, {
        status: 'created',
        stateDigest: digest
      })
    }).resource
  }

  stageConfig(input: {
    id: string
    expectedRevision: number
    configVersion: string
    stagedAt: number
    idempotencyKey: string
  }) {
    assertString(input.configVersion, 'Agent config version')
    return this.mutate(
      input.id,
      input.expectedRevision,
      input.stagedAt,
      input.idempotencyKey,
      'agent-instance.config-staged',
      { configVersion: input.configVersion },
      (state) => ({ ...state, pendingConfigVersion: input.configVersion })
    )
  }

  activateStagedConfig(input: {
    id: string
    expectedRevision: number
    activatedAt: number
    idempotencyKey: string
  }) {
    const current = this.get(input.id)
    if (!current?.state.pendingConfigVersion)
      throw new Error('Agent instance has no staged config version.')
    return this.mutate(
      input.id,
      input.expectedRevision,
      input.activatedAt,
      input.idempotencyKey,
      'agent-instance.config-activated',
      { configVersion: current.state.pendingConfigVersion },
      (state) => {
        const { pendingConfigVersion, ...rest } = state
        return {
          ...rest,
          previousConfigVersion: state.configVersion,
          configVersion: pendingConfigVersion!,
          configActivatedAt: input.activatedAt
        }
      }
    )
  }

  rollbackConfig(input: {
    id: string
    expectedRevision: number
    rolledBackAt: number
    idempotencyKey: string
  }) {
    const current = this.get(input.id)
    if (!current?.state.previousConfigVersion)
      throw new Error('Agent instance has no previous config version.')
    return this.mutate(
      input.id,
      input.expectedRevision,
      input.rolledBackAt,
      input.idempotencyKey,
      'agent-instance.config-rolled-back',
      { configVersion: current.state.previousConfigVersion },
      (state) => {
        const { pendingConfigVersion, ...rest } = state
        return {
          ...rest,
          configVersion: state.previousConfigVersion!,
          previousConfigVersion: state.configVersion,
          configActivatedAt: input.rolledBackAt
        }
      }
    )
  }

  private mutate(
    id: string,
    expectedRevision: number,
    at: number,
    idempotencyKey: string,
    type: string,
    payload: Record<string, unknown>,
    update: (state: MagicAgentInstanceState) => MagicAgentInstanceState
  ) {
    if (
      !id.trim() ||
      !idempotencyKey.trim() ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !Number.isFinite(at) ||
      at < 0
    )
      throw new Error('Invalid Agent config command.')
    const storedKey = `agent-instance:${id}:${type}:${idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, id, 1_000)
      .find((item) => item.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      if (
        committed?.type !== type ||
        committed.createdAt !== at ||
        sha256PolicyText(canonicalPolicyJson(committed.payload as never)) !==
          sha256PolicyText(canonicalPolicyJson(payload as never))
      )
        throw new Error('Agent config idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentInstanceState>
    }
    const current = this.get(id)
    if (!current) throw new Error('Agent instance not found.')
    if (current.revision !== expectedRevision) throw new Error('Agent instance revision conflict.')
    return this.eventStore.mutateResource<MagicAgentInstanceState>({
      operation: 'update',
      kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND,
      id,
      expectedRevision,
      state: update(current.state),
      createdAt: at,
      idempotencyKey: storedKey,
      event: event(id, type, at, expectedRevision + 1, payload)
    }).resource
  }

  getTransitionReplay(
    instanceId: string,
    status: MagicAgentInstanceStatus,
    idempotencyKey: string
  ): StoredResource<MagicAgentInstanceState> | undefined {
    const storedKey = `agent-instance:${instanceId}:transition:${idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, instanceId, 1_000)
      .find((item) => item.idempotencyKey === storedKey)
    if (!replay) return undefined
    const committed = this.eventStore.getEvent(replay.eventId)
    const payload = committed?.payload as { status?: string } | undefined
    if (committed?.type !== 'agent-instance.status-transitioned' || payload?.status !== status)
      throw new Error('Agent instance transition idempotency conflict.')
    return replay.resource as StoredResource<MagicAgentInstanceState>
  }

  getReplaceReplay(instanceId: string, idempotencyKey: string) {
    const key = `agent-instance:${instanceId}:replace:${idempotencyKey}`
    return this.eventStore
      .listResourceMutations(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, instanceId, 1_000)
      .find((item) => item.idempotencyKey === key)
  }

  replace(input: {
    instanceId: string
    expectedRevision: number
    definitionId: string
    name: string
    configVersion: string
    replacedAt: number
    idempotencyKey: string
  }) {
    assertString(input.instanceId, 'Agent instance id')
    assertString(input.definitionId, 'Agent definition id')
    assertString(input.name, 'Agent instance name')
    assertString(input.configVersion, 'Agent config version')
    const key = `agent-instance:${input.instanceId}:replace:${input.idempotencyKey}`
    const replay = this.getReplaceReplay(input.instanceId, input.idempotencyKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as
        | { definitionId?: string; name?: string; configVersion?: string }
        | undefined
      if (
        committed?.createdAt !== input.replacedAt ||
        payload?.definitionId !== input.definitionId ||
        payload?.name !== input.name ||
        payload?.configVersion !== input.configVersion
      )
        throw new Error('Agent instance replace idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentInstanceState>
    }
    const current = this.get(input.instanceId)
    if (!current) throw new Error('Agent instance not found.')
    if (current.revision !== input.expectedRevision)
      throw new Error('Agent instance revision conflict.')
    if (current.state.status === 'running' || current.state.status === 'removed')
      throw new Error('Agent instance must be quiescent before replacement.')
    return this.eventStore.mutateResource<MagicAgentInstanceState>({
      operation: 'update',
      kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND,
      id: input.instanceId,
      expectedRevision: input.expectedRevision,
      createdAt: input.replacedAt,
      idempotencyKey: key,
      state: {
        ...current.state,
        name: input.name,
        definitionId: input.definitionId,
        configVersion: input.configVersion,
        ...(current.state.configVersion
          ? { previousConfigVersion: current.state.configVersion }
          : {}),
        configActivatedAt: input.replacedAt,
        status: 'stopped'
      },
      event: event(
        input.instanceId,
        'agent-instance.replaced',
        input.replacedAt,
        input.expectedRevision + 1,
        {
          previousDefinitionId: current.state.definitionId,
          definitionId: input.definitionId,
          name: input.name,
          previousConfigVersion: current.state.configVersion,
          configVersion: input.configVersion
        }
      )
    }).resource
  }

  transition(input: {
    instanceId: string
    expectedRevision: number
    status: MagicAgentInstanceStatus
    transitionedAt: number
    idempotencyKey: string
  }): StoredResource<MagicAgentInstanceState> {
    if (
      !input.instanceId.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(input.transitionedAt) ||
      input.transitionedAt < 0
    )
      throw new Error('Invalid Agent instance transition command.')
    const storedKey = `agent-instance:${input.instanceId}:transition:${input.idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, input.instanceId, 1_000)
      .find((item) => item.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as { status?: string } | undefined
      if (
        committed?.type !== 'agent-instance.status-transitioned' ||
        committed.createdAt !== input.transitionedAt ||
        payload?.status !== input.status
      )
        throw new Error('Agent instance transition idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentInstanceState>
    }
    const current = this.get(input.instanceId)
    if (!current) throw new Error('Agent instance not found.')
    if (current.revision !== input.expectedRevision)
      throw new Error('Agent instance revision conflict.')
    if (!transitions[current.state.status].includes(input.status))
      throw new Error(
        `Invalid Agent instance transition: ${current.state.status} -> ${input.status}.`
      )
    return this.eventStore.mutateResource<MagicAgentInstanceState>({
      operation: 'update',
      kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND,
      id: input.instanceId,
      expectedRevision: input.expectedRevision,
      state: { ...current.state, status: input.status },
      createdAt: input.transitionedAt,
      idempotencyKey: storedKey,
      event: event(
        input.instanceId,
        'agent-instance.status-transitioned',
        input.transitionedAt,
        input.expectedRevision + 1,
        { fromStatus: current.state.status, status: input.status }
      )
    }).resource
  }

  start(input: Omit<Parameters<PersistentAgentInstanceStore['transition']>[0], 'status'>) {
    return this.transition({ ...input, status: 'running' })
  }
  pause(input: Omit<Parameters<PersistentAgentInstanceStore['transition']>[0], 'status'>) {
    return this.transition({ ...input, status: 'paused' })
  }
  resume(input: Omit<Parameters<PersistentAgentInstanceStore['transition']>[0], 'status'>) {
    return this.transition({ ...input, status: 'running' })
  }
  stop(input: Omit<Parameters<PersistentAgentInstanceStore['transition']>[0], 'status'>) {
    return this.transition({ ...input, status: 'stopped' })
  }
  remove(input: Omit<Parameters<PersistentAgentInstanceStore['transition']>[0], 'status'>) {
    return this.transition({ ...input, status: 'removed' })
  }
}
