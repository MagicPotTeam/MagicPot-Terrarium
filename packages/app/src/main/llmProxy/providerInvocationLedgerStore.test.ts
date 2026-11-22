import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { ProviderDispatchLedgerStore, ProviderInvocationLedgerDataStore, ProviderLedgerVersionError } from './providerDispatchLedgerStore'
import { type DispatchLedgerCommand } from './providerDispatchLedgerPolicy'
import { type InvocationCommand, type InvocationLedgerDocument, type InvocationOutcome, type InvocationUnit, type InvocationUpgradeCommand } from './providerInvocationLedgerPolicy'
import { sideScope as scope, sideTestCodec } from '../api/agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
const roots: string[] = [], stores: ProviderDispatchLedgerStore[] = []
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'invocation-data-')); roots.push(root)
  const file = path.join(root, 'ledger-v1.sqlite'), codec = sideTestCodec(), store = new ProviderInvocationLedgerDataStore(codec, file); stores.push(store)
  return { store, codec, file, reopen() { store.close(); const next = new ProviderInvocationLedgerDataStore(codec, file); stores.push(next); return next } }
}
const binding = { goalId: randomUUID(), generation: 1, profileHash: 'b'.repeat(64) }
const upgradeReq = (revision = 0): InvocationUpgradeCommand => ({ action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: revision })
const begin = (revision: number): Extract<InvocationCommand, { action: 'begin-v2' }> => ({ action: 'begin-v2', operationId: randomUUID(), expectedRevision: revision, runId: randomUUID(), binding, limits: { maxModelSteps: 2, maxToolInvocations: 2, maxProviderDispatches: 3 }, maxWalltimeMs: 10000 })
const reserve = (runId: string, expectedRevision: number, unit: InvocationUnit = 'modelStep', parentId?: string): Extract<InvocationCommand, { action: 'reserve-unit' }> => ({ action: 'reserve-unit', operationId: randomUUID(), runId, expectedRevision, unitId: randomUUID(), unit, ...(parentId ? { parentId } : {}) })
const complete: InvocationOutcome = { state: 'completed', charged: true, grantsPermission: false }
const settlement = (req: ReturnType<typeof reserve>, expectedRevision: number, outcome: InvocationOutcome = complete): Extract<InvocationCommand, { action: 'settle-unit' }> => ({ action: 'settle-unit', operationId: randomUUID(), runId: req.runId, expectedRevision, unitId: req.unitId, outcome })
const legacyBegin = (revision = 0): Extract<DispatchLedgerCommand, { action: 'begin' }> => ({ action: 'begin', operationId: randomUUID(), runId: randomUUID(), expectedRevision: revision, binding, maxProviderDispatches: 1, maxWalltimeMs: 1000 })
function upgraded() { const t = setup(), req = upgradeReq(); t.store.upgradeV2(scope, req, 100); return { ...t, req } }
function running() { const t = upgraded(), req = begin(1); t.store.applyV2(scope, req, 101); return { ...t, begin: req } }
function nested() {
  const t = running(), model = reserve(t.begin.runId, 2); t.store.applyV2(scope, model, 102)
  const dispatch = reserve(t.begin.runId, 3, 'providerDispatch', model.unitId); t.store.applyV2(scope, dispatch, 103)
  return { ...t, model, dispatch }
}
const dbOf = (store: ProviderDispatchLedgerStore) => (store as unknown as { db: NodeSQLiteAdapter }).db

