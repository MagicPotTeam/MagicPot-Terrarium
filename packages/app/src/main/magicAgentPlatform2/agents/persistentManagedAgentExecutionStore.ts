import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { readManagedRuntimeIngress } from './managedRuntimeIngress'
import { canonicalJson, type ResourceMutationInput as InstanceTransitionMutation } from '../persistence/eventStore'
import { MAGIC_AGENT_INSTANCE_RESOURCE_KIND } from './persistentAgentInstanceStore'
import { managedAgentCoverageId, MANAGED_AGENT_COVERAGE_KIND } from './managedAgentInstanceIdentity'
import { canonicalPolicyJson } from '../../../shared/magicAgentPlatform2/policy'
import type {
  MagicAgentEventStore,
  ResourceMutationInput,
  StoredResource
} from '../persistence/eventStore'

/** Persistence substrate only: not production-wired, not an admission/clearance API. */
export const MANAGED_EXECUTION_ATTEMPT_KIND = 'managed-agent-execution-attempt'
export const MANAGED_EXECUTION_INTENT_KIND = 'managed-agent-execution-intent'
export type ManagedExecutionIdentity = Readonly<{
  instanceId: string
  generation: string
  attemptId: string
  acceptedInstanceRevision: number
  definitionId: string
  configVersion: string
  authorizedRequestDigest: string
  sessionKey: string
}>
export type ManagedRuntimeBinding =
  | Readonly<{ runtimeRunId: string; effectiveRequestDigest: string }>
  | Readonly<{ bindingVersion: 2; runtimeRunId: string; ingressRecordId: string; executorInputProtocol: 'assistant-executor-input/v1'; executorInputDigest: string }>
export type ManagedIntentIdentity = Readonly<{
  invocationId: string
  runtimeRunId: string
  toolName: string
  argsDigest: string
}>
export type ManagedIntentOutcome = Readonly<{
  kind: 'reported-result' | 'unknown'
  resultDigest: string
  errorCode?: string
}>
export type ManagedBoundedAcceptance = Readonly<{ protocol: 'assistant-final-input/v1'; runId: string; finalInputDigest: string }>
export type ManagedBoundedTerminal = Readonly<{
  witness: 'producer-closure' | 'accepted-never-dispatched'
  status: 'completed' | 'cancelled' | 'failed'
  runId: string
  finalInputDigest: string
  instanceEventId: string
  instanceRevision: number
  closedAt: number
}>
export type ManagedExecutionAttempt = Readonly<{
  protocolVersion: 1
  identity: ManagedExecutionIdentity
  status: 'open' | 'bounded-closed'
  acceptance?: ManagedBoundedAcceptance
  terminal?: ManagedBoundedTerminal
  binding?: ManagedRuntimeBinding
  totalIntents: number
  pendingIntents: number
  unknownIntents: number
  reviewRequired: boolean
}>
export type ManagedExecutionIntent = Readonly<{
  protocolVersion: 1
  identity: ManagedExecutionIdentity
  intent: ManagedIntentIdentity
  status: 'pending' | 'reported-result' | 'unknown'
  outcome?: ManagedIntentOutcome
}>

type BeginInput = { identity: ManagedExecutionIdentity; recordedAt: number; acceptance?: ManagedBoundedAcceptance }
type BindInput = BeginInput & { expectedRevision: number; binding: ManagedRuntimeBinding }
type IntentInput = BeginInput & { expectedRevision: number; intent: ManagedIntentIdentity }
type OutcomeInput = BeginInput & {
  expectedRevision: number
  invocationId: string
  outcome: ManagedIntentOutcome
}
function invalid(detail: string): never {
  throw new Error(`Invalid managed execution evidence: ${detail}.`)
}
const text = (value: unknown, label: string): void => {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0') || value.length > 4_096)
    invalid(label)
}
const integer = (value: unknown, label: string): void => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(label)
}
const time = (value: unknown): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid('recordedAt time')
}
const hexDigest = (value: unknown): void => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid('digest')
}
const uuid = (value: unknown): void => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    invalid('generation/attempt UUID identity')
}

