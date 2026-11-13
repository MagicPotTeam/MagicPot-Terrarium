import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import { AGENT_GOAL_LIMITS as LIMITS, type AgentGoalBinding, type AgentGoalCollection, type AgentGoalMutation, type AgentModelGoalMutation } from '@shared/api/agentThreadGoal'
import type { CheckpointBinaryCodec } from '../figplugin/checkpointBinaryCodec'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
import { applyModelGoalMutation, applyUserGoalMutation, emptyAgentGoalCollection, validateAgentGoalCollection, validateAgentGoalMutation } from './agentThreadGoalPolicy'

export type GoalCheckpointCodec = CheckpointBinaryCodec & { available(): boolean }
/** Persisted data only. This is not consent, a permit, or an execution capability. */
export type GoalAutoRecord = {
  id: string; goalId: string; generation: number; deadlineAt: number
  state: 'armed' | 'claimed' | 'unknown' | 'completed' | 'stopped' | 'expired'
  stopRequested: boolean
}
type Envelope = { version: 2; storageRevision: number; collection: AgentGoalCollection; auto: GoalAutoRecord } | { version: 3; storageRevision: number; collection: AgentGoalCollection; records: GoalAutoRecord[] }
const AUTO_RECORD_LIMIT = 16
type Snapshot = { storageRevision: number; collection: AgentGoalCollection; records: GoalAutoRecord[]; format: 1 | 2 | 3 }
const autoValidator = new Ajv({ strict: true, ownProperties: true }).compile({
  type: 'object', additionalProperties: false,
  required: ['id', 'goalId', 'generation', 'deadlineAt', 'state', 'stopRequested'],
  properties: {
    id: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
    goalId: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
    generation: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    deadlineAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    state: { enum: ['armed', 'claimed', 'unknown', 'completed', 'stopped', 'expired'] },
    stopRequested: { type: 'boolean' }
  }
})
function validateEnvelope(value: unknown, revision: number): asserts value is Envelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid goal envelope.')
  const v = value as Record<string, unknown>
  const isV2 = v.version === 2 && Object.keys(v).sort().join(',') === 'auto,collection,storageRevision,version'
  const isV3 = v.version === 3 && Object.keys(v).sort().join(',') === 'collection,records,storageRevision,version'
  if ((!isV2 && !isV3) || v.storageRevision !== revision) throw new Error('Invalid goal envelope.')
  validateAgentGoalCollection(v.collection)
  if (v.collection.revision > revision) throw new Error('Invalid goal envelope revision.')
  const records: unknown[] = isV2 ? [v.auto] : Array.isArray(v.records) ? v.records : []
  if (records.length < 1 || records.length > AUTO_RECORD_LIMIT || records.some(record => !autoValidator(record))) throw new Error('Invalid goal auto records.')
  const autos = records as GoalAutoRecord[]
  if (new Set(autos.map(auto => auto.id)).size !== autos.length || autos.filter(auto => ['armed', 'claimed', 'unknown'].includes(auto.state)).length > 1 || autos.slice(0, -1).some(auto => ['armed', 'claimed', 'unknown'].includes(auto.state))) throw new Error('Invalid goal auto fences.')
  for (const auto of autos) {
    if (auto.stopRequested && !['unknown', 'stopped'].includes(auto.state)) throw new Error('Invalid goal auto stop state.')
    if (auto.state === 'armed' && !v.collection.goals.some(goal => goal.id === auto.goalId && goal.generation === auto.generation && goal.status === 'active' && !goal.proposal)) throw new Error('Invalid armed goal binding.')
  }
}
const DDL = 'CREATE TABLE goals (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, cipher BLOB NOT NULL)'
const APPLICATION_ID = 1297106737
const sqlText = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : ''
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const owner = (scope: AgentThreadInteractionScope): string => {
  const route = normalizeAgentRoute(scope.route)
  if (route.channel !== 'canvas' || route.scopeType !== 'thread' || ![route.scopeId, route.threadId, scope.conversationId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))) throw new Error('Invalid goal checkpoint scope.')
  return hash([getAgentSessionKey(route), scope.conversationId])
}
function inspect(file: string): void {
  const absolute = path.resolve(file); let current = path.parse(absolute).root
  for (const segment of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, segment)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (!stat) break
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory()) || (current === absolute && (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMITS.databaseBytes))) throw new Error('Unsafe goal checkpoint database path.')
  }
}
/** Data layer only, not an authorization API. Callers must establish provenance.
 * Main-selected private directory required; optimistic path checks are not an OS
 * sandbox against a hostile same-user writer. DB16MiB + bounded sidecars are
 * separate ceilings. AEAD/CAS do not detect restoring an older valid owner row
 * with its original revision, nor a valid whole-DB snapshot. Neither rollback
 * resistance nor automatic recovery authorizes execution.
 * Empty collections retain revisions, receipts and retired IDs. No owner purge,
 * automatic execution, provider configuration, tickets or authority is persisted.
 * Automatic records are bounded and never evicted. This is data only, not a
 * scheduler or authorization; capacity exhaustion requires future migration. */
