import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, linkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { ProviderDispatchLedgerStore, DISPATCH_LEDGER_STORAGE_LIMITS as S } from './providerDispatchLedgerStore'
import { DISPATCH_LEDGER_LIMITS, type DispatchLedgerCommand } from './providerDispatchLedgerPolicy'
import { sideTestCodec, sideScope as scope } from '../api/agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
const roots: string[] = [], stores: ProviderDispatchLedgerStore[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })
function setup(pageSize?: number, paddedCipher = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'dispatch-ledger-')); roots.push(root)
  const file = path.join(root, 'ledger.sqlite'), realCodec = sideTestCodec()
  const codec = paddedCipher ? {
    available: realCodec.available,
    encryptBytes(bytes: Uint8Array, aad: string) {
      const cipher = realCodec.encryptBytes(bytes, aad), padded = Buffer.alloc(S.cipherBytes)
      if (cipher.length > padded.length - 4) throw new Error('Padded fixture cipher too large')
      padded.writeUInt32LE(cipher.length); cipher.copy(padded, 4); return padded
    },
    decryptBytes(bytes: Uint8Array, aad: string, maxBytes: number) { const data = Buffer.from(bytes); return realCodec.decryptBytes(data.subarray(4, 4 + data.readUInt32LE()), aad, maxBytes) }
  } : realCodec
  if (pageSize) { const db = new NodeSQLiteAdapter(file); db.exec(`PRAGMA page_size=${pageSize};VACUUM;`); db.close() }
  const store = new ProviderDispatchLedgerStore(codec, file); stores.push(store)
  return { store, file, codec, reopen() { store.close(); const next = new ProviderDispatchLedgerStore(codec, file); stores.push(next); return next } }
}
const begin = (): Extract<DispatchLedgerCommand, { action: 'begin' }> => ({ action: 'begin', operationId: randomUUID(), runId: randomUUID(), expectedRevision: 0, binding: { goalId: randomUUID(), generation: 2, profileHash: 'a'.repeat(64) }, maxProviderDispatches: DISPATCH_LEDGER_LIMITS.attempts, maxWalltimeMs: 1000 })
const reserve = (runId: string): Extract<DispatchLedgerCommand, { action: 'reserve' }> => ({ action: 'reserve', operationId: randomUUID(), runId, attemptId: randomUUID(), expectedRevision: 1 })
const settle = (req: ReturnType<typeof reserve>): Extract<DispatchLedgerCommand, { action: 'settle' }> => ({ action: 'settle', operationId: randomUUID(), expectedRevision: 2, runId: req.runId, attemptId: req.attemptId, outcome: { state: 'response-complete', status: 200, responseBytes: 2, charged: true, grantsPermission: false } })
const finish = (runId: string, expectedRevision: number): Extract<DispatchLedgerCommand, { action: 'finish' }> => ({ action: 'finish', operationId: randomUUID(), runId, expectedRevision })

