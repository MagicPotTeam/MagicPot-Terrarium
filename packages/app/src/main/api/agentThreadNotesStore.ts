import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import { AGENT_THREAD_MEMORY_LIMITS as LIMITS, type AgentThreadNotes, type MutateAgentThreadNoteReq } from '@shared/api/agentThreadMemory'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'

const identity = (scope: AgentThreadInteractionScope) => JSON.stringify([getAgentSessionKey(normalizeAgentRoute(scope.route)), scope.conversationId])
const id = (scope: AgentThreadInteractionScope) => createHash('sha256').update(identity(scope)).digest('hex')
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key)
const digest = (req: MutateAgentThreadNoteReq) => createHash('sha256').update(JSON.stringify([req.action, req.key, req.value ?? null, req.expectedRevision])).digest('hex')
export function validateAgentNoteMutation(req: MutateAgentThreadNoteReq): void {
  if (!req || typeof req !== 'object' || Array.isArray(req) || Object.keys(req).some(key => !['route', 'conversationId', 'action', 'key', 'value', 'expectedRevision', 'operationId'].includes(key)) || !['set', 'delete', 'clear'].includes(req.action) || !Number.isSafeInteger(req.expectedRevision) || req.expectedRevision < 0 || req.expectedRevision >= Number.MAX_SAFE_INTEGER || typeof req.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(req.operationId) ||
    (req.action === 'clear' ? req.key !== undefined || req.value !== undefined : !validKey(req.key) ||
      (req.action === 'set' && (typeof req.value !== 'string' || req.value.length > LIMITS.noteCharacters)) || (req.action === 'delete' && req.value !== undefined))) throw new Error('Invalid Agent note mutation.')
}
function inspect(file: string): void {
  const absolute = path.resolve(file)
  let current = path.parse(absolute).root
  for (const segment of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, segment)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (!stat) break
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory()) || (current === absolute && (!stat.isFile() || stat.nlink !== 1))) throw new Error('Agent notes database must not traverse links or non-regular files.')
  }
}

const NOTES_DDL = 'CREATE TABLE notes (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)'
const RECEIPTS_DDL = 'CREATE TABLE receipts (owner TEXT NOT NULL, operation TEXT NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(owner, operation))'
const normalizeSql = (sql: unknown): string => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim().toLowerCase() : ''