export class AgentThreadGoalStore {
  private readonly db: NodeSQLiteAdapter
  private readonly changes = new Map<string, Set<() => void>>()
  /** Main-owned, body-free synchronous invalidation; not a persisted event bus. */
  onChanged(scope: AgentThreadInteractionScope, listener: () => void): () => void {
    const key = owner(scope), set = this.changes.get(key) ?? new Set<() => void>()
    if ([...this.changes.values()].reduce((n, value) => n + value.size, 0) >= 64) throw new Error('Goal change listener capacity reached.')
    set.add(listener); this.changes.set(key, set)
    return () => { set.delete(listener); if (!set.size && this.changes.get(key) === set) this.changes.delete(key) }
  }
  private readonly identity?: { dev: number; ino: number }
  constructor(private readonly codec: GoalCheckpointCodec, private readonly file = ':memory:') {
    if (!codec.available()) throw new Error('Encrypted goal storage unavailable.')
    if (file !== ':memory:' && !path.isAbsolute(file)) throw new Error('Goal database path must be absolute.')
    if (file !== ':memory:') for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(file + suffix)
    const before = file !== ':memory:' ? lstatSync(file, { throwIfNoEntry: false }) : undefined
    this.db = new NodeSQLiteAdapter(file)
    try {
      if (file !== ':memory:') {
        for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(file + suffix)
        this.identity = lstatSync(file)
        if (before && (before.dev !== this.identity.dev || before.ino !== this.identity.ino)) throw new Error('Goal database changed during open.')
      }
      const objects = this.db.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 3')
      if (this.db.get('PRAGMA application_id')?.application_id === 0 && this.db.get('PRAGMA user_version')?.user_version === 0 && !objects.length) this.db.exec(`BEGIN IMMEDIATE; ${DDL}; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`)
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;')
      this.check()
    } catch (error) { this.db.close(); throw error }
  }
  private check(): void {
    if (!this.codec.available()) throw new Error('Encrypted goal storage unavailable.')
    if (this.identity) {
      for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(this.file + suffix)
      const stat = lstatSync(this.file)
      if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || path.resolve(realpathSync(this.file)).toLowerCase() !== path.resolve(this.file).toLowerCase()) throw new Error('Goal database identity changed.')
    }
    const objects = this.db.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 3')
    const expected = new Map([['goals', { type: 'table', sql: sqlText(DDL) }], ['sqlite_autoindex_goals_1', { type: 'index', sql: '' }]])
    if (this.db.get('PRAGMA application_id')?.application_id !== APPLICATION_ID || this.db.get('PRAGMA user_version')?.user_version !== 1 || objects.length !== expected.size || objects.some(item => { const entry = expected.get(String(item.name)); return !entry || item.type !== entry.type || item.tbl_name !== 'goals' || sqlText(item.sql) !== entry.sql })) throw new Error('Invalid goal database schema.')
    const size = Number(this.db.get('PRAGMA page_size')?.page_size), pages = Number(this.db.get('PRAGMA page_count')?.page_count)
    if (!Number.isSafeInteger(size) || size < 512 || size > 65536 || (size & (size - 1)) !== 0 || !Number.isSafeInteger(pages) || pages * size > LIMITS.databaseBytes) throw new Error('Invalid goal database page budget.')
    const limit = Math.floor(LIMITS.databaseBytes / size)
    if (Number(this.db.get('PRAGMA max_page_count')?.max_page_count) !== limit && Number(this.db.get(`PRAGMA max_page_count=${limit}`)?.max_page_count) !== limit) throw new Error('Goal database byte limit unavailable.')
    const total = this.db.get('SELECT count(*) AS n,coalesce(sum(length(cipher)),0) AS bytes FROM goals')!
    if (!Number.isSafeInteger(total.n) || Number(total.n) > LIMITS.owners || !Number.isSafeInteger(total.bytes) || Number(total.bytes) > LIMITS.totalCipherBytes) throw new Error('Goal storage capacity exceeded.')
  }
  read(scope: AgentThreadInteractionScope): AgentGoalCollection { return this.readSnapshot(scope).collection }
  /** Internal data inspection only; never an execution grant. */
  readAuto(scope: AgentThreadInteractionScope): { storageRevision: number; record: GoalAutoRecord | null } {
    const snapshot = this.readSnapshot(scope)
    return { storageRevision: snapshot.storageRevision, record: snapshot.records.at(-1) ?? null }
  }
  readAutoRecords(scope: AgentThreadInteractionScope): { storageRevision: number; records: GoalAutoRecord[] } {
    const snapshot = this.readSnapshot(scope)
    return { storageRevision: snapshot.storageRevision, records: snapshot.records }
  }
  private readSnapshot(scope: AgentThreadInteractionScope): Snapshot {
    this.check(); const key = owner(scope)
    // Header + bounded blob from one snapshot, not two reads that can race.
    const row = this.db.get('SELECT revision,length(cipher) AS bytes,CASE WHEN length(cipher)<=? THEN cipher ELSE NULL END AS cipher FROM goals WHERE owner=?', LIMITS.cipherBytes, key)
    if (!row) return { storageRevision: 0, collection: emptyAgentGoalCollection(), records: [], format: 1 }
    if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > LIMITS.cipherBytes || !(row.cipher instanceof Uint8Array)) throw new Error('Invalid goal checkpoint header.')
    let plain: Buffer | undefined
    try {
      plain = this.codec.decryptBytes(row.cipher, `magicpot-goals-v1:${key}:${row.revision}`, LIMITS.plainBytes)
      const document: unknown = JSON.parse(plain.toString('utf8'))
      if ([2, 3].includes(Number((document as { version?: unknown } | null)?.version))) {
        validateEnvelope(document, Number(row.revision))
        return { storageRevision: document.storageRevision, collection: document.collection, records: document.version === 2 ? [document.auto] : document.records, format: document.version }
      }
      validateAgentGoalCollection(document)
      if (document.revision !== row.revision) throw new Error('Goal checkpoint revision mismatch.')
      return { storageRevision: document.revision, collection: document, records: [], format: 1 }
    } finally { plain?.fill(0) }
  }
  mutateUser(scope: AgentThreadInteractionScope, request: AgentGoalMutation, now = Date.now()): AgentGoalCollection {
    return this.mutate(scope, request, now)
  }
  mutateModel(scope: AgentThreadInteractionScope, request: AgentModelGoalMutation, binding: AgentGoalBinding, now = Date.now()): AgentGoalCollection {
    // Binding is a future main-captured authority prerequisite, never model data.
    if (!binding || !['report', 'propose'].includes(request.action) || request.goalId !== binding.goalId || request.expectedGeneration !== binding.generation) throw new Error('Model goal mutation requires its current main-owned binding.')
    return this.mutate(scope, request, now, binding)
  }
  private mutate(scope: AgentThreadInteractionScope, input: AgentGoalMutation, now: number, binding?: AgentGoalBinding): AgentGoalCollection {
    validateAgentGoalMutation(input); const request = structuredClone(input), key = owner(scope)
    const role = binding ? 'model' : 'user'
    const operationHash = hash([key, role, request.operationId])
    // Canonical field ordering, independent of RPC object property order.
    const payload = Object.fromEntries(Object.entries(request).filter(([name]) => name !== 'operationId').sort(([a], [b]) => a.localeCompare(b)))
    if ('spec' in request) payload.spec = { objective: request.spec.objective, successCriteria: [...request.spec.successCriteria], constraints: [...request.spec.constraints], autonomy: request.spec.autonomy, completionPolicy: request.spec.completionPolicy, budgets: { maxTurns: request.spec.budgets.maxTurns, maxToolCalls: request.spec.budgets.maxToolCalls, maxWalltimeSeconds: request.spec.budgets.maxWalltimeSeconds } }
    const digest = hash([key, role, binding ? [binding.goalId, binding.generation] : null, payload])
    this.check(); this.db.exec('BEGIN IMMEDIATE')
    let plain: Buffer | undefined
    try {
      const snapshot = this.readSnapshot(scope), current = this.read(scope)
      if (JSON.stringify(current) !== JSON.stringify(snapshot.collection)) throw new Error('Goal checkpoint read verification failed.')
      if (binding && !current.goals.some(goal => goal.id === binding.goalId && goal.generation === binding.generation && ['active', 'waiting', 'blocked'].includes(goal.status))) throw new Error('Model goal binding is no longer current.')
      const replay = current.receipts.find(receipt => receipt.operationHash === operationHash)
      if (replay) { if (replay.digest !== digest) throw new Error('Goal replay conflict.'); this.db.exec('COMMIT'); return current }
      const next = binding ? applyModelGoalMutation(current, request as AgentModelGoalMutation, binding, now) : applyUserGoalMutation(current, request, now)
      next.receipts = [...current.receipts, { operationHash, digest }].slice(-LIMITS.receipts)
      validateAgentGoalCollection(next)
      const total = this.db.get('SELECT count(*) AS n,coalesce(sum(length(cipher)),0) AS bytes FROM goals')!
      if (current.revision === 0 && Number(total.n) >= LIMITS.owners) throw new Error('Goal owner capacity reached; replay domains were not evicted.')
      if (snapshot.storageRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Goal storage revision exhausted.')
      const storageRevision = snapshot.storageRevision + 1
      const records = snapshot.records.map(auto => ['armed', 'claimed'].includes(auto.state) && !next.goals.some(goal => goal.id === auto.goalId && goal.generation === auto.generation && goal.status === 'active' && !goal.proposal) ? { ...auto, state: auto.state === 'armed' ? 'stopped' as const : 'unknown' as const } : auto)
      const payloadDocument = snapshot.format === 1 ? next : snapshot.format === 2 ? { version: 2 as const, storageRevision, collection: next, auto: records[0] } : { version: 3 as const, storageRevision, collection: next, records }
      if (snapshot.format !== 1) validateEnvelope(payloadDocument, storageRevision)
      plain = Buffer.from(JSON.stringify(payloadDocument), 'utf8')
      if (plain.length > LIMITS.plainBytes) throw new Error('Goal checkpoint size exceeded.')
      const cipher = this.codec.encryptBytes(plain, `magicpot-goals-v1:${key}:${storageRevision}`)
      const previous = Number(this.db.get('SELECT length(cipher) AS bytes FROM goals WHERE owner=?', key)?.bytes ?? 0)
      if (!(cipher instanceof Uint8Array) || cipher.length < 1 || cipher.length > LIMITS.cipherBytes || Number(total.bytes) - previous + cipher.length > LIMITS.totalCipherBytes) throw new Error('Goal encrypted storage capacity reached.')
      if (this.db.prepare('INSERT INTO goals(owner,revision,cipher) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,cipher=excluded.cipher WHERE goals.revision=?').run(key, storageRevision, cipher, snapshot.storageRevision).changes !== 1) throw new Error('Goal checkpoint write failed.')
      const verifiedSnapshot = this.readSnapshot(scope), verified = this.read(scope)
      if (JSON.stringify(verified) !== JSON.stringify(next) || JSON.stringify(verifiedSnapshot.collection) !== JSON.stringify(next) || verifiedSnapshot.storageRevision !== storageRevision || JSON.stringify(verifiedSnapshot.records) !== JSON.stringify(records)) throw new Error('Goal checkpoint write verification failed.')
      this.db.exec('COMMIT')
      for (const listener of [...(this.changes.get(key) ?? [])]) { try { listener() } catch { /* A receipt is not undone by observer failure. */ } }
      return verified
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { plain?.fill(0) }
  }
  /** MAIN-owned bookkeeping only. No operation proves or grants user consent.
   * Never wire these methods directly to untrusted inputs or model execution. */
  mutateAuto(scope: AgentThreadInteractionScope, expectedRevision: number, command:
    | { action: 'arm'; id: string; goalId: string; generation: number; deadlineAt: number }
    | { action: 'claim' | 'recover' | 'stop' | 'complete'; id: string }, now = Date.now()
  ): { storageRevision: number; record: GoalAutoRecord } {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid goal auto clock or revision.')
    this.check(); const key = owner(scope)
    this.db.exec('BEGIN IMMEDIATE')
    let plain: Buffer | undefined
    try {
      const current = this.readSnapshot(scope)
      if (current.storageRevision !== expectedRevision) throw new Error('Goal auto revision conflict.')
      let record: GoalAutoRecord
      if (command.action === 'arm') {
        if (current.records.length >= AUTO_RECORD_LIMIT) throw new Error('Goal auto lifetime capacity reached; records not discarded.')
        if (current.records.some(item => item.id === command.id)) throw new Error('Goal auto ID already used.')
        if (current.records.some(item => ['armed', 'claimed', 'unknown'].includes(item.state))) throw new Error('Goal auto unresolved fence.')
        record = { id: command.id, goalId: command.goalId, generation: command.generation, deadlineAt: command.deadlineAt, state: 'armed', stopRequested: false }
        if (!autoValidator(record) || now >= record.deadlineAt || !current.collection.goals.some(goal => goal.id === record.goalId && goal.generation === record.generation && goal.status === 'active' && !goal.proposal)) throw new Error('Invalid goal auto binding.')
      } else {
        const prior = current.records.find(item => item.id === command.id)
        if (!prior) throw new Error('Goal auto record unavailable.')
        record = { ...prior }
        if (command.action === 'claim') {
          if (record.state !== 'armed') throw new Error('Goal auto already consumed or stopped.')
          record.state = now >= record.deadlineAt ? 'expired' : 'claimed'
        } else if (command.action === 'recover') {
          if (record.state === 'claimed') record.state = 'unknown'
          else if (record.state === 'armed' && now >= record.deadlineAt) record.state = 'expired'
          else throw new Error('Goal auto recovery has no transition.')
        } else if (command.action === 'stop') {
          if (record.state === 'armed') { record.state = 'stopped'; record.stopRequested = true }
          else if (record.state === 'claimed' || record.state === 'unknown') { record.state = 'unknown'; record.stopRequested = true }
          else throw new Error('Goal auto already terminal.')
        } else if (command.action === 'complete') {
          if (record.state !== 'claimed') throw new Error('Goal auto cannot complete.')
          record.state = 'completed'
        } else throw new Error('Invalid goal auto operation.')
      }
      if (current.storageRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Goal storage revision exhausted.')
      const records = command.action === 'arm' ? [...current.records, record] : current.records.map(item => item.id === record.id ? record : item)
      const envelope: Envelope = { version: 3, storageRevision: current.storageRevision + 1, collection: current.collection, records }
      validateEnvelope(envelope, envelope.storageRevision)
      plain = Buffer.from(JSON.stringify(envelope), 'utf8')
      if (plain.length > LIMITS.plainBytes) throw new Error('Goal checkpoint size exceeded.')
      const cipher = this.codec.encryptBytes(plain, `magicpot-goals-v1:${key}:${envelope.storageRevision}`)
      const total = this.db.get('SELECT coalesce(sum(length(cipher)),0) AS bytes FROM goals')!
      const previous = Number(this.db.get('SELECT length(cipher) AS bytes FROM goals WHERE owner=?', key)?.bytes ?? 0)
      if (!(cipher instanceof Uint8Array) || cipher.length < 1 || cipher.length > LIMITS.cipherBytes || Number(total.bytes) - previous + cipher.length > LIMITS.totalCipherBytes) throw new Error('Goal encrypted storage capacity reached.')
      if (this.db.prepare('UPDATE goals SET revision=?,cipher=? WHERE owner=? AND revision=?').run(envelope.storageRevision, cipher, key, current.storageRevision).changes !== 1) throw new Error('Goal auto revision conflict.')
      const verified = this.readSnapshot(scope)
      if (verified.storageRevision !== envelope.storageRevision || JSON.stringify(verified.collection) !== JSON.stringify(envelope.collection) || JSON.stringify(verified.records) !== JSON.stringify(records)) throw new Error('Goal checkpoint write verification failed.')
      this.db.exec('COMMIT')
      for (const listener of [...(this.changes.get(key) ?? [])]) { try { listener() } catch { /* Observer errors do not roll back. */ } }
      return { storageRevision: verified.storageRevision, record }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { plain?.fill(0) }
  }
  close(): void { this.changes.clear(); this.db.close() }
}
