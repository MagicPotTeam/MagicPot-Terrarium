import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { CheckpointBinaryCodec } from '../figplugin/checkpointBinaryCodec'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
import { createProviderDispatchAdmission, type ProviderDispatchAdmission, type ProviderDispatchAdmissionOptions } from './providerDispatchAdmission'
import { ProviderDispatchLedgerStore, ProviderDispatchLedgerOpenUncertainError, ProviderInvocationLedgerDataStore } from './providerDispatchLedgerStore'
import type { ProviderInvocationAdmission, ProviderInvocationAdmissionOptions } from './providerInvocationAdmission'
import type { InvocationLedgerResult, InvocationUpgradeCommand } from './providerInvocationLedgerPolicy'

type Codec = CheckpointBinaryCodec & { available(): boolean }
export type ProviderInvocationOwnerHost = {
  readCurrentData(scope: AgentThreadInteractionScope): ReturnType<ProviderDispatchLedgerStore['readCurrent']>
  /** Trusted MAIN/test DATA operation, not user consent or an invocation grant. */
  trustedUpgrade(scope: AgentThreadInteractionScope, input: InvocationUpgradeCommand): InvocationLedgerResult
  createInvocationAdmission(options: Omit<ProviderInvocationAdmissionOptions, 'store'>): ProviderInvocationAdmission
  shutdown(): Promise<void>
}
type InvocationBuilder = (options: ProviderInvocationAdmissionOptions) => ProviderInvocationAdmission
type HostedEntry = { request?: ProviderInvocationAdmission; controller: AbortController; retire(): void; constructing: boolean; errors: unknown[]; drained?: Promise<void> }
const invocationMode = Symbol('isolated main-only invocation owner')
const hostAccess = new WeakMap<ProviderDispatchOwner, {
  upgrade(scope: AgentThreadInteractionScope, input: InvocationUpgradeCommand): InvocationLedgerResult
  create(builder: InvocationBuilder, options: Omit<ProviderInvocationAdmissionOptions, 'store'>): ProviderInvocationAdmission
}>()
const DDL = 'CREATE TABLE owner_identity (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1))'
const APPLICATION_ID = 0x4d50444f, MAX_BYTES = 1024 * 1024
const sql = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : ''
const quarantine = new Set<ProviderDispatchOwner>() // Preserve native handles when confirmed closure is unavailable.
const unavailable = (reason: string) => new Error(`Dispatch owner ${reason}.`)
function inspect(file: string): void {
  const absolute = path.resolve(file); let current = path.parse(absolute).root
  for (const segment of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, segment)
    const stat = lstatSync(current, { throwIfNoEntry: false }); if (!stat) break
    if (stat.isSymbolicLink() || current !== absolute && !stat.isDirectory() || current === absolute && (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES)) throw unavailable('unsafe ownership path')
  }
}
/** Cooperative lifetime ownership only, NOT hostile-writer/backup rollback
 * protection or global app singleton. Fixed paired files; never unlink/repair or
 * select another namespace after contention. Crash releases the SQLite lock but
 * never restores old execution capabilities. Explicit user-only accounting reads
 * may initialize this owner; trusted capped recordkeeping may construct request
 * admissions. No scheduler, autonomous pursuit or model-managed owner is exposed.
 * Main must choose a private canonical root. Root parameter is a test/main API,
 * not a renderer/config/environment capability. No plaintext encryption fallback. */
