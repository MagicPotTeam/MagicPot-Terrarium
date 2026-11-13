import { randomUUID } from 'node:crypto'
import type { MagicAgentEventStore, ResourceMutationInput, ManagedResourceCommitOutcome } from '../persistence/eventStore'
import { assertManagedResourceCommitOutcome, canonicalJson } from '../persistence/eventStore'
import type { CooperativeExecutionController } from './cooperativeExecutionController'
import { captureManagedData, managedOwnValues } from './managedRuntimeSnapshot'

export type ManagedFirstRunPhase = 'preparing' | 'awaiting-birth-approval' | 'birthing' | 'awaiting-start-approval' | 'accepting' | 'accepted' | 'executing' | 'draining' | 'publishing' | 'retiring' | 'retired' | 'faulted'
export type ManagedFirstRunOperation = 'birth' | 'start' | 'retirement' | 'terminal'
type Owner = { controller: AbortController; cooperativeExecution: CooperativeExecutionController; phase: string; stopRequested: boolean; managed?: ManagedFirstRunOwnerState }
type Ownership = { active: ReadonlyMap<string, Owner>; closing: Promise<void> | undefined }
type Operation = { canonical: string; disposition: 'pending' | 'committed' | 'rolled-back'; complete: boolean }
const mutationMaterial = (input: ResourceMutationInput) => ({ operation: input.operation, kind: input.kind, id: input.id, idempotencyKey: input.idempotencyKey, createdAt: input.createdAt, event: input.event,
  ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }), ...(input.operation === 'delete' ? {} : { state: input.state }) })
export const canonicalManagedFirstRunBatch = (inputs: readonly ResourceMutationInput[]): string => canonicalJson(inputs.map(mutationMaterial))
function invalid(): never { throw Error('Managed first-run owner or concrete commit binding is no longer current.') }

/** Additional MAIN-only concrete narrowing. Never a caller callback or standalone
 * policy grant. The only instance-indexed owner remains lifecycle.active. */
