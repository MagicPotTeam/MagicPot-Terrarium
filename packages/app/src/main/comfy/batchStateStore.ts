import type { ComfyBatchState } from '@shared/api/svcComfyBatch'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export { comfyBatchStateDatabasePath } from './statePaths'
import {
  assertComfyBatchStateSchema,
  assertComfyStateTableBoundary,
  COMFY_BATCH_SOURCE_INDEX_DDL,
  COMFY_BATCH_STATE_TABLE_DDL,
  COMFY_STATE_APPLICATION_ID,
  COMFY_STATE_SCHEMA_VERSION,
  readComfyStateUserTableNames
} from './statePaths'

const readIntegerPragma = (
  database: DatabaseSync,
  pragma: 'application_id' | 'user_version'
): number => {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
  const value = row?.[pragma]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Comfy batch state database returned an invalid ${pragma}.`)
  }
  return value
}

export interface ComfyBatchStateStore {
  loadAll(): readonly ComfyBatchState[]
  save(state: ComfyBatchState): void
  close(): void
}

type StateRow = {
  batch_id: unknown
  state_json: unknown
}

const isStateRow = (value: unknown): value is StateRow =>
  typeof value === 'object' && value !== null && 'batch_id' in value && 'state_json' in value

export class SqliteComfyBatchStateStore implements ComfyBatchStateStore {
  private readonly database: DatabaseSync

  constructor(readonly databasePath: string) {
    if (typeof databasePath !== 'string' || !databasePath.trim()) {
      throw new TypeError('Comfy batch state database path must be a non-empty string.')
    }

    if (databasePath !== ':memory:') {
      const resolved = path.resolve(databasePath)
      mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 })
      if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
        throw new Error(`Comfy batch state database must not be a symbolic link: ${resolved}`)
      }
    }

    this.database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true
    })
    try {
      this.initialize()
    } catch (error) {
      this.close()
      throw error
    }
  }

  private initialize(): void {
    this.database.exec('PRAGMA busy_timeout = 5000;')
    const applicationId = readIntegerPragma(this.database, 'application_id')
    const schemaVersion = readIntegerPragma(this.database, 'user_version')
    const userTableNames = readComfyStateUserTableNames(this.database)

    if (applicationId !== 0 && applicationId !== COMFY_STATE_APPLICATION_ID) {
      throw new Error('Comfy batch state database belongs to a different application.')
    }
    if (applicationId === 0 && (schemaVersion !== 0 || userTableNames.length > 0)) {
      throw new Error('Comfy batch state database has an unrecognized existing schema.')
    }
    if (
      applicationId === COMFY_STATE_APPLICATION_ID &&
      ![0, COMFY_STATE_SCHEMA_VERSION].includes(schemaVersion)
    ) {
      throw new Error(`Unsupported Comfy batch state schema version: ${schemaVersion}.`)
    }
    assertComfyStateTableBoundary(userTableNames)
    if (
      applicationId === COMFY_STATE_APPLICATION_ID &&
      schemaVersion === COMFY_STATE_SCHEMA_VERSION &&
      userTableNames.length === 0
    ) {
      throw new Error('Comfy batch state database is missing its authoritative tables.')
    }
    const batchTableExists = userTableNames.includes('comfy_batch_states')
    if (batchTableExists) assertComfyBatchStateSchema(this.database)

    this.database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA fullfsync = ON;
      PRAGMA checkpoint_fullfsync = ON;
    `)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (!batchTableExists) {
        this.database.exec(`${COMFY_BATCH_STATE_TABLE_DDL};${COMFY_BATCH_SOURCE_INDEX_DDL};`)
      }
      this.database.exec(`
        PRAGMA application_id = ${COMFY_STATE_APPLICATION_ID};
        PRAGMA user_version = ${COMFY_STATE_SCHEMA_VERSION};
      `)
      assertComfyBatchStateSchema(this.database)
      this.database.exec('COMMIT')
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Preserve the original schema failure.
      }
      throw error
    }

    if (
      readIntegerPragma(this.database, 'application_id') !== COMFY_STATE_APPLICATION_ID ||
      readIntegerPragma(this.database, 'user_version') !== COMFY_STATE_SCHEMA_VERSION
    ) {
      throw new Error('Comfy batch state database identity could not be established.')
    }
    const integrity = this.database.prepare('PRAGMA quick_check').get() as
      Record<string, unknown> | undefined
    if (!integrity || !Object.values(integrity).includes('ok')) {
      throw new Error('Comfy batch state database failed SQLite quick_check.')
    }
  }

  loadAll(): readonly ComfyBatchState[] {
    const rows = this.database
      .prepare('SELECT batch_id, state_json FROM comfy_batch_states ORDER BY batch_id ASC')
      .all()

    return rows.map((row) => {
      if (
        !isStateRow(row) ||
        typeof row.batch_id !== 'string' ||
        typeof row.state_json !== 'string'
      ) {
        throw new Error('Comfy batch state database returned a malformed row.')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(row.state_json)
      } catch (error) {
        throw new Error(`Comfy batch ${row.batch_id} contains invalid persisted JSON.`, {
          cause: error
        })
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('batchId' in parsed) ||
        parsed.batchId !== row.batch_id
      ) {
        throw new Error(`Comfy batch ${row.batch_id} has an inconsistent persisted identity.`)
      }
      return parsed as ComfyBatchState
    })
  }

  save(state: ComfyBatchState): void {
    const stateJson = JSON.stringify(state)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database
        .prepare(
          `INSERT INTO comfy_batch_states(batch_id, source_root, updated_at, state_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(batch_id) DO UPDATE SET
             source_root = excluded.source_root,
             updated_at = excluded.updated_at,
             state_json = excluded.state_json`
        )
        .run(state.batchId, state.sourceRoot, state.updatedAt, stateJson)
      this.database.exec('COMMIT')
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Preserve the original transaction error.
      }
      throw error
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }
}