/** Capture without invoking caller accessors, toJSON, proxies, or coercion. */
function data(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return value
  if (depth > 8 || !value || typeof value !== 'object' || utilTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('plain data object')
  const result: Record<string, unknown> = Object.create(null)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length > 24) invalid('data field count')
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) invalid('data field')
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !('value' in descriptor)) invalid('data fields must not execute accessors')
    if (descriptor.value !== undefined) result[key] = data(descriptor.value, depth + 1)
  }
  return Object.freeze(result)
}
const record = (value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('plain record')
  const result = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(result, key)) ||
      Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))) invalid('record fields')
  return result
}
const identityOf = (value: unknown): ManagedExecutionIdentity => {
  const row = record(value, ['instanceId', 'generation', 'attemptId', 'acceptedInstanceRevision', 'definitionId', 'configVersion', 'authorizedRequestDigest', 'sessionKey'])
  for (const key of ['instanceId', 'definitionId', 'configVersion', 'sessionKey']) text(row[key], 'identity')
  uuid(row.generation); uuid(row.attemptId); integer(row.acceptedInstanceRevision, 'instance revision')
  hexDigest(row.authorizedRequestDigest)
  return row as ManagedExecutionIdentity
}
const bindingOf = (value: unknown): ManagedRuntimeBinding => {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'bindingVersion')) {
    const row = record(value, ['bindingVersion', 'runtimeRunId', 'ingressRecordId', 'executorInputProtocol', 'executorInputDigest'])
    if (row.bindingVersion !== 2 || row.executorInputProtocol !== 'assistant-executor-input/v1') invalid('executor binding version/protocol')
    text(row.runtimeRunId, 'runtime binding'); text(row.ingressRecordId, 'runtime ingress identity'); hexDigest(row.executorInputDigest)
    return row as ManagedRuntimeBinding
  }
  const row = record(value, ['runtimeRunId', 'effectiveRequestDigest'])
  text(row.runtimeRunId, 'runtime binding'); hexDigest(row.effectiveRequestDigest)
  return row as ManagedRuntimeBinding
}
const intentOf = (value: unknown): ManagedIntentIdentity => {
  const row = record(value, ['invocationId', 'runtimeRunId', 'toolName', 'argsDigest'])
  for (const key of ['invocationId', 'runtimeRunId', 'toolName']) text(row[key], 'intent identity')
  hexDigest(row.argsDigest)
  return row as ManagedIntentIdentity
}
const outcomeOf = (value: unknown): ManagedIntentOutcome => {
  const row = record(value, ['kind', 'resultDigest'], ['errorCode'])
  if (row.kind !== 'reported-result' && row.kind !== 'unknown') invalid('intent outcome')
  hexDigest(row.resultDigest)
  if (row.errorCode !== undefined) text(row.errorCode, 'error code')
  // Even an otherwise-successful receipt cannot erase the MAIN unknown marker.
  return Object.freeze({ ...row, kind: row.errorCode === 'TOOL_EXECUTION_OUTCOME_UNKNOWN' ? 'unknown' : row.kind }) as ManagedIntentOutcome
}
// Only already-captured JSON-safe data reaches canonicalPolicyJson.
const canonical = (value: unknown): string => canonicalPolicyJson(value as never)
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)
const attemptKey = (identity: ManagedExecutionIdentity): string =>
  `managed-attempt:${digest([identity.instanceId, identity.generation, identity.attemptId])}`
const intentKey = (identity: ManagedExecutionIdentity, invocationId: string): string =>
  `managed-intent:${digest([attemptKey(identity), invocationId])}`

/**
 * Same-Event-Store fail-closed latch: publish uncertainty in memory BEFORE the
 * transaction can fail or re-enter. A failed unknown write preserves whichever
 * durable state committed (pending before COMMIT, possibly unknown after COMMIT),
 * never clean. Reopen loses this latch but cannot mint a terminal result or clean
 * attempt; recovery/clearance is deliberately not this API.
 */
