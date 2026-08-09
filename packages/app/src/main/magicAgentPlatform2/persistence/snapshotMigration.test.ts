import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)
import type { MagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import {
  CorruptEventStoreError,
  MagicAgentEventStore,
  RecoveryBundleError,
  RecoverySnapshotDecodeError,
  RecoveryStateValidationError,
  canonicalJson,
  restoreWithReducer,
  type RecoveryBundle,
  type StoredSnapshot
} from './eventStore'
import {
  CREATED_AT_INDEX_DDL,
  EVENTS_DDL,
  IDEMPOTENCY_INDEX_DDL,
  SCHEMA_METADATA_DDL,
  SNAPSHOTS_DDL,
  SNAPSHOT_COVERED_INDEX_DDL,
  SNAPSHOT_VERSION_INDEX_DDL,
  STREAM_INDEX_DDL
} from './schema'
import { EVENT_STORE_APPLICATION_ID } from './sqliteAdapter'

type V1Options = Readonly<{ omitIndex?: string; extraTrigger?: boolean }>
type MetadataRow = Readonly<{ key: string; value: string }>

let directory = ''
let path = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'magic-agent-snapshot-migration-'))
  path = join(directory, 'events.sqlite')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const event = (sequence: number, streamId = 'stream-a'): MagicAgentEvent<unknown> => ({
  protocolVersion: '2.0.0',
  envelopeKind: 'event',
  id: `${streamId}-event-${sequence}`,
  streamId,
  sequence,
  type: 'test.event',
  createdAt: 1000 + sequence,
  payload: { nested: { sequence }, ok: true }
})

