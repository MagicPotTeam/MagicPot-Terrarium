import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import type { HtmlCheckpointCodec } from './agentThreadHtmlStore'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'

const INITIALIZATION = Symbol('main-owned HTML ledger initialization')
const MAX_DB = 4 * 1024 * 1024, MAX_PLAIN = 8192, MAX_CIPHER = 80 * 1024
const DDL = 'CREATE TABLE ledger (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, cipher BLOB NOT NULL)'
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
type Slot = { slot: number; generation: number; status: 'clear' | 'unconfirmed'; ownerHash: string | null; savedHash: string | null; startedAt: number | null }
type Ledger = { version: 1; epoch: string; revision: number; slots: Slot[] }
/** An opaque in-memory capability. Persisted numeric generations never authorize clearing. */
export type HtmlRunTicket = Readonly<{ slot: number; generation: number }>
export type HtmlRunSlot = Readonly<Slot>
function regularPath(file: string, max = MAX_DB): void {
  if (!path.isAbsolute(file)) throw new Error('HTML run ledger path must be absolute.')
  let current = path.parse(file).root
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (!stat) throw new Error('HTML run ledger is missing; refusing automatic initialization.')
    if (stat.isSymbolicLink() || (current !== file && !stat.isDirectory()) || (current === file && (!stat.isFile() || stat.nlink !== 1 || stat.size > max))) throw new Error('Unsafe HTML run ledger path.')
  }
  if (path.resolve(realpathSync(file)).toLowerCase() !== file.toLowerCase()) throw new Error('HTML run ledger path is not canonical.')
}
function readAnchor(file: string): string {
  regularPath(file, 128)
  const before = lstatSync(file), fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== 37) throw new Error('Invalid HTML run anchor.')
    const bytes = Buffer.alloc(38), n = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd), current = lstatSync(file)
    const value = bytes.subarray(0, n).toString('ascii')
    if (n !== 37 || !value.endsWith('\n') || !uuid(value.slice(0, -1)) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== current.ino || after.dev !== current.dev) throw new Error('HTML run anchor changed.')
    return value.slice(0, -1)
  } finally { closeSync(fd) }
}
function validate(value: unknown, epoch: string, revision: number): asserts value is Ledger {
  const data = cloneBoundedMcpJson(value, MAX_PLAIN) as Ledger
  if (!data || Object.keys(data).sort().join() !== 'epoch,revision,slots,version' || data.version !== 1 || data.epoch !== epoch || data.revision !== revision || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(data.slots) || data.slots.length !== 4) throw new Error('Invalid HTML run ledger record.')
  for (let i = 0; i < 4; i++) {
    const slot = data.slots[i]
    if (!slot || Object.keys(slot).sort().join() !== 'generation,ownerHash,savedHash,slot,startedAt,status' || slot.slot !== i || !Number.isSafeInteger(slot.generation) || slot.generation < 0 || !['clear', 'unconfirmed'].includes(slot.status)) throw new Error('Invalid HTML run slot.')
    if (slot.status === 'clear' ? slot.ownerHash !== null || slot.savedHash !== null || slot.startedAt !== null : !hash(slot.ownerHash) || slot.savedHash !== null && !hash(slot.savedHash) || !Number.isSafeInteger(slot.startedAt) || Number(slot.startedAt) < 0 || slot.generation < 1) throw new Error('Invalid HTML run slot state.')
  }
}
const clearSlot = (slot: number, generation = 0): Slot => ({ slot, generation, status: 'clear', ownerHash: null, savedHash: null, startedAt: null })
/**
 * Separate from document retention. Open-existing is the only normal operation.
 * Explicit initialize requires two absent paths and never repairs a partial pair.
 * Anchor+AEAD bind this database epoch, not freshness: a valid older database
 * from the same epoch (even with the existing anchor) can be rolled back.
 */
