import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import { AGENT_SIDE_LIMITS as LIMITS, type AgentSideMessage, type AgentSideStatus } from '@shared/api/agentThreadSide'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
import type { CheckpointBinaryCodec } from '../figplugin/checkpointBinaryCodec'

export type AgentSideDocument = {
  version: 1; id: string; revision: number; generation: number; status: AgentSideStatus
  createdAt: number; updatedAt: number; title: string
  profileId: string; profileDigest: string; modelLabel: string
  snapshot: Array<{ role: 'user' | 'assistant'; content: string }>; snapshotTruncated: boolean
  messages: AgentSideMessage[]; turns: number; modelSteps: number; toolCalls: number
  receipts: Array<{ operationId: string; digest: string; generation: number }>
}
export type SideCodec = CheckpointBinaryCodec & { available(): boolean }
const idPattern = '^[a-f0-9-]{36}$', hashPattern = '^[a-f0-9]{64}$'
const integer = (maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum: 0, maximum })
const text = (maximum: number) => ({ type: 'string', maxLength: maximum })
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) })
const message = { role: { enum: ['user', 'assistant'] }, content: text(LIMITS.messageCharacters) }
const schema = object({
  version: { const: 1 }, id: { type: 'string', pattern: idPattern }, revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, generation: integer(LIMITS.turns),
  status: { enum: ['running', 'completed', 'incomplete', 'stopped', 'interrupted', 'failed', 'budget_exhausted'] },
  createdAt: integer(), updatedAt: integer(), title: text(100), profileId: text(2048), profileDigest: { type: 'string', pattern: hashPattern }, modelLabel: text(200),
  snapshot: { type: 'array', maxItems: LIMITS.snapshotMessages, items: object(message) }, snapshotTruncated: { type: 'boolean' },
  messages: { type: 'array', maxItems: LIMITS.transcriptMessages, items: object({ ...message, kind: { enum: ['question', 'answer', 'tool-call', 'tool-result', 'notice'] } }) },
  turns: integer(LIMITS.turns), modelSteps: integer(LIMITS.stepsPerBranch), toolCalls: integer(LIMITS.readsPerBranch),
  receipts: { type: 'array', maxItems: LIMITS.receipts, items: object({ operationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' }, digest: { type: 'string', pattern: hashPattern }, generation: integer(LIMITS.turns) }) }
})
const valid = new Ajv({ strict: false, ownProperties: true }).compile(schema)
export function validateSideDocument(value: unknown): asserts value is AgentSideDocument {
  if (!valid(value)) throw new Error('Invalid private side-conversation document.')
  const document = value as AgentSideDocument
  if (document.snapshot.reduce((sum, item) => sum + item.content.length, 0) > LIMITS.snapshotCharacters || Buffer.byteLength(JSON.stringify(document.messages)) > LIMITS.transcriptBytes || Buffer.byteLength(JSON.stringify(document)) > LIMITS.recordBytes || document.turns !== document.generation || new Set(document.receipts.map((r) => r.operationId)).size !== document.receipts.length) throw new Error('Private side-conversation storage budget exceeded.')
}
const owner = (scope: AgentThreadInteractionScope) => createHash('sha256').update(JSON.stringify([getAgentSessionKey(normalizeAgentRoute(scope.route)), scope.conversationId])).digest('hex')
const branchId = (id: string) => { if (typeof id !== 'string' || !new RegExp(idPattern).test(id)) throw new Error('Invalid side conversation id.'); return id }
const RETIRED_DDL = 'CREATE TABLE retired (owner TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(owner,id))'
const DDL = 'CREATE TABLE branches (owner TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, cipher BLOB NOT NULL, PRIMARY KEY(owner,id))'
const sql = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : ''
function inspect(file: string) {
  const absolute = path.resolve(file)
  let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (!stat) break
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory()) || (current === absolute && (!stat.isFile() || stat.nlink !== 1 || stat.size > 96 * 1024 * 1024))) throw new Error('Invalid private side-conversation database path.')
  }
}
/** Encrypted, bounded current checkpoints. No transcript copies enter the platform event journal. */
export class AgentThreadSideStore {
  private readonly db: NodeSQLiteAdapter
  private readonly identity?: { dev: number; ino: number }
  private pageLimit = 0
  constructor(private readonly codec: SideCodec, private readonly file = ':memory:') {
    if (!codec.available()) throw new Error('Encrypted side-conversation storage is unavailable.')
    if (file !== ':memory:') for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(file + suffix)
    const before = file !== ':memory:' ? lstatSync(file, { throwIfNoEntry: false }) : undefined
    this.db = new NodeSQLiteAdapter(file)
    try {
      if (file !== ':memory:') {
        for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(file + suffix)
        this.identity = lstatSync(file)
        if (before && (before.ino !== this.identity.ino || before.dev !== this.identity.dev)) throw new Error('Side-conversation database changed during open.')
      }
      const objects = this.db.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 5')
      if (this.db.get('PRAGMA application_id')?.application_id === 0 && this.db.get('PRAGMA user_version')?.user_version === 0 && !objects.length) this.db.exec(`BEGIN IMMEDIATE; ${DDL}; ${RETIRED_DDL}; PRAGMA application_id=1297109812; PRAGMA user_version=1; COMMIT;`)
      this.check()
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;')
      this.enforceDiskBudget()
    } catch (error) { this.db.close(); throw error }
  }
  private enforceDiskBudget() {
    const size = Number(this.db.get('PRAGMA page_size')?.page_size), pages = Number(this.db.get('PRAGMA page_count')?.page_count)
    if (!Number.isSafeInteger(size) || size < 512 || size > 65536 || (size & (size - 1)) !== 0 || !Number.isSafeInteger(pages) || pages * size > 96 * 1024 * 1024) throw new Error('Invalid side SQLite page budget.')
    const limit = Math.floor(96 * 1024 * 1024 / size)
    if (this.pageLimit !== limit || Number(this.db.get('PRAGMA max_page_count')?.max_page_count) !== limit) {
      if (Number(this.db.get(`PRAGMA max_page_count=${limit}`)?.max_page_count) !== limit) throw new Error('Side SQLite byte limit unavailable.')
      this.pageLimit = limit
    }
  }
  private check() {
    this.enforceDiskBudget()
    if (!this.codec.available()) throw new Error('Encrypted side-conversation storage is unavailable.')
    if (this.identity) {
      inspect(this.file)
      const current = lstatSync(this.file)
      if (current.dev !== this.identity.dev || current.ino !== this.identity.ino || path.resolve(realpathSync(this.file)).toLowerCase() !== path.resolve(this.file).toLowerCase()) throw new Error('Side-conversation database identity changed.')
      for (const suffix of ['-journal', '-wal', '-shm']) inspect(this.file + suffix)
    }
    const objects = this.db.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 5')
    const expected = new Map([['branches', { table: 'branches', type: 'table', sql: sql(DDL) }], ['sqlite_autoindex_branches_1', { table: 'branches', type: 'index', sql: '' }], ['retired', { table: 'retired', type: 'table', sql: sql(RETIRED_DDL) }], ['sqlite_autoindex_retired_1', { table: 'retired', type: 'index', sql: '' }]])
    if (this.db.get('PRAGMA application_id')?.application_id !== 1297109812 || this.db.get('PRAGMA user_version')?.user_version !== 1 || objects.length !== 4 || objects.some((item) => { const spec = expected.get(String(item.name)); return !spec || item.type !== spec.type || item.tbl_name !== spec.table || sql(item.sql) !== spec.sql })) throw new Error('Invalid side-conversation database schema.')
  }
  read(scope: AgentThreadInteractionScope, id: string): AgentSideDocument | undefined {
    this.check(); branchId(id)
    const key = owner(scope), header = this.db.get('SELECT revision,length(cipher) AS bytes FROM branches WHERE owner=? AND id=?', key, id)
    if (!header) return undefined
    if (!Number.isSafeInteger(header.revision) || Number(header.revision) < 1 || !Number.isSafeInteger(header.bytes) || Number(header.bytes) < 1 || Number(header.bytes) > LIMITS.cipherBytes) throw new Error('Invalid bounded side-conversation checkpoint.')
    const row = this.db.get('SELECT cipher FROM branches WHERE owner=? AND id=? AND revision=? AND length(cipher)<=?', key, id, Number(header.revision), LIMITS.cipherBytes)
    if (!(row?.cipher instanceof Uint8Array)) throw new Error('Side-conversation checkpoint unavailable.')
    let plain: Buffer | undefined
    try {
      plain = this.codec.decryptBytes(row.cipher, `magicpot-side-v1:${key}:${id}:${header.revision}`, LIMITS.recordBytes)
      if (plain.byteLength > LIMITS.recordBytes) throw new Error('Side checkpoint too large.')
      const document: unknown = JSON.parse(plain.toString('utf8')); validateSideDocument(document)
      if (document.id !== id || document.revision !== header.revision) throw new Error('Side checkpoint binding mismatch.')
      return document
    } finally { plain?.fill(0) }
  }
  list(scope: AgentThreadInteractionScope): AgentSideDocument[] {
    this.check()
    const rows = this.db.all('SELECT id FROM branches WHERE owner=? ORDER BY rowid DESC LIMIT ?', owner(scope), LIMITS.branchesPerScope + 1)
    if (rows.length > LIMITS.branchesPerScope) throw new Error('Side-conversation retention capacity exceeded.')
    return rows.map((row) => this.read(scope, String(row.id))!)
  }
  save(scope: AgentThreadInteractionScope, document: AgentSideDocument, expectedRevision: number): AgentSideDocument {
    validateSideDocument(document)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || document.revision !== expectedRevision + 1) throw new Error('Invalid side-conversation revision.')
    this.check(); this.db.exec('BEGIN IMMEDIATE')
    let plain: Buffer | undefined
    try {
      const current = this.read(scope, document.id)
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error('Side-conversation revision conflict.')
      const key = owner(scope)
      if (this.db.get('SELECT id FROM retired WHERE owner=? AND id=?', key, document.id)) throw new Error('Deleted side identity cannot be replayed.')
      const total = this.db.get('SELECT count(*) AS n,coalesce(sum(length(cipher)),0) AS bytes FROM branches')!
      const own = this.db.get('SELECT count(*) AS n FROM branches WHERE owner=?', key)!
      if (!current && (Number(total.n) >= LIMITS.branchesGlobal || Number(own.n) >= LIMITS.branchesPerScope)) throw new Error('Side-conversation capacity reached; delete a finished branch.')
      plain = Buffer.from(JSON.stringify(document))
      const cipher = this.codec.encryptBytes(plain, `magicpot-side-v1:${key}:${document.id}:${document.revision}`)
      const existingBytes = Number(this.db.get('SELECT length(cipher) AS bytes FROM branches WHERE owner=? AND id=?', key, document.id)?.bytes ?? 0)
      if (!(cipher instanceof Uint8Array) || cipher.byteLength > LIMITS.cipherBytes || Number(total.bytes) - existingBytes + cipher.byteLength > LIMITS.storedCipherBytes) throw new Error('Side-conversation encrypted storage capacity exceeded.')
      const changed = this.db.prepare('INSERT INTO branches(owner,id,revision,cipher) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET revision=excluded.revision,cipher=excluded.cipher').run(key, document.id, document.revision, cipher)
      if (changed.changes !== 1) throw new Error('Side-conversation checkpoint was not saved.')
      const verified = this.read(scope, document.id)!
      if (JSON.stringify(verified) !== JSON.stringify(document)) throw new Error('Side-conversation checkpoint verification failed.')
      this.db.exec('COMMIT'); return verified
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { plain?.fill(0) }
  }
  delete(scope: AgentThreadInteractionScope, id: string, expectedRevision: number): void {
    this.check(); this.db.exec('BEGIN IMMEDIATE')
    try {
      const document = this.read(scope, id)
      if (!document || document.revision !== expectedRevision) throw new Error('Side-conversation revision conflict.')
      if (Number(this.db.get('SELECT count(*) AS n FROM retired')?.n) >= 4096) throw new Error('Side deletion ledger capacity reached; refusing to discard replay protection.')
      this.db.prepare('INSERT INTO retired(owner,id) VALUES(?,?)').run(owner(scope), id)
      this.db.prepare('DELETE FROM branches WHERE owner=? AND id=? AND revision=?').run(owner(scope), id, expectedRevision)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close() { this.db.close() }
}
let singleton: Promise<AgentThreadSideStore> | undefined
export function getAgentThreadSideStore(): Promise<AgentThreadSideStore> {
  singleton ??= (async () => {
    const [{ checkpointCodec }, { createCheckpointBinaryCodec }, { getBuildEnv }] = await Promise.all([import('../figplugin/checkpointEncryption'), import('../figplugin/checkpointBinaryCodec'), import('../config/buildEnv')])
    return new AgentThreadSideStore({ available: () => checkpointCodec.available(), ...createCheckpointBinaryCodec(checkpointCodec) }, path.join(getBuildEnv().pathMap.data, 'agent-thread-sides', 'sides.sqlite'))
  })().catch((error) => { singleton = undefined; throw error })
  return singleton
}
