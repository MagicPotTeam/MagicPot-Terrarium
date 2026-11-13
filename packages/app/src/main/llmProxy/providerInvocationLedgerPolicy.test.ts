import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ProviderDispatchReceipt } from './providerDispatchFetch'
import { applyDispatchLedger, emptyDispatchLedger, type DispatchLedgerCommand } from './providerDispatchLedgerPolicy'
import { applyInvocationLedger as apply, emptyInvocationLedger as empty, upgradeInvocationLedger as upgrade, validateInvocationLedger as validate, type InvocationCommand, type InvocationLedgerDocument as Doc, type InvocationOutcome, type InvocationUnit, type InvocationUpgradeCommand } from './providerInvocationLedgerPolicy'
const owner = 'a'.repeat(64), binding = { goalId: randomUUID(), generation: 2, profileHash: 'b'.repeat(64) }
const known: InvocationOutcome = { state: 'completed', charged: true, grantsPermission: false }, unknown: InvocationOutcome = { state: 'unknown', charged: true, grantsPermission: false }
const transport = { state: 'response-complete' as const, status: 200, responseBytes: 4, charged: true as const, grantsPermission: false as const }
const begin = (doc: Doc = empty(owner), options = {}) => ({ action: 'begin-v2' as const, runId: randomUUID(), operationId: randomUUID(), expectedRevision: doc.revision, binding, limits: { maxModelSteps: 2, maxProviderDispatches: 3, maxToolInvocations: 2 }, maxWalltimeMs: 10000, ...options })
const start = () => apply(empty(owner), begin(), 100).document
function reserve(doc: Doc, unit: InvocationUnit, parentId?: string) { return { action: 'reserve-unit' as const, runId: doc.runs.at(-1)!.id, unitId: randomUUID(), unit, operationId: randomUUID(), expectedRevision: doc.revision, ...(parentId ? { parentId } : {}) } }
function finish(doc: Doc, action: 'finish-v2' | 'orphan-v2' = 'finish-v2') { return { action, runId: doc.runs.at(-1)!.id, operationId: randomUUID(), expectedRevision: doc.revision } }
function settle(doc: Doc, id: string, outcome: InvocationOutcome | ProviderDispatchReceipt = known) { return { action: 'settle-unit' as const, runId: doc.runs.at(-1)!.id, unitId: id, operationId: randomUUID(), expectedRevision: doc.revision, outcome } }
const model = (doc: Doc, at = 101) => { const command = reserve(doc, 'modelStep'); return { command, document: apply(doc, command, at).document } }
describe('isolated v2 hierarchical unit accounting DATA, not persistent admission or goal turns', () => {
  it('keeps independent charged counters and permits only model→dispatch nesting then sequential tools', () => {
    const m = model(start()), d = reserve(m.document, 'providerDispatch', m.command.unitId), pending = apply(m.document, d, 102).document
    expect(pending.runs[0].charged).toEqual({ modelStep: 1, toolInvocation: 0, providerDispatch: 1 })
    expect(() => apply(pending, reserve(pending, 'modelStep'), 103)).toThrow('overlaps')
    expect(() => apply(pending, reserve(pending, 'toolInvocation', m.command.unitId), 103)).toThrow('tool requires')
    expect(() => apply(pending, settle(pending, m.command.unitId), 103)).toThrow('before its child')
    const dispatched = apply(pending, settle(pending, d.unitId, transport), 103).document
    const d2 = reserve(dispatched, 'providerDispatch', m.command.unitId), retried = apply(dispatched, d2, 104).document
    const observed = apply(retried, settle(retried, d2.unitId, { ...transport, status: 503 }), 105).document
    const ready = apply(observed, settle(observed, m.command.unitId), 106).document
    const tool = reserve(ready, 'toolInvocation', m.command.unitId), charged = apply(ready, tool, 107).document
    const returned = apply(charged, settle(charged, tool.unitId), 108).document, ended = apply(returned, finish(returned), 109)
    expect(ended).toMatchObject({ replay: false, grantsPermission: false, document: { revision: 10, runs: [{ status: 'finished', charged: { modelStep: 1, providerDispatch: 2, toolInvocation: 1 } }] } })
    expect(start().runs[0].units).toEqual([])
  })
  it('a child unknown atomically closes its pending model and fences every later operation, even a new goal', () => {
    const m = model(start()), d = reserve(m.document, 'providerDispatch', m.command.unitId), pending = apply(m.document, d, 102).document
    const result = apply(pending, settle(pending, d.unitId, unknown), 103), run = result.document.runs[0]
    expect(run.status).toBe('unknown'); expect(run.units).toHaveLength(2)
    for (const record of run.units) expect(record).toMatchObject({ outcome: unknown, settledAt: 103 })
    expect(result.document.revision).toBe(4)
    expect(() => apply(result.document, settle(result.document, m.command.unitId), 104)).toThrow('unavailable')
    expect(() => apply(result.document, begin(result.document, { binding: { ...binding, goalId: randomUUID(), generation: 3 } }), 104)).toThrow('unavailable')
  })
  it.each(['modelStep', 'providerDispatch', 'toolInvocation'] as const)('unknown %s or orphan closes all pending frames without decrementing charge', kind => {
    const m = model(start()); let doc = m.document, id = m.command.unitId
    if (kind === 'providerDispatch') { const d = reserve(doc, kind, id); doc = apply(doc, d, 102).document; id = d.unitId }
    if (kind === 'toolInvocation') { doc = apply(doc, settle(doc, id), 102).document; const tool = reserve(doc, kind, id); doc = apply(doc, tool, 103).document; id = tool.unitId }
    const before = structuredClone(doc.runs[0].charged), unknownDoc = apply(doc, settle(doc, id, unknown), 104).document, orphan = apply(doc, finish(doc, 'orphan-v2'), 105).document
    for (const value of [unknownDoc, orphan]) { expect(value.runs[0].charged).toEqual(before); expect(value.runs[0].status).toBe('unknown'); expect(value.runs[0].units.every(unit => unit.outcome)).toBe(true) }
  })
  it('charges not-started and failed outcomes without refunds but never labels a model with children as not-started', () => {
    const m = model(start()), notStarted = apply(m.document, settle(m.document, m.command.unitId, { ...known, state: 'not-started' }), 102).document
    expect(notStarted.runs[0].charged.modelStep).toBe(1)
    expect(() => apply(notStarted, reserve(notStarted, 'toolInvocation', m.command.unitId), 103)).toThrow('completed model')
    const second = model(notStarted, 103), d = reserve(second.document, 'providerDispatch', second.command.unitId), sent = apply(second.document, d, 104).document
    const observed = apply(sent, settle(sent, d.unitId, { state: 'not-dispatched', charged: true, grantsPermission: false }), 105).document
    expect(() => apply(observed, settle(observed, second.command.unitId, { ...known, state: 'not-started' }), 106)).toThrow('with child')
    const failed = apply(observed, settle(observed, second.command.unitId, { ...known, state: 'failed' }), 106).document
    expect(failed.runs[0].charged).toEqual({ modelStep: 2, providerDispatch: 1, toolInvocation: 0 })
    expect(() => model(failed, 107)).toThrow('budget')
  })
  it('requires exact parent identities and distinct UUIDs across every unit/run including retired legacy identities', () => {
    const initial = start(), m = model(initial)
    expect(() => apply(initial, reserve(initial, 'providerDispatch'), 101)).toThrow('exact pending model')
    expect(() => apply(m.document, reserve(m.document, 'providerDispatch', randomUUID()), 102)).toThrow('exact pending model')
    expect(() => apply(m.document, { ...reserve(m.document, 'providerDispatch', m.command.unitId), unitId: m.command.unitId }, 102)).toThrow('reused')
    expect(() => apply(m.document, { ...reserve(m.document, 'providerDispatch', m.command.unitId), unitId: m.document.runs[0].id }, 102)).toThrow('reused')
    const done = apply(m.document, settle(m.document, m.command.unitId), 103).document
    expect(() => apply(done, reserve(done, 'toolInvocation', randomUUID()), 104)).toThrow('exact completed model')
  })
  it('refuses before charge on zero tools, wrong outcome type, redirect or oversized arbitrary outcome metadata', () => {
    let doc = apply(empty(owner), begin(empty(owner), { limits: { maxModelSteps: 1, maxToolInvocations: 0, maxProviderDispatches: 1 } }), 100).document
    const m = model(doc); doc = apply(m.document, settle(m.document, m.command.unitId), 102).document
    expect(() => apply(doc, reserve(doc, 'toolInvocation', m.command.unitId), 103)).toThrow('budget')
    expect(doc.runs[0].charged.toolInvocation).toBe(0)
    expect(() => apply(m.document, settle(m.document, m.command.unitId, transport), 103)).toThrow('does not match')
    const d = reserve(m.document, 'providerDispatch', m.command.unitId), p = apply(m.document, d, 102).document
    expect(() => apply(p, settle(p, d.unitId, { ...known, state: 'completed' }), 103)).toThrow('does not match')
    expect(() => apply(p, settle(p, d.unitId, { ...transport, status: 307 }), 103)).toThrow('redirect')
    expect(() => apply(p, { ...settle(p, d.unitId, transport), outcome: { ...transport, errorText: 'arbitrary' } } as InvocationCommand, 103)).toThrow('command invalid')
  })
  it('exact replay returns original data across stale revisions, never another unit or invocation permission', () => {
    const m = model(start()), req = settle(m.document, m.command.unitId), done = apply(m.document, req, 102).document, ended = apply(done, finish(done), 103).document
    expect(apply(ended, m.command, 1000)).toMatchObject({ replay: true, grantsPermission: false, receipt: { revision: 2 } })
    expect(apply(ended, req, 1000).document).toEqual(ended)
    expect(() => apply(ended, { ...m.command, unitId: randomUUID() }, 1001)).toThrow('replay conflict')
    expect(() => apply(ended, { ...m.command, expectedRevision: 0 }, 1001)).toThrow('replay conflict')
    expect(() => apply(ended, { ...m.command, operationId: randomUUID() }, 1001)).toThrow('revision')
  })
  it('preserves every original v1 run and exact replay receipt on explicit data-only upgrade without counting historical model/tool use', () => {
    const beginV1: DispatchLedgerCommand = { action: 'begin', runId: randomUUID(), operationId: randomUUID(), expectedRevision: 0, binding, maxProviderDispatches: 1, maxWalltimeMs: 10 }
    const started = applyDispatchLedger(emptyDispatchLedger(owner), beginV1, 10).document
    const old = applyDispatchLedger(started, { action: 'finish', runId: beginV1.runId, operationId: randomUUID(), expectedRevision: 1 }, 11).document
    const upgradeReq: InvocationUpgradeCommand = { action: 'upgrade-v2', expectedRevision: 2, operationId: randomUUID() }, converted = upgrade(old, upgradeReq, 12)
    expect(converted).toMatchObject({ grantsPermission: false, replay: false, document: { version: 2, revision: 3, legacy: old, runs: [] } })
    expect(converted.document.legacy).toEqual(old); expect(converted.document.legacy.runs[0]).not.toHaveProperty('charged.modelStep')
    expect(apply(converted.document, beginV1, 1000)).toMatchObject({ replay: true, grantsPermission: false, receipt: { revision: 1 } })
    expect(apply(converted.document, upgradeReq, 1000)).toMatchObject({ replay: true, receipt: { revision: 3 } })
    expect(() => apply(converted.document, { ...beginV1, operationId: randomUUID(), runId: randomUUID(), expectedRevision: 2 }, 20)).toThrow('fresh legacy')
    expect(() => apply(converted.document, { ...begin(converted.document), runId: beginV1.runId }, 20)).toThrow('unavailable')
    expect(() => upgrade(started, { action: 'upgrade-v2', expectedRevision: 1, operationId: randomUUID() }, 12)).toThrow('unavailable')
    const unknown = applyDispatchLedger(started, { action: 'orphan', runId: beginV1.runId, expectedRevision: 1, operationId: randomUUID() }, 12).document
    expect(() => upgrade(unknown, { action: 'upgrade-v2', expectedRevision: 2, operationId: randomUUID() }, 13)).toThrow('unavailable')
  })
  it('preserves full v1 history at four runs and refuses migration when all 264 receipts are already retained', () => {
    let old = emptyDispatchLedger(owner), clock = 1
    for (let run = 0; run < 4; run++) {
      const runId = randomUUID()
      old = applyDispatchLedger(old, { action: 'begin', runId, operationId: randomUUID(), expectedRevision: old.revision, binding, maxProviderDispatches: 32, maxWalltimeMs: 10000 }, clock++).document
      for (let attempt = 0; attempt < 32; attempt++) {
        const attemptId = randomUUID()
        old = applyDispatchLedger(old, { action: 'reserve', runId, attemptId, operationId: randomUUID(), expectedRevision: old.revision }, clock++).document
        old = applyDispatchLedger(old, { action: 'settle', runId, attemptId, operationId: randomUUID(), expectedRevision: old.revision, outcome: transport }, clock++).document
      }
      old = applyDispatchLedger(old, { action: 'finish', runId, operationId: randomUUID(), expectedRevision: old.revision }, clock++).document
    }
    expect(old.revision).toBe(264)
    const before = structuredClone(old)
    expect(() => upgrade(old, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 264 }, clock)).toThrow('unavailable')
    expect(old).toEqual(before); expect(old.runs).toHaveLength(4)
  })
  it('explicit upgrade preserves run capacity and refuses reused original operation IDs or implicit migration evidence', () => {
    let old = emptyDispatchLedger(owner)
    const original: DispatchLedgerCommand[] = []
    for (let i = 0; i < 4; i++) {
      const req: DispatchLedgerCommand = { action: 'begin', operationId: randomUUID(), expectedRevision: old.revision, runId: randomUUID(), binding, maxProviderDispatches: 1, maxWalltimeMs: 1000 }
      original.push(req); old = applyDispatchLedger(old, req, 100 + i * 2).document
      old = applyDispatchLedger(old, { action: 'finish', operationId: randomUUID(), expectedRevision: old.revision, runId: req.runId }, 101 + i * 2).document
    }
    expect(() => upgrade(old, { action: 'upgrade-v2', expectedRevision: old.revision, operationId: original[0].operationId }, 200)).toThrow('identity')
    const req: InvocationUpgradeCommand = { action: 'upgrade-v2', expectedRevision: old.revision, operationId: randomUUID() }, doc = upgrade(old, req, 200).document
    expect(() => apply(doc, begin(doc), 201)).toThrow('capacity')
    const broken = structuredClone(doc); delete broken.upgrade
    expect(() => validate(broken)).toThrow('upgrade history')
    expect(() => apply(doc, { ...req, expectedRevision: 0 }, 202)).toThrow('replay conflict')
    expect(() => apply(doc, { ...begin(doc), operationId: req.operationId }, 202)).toThrow('identity conflicts')
  })
  it('rejects corruption of hierarchy, missing receipts, counters, chronological settlement, state or migration evidence', () => {
    const m = model(start()), d = reserve(m.document, 'providerDispatch', m.command.unitId), p = apply(m.document, d, 102).document
    const done = apply(p, settle(p, d.unitId, unknown), 103).document
    for (const mutate of [
      (x: Doc) => { x.runs[0].units[1].parentId = randomUUID() },
      (x: Doc) => { x.runs[0].charged.modelStep = 0 },
      (x: Doc) => { x.receipts.splice(1, 1); x.revision-- },
      (x: Doc) => { x.runs[0].units[0].settledAt = 104 },
      (x: Doc) => { x.runs[0].status = 'active' },
      (x: Doc) => { x.runs[0].units[0].outcome = known },
      (x: Doc) => { x.receipts[2].parentId = randomUUID() },
      (x: Doc) => { x.legacy.ownerHash = 'c'.repeat(64) }
    ]) { const broken = structuredClone(done); mutate(broken); expect(() => validate(broken)).toThrow() }
  })
  it('detects outcome/deadline/binding/time corruption against independently retained payload commitments before replay', () => {
    const started = start(), m = model(started), req = settle(m.document, m.command.unitId), done = apply(m.document, req, 102).document
    const ended = apply(done, finish(done), 103).document
    for (const mutate of [
      (x: Doc) => { x.runs[0].units[0].outcome = { ...known, state: 'failed' } },
      (x: Doc) => { x.runs[0].deadlineAt++ },
      (x: Doc) => { x.runs[0].binding.generation++ },
      (x: Doc) => { x.receipts[0].begin!.maxWalltimeMs++; x.runs[0].deadlineAt++ },
      (x: Doc) => { x.receipts[2].outcome = { ...known, state: 'failed' }; x.runs[0].units[0].outcome = { ...known, state: 'failed' } },
      (x: Doc) => { x.receipts[2].at++ },
      (x: Doc) => { x.receipts[0].digest = '0'.repeat(64) }
    ]) {
      const broken = structuredClone(ended); mutate(broken)
      expect(() => validate(broken)).toThrow(); expect(() => apply(broken, req, 1000)).toThrow()
    }
  })
  it('retains original deadline and chronological clocks across model/dispatch/tool operations and permits cleanup after expiry', () => {
    const m = model(start())
    expect(() => apply(m.document, reserve(m.document, 'providerDispatch', m.command.unitId), 10100)).toThrow('deadline')
    expect(() => apply(m.document, reserve(m.document, 'providerDispatch', m.command.unitId), 100)).toThrow('clock')
    const cleanup = apply(m.document, settle(m.document, m.command.unitId, { ...known, state: 'not-started' }), 20000).document
    expect(cleanup.runs[0].deadlineAt).toBe(10100)
    expect(() => model(cleanup, 20001)).toThrow('deadline')
    expect(apply(cleanup, finish(cleanup), 20001).document.runs[0].status).toBe('finished')
  })
  it('validates original declared capacity at each historical begin, not only the currently pending frames', () => {
    let doc = apply(empty(owner), begin(empty(owner), { limits: { maxModelSteps: 32, maxToolInvocations: 32, maxProviderDispatches: 32 } }), 100).document, clock = 101
    for (let i = 0; i < 32; i++) {
      const m = model(doc, clock++), d = reserve(m.document, 'providerDispatch', m.command.unitId), sent = apply(m.document, d, clock++).document
      const done = apply(sent, settle(sent, d.unitId, transport), clock++).document, modelDone = apply(done, settle(done, m.command.unitId), clock++).document
      const tool = reserve(modelDone, 'toolInvocation', m.command.unitId), called = apply(modelDone, tool, clock++).document
      doc = apply(called, settle(called, tool.unitId), clock++).document
    }
    doc = apply(doc, finish(doc), clock++).document
    doc = apply(doc, begin(doc, { limits: { maxModelSteps: 1, maxToolInvocations: 0, maxProviderDispatches: 1 } }), clock++).document
    doc = apply(doc, finish(doc), clock++).document
    doc.runs[1].limits = { maxModelSteps: 32, maxToolInvocations: 32, maxProviderDispatches: 32 }
    const receipt = doc.receipts.find(item => item.runId === doc.runs[1].id && item.action === 'begin-v2')!
    receipt.begin!.limits = structuredClone(doc.runs[1].limits)
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value
    const payload = { action: 'begin-v2', expectedRevision: receipt.revision - 1, runId: receipt.runId, ...receipt.begin }
    // Deliberately rehash a self-consistent impossible admission. This must hit
    // historical capacity, not commitment/FSM-record mismatch. No authority here.
    receipt.digest = createHash('sha256').update(JSON.stringify(canonical({ operationHash: receipt.operationHash, at: receipt.at, payload }))).digest('hex')
    expect(() => validate(doc)).toThrow('begin receipt admits limits beyond retained capacity')
  })
  it('keeps known settlement and closure available near the real byte-admission ceiling without evicting history', () => {
    const at = Number.MAX_SAFE_INTEGER - 1000000
    let doc = apply(empty(owner), begin(empty(owner), { limits: { maxModelSteps: 32, maxToolInvocations: 32, maxProviderDispatches: 32 } }), at).document, clock = at + 1
    for (let i = 0; i < 32; i++) {
      const m = model(doc, clock++), d = reserve(m.document, 'providerDispatch', m.command.unitId), sent = apply(m.document, d, clock++).document
      const observed = apply(sent, settle(sent, d.unitId, { ...transport, status: 599, responseBytes: 64 * 1024 * 1024 }), clock++).document, completed = apply(observed, settle(observed, m.command.unitId), clock++).document
      const t = reserve(completed, 'toolInvocation', m.command.unitId), entered = apply(completed, t, clock++).document
      doc = apply(entered, settle(entered, t.unitId), clock++).document
    }
    doc = apply(doc, finish(doc), clock++).document
    doc = apply(doc, begin(doc, { limits: { maxModelSteps: 17, maxToolInvocations: 0, maxProviderDispatches: 17 } }), clock++).document
    let denied = false, crossedAdmissionCeiling = false
    for (let i = 0; i < 17; i++) {
      const before = doc
      try { doc = model(doc, clock++).document } catch (error) { expect(String(error)).toMatch(/headroom/); expect(doc).toEqual(before); denied = true; break }
      const id = doc.runs.at(-1)!.units.at(-1)!.id
      try { doc = apply(doc, reserve(doc, 'providerDispatch', id), clock++).document } catch (error) {
        expect(String(error)).toMatch(/headroom/); denied = true
        doc = apply(doc, settle(doc, id, { ...known, state: 'not-started' }), clock++).document
        break
      }
      const pending = doc.runs.at(-1)!.units.at(-1)!.id
      doc = apply(doc, settle(doc, pending, { ...transport, status: 599, responseBytes: 64 * 1024 * 1024 }), clock++).document
      crossedAdmissionCeiling ||= Buffer.byteLength(JSON.stringify(doc), 'utf8') > 128 * 1024 - 16 * 1024
      doc = apply(doc, settle(doc, id), clock++).document
      crossedAdmissionCeiling ||= Buffer.byteLength(JSON.stringify(doc), 'utf8') > 128 * 1024 - 16 * 1024
    }
    doc = apply(doc, finish(doc), clock).document
    expect(denied).toBe(true); expect(crossedAdmissionCeiling).toBe(true)
    expect(doc.runs.at(-1)!.status).toBe('finished'); expect(doc.runs[0].units).toHaveLength(96)
    expect(Buffer.byteLength(JSON.stringify(doc), 'utf8')).toBeLessThan(128 * 1024)
  })
  it('accounts maximum nested model/dispatch/tool histories within the SAME 264 retained receipt ceiling', () => {
    let doc = apply(empty(owner), begin(empty(owner), { limits: { maxModelSteps: 32, maxToolInvocations: 32, maxProviderDispatches: 32 } }), 100).document, clock = 101
    for (let i = 0; i < 32; i++) {
      const m = model(doc, clock++), d = reserve(m.document, 'providerDispatch', m.command.unitId), dispatched = apply(m.document, d, clock++).document
      const observed = apply(dispatched, settle(dispatched, d.unitId, transport), clock++).document, completed = apply(observed, settle(observed, m.command.unitId), clock++).document
      const tool = reserve(completed, 'toolInvocation', m.command.unitId), pending = apply(completed, tool, clock++).document; doc = apply(pending, settle(pending, tool.unitId), clock++).document
    }
    doc = apply(doc, finish(doc), clock++).document
    expect(doc.revision).toBe(194); expect(doc.runs[0].charged).toEqual({ modelStep: 32, providerDispatch: 32, toolInvocation: 32 })
    expect(() => apply(doc, begin(doc, { limits: { maxModelSteps: 32, maxToolInvocations: 32, maxProviderDispatches: 32 } }), clock)).toThrow('receipt capacity')
    doc = apply(doc, begin(doc, { limits: { maxModelSteps: 1, maxToolInvocations: 0, maxProviderDispatches: 1 } }), clock++).document
    doc = apply(doc, finish(doc), clock++).document
    expect(doc.runs).toHaveLength(2); expect(doc.runs[0].units).toHaveLength(96)
  })
})
