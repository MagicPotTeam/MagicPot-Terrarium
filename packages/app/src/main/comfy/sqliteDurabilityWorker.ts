import { DatabaseSync } from 'node:sqlite'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { SqliteComfyBatchStateStore } from './batchStateStore'
import { ComfyInstanceRegistry } from './instanceRegistry'
import { SqliteComfyOutputRouteStore } from './outputRouteStore'
import { comfyBatchStateDatabasePath, comfyInstanceStoreDatabasePath } from './statePaths'

type DatabaseIdentity = Readonly<{
  applicationId: number
  userVersion: number
  tables: readonly string[]
  indexes: readonly string[]
}>

const readIntegerPragma = (
  database: DatabaseSync,
  pragma: 'application_id' | 'user_version'
): number => {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
  const value = row?.[pragma]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Worker received an invalid SQLite ${pragma}.`)
  }
  return value
}

const inspectDatabase = (databasePath: string): DatabaseIdentity => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`
      )
      .all()
      .map((row) => {
        const name = (row as Record<string, unknown>).name
        if (typeof name !== 'string') throw new Error('Worker received an invalid table name.')
        return name
      })
    const indexes = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`
      )
      .all()
      .map((row) => {
        const name = (row as Record<string, unknown>).name
        if (typeof name !== 'string') throw new Error('Worker received an invalid index name.')
        return name
      })
    return {
      applicationId: readIntegerPragma(database, 'application_id'),
      userVersion: readIntegerPragma(database, 'user_version'),
      tables,
      indexes
    }
  } finally {
    database.close()
  }
}

const main = (): void => {
  const userDataRoot = process.argv[2]
  if (!userDataRoot) throw new Error('SQLite durability worker requires a user-data root.')

  const batchPath = comfyBatchStateDatabasePath(userDataRoot)
  const instancePath = comfyInstanceStoreDatabasePath(userDataRoot)

  const openOrder = process.argv[3] === 'route-first' ? 'route-first' : 'batch-first'
  const mode = process.argv[4] || 'inspect'
  let batchStates: ReturnType<SqliteComfyBatchStateStore['loadAll']>
  if (openOrder === 'route-first') {
    const routeStore = new SqliteComfyOutputRouteStore(batchPath)
    routeStore.close()
  }
  if (mode === 'open-only') {
    process.stdout.write(`${JSON.stringify({ pid: process.pid, openOrder, mode })}\n`)
    return
  }
  const batchStore = new SqliteComfyBatchStateStore(batchPath)
  try {
    batchStates = batchStore.loadAll()
  } finally {
    batchStore.close()
  }
  if (openOrder === 'batch-first') {
    const routeStore = new SqliteComfyOutputRouteStore(batchPath)
    routeStore.close()
  }

  const eventStore = new MagicAgentEventStore(instancePath)
  let instances: ReturnType<ComfyInstanceRegistry['list']>
  try {
    instances = new ComfyInstanceRegistry(eventStore).list()
  } finally {
    eventStore.close()
  }

  process.stdout.write(
    `${JSON.stringify({
      pid: process.pid,
      batchPath,
      instancePath,
      openOrder,
      batchStates,
      instances,
      databases: {
        batch: inspectDatabase(batchPath),
        instance: inspectDatabase(instancePath)
      }
    })}\n`
  )
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
}
