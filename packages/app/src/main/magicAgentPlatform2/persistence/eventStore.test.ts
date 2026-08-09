import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))

import type { MagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import {
  CorruptEventStoreError,
  EventStoreClosedError,
  EventStoreConflictError,
  MagicAgentEventStore,
  UnsupportedEventStoreError
} from './eventStore'
import {
  EVENT_STORE_APPLICATION_ID,
  EVENT_STORE_SCHEMA_VERSION,
  EventStoreOpenError,
  getNodeSQLiteCapability
} from './sqliteAdapter'

const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const nodeFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const os = await vi.importActual<typeof import('node:os')>('node:os')

const stores: MagicAgentEventStore[] = []
let directory: string
let databasePath: string

function event(
  sequence: number,
  overrides: Partial<MagicAgentEvent<unknown>> & { idempotencyKey?: string } = {}
): MagicAgentEvent<unknown> {
  return {
    protocolVersion: '2.0.0',
    envelopeKind: 'event',
    id: `event-${sequence}`,
    streamId: 'stream-a',
    sequence,
    type: 'test.event',
    createdAt: 1000 + sequence,
    payload: { z: sequence, a: true },
    ...overrides
  }
}

function open(path = databasePath): MagicAgentEventStore {
  const store = new MagicAgentEventStore(path)
  stores.push(store)
  return store
}

beforeEach(async () => {
  directory = await fs.mkdtemp(join(os.tmpdir(), 'magic-agent-event-store-'))
  databasePath = join(directory, 'nested', 'events.sqlite')
})

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('MagicAgentEventStore', () => {
  it('closes and reopens the same file-backed store', () => {
    const first = open()
    first.close()
    const second = open()
    expect(second.getStorageInfo().path).toBe(databasePath)
  })
  it('reports capability and initializes the real-file STRICT WAL schema and pragmas', () => {
    expect(getNodeSQLiteCapability()).toMatchObject({ available: true })
    const store = open()
    expect(store.getStorageInfo()).toMatchObject({
      schemaVersion: EVENT_STORE_SCHEMA_VERSION,
      journalMode: 'wal',
      path: databasePath
    })

    const db = new DatabaseSync(databasePath)
    expect(db.prepare('PRAGMA application_id').get()).toEqual({
      application_id: EVENT_STORE_APPLICATION_ID
    })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({
      user_version: EVENT_STORE_SCHEMA_VERSION
    })
    expect(db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'events'").get()).toEqual({
      strict: 1
    })
    expect(
      db.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get()
    ).toEqual({ value: String(EVENT_STORE_SCHEMA_VERSION) })
    db.close()
  })

  it('appends, reads, sorts, limits, checkpoints, and survives reopen', () => {
    const store = open()
    expect(store.appendBatch([event(2), event(0), event(1)])).toEqual([
      { eventId: 'event-2', streamId: 'stream-a', sequence: 2, inserted: true },
      { eventId: 'event-0', streamId: 'stream-a', sequence: 0, inserted: true },
      { eventId: 'event-1', streamId: 'stream-a', sequence: 1, inserted: true }
    ])
    expect(
      store.readStream('stream-a', { afterSequence: 0, limit: 1 }).map((item) => item.sequence)
    ).toEqual([1])
    expect(store.getEvent('event-2')?.payload).toEqual({ a: true, z: 2 })
    expect(store.getLastSequence('stream-a')).toBe(2)
    expect(store.countEvents()).toBe(3)
    expect(store.checkpoint('PASSIVE')).toMatchObject({ busy: 0 })
    store.close()

    const reopened = open()
    expect(reopened.readStream('stream-a').map((item) => item.sequence)).toEqual([0, 1, 2])
    expect(reopened.countEvents()).toBe(3)
  })

  it('supports exact/canonical replay and batch-local replay without duplicate rows', () => {
    const store = open()
    expect(store.appendBatch([event(0)])[0].inserted).toBe(true)
    expect(store.appendBatch([event(0, { payload: { a: true, z: 0 } })])[0].inserted).toBe(false)
    const duplicate = event(1)
    expect(store.appendBatch([duplicate, duplicate]).map((result) => result.inserted)).toEqual([
      true,
      false
    ])
    expect(store.countEvents()).toBe(2)
  })

  it('rejects event id, idempotency, and stream sequence conflicts and rolls back the batch', () => {
    const store = open()
    store.appendBatch([event(0, { idempotencyKey: 'key-0' })])
    expect(() => store.appendBatch([event(1, { id: 'event-0' })])).toThrow(EventStoreConflictError)
    expect(() => store.appendBatch([event(1, { idempotencyKey: 'key-0' })])).toThrow(
      /idempotencyKey/
    )
    expect(() => store.appendBatch([event(0, { id: 'other' })])).toThrow(/stream sequence/)
    expect(() => store.appendBatch([event(1), event(1, { id: 'other-1' })])).toThrow(
      EventStoreConflictError
    )
    expect(store.countEvents()).toBe(1)
  })

  it('returns immediately for an empty batch and has stable close behavior', () => {
    const store = open()
    expect(store.appendBatch([])).toEqual([])
    store.close()
    store.close()
    expect(() => store.countEvents()).toThrow(EventStoreClosedError)
  })

  it('detects corrupt stored JSON', () => {
    const store = open()
    store.appendBatch([event(0)])
    store.close()
    const db = new DatabaseSync(databasePath)
    db.prepare("UPDATE events SET payload_json = '{'").run()
    db.close()
    const reopened = open()
    expect(() => reopened.getEvent('event-0')).toThrow(CorruptEventStoreError)
  })

  it('rejects unsupported identifiers before modifying schema', async () => {
    const foreignPath = join(directory, 'foreign.sqlite')
    const db = new DatabaseSync(foreignPath)
    db.exec(
      'PRAGMA application_id = 123; PRAGMA user_version = 9; CREATE TABLE sentinel(value TEXT)'
    )
    db.close()
    expect(() => open(foreignPath)).toThrow(UnsupportedEventStoreError)
    const check = new DatabaseSync(foreignPath)
    expect(
      check.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get()
    ).toBeUndefined()
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'sentinel'").get()).toEqual({
      name: 'sentinel'
    })
    check.close()
  })

  it('does not modify an unidentified non-empty SQLite database', () => {
    const path = join(directory, 'ordinary.sqlite')
    const db = new DatabaseSync(path)
    db.exec(
      'PRAGMA journal_mode = DELETE; CREATE TABLE sentinel(value TEXT); CREATE INDEX sentinel_idx ON sentinel(value)'
    )
    const before = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
      )
      .all()
    db.close()
    expect(() => open(path)).toThrow(UnsupportedEventStoreError)
    const check = new DatabaseSync(path)
    expect(check.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    expect(check.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0 })
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    expect(
      check
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        )
        .all()
    ).toEqual(before)
    check.close()
  })

  it('round-trips protocol 2.1 and unknown top-level fields with canonical replay', () => {
    const store = open()
    const input = event(0, { protocolVersion: '2.1.0' }) as MagicAgentEvent<unknown> &
      Record<string, unknown>
    input.idempotencyKey = 'key-21'
    input.futureField = { z: 1, a: 2 }
    expect(store.appendBatch([input])[0].inserted).toBe(true)
    expect(store.getEvent(input.id)).toEqual(input)
    const reordered = { futureField: { a: 2, z: 1 }, ...input } as MagicAgentEvent<unknown>
    expect(store.appendBatch([reordered])[0].inserted).toBe(false)
  })

  it('detects envelope/indexed-column inconsistency', () => {
    const store = open()
    store.appendBatch([event(0)])
    store.close()
    const db = new DatabaseSync(databasePath)
    db.prepare("UPDATE events SET protocol_version = '2.1.0'").run()
    db.close()
    expect(() => open().getEvent('event-0')).toThrow(CorruptEventStoreError)
  })

  it('rejects missing indexes, forged schemas, bad metadata, and non-STRICT tables', () => {
    let store = open()
    store.close()
    let db = new DatabaseSync(databasePath)
    db.exec('DROP INDEX events_idempotency_key_unique')
    db.close()
    expect(() => open()).toThrow(CorruptEventStoreError)

    const forged = join(directory, 'forged.sqlite')
    db = new DatabaseSync(forged)
    db.exec(`CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL) STRICT;
      INSERT INTO schema_metadata VALUES ('schema_version', '1', 1), ('created_at', '1', 1);
      PRAGMA application_id = ${EVENT_STORE_APPLICATION_ID}; PRAGMA user_version = ${EVENT_STORE_SCHEMA_VERSION};`)
    db.close()
    expect(() => open(forged)).toThrow(CorruptEventStoreError)

    const badMetadata = join(directory, 'bad-metadata.sqlite')
    store = open(badMetadata)
    store.close()
    db = new DatabaseSync(badMetadata)
    db.prepare("UPDATE schema_metadata SET value = 'bad' WHERE key = 'created_at'").run()
    db.close()
    expect(() => open(badMetadata)).toThrow(CorruptEventStoreError)

    const lax = join(directory, 'lax.sqlite')
    store = open(lax)
    store.close()
    db = new DatabaseSync(lax)
    db.exec(
      'ALTER TABLE events RENAME TO old_events; CREATE TABLE events AS SELECT * FROM old_events; DROP TABLE old_events'
    )
    db.close()
    expect(() => open(lax)).toThrow(CorruptEventStoreError)
  })

  it('rejects a weakened idempotency partial predicate', () => {
    const store = open()
    store.close()
    const db = new DatabaseSync(databasePath)
    db.exec(`DROP INDEX events_idempotency_key_unique;
      CREATE UNIQUE INDEX events_idempotency_key_unique ON events(idempotency_key)
      WHERE idempotency_key IS NOT NULL OR 1 = 1`)
    db.close()
    expect(() => open()).toThrow(CorruptEventStoreError)
  })

  it('rejects forged v1 table SQL without the required CHECK semantics', () => {
    const store = open()
    store.close()
    const db = new DatabaseSync(databasePath)
    db.exec('PRAGMA writable_schema = ON')
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
      .get() as {
      sql: string
    }
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'events'").run(
      sql.sql.replace('CHECK(length(trim(event_id)) > 0)', 'CHECK(1)')
    )
    db.exec('PRAGMA writable_schema = OFF')
    db.close()
    expect(() => open()).toThrow(CorruptEventStoreError)
  })

  it('rejects comment-based CHECK forgery and every omitted event CHECK', () => {
    const replacements: Array<[string, string]> = [
      [
        'CHECK(correlation_id IS NULL OR length(trim(correlation_id)) > 0)',
        '/* CHECK(correlation_id IS NULL OR length(trim(correlation_id)) > 0) */ CHECK(1)'
      ],
      ['CHECK(length(trim(payload_json)) > 0)', 'CHECK(1)'],
      ['CHECK(length(trim(envelope_json)) > 0)', 'CHECK(1)'],
      [
        'CHECK(inserted_at = inserted_at AND abs(inserted_at) <= 1.7976931348623157e308)',
        'CHECK(1)'
      ]
    ]
    for (const [index, [original, replacement]] of replacements.entries()) {
      const path = join(directory, `weakened-${index}.sqlite`)
      const store = open(path)
      store.close()
      const db = new DatabaseSync(path)
      db.exec('PRAGMA writable_schema = ON')
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .get() as { sql: string }
      db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'events'").run(
        row.sql.replace(original, replacement)
      )
      db.exec('PRAGMA writable_schema = OFF')
      db.close()
      expect(() => open(path)).toThrow()
    }
  })

  it('rejects a NOCASE idempotency index', () => {
    const store = open()
    store.close()
    const db = new DatabaseSync(databasePath)
    db.exec(`DROP INDEX events_idempotency_key_unique;
      CREATE UNIQUE INDEX events_idempotency_key_unique
      ON events(idempotency_key COLLATE NOCASE) WHERE idempotency_key IS NOT NULL`)
    db.close()
    expect(() => open()).toThrow(CorruptEventStoreError)
  })

  it('rejects a descending stream index', () => {
    const store = open()
    store.close()
    const db = new DatabaseSync(databasePath)
    db.exec(`DROP INDEX events_stream_sequence_idx;
      CREATE INDEX events_stream_sequence_idx ON events(stream_id DESC, sequence)`)
    db.close()
    expect(() => open()).toThrow(CorruptEventStoreError)
  })

  it('uses the same real main-file path reported by database_list', async () => {
    const store = open()
    store.close()
    const db = new DatabaseSync(databasePath)
    const main = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get() as {
      file: string
    }
    db.close()
    expect(await fs.realpath(main.file)).toBe(await fs.realpath(databasePath))
  })

  it('initializes an existing zero-byte regular file', async () => {
    const path = join(directory, 'zero.sqlite')
    await fs.writeFile(path, '')
    const store = open(path)
    expect(store.getStorageInfo()).toMatchObject({
      schemaVersion: EVENT_STORE_SCHEMA_VERSION,
      journalMode: 'wal'
    })
  })

  it('uses stable non-zero bigint identity for the database file', () => {
    open()
    const stat = nodeFs.statSync(databasePath, { bigint: true })
    expect(stat.dev).not.toBe(0n)
    expect(stat.ino).not.toBe(0n)
  })

  it('rejects symbolic-link database paths', async (context) => {
    const target = join(directory, 'target.sqlite')
    const link = join(directory, 'link.sqlite')
    const db = new DatabaseSync(target)
    db.close()
    try {
      await fs.symlink(target, link, 'file')
    } catch (error) {
      if (process.platform === 'win32') {
        context.skip()
        return
      }
      throw error
    }
    expect(() => open(link)).toThrow(EventStoreOpenError)
  })

  it('rejects an AFTER INSERT trigger that can delete events', () => {
    const store = open()
    store.close()
    const db = new DatabaseSync(databasePath)
    db.exec(`CREATE TRIGGER delete_inserted_event AFTER INSERT ON events
      BEGIN DELETE FROM events WHERE event_id = NEW.event_id; END`)
    db.close()
    expect(() => open()).toThrow(CorruptEventStoreError)
  })

  it.each([
    ['view', 'CREATE VIEW unexpected_view AS SELECT event_id FROM events'],
    ['table', 'CREATE TABLE unexpected_table(value TEXT)'],
    ['index', 'CREATE INDEX unexpected_index ON events(type)']
  ])('rejects an extra schema %s', (_kind, sql) => {
    const path = join(directory, `extra-${_kind}.sqlite`)
    const store = open(path)
    store.close()
    const db = new DatabaseSync(path)
    db.exec(sql)
    db.close()
    expect(() => open(path)).toThrow(CorruptEventStoreError)
  })

  it.each([
    ['index', 'sqlite_evil_extra'],
    ['trigger', 'sqlite_evil_trigger']
  ])('rejects an extra malicious sqlite_%% %s object', (type, name) => {
    const path = join(directory, `malicious-${type}.sqlite`)
    const store = open(path)
    store.close()
    const db = new DatabaseSync(path)
    db.exec('PRAGMA writable_schema = ON')
    db.prepare(
      'INSERT INTO sqlite_master(type, name, tbl_name, rootpage, sql) VALUES (?, ?, ?, 0, NULL)'
    ).run(type, name, 'events')
    expect(
      db.prepare('SELECT type, name FROM sqlite_master WHERE type = ? AND name = ?').get(type, name)
    ).toEqual({ type, name })
    db.exec('PRAGMA schema_version = 101; PRAGMA writable_schema = OFF')
    db.close()
    expect(() => open(path)).toThrow()
  })

  it('rejects an unidentified empty database with a forged sqlite_ object without changing identity', () => {
    const path = join(directory, 'empty-malicious.sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA writable_schema = ON')
    db.prepare(
      "INSERT INTO sqlite_master(type, name, tbl_name, rootpage, sql) VALUES ('index', 'sqlite_evil_extra', 'ghost', 0, NULL)"
    ).run()
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_evil_extra'").get()
    ).toEqual({
      name: 'sqlite_evil_extra'
    })
    db.exec('PRAGMA schema_version = 101; PRAGMA writable_schema = OFF')
    db.close()

    expect(() => open(path)).toThrow()
    const check = new DatabaseSync(path)
    check.exec('PRAGMA writable_schema = ON')
    check.prepare("DELETE FROM sqlite_master WHERE name = 'sqlite_evil_extra'").run()
    check.exec('PRAGMA schema_version = 102; PRAGMA writable_schema = OFF')
    expect(check.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    expect(check.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0 })
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    check.close()
  })

  it('rejects a new database path whose parent chain contains a symbolic link', async (context) => {
    const realParent = join(directory, 'real-parent')
    const linkedParent = join(directory, 'linked-parent')
    await fs.mkdir(realParent)
    try {
      await fs.symlink(realParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (process.platform === 'win32') {
        context.skip()
        return
      }
      throw error
    }
    expect(() => open(join(linkedParent, 'new.sqlite'))).toThrow(EventStoreOpenError)
  })

  it('rejects non-JSON-safe payloads without inserting rows', () => {
    const store = open()
    const nonEnumerable = { visible: true }
    Object.defineProperty(nonEnumerable, 'hidden', { value: true })
    const sparse = new Array(2)
    sparse[1] = true
    const symbolKey = { ok: true } as Record<PropertyKey, unknown>
    symbolKey[Symbol('secret')] = true
    for (const payload of [
      nonEnumerable,
      sparse,
      symbolKey,
      { value: undefined },
      { value: 1n },
      { value: Number.NaN }
    ]) {
      expect(() => store.appendBatch([event(0, { payload })])).toThrow(TypeError)
      expect(store.countEvents()).toBe(0)
    }
  })

  it('allows shared references but rejects cycles and proxies', () => {
    const store = open()
    const shared = { value: 1 }
    store.appendBatch([event(0, { payload: { left: shared, right: shared } })])
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => store.appendBatch([event(1, { payload: cycle })])).toThrow(TypeError)
    expect(() => store.appendBatch([event(1, { payload: new Proxy({}, {}) })])).toThrow(TypeError)
    expect(store.countEvents()).toBe(1)
  })

  it('caps batches and rolls back batch-local idempotency conflicts', () => {
    const store = open()
    expect(() =>
      store.appendBatch(Array.from({ length: 1001 }, (_, index) => event(index)))
    ).toThrow(RangeError)
    expect(() =>
      store.appendBatch([
        event(0, { idempotencyKey: 'same' }),
        event(1, { idempotencyKey: 'same' })
      ])
    ).toThrow(EventStoreConflictError)
    expect(store.countEvents()).toBe(0)
  })

  it('validates query inputs, timeout, and checkpoint modes', () => {
    expect(() => new MagicAgentEventStore(databasePath, { timeout: -1 })).toThrow(RangeError)
    const store = open()
    expect(() => store.getEvent(' ')).toThrow(TypeError)
    expect(() => store.getLastSequence('')).toThrow(TypeError)
    expect(() => store.readStream('stream-a', { afterSequence: -2 })).toThrow(RangeError)
    expect(() => store.readStream('stream-a', { limit: 0 })).toThrow(RangeError)
    expect(() => store.checkpoint('BAD' as 'FULL')).toThrow(TypeError)
  })

  it('supports FULL and TRUNCATE checkpoints', () => {
    const store = open()
    store.appendBatch([event(0)])
    expect(store.checkpoint('FULL')).toMatchObject({ busy: 0 })
    expect(store.checkpoint('TRUNCATE')).toMatchObject({ busy: 0, log: 0, checkpointed: 0 })
  })

  it('reports stable closed errors for every public operation', () => {
    const store = open()
    store.close()
    for (const operation of [
      () => store.appendBatch([]),
      () => store.readStream('stream-a'),
      () => store.getEvent('event-0'),
      () => store.getLastSequence('stream-a'),
      () => store.countEvents(),
      () => store.getStorageInfo(),
      () => store.checkpoint('PASSIVE')
    ])
      expect(operation).toThrow(EventStoreClosedError)
  })

  it('wraps ordinary open failures', async () => {
    const path = join(directory, 'is-a-directory')
    await fs.mkdir(path)
    expect(() => new MagicAgentEventStore(path)).toThrow(EventStoreOpenError)
  })
})