const observedUnknown = new WeakMap<MagicAgentEventStore, Set<string>>()
const unknownsFor = (events: MagicAgentEventStore): Set<string> => {
  let values = observedUnknown.get(events)
  if (!values) { values = new Set(); observedUnknown.set(events, values) }
  return values
}

const acceptanceOf = (value: unknown): ManagedBoundedAcceptance => {
  const acceptance = record(value, ['protocol', 'runId', 'finalInputDigest'])
  if (acceptance.protocol !== 'assistant-final-input/v1') invalid('bounded acceptance protocol')
  text(acceptance.runId, 'bounded run identity'); hexDigest(acceptance.finalInputDigest)
  return acceptance as ManagedBoundedAcceptance
}

/**
 * Trusted MAIN persistence, not an execution capability or restart certificate.
 * No clean/clear/reconciliation method exists. A reported result only records a
 * returned receipt; it does not certify hidden effects, full-tail completion, or
 * instance coverage. Nothing imports this into production admission yet.
 */
export class PersistentManagedAgentExecutionStore {
  constructor(private readonly events: MagicAgentEventStore) {}

  /** @internal Inert captured begin plan; no store callout, commit, or execution authority. */
  prepareBeginAttempt(input: BeginInput): ResourceMutationInput {
    input = data(input) as BeginInput
    record(input, ['identity', 'recordedAt'], ['acceptance']); identityOf(input.identity); time(input.recordedAt)
    if (input.acceptance !== undefined) acceptanceOf(input.acceptance)
    const state: ManagedExecutionAttempt = {
      protocolVersion: 1, identity: input.identity, status: 'open',
      ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
      totalIntents: 0, pendingIntents: 0, unknownIntents: 0, reviewRequired: false
    }
    return data(this.mutation(MANAGED_EXECUTION_ATTEMPT_KIND, attemptKey(input.identity), state,
      undefined, input.recordedAt, this.commandKey(input.identity, 'begin'), input, 'attempt')) as ResourceMutationInput
  }

  beginAttempt(input: BeginInput): StoredResource<ManagedExecutionAttempt> {
    input = data(input) as BeginInput
    const mutation = this.prepareBeginAttempt(input)
    const command = this.commandKey(input.identity, 'begin')
    if (this.replayed(command, input)) return this.requireAttempt(input.identity)
    if (this.getAttempt(input.identity)) invalid('attempt begin identity conflict or missing receipt')
    this.events.mutateResourcesBatch([mutation])
    return this.requireAttempt(input.identity)
  }

