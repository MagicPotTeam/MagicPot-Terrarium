import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { CheckpointBinaryCodec } from '../figplugin/checkpointBinaryCodec'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
import { applyDispatchLedger, DISPATCH_LEDGER_LIMITS, emptyDispatchLedger, validateDispatchLedger, type DispatchLedgerCommand, type DispatchLedgerDocument } from './providerDispatchLedgerPolicy'

import { applyInvocationLedger, upgradeInvocationLedger, validateInvocationLedger, type InvocationLedgerCommand, type InvocationLedgerDocument, type InvocationLedgerResult, type InvocationUpgradeCommand } from './providerInvocationLedgerPolicy'

export type ProviderLedgerDocument = DispatchLedgerDocument | InvocationLedgerDocument
export type ProviderLedgerRead<T extends ProviderLedgerDocument = ProviderLedgerDocument> = { document: T; orphaned: boolean; mutationBlocked: boolean; grantsPermission: false }
export class ProviderLedgerVersionError extends Error {
  constructor(expected: 1 | 2, actual: 1 | 2) { super(`Dispatch ledger payload version ${actual} is unsupported by the v${expected} API; no reset, fallback or automatic upgrade.`) }
}
type LegacyResult = ReturnType<typeof applyDispatchLedger> & { grantsPermission: false }
type MutationResult = LegacyResult | InvocationLedgerResult
const dataAccess = new WeakMap<ProviderDispatchLedgerStore, { upgrade(scope: AgentThreadInteractionScope, input: InvocationUpgradeCommand, now?: number): InvocationLedgerResult; apply(scope: AgentThreadInteractionScope, input: InvocationLedgerCommand, now?: number): InvocationLedgerResult }>()

export const DISPATCH_LEDGER_STORAGE_LIMITS = Object.freeze({ owners: 128, cipherBytes: 196 * 1024, totalReservedCipherBytes: 12 * 1024 * 1024, databaseBytes: 16 * 1024 * 1024 })
type Codec = CheckpointBinaryCodec & { available(): boolean }
const S = DISPATCH_LEDGER_STORAGE_LIMITS
/** Partial open retained a native handle whose closure was not confirmed.
 * An ownership host MUST retain its lock; never infer a clean open failure. */
