import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export const COMFY_STATE_APPLICATION_ID = 0x4d504243
export const COMFY_STATE_SCHEMA_VERSION = 1
export const COMFY_BATCH_STATE_TABLE = 'comfy_batch_states'
export const COMFY_BATCH_SOURCE_INDEX = 'comfy_batch_states_source_root_idx'
export const COMFY_OUTPUT_ROUTE_TABLE = 'comfy_output_routes'
export const COMFY_OUTPUT_ROUTE_INSTANCE_INDEX = 'comfy_output_routes_instance_id_idx'
export const COMFY_OUTPUT_ROUTE_ENDPOINT_INDEX = 'comfy_output_routes_endpoint_uidx'

export const COMFY_BATCH_STATE_TABLE_DDL = `CREATE TABLE comfy_batch_states (
  batch_id TEXT PRIMARY KEY NOT NULL,
  source_root TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL
) STRICT`
export const COMFY_BATCH_SOURCE_INDEX_DDL =
  'CREATE INDEX comfy_batch_states_source_root_idx ON comfy_batch_states(source_root)'
export const COMFY_OUTPUT_ROUTE_TABLE_DDL = `CREATE TABLE comfy_output_routes (
  route_id TEXT PRIMARY KEY NOT NULL,
  instance_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
  created_at INTEGER NOT NULL
) STRICT`
export const COMFY_OUTPUT_ROUTE_INSTANCE_INDEX_DDL =
  'CREATE INDEX comfy_output_routes_instance_id_idx ON comfy_output_routes(instance_id)'
export const COMFY_OUTPUT_ROUTE_ENDPOINT_INDEX_DDL =
  'CREATE INDEX comfy_output_routes_endpoint_uidx ON comfy_output_routes(instance_id, origin, kind, created_at, route_id)'

const EXPECTED_BATCH_COLUMNS = [
  ['batch_id', 'TEXT', 1, 1],
  ['source_root', 'TEXT', 1, 0],
  ['updated_at', 'TEXT', 1, 0],
  ['state_json', 'TEXT', 1, 0]
] as const
const EXPECTED_ROUTE_COLUMNS = [
  ['route_id', 'TEXT', 1, 1],
  ['instance_id', 'TEXT', 1, 0],
  ['origin', 'TEXT', 1, 0],
  ['kind', 'TEXT', 1, 0],
  ['created_at', 'INTEGER', 1, 0]
] as const
const ALLOWED_STATE_TABLES = new Set([COMFY_BATCH_STATE_TABLE, COMFY_OUTPUT_ROUTE_TABLE])
const INSTANCE_PRIMARY_TABLES = new Set([
  'events',
  'resource_mutations',
  'resources',
  'schema_metadata',
  'snapshots'
])

const canonicalSql = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .trim()
        .replace(/\s+/gu, ' ')
        .replace(/\s*([(),])\s*/gu, '$1')
        .replace(/;$/u, '')
        .toLowerCase()
    : ''

const schemaSql = (database: DatabaseSync, type: 'table' | 'index', name: string): string => {
  const row = database
    .prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
    .get(type, name) as Record<string, unknown> | undefined
  return canonicalSql(row?.sql)
}

const assertColumns = (
  database: DatabaseSync,
  tableName: string,
  expected: readonly (readonly [string, string, number, number])[],
  errorMessage: string
): void => {
  const actual = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>
      return [record.name, record.type, record.notnull, record.pk]
    })
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(errorMessage)
}

const assertIndex = (
  database: DatabaseSync,
  tableName: string,
  indexName: string,
  indexedColumns: readonly string[],
  unique: boolean,
  expectedSql: string,
  errorMessage: string
): void => {
  const entry = database
    .prepare(`PRAGMA index_list(${tableName})`)
    .all()
    .find((row) => (row as Record<string, unknown>).name === indexName) as
    Record<string, unknown> | undefined
  if (!entry || entry.unique !== (unique ? 1 : 0) || entry.partial !== 0)
    throw new Error(errorMessage)
  const columns = database
    .prepare(`PRAGMA index_info(${indexName})`)
    .all()
    .map((row) => (row as Record<string, unknown>).name)
  if (
    JSON.stringify(columns) !== JSON.stringify(indexedColumns) ||
    schemaSql(database, 'index', indexName) !== canonicalSql(expectedSql)
  ) {
    throw new Error(errorMessage)
  }
}