  getAttempt(identity: ManagedExecutionIdentity): StoredResource<ManagedExecutionAttempt> | undefined {
    identity = identityOf(data(identity))
    const row = this.events.getResource<ManagedExecutionAttempt>(MANAGED_EXECUTION_ATTEMPT_KIND, attemptKey(identity), { includeDeleted: true })
    if (!row) return undefined
    if (row.deleted) invalid('attempt deleted')
    const state = record(data(row.state), ['protocolVersion', 'identity', 'status', 'totalIntents', 'pendingIntents', 'unknownIntents', 'reviewRequired'], ['binding', 'acceptance', 'terminal'])
    if (state.protocolVersion !== 1 || !['open', 'bounded-closed'].includes(state.status as string)) invalid('attempt version/status')
    identityOf(state.identity)
    if (!same(state.identity, identity)) invalid('attempt identity conflict')
    if (state.acceptance !== undefined) {
      const acceptance = acceptanceOf(state.acceptance)
      if (state.binding !== undefined || state.totalIntents !== 0 || state.pendingIntents !== 0 || state.unknownIntents !== 0 || state.reviewRequired !== false) invalid('bounded attempt cannot enter tool ledger')
      const begin = this.prepareBeginAttempt({ identity, recordedAt: row.createdAt, acceptance })
      this.requireExactMutation(begin, 0)
      if (state.status === 'open') {
        if (row.revision !== 0 || state.terminal !== undefined || !same(row.state, begin.state)) invalid('bounded open revision/evidence')
      } else {
        if (row.revision !== 1 || !state.terminal) invalid('bounded terminal revision/evidence')
        const terminal = record(state.terminal, ['witness', 'status', 'runId', 'finalInputDigest', 'instanceEventId', 'instanceRevision', 'closedAt'])
        if (!['producer-closure', 'accepted-never-dispatched'].includes(terminal.witness as string) || !['completed', 'cancelled', 'failed'].includes(terminal.status as string) || terminal.witness === 'accepted-never-dispatched' && terminal.status !== 'cancelled' || terminal.runId !== acceptance.runId || terminal.finalInputDigest !== acceptance.finalInputDigest || terminal.instanceRevision !== identity.acceptedInstanceRevision + 1) invalid('bounded terminal linkage')
        text(terminal.instanceEventId, 'bounded terminal event'); time(terminal.closedAt)
        const lifecycle = this.events.getEvent(terminal.instanceEventId as string)
        const current = this.events.getResource(MAGIC_AGENT_INSTANCE_RESOURCE_KIND, identity.instanceId, { includeDeleted: true })
        if (!lifecycle || lifecycle.type !== 'agent-instance.status-transitioned' || lifecycle.streamId !== `agent-instance:${identity.instanceId}:stream` || lifecycle.sequence !== terminal.instanceRevision || lifecycle.createdAt !== terminal.closedAt || !same((lifecycle.payload as { boundedOutcome?: unknown }).boundedOutcome, terminal) || !current || current.revision !== terminal.instanceRevision || current.deleted || (current.state as { status?: string }).status !== 'stopped') invalid('bounded terminal exact lifecycle pair')
        // Direct execution-store readers must validate the lifecycle chain too,
        // not merely combine an event with a plausible stopped snapshot.
        const instanceKey = `agent-instance:${identity.instanceId}:transition:managed-bounded-terminal:${acceptance.runId}`
        const paired = this.events.getResourceMutation(instanceKey)
        if (!paired || paired.operation !== 'update' || paired.expectedRevision !== identity.acceptedInstanceRevision || paired.eventId !== terminal.instanceEventId || paired.createdAt !== terminal.closedAt || !same(paired.resource, current)) invalid('bounded terminal lifecycle mutation receipt')
        const coverage = this.events.getResource(MANAGED_AGENT_COVERAGE_KIND, managedAgentCoverageId(identity.instanceId), { includeDeleted: true })
        if (!coverage || coverage.deleted || coverage.revision !== 1 || (coverage.state as { status?: string }).status !== 'dirty' || !same((coverage.state as { accepted?: { identity?: unknown; acceptance?: unknown } }).accepted?.identity, identity) || !same((coverage.state as { accepted?: { acceptance?: unknown } }).accepted?.acceptance, acceptance)) invalid('bounded terminal dirty coverage linkage')
        const coverageState = coverage.state as { accepted: { commandKey: string } }
        text(coverageState.accepted.commandKey, 'bounded accepted coverage command')
        const coverageReceipt = this.events.getResourceMutation(`${coverageState.accepted.commandKey}:coverage`)
        if (!coverageReceipt || coverageReceipt.operation !== 'update' || coverageReceipt.expectedRevision !== 0 || !same(coverageReceipt.resource, coverage)) invalid('bounded terminal exact dirty coverage receipt')
        const command = this.commandKey(identity, 'bounded-terminal')
        this.requireExactMutation(this.mutation(MANAGED_EXECUTION_ATTEMPT_KIND, row.id, row.state, 0, terminal.closedAt as number, command, { identity, acceptance, terminal }, 'attempt'), 1)
      }
      return row
    }
    if (state.status !== 'open' || state.terminal !== undefined) invalid('legacy attempt cannot claim bounded terminal')
    for (const key of ['totalIntents', 'pendingIntents', 'unknownIntents']) integer(state[key], 'intent counter')
    const total = state.totalIntents as number, pending = state.pendingIntents as number, unknown = state.unknownIntents as number
    if (pending > total || unknown > total - pending || state.reviewRequired !== (unknown > 0)) invalid('intent counters/review state')
    // One begin (revision 0), one binding, each intent once, each outcome once.
    // This exact monotonic relation rejects valid-looking counter resets too.
    const bindingWrites = state.binding === undefined ? 0 : 1
    const settled = total - pending
    if (total > Math.floor((Number.MAX_SAFE_INTEGER - bindingWrites) / 2) || row.revision !== bindingWrites + total + settled)
      invalid('attempt revision/counter evidence')
    if (state.binding !== undefined) {
      const binding = bindingOf(state.binding)
      if ('bindingVersion' in binding) this.requireIngress(identity, binding)
    }
    else if (total !== 0) invalid('intents without runtime binding')
    const beginReceipt = this.receipt(this.commandKey(identity, 'begin'), 'attempt', row.id, 0)
    if (!same(beginReceipt.payload, { commandDigest: digest({ identity, recordedAt: row.createdAt }) }) || beginReceipt.createdAt !== row.createdAt)
      invalid('attempt begin receipt evidence')
    if (state.binding !== undefined) {
      const boundReceipt = this.receipt(this.commandKey(identity, 'bind'), 'attempt', row.id, 1)
      if (!same(boundReceipt.payload, { commandDigest: digest({ identity, expectedRevision: 0, binding: state.binding, recordedAt: boundReceipt.createdAt }) }))
        invalid('runtime binding receipt evidence')
    }
    return row
  }

