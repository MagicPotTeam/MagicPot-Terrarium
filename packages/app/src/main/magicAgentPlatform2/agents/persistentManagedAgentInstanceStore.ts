import { randomUUID } from 'node:crypto'
import type { MagicAgentInstanceState } from '../../../shared/magicAgentPlatform2/agentInstance'
import { sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import { canonicalJson, type MagicAgentEventStore, type ResourceMutationInput, type StoredResource } from '../persistence/eventStore'
import { assertNewAgentInstance, MAGIC_AGENT_INSTANCE_RESOURCE_KIND, prepareAgentChildReservation, prepareAgentInstanceCreate, prepareAgentInstanceTransition } from './persistentAgentInstanceStore'
import { PersistentManagedAgentExecutionStore, type ManagedExecutionAttempt, type ManagedExecutionIdentity, type ManagedBoundedAcceptance } from './persistentManagedAgentExecutionStore'
import { type ManagedFirstRunOwnerState, type ManagedFirstRunOperation } from './managedFirstRunCommitFence'
import { MANAGED_AGENT_COVERAGE_KIND, managedAgentCoverageId } from './managedAgentInstanceIdentity'
export { MANAGED_AGENT_COVERAGE_KIND } from './managedAgentInstanceIdentity'

export type ManagedAgentBirthInput = Readonly<{
  instance: MagicAgentInstanceState
  createdAt: number
  idempotencyKey: string
}>
export type ManagedAgentChildInput = ManagedAgentBirthInput & Readonly<{
  parentInstanceId: string
  parentExpectedRevision: number
}>
export type ManagedAgentFirstStartInput = Readonly<{
  instanceId: string
  expectedRevision: number
  expectedCoverageRevision: number
  authorizedRequestDigest: string
  sessionKey: string
  startedAt: number
  idempotencyKey: string
  acceptance?: ManagedBoundedAcceptance
}>
export type ManagedAgentCoverage = Readonly<{
  protocolVersion: 1
  instanceId: string
  generation: string
  definitionId: string
  configVersion: string
  birthStateDigest: string
  birth: Readonly<{ commandKey: string; inputDigest: string; createdAt: number; parentInstanceId?: string; parentExpectedRevision?: number }>
  status: 'virgin' | 'dirty'
  accepted?: Readonly<{ identity: ManagedExecutionIdentity; commandKey: string; inputDigest: string; startedAt: number; acceptance?: ManagedBoundedAcceptance }>
}>
export type ManagedAgentBirthResult = Readonly<{
  inserted: boolean
  instance: StoredResource<MagicAgentInstanceState>
  coverage: StoredResource<ManagedAgentCoverage>
}>
export type ManagedAgentStartResult = ManagedAgentBirthResult & Readonly<{ attempt: StoredResource<ManagedExecutionAttempt> }>

type Inspection = Omit<ManagedAgentBirthResult, 'inserted'> & { attempt?: StoredResource<ManagedExecutionAttempt>; parent?: StoredResource<MagicAgentInstanceState> }
function invalid(detail: string): never { throw new Error(`Invalid managed instance evidence: ${detail}.`) }
const text = (value: unknown): void => { if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0') || value.length > 4096) invalid('trimmed identity') }
const integer = (value: unknown): void => { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('revision') }
const time = (value: unknown): void => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid('time') }
const hex = (value: unknown): void => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid('digest') }
const commandIdentity = (value: unknown): void => { if (typeof value !== 'string' || !/^managed-instance-command:[a-f0-9]{64}$/.test(value)) invalid('command identity') }
const digest = (value: unknown): string => sha256PolicyText(canonicalJson(value))
const same = (a: unknown, b: unknown): boolean => a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b)
const coverageId = managedAgentCoverageId
const commandKey = (id: string, operation: string, key: string): string => `managed-instance-command:${digest([id, operation, key])}`
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
// EventStore canonicalizer inspects own descriptors and rejects proxies/accessors/
// executable values without invoking them. This new persistence API is strict JSON,
// not the lifecycle approval canonicalizer's optional-own-undefined contract.
const capture = <T>(value: T): T => freeze(JSON.parse(canonicalJson(value))) as T
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid('record fields')
}
const createKey = (id: string, command: string): string => `agent-instance:${id}:create:${command}`
const parentKey = (id: string, command: string): string => `agent-instance:${id}:reserve-child:${command}`