export class ProviderDispatchOwner {
  private readonly lock: NodeSQLiteAdapter
  private store?: ProviderDispatchLedgerStore
  private incompleteLedger?: ProviderDispatchLedgerOpenUncertainError
  private readonly identity: { dev: number; ino: number }
  private readonly root: string
  private readonly file: string
  private held = false
  private closed = false
  private shutdownPromise?: Promise<void>
  private readonly entries = new Set<{ request?: ProviderDispatchAdmission; controller: AbortController; retire?: () => void }>()
  private readonly invocationEntries = new Set<HostedEntry>()
  private hostBusy = false
  constructor(root: string, codec: Codec, mode?: typeof invocationMode) {
    if (mode !== undefined && mode !== invocationMode) throw unavailable('invalid isolated host construction identity')
    if (!path.isAbsolute(root) || !codec.available()) throw unavailable('requires a main-selected absolute private root and OS codec')
    this.root = path.resolve(root)
    this.file = path.join(this.root, 'owner-v1.sqlite')
    for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(this.file + suffix)
    const before = lstatSync(this.file, { throwIfNoEntry: false })
    this.lock = new NodeSQLiteAdapter(this.file, 0)
    try {
      this.lock.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;')
      const objects = this.lock.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 2')
      if (!objects.length && this.lock.get('PRAGMA application_id')?.application_id === 0 && this.lock.get('PRAGMA user_version')?.user_version === 0) this.lock.exec(`BEGIN IMMEDIATE; ${DDL}; INSERT INTO owner_identity(id,version) VALUES(1,1); PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`)
      // Bootstrap is committed independently; shutdown rollback cannot erase it.
      this.lock.exec('BEGIN EXCLUSIVE'); this.held = true
      this.identity = lstatSync(this.file)
      if (before && (before.dev !== this.identity.dev || before.ino !== this.identity.ino)) throw unavailable('ownership file changed during open')
      this.check()
      this.store = mode === invocationMode ? new ProviderInvocationLedgerDataStore(codec, path.join(this.root, 'ledger-v1.sqlite')) : new ProviderDispatchLedgerStore(codec, path.join(this.root, 'ledger-v1.sqlite'))
      this.check()
      if (mode === invocationMode) hostAccess.set(this, {
        upgrade: (scope, input) => {
          if (this.hostBusy || this.entries.size || this.invocationEntries.size) throw unavailable('upgrade overlaps an occupied admission or owner operation')
          this.hostBusy = true
          try { this.check(); const result = (this.store as ProviderInvocationLedgerDataStore).upgradeV2(scope, input); this.check(); return result }
          finally { this.hostBusy = false }
        },
        create: (builder, options) => this.createHostedInvocation(builder, options)
      })
    } catch (error) {
      this.closed = true
      if (error instanceof ProviderDispatchLedgerOpenUncertainError) { this.incompleteLedger = error; quarantine.add(this); throw error }
      try { if (this.store) { this.store.close(); if (!this.store.isNativeClosed) throw unavailable('construction ledger native closure was not confirmed') } }
      catch (cleanup) { quarantine.add(this); throw new AggregateError([error, cleanup], 'Dispatch owner construction ledger cleanup was not confirmed.') }
      try {
        // BEGIN may have executed before throwing its acknowledgement. Check the
        // native state, not just the assignment to held after exec returned.
        if (this.lock.database.isTransaction) this.lock.exec('ROLLBACK')
        if (this.lock.database.isTransaction) throw unavailable('construction ownership rollback was not confirmed')
        this.held = false; this.lock.close()
        if (this.lock.database.isOpen) throw unavailable('construction ownership native closure was not confirmed')
      } catch (cleanup) { quarantine.add(this); throw new AggregateError([error, cleanup], 'Dispatch owner construction ownership cleanup was not confirmed.') }
      throw error
    }
  }
  private check(): void {
    if (this.closed || !this.held || !this.lock.database.isOpen || !this.lock.database.isTransaction) throw unavailable('is retired or lost its exclusive transaction')
    for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(this.file + suffix)
    const stat = lstatSync(this.file)
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || path.resolve(realpathSync(this.root)).toLowerCase() !== this.root.toLowerCase() || path.resolve(realpathSync(this.file)).toLowerCase() !== this.file.toLowerCase()) throw unavailable('file identity changed')
    const objects = this.lock.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 2')
    if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].name !== 'owner_identity' || objects[0].tbl_name !== 'owner_identity' || sql(objects[0].sql) !== sql(DDL) || this.lock.get('PRAGMA application_id')?.application_id !== APPLICATION_ID || this.lock.get('PRAGMA user_version')?.user_version !== 1 || this.lock.all('SELECT id,version FROM owner_identity LIMIT 2').length !== 1 || this.lock.get('SELECT id,version FROM owner_identity WHERE id=1')?.version !== 1) throw unavailable('schema is not recognized')
    const page = Number(this.lock.get('PRAGMA page_size')?.page_size), count = Number(this.lock.get('PRAGMA page_count')?.page_count)
    if (!Number.isSafeInteger(page) || page < 512 || page > 65536 || (page & (page - 1)) !== 0 || !Number.isSafeInteger(count) || count * page > MAX_BYTES || this.lock.get('PRAGMA synchronous')?.synchronous !== 2 || this.lock.get('PRAGMA journal_mode')?.journal_mode !== 'delete') throw unavailable('resource/durability limits unavailable')
    const maximum = Math.floor(MAX_BYTES / page)
    if (Number(this.lock.get('PRAGMA max_page_count')?.max_page_count) !== maximum && Number(this.lock.get(`PRAGMA max_page_count=${maximum}`)?.max_page_count) !== maximum) throw unavailable('byte ceiling unavailable')
    // Reads may reenter trusted hooks. Entry and return fences must notice a
    // shutdown latched DURING verification, before its queued teardown runs.
    if (this.closed || !this.held || !this.lock.database.isOpen || !this.lock.database.isTransaction) throw unavailable('retired during ownership verification')
  }
  readData(scope: AgentThreadInteractionScope): ReturnType<ProviderDispatchLedgerStore['read']> {
    this.check(); const result = this.store!.read(scope); this.check(); return result
  }
  /** Version-aware inspection DATA only. No upgrade or v2 mutation surface. */
  readCurrentData(scope: AgentThreadInteractionScope): ReturnType<ProviderDispatchLedgerStore['readCurrent']> {
    this.check(); const result = this.store!.readCurrent(scope); this.check(); return result
  }
  createAdmission(options: Omit<ProviderDispatchAdmissionOptions, 'store'>): ProviderDispatchAdmission {
    this.check()
    if (this.entries.size + this.invocationEntries.size >= 32) throw unavailable('admission capacity reached')
    // Reserve a slot before touching caller accessors/codec/admission callbacks.
    const entry: { request?: ProviderDispatchAdmission; controller: AbortController; retire?: () => void } = { controller: new AbortController() }
    this.entries.add(entry)
    const forget = () => this.entries.delete(entry)
    let parentSignal: AbortSignal | undefined
    const retire = () => {
      parentSignal?.removeEventListener('abort', retire)
      try { entry.controller.abort(unavailable('admission retired')); entry.request?.dispose() }
      finally { if (entry.request) forget() }
    }
    entry.retire = retire
    try {
      const input = { ...options }, assertLive = input.assertLive
      parentSignal = input.signal
      parentSignal.addEventListener('abort', retire, { once: true })
      const request = createProviderDispatchAdmission({ ...input, store: this.store!, signal: AbortSignal.any([parentSignal, entry.controller.signal]), assertLive: () => {
        this.check()
        const result: unknown = assertLive()
        if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') { void Promise.resolve(result).catch(() => undefined); throw unavailable('live callback must be synchronous') }
        this.check()
      } })
      entry.request = request
      this.check()
      if (entry.controller.signal.aborted || parentSignal.aborted) throw unavailable('admission was revoked during construction')
      return {
        fetch: async (input, init) => { try { return await request.fetch(input, init) } catch (error) { if (request.state === 'blocked' || request.state === 'disposed') retire(); throw error } },
        get state() { return request.state },
        finish() { request.finish(); parentSignal?.removeEventListener('abort', retire); forget() },
        dispose: retire
      }
    } catch (error) { try { retire() } finally { forget() }; throw error }
  }
  /** Private host closure only; never reachable from an ordinary owner facade.
   * A blocked/cancelled caller promise is NOT proof its callback has unwound. */
  private createHostedInvocation(builder: InvocationBuilder, options: Omit<ProviderInvocationAdmissionOptions, 'store'>): ProviderInvocationAdmission {
    if (!hostAccess.has(this) || !(this.store instanceof ProviderInvocationLedgerDataStore) || this.hostBusy) throw unavailable('isolated invocation host is unavailable or busy')
    if (this.entries.size + this.invocationEntries.size >= 32) throw unavailable('admission capacity reached')
    const entry: HostedEntry = { controller: new AbortController(), constructing: true, errors: [], retire: () => undefined }
    this.invocationEntries.add(entry); this.hostBusy = true
    let parentSignal: AbortSignal | undefined, retired = false
    const drain = () => {
      if (entry.constructing || entry.drained) return
      // Defer past synchronous construction/finish and observe every rejection.
      entry.drained = Promise.resolve().then(async () => {
        if (entry.request) await entry.request.drain()
        if (entry.errors.length) throw new AggregateError(entry.errors, 'Invocation disposal was not confirmed.')
        this.invocationEntries.delete(entry)
      })
      void entry.drained.catch(() => { quarantine.add(this) })
    }
    const retire = () => {
      if (!retired) {
        retired = true
        try { parentSignal?.removeEventListener('abort', retire) } catch (error) { entry.errors.push(error) }
        try { entry.controller.abort(unavailable('hosted invocation retired')) } catch (error) { entry.errors.push(error) }
        try { entry.request?.dispose() } catch (error) { entry.errors.push(error) }
      }
      drain()
    }
    entry.retire = retire
    try {
      // Slot/operation guards precede option accessors and all guard/codec calls.
      this.check()
      const input = { ...options }, assertLive = input.assertLive
      parentSignal = input.signal
      if (!(parentSignal instanceof AbortSignal)) throw unavailable('requires an AbortSignal')
      parentSignal.addEventListener('abort', retire, { once: true })
      parentSignal.throwIfAborted(); this.check()
      const request = builder({ ...input, store: this.store, signal: AbortSignal.any([parentSignal, entry.controller.signal]), assertLive: () => {
        this.check()
        const result: unknown = assertLive()
        if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') { void Promise.resolve(result).catch(() => undefined); throw unavailable('live callback must be synchronous') }
        this.check()
      } })
      entry.request = request // Assign BEFORE callbacks in post-construction checks.
      this.check()
      if (retired || entry.controller.signal.aborted || parentSignal.aborted) throw unavailable('hosted invocation was revoked during construction')
      const verifyHost = () => {
        try {
          this.check()
          if (retired || entry.controller.signal.aborted || parentSignal!.aborted || Date.now() >= input.deadlineAt) throw unavailable('hosted invocation return or entry was revoked/expired')
        } catch (error) { retire(); throw error }
      }
      return {
        runModel: async entry => {
          try { verifyHost(); const result = await request.runModel(entry); verifyHost(); return result }
          catch (error) { if (this.closed || request.state === 'blocked' || request.state === 'disposed') retire(); throw error }
        },
        runTool: async (parent, entry) => {
          try { verifyHost(); const result = await request.runTool(parent, entry); verifyHost(); return result }
          catch (error) { if (this.closed || request.state === 'blocked' || request.state === 'disposed') retire(); throw error }
        },
        get state() { return request.state },
        finish: () => { try { this.check(); request.finish() } catch (error) { retire(); throw error }; retire() },
        dispose: retire,
        drain: async () => { await request.drain(); if (entry.drained) await entry.drained }
      }
    } catch (error) { retire(); throw error }
    finally { entry.constructing = false; this.hostBusy = false; if (retired) drain() }
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true // Immediate revocation, before any callback/native teardown.
    quarantine.add(this) // Also retain an indefinitely abort-ignoring callback host.
    let resolve!: () => void, reject!: (error: unknown) => void
    this.shutdownPromise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    // Teardown must not close SQLite during a synchronous constructor/mutation.
    queueMicrotask(() => {
      void (async () => {
        const errors: unknown[] = []
        for (const entry of [...this.entries]) { try { entry.retire?.() } catch (error) { errors.push(error) } }
        this.entries.clear()
        const entries = [...this.invocationEntries]
        for (const entry of entries) { try { entry.retire() } catch (error) { errors.push(error) } }
        // Wait ALL callbacks, even when another drain/dispose failed. Never infer
        // quiescence from a rejected caller, state=blocked, timeout or disposed flag.
        const results = await Promise.allSettled(entries.map(entry => entry.drained ?? Promise.reject(unavailable('invocation construction/drain did not unwind'))))
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
        if (errors.length) throw new AggregateError(errors, 'Dispatch owner admission drainage was not confirmed.')
        if (this.incompleteLedger) throw unavailable('partial-open native ledger is quarantined until process exit')
        this.store!.close()
        if (!this.store!.isNativeClosed) throw unavailable('ledger native closure was not confirmed')
        this.lock.exec('ROLLBACK')
        if (this.lock.database.isTransaction) throw unavailable('ownership native rollback was not confirmed')
        this.held = false; this.lock.close()
        if (this.lock.database.isOpen) throw unavailable('ownership native closure was not confirmed')
        quarantine.delete(this)
      })().then(resolve, error => { quarantine.add(this); reject(error) }) // Never unlock on uncertain ledger/drain closure.
    })
    return this.shutdownPromise
  }
}