export class ManagedFirstRunOwnerState {
  readonly epoch = Symbol('managed-first-run-owner')
  // Non-secret request identity only. Not an owner/admission token, cannot be
  // chosen by an intent and is never reused when prebirth IDs are reused.
  readonly #policyEpoch = randomUUID()
  get policyEpoch(): string { return this.#policyEpoch }
  phase: ManagedFirstRunPhase = 'preparing'
  dispatchClaimed = false
  dispatchSealed = false
  #revoked = false
  #operations = new Map<ManagedFirstRunOperation, Operation>()
  #birth?: { instance: unknown; requestDigest: string }
  #start?: { requestDigest: string; acceptance: { protocol: string; runId: string; finalInputDigest: string }; generation: string; sessionKey: string }
  #terminal?: { witness: 'producer-closure' | 'accepted-never-dispatched'; status: string }
  #provenance?: { environment: object; facade: object; plan: object; finalInputDigest: string }
  constructor(
    readonly events: MagicAgentEventStore,
    readonly ownership: Ownership,
    readonly instanceId: string,
    readonly runId: string,
    readonly owner: Owner,
    readonly controller: AbortController,
    readonly root: CooperativeExecutionController
  ) {}
  revoke(reason: unknown): void { this.#revoked = true; this.dispatchSealed = true; this.controller.abort(reason) }
  get revoked(): boolean { return this.#revoked || this.controller.signal.aborted || this.owner.stopRequested || Boolean(this.ownership.closing) }
  assertOriginal(): void {
    if (this.ownership.active.get(this.instanceId) !== this.owner) invalid()
    const owner = managedOwnValues(this.owner)
    if (owner.controller !== this.controller || owner.cooperativeExecution !== this.root || owner.managed !== this || owner.phase === 'faulted' || this.phase === 'faulted' || this.phase === 'retired') invalid()
  }
  assertDispatch(): void {
    this.assertOriginal()
    if (this.revoked || this.dispatchSealed || !this.#provenance) invalid()
  }
  assertCompletion(): void { this.assertOriginal(); if (!this.#provenance || !this.dispatchSealed) invalid() }
  prepare(environment: object, facade: object, plan: object, finalInputDigest: string): void {
    this.assertOriginal()
    if (this.#provenance || this.phase !== 'preparing') invalid()
    this.#provenance = Object.freeze({ environment, facade, plan, finalInputDigest })
    this.assertDispatch()
  }
  approveBirth(instance: unknown, requestDigest: string): void {
    this.assertDispatch()
    if (this.phase !== 'awaiting-birth-approval' || this.#birth) invalid()
    this.#birth = { instance: captureManagedData(instance), requestDigest }; this.phase = 'birthing'
  }
  approveStart(requestDigest: string, generation: string, sessionKey: string, acceptance: { protocol: string; runId: string; finalInputDigest: string }): void {
    this.assertDispatch()
    if (this.phase !== 'awaiting-start-approval' || this.#start || acceptance.runId !== this.runId || acceptance.finalInputDigest !== this.#provenance?.finalInputDigest) invalid()
    this.#start = { requestDigest, generation, sessionKey, acceptance: captureManagedData(acceptance) }; this.phase = 'accepting'
  }
  claimDispatch(): void {
    this.assertDispatch()
    if (this.phase !== 'accepted' || this.dispatchClaimed || !this.isPublished('start')) invalid()
    // Burn before invoking the facade. A throwing start is not never-dispatched.
    this.dispatchClaimed = true; this.phase = 'executing'
  }
  sealProducer(outcome: { runId: string; finalInputDigest: string; outcome: string }): void {
    this.assertOriginal()
    if (!this.dispatchClaimed || this.phase !== 'draining' || outcome.runId !== this.runId || outcome.finalInputDigest !== this.#provenance?.finalInputDigest) invalid()
    this.dispatchSealed = true; this.#terminal = { witness: 'producer-closure', status: outcome.outcome }
  }
  sealNeverDispatched(): void {
    this.assertOriginal()
    if (this.dispatchClaimed || !this.isPublished('start') || this.phase !== 'accepted') invalid()
    this.dispatchSealed = true; this.#terminal = { witness: 'accepted-never-dispatched', status: 'cancelled' }
  }
  get terminal(): Readonly<{ witness: 'producer-closure' | 'accepted-never-dispatched'; status: string }> { if (!this.#terminal) invalid(); return Object.freeze({ ...this.#terminal }) }
  isPublished(operation: ManagedFirstRunOperation): boolean { const op = this.#operations.get(operation); return op?.disposition === 'committed' && op.complete }
  canRetirePreparation(): boolean {
    return !this.dispatchClaimed && !this.isPublished('start') && [...this.#operations.values()].every(op => op.disposition === 'rolled-back' || op.disposition === 'committed' && op.complete)
  }
  reserve(operation: ManagedFirstRunOperation, inputs: readonly ResourceMutationInput[]): ManagedFirstRunCommitFence {
    this.assertOriginal()
    if (this.#operations.has(operation)) invalid()
    this.#assertOperation(operation, inputs)
    const canonical = canonicalManagedFirstRunBatch(inputs)
    this.#operations.set(operation, { canonical, disposition: 'pending', complete: false })
    return new ManagedFirstRunCommitFence(this, operation, canonical)
  }
  #assertOperation(operation: ManagedFirstRunOperation, inputs: readonly ResourceMutationInput[]): void {
    const detached = JSON.parse(canonicalManagedFirstRunBatch(inputs)) as ResourceMutationInput[]
    const instance = detached[0], state = instance?.state as { id?: string; status?: string }
    if (instance?.kind !== 'agent-instance' || instance.id !== this.instanceId || state?.id !== this.instanceId) invalid()
    if (operation === 'birth') {
      this.assertDispatch()
      if (this.phase !== 'birthing' || !this.#birth || detached.length !== 2 || instance.operation !== 'create' || canonicalJson(instance.state) !== canonicalJson(this.#birth.instance) || detached[1].kind !== 'managed-agent-instance-coverage') invalid()
    } else if (operation === 'start') {
      this.assertDispatch()
      const coverage = detached[1]?.state as { generation?: string; status?: string; accepted?: { identity?: { authorizedRequestDigest?: string; sessionKey?: string }; acceptance?: unknown } }
      const attempt = detached[2]?.state as { status?: string; acceptance?: unknown }
      if (this.phase !== 'accepting' || !this.#start || !this.isPublished('birth') || detached.length !== 3 || instance.operation !== 'update' || instance.expectedRevision !== 0 || state.status !== 'running' || detached[1].kind !== 'managed-agent-instance-coverage' || detached[1].expectedRevision !== 0 || coverage.status !== 'dirty' || coverage.generation !== this.#start.generation || coverage.accepted?.identity?.authorizedRequestDigest !== this.#start.requestDigest || coverage.accepted?.identity?.sessionKey !== this.#start.sessionKey || canonicalJson(coverage.accepted?.acceptance) !== canonicalJson(this.#start.acceptance) || detached[2].kind !== 'managed-agent-execution-attempt' || attempt.status !== 'open' || canonicalJson(attempt.acceptance) !== canonicalJson(this.#start.acceptance)) invalid()
    } else if (operation === 'retirement') {
      if (this.phase !== 'retiring' || !this.root.isQuiescent() || !this.canRetirePreparation() || !this.isPublished('birth') || detached.length !== 1 || instance.expectedRevision !== 0 || state.status !== 'removed') invalid()
    } else {
      const terminal = (detached[1]?.state as { terminal?: { witness?: string; status?: string; runId?: string; finalInputDigest?: string } })?.terminal
      this.assertCompletion()
      if (this.phase !== 'publishing' || !this.root.isQuiescent() || !this.isPublished('start') || !this.#terminal || detached.length !== 2 || instance.expectedRevision !== 1 || state.status !== 'stopped' || detached[1].kind !== 'managed-agent-execution-attempt' || detached[1].expectedRevision !== 0 || terminal?.witness !== this.#terminal.witness || terminal.status !== this.#terminal.status || terminal.runId !== this.runId || terminal.finalInputDigest !== this.#provenance?.finalInputDigest) invalid()
    }
  }
  assertFence(operation: ManagedFirstRunOperation, events: MagicAgentEventStore, canonical: string, epoch: symbol): void {
    this.assertOriginal()
    const op = this.#operations.get(operation)
    if (events !== this.events || epoch !== this.epoch || op?.canonical !== canonical || op.disposition !== 'pending') invalid()
    if (operation === 'birth' || operation === 'start') this.assertDispatch()
    else if (operation === 'terminal') this.assertCompletion()
    if ((operation === 'terminal' || operation === 'retirement') && !this.root.isQuiescent()) invalid()
    // Shape was captured before registration. Do not rerun canRetirePreparation:
    // this operation itself is now deliberately pending/burned.
    const expected = { birth: 'birthing', start: 'accepting', retirement: 'retiring', terminal: 'publishing' } as const
    if (this.phase !== expected[operation]) invalid()
  }
  observe(fence: ManagedFirstRunCommitFence, outcome: ManagedResourceCommitOutcome, inputs: readonly ResourceMutationInput[]): void {
    const proof = fences.get(fence)
    if (!proof || proof.state !== this) invalid()
    assertManagedResourceCommitOutcome(outcome, this.events, fence, inputs)
    const operation = this.#operations.get(proof.operation)
    if (!operation || operation.disposition !== 'pending') invalid()
    operation.disposition = outcome.kind
  }
  complete(operation: ManagedFirstRunOperation): void {
    const op = this.#operations.get(operation)
    if (op?.disposition !== 'committed' || op.complete) invalid()
    op.complete = true
  }
}
type FenceProof = { state: ManagedFirstRunOwnerState; operation: ManagedFirstRunOperation; canonical: string; epoch: symbol }
const fences = new WeakMap<ManagedFirstRunCommitFence, FenceProof>()
declare const fenceBrand: unique symbol
export class ManagedFirstRunCommitFence {
  declare readonly [fenceBrand]: true
  constructor(state: ManagedFirstRunOwnerState, operation: ManagedFirstRunOperation, canonical: string) {
    fences.set(this, { state, operation, canonical, epoch: state.epoch }); Object.freeze(this)
  }
}
export function isManagedFirstRunCommitFence(value: unknown): value is ManagedFirstRunCommitFence { return typeof value === 'object' && value !== null && fences.has(value as ManagedFirstRunCommitFence) }
export function assertManagedFirstRunCommitFence(fence: ManagedFirstRunCommitFence, events: MagicAgentEventStore, inputs: readonly ResourceMutationInput[]): void {
  const proof = fences.get(fence)
  if (!proof) invalid()
  proof.state.assertFence(proof.operation, events, canonicalManagedFirstRunBatch(inputs), proof.epoch)
}
