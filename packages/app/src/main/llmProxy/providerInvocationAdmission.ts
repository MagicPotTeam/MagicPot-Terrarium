import { createHash, randomUUID } from 'node:crypto'
import type { FetchImpl } from '@shared/llm/clients'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import { ProviderInvocationLedgerDataStore } from './providerDispatchLedgerStore'
import { DISPATCH_LEDGER_LIMITS, type DispatchLedgerBinding } from './providerDispatchLedgerPolicy'
import { validateInvocationLedger, type InvocationCommand, type InvocationLimits, type InvocationOutcome, type InvocationRun } from './providerInvocationLedgerPolicy'
import { createProviderDispatchFetch, type ProviderDispatchFetch, type ProviderDispatchReceipt } from './providerDispatchFetch'

declare const completedModelBrand: unique symbol
/** Exact-object association witness, NOT a tool permission, persistent ID or
 * invocation grant. Only the latest completed model in this instance qualifies. */
export type CompletedModel = Readonly<{ [completedModelBrand]: true }>
export type ProviderInvocationAdmissionOptions = {
  store: ProviderInvocationLedgerDataStore; scope: AgentThreadInteractionScope; binding: DispatchLedgerBinding
  expectedRevision: number; limits: InvocationLimits
  /** Original absolute deadline, captured by trusted MAIN; never renewed here. */
  deadlineAt: number; signal: AbortSignal; endpoint: string; fetch: FetchImpl
  assertLive(): void
  timeoutMs?: number; requestBytes?: number; responseBytes?: number
}
export type ProviderInvocationAdmission = {
  runModel<T>(entry: (scope: Readonly<{ fetch: FetchImpl; signal: AbortSignal }>) => Promise<T>): Promise<{ value: T; parent: CompletedModel }>
  runTool<T>(parent: CompletedModel, entry: (scope: Readonly<{ signal: AbortSignal }>) => Promise<T>): Promise<T>
  readonly state: 'ready' | 'active' | 'blocked' | 'finished' | 'disposed'
  /** Accounting closure only, not goal/model/business success. */
  finish(): void
  dispose(): void
  /** After dispose, await callback unwind and settlement BEFORE closing the
   * caller-owned store/ownership handle. An abort-ignoring entry may never drain. */
  drain(): Promise<void>
}
const fail = (reason: string) => Object.assign(new Error(`Invocation admission ${reason}.`), { code: 'PROVIDER_INVOCATION_ADMISSION', retryBlocked: true })
const thenable = (value: unknown) => Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function')
const outcome = (state: InvocationOutcome['state']): InvocationOutcome => ({ state, charged: true, grantsPermission: false })

/** Copy bounded materialized plain DATA, never a lazy Response, stream, function,
 * accessor, class instance or deferred capability. MAIN must still supply trusted
 * entries; this validation is not a hostile-JavaScript/process sandbox. */
function materialize<T>(source: T): T {
  const seen = new Set<object>(); let nodes = 0, bytes = 0
  const account = (text: string) => { bytes += Buffer.byteLength(text, 'utf8'); if (bytes > 1024 * 1024) throw fail('entry result exceeds materialized data budget') }
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 16384 || depth > 32) throw fail('entry result exceeds materialized data structure budget')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') { account(value); return value }
    if (typeof value !== 'object' || !value || seen.has(value)) throw fail('entry must return materialized plain data')
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw fail('entry result contains a lazy or non-plain object')
    seen.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> | unknown[] = array ? [] : {}
    const keys = Reflect.ownKeys(descriptors), length = array ? descriptors.length.value as number : 0
    if (keys.length > 16384 || array && keys.length !== length + 1) throw fail('entry result contains sparse or oversized data')
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string') throw fail('entry result contains a symbol')
      const property = descriptors[key]
      if (!('value' in property) || !property.enumerable || array && (!Number.isSafeInteger(Number(key)) || Number(key) < 0 || Number(key) >= length || String(Number(key)) !== key)) throw fail('entry result contains accessors or non-contiguous array indexes')
      account(key)
      Object.defineProperty(result, key, { value: copy(property.value, depth + 1), enumerable: true, writable: true, configurable: true })
    }
    seen.delete(value); return result
  }
  const result = copy(source, 0)
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024) throw fail('entry result exceeds encoded data budget')
  return result as T
}