  bindRuntime(input: BindInput): StoredResource<ManagedExecutionAttempt> {
    input = data(input) as BindInput
    record(input, ['identity', 'expectedRevision', 'binding', 'recordedAt'])
    identityOf(input.identity); bindingOf(input.binding); integer(input.expectedRevision, 'expected revision'); time(input.recordedAt)
    this.assertLegacyAttempt(input.identity)
    if ('bindingVersion' in input.binding) this.requireIngress(input.identity, input.binding)
    const command = this.commandKey(input.identity, 'bind')
    if (this.replayed(command, input)) {
      const saved = this.requireAttempt(input.identity)
      if (!same(saved.state.binding, input.binding)) invalid('replayed binding conflict')
      return saved
    }
    const attempt = this.requireAttempt(input.identity, input.expectedRevision)
    if (attempt.state.binding) invalid('runtime binding conflict')
    this.events.mutateResourcesBatch([this.mutation(MANAGED_EXECUTION_ATTEMPT_KIND, attempt.id, { ...attempt.state, binding: input.binding }, attempt.revision, input.recordedAt, command, input, 'attempt')])
    return this.requireAttempt(input.identity)
  }

  recordIntent(input: IntentInput): StoredResource<ManagedExecutionIntent> {
    input = data(input) as IntentInput
    record(input, ['identity', 'expectedRevision', 'intent', 'recordedAt'])
    identityOf(input.identity); intentOf(input.intent); integer(input.expectedRevision, 'expected revision'); time(input.recordedAt)
    this.assertLegacyAttempt(input.identity)
    const command = this.commandKey(input.identity, 'intent', input.intent.invocationId)
    if (this.replayed(command, input)) {
      const saved = this.getIntent(input.identity, input.intent.invocationId)
      if (!saved || !same(saved.state.intent, input.intent)) invalid('replayed intent identity conflict')
      return saved
    }
    const attempt = this.requireAttempt(input.identity, input.expectedRevision)
    if (!attempt.state.binding || attempt.state.binding.runtimeRunId !== input.intent.runtimeRunId) invalid('intent runtime binding mismatch')
    if (attempt.state.reviewRequired || unknownsFor(this.events).has(attempt.id)) invalid('unknown review required before another intent')
    if (this.getIntent(input.identity, input.intent.invocationId)) invalid('intent identity conflict or missing receipt')
    const totalIntents = attempt.state.totalIntents + 1, pendingIntents = attempt.state.pendingIntents + 1
    integer(totalIntents, 'total intents'); integer(pendingIntents, 'pending intents')
    const state: ManagedExecutionIntent = { protocolVersion: 1, identity: input.identity, intent: input.intent, status: 'pending' }
    this.events.mutateResourcesBatch([
      this.mutation(MANAGED_EXECUTION_ATTEMPT_KIND, attempt.id, { ...attempt.state, totalIntents, pendingIntents }, attempt.revision, input.recordedAt, command, input, 'attempt'),
      this.mutation(MANAGED_EXECUTION_INTENT_KIND, intentKey(input.identity, input.intent.invocationId), state, undefined, input.recordedAt, command, input, 'intent')
    ])
    return this.getIntent(input.identity, input.intent.invocationId)!
  }