export class AgentThreadHtmlRunLedger {
  private readonly db: NodeSQLiteAdapter
  private readonly identity: { dev: number; ino: number }
  private readonly anchorIdentity: { dev: number; ino: number }
  private readonly tickets = new Map<HtmlRunTicket, { slot: number; generation: number }>()
  private readonly epoch: string
  static initialize(codec: HtmlCheckpointCodec, file: string): AgentThreadHtmlRunLedger {
    if (!codec.available() || !path.isAbsolute(file)) throw new Error('Encrypted HTML run ledger unavailable.')
    file = path.resolve(file)
    const anchor = file + '.anchor'
    // Parent must already be an owned ordinary directory; no recursive creation.
    const parent = path.dirname(file), stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(realpathSync(parent)).toLowerCase() !== parent.toLowerCase()) throw new Error('Unsafe HTML run ledger parent.')
    if (['', '.anchor', '-journal', '-wal', '-shm'].some(suffix => lstatSync(file + suffix, { throwIfNoEntry: false }))) throw new Error('HTML run ledger already exists or is incomplete; refusing reset.')
    const epoch = randomUUID(), fd = openSync(anchor, 'wx', 0o600)
    try { writeFileSync(fd, epoch + '\n', 'ascii'); fsyncSync(fd) } finally { closeSync(fd) }
    const database = openSync(file, 'wx', 0o600)
    try { fsyncSync(database) } finally { closeSync(database) }
    // A failure intentionally leaves the pair for diagnosis, never a fresh retry.
    return new AgentThreadHtmlRunLedger(codec, file, { epoch, capability: INITIALIZATION })
  }
  constructor(private readonly codec: HtmlCheckpointCodec, private readonly file: string, initialization?: { epoch: string; capability: typeof INITIALIZATION }) {
    if (!codec.available()) throw new Error('Encrypted HTML run ledger unavailable.')
    if (initialization && (initialization.capability !== INITIALIZATION || !uuid(initialization.epoch) || lstatSync(file).size !== 0)) throw new Error('Invalid HTML run initialization.')
    regularPath(file); this.epoch = readAnchor(file + '.anchor')
    // SQLite can recover/checkpoint sidecars during open/PRAGMAs. Validate before
    // handing any path to it, not merely after it may have consumed the bytes.
    for (const suffix of ['-journal', '-wal', '-shm']) if (lstatSync(file + suffix, { throwIfNoEntry: false })) regularPath(file + suffix)
    if (initialization && initialization.epoch !== this.epoch) throw new Error('HTML run initialization anchor mismatch.')
    this.identity = lstatSync(file); this.anchorIdentity = lstatSync(file + '.anchor')
    this.db = new NodeSQLiteAdapter(file)
    try {
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;')
      if (initialization) {
        this.db.exec(`BEGIN IMMEDIATE; ${DDL}; PRAGMA application_id=1297109553; PRAGMA user_version=1;`)
        try { this.write({ version: 1, epoch: this.epoch, revision: 1, slots: [0, 1, 2, 3].map(slot => clearSlot(slot)) }); this.db.exec('COMMIT') }
        catch (error) { this.db.exec('ROLLBACK'); throw error }
      }
      this.read()
    } catch (error) { this.db.close(); throw error }
  }
  private check(): void {
    if (!this.codec.available()) throw new Error('Encrypted HTML run ledger unavailable.')
    regularPath(this.file)
    for (const suffix of ['-journal', '-wal', '-shm']) if (lstatSync(this.file + suffix, { throwIfNoEntry: false })) regularPath(this.file + suffix)
    const disk = lstatSync(this.file), anchor = lstatSync(this.file + '.anchor')
    if (disk.ino !== this.identity.ino || disk.dev !== this.identity.dev || anchor.ino !== this.anchorIdentity.ino || anchor.dev !== this.anchorIdentity.dev || readAnchor(this.file + '.anchor') !== this.epoch) throw new Error('HTML run ledger identity changed.')
    const objects = this.db.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 2')
    if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].name !== 'ledger' || objects[0].sql !== DDL || this.db.get('PRAGMA application_id')?.application_id !== 1297109553 || this.db.get('PRAGMA user_version')?.user_version !== 1) throw new Error('Invalid HTML run ledger schema.')
    const size = Number(this.db.get('PRAGMA page_size')?.page_size), pages = Number(this.db.get('PRAGMA page_count')?.page_count)
    if (!Number.isSafeInteger(size) || size < 512 || size > 65536 || (size & (size - 1)) !== 0 || !Number.isSafeInteger(pages) || pages < 1 || pages * size > MAX_DB) throw new Error('HTML run ledger disk limit unavailable.')
    const expected = Math.floor(MAX_DB / size), actual = Number(this.db.get(`PRAGMA max_page_count=${expected}`)?.max_page_count)
    if (!Number.isSafeInteger(actual) || actual !== expected) throw new Error('HTML run ledger disk limit unavailable.')
  }
  private read(): Ledger {
    this.check()
    // Revision, bound and payload belong to one SQLite statement/snapshot.
    // CASE prevents oversized ciphertext from being materialized in JS.
    const rows = this.db.all('SELECT id,revision,length(cipher) AS bytes,CASE WHEN length(cipher)<=? THEN cipher ELSE NULL END AS cipher FROM ledger LIMIT 2', MAX_CIPHER)
    if (rows.length !== 1 || rows[0].id !== 1 || !Number.isSafeInteger(rows[0].revision) || Number(rows[0].revision) < 1 || Number(rows[0].bytes) < 1 || Number(rows[0].bytes) > MAX_CIPHER) throw new Error('Invalid HTML run ledger bounds.')
    const row = rows[0]
    if (!(row.cipher instanceof Uint8Array)) throw new Error('HTML run cipher unavailable.')
    let plain: Buffer | undefined
    try { plain = this.codec.decryptBytes(row.cipher, `magicpot-html-runs-v1:${this.epoch}:${rows[0].revision}`, MAX_PLAIN); const value: unknown = JSON.parse(plain.toString('utf8')); validate(value, this.epoch, Number(rows[0].revision)); return value }
    finally { plain?.fill(0) }
  }
  private write(record: Ledger): void {
    validate(record, this.epoch, record.revision)
    const plain = Buffer.from(JSON.stringify(record))
    try {
      const cipher = this.codec.encryptBytes(plain, `magicpot-html-runs-v1:${this.epoch}:${record.revision}`)
      if (!(cipher instanceof Uint8Array) || cipher.length < 1 || cipher.length > MAX_CIPHER) throw new Error('HTML run cipher limit exceeded.')
      if (this.db.prepare('INSERT INTO ledger(id,revision,cipher) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,cipher=excluded.cipher').run(record.revision, cipher).changes !== 1) throw new Error('HTML run ledger write failed.')
    } finally { plain.fill(0) }
  }
  /** Serialize snapshot mutations with run reservation, across runtime connections. */
  withSavedIdle<T>(ownerHash: string, savedId: string, operation: () => T): T {
    this.check(); this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.hasSavedRun(ownerHash, savedId)) throw new Error('Saved HTML has an active or unconfirmed run.')
      const result = operation()
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('HTML saved-idle operation must be synchronous.')
      this.db.exec('COMMIT'); return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  hasSavedRun(ownerHash: string, savedId: string): boolean {
    if (!hash(ownerHash) || !uuid(savedId)) throw new Error('Invalid HTML saved-run identity.')
    const savedHash = createHash('sha256').update(ownerHash + ':' + savedId).digest('hex')
    return this.read().slots.some(slot => slot.status === 'unconfirmed' && slot.savedHash === savedHash)
  }
  isPristine(): boolean { const record = this.read(); return record.revision === 1 && record.slots.every(slot => slot.status === 'clear' && slot.generation === 0) }
  get epochId(): string { return this.epoch }
  list(): HtmlRunSlot[] { return structuredClone(this.read().slots) }
  reserve(ownerHash: string, savedId?: string, validateAdmission?: () => void): HtmlRunTicket {
    if (!hash(ownerHash) || savedId !== undefined && !uuid(savedId)) throw new Error('Invalid HTML run identity.')
    const savedHash = savedId ? createHash('sha256').update(ownerHash + ':' + savedId).digest('hex') : null
    this.check(); this.db.exec('BEGIN IMMEDIATE')
    try {
      const record = this.read()
      if (savedHash && record.slots.some(slot => slot.status === 'unconfirmed' && slot.savedHash === savedHash)) throw new Error('Prior saved HTML run is unconfirmed.')
      validateAdmission?.() // Under the same write lock as snapshot mutation.
      const slot = record.slots.find(slot => slot.status === 'clear')
      if (!slot || slot.generation >= Number.MAX_SAFE_INTEGER || record.revision >= Number.MAX_SAFE_INTEGER) throw new Error('HTML run capacity exhausted or generation unavailable.')
      slot.generation++; slot.status = 'unconfirmed'; slot.ownerHash = ownerHash; slot.savedHash = savedHash; slot.startedAt = Date.now(); record.revision++
      this.write(record); const verified = this.read(); if (JSON.stringify(verified) !== JSON.stringify(record)) throw new Error('HTML run reserve verification failed.')
      this.db.exec('COMMIT')
      const ticket = Object.freeze({ slot: slot.slot, generation: slot.generation }); this.tickets.set(ticket, { slot: slot.slot, generation: slot.generation }); return ticket
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Call only from main's retained launcher completion, never renderer/model flags. */
  confirmEmpty(ticket: HtmlRunTicket): void {
    const held = this.tickets.get(ticket)
    if (!held) throw new Error('HTML run completion ticket is not owned by this runtime.')
    this.check(); this.db.exec('BEGIN IMMEDIATE')
    try {
      const record = this.read(), slot = record.slots[held.slot]
      if (!slot || slot.generation !== held.generation || slot.status !== 'unconfirmed' || record.revision >= Number.MAX_SAFE_INTEGER) throw new Error('HTML run completion revision conflict.')
      record.slots[held.slot] = clearSlot(held.slot, held.generation); record.revision++
      this.write(record); if (JSON.stringify(this.read()) !== JSON.stringify(record)) throw new Error('HTML run clear verification failed.')
      this.db.exec('COMMIT'); this.tickets.delete(ticket)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close(): void { this.tickets.clear(); this.db.close() }
}
