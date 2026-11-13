import { isProxy } from 'node:util/types'
import type {
  MagicAgentInstanceState,
  MagicAgentInstanceStatus
} from '../../../shared/magicAgentPlatform2/agentInstance'
import { canonicalPolicyJson, sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import { canonicalJson, type MagicAgentEventStore, type ResourceMutationInput, type StoredResource } from '../persistence/eventStore'
import type { PolicyActorRef } from '../../../shared/magicAgentPlatform2/policy'
import { hasManagedAgentInstanceEvidence, ManagedAgentOrdinaryAdmissionError } from './managedAgentInstanceIdentity'
import { AgentInstanceOrdinaryCommitFence, AgentInstanceOrdinaryEventCommitFence, assertAgentInstanceMutationCommitFence, assertAgentInstanceOrdinaryMutationResult, assertAgentInstanceOrdinaryEventCommitFence } from './agentInstanceOrdinaryCommitFence'
import {
  assertAgentInstanceReplacementCommitFence,
  type AgentInstanceReplacementCommitFence
} from './agentInstanceReplacementCommitFence'

export const MAGIC_AGENT_INSTANCE_RESOURCE_KIND = 'agent-instance' as const

export type AgentLifecycleCommand = Readonly<{
  action: 'pause' | 'resume'
  instanceId: string
  expectedRevision: number
  actor: PolicyActorRef
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>

const freezeJson = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

/** Capture once before authorization/await. No accessor or proxy is read. */
export function captureAgentLifecycleCommand(
  action: AgentLifecycleCommand['action'],
  input: Omit<AgentLifecycleCommand, 'action'>
): AgentLifecycleCommand {
  if (action !== 'pause' && action !== 'resume') throw new Error('Invalid lifecycle command action.')
  if (!input || typeof input !== 'object' || isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw new Error('Lifecycle command must be a plain object.')
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const fields: Record<string, unknown> = { action }
  const allowed = new Set(['action', 'instanceId', 'expectedRevision', 'actor', 'idempotencyKey', 'grantId', 'expectedGrantUseCount'])
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error('Invalid lifecycle command field.')
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Lifecycle command fields must be data.')
    if (key === 'action') {
      if (descriptor.value !== action) throw new Error('Lifecycle command action mismatch.')
    } else if (descriptor.value !== undefined) fields[key] = descriptor.value
  }
  const command = JSON.parse(canonicalJson(fields)) as AgentLifecycleCommand
  for (const key of ['instanceId', 'idempotencyKey'] as const)
    if (typeof command[key] !== 'string' || !command[key].trim() || command[key] !== command[key].trim())
      throw new Error(`Invalid lifecycle ${key}.`)
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)
    throw new Error('Invalid lifecycle expected revision.')
  if (!command.actor || typeof command.actor !== 'object' || Array.isArray(command.actor))
    throw new Error('Invalid lifecycle actor.')
  for (const key of ['kind', 'id'] as const)
    if (typeof command.actor[key] !== 'string' || !command.actor[key].trim() || command.actor[key] !== command.actor[key].trim())
      throw new Error('Invalid lifecycle actor.')
  if (command.actor.displayName !== undefined && (typeof command.actor.displayName !== 'string' || !command.actor.displayName.trim()))
    throw new Error('Invalid lifecycle actor displayName.')
  if (command.grantId !== undefined && (typeof command.grantId !== 'string' || !command.grantId.trim() || command.grantId !== command.grantId.trim()))
    throw new Error('Invalid lifecycle grant id.')
  if (command.expectedGrantUseCount !== undefined && (!Number.isSafeInteger(command.expectedGrantUseCount) || command.expectedGrantUseCount < 0))
    throw new Error('Invalid lifecycle grant use count.')
  return freezeJson(command)
}

const noopReceiptKey = (command: AgentLifecycleCommand): string =>
  `agent-instance:lifecycle-noop:${sha256PolicyText(canonicalJson([command.instanceId, command.action, command.idempotencyKey]))}`

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

/** @internal Shared validation for inert managed-birth plans; not admission authority. */
export const assertNewAgentInstance = assertInstance

/** @internal Shared event/mutation recipe; callers must validate and capture input first. */
export const prepareAgentInstanceCreate = (
  input: CreateAgentInstanceInput, reservedParentId?: string,
  captured?: Readonly<{ storedKey: string; stateDigest: string }>
): ResourceMutationInput => ({
  operation: 'create', kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND, id: input.instance.id,
  state: input.instance, createdAt: input.createdAt,
  idempotencyKey: captured?.storedKey ?? `agent-instance:${input.instance.id}:create:${input.idempotencyKey}`,
  event: event(input.instance.id, 'agent-instance.created', input.createdAt, 0, {
    status: 'created', ...(reservedParentId === undefined ? {} : { parentInstanceId: reservedParentId }),
    stateDigest: captured?.stateDigest ?? sha256PolicyText(canonicalPolicyJson(input.instance as never))
  })
})

/** @internal Data only; parent CAS does not establish tree capacity or policy approval. */
export const prepareAgentChildReservation = (
  parent: StoredResource<MagicAgentInstanceState>, childId: string, createdAt: number, idempotencyKey: string
): ResourceMutationInput => ({
  operation: 'update', kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND, id: parent.id,
  expectedRevision: parent.revision, state: parent.state, createdAt,
  idempotencyKey: `agent-instance:${parent.id}:reserve-child:${idempotencyKey}`,
  event: event(parent.id, 'agent-instance.child-reserved', createdAt, parent.revision + 1, { childId })
})

/** @internal Exact default status-transition recipe, no execution permission. */
export const prepareAgentInstanceTransition = (
  current: StoredResource<MagicAgentInstanceState>, status: MagicAgentInstanceStatus,
  transitionedAt: number, idempotencyKey: string,
  captured?: Readonly<{ storedKey: string; instanceId: string; expectedRevision: number }>
): ResourceMutationInput => ({
  operation: 'update', kind: MAGIC_AGENT_INSTANCE_RESOURCE_KIND, id: captured?.instanceId ?? current.id,
  expectedRevision: captured?.expectedRevision ?? current.revision, state: { ...current.state, status }, createdAt: transitionedAt,
  idempotencyKey: captured?.storedKey ?? `agent-instance:${current.id}:transition:${idempotencyKey}`,
  event: event(captured?.instanceId ?? current.id, 'agent-instance.status-transitioned', transitionedAt, (captured?.expectedRevision ?? current.revision) + 1,
    { fromStatus: current.state.status, status })
})

export class PersistentAgentInstanceStore {
  constructor(private readonly eventStore: MagicAgentEventStore) {}

  /** Conservative durable classification, not managed schema validation or a lease. */
  hasManagedIdentity(instanceId: string): boolean {
    return hasManagedAgentInstanceEvidence(this.eventStore, instanceId)
  }

  assertOrdinaryIdentity(instanceId: string): void {
    if (this.hasManagedIdentity(instanceId)) throw new ManagedAgentOrdinaryAdmissionError()
  }

  private ordinaryResult<T extends StoredResource<MagicAgentInstanceState>>(row: T): T {
    this.assertOrdinaryIdentity(row.id)
    this.assertOrdinaryIdentity(row.state.id)
    if (row.state.parentInstanceId !== undefined) this.assertOrdinaryIdentity(row.state.parentInstanceId)
    return row
  }

  private mutateOrdinaryResource<T = MagicAgentInstanceState>(input: ResourceMutationInput, replacement?: AgentInstanceReplacementCommitFence) {
    const fence = new AgentInstanceOrdinaryCommitFence(this.eventStore, [input], replacement)
    assertAgentInstanceMutationCommitFence(fence, this.eventStore, [input])
    const result = this.eventStore.mutateResource<T>(input, fence)
    assertAgentInstanceOrdinaryMutationResult(fence, this.eventStore, [input])
    return result
  }

  private mutateOrdinaryBatch(inputs: readonly ResourceMutationInput[]) {
    const fence = new AgentInstanceOrdinaryCommitFence(this.eventStore, inputs)
    assertAgentInstanceMutationCommitFence(fence, this.eventStore, inputs)
    const result = this.eventStore.mutateResourcesBatch(inputs, fence)
    assertAgentInstanceOrdinaryMutationResult(fence, this.eventStore, inputs)
    return result
  }

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
    this.assertOrdinaryIdentity(input.parentInstanceId)
    this.assertOrdinaryIdentity(input.child.id)
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
    this.assertOrdinaryIdentity(input.parentInstanceId)
    return this.ordinaryResult(child)
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
    this.assertOrdinaryIdentity(input.parentInstanceId)
    this.assertOrdinaryIdentity(input.child.id)
    if (input.child.parentInstanceId !== input.parentInstanceId)
      throw new Error('Child Agent parent identity mismatch.')
    const parent = this.get(input.parentInstanceId)
    if (!parent) throw new Error('Parent Agent instance not found.')
    if (parent.revision !== input.parentExpectedRevision)
      throw new Error('Parent Agent instance revision conflict.')
    if (this.get(input.child.id)) throw new Error('Agent instance already exists.')
    const results = this.mutateOrdinaryBatch([
      prepareAgentChildReservation(parent, input.child.id, input.createdAt, input.idempotencyKey),
      prepareAgentInstanceCreate({ instance: input.child, createdAt: input.createdAt, idempotencyKey: input.idempotencyKey }, parent.id)
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
    this.assertOrdinaryIdentity(input.instance.id)
    if (input.instance.parentInstanceId !== undefined) this.assertOrdinaryIdentity(input.instance.parentInstanceId)
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
    return this.ordinaryResult(replay.resource as StoredResource<MagicAgentInstanceState>)
  }

  create(input: CreateAgentInstanceInput): StoredResource<MagicAgentInstanceState> {
    assertInstance(input.instance)
    if (!Number.isFinite(input.createdAt) || input.createdAt < 0 || !input.idempotencyKey.trim())
      throw new Error('Invalid Agent instance create command.')
    const digest = sha256PolicyText(canonicalPolicyJson(input.instance as never))
    const storedKey = `agent-instance:${input.instance.id}:create:${input.idempotencyKey}`
    this.assertOrdinaryIdentity(input.instance.id)
    if (input.instance.parentInstanceId !== undefined) this.assertOrdinaryIdentity(input.instance.parentInstanceId)
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
      return this.ordinaryResult(replay.resource as StoredResource<MagicAgentInstanceState>)
    }
    if (this.get(input.instance.id)) throw new Error('Agent instance already exists.')
    return this.mutateOrdinaryResource<MagicAgentInstanceState>(
      prepareAgentInstanceCreate(input, undefined, { storedKey, stateDigest: digest })
    ).resource
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
    this.assertOrdinaryIdentity(input.id)
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
    this.assertOrdinaryIdentity(input.id)
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
    this.assertOrdinaryIdentity(id)
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
      return this.ordinaryResult(replay.resource as StoredResource<MagicAgentInstanceState>)
    }
    const current = this.get(id)
    if (!current) throw new Error('Agent instance not found.')
    if (current.revision !== expectedRevision) throw new Error('Agent instance revision conflict.')
    return this.mutateOrdinaryResource<MagicAgentInstanceState>({
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

  getLifecycleNoopReplay(input: AgentLifecycleCommand): StoredResource<MagicAgentInstanceState> | undefined {
    const command = captureAgentLifecycleCommand(input.action, input)
    this.assertOrdinaryIdentity(command.instanceId)
    const key = noopReceiptKey(command)
    const receipt = this.eventStore.getEvent(`${key}:completed`)
    if (!receipt) return undefined
    const payload = receipt.payload as { commandDigest?: string; resultDigest?: string; result?: StoredResource<MagicAgentInstanceState> }
    if (payload?.commandDigest !== sha256PolicyText(canonicalJson(command)))
      throw new Error('Agent lifecycle no-op idempotency conflict.')
    const result = payload.result
    if (
      receipt.type !== 'agent-instance.lifecycle-noop-completed' || receipt.envelopeKind !== 'event' ||
      receipt.streamId !== `${key}:stream` || receipt.sequence !== 0 ||
      receipt.extensions?.lifecycleNoopKey !== key || receipt.extensions?.instanceId !== command.instanceId ||
      !result || result.kind !== MAGIC_AGENT_INSTANCE_RESOURCE_KIND || result.id !== command.instanceId || result.deleted !== false ||
      !Number.isSafeInteger(result.revision) || result.revision < command.expectedRevision ||
      !Number.isFinite(result.createdAt) || !Number.isFinite(result.updatedAt) || result.createdAt < 0 || result.updatedAt < result.createdAt || receipt.createdAt < result.updatedAt ||
      result.state?.id !== command.instanceId || result.state.status !== (command.action === 'pause' ? 'paused' : 'running') ||
      payload.resultDigest !== sha256PolicyText(canonicalJson(result))
    ) throw new Error('Invalid Agent lifecycle no-op receipt.')
    assertInstance({ ...result.state, status: 'created' })
    const detached = freezeJson(JSON.parse(canonicalJson(result)) as StoredResource<MagicAgentInstanceState>)
    return this.ordinaryResult(detached)
  }

  recordLifecycleNoopCompletion(input: {
    command: AgentLifecycleCommand
    result: StoredResource<MagicAgentInstanceState>
    completedAt: number
  }): StoredResource<MagicAgentInstanceState> {
    const command = captureAgentLifecycleCommand(input.command.action, input.command)
    const replay = this.getLifecycleNoopReplay(command)
    if (replay) return replay
    const current = this.get(command.instanceId)
    if (!current || canonicalJson(current) !== canonicalJson(input.result) || current.deleted ||
      current.state.status !== (command.action === 'pause' ? 'paused' : 'running') || current.revision < command.expectedRevision ||
      !Number.isFinite(input.completedAt) || input.completedAt < current.updatedAt)
      throw new Error('Invalid Agent lifecycle no-op completion.')
    const key = noopReceiptKey(command)
    const events = [{
      protocolVersion: '2.0.0', id: `${key}:completed`, type: 'agent-instance.lifecycle-noop-completed',
      createdAt: input.completedAt, envelopeKind: 'event' as const, streamId: `${key}:stream`, sequence: 0,
      extensions: { lifecycleNoopKey: key, instanceId: current.id },
      payload: { commandDigest: sha256PolicyText(canonicalJson(command)), resultDigest: sha256PolicyText(canonicalJson(current)), result: current }
    }]
    const fence = new AgentInstanceOrdinaryEventCommitFence(this.eventStore, events, command.instanceId)
    assertAgentInstanceOrdinaryEventCommitFence(fence, this.eventStore, events)
    this.eventStore.appendBatch(events, fence)
    assertAgentInstanceOrdinaryEventCommitFence(fence, this.eventStore, events)
    return this.ordinaryResult(current)
  }

  getTransitionReplay(
    instanceId: string,
    status: MagicAgentInstanceStatus,
    idempotencyKey: string
  ): StoredResource<MagicAgentInstanceState> | undefined {
    const storedKey = `agent-instance:${instanceId}:transition:${idempotencyKey}`
    this.assertOrdinaryIdentity(instanceId)
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, instanceId, 1_000)
      .find((item) => item.idempotencyKey === storedKey)
    if (!replay) return undefined
    const committed = this.eventStore.getEvent(replay.eventId)
    const payload = committed?.payload as { status?: string } | undefined
    if (committed?.type !== 'agent-instance.status-transitioned' || payload?.status !== status)
      throw new Error('Agent instance transition idempotency conflict.')
    return this.ordinaryResult(replay.resource as StoredResource<MagicAgentInstanceState>)
  }

  getReplaceReplay(instanceId: string, idempotencyKey: string) {
    const key = `agent-instance:${instanceId}:replace:${idempotencyKey}`
    this.assertOrdinaryIdentity(instanceId)
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, instanceId, 1_000)
      .find((item) => item.idempotencyKey === key)
    this.assertOrdinaryIdentity(instanceId)
    if (replay) this.ordinaryResult(replay.resource as StoredResource<MagicAgentInstanceState>)
    return replay
  }

  replace(input: {
    instanceId: string
    expectedRevision: number
    definitionId: string
    name: string
    configVersion: string
    replacedAt: number
    idempotencyKey: string
  }, fence?: AgentInstanceReplacementCommitFence) {
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
      return this.ordinaryResult(replay.resource as StoredResource<MagicAgentInstanceState>)
    }
    const current = this.get(input.instanceId)
    if (!current) throw new Error('Agent instance not found.')
    if (current.revision !== input.expectedRevision)
      throw new Error('Agent instance revision conflict.')
    if (current.state.status === 'running' || current.state.status === 'removed')
      throw new Error('Agent instance must be quiescent before replacement.')
    const mutation = {
      operation: 'update' as const,
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
    }
    // Check after all store reads/materialization, then pass the same concrete
    // predicate into the synchronous SQLite transaction. No callback API.
    if (fence) assertAgentInstanceReplacementCommitFence(fence, mutation)
    return this.mutateOrdinaryResource<MagicAgentInstanceState>(mutation, fence).resource
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
    this.assertOrdinaryIdentity(input.instanceId)
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
      return this.ordinaryResult(replay.resource as StoredResource<MagicAgentInstanceState>)
    }
    const current = this.get(input.instanceId)
    if (!current) throw new Error('Agent instance not found.')
    if (current.revision !== input.expectedRevision)
      throw new Error('Agent instance revision conflict.')
    if (!transitions[current.state.status].includes(input.status))
      throw new Error(
        `Invalid Agent instance transition: ${current.state.status} -> ${input.status}.`
      )
    return this.mutateOrdinaryResource<MagicAgentInstanceState>(
      prepareAgentInstanceTransition(current, input.status, input.transitionedAt, input.idempotencyKey,
        { storedKey, instanceId: input.instanceId, expectedRevision: input.expectedRevision })
    ).resource
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