  getIntent(identity: ManagedExecutionIdentity, invocationId: string): StoredResource<ManagedExecutionIntent> | undefined {
    identity = identityOf(data(identity)); text(invocationId, 'invocation identity')
    this.assertLegacyAttempt(identity)
    const row = this.events.getResource<ManagedExecutionIntent>(MANAGED_EXECUTION_INTENT_KIND, intentKey(identity, invocationId), { includeDeleted: true })
    if (!row) return undefined
    if (row.deleted) invalid('intent deleted')
    const state = record(data(row.state), ['protocolVersion', 'identity', 'intent', 'status'], ['outcome'])
    if (state.protocolVersion !== 1 || !same(identityOf(state.identity), identity)) invalid('intent version/identity conflict')
    const intent = intentOf(state.intent), attempt = this.requireAttempt(identity)
    if (intent.invocationId !== invocationId || intent.runtimeRunId !== attempt.state.binding?.runtimeRunId) invalid('intent binding mismatch')
    if (state.status === 'pending') {
      if (state.outcome !== undefined || row.revision !== 0 || attempt.state.pendingIntents < 1) invalid('pending intent evidence')
    } else {
      const outcome = outcomeOf(state.outcome)
      if ((state.status !== 'reported-result' && state.status !== 'unknown') || outcome.kind !== state.status ||
          row.revision !== 1 || (state.status === 'unknown' && attempt.state.unknownIntents < 1) ||
          (state.status === 'reported-result' && attempt.state.totalIntents - attempt.state.pendingIntents - attempt.state.unknownIntents < 1)) invalid('terminal intent counter evidence')
    }
    this.intentReceipts(attempt, row)
    return row
  }

  recordOutcome(input: OutcomeInput): StoredResource<ManagedExecutionIntent> {
    input = data(input) as OutcomeInput
    record(input, ['identity', 'expectedRevision', 'invocationId', 'outcome', 'recordedAt'])
    identityOf(input.identity); text(input.invocationId, 'invocation identity'); integer(input.expectedRevision, 'expected revision'); time(input.recordedAt)
    this.assertLegacyAttempt(input.identity)
    input = { ...input, outcome: outcomeOf(input.outcome) }
    const uncertain = unknownsFor(this.events)
    const intentIdentity = intentKey(input.identity, input.invocationId)
    if (input.outcome.kind !== 'unknown' && uncertain.has(intentIdentity)) invalid('observed unknown requires review, including after publication failure')
    const command = this.commandKey(input.identity, 'outcome', input.invocationId)
    if (this.replayed(command, input)) {
      const saved = this.getIntent(input.identity, input.invocationId)
      if (!saved || !same(saved.state.outcome, input.outcome)) invalid('replayed outcome conflict')
      return saved
    }
    const attempt = this.requireAttempt(input.identity)
    const intent = this.getIntent(input.identity, input.invocationId)
    if (!intent) invalid('missing intent')
    if (intent.state.status !== 'pending' || attempt.state.pendingIntents < 1) invalid('unknown/terminal outcome conflict; review required')
    if (input.outcome.kind === 'unknown') {
      uncertain.add(intentIdentity)
      uncertain.add(attempt.id)
    }
    // The observation belongs to this validated pending intent even when another
    // intent has advanced the aggregate revision. Reject the write, not knowledge
    // of uncertainty; a current-revision retry may only persist the unknown.
    if (attempt.revision !== input.expectedRevision) invalid('attempt revision conflict')
    const unknownIntents = attempt.state.unknownIntents + (input.outcome.kind === 'unknown' ? 1 : 0)
    this.events.mutateResourcesBatch([
      this.mutation(MANAGED_EXECUTION_ATTEMPT_KIND, attempt.id, { ...attempt.state, pendingIntents: attempt.state.pendingIntents - 1, unknownIntents, reviewRequired: unknownIntents > 0 }, attempt.revision, input.recordedAt, command, input, 'attempt'),
      this.mutation(MANAGED_EXECUTION_INTENT_KIND, intent.id, { ...intent.state, status: input.outcome.kind, outcome: input.outcome }, intent.revision, input.recordedAt, command, input, 'intent')
    ])
    return this.getIntent(input.identity, input.invocationId)!
  }

