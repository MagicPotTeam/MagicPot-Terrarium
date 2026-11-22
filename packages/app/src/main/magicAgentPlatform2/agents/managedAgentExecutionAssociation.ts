import { isProxy } from 'node:util/types'
import { getAgentSessionKey, normalizeAgentRoute } from '../../../shared/agent/sessionIdentity'
import { canonicalPolicyJson, sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import type { AssistantInboundMessage } from '../../assistantRuntime/types'
import type { MagicAgentEventStore } from '../persistence/eventStore'
import { CooperativeExecutionController } from './cooperativeExecutionController'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import { PersistentManagedAgentExecutionStore, type ManagedExecutionIdentity } from './persistentManagedAgentExecutionStore'
import { PersistentManagedAgentInstanceStore, type ManagedAgentFirstStartInput } from './persistentManagedAgentInstanceStore'

declare const associationBrand: unique symbol
/** MAIN-only association identity, not runnable/policy/recovery authority. */
export type ManagedExecutionAssociation = Readonly<{ [associationBrand]: true }>
export type ManagedAssociationOwner = {
  controller: AbortController
  cooperativeExecution: CooperativeExecutionController
  phase: 'starting' | 'running' | 'finishing' | 'faulted'
  stopRequested: boolean
}
export type ManagedAssociationOwnership = {
  readonly active: ReadonlyMap<string, ManagedAssociationOwner>
  closing: boolean
}
export type ManagedAssistantIngress = Pick<AssistantInboundMessage,
  'route' | 'text' | 'attachments' | 'profileId' | 'maxOutputTokens' | 'temperature' |
  'systemPrompt' | 'execution' | 'workspaceId' | 'resetHistory' | 'taskGroup'>
export type ManagedAssociationContext = Readonly<{
  events: MagicAgentEventStore
  owner: ManagedAssociationOwner
  controller: AbortController
  cooperativeExecution: CooperativeExecutionController
}>
export type ManagedIngressClaim = Readonly<{
  identity: ManagedExecutionIdentity
  ingressDigest: string
  sessionKey: string
  ingress: ManagedAssistantIngress
}>

type Slot = {
  phase: 'issuing' | 'issued' | 'claiming' | 'claimed' | 'blocked'
  instanceId: string
  owner: ManagedAssociationOwner
  controller: AbortController | undefined
  cooperativeExecution: CooperativeExecutionController | undefined
}
type AssociationRecord = Readonly<{
  slot: Slot
  identity: ManagedExecutionIdentity
  ingress: ManagedAssistantIngress
  ingressDigest: string
  sessionKey: string
}>
function invalid(detail: string): never { throw new Error(`Invalid managed execution association: ${detail}.`) }
const canonical = (value: unknown): string => canonicalPolicyJson(value as never)
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)