type Frame = { id: string; unit: 'modelStep' | 'toolInvocation'; parentId?: string; reserved: boolean; invoked: boolean; viewLive: boolean; settled: boolean; attempted: boolean; closedByChild: boolean }
type DispatchTicket = { id: string; parent: Frame; settled: boolean; command?: Extract<InvocationCommand, { action: 'settle-unit' }> }

/** ISOLATED MAIN/TEST prerequisite, NO PRODUCTION IMPORT/UPGRADE/RUNNER. An
 * already-v2 payload, schema-valid options, witness or possession of this helper
 * establishes no user consent or tool permissions. MAIN must independently choose
 * trusted entries and authorize them. Same store/replay domain and policy limits;
 * no automatic retries, resume, eviction, compaction or rollback resistance.
 * Model steps count entry callbacks, tools count chosen provider entries (including
 * read/status), dispatches count fetch delegates. None are goal delivery turns,
 * token/currency charges or proof of supplier billing. Throwing after entry is
 * conservatively unknown; no caller-forgeable known-failed marker is accepted. */
export function createProviderInvocationAdmission(options: ProviderInvocationAdmissionOptions): ProviderInvocationAdmission {
  if (!(options.store instanceof ProviderInvocationLedgerDataStore) || typeof options.fetch !== 'function' || typeof options.assertLive !== 'function' || !(options.signal instanceof AbortSignal)) throw fail('requires isolated main-owned v2 DATA store and synchronous guard')
  const store = options.store, scope = structuredClone(options.scope), binding = structuredClone(options.binding), limits = structuredClone(options.limits)
  const parentSignal = options.signal, assertBinding = options.assertLive, originalDeadline = options.deadlineAt
  const controller = new AbortController(), signal = AbortSignal.any([parentSignal, controller.signal]), runId = randomUUID()
  let revision = options.expectedRevision, monotonicDeadline = Infinity, begun = false, stopping = false, blocked = false, uncertain = false, terminal = false, finished = false, closed = false
  let mutating = false, checking = false, finishing = false, slot: Frame | undefined, transportModel: Frame | undefined, pendingDispatch: object | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, activeDrain: Promise<void> | undefined
  let latest: CompletedModel | undefined
  const witnesses = new WeakMap<CompletedModel, Frame>(), tickets = new WeakMap<object, DispatchTicket>()
  const pinned = (run: InvocationRun) => run.binding.goalId === binding.goalId && run.binding.generation === binding.generation && run.binding.profileHash === binding.profileHash
  const write = (command: InvocationCommand, at = Date.now()) => {
    if (mutating || uncertain) throw fail('mutation is already active or unconfirmed')
    const expected = structuredClone(command); mutating = true
    try {
      const result = store.applyV2(scope, command, at)
      validateInvocationLedger(result.document)
      const receipt = result.receipt, run = result.document.runs.find(item => item.id === runId)
      const operationHash = createHash('sha256').update(JSON.stringify([result.document.ownerHash, expected.operationId])).digest('hex')
      if (result.replay || result.grantsPermission !== false || receipt.operationHash !== operationHash || !('at' in receipt) || receipt.at !== at || receipt.action !== expected.action || receipt.revision !== revision + 1 || result.document.revision !== revision + 1 || receipt.runId !== runId || !run || !pinned(run) || JSON.stringify(receipt) !== JSON.stringify(result.document.receipts.at(-1)) || ('unitId' in expected && receipt.unitId !== expected.unitId) || expected.action === 'reserve-unit' && (receipt.unit !== expected.unit || receipt.parentId !== expected.parentId) || expected.action === 'settle-unit' && JSON.stringify(receipt.outcome) !== JSON.stringify(expected.outcome)) throw fail('mutation receipt is not a fresh exact self-commit')
      if (expected.action === 'begin-v2' && (run.startedAt !== at || run.deadlineAt !== at + expected.maxWalltimeMs || JSON.stringify(run.limits) !== JSON.stringify(expected.limits))) throw fail('begin receipt does not match the original budget and deadline')
      revision = result.document.revision
      return run
    } catch (error) { blocked = uncertain = true; latest = undefined; throw error }
    finally { mutating = false }
  }
  /** DATA consistency only: settlement does not need a live goal/profile/signal. */
  const snapshot = () => {
    try {
      const value = store.readCurrent(scope), doc = value.document
      if (value.mutationBlocked || value.orphaned || doc.version !== 2 || doc.revision !== revision) throw fail('ledger changed, became orphaned or lost mutation ownership')
      const run = doc.runs.find(item => item.id === runId)
      if (!run || run.status !== 'active' || !pinned(run)) throw fail('pinned run is no longer active')
      return run
    } catch (error) { blocked = uncertain = true; latest = undefined; throw error }
  }
  const liveFlags = () => {
    if (!begun || stopping || blocked || uncertain || terminal || finished) throw fail('request is no longer live')
    signal.throwIfAborted()
    if (Date.now() >= originalDeadline || performance.now() >= monotonicDeadline) throw fail('original run deadline expired')
  }
  const bindingGuard = () => {
    const result: unknown = assertBinding()
    if (thenable(result)) { void Promise.resolve(result).catch(() => undefined); throw fail('binding guard must complete synchronously') }
  }
  const assertLive = () => {
    if (checking || mutating) throw fail('live verification is reentrant or a mutation is active')
    checking = true
    try { liveFlags(); bindingGuard(); liveFlags(); snapshot(); liveFlags(); bindingGuard(); liveFlags() }
    catch (error) { blocked = true; latest = undefined; throw error }
    finally { checking = false }
  }
  const orphan = () => {
    if (!begun || finished || closed || terminal || uncertain || mutating || checking || finishing || slot || pendingDispatch || transport.state === 'active') return
    try { snapshot(); write({ action: 'orphan-v2', operationId: randomUUID(), expectedRevision: revision, runId }); terminal = blocked = true }
    catch { blocked = true } // Not clearance: preserve uncertain durable history for inspection/reopen.
  }
  const stop = (reason: unknown = fail('disposed or original deadline expired')) => {
    if (finished) return
    stopping = true; latest = undefined
    if (slot) slot.viewLive = false
    clearTimeout(timer); parentSignal.removeEventListener('abort', onAbort)
    if (!controller.signal.aborted) controller.abort(reason)
    transport?.dispose(); orphan()
  }
  function onAbort() { stop(parentSignal.reason) }
  const settleEntry = (frame: Frame, receipt: InvocationOutcome) => {
    if (slot !== frame || !frame.reserved || frame.settled || frame.attempted || uncertain || pendingDispatch) throw fail('entry settlement has no exact pending capability')
    frame.attempted = true
    snapshot()
    const run = write({ action: 'settle-unit', operationId: randomUUID(), expectedRevision: revision, runId, unitId: frame.id, outcome: receipt })
    frame.settled = true
    if (receipt.state === 'unknown') { if (run.status !== 'unknown') { uncertain = blocked = true; throw fail('unknown entry closure was not confirmed') }; terminal = blocked = true; latest = undefined }
  }
  const activeModel = () => {
    const frame = transportModel
    if (!frame || slot !== frame || frame.unit !== 'modelStep' || !frame.invoked || !frame.viewLive || frame.settled || checking || mutating) throw fail('fetch view does not belong to the exact executing model')
    assertLive(); return frame
  }
  // Validate endpoint/resources before any begin write. One transport, but NEVER
  // a run-wide fetch. Each callback gets its own ephemeral identity-bound view.
  const transport: ProviderDispatchFetch = createProviderDispatchFetch({ endpoint: options.endpoint, fetch: options.fetch, signal, assertLive: activeModel, timeoutMs: options.timeoutMs, requestBytes: options.requestBytes, responseBytes: options.responseBytes,
    reserve() {
      const parent = activeModel()
      if (pendingDispatch) throw fail('a child dispatch is pending')
      const id = randomUUID(), ticket = Object.freeze({})
      write({ action: 'reserve-unit', operationId: randomUUID(), expectedRevision: revision, runId, unitId: id, unit: 'providerDispatch', parentId: parent.id })
      tickets.set(ticket, { id, parent, settled: false }); pendingDispatch = ticket
      return ticket // Even Stop during commit must let transport record charged not-dispatched.
    },
    settle(ticket: object, receipt: ProviderDispatchReceipt) {
      const owned = tickets.get(ticket)
      if (!owned || owned.settled || owned.command || pendingDispatch !== ticket || slot !== owned.parent) throw fail('dispatch settlement capability is foreign or was already attempted')
      owned.command = { action: 'settle-unit', operationId: randomUUID(), expectedRevision: revision, runId, unitId: owned.id, outcome: structuredClone(receipt) }
      snapshot()
      const run = write(owned.command)
      owned.settled = true; pendingDispatch = undefined; transportModel = undefined
      if (receipt.state === 'unknown') {
        // Reconcile ONLY this fresh acknowledged child transition. No read/replay,
        // UUID permit, second parent settlement or active-only snapshot afterward.
        if (run.status !== 'unknown' || run.units.find(item => item.id === owned.id)?.outcome?.state !== 'unknown' || run.units.find(item => item.id === owned.parent.id)?.outcome?.state !== 'unknown' || run.units.some(item => !item.outcome)) { blocked = uncertain = true; throw fail('atomic unknown child/parent closure was not confirmed') }
        owned.parent.settled = owned.parent.closedByChild = true; owned.parent.viewLive = false
        terminal = blocked = true; stop(fail('child outcome closed the pending model unknown'))
      }
    }
  })
  const scopedFetch = (frame: Frame): FetchImpl => async (input, init) => {
    if (slot !== frame || !frame.viewLive || !frame.invoked || frame.settled || checking || mutating || finishing) throw fail('fetch view is revoked or belongs to another model')
    if (transport.state !== 'idle') throw fail('a dispatch is already active or fenced')
    transportModel = frame
    try { return await transport.fetch(input, init) }
    finally { if (!pendingDispatch) transportModel = undefined }
  }
  // A timed-out caller can stop waiting, but occupancy/cleanup belongs to the
  // original callback until it REALLY unwinds. Never close its store speculatively.
  const wait = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? fail('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
  const launch = <T>(unit: Frame['unit'], entry: (frame: Frame) => Promise<T>, parent?: CompletedModel): Promise<{ value: T; parent: CompletedModel } | T> => {
    if (typeof entry !== 'function' || slot || finishing || checking || mutating) return Promise.reject(fail('entry overlaps an occupied callback, finish or verification'))
    const previous = parent && witnesses.get(parent)
    if (unit === 'toolInvocation' && (!parent || parent !== latest || !previous?.settled || previous.unit !== 'modelStep' || previous.closedByChild)) return Promise.reject(fail('tool requires the exact latest completed model association'))
    const frame: Frame = { id: randomUUID(), unit, ...(previous ? { parentId: previous.id } : {}), reserved: false, invoked: false, viewLive: false, settled: false, attempted: false, closedByChild: false }
    slot = frame; if (unit === 'modelStep') latest = undefined
    let drained!: () => void
    activeDrain = new Promise<void>(resolve => { drained = resolve })
    const work = (async () => {
      try {
        assertLive()
        write({ action: 'reserve-unit', operationId: randomUUID(), expectedRevision: revision, runId, unitId: frame.id, unit, ...(frame.parentId ? { parentId: frame.parentId } : {}) }); frame.reserved = true
        assertLive()
        frame.invoked = true; frame.viewLive = unit === 'modelStep'
        let raw: T
        try { raw = await entry(frame) }
        finally { frame.viewLive = false } // Revoke BEFORE any materialization/parent settlement.
        if (frame.closedByChild) throw fail('model was atomically closed unknown by its child')
        if (pendingDispatch || transport.state !== 'idle') throw fail('entry returned before its child reached observed EOF')
        assertLive()
        const value = materialize(raw)
        assertLive(); settleEntry(frame, outcome('completed')); assertLive()
        if (unit === 'toolInvocation') return value
        const witness = Object.freeze({}) as CompletedModel
        witnesses.set(witness, frame); latest = witness
        return { value, parent: witness }
      } catch (error) {
        frame.viewLive = false; blocked = true; stop(error)
        if (frame.reserved && !frame.settled && !frame.attempted && !uncertain && !pendingDispatch) settleEntry(frame, outcome(frame.invoked ? 'unknown' : 'not-started'))
        throw error
      } finally {
        frame.viewLive = false; slot = undefined; if (stopping) orphan(); drained(); activeDrain = undefined
      }
    })()
    return wait(work)
  }
  parentSignal.addEventListener('abort', onAbort, { once: true })
  try {
    signal.throwIfAborted()
    const current = store.readCurrent(scope)
    if (current.document.version !== 2 || current.document.revision !== revision || current.mutationBlocked || current.orphaned) throw fail('requires already-v2 data at the exact revision; no automatic upgrade')
    bindingGuard(); signal.throwIfAborted()
    const now = Date.now(), remaining = originalDeadline - now
    if (!Number.isSafeInteger(originalDeadline) || !Number.isSafeInteger(remaining) || remaining < 1 || remaining > DISPATCH_LEDGER_LIMITS.maxWalltimeMs) throw fail('invalid original deadline')
    monotonicDeadline = performance.now() + remaining
    const run = write({ action: 'begin-v2', operationId: randomUUID(), expectedRevision: revision, runId, binding, limits, maxWalltimeMs: remaining }, now)
    begun = true
    if (run.deadlineAt > originalDeadline) throw fail('begin moved the original deadline')
    assertLive(); timer = setTimeout(() => stop(), Math.max(0, Math.min(originalDeadline - Date.now(), monotonicDeadline - performance.now())))
  } catch (error) { stop(error); throw error }
  return {
    runModel<T>(entry: (context: Readonly<{ fetch: FetchImpl; signal: AbortSignal }>) => Promise<T>): Promise<{ value: T; parent: CompletedModel }> {
      if (typeof entry !== 'function') return Promise.reject(fail('requires a trusted entry callback'))
      return launch('modelStep', frame => entry(Object.freeze({ fetch: scopedFetch(frame), signal }))) as Promise<{ value: T; parent: CompletedModel }>
    },
    runTool<T>(parent: CompletedModel, entry: (context: Readonly<{ signal: AbortSignal }>) => Promise<T>): Promise<T> {
      if (typeof entry !== 'function') return Promise.reject(fail('requires a trusted entry callback'))
      return launch('toolInvocation', () => entry(Object.freeze({ signal })), parent) as Promise<T>
    },
    get state() { return finished ? 'finished' : blocked || uncertain || terminal || transport.state === 'blocked' ? 'blocked' : stopping ? 'disposed' : slot || mutating ? 'active' : 'ready' },
    finish() {
      if (slot || pendingDispatch || mutating || checking || finishing || transport.state !== 'idle') throw fail('cannot finish with occupied or uncertain entries')
      finishing = true
      try {
        assertLive(); write({ action: 'finish-v2', operationId: randomUUID(), expectedRevision: revision, runId }); closed = true
        // Data is finished, so do NOT apply an active-run snapshot. Still reject
        // successful delivery if Stop/config/deadline changed during settlement.
        liveFlags(); checking = true; try { bindingGuard(); liveFlags() } finally { checking = false }
        finished = true; clearTimeout(timer); parentSignal.removeEventListener('abort', onAbort); transport.dispose(); controller.abort(fail('accounting finished'))
      } catch (error) { blocked = true; stop(error); throw error }
      finally { finishing = false; if (stopping) orphan() }
    },
    dispose: () => stop(),
    drain: () => activeDrain ?? Promise.resolve()
  }
}