export const readComfyStateUserTableNames = (database: DatabaseSync): string[] =>
  database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`
    )
    .all()
    .map((row) => {
      const name = (row as Record<string, unknown>).name
      if (typeof name !== 'string')
        throw new Error('Comfy state database returned an invalid table name.')
      return name
    })

export const assertComfyStateTableBoundary = (tableNames: readonly string[]): void => {
  const instanceTable = tableNames.find((name) => INSTANCE_PRIMARY_TABLES.has(name))
  if (instanceTable) {
    throw new Error(`Comfy state database contains forbidden instance table: ${instanceTable}.`)
  }
  const unexpected = tableNames.find((name) => !ALLOWED_STATE_TABLES.has(name))
  if (unexpected)
    throw new Error(`Comfy state database contains an unexpected table: ${unexpected}.`)
}

export const assertComfyBatchStateSchema = (database: DatabaseSync): void => {
  assertColumns(
    database,
    COMFY_BATCH_STATE_TABLE,
    EXPECTED_BATCH_COLUMNS,
    'Comfy batch state database has an altered batch table schema.'
  )
  if (
    schemaSql(database, 'table', COMFY_BATCH_STATE_TABLE) !==
    canonicalSql(COMFY_BATCH_STATE_TABLE_DDL)
  ) {
    throw new Error('Comfy batch state database has an altered batch table schema.')
  }
  assertIndex(
    database,
    COMFY_BATCH_STATE_TABLE,
    COMFY_BATCH_SOURCE_INDEX,
    ['source_root'],
    false,
    COMFY_BATCH_SOURCE_INDEX_DDL,
    'Comfy batch state database has an altered batch index schema.'
  )
}

export const assertComfyOutputRouteTableAndLegacyIndexSchema = (database: DatabaseSync): void => {
  assertColumns(
    database,
    COMFY_OUTPUT_ROUTE_TABLE,
    EXPECTED_ROUTE_COLUMNS,
    'Comfy output route database has an altered route table schema.'
  )
  if (
    schemaSql(database, 'table', COMFY_OUTPUT_ROUTE_TABLE) !==
    canonicalSql(COMFY_OUTPUT_ROUTE_TABLE_DDL)
  ) {
    throw new Error('Comfy output route database has an altered route table schema.')
  }
  assertIndex(
    database,
    COMFY_OUTPUT_ROUTE_TABLE,
    COMFY_OUTPUT_ROUTE_INSTANCE_INDEX,
    ['instance_id'],
    false,
    COMFY_OUTPUT_ROUTE_INSTANCE_INDEX_DDL,
    'Comfy output route database has an altered route index schema.'
  )
}

export const assertComfyOutputRouteSchema = (database: DatabaseSync): void => {
  assertComfyOutputRouteTableAndLegacyIndexSchema(database)
  assertIndex(
    database,
    COMFY_OUTPUT_ROUTE_TABLE,
    COMFY_OUTPUT_ROUTE_ENDPOINT_INDEX,
    ['instance_id', 'origin', 'kind', 'created_at', 'route_id'],
    false,
    COMFY_OUTPUT_ROUTE_ENDPOINT_INDEX_DDL,
    'Comfy output route database has an altered endpoint index schema.'
  )
}

export const comfyBatchStateDatabasePath = (userDataRoot: string): string =>
  path.join(userDataRoot, 'comfy-batch', 'state.sqlite')

export const comfyInstanceStoreDatabasePath = (userDataRoot: string): string =>
  path.join(userDataRoot, 'comfy-batch', 'instances.sqlite')