  /** Inert second half of the exact lifecycle/attempt terminal pair. */
  prepareBoundedTerminal(identity: ManagedExecutionIdentity, instance: InstanceTransitionMutation, witness: 'producer-closure' | 'accepted-never-dispatched', status: 'completed' | 'cancelled' | 'failed'): ResourceMutationInput {
    const row = this.requireAttempt(identity)
    if (!row.state.acceptance || row.state.status !== 'open' || row.revision !== 0 || instance.kind !== MAGIC_AGENT_INSTANCE_RESOURCE_KIND || instance.id !== identity.instanceId || instance.expectedRevision !== identity.acceptedInstanceRevision || instance.event.type !== 'agent-instance.status-transitioned' || (instance.state as { status?: string }).status !== 'stopped' || witness === 'accepted-never-dispatched' && status !== 'cancelled') invalid('bounded terminal plan')
    const terminal: ManagedBoundedTerminal = { witness, status, runId: row.state.acceptance.runId, finalInputDigest: row.state.acceptance.finalInputDigest, instanceEventId: instance.event.id, instanceRevision: identity.acceptedInstanceRevision + 1, closedAt: instance.createdAt }
    return data(this.mutation(MANAGED_EXECUTION_ATTEMPT_KIND, row.id, { ...row.state, status: 'bounded-closed', terminal }, 0, instance.createdAt, this.commandKey(identity, 'bounded-terminal'), { identity, acceptance: row.state.acceptance, terminal }, 'attempt')) as ResourceMutationInput
  }

  private assertLegacyAttempt(identity: ManagedExecutionIdentity): void {
    const row = this.requireAttempt(identity)
    if (row.state.acceptance || row.state.status !== 'open') invalid('bounded attempts cannot bind tools or replay ledger commands')
  }

  private requireExactMutation(plan: ResourceMutationInput, revision: number): void {
    const receipt = this.events.getResourceMutation(plan.idempotencyKey), event = this.events.getEvent(plan.event.id)
    if (!receipt || !event || receipt.operation !== plan.operation || receipt.expectedRevision !== plan.expectedRevision || receipt.eventId !== plan.event.id || receipt.resource.kind !== plan.kind || receipt.resource.id !== plan.id || receipt.resource.revision !== revision || receipt.resource.deleted || receipt.createdAt !== plan.createdAt || !same(receipt.resource.state, plan.state) || canonicalJson(event) !== canonicalJson(plan.event)) invalid('bounded exact mutation receipt')
  }

  private requireIngress(identity: ManagedExecutionIdentity, binding: Extract<ManagedRuntimeBinding, { bindingVersion: 2 }>): void {
    const row = readManagedRuntimeIngress(this.events, identity)
    if (!row || row.id !== binding.ingressRecordId || row.state.runtimeRunId !== binding.runtimeRunId) invalid('executor binding exact ingress evidence')
  }

