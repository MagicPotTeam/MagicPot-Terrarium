import { getEventListeners } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import type { ProviderDispatchAdmission } from './providerDispatchAdmission'
import { ProviderDispatchOwner } from './providerDispatchOwner'
import { ProviderDispatchLedgerStore, ProviderDispatchLedgerOpenUncertainError } from './providerDispatchLedgerStore'
import { sideTestCodec, sideScope as scope } from '../api/agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
const owners: ProviderDispatchOwner[] = [], roots: string[] = []
const endpoint = 'https://model.test/chat'
const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"test"}' }
const makeRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'dispatch-owner-')); roots.push(root); return root }
function open(root = makeRoot(), codec = sideTestCodec()) { const owner = new ProviderDispatchOwner(root, codec); owners.push(owner); return { root, owner, codec } }
const options = (extra: Partial<Parameters<ProviderDispatchOwner['createAdmission']>[0]> = {}) => ({ scope, binding: { goalId: randomUUID(), generation: 1, profileHash: 'a'.repeat(64) }, expectedRevision: 0, maxProviderDispatches: 2, maxWalltimeMs: 10000, endpoint, fetch: vi.fn(async () => new Response('ok')), signal: new AbortController().signal, assertLive: () => undefined, ...extra })
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) { try { await owner.shutdown() } catch { /* Explicit quarantine tests clean native handles below. */ } } for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })
describe('isolated cooperative dispatch owner, not app singleton or production goal execution', () => {
  it('holds one fixed-file exclusive transaction until confirmed ledger close, then reopens without erasing data', async () => {
    const t = open(), request = t.owner.createAdmission(options())
    expect(() => new ProviderDispatchOwner(t.root, t.codec)).toThrow()
    expect(await (await request.fetch(endpoint, post)).text()).toBe('ok'); request.finish()
    expect(t.owner.readData(scope).document.runs[0].status).toBe('finished')
    const first = t.owner.shutdown(), duplicate = t.owner.shutdown(); expect(first).toBe(duplicate)
    expect(() => t.owner.readData(scope)).toThrow('retired')
    await first
    const next = open(t.root, t.codec)
    expect(next.owner.readData(scope)).toMatchObject({ grantsPermission: false, orphaned: false, document: { revision: 4 } })
    expect(() => new ProviderDispatchOwner(t.root, t.codec)).toThrow()
  })
  it('shutdown disposes pending and idle admissions before releasing ownership; next owner cannot resume them', async () => {
    const t = open(), pending = t.owner.createAdmission(options()), idleScope = { ...scope, conversationId: 'idle' }
    t.owner.createAdmission(options({ scope: idleScope }))
    const response = await pending.fetch(endpoint, post)
    await t.owner.shutdown(); await expect(response.text()).rejects.toThrow()
    const next = open(t.root, t.codec)
    expect(next.owner.readData(scope).document.runs[0].status).toBe('unknown')
    expect(next.owner.readData(idleScope).document.runs[0].status).toBe('unknown')
    expect(() => next.owner.createAdmission(options({ expectedRevision: next.owner.readData(scope).document.revision }))).toThrow('uncertain')
  })
  it('latches reentrant shutdown in construction before callbacks return and defers native teardown', async () => {
    const t = open(); let closing: Promise<void> | undefined
    expect(() => t.owner.createAdmission(options({ assertLive() { closing = t.owner.shutdown() } }))).toThrow('retired')
    expect(closing).toBeDefined(); await closing
    const next = open(t.root, t.codec)
    expect(next.owner.readData(scope).document.revision).toBe(0)
  })
  it('shutdown during codec mutation never closes SQLite on the mutation stack or returns a renewed admission', async () => {
    const t = open(), encrypt = t.codec.encryptBytes.bind(t.codec); let closing: Promise<void> | undefined
    vi.spyOn(t.codec, 'encryptBytes').mockImplementationOnce((bytes, aad) => { closing = t.owner.shutdown(); return encrypt(bytes, aad) })
    expect(() => t.owner.createAdmission(options())).toThrow('retired')
    await closing
    const next = open(t.root, t.codec), current = next.owner.readData(scope)
    expect(current.document.runs[0].status).toBe('unknown')
    expect(() => next.owner.createAdmission(options({ expectedRevision: current.document.revision }))).toThrow('uncertain')
  })
  it('refuses new construction at capacity and reclaims a clean explicitly finished slot only', () => {
    const t = open(), requests: ProviderDispatchAdmission[] = []
    for (let i = 0; i < 32; i++) requests.push(t.owner.createAdmission(options({ scope: { ...scope, conversationId: `owner${i}` } })))
    expect(() => t.owner.createAdmission(options({ scope: { ...scope, conversationId: 'too-many' } }))).toThrow('capacity')
    requests[0].finish()
    expect(() => t.owner.createAdmission(options({ scope: { ...scope, conversationId: 'new-slot' } }))).not.toThrow()
  })
  it('keeps fixed ownership schema across shutdown rollback and never resets an incompatible owner database', async () => {
    const t = open(); await t.owner.shutdown()
    const file = path.join(t.root, 'owner-v1.sqlite'), db = new NodeSQLiteAdapter(file)
    expect(db.get('SELECT version FROM owner_identity WHERE id=1')?.version).toBe(1)
    db.exec('CREATE TABLE injected(x TEXT)'); db.close()
    expect(() => new ProviderDispatchOwner(t.root, t.codec)).toThrow('schema')
    const retained = new NodeSQLiteAdapter(file); expect(retained.get("SELECT name FROM sqlite_master WHERE name='injected'")?.name).toBe('injected'); retained.close()
  })
  it('does not release the ownership lock after unconfirmed native ledger close', async () => {
    const t = open(), store = (t.owner as unknown as { store: ProviderDispatchLedgerStore }).store, db = (store as unknown as { db: NodeSQLiteAdapter }).db
    const close = db.close.bind(db)
    vi.spyOn(db, 'close').mockImplementation(() => { throw new Error('Native close not confirmed') })
    await expect(t.owner.shutdown()).rejects.toThrow('not confirmed')
    expect(store.isNativeClosed).toBe(false)
    expect(() => new ProviderDispatchOwner(t.root, t.codec)).toThrow()
    // Test-only recovery to avoid leaving native handles in the test runner;
    // production quarantine intentionally retains them until process exit.
    vi.mocked(db.close).mockImplementation(close); store.close(); expect(store.isNativeClosed).toBe(true)
    const lock = (t.owner as unknown as { lock: NodeSQLiteAdapter }).lock
    lock.exec('ROLLBACK'); lock.close()
  })
  it('propagates owner loss from an exclusive-transaction rollback before any delegate dispatch', async () => {
    const t = open(), input = options(), request = t.owner.createAdmission(input)
    const lock = (t.owner as unknown as { lock: NodeSQLiteAdapter }).lock
    lock.exec('ROLLBACK')
    await expect(request.fetch(endpoint, post)).rejects.toThrow('exclusive')
    expect(input.fetch).not.toHaveBeenCalled()
    // Restore a transaction only for deterministic test resource cleanup, never
    // offered by the public owner API after loss.
    lock.exec('BEGIN EXCLUSIVE')
  })
  it('detaches original caller AbortSignal listeners during owner shutdown even if the parent never aborts', async () => {
    const t = open(), parent = new AbortController()
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
    t.owner.createAdmission(options({ signal: parent.signal }))
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(1)
    await t.owner.shutdown()
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
  })
  it('retains the ownership lock after partial ledger construction and native cleanup failure', () => {
    const root = makeRoot(), codec = sideTestCodec(), file = path.join(root, 'ledger-v1.sqlite')
    const incompatible = new NodeSQLiteAdapter(file); incompatible.exec('CREATE TABLE incompatible(x TEXT)'); incompatible.close()
    const close = NodeSQLiteAdapter.prototype.close, exec = NodeSQLiteAdapter.prototype.exec
    const holder: { lock?: NodeSQLiteAdapter } = {}; let partial!: ProviderDispatchLedgerOpenUncertainError
    vi.spyOn(NodeSQLiteAdapter.prototype, 'exec').mockImplementation(function (this: NodeSQLiteAdapter, sql) { if (this.path.endsWith('owner-v1.sqlite') && sql === 'BEGIN EXCLUSIVE') { Object.assign(holder, { lock: this }) }; return exec.call(this, sql) })
    vi.spyOn(NodeSQLiteAdapter.prototype, 'close').mockImplementation(function (this: NodeSQLiteAdapter) { if (this.path === file) throw new Error('Partial ledger native close failed'); return close.call(this) })
    try { new ProviderDispatchOwner(root, codec) } catch (error) { partial = error as ProviderDispatchLedgerOpenUncertainError }
    expect(partial).toBeInstanceOf(ProviderDispatchLedgerOpenUncertainError); expect(partial.isNativeClosed).toBe(false)
    expect(() => new ProviderDispatchOwner(root, codec)).toThrow()
    // Test-only cleanup of quarantined native handles; no production path releases this lock.
    vi.mocked(NodeSQLiteAdapter.prototype.close).mockImplementation(close)
    partial.closeNative(); holder.lock!.exec('ROLLBACK'); holder.lock!.close()
  })
  it('retries a failed data-store close rather than mistaking a closed flag for native closure', () => {
    const codec = sideTestCodec(), store = new ProviderDispatchLedgerStore(codec), db = (store as unknown as { db: NodeSQLiteAdapter }).db
    const close = db.close.bind(db)
    vi.spyOn(db, 'close').mockImplementationOnce(() => { throw new Error('Close failed') }).mockImplementation(close)
    expect(() => store.close()).toThrow('Close failed'); expect(store.isNativeClosed).toBe(false)
    store.close(); expect(store.isNativeClosed).toBe(true)
  })
})
