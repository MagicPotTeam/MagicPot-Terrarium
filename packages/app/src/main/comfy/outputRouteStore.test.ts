import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
vi.mock('node:fs/promises', async (importActual) => importActual())

import { SqliteComfyBatchStateStore } from './batchStateStore'
import { SqliteComfyOutputRouteStore } from './outputRouteStore'

const APPLICATION_ID = 0x4d504243
const SCHEMA_VERSION = 1
const temporaryRoots: string[] = []

const makeDatabasePath = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'magicpot-output-route-'))
  temporaryRoots.push(root)
  return path.join(root, 'state.sqlite')
}

const mutateDatabase = (databasePath: string, sql: string): void => {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(sql)
  } finally {
    database.close()
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
})

describe('SqliteComfyOutputRouteStore', () => {
  it('persists an immutable opaque route across close and reopen', async () => {
    const databasePath = await makeDatabasePath()
    const first = new SqliteComfyOutputRouteStore(databasePath)
    const instance = {
      id: 'gpu-a',
      origin: 'https://captured.example/',
      kind: 'remote' as const
    }
    const captured = first.capture(instance)
    const concurrent = new SqliteComfyOutputRouteStore(databasePath)
    expect(concurrent.get(captured.routeId)).toEqual(captured)
    concurrent.close()
    instance.id = 'gpu-edited'
    instance.origin = 'https://replacement.example/'
    first.close()

    const reopened = new SqliteComfyOutputRouteStore(databasePath)
    try {
      expect(reopened.get(captured.routeId)).toEqual(captured)
      expect(reopened.get('route-forged')).toBeUndefined()
    } finally {
      reopened.close()
    }
  })

  it('deduplicates immutable routes by normalized endpoint across concurrent connections', async () => {
    const databasePath = await makeDatabasePath()
    const first = new SqliteComfyOutputRouteStore(databasePath)
    const second = new SqliteComfyOutputRouteStore(databasePath)
    const original = first.capture({
      id: 'gpu-a',
      origin: 'https://GPU.Example:443/',
      kind: 'remote'
    })
    const sameEndpoint = second.capture({
      id: 'gpu-a',
      origin: 'https://gpu.example',
      kind: 'remote'
    })
    const changedEndpoint = second.capture({
      id: 'gpu-a',
      origin: 'https://gpu-v2.example/',
      kind: 'remote'
    })

    expect(original.origin).toBe('https://gpu.example/')
    expect(sameEndpoint).toEqual(original)
    expect(changedEndpoint.routeId).not.toBe(original.routeId)
    expect(first.get(original.routeId)).toEqual(original)
    first.close()
    second.close()

    const reopened = new SqliteComfyOutputRouteStore(databasePath)
    expect(reopened.get(original.routeId)).toEqual(original)
    expect(reopened.get(changedEndpoint.routeId)).toEqual(changedEndpoint)
    reopened.close()
  })

  it('preserves legacy duplicate handles and deterministically reuses the oldest endpoint route', async () => {
    const databasePath = await makeDatabasePath()
    const seeded = new SqliteComfyOutputRouteStore(databasePath)
    seeded.close()
    mutateDatabase(
      databasePath,
      `DROP INDEX comfy_output_routes_endpoint_uidx;
       INSERT INTO comfy_output_routes(route_id, instance_id, origin, kind, created_at) VALUES
         ('route-00000000-0000-4000-8000-000000000002', 'gpu-legacy', 'https://legacy.example/', 'remote', 20),
         ('route-00000000-0000-4000-8000-000000000001', 'gpu-legacy', 'https://legacy.example/', 'remote', 10);`
    )

    const first = new SqliteComfyOutputRouteStore(databasePath)
    const second = new SqliteComfyOutputRouteStore(databasePath)
    expect(first.get('route-00000000-0000-4000-8000-000000000001')).toMatchObject({ createdAt: 10 })
    expect(first.get('route-00000000-0000-4000-8000-000000000002')).toMatchObject({ createdAt: 20 })
    const reused = first.capture({
      id: 'gpu-legacy',
      origin: 'https://legacy.example',
      kind: 'remote'
    })
    const concurrentlyReused = second.capture({
      id: 'gpu-legacy',
      origin: 'https://legacy.example/',
      kind: 'remote'
    })
    expect(reused.routeId).toBe('route-00000000-0000-4000-8000-000000000001')
    expect(concurrentlyReused).toEqual(reused)
    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM comfy_output_routes
           WHERE instance_id = 'gpu-legacy' AND origin = 'https://legacy.example/' AND kind = 'remote'`
        )
        .get()
    ).toEqual({ count: 2 })
    database.close()
    second.close()
    first.close()
  })

  it('fails closed on invalid capture identities', () => {
    const store = new SqliteComfyOutputRouteStore(':memory:')
    try {
      expect(() => store.capture({ id: '', origin: 'https://x.example/', kind: 'remote' })).toThrow(
        'instance id'
      )
      expect(() => store.capture({ id: 'gpu', origin: '', kind: 'remote' })).toThrow('origin')
      expect(() =>
        store.capture({ id: 'gpu', origin: 'https://x.example/', kind: 'forged' as never })
      ).toThrow('kind')
    } finally {
      store.close()
    }
  })

  it.each([
    [
      'unsafe local origin',
      'route-00000000-0000-4000-8000-000000000010',
      'gpu',
      'http://169.254.169.254/',
      'local',
      1
    ],
    [
      'unsafe remote literal',
      'route-00000000-0000-4000-8000-000000000011',
      'gpu',
      'http://127.0.0.1/',
      'remote',
      1
    ],
    [
      'noncanonical origin',
      'route-00000000-0000-4000-8000-000000000012',
      'gpu',
      'https://EXAMPLE.com/',
      'remote',
      1
    ],
    ['invalid route id', 'route-corrupt', 'gpu', 'https://example.com/', 'remote', 1],
    [
      'negative created time',
      'route-00000000-0000-4000-8000-000000000013',
      'gpu',
      'https://example.com/',
      'remote',
      -1
    ]
  ])('fails closed on a persisted %s', (_label, routeId, instanceId, origin, kind, createdAt) => {
    const store = new SqliteComfyOutputRouteStore(':memory:')
    const database = (store as unknown as { database: DatabaseSync }).database
    database
      .prepare(
        `INSERT INTO comfy_output_routes(route_id, instance_id, origin, kind, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(routeId, instanceId, origin, kind, createdAt)
    expect(() => store.get(routeId)).toThrow()
    store.close()
  })

  it('fails closed when an authoritative route row has an empty identity', () => {
    const store = new SqliteComfyOutputRouteStore(':memory:')
    const database = (store as unknown as { database: DatabaseSync }).database
    database
      .prepare(
        `INSERT INTO comfy_output_routes(route_id, instance_id, origin, kind, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('route-corrupt', '', 'https://x.example/', 'remote', 1)
    try {
      expect(() => store.get('route-corrupt')).toThrow('malformed row')
    } finally {
      store.close()
    }
  })

  it.each([
    {
      name: 'altered route table',
      seed: `
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${SCHEMA_VERSION};
        CREATE TABLE comfy_output_routes (
          route_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          kind TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          injected TEXT
        ) STRICT;
        CREATE INDEX comfy_output_routes_instance_id_idx ON comfy_output_routes(instance_id);`,
      expected: 'altered route table schema'
    },
    {
      name: 'missing route index',
      seed: `
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${SCHEMA_VERSION};
        CREATE TABLE comfy_output_routes (
          route_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX comfy_output_routes_endpoint_uidx
          ON comfy_output_routes(instance_id, origin, kind, created_at, route_id);`,
      expected: 'altered route index schema'
    },
    {
      name: 'altered route index',
      seed: `
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${SCHEMA_VERSION};
        CREATE TABLE comfy_output_routes (
          route_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX comfy_output_routes_instance_id_idx ON comfy_output_routes(origin);
        CREATE INDEX comfy_output_routes_endpoint_uidx
          ON comfy_output_routes(instance_id, origin, kind, created_at, route_id);`,
      expected: 'altered route index schema'
    },
    {
      name: 'altered endpoint unique index',
      seed: `
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${SCHEMA_VERSION};
        CREATE TABLE comfy_output_routes (
          route_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX comfy_output_routes_instance_id_idx ON comfy_output_routes(instance_id);
        CREATE INDEX comfy_output_routes_endpoint_uidx
          ON comfy_output_routes(instance_id, origin);`,
      expected: 'altered endpoint index schema'
    },
    {
      name: 'foreign identity',
      seed: `
        PRAGMA application_id = 12345;
        PRAGMA user_version = 7;
        CREATE TABLE foreign_data (id INTEGER) STRICT;`,
      expected: 'belongs to a different application'
    }
  ])('rejects $name without repairing it', async ({ seed, expected }) => {
    const databasePath = await makeDatabasePath()
    mutateDatabase(databasePath, seed)
    expect(() => new SqliteComfyOutputRouteStore(databasePath)).toThrow(expected)
  })

  it.each(['route-first', 'batch-first'] as const)(
    'opens the shared database in %s order without losing either schema',
    async (order) => {
      const databasePath = await makeDatabasePath()
      if (order === 'route-first') {
        const routeStore = new SqliteComfyOutputRouteStore(databasePath)
        routeStore.close()
        const batchStore = new SqliteComfyBatchStateStore(databasePath)
        batchStore.close()
      } else {
        const batchStore = new SqliteComfyBatchStateStore(databasePath)
        batchStore.close()
        const routeStore = new SqliteComfyOutputRouteStore(databasePath)
        routeStore.close()
      }
      const database = new DatabaseSync(databasePath, { readOnly: true })
      try {
        const names = database
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
             ORDER BY name ASC`
          )
          .all()
          .map((row) => (row as Record<string, unknown>).name)
        expect(names).toEqual([
          'comfy_batch_states',
          'comfy_batch_states_source_root_idx',
          'comfy_output_routes',
          'comfy_output_routes_endpoint_uidx',
          'comfy_output_routes_instance_id_idx'
        ])
      } finally {
        database.close()
      }
    }
  )
})
