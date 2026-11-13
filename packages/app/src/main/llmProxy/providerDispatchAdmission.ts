import { randomUUID } from 'node:crypto'
import type { FetchImpl } from '@shared/llm/clients'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import { createProviderDispatchFetch, type ProviderDispatchFetch, type ProviderDispatchReceipt } from './providerDispatchFetch'
import { ProviderDispatchLedgerStore } from './providerDispatchLedgerStore'
import { DISPATCH_LEDGER_LIMITS, type DispatchLedgerBinding, type DispatchLedgerCommand, type DispatchLedgerDocument } from './providerDispatchLedgerPolicy'

export type ProviderDispatchAdmissionOptions = {
  store: ProviderDispatchLedgerStore; scope: AgentThreadInteractionScope; binding: DispatchLedgerBinding
  expectedRevision: number; maxProviderDispatches: number; maxWalltimeMs: number
  endpoint: string; fetch: FetchImpl; signal: AbortSignal
  /** Synchronous MAIN-captured binding/profile/configuration guard; not model data.
   * Production must establish provenance before constructing this isolated helper. */
  assertLive(): void
  timeoutMs?: number; requestBytes?: number; responseBytes?: number
}
export type ProviderDispatchAdmission = {
  fetch: FetchImpl
  readonly state: 'ready' | 'active' | 'blocked' | 'finished' | 'disposed'
  /** Accounting end only, NOT goal/model/business completion. */
  finish(): void
  dispose(): void
}
const fail = (reason: string) => Object.assign(new Error(`Dispatch admission ${reason}.`), { code: 'PROVIDER_DISPATCH_ADMISSION', retryBlocked: true })
const thenable = (value: unknown) => Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function')

/** Isolated integration prerequisite, NOT production goal admission or a runner.
 * Caller possession of this API or schema-valid data does not establish user
 * consent. Only trusted user-selected capped goal recordkeeping constructs it
 * through the fixed owner; no model tool or autonomous pursuit scheduler does.
 * Only provider-delegate invocations
 * are charged here; maxTurns/modelSteps/toolCalls remain distinct, unimplemented.
 * Private memory-identity tickets never leave these closures. Replayed ledger
 * DATA, IDs and a new instance cannot restore tickets. Any uncertain mutation,
 * external revision or binding failure fences rather than auto-rebases/retries.
 * AEAD/SQLite do NOT provide hostile rollback resistance or exactly-once billing.
 * Ordinary permission checks/wake/user provenance/exclusive production ownership
 * are separate prerequisites, not supplied by assertLive or this helper. */