// This is a bounded descriptor capture, not inbound schema validation/approval.
// Optional own undefined is significant. Never freeze or invoke caller data.
function capture<T>(input: T): T {
  const ancestors = new Set<object>(); let nodes = 0, stringUnits = 0
  const visit = (value: unknown, depth: number, arrayItem = false): unknown => {
    if (++nodes > 8192 || depth > 24) invalid('ingress data exceeds capture bounds')
    if (typeof value === 'string') { stringUnits += value.length; if (stringUnits > 4 * 1024 * 1024) invalid('ingress string data exceeds capture bounds'); return value }
    if (value === undefined && !arrayItem || value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || isProxy(value)) invalid('plain ingress data required, not proxy/executable values')
    if (ancestors.has(value)) invalid('cyclic ingress data')
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid('plain ingress objects/arrays required')
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
    if (keys.length > 8192 || keys.some(key => typeof key !== 'string')) invalid('ingress data fields')
    ancestors.add(value)
    try {
      if (array) {
        const length = descriptors.length.value as number
        if (length > 8192 || keys.length !== length + 1) invalid('ingress arrays must be dense without extra fields')
        const result: unknown[] = []
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)]
          if (!descriptor?.enumerable || !('value' in descriptor)) invalid('ingress array fields must be plain data')
          result.push(visit(descriptor.value, depth + 1, true))
        }
        return Object.freeze(result)
      }
      const result: Record<string, unknown> = Object.create(null)
      for (const key of keys as string[]) {
        const descriptor = descriptors[key]
        if (!descriptor.enumerable || !('value' in descriptor) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid('ingress fields must be plain data, not accessors')
        stringUnits += key.length
        if (stringUnits > 4 * 1024 * 1024) invalid('ingress string data exceeds capture bounds')
        Object.defineProperty(result, key, { enumerable: true, configurable: false, writable: false, value: visit(descriptor.value, depth + 1) })
      }
      return Object.freeze(result)
    } finally { ancestors.delete(value) }
  }
  return visit(input, 0) as T
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid('record fields')
}
function materialOf(input: ManagedAssistantIngress): ManagedAssistantIngress {
  const snapshot = capture(input)
  fields(snapshot, ['route'], ['text', 'attachments', 'profileId', 'maxOutputTokens', 'temperature', 'systemPrompt', 'execution', 'workspaceId', 'resetHistory', 'taskGroup'])
  fields(snapshot.route, ['channel', 'scopeType', 'scopeId'], ['threadId', 'senderId', 'senderName'])
  for (const [key, value] of Object.entries(snapshot.route)) if (value !== undefined && typeof value !== 'string' || ['channel', 'scopeType', 'scopeId'].includes(key) && typeof value !== 'string') invalid('ingress route fields must be strings')
  for (const key of ['text', 'profileId', 'systemPrompt', 'workspaceId'] as const) if (snapshot[key] !== undefined && typeof snapshot[key] !== 'string') invalid('ingress text fields')
  for (const key of ['maxOutputTokens', 'temperature'] as const) if (snapshot[key] !== undefined && typeof snapshot[key] !== 'number') invalid('ingress inference fields')
  if (snapshot.resetHistory !== undefined && typeof snapshot.resetHistory !== 'boolean' || snapshot.attachments !== undefined && !Array.isArray(snapshot.attachments)) invalid('ingress reset/attachments fields')
  if (snapshot.execution !== undefined && (!snapshot.execution || typeof snapshot.execution !== 'object' || Array.isArray(snapshot.execution)) || snapshot.taskGroup !== undefined && snapshot.taskGroup !== null && (typeof snapshot.taskGroup !== 'object' || Array.isArray(snapshot.taskGroup))) invalid('ingress execution/task fields')
  const route = normalizeAgentRoute(snapshot.route)
  // Normalized text remains equivalent, but an explicitly present undefined is
  // still material under canonicalPolicyJson rather than silently becoming absent.
  for (const key of ['threadId', 'senderId', 'senderName'] as const) {
    if (Object.hasOwn(snapshot.route, key) && snapshot.route[key] === undefined)
      Object.defineProperty(route, key, { value: undefined, enumerable: true })
  }
  return Object.freeze({ ...snapshot, route: Object.freeze(route) }) as ManagedAssistantIngress
}
function ownerData(owner: ManagedAssociationOwner): ManagedAssociationOwner {
  if (!owner || typeof owner !== 'object' || isProxy(owner)) invalid('trusted owner identity required')
  const result = Object.create(null) as ManagedAssociationOwner
  for (const key of ['controller', 'cooperativeExecution', 'phase', 'stopRequested'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid('owner fields must be own plain data, not accessors')
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true })
  }
  return result
}
const ingressDigest = (material: ManagedAssistantIngress): string => sha256PolicyText(canonical({ domain: 'assistant-ingress/v1', material }))

/**
 * Isolated MAIN association prerequisite; only test fixtures import this today.
 * The registry must be the issuer's trusted MAIN objects, never model/IPC DTOs.
 * A test-only registry does not become the production lifecycle's private map.
 * No policy, actual runtime UUID, durable bind, tool intent or clean authority.
 * Liveness reads narrow association only, NOT a final-COMMIT admission fence.
 * Malicious replacement of trusted MAIN store/registry methods is outside scope.
 */
export class ManagedExecutionAssociationIssuer {
  readonly #events: MagicAgentEventStore
  readonly #ownership: ManagedAssociationOwnership
  readonly #managed: PersistentManagedAgentInstanceStore
  readonly #ledger: PersistentManagedAgentExecutionStore
  readonly #plain: PersistentAgentInstanceStore
  readonly #slots = new WeakMap<ManagedAssociationOwner, Slot>()
  readonly #instances = new Map<string, Slot>()
  readonly #records = new WeakMap<ManagedExecutionAssociation, AssociationRecord>()
  #closed = false

  constructor(events: MagicAgentEventStore, ownership: ManagedAssociationOwnership) {
    this.#events = events; this.#ownership = ownership
    this.#managed = new PersistentManagedAgentInstanceStore(events)
    this.#ledger = new PersistentManagedAgentExecutionStore(events)
    this.#plain = new PersistentAgentInstanceStore(events)
    Object.freeze(this)
  }