  private requireAttempt(identity: ManagedExecutionIdentity, revision?: number): StoredResource<ManagedExecutionAttempt> {
    const attempt = this.getAttempt(identity)
    if (!attempt) invalid('missing attempt')
    if (revision !== undefined && attempt.revision !== revision) invalid('attempt revision conflict')
    return attempt
  }

  private commandKey(identity: ManagedExecutionIdentity, operation: string, invocationId = ''): string {
    return `managed-command:${digest([attemptKey(identity), operation, invocationId])}`
  }

  private receipt(command: string, part: 'attempt' | 'intent', id: string, sequence?: number) {
    const event = this.events.getEvent(`${command}:${part}:event`)
    const kind = part === 'attempt' ? MANAGED_EXECUTION_ATTEMPT_KIND : MANAGED_EXECUTION_INTENT_KIND
    if (!event || event.id !== `${command}:${part}:event` || event.protocolVersion !== '2.0.0' ||
        event.type !== 'managed-execution.recorded' || event.envelopeKind !== 'event' ||
        event.streamId !== `${kind}:${id}:stream` || !Number.isSafeInteger(event.sequence) ||
        event.sequence < 0 || (sequence !== undefined && event.sequence !== sequence)) invalid('missing or inconsistent exact receipt evidence')
    return event
  }

  private intentReceipts(attempt: StoredResource<ManagedExecutionAttempt>, row: StoredResource<ManagedExecutionIntent>): void {
    const { identity, intent } = row.state
    const verify = (operation: 'intent' | 'outcome', value: unknown, intentRevision: number) => {
      const command = this.commandKey(identity, operation, intent.invocationId)
      const aggregate = this.receipt(command, 'attempt', attempt.id)
      const individual = this.receipt(command, 'intent', row.id, intentRevision)
      if (aggregate.sequence < 2 || aggregate.sequence > attempt.revision ||
          aggregate.createdAt !== individual.createdAt || !same(aggregate.payload, individual.payload) ||
          !same(aggregate.payload, { commandDigest: digest({ identity, expectedRevision: aggregate.sequence - 1,
            ...(operation === 'intent' ? { intent: value } : { invocationId: intent.invocationId, outcome: value }), recordedAt: aggregate.createdAt }) }))
        invalid('paired receipt evidence conflict')
      return aggregate
    }
    const created = verify('intent', intent, 0)
    if (created.createdAt !== row.createdAt) invalid('intent creation receipt evidence')
    if (row.state.status !== 'pending') {
      const completed = verify('outcome', row.state.outcome, 1)
      if (completed.sequence <= created.sequence || completed.createdAt !== row.updatedAt) invalid('intent outcome receipt ordering')
    } else if (this.events.getEvent(`${this.commandKey(identity, 'outcome', intent.invocationId)}:attempt:event`)) {
      invalid('pending intent contradicts outcome receipt')
    }
  }

  /** Fixed command identities use exact event reads, never bounded history scans. */
  private replayed(command: string, input: unknown): boolean {
    const receipt = this.events.getEvent(`${command}:attempt:event`)
    if (!receipt) return false
    if (receipt.type !== 'managed-execution.recorded' || receipt.envelopeKind !== 'event' ||
        !same(receipt.payload, { commandDigest: digest(input) })) invalid('command identity/replay conflict')
    return true
  }

  private mutation(
    kind: string, id: string, state: ManagedExecutionAttempt | ManagedExecutionIntent,
    revision: number | undefined, recordedAt: number, command: string, input: unknown, part: 'attempt' | 'intent'
  ): ResourceMutationInput {
    return {
      operation: revision === undefined ? 'create' : 'update', kind, id, state,
      ...(revision === undefined ? {} : { expectedRevision: revision }),
      createdAt: recordedAt, idempotencyKey: `${command}:${part}`,
      event: {
        protocolVersion: '2.0.0', id: `${command}:${part}:event`, type: 'managed-execution.recorded',
        createdAt: recordedAt, envelopeKind: 'event', streamId: `${kind}:${id}:stream`,
        sequence: revision === undefined ? 0 : revision + 1, payload: { commandDigest: digest(input) }
      }
    }
  }
}