/** Current values only: no historical value snapshots. Durable CAS + bounded hash receipts. */
export class AgentThreadNotesStore {
  private readonly db: NodeSQLiteAdapter
  constructor(database = ':memory:') {
    if (database !== ':memory:') for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(database + suffix)
    const before = database !== ':memory:' ? lstatSync(database, { throwIfNoEntry: false }) : undefined
    this.db = new NodeSQLiteAdapter(database)
    try {
      if (database !== ':memory:') {
        for (const suffix of ['', '-journal', '-wal', '-shm']) inspect(database + suffix)
        const after = lstatSync(database)
        if ((before && (before.dev !== after.dev || before.ino !== after.ino)) || path.resolve(realpathSync(database)).toLowerCase() !== path.resolve(database).toLowerCase()) throw new Error('Agent notes database identity changed.')
      }
      const applicationId = this.db.get('PRAGMA application_id')?.application_id
      const version = this.db.get('PRAGMA user_version')?.user_version
      const objects = this.db.all('SELECT type, name, tbl_name, sql FROM sqlite_master')
      if (applicationId === 0 && version === 0 && objects.length === 0) {
        this.db.exec(`BEGIN IMMEDIATE; ${NOTES_DDL}; ${RECEIPTS_DDL}; PRAGMA application_id=1297108529; PRAGMA user_version=1; COMMIT;`)
      } else if (applicationId !== 0x4d504e31 || version !== 1) throw new Error('Unsupported Agent notes database identity or version.')
      this.assertSchema()
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;')
    } catch (error) { this.db.close(); throw error }
  }
  private assertSchema(): void {
    const expected = new Map([
      ['notes', { type: 'table', table: 'notes', sql: normalizeSql(NOTES_DDL) }],
      ['receipts', { type: 'table', table: 'receipts', sql: normalizeSql(RECEIPTS_DDL) }],
      ['sqlite_autoindex_notes_1', { type: 'index', table: 'notes', sql: '' }],
      ['sqlite_autoindex_receipts_1', { type: 'index', table: 'receipts', sql: '' }]
    ])
    const objects = this.db.all('SELECT type, name, tbl_name, sql FROM sqlite_master')
    if (objects.length !== expected.size || objects.some((object) => {
      const spec = expected.get(String(object.name))
      return !spec || object.type !== spec.type || object.tbl_name !== spec.table || normalizeSql(object.sql) !== spec.sql
    }) || this.db.get('PRAGMA application_id')?.application_id !== 0x4d504e31 || this.db.get('PRAGMA user_version')?.user_version !== 1)
      throw new Error('Invalid Agent notes database schema; unexpected tables, indexes or triggers.')
  }
  get(scope: AgentThreadInteractionScope): AgentThreadNotes {
    this.assertSchema()
    const row = this.db.get('SELECT revision, document FROM notes WHERE owner = ?', id(scope))
    if (!row) return { revision: 0, notes: [] }
    if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || typeof row.document !== 'string' || Buffer.byteLength(row.document, 'utf8') > LIMITS.noteBytes) throw new Error('Invalid stored Agent notes.')
    const notes = JSON.parse(row.document) as AgentThreadNotes['notes']
    if (!Array.isArray(notes) || notes.length > LIMITS.noteKeys || new Set(notes.map((note) => note?.key)).size !== notes.length || notes.some((note) => !note || !validKey(note.key) || typeof note.value !== 'string' || note.value.length > LIMITS.noteCharacters || !Number.isFinite(note.updatedAt))) throw new Error('Invalid stored Agent notes.')
    return { revision: row.revision as number, notes }
  }
  replay(req: MutateAgentThreadNoteReq): AgentThreadNotes | undefined {
    validateAgentNoteMutation(req)
    this.assertSchema()
    const row = this.db.get('SELECT digest FROM receipts WHERE owner = ? AND operation = ?', id(req), req.operationId)
    if (!row) return undefined
    if (row.digest !== digest(req)) throw new Error('Agent note replay conflict.')
    // Do not retain or resurrect an older value in replay receipts.
    return this.get(req)
  }
  mutate(req: MutateAgentThreadNoteReq): AgentThreadNotes {
    validateAgentNoteMutation(req)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.replay(req)
      if (replay) { this.db.exec('COMMIT'); return replay }
      const current = this.get(req)
      if (current.revision !== req.expectedRevision) throw new Error('Agent notes revision conflict; read again before saving.')
      const notes = req.action === 'clear' ? [] : current.notes.filter((note) => note.key !== req.key)
      if (req.action === 'set') notes.push({ key: req.key, value: req.value!, updatedAt: Date.now() })
      const document = JSON.stringify(notes)
      if (notes.length > LIMITS.noteKeys || Buffer.byteLength(document, 'utf8') > LIMITS.noteBytes) throw new Error('Agent notes capacity limit reached.')
      const changed = this.db.prepare('INSERT INTO notes(owner, revision, document) VALUES(?, ?, ?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision, document=excluded.document').run(id(req), current.revision + 1, document)
      if (changed.changes !== 1) throw new Error('Agent note write did not persist.')
      const receipt = this.db.prepare('INSERT INTO receipts(owner, operation, digest, revision) VALUES(?, ?, ?, ?)').run(id(req), req.operationId, digest(req), current.revision + 1)
      if (receipt.changes !== 1) throw new Error('Agent note receipt did not persist.')
      this.db.prepare('DELETE FROM receipts WHERE owner = ? AND revision <= ?').run(id(req), current.revision - 63)
      const persisted = this.get(req)
      if (persisted.revision !== current.revision + 1 || JSON.stringify(persisted.notes) !== document) throw new Error('Agent note write verification failed.')
      this.db.exec('COMMIT')
      return persisted
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close(): void { this.db.close() }
}
let production: AgentThreadNotesStore | undefined
export async function closeAgentThreadNotesStore(): Promise<void> { production?.close(); production = undefined }
export async function getAgentThreadNotesStore(): Promise<AgentThreadNotesStore> {
  if (production) return production
  // Bundler-tracked import, not a runtime require of a source-tree path.
  const database = process.env.NODE_ENV === 'test' ? ':memory:' : path.join((await import('../config/buildEnv')).getBuildEnv().pathMap.data, 'agent-thread-memory', 'notes-v1.sqlite')
  production ??= new AgentThreadNotesStore(database)
  return production
}
