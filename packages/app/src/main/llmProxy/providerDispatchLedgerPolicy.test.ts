import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyDispatchLedger, DISPATCH_LEDGER_LIMITS as L, emptyDispatchLedger, validateDispatchLedger, type DispatchLedgerCommand, type DispatchLedgerDocument } from './providerDispatchLedgerPolicy'
const owner = 'a'.repeat(64), profileHash = 'b'.repeat(64)
const begin = (expectedRevision = 0): Extract<DispatchLedgerCommand, { action: 'begin' }> => ({ action: 'begin', operationId: randomUUID(), runId: randomUUID(), expectedRevision, binding: { goalId: randomUUID(), generation: 2, profileHash }, maxProviderDispatches: 2, maxWalltimeMs: 100 })
const command = <T extends { action: 'reserve'; attemptId: string } | { action: 'settle'; attemptId: string; outcome: { state: 'not-dispatched' | 'unknown'; charged: true; grantsPermission: false } | { state: 'response-complete'; status: number; responseBytes: number; charged: true; grantsPermission: false } } | { action: 'finish' | 'orphan' }>(doc: DispatchLedgerDocument, value: T): T & { runId: string; expectedRevision: number; operationId: string } => ({ ...value, runId: doc.runs.at(-1)!.id, expectedRevision: doc.revision, operationId: randomUUID() })
const started = () => applyDispatchLedger(emptyDispatchLedger(owner), begin(), 100).document
const charge = (doc: DispatchLedgerDocument, at = 101) => applyDispatchLedger(doc, command(doc, { action: 'reserve', attemptId: randomUUID() }), at).document
const settle = (doc: DispatchLedgerDocument, state: 'not-dispatched' | 'unknown' = 'not-dispatched', at = 102) => applyDispatchLedger(doc, command(doc, { action: 'settle', attemptId: doc.runs.at(-1)!.attempts.at(-1)!.id, outcome: { state, charged: true, grantsPermission: false } }), at).document

