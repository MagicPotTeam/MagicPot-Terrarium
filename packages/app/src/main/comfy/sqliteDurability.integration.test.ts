import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
vi.mock('node:fs/promises', async (importActual) => importActual())

import type { ComfyBatchState } from '@shared/api/svcComfyBatch'
import type { ComfyInstanceState } from '@shared/comfy/dispatch'
import {
  MagicAgentEventStore,
  type StoredResource
} from '../magicAgentPlatform2/persistence/eventStore'
import {
  EVENT_STORE_APPLICATION_ID,
  EVENT_STORE_SCHEMA_VERSION
} from '../magicAgentPlatform2/persistence/sqliteAdapter'
import { SqliteComfyBatchStateStore } from './batchStateStore'
import { SqliteComfyOutputRouteStore } from './outputRouteStore'
import { ComfyInstanceRegistry } from './instanceRegistry'
import { comfyBatchStateDatabasePath, comfyInstanceStoreDatabasePath } from './statePaths'

const BATCH_APPLICATION_ID = 0x4d504243
const BATCH_SCHEMA_VERSION = 1
const BATCH_TABLES = ['comfy_batch_states', 'comfy_output_routes'] as const
const BATCH_INDEXES = [
  'comfy_batch_states_source_root_idx',
  'comfy_output_routes_endpoint_uidx',
  'comfy_output_routes_instance_id_idx'
] as const
const INSTANCE_TABLES = [
  'events',
  'resource_mutations',
  'resources',
  'schema_metadata',
  'snapshots'
] as const

type DatabaseSnapshot = Readonly<{
  applicationId: number
  userVersion: number
  tables: readonly string[]
  indexes: readonly string[]
  sentinel?: string
}>

type WorkerResult = Readonly<{
  pid: number
  batchPath: string
  instancePath: string
  openOrder: 'route-first' | 'batch-first'
  batchStates: readonly ComfyBatchState[]
  instances: readonly StoredResource<ComfyInstanceState>[]
  databases: Readonly<{
    batch: DatabaseSnapshot
    instance: DatabaseSnapshot
  }>
}>

const repositoryRoot = path.resolve(__dirname, '../../../../..')
const temporaryRoots: string[] = []
let workerBuildRoot = ''
let workerBundle = ''

const makeTemporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

beforeAll(async () => {
  workerBuildRoot = await mkdtemp(path.join(tmpdir(), 'magicpot-comfy-sqlite-worker-'))
  workerBundle = path.join(workerBuildRoot, 'sqlite-durability-worker.cjs')
  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [path.join(__dirname, 'sqliteDurabilityWorker.ts')],
    outfile: workerBundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['node:sqlite'],
    alias: {
      electron: path.join(__dirname, 'sqliteDurabilityElectronStub.ts')
    },
    tsconfig: path.join(repositoryRoot, 'config/tsconfig/tsconfig.node.json')
  })
})

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
})

afterAll(async () => {
  if (workerBuildRoot) {
    await rm(workerBuildRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    })
  }
})