/**
 * Same-EventStore birth/start recording only, deliberately unused by production.
 * Virgin is birth evidence, not clean or restart permission. First start requires
 * the exact unmodified created/revision-0 instance; default lifecycle mutations
 * invalidate that eligibility. Replays return current records and inserted:false,
 * never a runnable capability. No policy/provider/runtime/tool is constructed.
 */
export class PersistentManagedAgentInstanceStore {
  private readonly ledger: PersistentManagedAgentExecutionStore
  constructor(private readonly events: MagicAgentEventStore) { this.ledger = new PersistentManagedAgentExecutionStore(events) }

  createRoot(input: ManagedAgentBirthInput, owner?: ManagedFirstRunOwnerState): ManagedAgentBirthResult {
    input = capture(input)
    fields(input, ['instance', 'createdAt', 'idempotencyKey']); this.validateBirth(input)
    if (input.instance.parentInstanceId !== undefined || input.instance.depth !== 0) invalid('root birth parent/depth')
    return this.create(input, owner)
  }

  reserveChild(input: ManagedAgentChildInput): ManagedAgentBirthResult & Readonly<{ parent: StoredResource<MagicAgentInstanceState> }> {
    input = capture(input)
    fields(input, ['instance', 'createdAt', 'idempotencyKey', 'parentInstanceId', 'parentExpectedRevision']); this.validateBirth(input)
    text(input.parentInstanceId); integer(input.parentExpectedRevision)
    if (input.instance.parentInstanceId !== input.parentInstanceId) invalid('child parent identity')
    const result = this.create(input)
    return { ...result, parent: this.requireInstance(input.parentInstanceId) }
  }

  private validateBirth(input: ManagedAgentBirthInput): void {
    text(input.idempotencyKey); time(input.createdAt); assertNewAgentInstance(input.instance)
  }

  private create(input: ManagedAgentBirthInput | ManagedAgentChildInput, owner?: ManagedFirstRunOwnerState): ManagedAgentBirthResult {
    const child = 'parentInstanceId' in input, id = input.instance.id
    const command = commandKey(id, child ? 'child' : 'root', input.idempotencyKey)
    if (this.hasOperation(command)) {
      if (owner) invalid('production owner never adopts birth replay')
      const saved = this.inspect(id)
      if (!saved || saved.coverage.state.birth.commandKey !== command || saved.coverage.state.birth.inputDigest !== digest(input)) invalid('birth command replay conflict')
      return { inserted: false, instance: saved.instance, coverage: saved.coverage }
    }
    // Include tombstones. A legacy-created/stopped instance is never adopted.
    if (this.events.getResource(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, id, { includeDeleted: true }) || this.events.getResource(MANAGED_AGENT_COVERAGE_KIND, coverageId(id), { includeDeleted: true })) invalid('birth already exists or coverage missing')
    const parent = child ? this.requireInstance(input.parentInstanceId) : undefined
    if (child && (parent!.revision !== input.parentExpectedRevision || parent!.state.status === 'removed' || input.instance.depth !== parent!.state.depth + 1)) invalid('parent revision/depth conflict')
    const state: ManagedAgentCoverage = {
      protocolVersion: 1, instanceId: id, generation: randomUUID(), definitionId: input.instance.definitionId,
      configVersion: input.instance.configVersion, birthStateDigest: digest(input.instance), status: 'virgin',
      birth: { commandKey: command, inputDigest: digest(input), createdAt: input.createdAt,
        ...(child ? { parentInstanceId: input.parentInstanceId, parentExpectedRevision: input.parentExpectedRevision } : {}) }
    }
    const birthInput = { instance: input.instance, createdAt: input.createdAt, idempotencyKey: command }
    const plans = [
      ...(parent ? [prepareAgentChildReservation(parent, id, input.createdAt, command)] : []),
      prepareAgentInstanceCreate(birthInput, parent?.id), this.coverageMutation(state, command, digest(input), input.createdAt)
    ]
    const results = this.commit(plans, 'birth', owner)
    const saved = this.inspect(id)
    if (!saved) invalid('committed birth publication missing')
    owner?.complete('birth')
    return { inserted: results.every(row => row.inserted), instance: saved.instance, coverage: saved.coverage }
  }

