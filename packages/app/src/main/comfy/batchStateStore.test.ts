import { afterEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ComfyBatchState } from '@shared/api/svcComfyBatch'
import { SqliteComfyBatchStateStore } from './batchStateStore'
import { SqliteComfyOutputRouteStore } from './outputRouteStore'
import { comfyBatchStateDatabasePath, comfyInstanceStoreDatabasePath } from './statePaths'

const makeState = (batchId: string, sourceRoot: string): ComfyBatchState => {
  const outputRoot = `${sourceRoot}.output`
  const metadataRoot = `${outputRoot}/.magicpot-batch`
  const now = '2025-01-01T00:00:00.000Z'
  return {
    batchId,
    status: 'running',
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
    target: { mode: 'auto' },
    workspace: {
      sourceRoot,
      workRoot: outputRoot,
      outputRoot,
      metadataRoot,
      stagingRoot: `${metadataRoot}/staging`,
      manifestPath: `${metadataRoot}/manifest.json`
    },
    manifest: {
      version: 1,
      sourceRoot,
      createdAt: now,
      updatedAt: now,
      items: []
    },
    items: [],
    createdAt: now,
    updatedAt: now,
    errorLogPath: `${metadataRoot}/errors.log`
  }
}

describe('SqliteComfyBatchStateStore', () => {
  it('atomically round-trips authoritative batch state', () => {
    const state = makeState('batch-1', '/source')
    const store = new SqliteComfyBatchStateStore(':memory:')
    store.save(state)
    expect(store.loadAll()).toEqual([state])
    store.close()
  })

  it('keeps batch and instance state in independent production paths', () => {
    const batchPath = comfyBatchStateDatabasePath('C:\\MagicPotUserData')
    const instancePath = comfyInstanceStoreDatabasePath('C:\\MagicPotUserData')
    expect(batchPath).not.toBe(instancePath)
    expect(path.basename(batchPath)).toBe('state.sqlite')
    expect(path.basename(instancePath)).toBe('instances.sqlite')
  })

  it.each(['batch-first', 'route-first'] as const)(
    'supports simultaneous %s connections against the shared state database',
    (order) => {
      const databaseUri = `file:magicpot-state-simultaneous-${order}?mode=memory&cache=shared`
      const state = makeState(`batch-${order}`, `C:\\MagicPotSource\\${order}`)
      let batchStore: SqliteComfyBatchStateStore
      let routeStore: SqliteComfyOutputRouteStore
      if (order === 'batch-first') {
        batchStore = new SqliteComfyBatchStateStore(databaseUri)
        routeStore = new SqliteComfyOutputRouteStore(databaseUri)
      } else {
        routeStore = new SqliteComfyOutputRouteStore(databaseUri)
        batchStore = new SqliteComfyBatchStateStore(databaseUri)
      }
      batchStore.save(state)
      const route = routeStore.capture({
        id: 'gpu-simultaneous',
        origin: 'https://simultaneous.example/',
        kind: 'remote'
      })
      expect(batchStore.loadAll()).toEqual([state])
      expect(routeStore.get(route.routeId)).toEqual(route)
      routeStore.close()
      batchStore.close()
    }
  )

  it('round-trips authoritative state across two connections to the same database', () => {
    const databaseUri = 'file:magicpot-batch-reopen?mode=memory&cache=shared'
    const state = makeState('batch-reopen', 'C:\\MagicPotSource')
    const store = new SqliteComfyBatchStateStore(databaseUri)
    store.save(state)
    const reopened = new SqliteComfyBatchStateStore(databaseUri)
    expect(reopened.loadAll()).toEqual([state])
    reopened.close()
    store.close()
  })

  it('rejects a foreign application identity without overwriting it', () => {
    const databaseUri = 'file:magicpot-foreign-state?mode=memory&cache=shared'
    const foreign = new DatabaseSync(databaseUri)
    foreign.exec(
      'PRAGMA application_id = 12345; PRAGMA user_version = 7; CREATE TABLE foreign_data (id INTEGER);'
    )

    expect(() => new SqliteComfyBatchStateStore(databaseUri)).toThrow(
      'belongs to a different application'
    )
    expect(foreign.prepare('PRAGMA application_id').get()).toMatchObject({ application_id: 12345 })
    expect(foreign.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 })
    expect(
      foreign.prepare("SELECT name FROM sqlite_schema WHERE name = 'foreign_data'").get()
    ).toMatchObject({ name: 'foreign_data' })
    foreign.close()
  })

  it.each([
    [
      'missing required batch table',
      'DROP TABLE comfy_batch_states',
      'missing its authoritative tables'
    ],
    [
      'missing required batch index',
      'DROP INDEX comfy_batch_states_source_root_idx',
      'altered batch index schema'
    ],
    [
      'altered required batch index',
      `DROP INDEX comfy_batch_states_source_root_idx;
       CREATE INDEX comfy_batch_states_source_root_idx ON comfy_batch_states(updated_at)`,
      'altered batch index schema'
    ]
  ])('fails closed for %s', (_label, corruptionSql, expectedMessage) => {
    const databaseUri = `file:batch-schema-${String(_label).replaceAll(' ', '-')}?mode=memory&cache=shared`
    const first = new SqliteComfyBatchStateStore(databaseUri)
    const corrupt = new DatabaseSync(databaseUri)
    corrupt.exec(corruptionSql)
    expect(() => new SqliteComfyBatchStateStore(databaseUri)).toThrow(expectedMessage)
    corrupt.close()
    first.close()
  })

  it('rejects instance primary tables in the state database without mutating them', () => {
    const databaseUri = 'file:batch-forbidden-instance-table?mode=memory&cache=shared'
    const first = new SqliteComfyBatchStateStore(databaseUri)
    const corrupt = new DatabaseSync(databaseUri)
    corrupt.exec(`CREATE TABLE resources (id TEXT); INSERT INTO resources VALUES ('sentinel')`)

    expect(() => new SqliteComfyBatchStateStore(databaseUri)).toThrow(
      'contains forbidden instance table: resources'
    )
    expect(corrupt.prepare('SELECT id FROM resources').get()).toEqual({ id: 'sentinel' })
    corrupt.close()
    first.close()
  })

  it('fails closed when an authoritative row contains invalid JSON', () => {
    const store = new SqliteComfyBatchStateStore(':memory:')
    const database = (store as unknown as { database: DatabaseSync }).database
    database
      .prepare(
        `INSERT INTO comfy_batch_states(batch_id, source_root, updated_at, state_json)
         VALUES (?, ?, ?, ?)`
      )
      .run('corrupt', '/source', '2025-01-01T00:00:00.000Z', '{not-json')
    expect(() => store.loadAll()).toThrow('invalid persisted JSON')
    store.close()
  })

  it('rejects an inconsistent persisted batch identity', () => {
    const store = new SqliteComfyBatchStateStore(':memory:')
    const database = (store as unknown as { database: DatabaseSync }).database
    database
      .prepare(
        `INSERT INTO comfy_batch_states(batch_id, source_root, updated_at, state_json)
         VALUES (?, ?, ?, ?)`
      )
      .run('row-id', '/source', '2025-01-01T00:00:00.000Z', JSON.stringify({ batchId: 'other' }))
    expect(() => store.loadAll()).toThrow('inconsistent persisted identity')
    store.close()
  })
})