const makeBatchState = (sourceRoot: string): ComfyBatchState => {
  const outputRoot = path.join(path.dirname(sourceRoot), 'output')
  const metadataRoot = path.join(outputRoot, '.magicpot-batch')
  const timestamp = '2025-02-03T04:05:06.000Z'
  return {
    batchId: 'durable-batch',
    status: 'paused',
    sourceRoot,
    workflow: {
      '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } }
    },
    binding: {
      inputNodeId: '1',
      inputField: 'image',
      outputNodeId: '2',
      outputIndex: 0
    },
    target: { mode: 'specific', instanceId: 'durable-gpu' },
    workspace: {
      sourceRoot,
      workRoot: outputRoot,
      outputRoot,
      metadataRoot,
      stagingRoot: path.join(metadataRoot, 'staging'),
      manifestPath: path.join(metadataRoot, 'manifest.json')
    },
    manifest: {
      version: 1,
      sourceRoot,
      createdAt: timestamp,
      updatedAt: timestamp,
      items: []
    },
    items: [
      {
        relativeInputPath: 'prepared.png',
        status: 'running',
        instanceId: 'durable-gpu',
        instanceOrigin: 'https://durable-comfy.example/',
        instanceKind: 'remote',
        attempts: 1,
        submissionToken: 'submission-prepared-token',
        submissionState: 'prepared'
      },
      {
        relativeInputPath: 'unknown.png',
        status: 'failed',
        instanceId: 'durable-gpu',
        instanceOrigin: 'https://durable-comfy.example/',
        instanceKind: 'remote',
        attempts: 1,
        error: 'Prompt submission outcome is unknown.',
        submissionToken: 'submission-unknown-token',
        submissionState: 'unknown',
        requiresManualIntervention: true
      }
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
    errorLogPath: path.join(metadataRoot, 'errors.log')
  }
}

const seedInstanceRegistry = (databasePath: string): StoredResource<ComfyInstanceState> => {
  const eventStore = new MagicAgentEventStore(databasePath)
  try {
    const registry = new ComfyInstanceRegistry(eventStore)
    const created = registry.create({
      id: 'durable-gpu',
      name: 'Durable GPU',
      origin: 'https://durable-comfy.example/',
      kind: 'remote',
      tags: ['flux', 'durable'],
      capabilities: {
        tags: ['flux', 'durable'],
        models: ['flux.safetensors'],
        customNodes: ['LoadImage', 'SaveImage']
      },
      createdAt: 1_738_560_000_000,
      idempotencyKey: 'durable-create'
    })
    return registry.updateHealth({
      id: 'durable-gpu',
      expectedRevision: created.revision,
      status: 'online',
      checkedAt: 1_738_560_000_001,
      idempotencyKey: 'durable-health'
    })
  } finally {
    eventStore.close()
  }
}

const readIntegerPragma = (
  database: DatabaseSync,
  pragma: 'application_id' | 'user_version'
): number => {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
  const value = row?.[pragma]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid SQLite ${pragma}.`)
  }
  return value
}

const inspectDatabase = (databasePath: string, readSentinel = false): DatabaseSnapshot => {
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
        if (typeof name !== 'string') throw new Error('Invalid SQLite table name.')
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
        if (typeof name !== 'string') throw new Error('Invalid SQLite index name.')
        return name
      })
    const sentinel = readSentinel
      ? (
          database.prepare('SELECT marker FROM durability_sentinel').get() as
            Record<string, unknown> | undefined
        )?.marker
      : undefined
    if (readSentinel && typeof sentinel !== 'string') {
      throw new Error('Foreign database sentinel is missing.')
    }
    return {
      applicationId: readIntegerPragma(database, 'application_id'),
      userVersion: readIntegerPragma(database, 'user_version'),
      tables,
      indexes,
      ...(typeof sentinel === 'string' ? { sentinel } : {})
    }
  } finally {
    database.close()
  }
}

const seedForeignDatabase = (
  databasePath: string,
  applicationId: number,
  userVersion: number,
  sentinel: string
): DatabaseSnapshot => {
  mkdirSync(path.dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA application_id = ${applicationId};
      PRAGMA user_version = ${userVersion};
      CREATE TABLE durability_sentinel (marker TEXT PRIMARY KEY NOT NULL) STRICT;
    `)
    database.prepare('INSERT INTO durability_sentinel(marker) VALUES (?)').run(sentinel)
  } finally {
    database.close()
  }
  return inspectDatabase(databasePath, true)
}

const runWorker = <T = WorkerResult>(
  userDataRoot: string,
  openOrder: 'route-first' | 'batch-first' = 'batch-first',
  mode = 'inspect'
): Promise<T> =>
  new Promise((resolveWorker, rejectWorker) => {
    execFile(
      process.execPath,
      [workerBundle, userDataRoot, openOrder, mode],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 30_000,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectWorker(
            new Error(`SQLite durability worker failed: ${String(stderr).trim()}`, { cause: error })
          )
          return
        }
        try {
          resolveWorker(JSON.parse(String(stdout).trim()) as T)
        } catch (parseError) {
          rejectWorker(
            new Error(`SQLite durability worker returned invalid JSON: ${String(stdout)}`, {
              cause: parseError
            })
          )
        }
      }
    )
  })