  startFirstAttempt(input: ManagedAgentFirstStartInput, owner?: ManagedFirstRunOwnerState): ManagedAgentStartResult {
    input = capture(input)
    fields(input, ['instanceId', 'expectedRevision', 'expectedCoverageRevision', 'authorizedRequestDigest', 'sessionKey', 'startedAt', 'idempotencyKey'], ['acceptance'])
    text(input.instanceId); text(input.idempotencyKey); text(input.sessionKey); hex(input.authorizedRequestDigest)
    integer(input.expectedRevision); integer(input.expectedCoverageRevision); time(input.startedAt)
    const command = commandKey(input.instanceId, 'start', input.idempotencyKey)
    const replay = this.hasOperation(command), saved = this.inspect(input.instanceId)
    if (!saved) invalid('missing birth coverage')
    if (replay) {
      if (owner) invalid('production owner never adopts acceptance replay')
      if (!saved.attempt || saved.coverage.state.accepted?.commandKey !== command || saved.coverage.state.accepted.inputDigest !== digest(input)) invalid('start command replay conflict')
      return { inserted: false, instance: saved.instance, coverage: saved.coverage, attempt: saved.attempt }
    }
    const { instance, coverage } = saved
    if (input.expectedRevision !== 0 || input.expectedCoverageRevision !== 0 || instance.revision !== 0 || instance.state.status !== 'created' || coverage.revision !== 0 || coverage.state.status !== 'virgin' || digest(instance.state) !== coverage.state.birthStateDigest) invalid('first-start requires exact unmodified virgin birth revision')
    const identity: ManagedExecutionIdentity = {
      instanceId: instance.id, generation: coverage.state.generation, attemptId: randomUUID(), acceptedInstanceRevision: instance.revision + 1,
      definitionId: instance.state.definitionId, configVersion: instance.state.configVersion,
      authorizedRequestDigest: input.authorizedRequestDigest, sessionKey: input.sessionKey
    }
    const state: ManagedAgentCoverage = { ...coverage.state, status: 'dirty', accepted: { identity, commandKey: command, inputDigest: digest(input), startedAt: input.startedAt, ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }) } }
    const results = this.commit([
      prepareAgentInstanceTransition(instance, 'running', input.startedAt, command),
      this.coverageMutation(state, command, digest(input), input.startedAt, coverage.revision),
      this.ledger.prepareBeginAttempt({ identity, recordedAt: input.startedAt, ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }) })
    ], 'start', owner)
    const published = this.inspect(instance.id)
    if (!published?.attempt) invalid('committed first-start publication missing')
    owner?.complete('start')
    return { inserted: results.every(row => row.inserted), instance: published.instance, coverage: published.coverage, attempt: published.attempt }
  }

  retireUnusedVirgin(instanceId: string, at: number, owner: ManagedFirstRunOwnerState): void {
    const saved = this.inspect(instanceId)
    if (!saved || saved.instance.revision !== 0 || saved.instance.state.status !== 'created' || saved.coverage.revision !== 0 || saved.coverage.state.status !== 'virgin' || saved.attempt) invalid('unused virgin retirement')
    this.commit([prepareAgentInstanceTransition(saved.instance, 'removed', at, `managed-unused:${owner.runId}`)], 'retirement', owner)
    const current = this.inspect(instanceId)
    if (!current || current.instance.state.status !== 'removed' || current.instance.revision !== 1 || !same(current.coverage, saved.coverage)) invalid('virgin retirement publication')
    owner.complete('retirement')
  }

  publishBoundedTerminal(identity: ManagedExecutionIdentity, at: number, owner: ManagedFirstRunOwnerState): void {
    const saved = this.inspect(identity.instanceId), proof = owner.terminal
    if (!saved || !saved.attempt?.state.acceptance || saved.attempt.state.status !== 'open' || saved.instance.revision !== identity.acceptedInstanceRevision || saved.instance.state.status !== 'running' || !same(saved.attempt.state.identity, identity)) invalid('bounded terminal acceptance')
    const instance = prepareAgentInstanceTransition(saved.instance, 'stopped', at, `managed-bounded-terminal:${owner.runId}`)
    const attempt = this.ledger.prepareBoundedTerminal(identity, instance, proof.witness, proof.status as 'completed' | 'cancelled' | 'failed')
    const terminal = (attempt.state as ManagedExecutionAttempt).terminal!
    const paired = { ...instance, event: { ...instance.event, payload: { ...instance.event.payload as Record<string, unknown>, boundedOutcome: terminal } } }
    this.commit([paired, attempt], 'terminal', owner)
    const published = this.inspect(identity.instanceId)
    if (!published || published.instance.state.status !== 'stopped' || published.attempt?.state.status !== 'bounded-closed' || !same(saved.coverage, published.coverage)) invalid('bounded terminal pair publication')
    owner.complete('terminal')
  }

  private commit(inputs: readonly ResourceMutationInput[], operation: ManagedFirstRunOperation, owner?: ManagedFirstRunOwnerState) {
    if (!owner) return this.events.mutateResourcesBatch(inputs)
    const detached = capture(inputs), fence = owner.reserve(operation, detached)
    const outcome = this.events.mutateManagedResourcesBatch(detached, fence)
    owner.observe(fence, outcome, detached)
    if (outcome.kind === 'rolled-back') throw outcome.cause
    if (!outcome.results.every(result => result.inserted)) invalid('production commit requires fresh positive insertion')
    return outcome.results
  }

  getCoverage(instanceId: string): StoredResource<ManagedAgentCoverage> | undefined {
    text(instanceId)
    return this.inspect(instanceId)?.coverage
  }

  private hasOperation(command: string): boolean {
    const receipt = this.events.getResourceMutation(`${command}:coverage`), event = this.events.getEvent(`${command}:coverage:event`)
    if (Boolean(receipt) !== Boolean(event)) invalid('partial operation receipt')
    return !!receipt
  }

  private requireInstance(id: string): StoredResource<MagicAgentInstanceState> {
    const result = this.events.getResource<MagicAgentInstanceState>(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, id, { includeDeleted: true })
    if (!result || result.deleted || result.state.id !== id) invalid('missing or deleted instance identity')
    return result
  }

  private coverageMutation(state: ManagedAgentCoverage, command: string, inputDigest: string, at: number, revision?: number): ResourceMutationInput {
    const id = coverageId(state.instanceId)
    return {
      operation: revision === undefined ? 'create' : 'update', kind: MANAGED_AGENT_COVERAGE_KIND, id, state,
      ...(revision === undefined ? {} : { expectedRevision: revision }), idempotencyKey: `${command}:coverage`, createdAt: at,
      event: { protocolVersion: '2.0.0', id: `${command}:coverage:event`, type: 'managed-instance.coverage-recorded',
        envelopeKind: 'event', streamId: `${MANAGED_AGENT_COVERAGE_KIND}:${id}:stream`, sequence: revision === undefined ? 0 : revision + 1,
        createdAt: at, payload: { commandDigest: inputDigest, coverageDigest: digest(state) } }
    }
  }

  /** Verify the exact historical mutation + event using EventStore full-chain validation. */
  private receipt(plan: ResourceMutationInput): StoredResource {
    const row = this.events.getResourceMutation(plan.idempotencyKey), event = this.events.getEvent(plan.event.id)
    if (!row || !event || row.idempotencyKey !== plan.idempotencyKey || row.operation !== plan.operation || row.eventId !== plan.event.id || row.expectedRevision !== plan.expectedRevision || row.createdAt !== plan.createdAt || !same(event, plan.event)) invalid('missing or conflicting paired receipt')
    const resource = row.resource
    if (resource.kind !== plan.kind || resource.id !== plan.id || resource.deleted || resource.revision !== (plan.expectedRevision === undefined ? 0 : plan.expectedRevision + 1) || resource.updatedAt !== plan.createdAt || !same(resource.state, plan.state)) invalid('paired resource evidence conflict')
    return resource
  }

  private inspect(instanceId: string): Inspection | undefined {
    const row = this.events.getResource<ManagedAgentCoverage>(MANAGED_AGENT_COVERAGE_KIND, coverageId(instanceId), { includeDeleted: true })
    if (!row) return undefined
    if (row.deleted) invalid('coverage deleted')
    const state = capture(row.state)
    fields(state, ['protocolVersion', 'instanceId', 'generation', 'definitionId', 'configVersion', 'birthStateDigest', 'birth', 'status'], ['accepted'])
    if (state.protocolVersion !== 1 || state.instanceId !== instanceId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(state.generation)) invalid('coverage generation/identity')
    text(state.definitionId); text(state.configVersion); hex(state.birthStateDigest)
    const birth = state.birth
    fields(birth, ['commandKey', 'inputDigest', 'createdAt'], ['parentInstanceId', 'parentExpectedRevision'])
    commandIdentity(birth.commandKey); hex(birth.inputDigest); time(birth.createdAt)
    const child = birth.parentInstanceId !== undefined
    if (child) { text(birth.parentInstanceId); integer(birth.parentExpectedRevision) }
    else if (birth.parentExpectedRevision !== undefined) invalid('root birth parent revision')
    const instanceBirth = this.events.getResourceMutation(createKey(instanceId, birth.commandKey))
    if (!instanceBirth) invalid('missing birth instance receipt')
    const born = instanceBirth.resource as StoredResource<MagicAgentInstanceState>
    assertNewAgentInstance(born.state)
    if (born.kind !== MAGIC_AGENT_INSTANCE_RESOURCE_KIND || born.id !== instanceId || born.state.id !== instanceId || born.revision !== 0 || born.deleted || born.createdAt !== birth.createdAt || digest(born.state) !== state.birthStateDigest || born.state.definitionId !== state.definitionId || born.state.configVersion !== state.configVersion || (child ? born.state.parentInstanceId !== birth.parentInstanceId : born.state.parentInstanceId !== undefined || born.state.depth !== 0)) invalid('birth instance identity/digest conflict')
    this.receipt(prepareAgentInstanceCreate({ instance: born.state, createdAt: birth.createdAt, idempotencyKey: birth.commandKey }, birth.parentInstanceId))
    let parent: StoredResource<MagicAgentInstanceState> | undefined
    if (child) {
      const reservation = this.events.getResourceMutation(parentKey(birth.parentInstanceId!, birth.commandKey))
      if (!reservation || reservation.expectedRevision !== birth.parentExpectedRevision) invalid('missing parent reservation receipt')
      const previousParent = { ...reservation.resource, revision: birth.parentExpectedRevision! } as StoredResource<MagicAgentInstanceState>
      if (previousParent.state.status === 'removed' || born.state.depth !== previousParent.state.depth + 1) invalid('birth parent identity/depth conflict')
      this.receipt(prepareAgentChildReservation(previousParent, instanceId, birth.createdAt, birth.commandKey))
      parent = this.requireInstance(birth.parentInstanceId!)
    }
    const { accepted, ...withoutAccepted } = state
    const initial: ManagedAgentCoverage = { ...withoutAccepted, status: 'virgin' }
    const virgin = this.receipt(this.coverageMutation(initial, birth.commandKey, birth.inputDigest, birth.createdAt))
    if (virgin.createdAt !== row.createdAt || row.createdAt !== birth.createdAt) invalid('coverage birth time conflict')
    const instance = this.requireInstance(instanceId)
    if (instance.createdAt !== birth.createdAt) invalid('current instance birth identity conflict')
    if (state.status === 'virgin') {
      if (accepted !== undefined || row.revision !== 0 || !same(row, virgin)) invalid('virgin coverage revision/evidence conflict')
      return { instance, coverage: row, parent }
    }
    if (state.status !== 'dirty' || row.revision !== 1 || !accepted) invalid('dirty coverage revision/evidence conflict')
    fields(accepted, ['identity', 'commandKey', 'inputDigest', 'startedAt'], ['acceptance'])
    commandIdentity(accepted.commandKey); hex(accepted.inputDigest); time(accepted.startedAt)
    const identity = accepted.identity
    const begin = this.ledger.prepareBeginAttempt({ identity, recordedAt: accepted.startedAt, ...(accepted.acceptance === undefined ? {} : { acceptance: accepted.acceptance }) })
    if (identity.instanceId !== instanceId || identity.generation !== state.generation || identity.definitionId !== state.definitionId || identity.configVersion !== state.configVersion || identity.acceptedInstanceRevision !== 1 || accepted.startedAt < birth.createdAt) invalid('accepted linkage identity conflict')
    this.receipt(prepareAgentInstanceTransition(born, 'running', accepted.startedAt, accepted.commandKey))
    const dirty = this.receipt(this.coverageMutation(state, accepted.commandKey, accepted.inputDigest, accepted.startedAt, 0))
    if (!same(row, dirty)) invalid('dirty current coverage conflict')
    this.receipt(begin)
    const attempt = this.ledger.getAttempt(identity)
    if (!attempt || attempt.createdAt !== accepted.startedAt || instance.revision < identity.acceptedInstanceRevision) invalid('missing accepted attempt evidence')
    return { instance, coverage: row, attempt, parent }
  }
}