/** ISOLATED MAIN/TEST factory. NOT called by getProviderDispatchOwner, IPC/UI,
 * model tools or a scheduler. No implicit upgrade, user consent or execution
 * permission. One exact DATA store under the same lifetime owner lock; never
 * compose a second writer beside a production owner. Later production integration
 * must jointly establish supported execution routes AND trusted user consent. */
export async function createIsolatedProviderInvocationOwnerHost(root: string, codec: Codec): Promise<ProviderInvocationOwnerHost> {
  const { createProviderInvocationAdmission } = await import('./providerInvocationAdmission')
  const owner = new ProviderDispatchOwner(root, codec, invocationMode)
  try {
    const access = hostAccess.get(owner)
    if (!access) throw unavailable('isolated host identity was not installed')
    return Object.freeze({
      readCurrentData: (scope: AgentThreadInteractionScope) => owner.readCurrentData(scope),
      trustedUpgrade: (scope: AgentThreadInteractionScope, input: InvocationUpgradeCommand) => access.upgrade(scope, input),
      createInvocationAdmission: (options: Omit<ProviderInvocationAdmissionOptions, 'store'>) => access.create(createProviderInvocationAdmission, options),
      shutdown: () => owner.shutdown()
    })
  } catch (error) {
    try { await owner.shutdown() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Isolated owner host construction cleanup was not confirmed.') }
    throw error
  }
}

let production: Promise<ProviderDispatchOwner> | undefined, productionRetired = false
/** Fixed main-owned OS-backed factory. User-only accounting inspection may open
 * it; explicit capped recordkeeping can admit one user-bound request.
 * A failed/closed owner is NOT silently reopened to replace uncertainty fences. */
export function getProviderDispatchOwner(): Promise<ProviderDispatchOwner> {
  if (productionRetired) return Promise.reject(unavailable('factory is retired for application shutdown'))
  production ??= (async () => {
    const [{ checkpointCodec }, { createCheckpointBinaryCodec }, { getBuildEnv }] = await Promise.all([import('../figplugin/checkpointEncryption'), import('../figplugin/checkpointBinaryCodec'), import('../config/buildEnv')])
    if (productionRetired) throw unavailable('factory retired during initialization')
    const root = realpathSync.native(getBuildEnv().pathMap.data)
    const owner = new ProviderDispatchOwner(path.join(root, 'agent-thread-dispatch'), { available: () => checkpointCodec.available(), ...createCheckpointBinaryCodec(checkpointCodec) })
    if (productionRetired) { await owner.shutdown(); throw unavailable('factory retired while opening ownership') }
    return owner
  })()
  return production
}
export async function shutdownProviderDispatchOwner(): Promise<void> {
  productionRetired = true // Latch even if no read has initialized the factory yet.
  if (production) await (await production).shutdown()
}
