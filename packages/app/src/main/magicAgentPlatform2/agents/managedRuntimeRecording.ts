import { randomUUID } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { Config } from '../../../shared/config/config'
import type { AssistantInboundMessage } from '../../assistantRuntime/types'
import type { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import { PersistentManagedAgentInstanceStore, type ManagedAgentFirstStartInput } from './persistentManagedAgentInstanceStore'
import type { AssistantExecutionRequest } from '../../assistantRuntime/executionAdapter'
import { PersistentManagedAgentExecutionStore } from './persistentManagedAgentExecutionStore'
import { ManagedExecutionAssociationIssuer, type ManagedExecutionAssociation, type ManagedAssociationOwner, type ManagedAssociationOwnership, type ManagedAssistantIngress, type ManagedIngressClaim } from './managedAgentExecutionAssociation'
import { insertManagedRuntimeIngress, readManagedRuntimeIngress } from './managedRuntimeIngress'
import { captureManagedData as capture, invalidManagedRecording as invalid, managedCanonical as canonical, managedDigest as digest, managedOwnValues } from './managedRuntimeSnapshot'

declare const ticketBrand: unique symbol
declare const leaseBrand: unique symbol
declare const toolBrand: unique symbol
export type ManagedRuntimeTicket = Readonly<{ [ticketBrand]: true }>
export type ManagedRuntimeLease = Readonly<{ [leaseBrand]: true }>
export type ManagedRuntimeTool = Readonly<{ [toolBrand]: true }>
export type ManagedRuntimeOptions = Readonly<{ ticket: ManagedRuntimeTicket }>
/** Separate internal method argument, never an inbound/adapter/tool-context property. */
export type ManagedRuntimeExecution = Readonly<{ coordinator: ManagedRuntimeRecording; runtime: object; lease: ManagedRuntimeLease }>
type Slot = {
  phase: 'issued' | 'claiming' | 'active' | 'blocked' | 'finished'
  handle: ManagedExecutionAssociation
  owner: ManagedAssociationOwner
  controller: AbortController
  gate: ManagedAssociationOwner['cooperativeExecution']
  claim?: ManagedIngressClaim
  runId?: string
  ingressId?: string
  config?: Config
  configDigest?: string
  bound: boolean
  busy: boolean
  calls: Set<string>
  totalCalls: number
}
type ToolSlot = { slot: Slot; invocationId: string; phase: 'intent' | 'started' | 'publishing' | 'done' }
const materialKeys = ['route', 'text', 'attachments', 'profileId', 'maxOutputTokens', 'temperature', 'systemPrompt', 'execution', 'workspaceId', 'resetHistory', 'taskGroup']
const referenceKeys = ['signal', 'cooperativeExecution', 'toolProvider', 'onEvent']
const opaque = <T>(): T => Object.freeze(Object.create(null)) as T

/**
 * Explicit opt-in direct actual-runtime recording, with fixture MAIN ownership.
 * No production service/adapter transport, real LLMProxy service, clean witness,
 * restart/replacement/config admission or clearance. Readable receipts are DATA.
 * Supported liveness rechecks are not a final-COMMIT admission fence.
 */
export class ManagedRuntimeRecording {
  readonly #issuer: ManagedExecutionAssociationIssuer
  readonly #ledger: PersistentManagedAgentExecutionStore
  readonly #managed: PersistentManagedAgentInstanceStore
  readonly #plain: PersistentAgentInstanceStore
  readonly #tickets = new WeakMap<ManagedRuntimeTicket, Slot>()
  readonly #leases = new WeakMap<ManagedRuntimeLease, Slot>()
  readonly #tools = new WeakMap<ManagedRuntimeTool, ToolSlot>()
  #runtime?: object
  #closed = false
  constructor(readonlyEvents: MagicAgentEventStore, readonlyOwnership: ManagedAssociationOwnership) {
    this.#events = readonlyEvents; this.#ownership = readonlyOwnership
    this.#issuer = new ManagedExecutionAssociationIssuer(readonlyEvents, readonlyOwnership)
    this.#ledger = new PersistentManagedAgentExecutionStore(readonlyEvents)
    this.#managed = new PersistentManagedAgentInstanceStore(readonlyEvents)
    this.#plain = new PersistentAgentInstanceStore(readonlyEvents)
    Object.freeze(this)
  }
  readonly #events: MagicAgentEventStore
  readonly #ownership: ManagedAssociationOwnership
  attachRuntime(runtime: object): void {
    if (this.#closed || this.#runtime || !runtime || typeof runtime !== 'object') invalid('one exact runtime attachment required')
    this.#runtime = runtime
  }
  begin(input: Omit<ManagedAgentFirstStartInput, 'sessionKey'>, owner: ManagedAssociationOwner, ingress: ManagedAssistantIngress): ManagedRuntimeTicket {
    if (!this.#runtime || this.#closed) invalid('runtime not attached or recording closed')
    // Issuer owns fresh atomic start; no external result/receipt/claim can mint.
    const handle = this.#issuer.begin(input, owner, ingress), values = managedOwnValues(owner)
    const slot: Slot = { phase: 'issued', handle, owner, controller: values.controller as AbortController, gate: values.cooperativeExecution as Slot['gate'], bound: false, busy: false, calls: new Set(), totalCalls: 0 }
    const ticket = opaque<ManagedRuntimeTicket>(); this.#tickets.set(ticket, slot); return ticket
  }
  #ticket(options: ManagedRuntimeOptions): Slot | undefined {
    // Find a recognizable own data ticket before inspecting any other descriptors.
    // Extra accessor fields fail without evaluation AND burn that issued ticket.
    if (!options || typeof options !== 'object' || isProxy(options)) invalid('plain ticket options required')
    const descriptor = Object.getOwnPropertyDescriptor(options, 'ticket')
    const recognized = descriptor && 'value' in descriptor ? this.#tickets.get(descriptor.value) : undefined
    try {
      const values = managedOwnValues(options)
      if (Object.keys(values).length !== 1 || !Object.hasOwn(values, 'ticket')) invalid('exact ticket options required')
      return recognized
    } catch (error) { if (recognized?.phase === 'issued') recognized.phase = 'blocked'; throw error }
  }
  rejectTicket(options?: ManagedRuntimeOptions): void {
    if (!options) return
    const slot = this.#ticket(options)
    if (slot?.phase === 'issued') slot.phase = 'blocked'
  }
  claim(runtime: object, options: ManagedRuntimeOptions, request: AssistantInboundMessage): { lease: ManagedRuntimeLease; runId: string; request: AssistantInboundMessage } {
    const slot = this.#ticket(options)
    // A duplicate does not corrupt the first in-flight/finished claim.
    if (!slot || slot.phase !== 'issued') invalid('unknown or consumed runtime ticket')
    slot.phase = 'claiming'
    try {
      if (runtime !== this.#runtime) invalid('exact attached runtime required')
      const values = managedOwnValues(request)
      if (Object.keys(values).some(key => !materialKeys.includes(key) && !referenceKeys.includes(key))) invalid('unsupported managed request fields, continuation/resume not admitted')
      if (values.signal !== slot.controller.signal || values.cooperativeExecution !== slot.gate) invalid('original owner signal/root gate required at direct ingress')
      const material = Object.fromEntries(materialKeys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]])) as ManagedAssistantIngress
      slot.claim = this.#issuer.claim(slot.handle, { events: this.#events, owner: slot.owner, controller: slot.controller, cooperativeExecution: slot.gate }, material)
      slot.runId = randomUUID()
      this.#assertLive(slot, true)
      const row = insertManagedRuntimeIngress(this.#events, { protocolVersion: 1, identity: slot.claim.identity, runtimeRunId: slot.runId, ingressProtocol: 'assistant-ingress/v1', ingressDigest: slot.claim.ingressDigest, routeCanonical: canonical(slot.claim.ingress.route), sessionKey: slot.claim.sessionKey })
      slot.ingressId = row.id
      this.#assertLive(slot, true)
      const lease = opaque<ManagedRuntimeLease>(); this.#leases.set(lease, slot); slot.phase = 'active'
      // Only trusted references plus the issuer's detached snapshot; no authority fields.
      const refs = Object.fromEntries(referenceKeys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]))
      return { lease, runId: slot.runId, request: Object.freeze({ ...slot.claim.ingress, ...refs }) as AssistantInboundMessage }
    } catch (error) { slot.phase = 'blocked'; throw error }
  }
  #slot(runtime: object, lease: ManagedRuntimeLease): Slot {
    const slot = this.#leases.get(lease)
    if (!slot || runtime !== this.#runtime || slot.phase !== 'active') invalid('unknown, blocked or finished runtime lease')
    return slot
  }
  #assertLive(slot: Slot, fresh = false): void {
    if (this.#closed || this.#ownership.closing || !slot.claim || this.#ownership.active.get(slot.claim.identity.instanceId) !== slot.owner) invalid('recording closed or current owner changed')
    const owner = managedOwnValues(slot.owner)
    if (owner.controller !== slot.controller || owner.cooperativeExecution !== slot.gate || owner.phase !== 'running' || owner.stopRequested || slot.controller.signal.aborted) invalid('owner stopped/controller/root changed')
    const identity = slot.claim.identity, coverage = this.#managed.getCoverage(identity.instanceId), instance = this.#plain.get(identity.instanceId), attempt = this.#ledger.getAttempt(identity)
    if (!coverage || coverage.deleted || coverage.revision !== 1 || coverage.state.status !== 'dirty' || canonical(coverage.state.accepted?.identity) !== canonical(identity) || !instance || instance.deleted || instance.revision !== identity.acceptedInstanceRevision || instance.state.status !== 'running' || instance.state.definitionId !== identity.definitionId || instance.state.configVersion !== identity.configVersion || !attempt || attempt.deleted || attempt.state.reviewRequired || fresh && (attempt.revision !== 0 || attempt.state.binding || attempt.state.totalIntents)) invalid('exact dirty coverage/attempt/current instance required')
    // Store/registry reads can call out in supported tests. Recheck owner afterward.
    const after = managedOwnValues(slot.owner)
    if (this.#closed || this.#ownership.closing || this.#ownership.active.get(identity.instanceId) !== slot.owner || after.controller !== slot.controller || after.cooperativeExecution !== slot.gate || after.phase !== 'running' || after.stopRequested || slot.controller.signal.aborted) invalid('owner changed during recording read')
  }
  captureConfig(runtime: object, lease: ManagedRuntimeLease, config: Config): Config {
    const slot = this.#slot(runtime, lease)
    try {
      if (slot.config) invalid('config snapshot already captured')
      this.#assertLive(slot, true); slot.config = capture(config); slot.configDigest = digest('assistant-config-snapshot/v1', slot.config); this.#assertLive(slot, true)
      return slot.config
    } catch (error) { slot.phase = 'blocked'; throw error }
  }
  config(runtime: object, lease: ManagedRuntimeLease): Config {
    const slot = this.#slot(runtime, lease)
    try { this.#assertLive(slot); if (!slot.config) invalid('missing pinned config'); return slot.config } catch (error) { slot.phase = 'blocked'; throw error }
  }
  runId(runtime: object, lease: ManagedRuntimeLease): string { const slot = this.#slot(runtime, lease); this.#assertLive(slot); return slot.runId! }
  admitExecutor(runtime: object, lease: ManagedRuntimeLease, input: AssistantExecutionRequest): AssistantExecutionRequest {
    const slot = this.#slot(runtime, lease)
    if (slot.busy || slot.bound) invalid('executor binding already reserved')
    slot.busy = true
    try {
      this.#assertLive(slot, true)
      if (!slot.config || input.config !== slot.config || input.runId !== slot.runId || canonical(input.route) !== canonical(slot.claim!.ingress.route)) invalid('executor run/config/route mismatch')
      const inputValues = managedOwnValues(input)
      const dataKeys = ['runId', 'route', 'messages', 'profileId', 'systemPrompt', 'maxOutputTokens', 'temperature', 'executionMode', 'executionHistorySize', 'executionTraceLabel', 'maxToolCalls', 'taskState', 'workspaceMemoryFile', 'workspaceTaskContextFile', 'workspaceContextFile', 'workspacePinnedContextFile', 'workspaceMetaFile', 'workspaceRootDir']
      const material = capture({ ...Object.fromEntries(dataKeys.filter(key => Object.hasOwn(input, key)).map(key => [key, inputValues[key]])), inbound: slot.claim!.ingress, sessionKey: slot.claim!.sessionKey, configDigest: slot.configDigest })
      const plan = Object.freeze({ ...input, ...Object.fromEntries(dataKeys.filter(key => Object.hasOwn(material, key)).map(key => [key, (material as Record<string, unknown>)[key]])) }) as AssistantExecutionRequest
      this.#ledger.bindRuntime({ identity: slot.claim!.identity, expectedRevision: 0, recordedAt: Date.now(), binding: { bindingVersion: 2, runtimeRunId: slot.runId!, ingressRecordId: slot.ingressId!, executorInputProtocol: 'assistant-executor-input/v1', executorInputDigest: digest('assistant-executor-input/v1', material) } })
      this.#assertLive(slot); slot.bound = true
      return plan
    } catch (error) { slot.phase = 'blocked'; throw error } finally { slot.busy = false }
  }
  assertBound(runtime: object, lease: ManagedRuntimeLease): void {
    const slot = this.#slot(runtime, lease)
    try {
      if (!slot.bound || slot.busy) invalid('executor binding not ready')
      this.#assertLive(slot)
      const binding = this.#ledger.getAttempt(slot.claim!.identity)?.state.binding, ingress = readManagedRuntimeIngress(this.#events, slot.claim!.identity)
      if (!binding || !('bindingVersion' in binding) || binding.runtimeRunId !== slot.runId || binding.ingressRecordId !== slot.ingressId || ingress?.id !== slot.ingressId) invalid('executor exact durable binding missing')
      this.#assertLive(slot)
    } catch (error) { slot.phase = 'blocked'; throw error }
  }
  assertReturned(runtime: object, lease: ManagedRuntimeLease): void {
    const slot = this.#slot(runtime, lease)
    try {
      this.assertBound(runtime, lease)
      if (this.#ledger.getAttempt(slot.claim!.identity)!.state.pendingIntents !== 0) invalid('pending tool intents prevent successful runtime completion')
    } catch (error) { slot.phase = 'blocked'; throw error }
  }
  prepareTool(runtime: object, lease: ManagedRuntimeLease, input: { invocationId: string; runtimeRunId: string; toolName: string; args: unknown; route: unknown; toolCallId?: string }): ManagedRuntimeTool {
    const slot = this.#slot(runtime, lease)
    if (slot.busy) invalid('tool recording reentrancy blocked')
    slot.busy = true
    try {
      const action = capture(input)
      this.#assertLive(slot)
      if (!slot.bound || action.runtimeRunId !== slot.runId || canonical(action.route) !== canonical(slot.claim!.ingress.route)) invalid('tool runtime run/route binding mismatch')
      const callKey = action.toolCallId ?? action.invocationId
      if (slot.calls.has(callKey) || this.#ledger.getIntent(slot.claim!.identity, action.invocationId)) invalid('managed invocation replay forbidden')
      slot.calls.add(callKey); slot.totalCalls++
      const policy = slot.claim!.ingress.execution
      if (policy?.maxToolCalls !== undefined && slot.totalCalls > policy.maxToolCalls) invalid('managed tool call budget exhausted')
      const attempt = this.#ledger.getAttempt(slot.claim!.identity)!
      this.#ledger.recordIntent({ identity: slot.claim!.identity, expectedRevision: attempt.revision, intent: { invocationId: action.invocationId, runtimeRunId: slot.runId!, toolName: action.toolName, argsDigest: digest('assistant-tool-args/v1', action.args) }, recordedAt: Date.now() })
      this.#assertLive(slot)
      const tool = opaque<ManagedRuntimeTool>(); this.#tools.set(tool, { slot, invocationId: action.invocationId, phase: 'intent' }); return tool
    } catch (error) { slot.phase = 'blocked'; throw error } finally { slot.busy = false }
  }
  startTool(runtime: object, lease: ManagedRuntimeLease, tool: ManagedRuntimeTool): void {
    const slot = this.#slot(runtime, lease), item = this.#tools.get(tool)
    this.assertBound(runtime, lease)
    if (!item || item.slot !== slot || item.phase !== 'intent') { slot.phase = 'blocked'; invalid('tool intent not uniquely dispatchable') }
    item.phase = 'started'
  }
  completeTool(runtime: object, lease: ManagedRuntimeLease, tool: ManagedRuntimeTool, receipt: { started: boolean; failed: boolean; value?: unknown; error?: { name?: string; message?: string; code?: string } }): 'reported-result' | 'unknown' {
    // Completion must still publish unknown after the owner aborts; no live dispatch
    // check here. A retained tool can finish after caller cancellation, never retry.
    const slot = this.#leases.get(lease), item = this.#tools.get(tool)
    if (!slot || runtime !== this.#runtime || !item || item.slot !== slot || item.phase === 'publishing' || item.phase === 'done' || slot.busy) invalid('tool outcome already reserved or invalid lease')
    item.phase = 'publishing'; slot.busy = true
    const priorPhase = slot.phase
    slot.phase = 'blocked'
    try {
      const result = capture(receipt)
      const metadata = result.value && typeof result.value === 'object' ? (result.value as { metadata?: { error?: { code?: string }; code?: string } }).metadata : undefined
      const unknown = result.started && result.failed || metadata?.error?.code === 'TOOL_EXECUTION_OUTCOME_UNKNOWN' || metadata?.code === 'TOOL_EXECUTION_OUTCOME_UNKNOWN'
      const kind = unknown ? 'unknown' : 'reported-result', identity = slot.claim!.identity, attempt = this.#ledger.getAttempt(identity)!
      this.#ledger.recordOutcome({ identity, expectedRevision: attempt.revision, invocationId: item.invocationId, outcome: { kind, resultDigest: digest('assistant-tool-receipt/v1', result), ...(unknown ? { errorCode: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' } : {}) }, recordedAt: Date.now() })
      item.phase = 'done'
      if (!unknown && priorPhase === 'active') slot.phase = 'active'
      return kind
    } finally { slot.busy = false }
  }
  finish(runtime: object, lease: ManagedRuntimeLease, failed: boolean): void {
    const slot = this.#leases.get(lease)
    if (!slot || runtime !== this.#runtime) return
    slot.phase = failed || slot.phase === 'blocked' ? 'blocked' : 'finished'
  }
  close(): void { this.#closed = true; this.#issuer.close() }
}