describe('isolated encrypted ledger DATA only, no execution capabilities or production admission', () => {
  it('persists accounting ciphertext and reports unfinished idle runs as orphaned after reopening, without renewed authority', () => {
    const t = setup(), req = begin(), saved = t.store.apply(scope, req, 100)
    expect(saved.grantsPermission).toBe(false)
    expect(t.store.read(scope)).toMatchObject({ orphaned: false, document: { revision: 1 } })
    const disk = readFileSync(t.file).toString('latin1')
    for (const secret of [req.operationId, req.runId, req.binding.goalId, req.binding.profileHash]) expect(disk).not.toContain(secret)
    const reopened = t.reopen()
    expect(reopened.read(scope)).toMatchObject({ orphaned: true, grantsPermission: false, document: saved.document })
    expect(() => reopened.apply(scope, reserve(req.runId), 101)).toThrow('Orphan')
    expect(() => reopened.apply(scope, finish(req.runId, 1), 101)).toThrow('Orphan')
    expect(reopened.apply(scope, req, 102)).toMatchObject({ replay: true, grantsPermission: false })
    expect(() => reopened.apply(scope, reserve(req.runId), 103)).toThrow('Orphan')
    const orphan: DispatchLedgerCommand = { action: 'orphan', operationId: randomUUID(), expectedRevision: 1, runId: req.runId }
    expect(reopened.apply(scope, orphan, 104).document.runs[0].status).toBe('unknown')
    expect(() => reopened.apply(scope, { ...begin(), expectedRevision: 2 }, 105)).toThrow('uncertain')
  })
  it('pending survives reopen as a fence, original settlement data can replay but cannot recreate an instance-owned run', () => {
    const t = setup(), req = begin(), pending = reserve(req.runId)
    t.store.apply(scope, req, 100); t.store.apply(scope, pending, 101)
    const reopened = t.reopen()
    expect(reopened.read(scope)).toMatchObject({ orphaned: true, document: { revision: 2, runs: [{ chargedProviderDispatches: 1 }] } })
    expect(reopened.apply(scope, pending, 102)).toMatchObject({ replay: true, receipt: { revision: 2 }, grantsPermission: false })
    expect(() => reopened.apply(scope, settle(pending), 103)).toThrow('Orphan')
    const result = reopened.apply(scope, { action: 'orphan', operationId: randomUUID(), runId: req.runId, expectedRevision: 2 }, 104)
    expect(result.document.runs[0]).toMatchObject({ status: 'unknown', attempts: [{ outcome: { state: 'unknown', charged: true } }] })
    expect(() => reopened.apply(scope, { ...settle(pending), expectedRevision: 3 }, 105)).toThrow('unavailable')
  })
  it('retains original receipts across later known settlements and rejects mutated replay or cross-owner data', () => {
    const t = setup(), req = begin(), pending = reserve(req.runId), end = settle(pending)
    t.store.apply(scope, req, 100); t.store.apply(scope, pending, 101); t.store.apply(scope, end, 102)
    t.store.apply(scope, finish(req.runId, 3), 103)
    const reopened = t.reopen()
    expect(reopened.apply(scope, end, 200)).toMatchObject({ replay: true, receipt: { revision: 3 }, document: { revision: 4 } })
    expect(() => reopened.apply(scope, { ...end, outcome: { state: 'unknown', charged: true, grantsPermission: false } }, 201)).toThrow('replay conflict')
    expect(reopened.read({ ...scope, conversationId: 'other' }).document).toMatchObject({ revision: 0, runs: [] })
    expect(() => reopened.apply({ ...scope, conversationId: 'other' }, pending, 202)).toThrow('revision')
    expect(() => reopened.read({ ...scope, route: { ...scope.route, scopeId: 'unsafe:scope' } })).toThrow('scope')
  })
  it('serializes real independent connections but never transfers data-mutation ownership to another instance', () => {
    const t = setup(), other = new ProviderDispatchLedgerStore(t.codec, t.file); stores.push(other)
    const req = begin(); t.store.apply(scope, req, 100)
    expect(() => other.apply(scope, begin(), 101)).toThrow('revision')
    expect(() => other.apply(scope, reserve(req.runId), 101)).toThrow('Orphan')
    expect(other.apply(scope, req, 102)).toMatchObject({ replay: true, grantsPermission: false })
    other.apply(scope, { action: 'orphan', operationId: randomUUID(), runId: req.runId, expectedRevision: 1 }, 103)
    expect(() => t.store.apply(scope, { ...reserve(req.runId), expectedRevision: 2 }, 104)).toThrow('unavailable')
    expect(t.store.read(scope).document.runs[0].status).toBe('unknown')
  })
  it.each(['before-begin', 'after-begin', 'lost-rollback-ack'] as const)('fences %s failure and releases any actually opened native transaction without replaying the mutation', mode => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    const other = new ProviderDispatchLedgerStore(t.codec, t.file); stores.push(other)
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, exec = db.exec.bind(db)
    let injected = false
    vi.spyOn(db, 'exec').mockImplementation(sql => {
      if (sql === 'BEGIN IMMEDIATE' && !injected) {
        injected = true
        if (mode !== 'before-begin') exec(sql)
        throw new Error('Lost BEGIN acknowledgement')
      }
      const result = exec(sql)
      if (sql === 'ROLLBACK' && mode === 'lost-rollback-ack') throw new Error('Lost ROLLBACK acknowledgement')
      return result
    })
    expect(() => t.store.apply(scope, reserve(req.runId), 101)).toThrow('Lost BEGIN acknowledgement')
    expect(db.database.isTransaction).toBe(false)
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 1, runs: [{ chargedProviderDispatches: 0 }] } })
    expect(() => t.store.apply(scope, reserve(req.runId), 102)).toThrow('blocked')
    expect(other.apply(scope, { action: 'orphan', operationId: randomUUID(), runId: req.runId, expectedRevision: 1 }, 103).document.runs[0].status).toBe('unknown')
    expect(t.store.read(scope).document.revision).toBe(2)
  })
  it('refuses public reads while rollback itself cannot release a lost-BEGIN native transaction, then confirmed close releases it', () => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    const other = new ProviderDispatchLedgerStore(t.codec, t.file); stores.push(other)
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, exec = db.exec.bind(db)
    vi.spyOn(db, 'exec').mockImplementation(sql => {
      if (sql === 'BEGIN IMMEDIATE') { exec(sql); throw new Error('Lost BEGIN acknowledgement') }
      if (sql === 'ROLLBACK') throw new Error('Rollback unavailable')
      return exec(sql)
    })
    expect(() => t.store.apply(scope, reserve(req.runId), 101)).toThrow('Lost BEGIN')
    expect(db.database.isTransaction).toBe(true)
    expect(() => t.store.read(scope)).toThrow('active operation or transaction')
    expect(() => t.store.apply(scope, reserve(req.runId), 102)).toThrow('blocked')
    t.store.close(); expect(t.store.isNativeClosed).toBe(true)
    expect(other.apply(scope, { action: 'orphan', operationId: randomUUID(), runId: req.runId, expectedRevision: 1 }, 103).document.runs[0].status).toBe('unknown')
  })
  it.each(['rethrow', 'swallow'] as const)('never exposes provisional receipts through a codec verification read (%s nested error)', mode => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    const decrypt = t.codec.decryptBytes.bind(t.codec), snapshots: unknown[] = []
    let nestedError: unknown
    vi.spyOn(t.codec, 'decryptBytes').mockImplementation((bytes, aad, maximum) => {
      const plain = decrypt(bytes, aad, maximum)
      if (aad.endsWith(':2')) {
        try { snapshots.push(t.store.read(scope)) } catch (error) { nestedError = error }
        if (mode === 'rethrow') { plain.fill(0); throw new Error('Verification failed after tentative read attempt') }
      }
      return plain
    })
    expect(() => t.store.apply(scope, reserve(req.runId), 101)).toThrow(mode === 'rethrow' ? 'Verification failed' : 'revoked during write verification')
    expect(snapshots).toEqual([]); expect(nestedError).toMatchObject({ message: expect.stringContaining('public read is blocked') })
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db
    expect(db.database.isTransaction).toBe(false)
    const stable = t.store.read(scope)
    expect(stable).toMatchObject({ mutationBlocked: true, orphaned: true, grantsPermission: false, document: { revision: 1, runs: [{ chargedProviderDispatches: 0 }] } })
    expect(stable.document.receipts).toHaveLength(1)
  })
  it.each(['read', 'apply'] as const)('revokes an outer public read if its codec swallows a nested %s rejection, including on an already poisoned instance', kind => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    const decrypt = t.codec.decryptBytes.bind(t.codec)
    const trap = () => vi.spyOn(t.codec, 'decryptBytes').mockImplementationOnce((bytes, aad, maximum) => {
      try { if (kind === 'read') t.store.read(scope); else t.store.apply(scope, reserve(req.runId), 101) } catch { /* Intentionally swallowed callback failure. */ }
      return decrypt(bytes, aad, maximum)
    })
    trap(); expect(() => t.store.read(scope)).toThrow('revoked during verification')
    trap(); expect(() => t.store.read(scope)).toThrow('revoked during verification')
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, document: { revision: 1 } })
    expect((t.store as unknown as { db: NodeSQLiteAdapter }).db.database.isTransaction).toBe(false)
  })
  it.each(['source-verification', 'commit-callback'] as const)('does not return even a retained replay if a callback revokes public-read consistency during %s', point => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    let nestedError: unknown
    if (point === 'source-verification') {
      const decrypt = t.codec.decryptBytes.bind(t.codec)
      vi.spyOn(t.codec, 'decryptBytes').mockImplementationOnce((bytes, aad, maximum) => {
        try { t.store.read(scope) } catch (error) { nestedError = error }
        return decrypt(bytes, aad, maximum)
      })
    } else {
      const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, exec = db.exec.bind(db)
      vi.spyOn(db, 'exec').mockImplementation(sql => { const result = exec(sql); if (sql === 'COMMIT') { try { t.store.read(scope) } catch (error) { nestedError = error } }; return result })
    }
    expect(() => t.store.apply(scope, req, 101)).toThrow(point === 'source-verification' ? 'source verification' : 'replay receipt lost instance ownership')
    expect(nestedError).toMatchObject({ message: expect.stringContaining('public read is blocked') })
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 1 } })
    expect((t.store as unknown as { db: NodeSQLiteAdapter }).db.database.isTransaction).toBe(false)
  })
  it('poisons mutations when COMMIT succeeds but acknowledgement throws, retaining accounting without replacement authority', () => {
    const t = setup(), db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, exec = db.exec.bind(db)
    let lost = false
    vi.spyOn(db, 'exec').mockImplementation(sql => { const result = exec(sql); if (sql === 'COMMIT' && !lost) { lost = true; throw new Error('Lost postcommit acknowledgement') } return result })
    const req = begin()
    expect(() => t.store.apply(scope, req, 100)).toThrow('Lost postcommit')
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 1 } })
    expect(() => t.store.apply(scope, req, 101)).toThrow('blocked')
    const reopened = t.reopen()
    expect(reopened.apply(scope, req, 102)).toMatchObject({ replay: true, grantsPermission: false })
    expect(() => reopened.apply(scope, reserve(req.runId), 103)).toThrow('Orphan')
  })
  it('poisons mutations on codec failure without fallback, while preserving readable prior data', () => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    vi.spyOn(t.codec, 'encryptBytes').mockImplementationOnce(() => { throw new Error('Encryption failed') })
    expect(() => t.store.apply(scope, reserve(req.runId), 101)).toThrow('Encryption failed')
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 1 } })
    expect(() => t.store.apply(scope, reserve(req.runId), 102)).toThrow('blocked')
  })
  it.each([512, 4096, 65536])('honors actual page-size byte ceilings and preserves room for reserve/settle at page size %s', pageSize => {
    const t = setup(pageSize), req = begin(), pending = reserve(req.runId)
    t.store.apply(scope, req, 100); t.store.apply(scope, pending, 101); t.store.apply(scope, settle(pending), 102)
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db
    expect(db.get('PRAGMA max_page_count')?.max_page_count).toBe(Math.floor(S.databaseBytes / pageSize))
    expect(Number(db.get('PRAGMA page_count')?.page_count) * pageSize).toBeLessThanOrEqual(S.databaseBytes)
    expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'active', chargedProviderDispatches: 1 })
  })
  it('rejects cross-owner cipher swaps and schema tampering rather than trusting valid-looking counters', () => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    const otherScope = { ...scope, conversationId: 'other' }; t.store.apply(otherScope, begin(), 100)
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db
    const rows = db.all('SELECT owner,revision,cipher FROM dispatch_ledger')
    db.prepare('UPDATE dispatch_ledger SET cipher=? WHERE owner=?').run(rows[0].cipher as Uint8Array, rows[1].owner as string)
    expect(() => t.store.read(otherScope)).toThrow()
    expect(() => t.store.apply(scope, reserve(req.runId), 101)).toThrow('blocked')
    db.exec('CREATE TABLE injected(x TEXT)')
    expect(() => t.store.read(scope)).toThrow('schema')
  })
  it('blocks after a transient database read failure during a mutation instead of reusing instance ownership', () => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, get = db.get.bind(db)
    vi.spyOn(db, 'get').mockImplementationOnce(() => { throw new Error('Transient disk read failure') })
    expect(() => t.store.apply(scope, reserve(req.runId), 101)).toThrow('disk read')
    vi.mocked(db.get).mockImplementation(get)
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 1 } })
    expect(() => t.store.apply(scope, reserve(req.runId), 102)).toThrow('blocked')
  })
  it('does not commit after a nested codec callback revokes the ledger instance', () => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    const encrypt = t.codec.encryptBytes.bind(t.codec)
    vi.spyOn(t.codec, 'encryptBytes').mockImplementationOnce((plain, aad) => {
      try { t.store.read({ ...scope, route: { ...scope.route, scopeId: 'invalid:scope' } }) } catch { /* This read revokes mutations. */ }
      return encrypt(plain, aad)
    })
    expect(() => t.store.apply(scope, reserve(req.runId), 101)).toThrow('revoked')
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, document: { revision: 1 } })
  })
  it('does not reinstall instance ownership after revocation in a successful commit callback', () => {
    const t = setup(), db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, exec = db.exec.bind(db)
    let revoke = true
    vi.spyOn(db, 'exec').mockImplementation(sql => {
      const result = exec(sql)
      if (sql === 'COMMIT' && revoke) { revoke = false; try { t.store.read({ ...scope, route: { ...scope.route, scopeId: 'invalid:scope' } }) } catch { /* Revokes even if a commit already succeeded. */ } }
      return result
    })
    expect(() => t.store.apply(scope, begin(), 100)).toThrow('committed data may remain')
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 1 } })
  })
  it('keeps full bounded lifecycle receipts durable through all reservations, settlements and finishes', () => {
    const t = setup(); let revision = 0, clock = 100
    for (let run = 0; run < DISPATCH_LEDGER_LIMITS.runs; run++) {
      const req = { ...begin(), expectedRevision: revision }
      revision = t.store.apply(scope, req, clock++).document.revision
      for (let attempt = 0; attempt < DISPATCH_LEDGER_LIMITS.attempts; attempt++) {
        const pending = { ...reserve(req.runId), expectedRevision: revision }
        revision = t.store.apply(scope, pending, clock++).document.revision
        revision = t.store.apply(scope, { ...settle(pending), expectedRevision: revision }, clock++).document.revision
      }
      revision = t.store.apply(scope, finish(req.runId, revision), clock++).document.revision
    }
    expect(revision).toBe(DISPATCH_LEDGER_LIMITS.receipts)
    const reopened = t.reopen(), value = reopened.read(scope)
    expect(value).toMatchObject({ orphaned: false, grantsPermission: false, document: { revision } })
    expect(value.document.receipts).toHaveLength(DISPATCH_LEDGER_LIMITS.receipts)
    expect(value.document.runs.every(run => run.status === 'finished' && run.chargedProviderDispatches === DISPATCH_LEDGER_LIMITS.attempts)).toBe(true)
  })
  it('rejects hardlink database paths before opening unsafe aliases', () => {
    const t = setup(), req = begin(); t.store.apply(scope, req, 100)
    const linked = path.join(path.dirname(t.file), 'hardlink.sqlite'); linkSync(t.file, linked)
    expect(() => new ProviderDispatchLedgerStore(t.codec, linked)).toThrow('Unsafe')
    rmSync(linked)
  })
  it('rejects file symlinks when the OS permits the test to create one', context => {
    const t = setup(), symbolic = path.join(path.dirname(t.file), 'symlink.sqlite')
    try { symlinkSync(t.file, symbolic) } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(true, 'Windows file-symlink creation requires OS privilege; this case is environment-blocked, not passed.'); return }
      throw error
    }
    expect(() => new ProviderDispatchLedgerStore(t.codec, symbolic)).toThrow('Unsafe')
  })
  it('rejects a real Windows directory junction in an ancestor path', () => {
    const t = setup(), other = setup(), junction = path.join(path.dirname(other.file), 'directory-link')
    symlinkSync(path.dirname(t.file), junction, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => new ProviderDispatchLedgerStore(t.codec, path.join(junction, path.basename(t.file)))).toThrow('Unsafe')
  })
  it.each([512, 65536])('leaves logical slot and real SQLite page room to settle at maximum ciphertext expansion (page=%s)', pageSize => {
    const t = setup(pageSize, true), maximum = Math.floor(S.totalReservedCipherBytes / S.cipherBytes)
    let last!: ReturnType<typeof begin>, lastScope!: typeof scope | { route: typeof scope.route; conversationId: string }
    for (let n = 0; n < maximum; n++) { last = begin(); lastScope = { ...scope, conversationId: `padded${n}` }; t.store.apply(lastScope, last, 100) }
    const pending = reserve(last.runId)
    t.store.apply(lastScope, pending, 101); t.store.apply(lastScope, settle(pending), 102); t.store.apply(lastScope, finish(last.runId, 3), 103)
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db
    expect(db.get('SELECT min(length(cipher)) AS smallest,max(length(cipher)) AS biggest,count(*) AS n FROM dispatch_ledger')).toMatchObject({ smallest: S.cipherBytes, biggest: S.cipherBytes, n: maximum })
    expect(Number(db.get('PRAGMA page_count')?.page_count) * pageSize).toBeLessThanOrEqual(S.databaseBytes)
    expect(t.store.read(lastScope).document.runs[0]).toMatchObject({ status: 'finished', chargedProviderDispatches: 1 })
    expect(() => t.store.apply({ ...scope, conversationId: 'no-slot' }, begin(), 100)).toThrow('slot capacity')
  })
  it('poisons on a database write-full error without erasing or replaying a pending reservation', () => {
    const t = setup(), req = begin(), pending = reserve(req.runId)
    t.store.apply(scope, req, 100); t.store.apply(scope, pending, 101)
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation(sql => { if (sql.startsWith('INSERT INTO dispatch_ledger')) throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }); return prepare(sql) })
    expect(() => t.store.apply(scope, settle(pending), 102)).toThrow('disk is full')
    expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 2, runs: [{ chargedProviderDispatches: 1 }] } })
    expect(() => t.store.apply(scope, settle(pending), 103)).toThrow('blocked')
  })
  it('reserves full owner cipher slots before admission and refuses capacity without evicting old runs', () => {
    const t = setup(), maximum = Math.floor(S.totalReservedCipherBytes / S.cipherBytes)
    for (let n = 0; n < maximum; n++) t.store.apply({ ...scope, conversationId: `owner${n}` }, begin(), 100)
    expect(() => t.store.apply({ ...scope, conversationId: 'over' }, begin(), 100)).toThrow('slot capacity')
    expect(t.store.read({ ...scope, conversationId: 'owner0' }).document.runs).toHaveLength(1)
    expect(t.store.read({ ...scope, conversationId: 'over' }).document).toMatchObject({ revision: 0, runs: [] })
  })
})