function createV1Db(databasePath: string, options: V1Options = {}): void {
  const db = new DatabaseSync(databasePath)
  const indexes = [IDEMPOTENCY_INDEX_DDL, STREAM_INDEX_DDL, CREATED_AT_INDEX_DDL].filter(
    (ddl) => !ddl.includes(options.omitIndex ?? '\u0000')
  )
  db.exec(`${SCHEMA_METADATA_DDL}; ${EVENTS_DDL}; ${indexes.join('; ')};`)
  db.exec(`PRAGMA application_id = ${EVENT_STORE_APPLICATION_ID}; PRAGMA user_version = 1;`)
  const createdAt = 123456
  const insertMetadata = db.prepare(
    'INSERT INTO schema_metadata (key, value, updated_at) VALUES (?, ?, ?)'
  )
  insertMetadata.run('schema_version', '1', createdAt)
  insertMetadata.run('created_at', String(createdAt), createdAt)
  const insertEvent = db.prepare(`INSERT INTO events (
    event_id, protocol_version, stream_id, sequence, type, created_at, correlation_id,
    causation_id, idempotency_key, payload_json, envelope_json, inserted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const value of [event(0), event(1)]) {
    insertEvent.run(
      value.id,
      value.protocolVersion,
      value.streamId,
      value.sequence,
      value.type,
      value.createdAt,
      null,
      null,
      null,
      canonicalJson(value.payload),
      canonicalJson(value),
      createdAt + value.sequence
    )
  }
  if (options.extraTrigger)
    db.exec('CREATE TRIGGER events_extra AFTER INSERT ON events BEGIN SELECT 1; END')
  db.close()
}

function inspect(): DatabaseSync {
  return new DatabaseSync(path)
}

function expectOpenCorrupt(databasePath: string): void {
  let store: MagicAgentEventStore
  try {
    store = new MagicAgentEventStore(databasePath)
  } catch (error) {
    expect(error).toBeInstanceOf(CorruptEventStoreError)
    return
  }
  store.close()
  throw new Error('Expected opening the Event Store to report corruption.')
}

function createV2WithSnapshot(): void {
  const store = new MagicAgentEventStore(path)
  store.appendBatch([event(0), event(1)])
  store.appendSnapshot({
    snapshotId: 'snapshot-1',
    streamId: 'stream-a',
    snapshotVersion: 1,
    coveredSequence: 0,
    stateType: 'counter',
    state: { count: 1 },
    metadata: { source: 'test' },
    createdAt: 2000
  })
  store.close()
}

function normalBundle(): RecoveryBundle {
  return {
    snapshot: null,
    events: [event(0)]
  }
}

function forgedSnapshot(overrides: Record<string, unknown> = {}): StoredSnapshot {
  return {
    snapshotId: 'snapshot-1',
    streamId: 'stream-a',
    snapshotVersion: 1,
    coveredSequence: 0,
    stateType: 'counter',
    state: { count: 1 },
    createdAt: 2000,
    insertedAt: 2001,
    ...overrides
  } as unknown as StoredSnapshot
}

describe('snapshot schema migration', () => {
  it('migrates a real v1 database through v2 to v3 without losing events or created_at', () => {
    createV1Db(path)
    const store = new MagicAgentEventStore(path)
    expect(store.readStream('stream-a')).toEqual([event(0), event(1)])
    expect(store.countEvents()).toBe(2)
    expect(store.getStorageInfo().schemaVersion).toBe(3)
    store.close()

    const db = inspect()
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 })
    const metadata = db
      .prepare('SELECT key, value FROM schema_metadata ORDER BY key')
      .all() as MetadataRow[]
    expect(metadata.find((row) => row.key === 'created_at')?.value).toBe('123456')
    expect(metadata.find((row) => row.key === 'schema_version')?.value).toBe('3')
    expect(
      Number(metadata.find((row) => row.key === 'migrated_to_v3_at')?.value)
    ).toBeGreaterThanOrEqual(Number(metadata.find((row) => row.key === 'migrated_at')?.value))
    expect(Number(metadata.find((row) => row.key === 'migrated_at')?.value)).toBeGreaterThanOrEqual(
      123456
    )
    const tableSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'")
      .get()?.sql
    expect(tableSql).toEqual(SNAPSHOTS_DDL)
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'snapshots_%_idx'")
        .get()
    ).toMatchObject({ count: 2 })
    db.close()

    const reopened = new MagicAgentEventStore(path)
    expect(reopened.countEvents()).toBe(2)
    expect(reopened.countSnapshots()).toBe(0)
    reopened.close()
  })

  it('rolls back migration when a v1 named index is missing', () => {
    createV1Db(path, { omitIndex: 'events_created_at_idx' })
    expectOpenCorrupt(path)
    const db = inspect()
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'snapshots'").get()
    ).toMatchObject({ count: 0 })
    expect(
      db.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get()
    ).toMatchObject({ value: '1' })
    db.close()
  })

  it('rolls back migration when a v1 trigger is present', () => {
    createV1Db(path, { extraTrigger: true })
    expectOpenCorrupt(path)
    const db = inspect()
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'snapshots'").get()
    ).toMatchObject({ count: 0 })
    db.close()
  })

  it('rejects a v2 database missing the snapshot coverage index', () => {
    createV2WithSnapshot()
    const db = inspect()
    db.exec('DROP INDEX snapshots_stream_covered_idx')
    db.close()
    expectOpenCorrupt(path)
  })

  it('rejects an ASC snapshot version index', () => {
    createV2WithSnapshot()
    const db = inspect()
    db.exec(
      'DROP INDEX snapshots_stream_version_idx; CREATE INDEX snapshots_stream_version_idx ON snapshots(stream_id, snapshot_version)'
    )
    db.close()
    expectOpenCorrupt(path)
  })

  it('rejects a NOCASE snapshot coverage index', () => {
    createV2WithSnapshot()
    const db = inspect()
    db.exec(
      'DROP INDEX snapshots_stream_covered_idx; CREATE INDEX snapshots_stream_covered_idx ON snapshots(stream_id COLLATE NOCASE, covered_sequence)'
    )
    db.close()
    expectOpenCorrupt(path)
  })

  it.each([
    ['CHECK', SNAPSHOTS_DDL.replace(' CHECK(length(trim(snapshot_id)) > 0)', '')],
    ['STRICT', SNAPSHOTS_DDL.replace(/ STRICT$/, '')]
  ])('rejects snapshot table SQL with missing %s semantics', (_label, forgedSql) => {
    createV2WithSnapshot()
    const db = inspect()
    db.exec('PRAGMA writable_schema = ON')
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'snapshots'").run(
      forgedSql
    )
    db.exec('PRAGMA writable_schema = OFF; PRAGMA schema_version = 99')
    db.close()
    expectOpenCorrupt(path)
  })

  it.each(['-1', 'not-a-number'])('rejects invalid migrated_at metadata %s', (value) => {
    createV1Db(path)
    const migrated = new MagicAgentEventStore(path)
    migrated.close()
    const db = inspect()
    db.prepare("UPDATE schema_metadata SET value = ? WHERE key = 'migrated_at'").run(value)
    db.close()
    expectOpenCorrupt(path)
  })
})

describe('snapshot row corruption', () => {
  it.each([
    ['state_json', '{invalid'],
    ['metadata_json', '{invalid']
  ])('detects corrupt %s through get and recovery', (column, value) => {
    createV2WithSnapshot()
    const db = inspect()
    db.exec(`UPDATE snapshots SET ${column} = '${value}'`)
    db.close()
    const store = new MagicAgentEventStore(path)
    expect(() => store.getSnapshot('snapshot-1')).toThrow(CorruptEventStoreError)
    expect(() => store.recoverStream('stream-a')).toThrow(CorruptEventStoreError)
    store.close()
  })
})

describe('restore bundle hardening', () => {
  it('rejects a snapshot whose tail event belongs to another stream', () => {
    const bundle = { snapshot: forgedSnapshot(), events: [event(1, 'other')] }
    expect(() =>
      restoreWithReducer(
        bundle,
        0,
        (state) => state,
        () => 1
      )
    ).toThrow(RecoveryBundleError)
  })

  it.each([
    { snapshotId: '' },
    { streamId: '' },
    { snapshotVersion: -1 },
    { coveredSequence: -2 },
    { createdAt: -1 },
    { insertedAt: Number.NaN },
    { state: new Map([['unsafe', true]]) }
  ])('rejects forged snapshot fields %#', (overrides) => {
    const bundle = { snapshot: forgedSnapshot(overrides), events: [] } as unknown as RecoveryBundle
    expect(() =>
      restoreWithReducer(
        bundle,
        0,
        (state) => state,
        () => 1
      )
    ).toThrow(RecoveryBundleError)
  })

  it.each([
    () => new Map([['unsafe', true]]),
    () => new Set(['unsafe']),
    () => {
      const value: { self?: unknown } = {}
      value.self = value
      return value
    }
  ])('rejects JSON-unsafe decoder output', (decode) => {
    const bundle = { snapshot: forgedSnapshot(), events: [] }
    expect(() => restoreWithReducer<unknown>(bundle, 0, (state) => state, decode)).toThrow(
      RecoveryStateValidationError
    )
  })

  it.each([undefined, () => 1, new Map([['unsafe', true]])])(
    'rejects JSON-unsafe reducer output %#',
    (output) => {
      expect(() => restoreWithReducer<unknown>(normalBundle(), 0, () => output)).toThrow(
        RecoveryStateValidationError
      )
    }
  )

  it('detaches and deeply freezes the initial state', () => {
    const original = { nested: { count: 1 } }
    const result = restoreWithReducer({ snapshot: null, events: [] }, original, (state) => state)
    original.nested.count = 9
    expect(result.state).toEqual({ nested: { count: 1 } })
    expect(result.state).not.toBe(original)
    expect(Object.isFrozen(result.state)).toBe(true)
    expect(Object.isFrozen(result.state.nested)).toBe(true)
  })

  it('fully freezes descendants below a pre-frozen initial root', () => {
    const nested = { count: 1 }
    const original = Object.freeze({ nested })
    const result = restoreWithReducer({ snapshot: null, events: [] }, original, (state) => state)
    expect(Object.isFrozen(result.state)).toBe(true)
    expect(Object.isFrozen(result.state.nested)).toBe(true)
    expect(result.state.nested).not.toBe(nested)
  })

  it('wraps a decoder throw with its original cause', () => {
    const cause = new Error('decoder failed')
    const bundle = { snapshot: forgedSnapshot(), events: [] }
    try {
      restoreWithReducer<number>(
        bundle,
        0,
        (state) => state,
        () => {
          throw cause
        }
      )
      throw new Error('expected decoder failure')
    } catch (error) {
      expect(error).toBeInstanceOf(RecoverySnapshotDecodeError)
      expect((error as Error).cause).toBe(cause)
    }
  })
})
