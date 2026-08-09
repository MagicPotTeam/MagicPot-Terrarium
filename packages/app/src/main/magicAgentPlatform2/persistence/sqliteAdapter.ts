import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backup, DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

export const EVENT_STORE_APPLICATION_ID = 0x4d415032
export const EVENT_STORE_SCHEMA_VERSION = 3

export type NodeSQLiteCapability = Readonly<{
  nodeVersion: string
  sqliteVersion: string | null
  available: boolean
}>

export class NodeSQLiteUnavailableError extends Error {
  readonly code = 'MAGIC_AGENT_NODE_SQLITE_UNAVAILABLE'
  constructor(cause?: unknown) {
    super('MagicAgent Event Store requires the node:sqlite DatabaseSync API.', { cause })
    this.name = 'NodeSQLiteUnavailableError'
  }
}

export class EventStoreOpenError extends Error {
  readonly code = 'MAGIC_AGENT_EVENT_STORE_OPEN'
  constructor(path: string, cause?: unknown) {
    super(`Could not open MagicAgent Event Store at ${path}.`, { cause })
    this.name = 'EventStoreOpenError'
  }
}

const DATABASE_OPTIONS = {
  allowExtension: false,
  enableDoubleQuotedStringLiterals: false,
  enableForeignKeyConstraints: true
} as const

export function getNodeSQLiteCapability(): NodeSQLiteCapability {
  let db: DatabaseSync | undefined
  try {
    if (typeof DatabaseSync !== 'function') throw new NodeSQLiteUnavailableError()
    db = new DatabaseSync(':memory:', DATABASE_OPTIONS)
    const row = db.prepare('SELECT sqlite_version() AS version').get()
    return {
      nodeVersion: process.versions.node,
      sqliteVersion:
        isRow(row) && typeof row.version === 'string'
          ? row.version
          : (process.versions.sqlite ?? null),
      available: true
    }
  } catch {
    return {
      nodeVersion: process.versions.node,
      sqliteVersion: process.versions.sqlite ?? null,
      available: false
    }
  } finally {
    if (db?.isOpen) db.close()
  }
}

export type SQLiteRow = Record<string, unknown>

type OpenMode = 'read-only' | 'read-write'

export class NodeSQLiteAdapter {
  readonly path: string
  readonly timeout: number
  readonly database: DatabaseSync

  constructor(path: string, timeout = 5000, mode: OpenMode = 'read-write') {
    if (typeof path !== 'string' || path.length === 0)
      throw new TypeError('SQLite path must be a non-empty string.')
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      throw new RangeError('SQLite timeout must be a non-negative safe integer.')
    }
    this.path = path
    this.timeout = timeout
    if (typeof DatabaseSync !== 'function') throw new NodeSQLiteUnavailableError()
    try {
      if (mode === 'read-write' && path !== ':memory:')
        mkdirSync(dirname(path), { recursive: true })
      this.database = new DatabaseSync(path, {
        ...DATABASE_OPTIONS,
        ...(mode === 'read-only' ? { readOnly: true } : {})
      })
    } catch (error) {
      if (mode === 'read-only' && isMissingFileError(error)) throw error
      throw new EventStoreOpenError(path, error)
    }
  }

  exec(sql: string): void {
    this.database.exec(sql)
  }

  prepare(sql: string): StatementSync {
    return this.database.prepare(sql)
  }

  get(sql: string, ...params: SQLInputValue[]): SQLiteRow | undefined {
    const row = this.prepare(sql).get(...params)
    return isRow(row) ? row : undefined
  }

  all(sql: string, ...params: SQLInputValue[]): SQLiteRow[] {
    return this.prepare(sql)
      .all(...params)
      .filter(isRow)
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }
}

export function openReadOnlyDatabase(path: string): NodeSQLiteAdapter {
  if (path === ':memory:') return new NodeSQLiteAdapter(path, 0, 'read-only')
  return new NodeSQLiteAdapter(path, 0, 'read-only')
}

export function openImmutableReadOnlyDatabase(path: string): NodeSQLiteAdapter {
  if (path === ':memory:') return openReadOnlyDatabase(path)
  const url = pathToFileURL(path)
  url.searchParams.set('immutable', '1')
  return new NodeSQLiteAdapter(url.href, 0, 'read-only')
}

export function openReadWriteDatabase(path: string, timeout = 5000): NodeSQLiteAdapter {
  return new NodeSQLiteAdapter(path, timeout, 'read-write')
}

export function backupDatabase(
  source: NodeSQLiteAdapter,
  targetPath: string,
  options: { rate?: number } = {}
): Promise<void> {
  return backup(source.database, targetPath, options)
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export function isRow(value: unknown): value is SQLiteRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