describe('Comfy native SQLite durability', () => {
  it('keeps batch submission intent and instance registry data across reopen and a child process', async () => {
    const userDataRoot = await makeTemporaryRoot('magicpot-comfy-sqlite-durability-')
    const batchPath = comfyBatchStateDatabasePath(userDataRoot)
    const instancePath = comfyInstanceStoreDatabasePath(userDataRoot)
    expect(batchPath).not.toBe(instancePath)

    const expectedBatch = makeBatchState(path.join(userDataRoot, 'source'))
    const batchStore = new SqliteComfyBatchStateStore(batchPath)
    try {
      batchStore.save(expectedBatch)
    } finally {
      batchStore.close()
    }
    const routeStore = new SqliteComfyOutputRouteStore(batchPath)
    const expectedRoute = routeStore.capture({
      id: 'route-instance',
      origin: 'http://127.0.0.1:8189/',
      kind: 'local'
    })
    routeStore.close()
    const reopenedRouteStore = new SqliteComfyOutputRouteStore(batchPath)
    expect(reopenedRouteStore.get(expectedRoute.routeId)).toEqual(expectedRoute)
    reopenedRouteStore.close()
    const expectedInstance = seedInstanceRegistry(instancePath)

    const reopenedBatchStore = new SqliteComfyBatchStateStore(batchPath)
    try {
      const reopened = reopenedBatchStore.loadAll()
      expect(reopened).toEqual([expectedBatch])
      expect(reopened[0].items.map((item) => item.submissionState)).toEqual(['prepared', 'unknown'])
      expect(reopened[0].items[1].requiresManualIntervention).toBe(true)
    } finally {
      reopenedBatchStore.close()
    }

    const reopenedEventStore = new MagicAgentEventStore(instancePath)
    try {
      expect(new ComfyInstanceRegistry(reopenedEventStore).list()).toEqual([expectedInstance])
    } finally {
      reopenedEventStore.close()
    }

    const child = await runWorker(userDataRoot, 'batch-first')
    expect(child.pid).not.toBe(process.pid)
    expect(child.batchPath).toBe(batchPath)
    expect(child.instancePath).toBe(instancePath)
    expect(child.openOrder).toBe('batch-first')
    expect(child.batchStates).toEqual([expectedBatch])
    expect(child.batchStates[0].items.map((item) => item.submissionState)).toEqual([
      'prepared',
      'unknown'
    ])
    expect(child.instances).toEqual([expectedInstance])

    const expectedBatchIdentity = {
      applicationId: BATCH_APPLICATION_ID,
      userVersion: BATCH_SCHEMA_VERSION,
      tables: BATCH_TABLES,
      indexes: BATCH_INDEXES
    }
    const expectedInstanceIdentity = {
      applicationId: EVENT_STORE_APPLICATION_ID,
      userVersion: EVENT_STORE_SCHEMA_VERSION,
      tables: INSTANCE_TABLES,
      indexes: expect.any(Array)
    }
    expect(child.databases.batch).toEqual(expectedBatchIdentity)
    expect(child.databases.instance).toEqual(expectedInstanceIdentity)
    expect(inspectDatabase(batchPath)).toEqual(expectedBatchIdentity)
    expect(inspectDatabase(instancePath)).toEqual(expectedInstanceIdentity)
    expect(child.databases.batch.applicationId).not.toBe(child.databases.instance.applicationId)
    expect(child.databases.batch.tables).not.toContain('resources')
    expect(child.databases.instance.tables).not.toContain('comfy_batch_states')
    expect(child.databases.instance.tables).not.toContain('comfy_output_routes')
  })

  it.each(['route-first', 'batch-first'] as const)(
    'opens the shared state database %s in a child process',
    async (openOrder) => {
      const userDataRoot = await makeTemporaryRoot(`magicpot-comfy-sqlite-${openOrder}-`)
      const child = await runWorker(userDataRoot, openOrder)
      expect(child.openOrder).toBe(openOrder)
      expect(child.databases.batch).toMatchObject({
        applicationId: BATCH_APPLICATION_ID,
        userVersion: BATCH_SCHEMA_VERSION,
        tables: BATCH_TABLES,
        indexes: BATCH_INDEXES
      })
    }
  )

  it('rejects state primary tables in an instances database without changing sentinel rows', async () => {
    const root = await makeTemporaryRoot('magicpot-comfy-sqlite-instance-boundary-')
    const instancePath = comfyInstanceStoreDatabasePath(root)
    const eventStore = new MagicAgentEventStore(instancePath)
    eventStore.close()
    const database = new DatabaseSync(instancePath)
    database.exec(`
      CREATE TABLE comfy_batch_states (
        batch_id TEXT PRIMARY KEY NOT NULL,
        source_root TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE durability_sentinel (marker TEXT PRIMARY KEY NOT NULL) STRICT;
      INSERT INTO durability_sentinel VALUES ('unchanged');
    `)
    database.close()

    expect(() => new MagicAgentEventStore(instancePath)).toThrow()
    const inspected = new DatabaseSync(instancePath, { readOnly: true })
    expect(inspected.prepare('SELECT marker FROM durability_sentinel').get()).toEqual({
      marker: 'unchanged'
    })
    expect(
      inspected.prepare("SELECT name FROM sqlite_schema WHERE name = 'comfy_batch_states'").get()
    ).toEqual({ name: 'comfy_batch_states' })
    inspected.close()
  })

  it.each([
    {
      name: 'invalid persisted JSON',
      rowId: 'corrupt-json',
      stateJson: '{not-json',
      expected: 'invalid persisted JSON'
    },
    {
      name: 'foreign persisted identity',
      rowId: 'row-id',
      stateJson: JSON.stringify({ batchId: 'other-id' }),
      expected: 'inconsistent persisted identity'
    }
  ])('fails closed in a child process on $name', async ({ rowId, stateJson, expected }) => {
    const userDataRoot = await makeTemporaryRoot('magicpot-comfy-sqlite-corrupt-row-')
    const batchPath = comfyBatchStateDatabasePath(userDataRoot)
    const batchStore = new SqliteComfyBatchStateStore(batchPath)
    batchStore.close()
    const database = new DatabaseSync(batchPath)
    try {
      database
        .prepare(
          `INSERT INTO comfy_batch_states(batch_id, source_root, updated_at, state_json)
           VALUES (?, ?, ?, ?)`
        )
        .run(rowId, '/source', '2025-01-01T00:00:00.000Z', stateJson)
    } finally {
      database.close()
    }

    await expect(runWorker(userDataRoot, 'batch-first')).rejects.toThrow(expected)
  })

  it('fails closed in a child process on an altered authoritative route index', async () => {
    const userDataRoot = await makeTemporaryRoot('magicpot-comfy-sqlite-altered-index-')
    const batchPath = comfyBatchStateDatabasePath(userDataRoot)
    const routeStore = new SqliteComfyOutputRouteStore(batchPath)
    routeStore.close()
    const database = new DatabaseSync(batchPath)
    try {
      database.exec(`
        DROP INDEX comfy_output_routes_endpoint_uidx;
        CREATE UNIQUE INDEX comfy_output_routes_endpoint_uidx
          ON comfy_output_routes(instance_id, origin);
      `)
    } finally {
      database.close()
    }

    await expect(runWorker(userDataRoot, 'route-first', 'open-only')).rejects.toThrow(
      'altered endpoint index schema'
    )
  })

  it('fails closed on both foreign identities without overwriting sentinel data', async () => {
    const root = await makeTemporaryRoot('magicpot-comfy-sqlite-foreign-')
    const foreignBatchPath = comfyBatchStateDatabasePath(path.join(root, 'batch-target'))
    const foreignInstancePath = comfyInstanceStoreDatabasePath(path.join(root, 'instance-target'))

    const batchSentinel = seedForeignDatabase(
      foreignBatchPath,
      EVENT_STORE_APPLICATION_ID,
      EVENT_STORE_SCHEMA_VERSION,
      'preserve-for-batch-store'
    )
    const instanceSentinel = seedForeignDatabase(
      foreignInstancePath,
      BATCH_APPLICATION_ID,
      BATCH_SCHEMA_VERSION,
      'preserve-for-instance-store'
    )

    expect(() => new SqliteComfyBatchStateStore(foreignBatchPath)).toThrow(
      'belongs to a different application'
    )
    expect(inspectDatabase(foreignBatchPath, true)).toEqual(batchSentinel)
    expect(batchSentinel.tables).toEqual(['durability_sentinel'])
    expect(batchSentinel.indexes).toEqual([])

    expect(() => new MagicAgentEventStore(foreignInstancePath)).toThrow(
      /Unsupported Event Store identity/u
    )
    expect(inspectDatabase(foreignInstancePath, true)).toEqual(instanceSentinel)
    expect(instanceSentinel.tables).toEqual(['durability_sentinel'])
    expect(instanceSentinel.indexes).toEqual([])
  })
})
