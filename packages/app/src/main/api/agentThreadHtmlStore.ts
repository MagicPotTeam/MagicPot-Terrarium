import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
import type { CheckpointBinaryCodec } from '../figplugin/checkpointBinaryCodec'
import { validateHtmlHostDocument } from './agentThreadHtmlDocument'

export const HTML_CHECKPOINT_LIMITS = Object.freeze({ perScope: 8, global: 128, plainBytes: 512 * 1024, cipherBytes: 600 * 1024, totalCipherBytes: 32 * 1024 * 1024, retired: 4096, receipts: 64, databaseBytes: 96 * 1024 * 1024 })
export type HtmlCheckpointContent = { title: string; html: string; data: Record<string, unknown>; state: Record<string, unknown>; documentRevision: number; surface: 'canvas' | 'chat' }
export type HtmlCheckpoint = HtmlCheckpointContent & { version: 1; id: string; storageRevision: number; createdAt: number; updatedAt: number; receipts: Array<{ operationHash: string; digest: string }> }
export type HtmlCheckpointCodec = CheckpointBinaryCodec & { available(): boolean }
const idPattern = '^[a-f0-9-]{36}$', opPattern = '^[A-Za-z0-9_-]{1,128}$', hashPattern = '^[a-f0-9]{64}$'
const idValid = (id: unknown): id is string => typeof id === 'string' && new RegExp(idPattern).test(id)
const opValid = (id: unknown): id is string => typeof id === 'string' && new RegExp(opPattern).test(id)
const integer = (minimum = 0) => ({ type: 'integer', minimum, maximum: Number.MAX_SAFE_INTEGER })
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, additionalProperties: false, required: Object.keys(properties) })
const contentProperties = { title: { type: 'string', minLength: 1, maxLength: 120 }, html: { type: 'string', minLength: 1, maxLength: 262144 }, data: { type: 'object' }, state: { type: 'object' }, documentRevision: integer(1), surface: { enum: ['canvas', 'chat'] } }
const valid = new Ajv({ strict: false, ownProperties: true }).compile(object({ ...contentProperties,
  version: { const: 1 }, id: { type: 'string', pattern: idPattern }, storageRevision: integer(1), createdAt: integer(), updatedAt: integer(),
  receipts: { type: 'array', minItems: 1, maxItems: HTML_CHECKPOINT_LIMITS.receipts, items: object({ operationHash: { type: 'string', pattern: hashPattern }, digest: { type: 'string', pattern: hashPattern } }) }
}))
function content(value: HtmlCheckpointContent): HtmlCheckpointContent {
  const snapshot = cloneBoundedMcpJson(value, HTML_CHECKPOINT_LIMITS.plainBytes) as HtmlCheckpointContent
  if (!snapshot || Object.keys(snapshot).some(key => !Object.hasOwn(contentProperties, key)) || !['canvas', 'chat'].includes(snapshot.surface)) throw new Error('Invalid HTML checkpoint content.')
  validateHtmlHostDocument({ title: snapshot.title, html: snapshot.html, data: snapshot.data, revision: snapshot.documentRevision })
  if (!snapshot.data || !snapshot.state || Array.isArray(snapshot.data) || Array.isArray(snapshot.state)) throw new Error('HTML checkpoint data and state must be objects.')
  cloneBoundedMcpJson(snapshot.data, 65536); cloneBoundedMcpJson(snapshot.state, 65536)
  return { title: snapshot.title, html: snapshot.html, data: snapshot.data, state: snapshot.state, surface: snapshot.surface, documentRevision: snapshot.documentRevision }
}
function validateCheckpoint(value: unknown): asserts value is HtmlCheckpoint {
  if (!valid(value)) throw new Error('Invalid encrypted HTML checkpoint.')
  const document = value as HtmlCheckpoint
  content({ title: document.title, html: document.html, data: document.data, state: document.state, surface: document.surface, documentRevision: document.documentRevision })
  if (document.updatedAt < document.createdAt || Buffer.byteLength(JSON.stringify(document)) > HTML_CHECKPOINT_LIMITS.plainBytes || new Set(document.receipts.map(receipt => receipt.operationHash)).size !== document.receipts.length) throw new Error('HTML checkpoint budget or receipt constraint failed.')
}
const owner = (scope: AgentThreadInteractionScope) => {
  const route = normalizeAgentRoute(scope.route)
  if (route.channel !== 'canvas' || route.scopeType !== 'thread' || ![route.scopeId, route.threadId, scope.conversationId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))) throw new Error('Invalid HTML checkpoint scope.')
  return createHash('sha256').update(JSON.stringify([getAgentSessionKey(route), scope.conversationId])).digest('hex')
}
const DDL = 'CREATE TABLE apps (owner TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, cipher BLOB NOT NULL, PRIMARY KEY(owner,id))'
const RETIRED = 'CREATE TABLE retired (owner TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(owner,id))'
const sql = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : ''
function inspect(file: string): void {
  const absolute = path.resolve(file); let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (!stat) break
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory()) || (current === absolute && (!stat.isFile() || stat.nlink !== 1 || stat.size > HTML_CHECKPOINT_LIMITS.databaseBytes))) throw new Error('Unsafe HTML checkpoint database path.')
  }
}
/** Current user-saved data only. Runtime/sender/input/approval state is never accepted. */
export class AgentThreadHtmlStore {
  private readonly db: NodeSQLiteAdapter
  private readonly identity?: { dev: number; ino: number }
  private pageLimit = 0
  constructor(private readonly codec: HtmlCheckpointCodec, private readonly file = ':memory:') {
    if (!codec.available()) throw new Error('Encrypted HTML checkpoint storage unavailable.')
    if (file !== ':memory:' && !path.isAbsolute(file)) throw new Error('HTML checkpoint database path must be absolute.')
    if (file !== ':memory:') for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(file + suffix)
    const before = file !== ':memory:' ? lstatSync(file, { throwIfNoEntry: false }) : undefined
    this.db = new NodeSQLiteAdapter(file)
    try {
      if (file !== ':memory:') {
        for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(file + suffix)
        this.identity = lstatSync(file)
        if (before && (before.ino !== this.identity.ino || before.dev !== this.identity.dev)) throw new Error('HTML checkpoint database changed during open.')
      }
      const objects = this.db.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 5')
      if (this.db.get('PRAGMA application_id')?.application_id === 0 && this.db.get('PRAGMA user_version')?.user_version === 0 && !objects.length) this.db.exec(`BEGIN IMMEDIATE; ${DDL}; ${RETIRED}; PRAGMA application_id=1297106993; PRAGMA user_version=1; COMMIT;`)
      this.check()
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;')
      this.enforceDiskBudget()
    } catch (error) { this.db.close(); throw error }
  }
  private enforceDiskBudget(): void {
    const size = Number(this.db.get('PRAGMA page_size')?.page_size), pages = Number(this.db.get('PRAGMA page_count')?.page_count)
    if (!Number.isSafeInteger(size) || size < 512 || size > 65536 || (size & (size - 1)) !== 0 || !Number.isSafeInteger(pages) || pages * size > HTML_CHECKPOINT_LIMITS.databaseBytes) throw new Error('Invalid HTML SQLite page budget.')
    const limit = Math.floor(HTML_CHECKPOINT_LIMITS.databaseBytes / size)
    if (this.pageLimit !== limit || Number(this.db.get('PRAGMA max_page_count')?.max_page_count) !== limit) {
      if (Number(this.db.get(`PRAGMA max_page_count=${limit}`)?.max_page_count) !== limit) throw new Error('HTML SQLite byte limit unavailable.')
      this.pageLimit = limit
    }
  }
  private check(): void {
    this.enforceDiskBudget()
    if (!this.codec.available()) throw new Error('Encrypted HTML checkpoint storage unavailable.')
    if (this.identity) {
      for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(this.file + suffix)
      const current = lstatSync(this.file)
      if (current.dev !== this.identity.dev || current.ino !== this.identity.ino || path.resolve(realpathSync(this.file)).toLowerCase() !== path.resolve(this.file).toLowerCase()) throw new Error('HTML checkpoint database identity changed.')
    }
    const objects = this.db.all('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 5')
    const expected = new Map([['apps', { type: 'table', table: 'apps', sql: sql(DDL) }], ['retired', { type: 'table', table: 'retired', sql: sql(RETIRED) }], ['sqlite_autoindex_apps_1', { type: 'index', table: 'apps', sql: '' }], ['sqlite_autoindex_retired_1', { type: 'index', table: 'retired', sql: '' }]])
    if (this.db.get('PRAGMA application_id')?.application_id !== 1297106993 || this.db.get('PRAGMA user_version')?.user_version !== 1 || objects.length !== expected.size || objects.some(item => { const spec = expected.get(String(item.name)); return !spec || spec.type !== item.type || spec.table !== item.tbl_name || spec.sql !== sql(item.sql) })) throw new Error('Invalid HTML checkpoint database schema.')
  }
  read(scope: AgentThreadInteractionScope, id: string): HtmlCheckpoint | undefined {
    this.check(); if (!idValid(id)) throw new Error('Invalid HTML checkpoint id.')
    const key = owner(scope)
    const header = this.db.get('SELECT revision,length(cipher) AS bytes,CASE WHEN length(cipher)<=? THEN cipher ELSE NULL END AS cipher FROM apps WHERE owner=? AND id=?', HTML_CHECKPOINT_LIMITS.cipherBytes, key, id)
    if (!header) return undefined
    if (!Number.isSafeInteger(header.revision) || Number(header.revision) < 1 || !Number.isSafeInteger(header.bytes) || Number(header.bytes) < 1 || Number(header.bytes) > HTML_CHECKPOINT_LIMITS.cipherBytes) throw new Error('Invalid HTML checkpoint size or revision.')
    const row = header
    if (!(row?.cipher instanceof Uint8Array)) throw new Error('HTML checkpoint unavailable.')
    let plain: Buffer | undefined
    try {
      plain = this.codec.decryptBytes(row.cipher, `magicpot-html-v1:${key}:${id}:${header.revision}`, HTML_CHECKPOINT_LIMITS.plainBytes)
      if (plain.length > HTML_CHECKPOINT_LIMITS.plainBytes) throw new Error('HTML checkpoint too large.')
      const document: unknown = JSON.parse(plain.toString('utf8')); validateCheckpoint(document)
      if (document.id !== id || document.storageRevision !== header.revision) throw new Error('HTML checkpoint identity mismatch.')
      return document
    } finally { plain?.fill(0) }
  }
  list(scope: AgentThreadInteractionScope): HtmlCheckpoint[] {
    this.check()
    const rows = this.db.all('SELECT id FROM apps WHERE owner=? ORDER BY rowid DESC LIMIT ?', owner(scope), HTML_CHECKPOINT_LIMITS.perScope + 1)
    if (rows.length > HTML_CHECKPOINT_LIMITS.perScope) throw new Error('HTML checkpoint owner capacity exceeded.')
    return rows.map(row => this.read(scope, String(row.id))!)
  }
  save(scope: AgentThreadInteractionScope, req: { id: string; expectedRevision: number; operationId: string; content: HtmlCheckpointContent }): HtmlCheckpoint {
    if (!idValid(req.id) || !opValid(req.operationId) || !Number.isSafeInteger(req.expectedRevision) || req.expectedRevision < 0 || req.expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid HTML checkpoint mutation.')
    const snapshot = content(req.content), operationHash = createHash('sha256').update(req.operationId).digest('hex'), digest = createHash('sha256').update(JSON.stringify([req.id, req.expectedRevision, snapshot])).digest('hex')
    this.check(); this.db.exec('BEGIN IMMEDIATE')
    let plain: Buffer | undefined
    try {
      const key = owner(scope), current = this.read(scope, req.id)
      if (this.db.get('SELECT id FROM retired WHERE owner=? AND id=?', key, req.id)) throw new Error('Deleted HTML identity cannot be replayed.')
      const replay = current?.receipts.find(receipt => receipt.operationHash === operationHash)
      if (replay) { if (replay.digest !== digest) throw new Error('HTML checkpoint replay conflict.'); this.db.exec('COMMIT'); return current! }
      if ((current?.storageRevision ?? 0) !== req.expectedRevision) throw new Error('HTML checkpoint revision conflict; refresh before saving.')
      const now = Date.now(), document: HtmlCheckpoint = { version: 1, id: req.id, storageRevision: req.expectedRevision + 1, createdAt: current?.createdAt ?? now, updatedAt: now, ...snapshot, receipts: [...(current?.receipts ?? []), { operationHash, digest }].slice(-HTML_CHECKPOINT_LIMITS.receipts) }
      validateCheckpoint(document)
      const total = this.db.get('SELECT count(*) AS n,coalesce(sum(length(cipher)),0) AS bytes FROM apps')!, own = this.db.get('SELECT count(*) AS n FROM apps WHERE owner=?', key)!
      if (!current && (Number(total.n) >= HTML_CHECKPOINT_LIMITS.global || Number(own.n) >= HTML_CHECKPOINT_LIMITS.perScope)) throw new Error('HTML checkpoint capacity reached.')
      plain = Buffer.from(JSON.stringify(document))
      const cipher = this.codec.encryptBytes(plain, `magicpot-html-v1:${key}:${req.id}:${document.storageRevision}`)
      const existingBytes = Number(this.db.get('SELECT length(cipher) AS bytes FROM apps WHERE owner=? AND id=?', key, req.id)?.bytes ?? 0)
      if (!(cipher instanceof Uint8Array) || cipher.length < 1 || cipher.length > HTML_CHECKPOINT_LIMITS.cipherBytes || Number(total.bytes) - existingBytes + cipher.length > HTML_CHECKPOINT_LIMITS.totalCipherBytes) throw new Error('HTML encrypted storage budget exceeded.')
      if (this.db.prepare('INSERT INTO apps(owner,id,revision,cipher) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET revision=excluded.revision,cipher=excluded.cipher').run(key, req.id, document.storageRevision, cipher).changes !== 1) throw new Error('HTML checkpoint write failed.')
      const verified = this.read(scope, req.id)!
      if (JSON.stringify(verified) !== JSON.stringify(document)) throw new Error('HTML checkpoint write verification failed.')
      this.db.exec('COMMIT'); return verified
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { plain?.fill(0) }
  }
  delete(scope: AgentThreadInteractionScope, id: string, expectedRevision: number): void {
    if (!idValid(id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Invalid HTML checkpoint deletion.')
    this.check(); this.db.exec('BEGIN IMMEDIATE')
    try {
      const key = owner(scope)
      if (this.db.get('SELECT id FROM retired WHERE owner=? AND id=?', key, id)) { this.db.exec('COMMIT'); return }
      const current = this.read(scope, id)
      if (!current || current.storageRevision !== expectedRevision) throw new Error('HTML checkpoint revision conflict; refresh before deleting.')
      if (Number(this.db.get('SELECT count(*) AS n FROM retired')?.n) >= HTML_CHECKPOINT_LIMITS.retired) throw new Error('HTML deletion ledger capacity reached; refusing to drop replay protection.')
      if (this.db.prepare('INSERT INTO retired(owner,id) VALUES(?,?)').run(key, id).changes !== 1 || this.db.prepare('DELETE FROM apps WHERE owner=? AND id=? AND revision=?').run(key, id, expectedRevision).changes !== 1) throw new Error('HTML checkpoint deletion failed.')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close(): void { this.db.close() }
}