export function createProviderDispatchAdmission(options: ProviderDispatchAdmissionOptions): ProviderDispatchAdmission {
  if (typeof options.fetch !== 'function' || typeof options.assertLive !== 'function' || !(options.store instanceof ProviderDispatchLedgerStore)) throw fail('requires main-owned store and synchronous callbacks')
  const scope = structuredClone(options.scope), binding = structuredClone(options.binding)
  const store = options.store, parentSignal = options.signal, assertBinding = options.assertLive
  const controller = new AbortController(), signal = AbortSignal.any([parentSignal, controller.signal])
  const maxProviderDispatches = options.maxProviderDispatches, maxWalltimeMs = options.maxWalltimeMs
  const runId = randomUUID()
  let revision = options.expectedRevision, deadlineAt = 0, monotonicDeadline = Infinity
  let begun = false, retired = false, finished = false, blocked = false, mutating = false, finishing = false
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let pending: object | undefined
  const tickets = new WeakMap<object, { attemptId: string; settled: boolean; command?: Extract<DispatchLedgerCommand, { action: 'settle' }> }>()
  const clock = () => Date.now()
  const write = (command: DispatchLedgerCommand) => {
    if (mutating) throw fail('mutation is already in progress')
    mutating = true
    try {
      const result = store.apply(scope, command, clock())
      if (result.replay || result.receipt.revision !== revision + 1 || result.document.revision !== revision + 1 || result.receipt.runId !== runId) throw fail('mutation receipt is not a fresh exact self-commit')
      revision = result.document.revision
      return result.document
    } catch (error) { blocked = true; throw error }
    finally { mutating = false }
  }
  const snapshot = (): DispatchLedgerDocument => {
    const value = store.read(scope)
    if (value.mutationBlocked || value.orphaned || value.document.revision !== revision) throw fail('ledger changed, became orphaned or lost mutation ownership')
    const run = value.document.runs.find(run => run.id === runId)
    if (!run || run.status !== 'active' || JSON.stringify(run.binding) !== JSON.stringify(binding)) throw fail('pinned run binding is no longer current')
    return value.document
  }
  const assertLive = () => {
    try {
      if (!begun || retired || finished || blocked) throw fail('request is no longer live')
      signal.throwIfAborted()
      if (clock() >= deadlineAt || performance.now() >= monotonicDeadline) throw fail('original run deadline expired')
      const result: unknown = assertBinding()
      if (thenable(result)) { void Promise.resolve(result).catch(() => undefined); throw fail('binding guard must complete synchronously') }
      signal.throwIfAborted()
      if (retired || blocked || clock() >= deadlineAt || performance.now() >= monotonicDeadline) throw fail('binding guard revoked or expired this request')
      snapshot()
      signal.throwIfAborted()
      if (retired || blocked || clock() >= deadlineAt || performance.now() >= monotonicDeadline) throw fail('ledger verification revoked or expired this request')
    } catch (error) { blocked = true; throw error }
  }
  const orphan = () => {
    if (!begun || finished || mutating || pending) return
    try {
      const value = store.read(scope)
      if (value.mutationBlocked || value.orphaned || value.document.revision !== revision) { blocked = true; return }
      if (value.document.runs.find(run => run.id === runId)?.status === 'active') write({ action: 'orphan', runId, expectedRevision: revision, operationId: randomUUID() })
    } catch { blocked = true } // Failure is not clearance; durable active/pending remains fenced on reopen.
  }
  const settle = (ticket: object, outcome: ProviderDispatchReceipt) => {
    const owned = tickets.get(ticket)
    if (!owned || owned.settled || owned.command || pending !== ticket) { blocked = true; throw fail('settlement capability does not belong to the pending reservation or was already attempted') }
    owned.command = { action: 'settle', runId, attemptId: owned.attemptId, expectedRevision: revision, operationId: randomUUID(), outcome: structuredClone(outcome) }
    // Do not require a still-live goal or deadline to record an already charged
    // attempt. The exact pinned ledger revision/instance remains mandatory.
    try {
      snapshot()
      write(owned.command) // One immutable original command, never retried with a new operation ID.
      owned.settled = true; pending = undefined
      if (outcome.state === 'unknown') blocked = true
      if (retired) orphan()
    } catch (error) { blocked = true; throw error }
  }
  // Validate endpoint/resource options BEFORE creating persistent run data.
  const transport: ProviderDispatchFetch = createProviderDispatchFetch({ endpoint: options.endpoint, fetch: options.fetch, signal, assertLive, timeoutMs: options.timeoutMs, requestBytes: options.requestBytes, responseBytes: options.responseBytes,
    reserve() {
      assertLive()
      if (pending) throw fail('a charged reservation is pending')
      const attemptId = randomUUID(), ticket = Object.freeze({})
      write({ action: 'reserve', runId, attemptId, expectedRevision: revision, operationId: randomUUID() })
      tickets.set(ticket, { attemptId, settled: false }); pending = ticket
      // Return even if an in-transaction callback revoked the caller. The
      // transport must settle charged not-dispatched, never silently lose it.
      return ticket
    }, settle
  })
  const dispose = () => {
    if (retired || finished) return
    retired = true; clearTimeout(expiryTimer); parentSignal.removeEventListener('abort', dispose); controller.abort(fail('disposed or original run deadline expired'))
    transport.dispose(); orphan()
  }
  parentSignal.addEventListener('abort', dispose, { once: true })
  try {
    signal.throwIfAborted()
    const result: unknown = assertBinding()
    if (thenable(result)) { void Promise.resolve(result).catch(() => undefined); throw fail('binding guard must complete synchronously') }
    signal.throwIfAborted()
    if (!Number.isSafeInteger(maxWalltimeMs) || maxWalltimeMs < 1 || maxWalltimeMs > DISPATCH_LEDGER_LIMITS.maxWalltimeMs) throw fail('invalid run walltime')
    monotonicDeadline = performance.now() + maxWalltimeMs
    const doc = write({ action: 'begin', runId, binding, maxProviderDispatches, maxWalltimeMs, expectedRevision: revision, operationId: randomUUID() })
    begun = true; deadlineAt = doc.runs.find(run => run.id === runId)!.deadlineAt
    assertLive()
    const remaining = Math.max(0, Math.min(deadlineAt - clock(), monotonicDeadline - performance.now()))
    expiryTimer = setTimeout(dispose, remaining) // Revoke even while fetch/read is suspended or the run is idle.
  } catch (error) { dispose(); orphan(); throw error }
  return {
    fetch: async (input, init) => {
      if (finishing) throw fail('cannot dispatch during accounting finish')
      try { return await transport.fetch(input, init) }
      catch (error) { if (retired || blocked || signal.aborted) orphan(); throw error }
    },
    get state() { return finished ? 'finished' : blocked || transport.state === 'blocked' ? 'blocked' : retired ? 'disposed' : transport.state === 'active' ? 'active' : 'ready' },
    finish() {
      if (finishing || transport.state !== 'idle' || pending || mutating) throw fail('cannot finish with an active or uncertain dispatch')
      finishing = true
      try {
        assertLive()
        write({ action: 'finish', runId, expectedRevision: revision, operationId: randomUUID() })
        if (retired || blocked || signal.aborted) throw fail('finish receipt lost live ownership; accounting data may remain finished')
        finished = true; clearTimeout(expiryTimer); parentSignal.removeEventListener('abort', dispose); transport.dispose(); controller.abort(fail('accounting run finished'))
      } catch (error) { blocked = true; dispose(); orphan(); throw error }
      finally { finishing = false }
    },
    dispose
  }
}