describe('same-file v2 encrypted DATA adapter, never invocation permission or production opt-in', () => {
  it('keeps missing owners v1 on reads and upgrades only explicitly in the same schema/envelope/AAD', () => {
    const t = setup(), db = dbOf(t.store), originalSchema = db.all('SELECT type,name,sql FROM sqlite_master')
    expect(t.store.readCurrent(scope)).toMatchObject({ document: { version: 1, revision: 0 }, grantsPermission: false })
    expect(db.get('SELECT count(*) AS n FROM dispatch_ledger')?.n).toBe(0)
    const encrypt = vi.spyOn(t.codec, 'encryptBytes'), req = upgradeReq(), upgraded = t.store.upgradeV2(scope, req, 100)
    expect(upgraded).toMatchObject({ replay: false, grantsPermission: false, document: { version: 2, revision: 1, legacy: { revision: 0, runs: [] }, runs: [] } })
    expect(encrypt.mock.calls[0][1]).toBe(`magicpot-dispatch-ledger-v1:${upgraded.document.ownerHash}:1`)
    expect(db.all('SELECT type,name,sql FROM sqlite_master')).toEqual(originalSchema)
    expect(db.get('PRAGMA user_version')?.user_version).toBe(1)
    expect(t.store.readCurrent(scope)).toMatchObject({ orphaned: false, mutationBlocked: false, grantsPermission: false, document: upgraded.document })
    expect(t.store.readCurrent({ ...scope, conversationId: 'other' }).document).toMatchObject({ version: 1, revision: 0 })
    expect(t.reopen().readCurrent(scope).document).toEqual(upgraded.document)
  })
  it('preserves exact legacy history and original replay digests, never backfills model/tool zero or reowns on upgrade/replay', () => {
    const t = setup(), req = legacyBegin(); t.store.apply(scope, req, 100)
    const reserve: DispatchLedgerCommand = { action: 'reserve', operationId: randomUUID(), runId: req.runId, attemptId: randomUUID(), expectedRevision: 1 }
    t.store.apply(scope, reserve, 101)
    const settled: DispatchLedgerCommand = { action: 'settle', operationId: randomUUID(), runId: req.runId, attemptId: reserve.attemptId, expectedRevision: 2, outcome: { state: 'response-complete', status: 200, responseBytes: 2, charged: true, grantsPermission: false } }
    t.store.apply(scope, settled, 102); t.store.apply(scope, { action: 'finish', operationId: randomUUID(), runId: req.runId, expectedRevision: 3 }, 103)
    const old = t.store.read(scope).document, convert = upgradeReq(4), upgraded = t.store.upgradeV2(scope, convert, 104)
    expect(upgraded.document.legacy).toEqual(old); expect(upgraded.document.runs).toEqual([])
    expect(upgraded.document.legacy.runs[0]).not.toHaveProperty('charged.modelStep')
    const reopened = t.reopen()
    expect(reopened.applyV2(scope, settled, 105)).toMatchObject({ replay: true, grantsPermission: false, receipt: old.receipts[2] })
    expect(reopened.upgradeV2(scope, convert, 105)).toMatchObject({ replay: true, grantsPermission: false, document: upgraded.document })
    expect(() => reopened.applyV2(scope, legacyBegin(4), 106)).toThrow('fresh legacy')
    expect(reopened.readCurrent(scope).mutationBlocked).toBe(false)
    const start = begin(5); reopened.applyV2(scope, start, 107)
    expect(reopened.applyV2(scope, reserve, 108).replay).toBe(true)
    expect(reopened.readCurrent(scope).orphaned).toBe(false) // old replay does not erase fresh v2 ownership either
    const owned = { action: 'reserve-unit' as const, operationId: randomUUID(), runId: start.runId, expectedRevision: 6, unitId: randomUUID(), unit: 'modelStep' as const }
    expect(reopened.applyV2(scope, owned, 109).replay).toBe(false)
  })
  it('v1 reads and mutations fail closed on v2 without poisoning or changing its data, and v2 write requires explicit upgrade', () => {
    const t = setup(), req = begin(0)
    expect(() => t.store.applyV2(scope, req, 100)).toThrow(ProviderLedgerVersionError)
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: false, document: { version: 1, revision: 0 } })
    t.store.upgradeV2(scope, upgradeReq(), 100)
    const before = t.store.readCurrent(scope)
    expect(() => t.store.read(scope)).toThrow(ProviderLedgerVersionError)
    expect(() => t.store.apply(scope, legacyBegin(1), 101)).toThrow('unsupported by the v1 API')
    expect(t.store.readCurrent(scope)).toEqual(before)
    expect(t.store.applyV2(scope, begin(1), 102).document.version).toBe(2)
    const reopened = t.reopen()
    expect(() => reopened.read(scope)).toThrow('unsupported')
    expect(reopened.readCurrent(scope)).toMatchObject({ mutationBlocked: false, orphaned: true })
  })
  it('base production store has no upgrade/applyV2 methods and rejects borrowed facade methods by exact identity', () => {
    const store = new ProviderDispatchLedgerStore(sideTestCodec()); stores.push(store)
    expect(store).not.toHaveProperty('applyV2'); expect(store).not.toHaveProperty('upgradeV2')
    expect(() => ProviderInvocationLedgerDataStore.prototype.upgradeV2.call(store, scope, upgradeReq(), 100)).toThrow('identity')
    expect(() => ProviderInvocationLedgerDataStore.prototype.applyV2.call(store, scope, begin(0), 100)).toThrow('identity')
    expect(store.read(scope)).toMatchObject({ mutationBlocked: false, document: { version: 1, revision: 0 } })
  })
  it.each(['active', 'unknown'] as const)('refuses upgrade of %s v1 without clearing history or poisoning a known policy rejection', status => {
    const t = setup(), req = legacyBegin(); t.store.apply(scope, req, 100)
    if (status === 'unknown') t.store.apply(scope, { action: 'orphan', operationId: randomUUID(), runId: req.runId, expectedRevision: 1 }, 101)
    const before = t.store.read(scope)
    expect(() => t.store.upgradeV2(scope, upgradeReq(before.document.revision), 102)).toThrow('unavailable')
    expect(t.store.read(scope)).toEqual(before)
  })
  it('persists nested charged DATA encrypted and reopening/replay never restores model/dispatch ownership', () => {
    const t = nested(), before = t.store.readCurrent(scope), text = readFileSync(t.file).toString('latin1')
    for (const secret of [binding.goalId, binding.profileHash, t.model.unitId, t.dispatch.unitId, t.req.operationId]) expect(text).not.toContain(secret)
    expect(before).toMatchObject({ orphaned: false, document: { version: 2, revision: 4, runs: [{ status: 'active', charged: { modelStep: 1, toolInvocation: 0, providerDispatch: 1 } }] } })
    const reopened = t.reopen()
    expect(reopened.readCurrent(scope)).toMatchObject({ orphaned: true, grantsPermission: false, document: before.document })
    expect(reopened.applyV2(scope, t.model, 104)).toMatchObject({ replay: true, grantsPermission: false, receipt: { revision: 3 } })
    expect(() => reopened.applyV2(scope, settlement(t.model, 4, { ...complete, state: 'unknown' }), 105)).toThrow('Orphan')
    expect(reopened.readCurrent(scope).orphaned).toBe(true)
    const fenced = reopened.applyV2(scope, { action: 'orphan-v2', operationId: randomUUID(), runId: t.begin.runId, expectedRevision: 4 }, 106)
    expect(fenced.document.runs[0]).toMatchObject({ status: 'unknown', charged: { modelStep: 1, providerDispatch: 1 } })
    expect(fenced.document.runs[0].units.every(unit => unit.outcome?.state === 'unknown')).toBe(true)
    expect(() => reopened.applyV2(scope, begin(5), 107)).toThrow('unavailable')
    expect(() => reopened.applyV2(scope, settlement(t.model, 5), 107)).toThrow('unavailable')
  })
  it('unknown child settlement atomically persists parent closure once and never issues an invocation permit', () => {
    const t = nested(), end = settlement(t.dispatch, 4, { ...complete, state: 'unknown' }), result = t.store.applyV2(scope, end, 104)
    expect(result).toMatchObject({ grantsPermission: false, replay: false, document: { revision: 5, runs: [{ status: 'unknown' }] } })
    expect(result.document.runs[0].units.every(unit => unit.outcome?.state === 'unknown' && unit.settledAt === 104)).toBe(true)
    expect(t.store.applyV2(scope, end, 105)).toMatchObject({ replay: true, receipt: { revision: 5 }, grantsPermission: false })
    expect(t.reopen().readCurrent(scope).document).toEqual(result.document)
  })
  it('serializes two real connections but fresh begin ownership belongs only to its confirmed instance, never upgrade or replay', () => {
    const t = setup(), other = new ProviderInvocationLedgerDataStore(t.codec, t.file); stores.push(other)
    const req = upgradeReq(); t.store.upgradeV2(scope, req, 100)
    expect(other.upgradeV2(scope, req, 101).replay).toBe(true)
    const start = begin(1); t.store.applyV2(scope, start, 102)
    expect(() => other.applyV2(scope, begin(1), 103)).toThrow('revision')
    expect(other.applyV2(scope, start, 103)).toMatchObject({ replay: true, grantsPermission: false })
    expect(() => other.applyV2(scope, reserve(start.runId, 2), 104)).toThrow('Orphan')
    other.applyV2(scope, { action: 'orphan-v2', operationId: randomUUID(), runId: start.runId, expectedRevision: 2 }, 105)
    expect(() => t.store.applyV2(scope, reserve(start.runId, 3), 106)).toThrow('unavailable')
    expect(t.store.readCurrent(scope)).toMatchObject({ mutationBlocked: false, document: { revision: 3, runs: [{ status: 'unknown' }] } })
    expect(t.store.readCurrent({ ...scope, conversationId: 'separate' }).document).toMatchObject({ version: 1, revision: 0 })
  })
  it.each(['upgrade', 'begin', 'nested-settlement'] as const)('lost %s COMMIT acknowledgement retains committed data without recovered ownership', mode => {
    const t = mode === 'nested-settlement' ? nested() : upgraded(), db = dbOf(t.store), exec = db.exec.bind(db)
    const target = { ...scope, conversationId: 'upgrade-lost' }, req = mode === 'upgrade' ? upgradeReq() : mode === 'begin' ? begin(1) : settlement((t as ReturnType<typeof nested>).dispatch, 4, { ...complete, state: 'unknown' })
    vi.spyOn(db, 'exec').mockImplementation(sql => { const result = exec(sql); if (sql === 'COMMIT') throw new Error('Lost v2 COMMIT acknowledgement'); return result })
    expect(() => mode === 'upgrade' ? t.store.upgradeV2(target, req as InvocationUpgradeCommand, 105) : t.store.applyV2(scope, req, 105)).toThrow('Lost v2 COMMIT')
    const current = t.store.readCurrent(mode === 'upgrade' ? target : scope)
    expect(current.mutationBlocked).toBe(true)
    expect(current.document.version).toBe(2)
    expect(() => t.store.upgradeV2(target, upgradeReq(), 106)).toThrow('blocked')
    vi.restoreAllMocks()
    const reopened = t.reopen(), result = mode === 'upgrade' ? reopened.upgradeV2(target, req as InvocationUpgradeCommand, 107) : reopened.applyV2(scope, req, 107)
    expect(result).toMatchObject({ replay: true, grantsPermission: false })
    if (mode === 'begin') { expect(reopened.readCurrent(scope).orphaned).toBe(true); expect(() => reopened.applyV2(scope, reserve((req as ReturnType<typeof begin>).runId, result.document.revision), 108)).toThrow('Orphan') }
    if (mode === 'nested-settlement') expect(result.document.runs[0].units.every(unit => unit.outcome?.state === 'unknown')).toBe(true)
  })
  it.each(['upgrade', 'nested-reserve'] as const)('lost BEGIN acknowledgement rolls back native transaction and poisons only uncertain %s writer', mode => {
    const t = mode === 'upgrade' ? setup() : running(), db = dbOf(t.store), exec = db.exec.bind(db), before = t.store.readCurrent(scope)
    vi.spyOn(db, 'exec').mockImplementation(sql => { const result = exec(sql); if (sql === 'BEGIN IMMEDIATE') throw new Error('Lost v2 BEGIN acknowledgement'); return result })
    expect(() => mode === 'upgrade' ? t.store.upgradeV2(scope, upgradeReq(), 104) : t.store.applyV2(scope, reserve((t as ReturnType<typeof running>).begin.runId, 2), 104)).toThrow('Lost v2 BEGIN')
    expect(db.database.isTransaction).toBe(false)
    expect(t.store.readCurrent(scope)).toMatchObject({ mutationBlocked: true, document: before.document })
  })
  it.each(['upgrade', 'model', 'dispatch', 'tool'] as const)('rejects swallowed public-read reentrancy during tentative %s ciphertext verification and never publishes a receipt', kind => {
    const t = kind === 'upgrade' ? setup() : running(), db = dbOf(t.store), decrypt = t.codec.decryptBytes.bind(t.codec)
    let request: InvocationCommand | InvocationUpgradeCommand, expectedRevision = 0
    if (kind === 'upgrade') request = upgradeReq()
    else {
      const start = (t as ReturnType<typeof running>).begin
      if (kind === 'model') request = reserve(start.runId, 2)
      else {
        const m = reserve(start.runId, 2); t.store.applyV2(scope, m, 102)
        if (kind === 'dispatch') request = reserve(start.runId, 3, 'providerDispatch', m.unitId)
        else { t.store.applyV2(scope, settlement(m, 3), 103); request = reserve(start.runId, 4, 'toolInvocation', m.unitId) }
      }
      expectedRevision = request.expectedRevision
    }
    const before = t.store.readCurrent(scope), snapshots: unknown[] = []
    vi.spyOn(t.codec, 'decryptBytes').mockImplementation((bytes, aad, maximum) => {
      const value = decrypt(bytes, aad, maximum)
      if (aad.endsWith(`:${expectedRevision + 1}`)) { try { snapshots.push(t.store.readCurrent(scope)) } catch { /* Swallowed callback rejection must still poison outer operation. */ } }
      return value
    })
    expect(() => kind === 'upgrade' ? t.store.upgradeV2(scope, request as InvocationUpgradeCommand, 104) : t.store.applyV2(scope, request, 104)).toThrow('revoked during write verification')
    expect(snapshots).toEqual([]); expect(db.database.isTransaction).toBe(false)
    expect(t.store.readCurrent(scope)).toMatchObject({ mutationBlocked: true, document: before.document })
  })
  it('guards input snapshot accessors before any native transaction and captures mutable commands only once', () => {
    const t = running(), req = reserve(t.begin.runId, 2), db = dbOf(t.store), before = t.store.readCurrent(scope), exec = vi.spyOn(db, 'exec')
    let reads = 0
    Object.defineProperty(req, 'unitId', { enumerable: true, get() { reads++; try { t.store.readCurrent(scope) } catch { /* Invalidate outer snapshot. */ }; return randomUUID() } })
    expect(() => t.store.applyV2(scope, req, 102)).toThrow('input capture')
    expect(reads).toBe(1); expect(exec).not.toHaveBeenCalled()
    expect(t.store.readCurrent(scope)).toMatchObject({ mutationBlocked: true, document: before.document })
  })
  it('a confirmed upgrade never resumes another process or transfers a fresh run data-ownership through replay', () => {
    const t = running(), next = t.reopen(), before = next.readCurrent(scope)
    expect(next.upgradeV2(scope, t.req, 103)).toMatchObject({ replay: true, grantsPermission: false })
    expect(next.readCurrent(scope)).toEqual(before)
    expect(() => next.applyV2(scope, reserve(t.begin.runId, 2), 104)).toThrow('Orphan')
  })
  it('known child/model/tool settlements and finish persist without suggesting real provider or tool invocation', () => {
    const t = nested(), response = { ...settlement(t.dispatch, 4), outcome: { state: 'response-complete' as const, status: 200, responseBytes: 8, charged: true as const, grantsPermission: false as const } }
    t.store.applyV2(scope, response, 104); t.store.applyV2(scope, settlement(t.model, 5), 105)
    const tool = reserve(t.begin.runId, 6, 'toolInvocation', t.model.unitId); t.store.applyV2(scope, tool, 106)
    t.store.applyV2(scope, settlement(tool, 7), 107)
    t.store.applyV2(scope, { action: 'finish-v2', operationId: randomUUID(), runId: t.begin.runId, expectedRevision: 8 }, 108)
    const saved = t.store.readCurrent(scope)
    expect(saved).toMatchObject({ orphaned: false, grantsPermission: false, document: { revision: 9, runs: [{ status: 'finished', charged: { modelStep: 1, toolInvocation: 1, providerDispatch: 1 } }] } })
    const reopened = t.reopen(); expect(reopened.readCurrent(scope)).toEqual(saved)
    expect(reopened.applyV2(scope, response, 109)).toMatchObject({ replay: true, grantsPermission: false })
  })
  it.each(['no-native-begin', 'no-native-commit', 'failed-rollback'] as const)('never confirms a receipt when %s leaves native transaction state uncertain', mode => {
    const t = running(), req = reserve(t.begin.runId, 2), db = dbOf(t.store), exec = db.exec.bind(db)
    const trap = vi.spyOn(db, 'exec').mockImplementation(sql => {
      if (mode === 'no-native-begin' && sql === 'BEGIN IMMEDIATE' || mode === 'no-native-commit' && sql === 'COMMIT') return
      if (mode === 'failed-rollback' && sql === 'ROLLBACK') throw new Error('Rollback unavailable')
      const result = exec(sql)
      if (mode === 'failed-rollback' && sql === 'BEGIN IMMEDIATE') throw new Error('Lost v2 BEGIN acknowledgement')
      return result
    })
    expect(() => t.store.applyV2(scope, req, 104)).toThrow(mode === 'failed-rollback' ? 'Lost v2 BEGIN' : mode === 'no-native-begin' ? 'native BEGIN was not confirmed' : 'native COMMIT was not confirmed')
    if (mode === 'failed-rollback') {
      expect(db.database.isTransaction).toBe(true); expect(() => t.store.readCurrent(scope)).toThrow('active operation or transaction')
      trap.mockRestore(); t.store.close(); expect(t.store.isNativeClosed).toBe(true)
      expect(t.reopen().readCurrent(scope)).toMatchObject({ orphaned: true, document: { revision: 2 } })
    } else {
      expect(db.database.isTransaction).toBe(false)
      expect(t.store.readCurrent(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 2 } })
    }
  })
  it('does not return a replay receipt after a successful commit callback swallows public-read revocation', () => {
    const t = nested(), db = dbOf(t.store), exec = db.exec.bind(db), errors: unknown[] = []
    vi.spyOn(db, 'exec').mockImplementation(sql => {
      const result = exec(sql)
      if (sql === 'COMMIT') { try { t.store.readCurrent(scope) } catch (error) { errors.push(error) } }
      return result
    })
    expect(() => t.store.applyV2(scope, t.dispatch, 104)).toThrow('replay receipt lost instance ownership')
    expect(errors).toHaveLength(1); expect(db.database.isTransaction).toBe(false)
    expect(t.store.readCurrent(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 4 } })
  })
  it('refuses all v2 mutations when codec encryption fails, with no v1 fallback and prior authenticated history still readable', () => {
    const t = running(), before = t.store.readCurrent(scope)
    vi.spyOn(t.codec, 'encryptBytes').mockImplementationOnce(() => { throw new Error('V2 encryption unavailable') })
    expect(() => t.store.applyV2(scope, reserve(t.begin.runId, 2), 104)).toThrow('encryption unavailable')
    expect(t.store.readCurrent(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: before.document })
    expect(() => t.store.upgradeV2(scope, t.req, 105)).toThrow('blocked')
  })
  it.each(['owner', 'revision'] as const)('rejects an actual v2 ciphertext swap across %s without a version fallback or rewrite', kind => {
    const t = upgraded(), db = dbOf(t.store), original = db.get('SELECT owner,revision,cipher FROM dispatch_ledger')!
    let target: string, selected = scope as { route: typeof scope.route; conversationId: string }
    if (kind === 'owner') {
      selected = { ...scope, conversationId: 'swapped-owner' }; t.store.upgradeV2(selected, upgradeReq(), 101)
      target = String(db.all('SELECT owner FROM dispatch_ledger').find(item => item.owner !== original.owner)!.owner)
    } else {
      t.store.applyV2(scope, begin(1), 101); target = String(original.owner)
      expect(db.get('SELECT revision FROM dispatch_ledger')?.revision).toBe(2)
    }
    db.prepare('UPDATE dispatch_ledger SET cipher=? WHERE owner=?').run(original.cipher as Uint8Array, target)
    expect(() => t.store.readCurrent(selected)).toThrow('CHECKPOINT_UNAVAILABLE')
    expect(Buffer.from(db.get('SELECT cipher FROM dispatch_ledger WHERE owner=?', target)!.cipher as Uint8Array)).toEqual(Buffer.from(original.cipher as Uint8Array))
    expect(() => t.store.applyV2(selected, begin(1), 102)).toThrow('blocked')
  })
  it('rejects authenticated malformed v2 payload and unknown version without v1 fallback or data rewrite', () => {
    const t = upgraded(), db = dbOf(t.store), row = db.get('SELECT owner,revision,cipher FROM dispatch_ledger')!
    const original = t.store.readCurrent(scope).document as InvocationLedgerDocument
    for (const mutate of [(doc: Record<string, unknown>) => { doc.version = 3 }, (doc: Record<string, unknown>) => { doc.runs = [{ bogus: true }] }]) {
      const next = structuredClone(original) as unknown as Record<string, unknown>; mutate(next)
      const cipher = t.codec.encryptBytes(Buffer.from(JSON.stringify(next)), `magicpot-dispatch-ledger-v1:${row.owner}:1`)
      db.prepare('UPDATE dispatch_ledger SET cipher=?').run(cipher)
      expect(() => t.store.readCurrent(scope)).toThrow()
      expect(Buffer.from(db.get('SELECT cipher FROM dispatch_ledger')!.cipher as Uint8Array)).toEqual(cipher)
    }
    expect(() => t.store.applyV2(scope, begin(1), 102)).toThrow('blocked')
  })
})