export class ProviderDispatchLedgerOpenUncertainError extends Error {
  readonly #native: NodeSQLiteAdapter | undefined
  constructor(native: NodeSQLiteAdapter | undefined, cause: unknown) { super('Dispatch ledger partial-open native closure is uncertain.', { cause }); this.#native = native }
  get isNativeClosed(): boolean { return Boolean(this.#native && !this.#native.database.isOpen) }
  closeNative(): void { if (!this.#native) throw new Error('Ledger constructor returned no inspectable native handle; closure remains unconfirmed.'); this.#native.close() }
}
const DDL = 'CREATE TABLE dispatch_ledger (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, cipher BLOB NOT NULL)'
const APPLICATION_ID = 0x4d50444c
const normalizedSql = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : ''
function owner(scope: AgentThreadInteractionScope): string {
  const route = normalizeAgentRoute(scope.route)
  if (route.channel !== 'canvas' || route.scopeType !== 'thread' || ![route.scopeId, route.threadId, scope.conversationId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))) throw new Error('Invalid dispatch ledger scope.')
  return createHash('sha256').update(JSON.stringify([getAgentSessionKey(route), scope.conversationId])).digest('hex')
}
function inspect(file: string): void {
  const absolute = path.resolve(file); let current = path.parse(absolute).root
  for (const segment of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, segment)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (!stat) break
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory()) || current === absolute && (!stat.isFile() || stat.nlink !== 1 || stat.size > S.databaseBytes)) throw new Error('Unsafe dispatch ledger database path.')
  }
}
/** DATA storage, not a capability issuer or authorization API. The fixed owner
 * factory supports explicit user-only accounting inspection and request-bound
 * capped recordkeeping, never an autonomous goal runner or model-owned factory.
 * Caller provenance and dispatch binding remain prerequisites.
 * Reading/replaying data NEVER authorizes send.
 * Only this instance's confirmed begin can make fresh data mutations; orphan
 * fencing may revoke another instance's run but never resume/settle it.
 * Every owner reserves a full cipher slot before admission. No deletion/eviction.
 * DELETE journal + FULL synchronous, DB16MiB and sidecars separately bounded;
 * disk/OS errors still can prevent receipts, so fail closed, never promise writes.
 * Path identity checks are optimistic, NOT a hostile-same-user OS sandbox.
 * AEAD does NOT prevent restoring a legitimate old row/revision or whole DB;
 * this store is NOT rollback-resistant/monotonic execution authority. */
export class ProviderDispatchLedgerStore {
  private readonly db: NodeSQLiteAdapter
  private readonly identity?: { dev: number; ino: number }
  private readonly ownedRuns = new Map<string, { version: 1 | 2; id: string }>()
  private poisoned = false
  private closed = false
  private mutating = false
  private reading = false
  private revocation = 0
  private poison(): void { this.poisoned = true; this.revocation++; this.ownedRuns.clear() }
  constructor(private readonly codec: Codec, private readonly file = ':memory:') {
    if (!codec.available() || file !== ':memory:' && !path.isAbsolute(file)) throw new Error('Encrypted dispatch ledger storage unavailable or invalid path.')
    if (file !== ':memory:') for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(file + suffix)
    const before = file !== ':memory:' ? lstatSync(file, { throwIfNoEntry: false }) : undefined
    // An exception before adapter assignment is not a native-close receipt. Keep
    // a distinct uninspectable uncertainty carrier for the owning host, even when
    // it may be a clean filesystem/open failure. Never infer closure from absence.
    try { this.db = new NodeSQLiteAdapter(file) }
    catch (error) { throw new ProviderDispatchLedgerOpenUncertainError(undefined, error) }
    try {
      if (file !== ':memory:') {
        for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(file + suffix)
        this.identity = lstatSync(file)
        if (before && (before.dev !== this.identity.dev || before.ino !== this.identity.ino)) throw new Error('Dispatch ledger identity changed during open.')
      }
      const objects = this.db.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 3')
      if (this.db.get('PRAGMA application_id')?.application_id === 0 && this.db.get('PRAGMA user_version')?.user_version === 0 && !objects.length) this.db.exec(`BEGIN IMMEDIATE; ${DDL}; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`)
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;')
      this.check()
      // Only the separately constructed DATA facade gets v2 write closures. The
      // production owner constructs the base class and cannot mint these through
      // method borrowing. This is main trust separation, NOT a JS sandbox.
      if (new.target === ProviderInvocationLedgerDataStore) dataAccess.set(this, { upgrade: (scope, input, now = Date.now()) => this.mutate('upgrade', scope, input, now), apply: (scope, input, now = Date.now()) => this.mutate('v2', scope, input, now) })
    } catch (error) {
      try {
        this.db.close()
        if (this.db.database.isOpen) throw new Error('Ledger constructor native close was not confirmed.')
      } catch (closeError) { throw new ProviderDispatchLedgerOpenUncertainError(this.db, new AggregateError([error, closeError], 'Ledger open and cleanup failed.')) }
      throw error
    }
  }
  private check(): void {
    if (this.closed || !this.codec.available()) throw new Error('Dispatch ledger is closed or encryption unavailable.')
    if (this.identity) {
      for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(this.file + suffix)
      const stat = lstatSync(this.file)
      if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || path.resolve(realpathSync(this.file)).toLowerCase() !== path.resolve(this.file).toLowerCase()) throw new Error('Dispatch ledger database identity changed.')
    }
    const objects = this.db.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 3')
    const expected = new Map([['dispatch_ledger', { type: 'table', sql: normalizedSql(DDL) }], ['sqlite_autoindex_dispatch_ledger_1', { type: 'index', sql: '' }]])
    if (this.db.get('PRAGMA application_id')?.application_id !== APPLICATION_ID || this.db.get('PRAGMA user_version')?.user_version !== 1 || objects.length !== expected.size || objects.some(item => { const entry = expected.get(String(item.name)); return !entry || item.type !== entry.type || item.tbl_name !== 'dispatch_ledger' || normalizedSql(item.sql) !== entry.sql })) throw new Error('Invalid dispatch ledger schema.')
    const page = Number(this.db.get('PRAGMA page_size')?.page_size), count = Number(this.db.get('PRAGMA page_count')?.page_count)
    if (!Number.isSafeInteger(page) || page < 512 || page > 65536 || (page & (page - 1)) !== 0 || !Number.isSafeInteger(count) || count * page > S.databaseBytes) throw new Error('Dispatch ledger page budget exceeded.')
    const maximum = Math.floor(S.databaseBytes / page)
    if (Number(this.db.get('PRAGMA max_page_count')?.max_page_count) !== maximum && Number(this.db.get(`PRAGMA max_page_count=${maximum}`)?.max_page_count) !== maximum) throw new Error('Dispatch ledger byte ceiling unavailable.')
    const totals = this.db.get('SELECT count(*) AS n,coalesce(max(length(cipher)),0) AS biggest FROM dispatch_ledger')!
    if (!Number.isSafeInteger(totals.n) || Number(totals.n) > S.owners || Number(totals.n) * S.cipherBytes > S.totalReservedCipherBytes || !Number.isSafeInteger(totals.biggest) || Number(totals.biggest) > S.cipherBytes || Number(this.db.get('PRAGMA synchronous')?.synchronous) !== 2 || String(this.db.get('PRAGMA journal_mode')?.journal_mode).toLowerCase() !== (this.file === ':memory:' ? 'memory' : 'delete')) throw new Error('Dispatch ledger reserved capacity or durability mode invalid.')
  }
  private readOwner(key: string): ProviderLedgerDocument {
    this.check()
    const row = this.db.get('SELECT revision,length(cipher) AS bytes,CASE WHEN length(cipher)<=? THEN cipher ELSE NULL END AS cipher FROM dispatch_ledger WHERE owner=?', S.cipherBytes, key)
    if (!row) return emptyDispatchLedger(key)
    if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > S.cipherBytes || !(row.cipher instanceof Uint8Array)) throw new Error('Invalid dispatch ledger cipher header.')
    let plain: Buffer | undefined
    try {
      plain = this.codec.decryptBytes(row.cipher, `magicpot-dispatch-ledger-v1:${key}:${row.revision}`, DISPATCH_LEDGER_LIMITS.plainBytes)
      const doc: unknown = JSON.parse(plain.toString('utf8'))
      // Discriminate exactly once. Never try another validator, reset or migrate
      // after an authentication/schema failure. AAD/schema/files stay unchanged.
      if (doc && typeof doc === 'object' && 'version' in doc && doc.version === 2) validateInvocationLedger(doc)
      else validateDispatchLedger(doc)
      const document = doc as ProviderLedgerDocument
      if (document.ownerHash !== key || document.revision !== row.revision) throw new Error('Dispatch ledger owner/revision mismatch.')
      return document
    } finally { plain?.fill(0) }
  }
  read(scope: AgentThreadInteractionScope): ProviderLedgerRead<DispatchLedgerDocument> {
    const value = this.readCurrent(scope)
    if (value.document.version !== 1) throw new ProviderLedgerVersionError(1, value.document.version)
    return { ...value, document: value.document }
  }
  /** Authenticated union DATA only. Missing owners remain empty v1. No upgrade. */
  readCurrent(scope: AgentThreadInteractionScope): ProviderLedgerRead {
    let entered = false
    try {
      // Only private readOwner may observe this connection's tentative row for
      // verification. Public reads never publish data from an in-flight write.
      if (this.mutating || this.reading || this.db.database.isTransaction) throw new Error('Dispatch ledger public read is blocked during an active operation or transaction.')
      this.reading = entered = true
      const epoch = this.revocation, key = owner(structuredClone(scope)), document = this.readOwner(key)
      if (this.closed || epoch !== this.revocation) throw new Error('Dispatch ledger public read was revoked during verification.')
      const owned = this.ownedRuns.get(key)
      return { document, orphaned: document.runs.some(run => run.status === 'active' && (owned?.id !== run.id || owned?.version !== document.version)), mutationBlocked: this.poisoned, grantsPermission: false }
    } catch (error) { this.poison(); throw error }
    finally { if (entered) this.reading = false }
  }
  apply(scope: AgentThreadInteractionScope, input: DispatchLedgerCommand, now = Date.now()): LegacyResult { return this.mutate('v1', scope, input, now) }
  private mutate(mode: 'v1', scope: AgentThreadInteractionScope, input: DispatchLedgerCommand, now: number): LegacyResult
  private mutate(mode: 'v2' | 'upgrade', scope: AgentThreadInteractionScope, input: InvocationLedgerCommand, now: number): InvocationLedgerResult
  private mutate(mode: 'v1' | 'v2' | 'upgrade', scope: AgentThreadInteractionScope, input: InvocationLedgerCommand, now: number): MutationResult {
    if (this.reading || this.mutating) { this.poison(); throw new Error('Dispatch ledger mutations blocked during an active operation; no execution authority was issued.') }
    if (this.poisoned || this.closed) throw new Error('Dispatch ledger mutations blocked; no execution authority was issued.')
    this.mutating = true
    const epoch = this.revocation
    const verifyLive = (where: string) => { if (this.poisoned || this.closed || epoch !== this.revocation) throw new Error(`Dispatch ledger was revoked during ${where}.`) }
    let opening = false, transaction = false, uncertain = false, plain: Buffer | undefined
    try {
      // Acquire the operation guard BEFORE callback-capable accessors/snapshotting.
      const key = owner(structuredClone(scope)), command = structuredClone(input)
      verifyLive('input capture')
      uncertain = true
      this.check(); verifyLive('pre-BEGIN check'); opening = true; this.db.exec('BEGIN IMMEDIATE'); transaction = true; opening = false
      if (!this.db.database.isOpen || !this.db.database.isTransaction) throw new Error('Dispatch ledger native BEGIN was not confirmed.')
      const current = this.readOwner(key)
      verifyLive('source verification')
      uncertain = false // Authenticated version/CAS/policy rejection is known, not storage uncertainty.
      let result: MutationResult
      if (mode === 'v1') {
        if (current.version !== 1) throw new ProviderLedgerVersionError(1, current.version)
        result = { ...applyDispatchLedger(current, command as DispatchLedgerCommand, now), grantsPermission: false }
      } else if (mode === 'upgrade') {
        if (command.action !== 'upgrade-v2') throw new Error('Invalid explicit ledger upgrade command.')
        result = current.version === 1 ? upgradeInvocationLedger(current, command, now) : applyInvocationLedger(current, command, now)
      } else {
        if (current.version !== 2) throw new ProviderLedgerVersionError(2, current.version)
        result = applyInvocationLedger(current, command, now)
      }
      verifyLive('policy validation')
      if (result.replay) {
        uncertain = true; this.db.exec('COMMIT'); transaction = false
        verifyLive('replay receipt lost instance ownership; no new authority was issued')
        if (this.db.database.isTransaction) throw new Error('Dispatch ledger replay COMMIT was not confirmed.')
        return { ...result, grantsPermission: false }
      }
      const runId = 'runId' in command ? command.runId : undefined, owned = this.ownedRuns.get(key)
      if (!['begin', 'orphan', 'begin-v2', 'orphan-v2', 'upgrade-v2'].includes(command.action) && (owned?.id !== runId || owned?.version !== current.version)) throw new Error('Orphan dispatch run cannot be continued or settled by this instance.')
      uncertain = true
      const totals = this.db.get('SELECT count(*) AS n FROM dispatch_ledger')!
      uncertain = false
      if (current.revision === 0 && (Number(totals.n) >= S.owners || (Number(totals.n) + 1) * S.cipherBytes > S.totalReservedCipherBytes)) throw new Error('Dispatch ledger reserved slot capacity reached; no replay domains were evicted.')
      plain = Buffer.from(JSON.stringify(result.document), 'utf8')
      uncertain = true // Codec/database callbacks may fail or reenter; never infer rollback from an exception.
      const cipher = this.codec.encryptBytes(plain, `magicpot-dispatch-ledger-v1:${key}:${result.document.revision}`)
      verifyLive('encryption')
      if (!(cipher instanceof Uint8Array) || cipher.length < 1 || cipher.length > S.cipherBytes) throw new Error('Dispatch ledger cipher byte ceiling exceeded.')
      if (this.db.prepare('INSERT INTO dispatch_ledger(owner,revision,cipher) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,cipher=excluded.cipher').run(key, result.document.revision, cipher).changes !== 1) throw new Error('Dispatch ledger write not confirmed.')
      const verified = this.readOwner(key)
      verifyLive('write verification')
      if (JSON.stringify(verified) !== JSON.stringify(result.document)) throw new Error('Dispatch ledger write verification mismatch.')
      this.db.exec('COMMIT'); transaction = false
      verifyLive('commit receipt lost instance ownership; committed data may remain')
      if (this.db.database.isTransaction) throw new Error('Dispatch ledger native COMMIT was not confirmed.')
      if (command.action === 'begin' || command.action === 'begin-v2') this.ownedRuns.set(key, { version: result.document.version, id: command.runId })
      else if (command.action === 'upgrade-v2' || result.document.runs.find(run => run.id === runId)?.status !== 'active') this.ownedRuns.delete(key)
      return result
    } catch (error) {
      if (uncertain) this.poison()
      // BEGIN itself may have succeeded before its acknowledgement was lost.
      // Query native transaction state, never infer it from a returned boolean.
      if (opening || transaction || this.db.database.isOpen && this.db.database.isTransaction) {
        try {
          if (this.db.database.isOpen && this.db.database.isTransaction) this.db.exec('ROLLBACK')
          if (this.db.database.isOpen && this.db.database.isTransaction) throw new Error('Dispatch ledger rollback was not confirmed.')
        } catch { this.poison() } // Keep instance fenced; owner retains uncertain native handles.
      }
      throw error
    } finally { plain?.fill(0); this.mutating = false }
  }
  get isNativeClosed(): boolean { return !this.db.database.isOpen }
  close(): void {
    if (this.closed && this.isNativeClosed) return
    this.closed = true; this.ownedRuns.clear()
    // A failed native close is NOT confirmation. Retrying must still reach SQLite,
    // and an ownership wrapper must retain its lock until isNativeClosed is true.
    this.db.close()
  }
}

/** Isolated main/test DATA facade, not constructed or exposed by the production
 * owner/factory. Only the isolated owner host selects this sole connection.
 * Upgrading a payload or writing a unit grants NO invocation capability; isolated
 * admission exists separately but production user opt-in/entries are not wired.
 * Same file/table/owner hash/AAD and native transaction/poison/close machinery.
 * Missing owners stay v1 until an explicit upgrade, including for empty history.
 * Never open a second instance alongside a production owner to bypass its lock. */
export class ProviderInvocationLedgerDataStore extends ProviderDispatchLedgerStore {
  upgradeV2(scope: AgentThreadInteractionScope, input: InvocationUpgradeCommand, now = Date.now()): InvocationLedgerResult {
    const access = dataAccess.get(this)
    if (!access) throw new Error('No isolated v2 DATA-store identity.')
    return access.upgrade(scope, input, now)
  }
  applyV2(scope: AgentThreadInteractionScope, input: InvocationLedgerCommand, now = Date.now()): InvocationLedgerResult {
    const access = dataAccess.get(this)
    if (!access) throw new Error('No isolated v2 DATA-store identity.')
    return access.apply(scope, input, now)
  }
}