  begin(input: Omit<ManagedAgentFirstStartInput, 'sessionKey'>, owner: ManagedAssociationOwner, ingress: ManagedAssistantIngress): ManagedExecutionAssociation {
    if (this.#closed) invalid('issuer closed')
    const command = capture(input), material = materialOf(ingress)
    fields(command, ['instanceId', 'expectedRevision', 'expectedCoverageRevision', 'authorizedRequestDigest', 'startedAt', 'idempotencyKey'])
    if (typeof command.instanceId !== 'string' || !command.instanceId || typeof command.idempotencyKey !== 'string' || !command.idempotencyKey || typeof command.authorizedRequestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(command.authorizedRequestDigest) || command.expectedRevision !== 0 || command.expectedCoverageRevision !== 0 || typeof command.startedAt !== 'number' || !Number.isFinite(command.startedAt) || command.startedAt < 0) invalid('fresh start command fields')
    if (!owner || typeof owner !== 'object' || isProxy(owner)) invalid('trusted owner identity required')
    if (this.#slots.has(owner) || this.#instances.has(command.instanceId)) invalid('owner/instance association already reserved')
    // Reserve before inspecting even the trusted owner's data descriptors. A
    // malformed owner burns this epoch without invoking its executable fields.
    const slot: Slot = { phase: 'issuing', instanceId: command.instanceId, owner, controller: undefined, cooperativeExecution: undefined }
    this.#slots.set(owner, slot); this.#instances.set(command.instanceId, slot)
    try {
      const ownerSnapshot = ownerData(owner)
      slot.controller = ownerSnapshot.controller; slot.cooperativeExecution = ownerSnapshot.cooperativeExecution
      this.#assertLive(slot)
      const sessionKey = getAgentSessionKey(material.route)
      const accepted = this.#managed.startFirstAttempt({ ...command, sessionKey })
      if (!accepted.inserted) invalid('fresh insertion required; replay is not association authority')
      const identity = capture(accepted.attempt.state.identity)
      const record: AssociationRecord = Object.freeze({ slot, identity, ingress: material, ingressDigest: ingressDigest(material), sessionKey })
      this.#assertStored(record)
      this.#assertLive(slot)
      const handle = Object.freeze(Object.create(null)) as ManagedExecutionAssociation
      this.#records.set(handle, record); slot.phase = 'issued'
      return handle
    } catch (error) { slot.phase = 'blocked'; throw error }
  }

  claim(handle: ManagedExecutionAssociation, context: ManagedAssociationContext, ingress: ManagedAssistantIngress): ManagedIngressClaim {
    const record = this.#records.get(handle)
    // Reject duplicates outside the catch: do not corrupt an original in-flight
    // or completed claim when a callout attempts reentrancy with the same handle.
    if (!record || record.slot.phase !== 'issued') invalid('unknown or already claimed association')
    const slot = record.slot
    slot.phase = 'claiming'
    try {
      if (!context || typeof context !== 'object' || isProxy(context)) invalid('exact MAIN association context required')
      const descriptors = Object.getOwnPropertyDescriptors(context), keys = Reflect.ownKeys(descriptors)
      const expected = ['events', 'owner', 'controller', 'cooperativeExecution']
      if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key) || !descriptors[key].enumerable || !('value' in descriptors[key]))) invalid('exact MAIN association context fields required')
      if (descriptors.events.value !== this.#events || descriptors.owner.value !== slot.owner || descriptors.controller.value !== slot.controller || descriptors.cooperativeExecution.value !== slot.cooperativeExecution) invalid('exact store/owner/controller/root-gate identity mismatch')
      this.#assertLive(slot)
      const material = materialOf(ingress)
      // Full material includes normalized ROUTE, not only a collision-prone key.
      if (!same(material, record.ingress) || ingressDigest(material) !== record.ingressDigest) invalid('pinned ingress/route mismatch')
      this.#assertStored(record)
      this.#assertLive(slot)
      slot.phase = 'claimed'
      // This detached, immutable DATA is diagnostic only; it contains no handle,
      // controller, store, registry or private slot and cannot mint a new claim.
      return Object.freeze({ identity: record.identity, ingressDigest: record.ingressDigest, sessionKey: record.sessionKey, ingress: record.ingress })
    } catch (error) { slot.phase = 'blocked'; throw error }
  }

  close(): void { this.#closed = true }

  #assertLive(slot: Slot): void {
    if (this.#closed || this.#ownership.closing || this.#ownership.active.get(slot.instanceId) !== slot.owner) invalid('issuer closed or owner no longer current')
    const owner = ownerData(slot.owner)
    if (owner.phase !== 'running' || owner.stopRequested || owner.controller !== slot.controller || owner.cooperativeExecution !== slot.cooperativeExecution || !(slot.controller instanceof AbortController) || !(slot.cooperativeExecution instanceof CooperativeExecutionController) || slot.controller.signal.aborted) invalid('owner phase/controller/gate no longer live')
  }

  #assertStored(record: AssociationRecord): void {
    const { identity } = record, coverage = this.#managed.getCoverage(identity.instanceId)
    const instance = this.#plain.get(identity.instanceId), attempt = this.#ledger.getAttempt(identity)
    if (!coverage || coverage.deleted || coverage.revision !== 1 || coverage.state.status !== 'dirty' || coverage.state.generation !== identity.generation || !same(coverage.state.accepted?.identity, identity) || identity.sessionKey !== record.sessionKey) invalid('exact dirty coverage identity mismatch')
    if (!instance || instance.deleted || instance.revision !== identity.acceptedInstanceRevision || instance.state.status !== 'running' || instance.state.definitionId !== identity.definitionId || instance.state.configVersion !== identity.configVersion) invalid('accepted running instance revision/identity changed')
    if (!attempt || attempt.deleted || attempt.revision !== 0 || attempt.state.binding || attempt.state.reviewRequired || attempt.state.totalIntents || attempt.state.pendingIntents || attempt.state.unknownIntents) invalid('fresh unbound attempt required')
  }
}