describe('pure dispatch accounting policy, no capabilities, storage, runner or goal counters', () => {
  it('charges before dispatch, pending blocks another reserve, known not-dispatched does not refund', () => {
    const active = started(), first = charge(active)
    expect(first.runs[0]).toMatchObject({ status: 'active', chargedProviderDispatches: 1 })
    expect(() => charge(first, 102)).toThrow('pending')
    const known = settle(first), second = charge(known, 103)
    expect(second.runs[0].chargedProviderDispatches).toBe(2)
    expect(() => charge(settle(second, 'not-dispatched', 104), 105)).toThrow('budget')
    expect(active.runs[0].chargedProviderDispatches).toBe(0)
  })
  it('replays data receipts before stale CAS checks without a second charge or returned execution authority', () => {
    const active = started(), req = command(active, { action: 'reserve', attemptId: randomUUID() }), applied = applyDispatchLedger(active, req, 101)
    const current = settle(applied.document)
    const replay = applyDispatchLedger(current, Object.fromEntries(Object.entries(req).reverse()) as DispatchLedgerCommand, 1000)
    expect(replay).toMatchObject({ replay: true, document: { revision: 3, runs: [{ chargedProviderDispatches: 1 }] }, receipt: { revision: 2 } })
    expect(Object.keys(replay).sort()).toEqual(['document', 'receipt', 'replay'])
    expect(() => applyDispatchLedger(current, { ...req, attemptId: randomUUID() }, 1000)).toThrow('replay conflict')
    expect(() => applyDispatchLedger(current, { ...req, operationId: randomUUID() }, 103)).toThrow('revision')
  })
  it('rejects replay receipt identity mismatch even when corrupted hash/digest pairs still pass the transition FSM', () => {
    const req = begin(), active = applyDispatchLedger(emptyDispatchLedger(owner), req, 100).document
    const done = applyDispatchLedger(active, command(active, { action: 'finish' }), 101).document
    const first = { operationHash: done.receipts[0].operationHash, digest: done.receipts[0].digest }
    Object.assign(done.receipts[0], { operationHash: done.receipts[1].operationHash, digest: done.receipts[1].digest })
    Object.assign(done.receipts[1], first)
    expect(() => validateDispatchLedger(done)).not.toThrow() // Cryptographic origin/freshness is outside pure data validation.
    expect(() => applyDispatchLedger(done, req, 102)).toThrow('replay conflict')
  })
  it('rejects a forged matching receipt pair at the wrong operation revision without changing its valid FSM identities', () => {
    const pending = charge(started()), second = charge(settle(pending), 103), next = settle(second, 'not-dispatched', 104)
    const oldReq: DispatchLedgerCommand = { action: 'reserve', operationId: randomUUID(), expectedRevision: 1, runId: next.runs[0].id, attemptId: next.runs[0].attempts[1].id }
    const canonical = Object.fromEntries(Object.entries(oldReq).sort(([a], [b]) => a.localeCompare(b)))
    const candidate = next.receipts[3]
    candidate.operationHash = createHash('sha256').update(JSON.stringify([next.ownerHash, oldReq.operationId])).digest('hex')
    candidate.digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
    expect(() => validateDispatchLedger(next)).not.toThrow()
    expect(() => applyDispatchLedger(next, oldReq, 105)).toThrow('replay conflict')
  })
  it('settles HTTP failure as transport-only receipt, not goal success, then permits explicit finish', () => {
    const pending = charge(started()), id = pending.runs[0].attempts[0].id
    const req = command(pending, { action: 'settle', attemptId: id, outcome: { state: 'response-complete', status: 503, responseBytes: 10, charged: true, grantsPermission: false } })
    const saved = applyDispatchLedger(pending, req, 102), finished = applyDispatchLedger(saved.document, command(saved.document, { action: 'finish' }), 103).document
    expect(finished.runs[0]).toMatchObject({ status: 'finished', chargedProviderDispatches: 1, attempts: [{ outcome: { state: 'response-complete', status: 503 } }] })
    expect(applyDispatchLedger(finished, req, 1000)).toMatchObject({ replay: true, receipt: { revision: 3 } })
    expect(() => applyDispatchLedger(finished, command(finished, { action: 'settle', attemptId: id, outcome: { state: 'not-dispatched', charged: true, grantsPermission: false } }), 104)).toThrow('unavailable')
  })
  it('unknown is terminal and permanently fences even a different goal, run or generation', () => {
    const unknown = settle(charge(started()), 'unknown')
    expect(unknown.runs[0].status).toBe('unknown')
    expect(() => charge(unknown, 103)).toThrow('unavailable')
    expect(() => applyDispatchLedger(unknown, command(unknown, { action: 'finish' }), 103)).toThrow('unavailable')
    expect(() => applyDispatchLedger(unknown, begin(unknown.revision), 103)).toThrow('uncertain')
  })
  it.each([false, true])('orphan fencing covers an unfinished run even with no pending attempt (pending=%s)', pending => {
    const doc = pending ? charge(started()) : started()
    const orphan = applyDispatchLedger(doc, command(doc, { action: 'orphan' }), 1000).document
    expect(orphan.runs[0].status).toBe('unknown')
    if (pending) expect(orphan.runs[0].attempts[0]).toMatchObject({ outcome: { state: 'unknown', charged: true }, settledAt: 1000 })
    expect(() => applyDispatchLedger(orphan, begin(orphan.revision), 1001)).toThrow('uncertain')
  })
  it('checks the original absolute deadline on reservations but allows conservative settlement after expiry', () => {
    const active = started()
    expect(() => charge(active, 200)).toThrow('deadline')
    const pending = charge(active, 199), known = settle(pending, 'not-dispatched', 1000)
    expect(known.runs[0]).toMatchObject({ deadlineAt: 200, chargedProviderDispatches: 1 })
    expect(() => charge(known, 1001)).toThrow('deadline')
    expect(() => settle(pending, 'not-dispatched', 198)).toThrow('clock')
    expect(() => applyDispatchLedger(emptyDispatchLedger(owner), begin(), Number.MAX_SAFE_INTEGER - 1)).toThrow('deadline')
  })
  it('rejects new UUID conflicts and cross-owner stale operations, never silently evicting replay IDs', () => {
    const first = settle(charge(started())), finish = applyDispatchLedger(first, command(first, { action: 'finish' }), 103).document
    const next = applyDispatchLedger(finish, begin(finish.revision), 104).document
    expect(() => applyDispatchLedger(next, command(next, { action: 'reserve', attemptId: first.runs[0].attempts[0].id }), 105)).toThrow('identity')
    const req = begin(), a = applyDispatchLedger(emptyDispatchLedger(owner), req, 100), b = applyDispatchLedger(emptyDispatchLedger('c'.repeat(64)), req, 100)
    expect(a.receipt.operationHash).not.toBe(b.receipt.operationHash)
    expect(a.document.runs[0].binding).toEqual(b.document.runs[0].binding) // Policy data is NOT authorization; future owner capability is separate.
  })
  it('retains full bounded operation history through every max-sized run, leaving room for every settlement and finish', () => {
    let doc = emptyDispatchLedger(owner), now = 100
    for (let r = 0; r < L.runs; r++) {
      doc = applyDispatchLedger(doc, { ...begin(doc.revision), maxProviderDispatches: L.attempts, maxWalltimeMs: L.maxWalltimeMs }, now++).document
      for (let i = 0; i < L.attempts; i++) {
        doc = charge(doc, now++)
        doc = applyDispatchLedger(doc, command(doc, { action: 'settle', attemptId: doc.runs.at(-1)!.attempts.at(-1)!.id, outcome: { state: 'response-complete', status: 599, responseBytes: L.responseBytes, charged: true, grantsPermission: false } }), now++).document
      }
      doc = applyDispatchLedger(doc, command(doc, { action: 'finish' }), now++).document
    }
    expect(doc.revision).toBe(L.receipts); expect(doc.receipts).toHaveLength(L.receipts)
    expect(Buffer.byteLength(JSON.stringify(doc))).toBeLessThan(L.plainBytes - L.settlementHeadroom)
    expect(() => applyDispatchLedger(doc, begin(doc.revision), now)).toThrow()
    expect(doc.runs.every(run => run.status === 'finished' && run.chargedProviderDispatches === L.attempts)).toBe(true)
  })
  it('rejects clock rollback across a finished run and preserves the original replay receipt', () => {
    const doc = started(), finished = applyDispatchLedger(doc, command(doc, { action: 'finish' }), 1000).document
    expect(() => applyDispatchLedger(finished, begin(finished.revision), 100)).toThrow('clock')
    expect(() => applyDispatchLedger(finished, begin(finished.revision), 1001)).not.toThrow()
  })
  it('rejects a full forged receipt history with a pending attempt rather than treating it as valid', () => {
    const pending = charge(started()), original = structuredClone(pending.receipts[1])
    while (pending.receipts.length < L.receipts) pending.receipts.push({ ...original, revision: pending.receipts.length + 1, operationHash: pending.receipts.length.toString(16).padStart(64, '0') })
    pending.revision = pending.receipts.length
    expect(() => validateDispatchLedger(pending)).toThrow()
  })
  it('rejects orphaning a pending reservation whose record falsely claims it was not dispatched', () => {
    const doc = charge(started()), orphan = applyDispatchLedger(doc, command(doc, { action: 'orphan' }), 103).document
    orphan.runs[0].attempts[0].outcome = { state: 'not-dispatched', charged: true, grantsPermission: false }
    expect(() => validateDispatchLedger(orphan)).toThrow('orphan')
  })
  it('does not accept caller-defined actor, maxTurns aliases, plaintext request fields or grantsPermission', () => {
    const empty = emptyDispatchLedger(owner)
    for (const extra of [{ actor: 'user' }, { maxTurns: 1 }, { prompt: 'SECRET' }, { endpoint: 'https://provider.test' }, { grantsPermission: true }]) expect(() => applyDispatchLedger(empty, { ...begin(), ...extra } as DispatchLedgerCommand, 100)).toThrow('command')
    const pending = charge(started())
    expect(() => applyDispatchLedger(pending, command(pending, { action: 'settle', attemptId: pending.runs[0].attempts[0].id, outcome: { state: 'response-complete', status: 307, responseBytes: 1, charged: true, grantsPermission: false } }), 102)).toThrow('redirect')
  })
  it('rejects malformed stored counters, duplicate receipts, unsupported upgrades and chronology without mutating inputs', () => {
    const valid = settle(charge(started()))
    for (const edit of [
      (doc: DispatchLedgerDocument) => { doc.revision = 0; doc.receipts = [] },
      (doc: DispatchLedgerDocument) => { doc.receipts[1].action = 'begin'; delete doc.receipts[1].attemptId },
      (doc: DispatchLedgerDocument) => { doc.receipts[2].action = 'reserve' },
      (doc: DispatchLedgerDocument) => { doc.runs[0].chargedProviderDispatches = 0 },
      (doc: DispatchLedgerDocument) => { doc.runs[0].attempts[0].settledAt = 1 },
      (doc: DispatchLedgerDocument) => { doc.receipts.push(doc.receipts[0]); doc.revision++ },
      (doc: DispatchLedgerDocument) => { doc.runs[0].status = 'finished'; delete doc.runs[0].attempts[0].outcome; delete doc.runs[0].attempts[0].settledAt },
      (doc: DispatchLedgerDocument) => { (doc as unknown as Record<string, unknown>).actor = 'user' }
    ]) { const copy = structuredClone(valid); edit(copy); expect(() => validateDispatchLedger(copy)).toThrow() }
    expect(() => validateDispatchLedger(valid)).not.toThrow()
  })
})
