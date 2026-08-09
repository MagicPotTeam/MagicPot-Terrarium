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
  ResourceNotFoundError,
  ResourceRevisionConflictError,
  ResourceValidationError,
  type ResourceMutationInput
} from './eventStore'
import { EVENT_STORE_APPLICATION_ID, EVENT_STORE_SCHEMA_VERSION } from './sqliteAdapter'
import {
  CREATED_AT_INDEX_DDL,
  EVENTS_DDL,
  EVENT_STORE_V2_ADDITIONS_SQL,
  IDEMPOTENCY_INDEX_DDL,
  SCHEMA_METADATA_DDL,
  STREAM_INDEX_DDL
} from './schema'

const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const os = await vi.importActual<typeof import('node:os')>('node:os')

const stores: MagicAgentEventStore[] = []
let directory: string
let databasePath: string
let serial = 0

function event(
  sequence: number,
  overrides: Partial<MagicAgentEvent<unknown>> = {}
): MagicAgentEvent<unknown> {
  serial += 1
  return {
    protocolVersion: '2.0.0',
    envelopeKind: 'event',
    id: `resource-event-${serial}`,
    streamId: `resource-stream-${serial}`,
    sequence,
    type: 'resource.changed',
    createdAt: 1000 + serial,
    payload: { sequence },
    ...overrides
  }
}

function open(path = databasePath): MagicAgentEventStore {
  const store = new MagicAgentEventStore(path)
  stores.push(store)
  return store
}

function createInput(
  id = 'session-1',
  overrides: Partial<ResourceMutationInput> = {}
): ResourceMutationInput {
  return {
    operation: 'create',
    kind: 'session',
    id,
    idempotencyKey: `create-${id}`,
    state: { title: id, nested: { active: true } },
    createdAt: 100,
    event: event(0),
    ...overrides
  }
}

function updateInput(
  id: string,
  expectedRevision: number,
  overrides: Partial<ResourceMutationInput> = {}
): ResourceMutationInput {
  return {
    operation: 'update',
    kind: 'session',
    id,
    idempotencyKey: `update-${id}-${expectedRevision}-${serial}`,
    expectedRevision,
    state: { title: `${id}-updated`, nested: { active: false } },
    createdAt: 101 + expectedRevision,
    event: event(expectedRevision + 1),
    ...overrides
  }
}

function deleteInput(
  id: string,
  expectedRevision: number,
  overrides: Partial<ResourceMutationInput> = {}
): ResourceMutationInput {
  return {
    operation: 'delete',
    kind: 'session',
    id,
    idempotencyKey: `delete-${id}-${expectedRevision}-${serial}`,
    expectedRevision,
    createdAt: 102 + expectedRevision,
    event: event(expectedRevision + 1),
    ...overrides
  }
}

function raw(path = databasePath): DatabaseSync {
  return new DatabaseSync(path)
}

function counts(path = databasePath): { resources: number; events: number; mutations: number } {
  const db = raw(path)
  const result = {
    resources: Number(db.prepare('SELECT COUNT(*) value FROM resources').get()?.value),
    events: Number(db.prepare('SELECT COUNT(*) value FROM events').get()?.value),
    mutations: Number(db.prepare('SELECT COUNT(*) value FROM resource_mutations').get()?.value)
  }
  db.close()
  return result
}

function canonicalForTest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalForTest(record[key])}`)
    .join(',')}}`
}

function createV2(path: string): void {
  const db = raw(path)
  const now = 10
  db.exec(`${SCHEMA_METADATA_DDL}; ${EVENTS_DDL}; ${IDEMPOTENCY_INDEX_DDL};
    ${STREAM_INDEX_DDL}; ${CREATED_AT_INDEX_DDL}; ${EVENT_STORE_V2_ADDITIONS_SQL};
    PRAGMA application_id = ${EVENT_STORE_APPLICATION_ID}; PRAGMA user_version = 2;`)
  db.prepare('INSERT INTO schema_metadata VALUES (?, ?, ?)').run('schema_version', '2', now)
  db.prepare('INSERT INTO schema_metadata VALUES (?, ?, ?)').run('created_at', String(now), now)
  db.prepare('INSERT INTO schema_metadata VALUES (?, ?, ?)').run('migrated_at', String(now), now)
  const stored = event(0, { id: 'v2-event', streamId: 'v2-stream', createdAt: 20 })
  const envelope = canonicalForTest(stored)
  db.prepare(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`).run(
    stored.id,
    stored.protocolVersion,
    stored.streamId,
    stored.sequence,
    stored.type,
    stored.createdAt,
    canonicalForTest(stored.payload),
    envelope,
    20
  )
  db.prepare(`INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
    'v2-snapshot',
    'v2-stream',
    0,
    0,
    'test',
    '{"ok":true}',
    21,
    21
  )
  db.close()
}

beforeEach(async () => {
  serial = 0
  directory = await fs.mkdtemp(join(os.tmpdir(), 'magic-agent-resource-store-'))
  databasePath = join(directory, 'resource.sqlite')
})

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('resource store schema and lifecycle', () => {
  it('creates v3 STRICT resource tables with clean foreign keys and survives reopen', () => {
    const store = open()
    expect(store.getStorageInfo()).toMatchObject({ schemaVersion: EVENT_STORE_SCHEMA_VERSION })
    store.close()
    const db = raw()
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
    expect(db.prepare("SELECT strict FROM pragma_table_list WHERE name='resources'").get()).toEqual(
      { strict: 1 }
    )
    expect(
      db.prepare("SELECT strict FROM pragma_table_list WHERE name='resource_mutations'").get()
    ).toEqual({ strict: 1 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
    expect(open().getStorageInfo().schemaVersion).toBe(3)
  })

  it('throws EventStoreClosedError from every resource API after close', () => {
    const store = open()
    store.close()
    expect(() => store.mutateResource(createInput())).toThrow(EventStoreClosedError)
    expect(() => store.getResource('session', 'x')).toThrow(EventStoreClosedError)
    expect(() => store.listResources()).toThrow(EventStoreClosedError)
    expect(() => store.countResources()).toThrow(EventStoreClosedError)
    expect(() => store.getResourceRevision('session', 'x')).toThrow(EventStoreClosedError)
    expect(() => store.listResourceMutations('session', 'x')).toThrow(EventStoreClosedError)
  })
})

describe('resource mutations', () => {
  it('creates a detached frozen session at revision zero with one event and mutation', () => {
    const store = open()
    const state = { title: 'original', nested: { active: true } }
    const result = store.mutateResource(createInput('s1', { state }))
    expect(result).toMatchObject({ inserted: true, resource: { revision: 0, deleted: false } })
    expect(result.resource.state).not.toBe(state)
    expect(Object.isFrozen(result.resource)).toBe(true)
    expect(Object.isFrozen(result.resource.state)).toBe(true)
    expect(Object.isFrozen((result.resource.state as { nested: object }).nested)).toBe(true)
    expect(Object.isFrozen(state)).toBe(false)
    state.title = 'changed'
    expect(result.resource.state).toMatchObject({ title: 'original' })
    expect(store.getResource('session', 's1')).toEqual(result.resource)
    expect(store.countResources()).toBe(1)
    expect(store.getResourceRevision('session', 's1')).toBe(0)
    expect(store.countEvents()).toBe(1)
    expect(store.listResourceMutations('session', 's1')).toHaveLength(1)
  })

  it('updates expected revision zero to revision one and permits equal updatedAt', () => {
    const store = open()
    store.mutateResource(createInput('s1', { createdAt: 100 }))
    const result = store.mutateResource(updateInput('s1', 0, { createdAt: 100 }))
    expect(result.resource).toMatchObject({ revision: 1, updatedAt: 100, deleted: false })
  })

  it('deletes expected revision one to a hidden revision-two tombstone', () => {
    const store = open()
    store.mutateResource(createInput('s1'))
    store.mutateResource(updateInput('s1', 0))
    const result = store.mutateResource(deleteInput('s1', 1))
    expect(result.resource).toMatchObject({ revision: 2, deleted: true })
    expect(store.getResource('session', 's1')).toBeUndefined()
    expect(store.getResource('session', 's1', { includeDeleted: true })).toEqual(result.resource)
    expect(store.countEvents()).toBe(3)
    expect(store.listResourceMutations('session', 's1')).toHaveLength(3)
  })

  it.each(['create', 'update', 'delete'] as const)(
    'does not permit %s against a tombstone',
    (operation) => {
      const store = open()
      store.mutateResource(createInput('s1'))
      store.mutateResource(deleteInput('s1', 0))
      const input =
        operation === 'create'
          ? createInput('s1', { idempotencyKey: 'again' })
          : operation === 'update'
            ? updateInput('s1', 1)
            : deleteInput('s1', 1)
      expect(() => store.mutateResource(input)).toThrow(
        operation === 'create' ? ResourceRevisionConflictError : ResourceNotFoundError
      )
    }
  )

  it('rejects create with expectedRevision', () => {
    expect(() => open().mutateResource(createInput('s1', { expectedRevision: 0 }))).toThrow(
      ResourceValidationError
    )
  })

  it.each(['update', 'delete'] as const)('rejects %s without expectedRevision', (operation) => {
    const input = operation === 'update' ? updateInput('missing', 0) : deleteInput('missing', 0)
    const { expectedRevision: _expectedRevision, ...missing } = input
    expect(() => open().mutateResource(missing as ResourceMutationInput)).toThrow(
      ResourceValidationError
    )
  })

  it.each(['update', 'delete'] as const)(
    'rejects stale %s revision without side effects',
    (operation) => {
      const store = open()
      store.mutateResource(createInput('s1'))
      const before = counts()
      const input = operation === 'update' ? updateInput('s1', 1) : deleteInput('s1', 1)
      expect(() => store.mutateResource(input)).toThrow(ResourceRevisionConflictError)
      expect(counts()).toEqual(before)
    }
  )

  it.each(['update', 'delete'] as const)('rejects not-found %s', (operation) => {
    const input = operation === 'update' ? updateInput('missing', 0) : deleteInput('missing', 0)
    expect(() => open().mutateResource(input)).toThrow(ResourceNotFoundError)
  })

  it('rejects decreasing updatedAt', () => {
    const store = open()
    store.mutateResource(createInput('s1', { createdAt: 200 }))
    expect(() => store.mutateResource(updateInput('s1', 0, { createdAt: 199 }))).toThrow(
      ResourceRevisionConflictError
    )
  })

  it('exactly replays a full result with inserted false before and after reopen', () => {
    const store = open()
    const input = createInput('s1')
    const first = store.mutateResource(input)
    expect(store.mutateResource(input)).toEqual({ resource: first.resource, inserted: false })
    store.close()
    expect(open().mutateResource(input)).toEqual({ resource: first.resource, inserted: false })
    expect(counts()).toEqual({ resources: 1, events: 1, mutations: 1 })
  })

  it.each([
    ['state', { state: { title: 'different' } }],
    ['event', { event: event(0, { id: 'different-event' }) }],
    ['operation', { operation: 'update', expectedRevision: 0 }]
  ] as const)('rejects same idempotency key with changed %s', (_name, change) => {
    const store = open()
    const input = createInput('s1')
    store.mutateResource(input)
    expect(() => store.mutateResource({ ...input, ...change } as ResourceMutationInput)).toThrow(
      EventStoreConflictError
    )
    expect(counts()).toEqual({ resources: 1, events: 1, mutations: 1 })
  })
})

describe('event atomicity and concurrency', () => {
  function atomicFailure(setup: (store: MagicAgentEventStore) => ResourceMutationInput): void {
    const store = open()
    const input = setup(store)
    const before = counts()
    expect(() => store.mutateResource(input)).toThrow(EventStoreConflictError)
    expect(counts()).toEqual(before)
  }

  it('cannot reuse an existing exact event for a new mutation', () => {
    atomicFailure((store) => {
      const reused = event(0, { id: 'existing', streamId: 'existing-stream' })
      store.appendBatch([reused])
      return createInput('s1', { event: reused })
    })
  })

  it('rolls back resource creation on eventId conflict', () => {
    atomicFailure((store) => {
      store.appendBatch([event(0, { id: 'collision', streamId: 'old-stream' })])
      return createInput('s1', { event: event(0, { id: 'collision', streamId: 'new-stream' }) })
    })
  })

  it('rolls back resource creation on stream sequence conflict', () => {
    atomicFailure((store) => {
      store.appendBatch([event(0, { id: 'old', streamId: 'shared' })])
      return createInput('s1', { event: event(0, { id: 'new', streamId: 'shared' }) })
    })
  })

  it('rolls back resource creation on snapshot coverage conflict', () => {
    atomicFailure((store) => {
      store.appendBatch([event(0, { id: 'covered', streamId: 'covered-stream' })])
      store.appendSnapshot({
        snapshotId: 'snap',
        streamId: 'covered-stream',
        snapshotVersion: 0,
        coveredSequence: 0,
        stateType: 'test',
        state: {},
        createdAt: 10
      })
      return createInput('s1', { event: event(0, { id: 'late', streamId: 'covered-stream' }) })
    })
  })

  it('serializes two stores so stale expected revision loses', () => {
    const a = open()
    const b = open()
    a.mutateResource(createInput('s1'))
    expect(a.getResourceRevision('session', 's1')).toBe(0)
    expect(b.getResourceRevision('session', 's1')).toBe(0)
    expect(
      a.mutateResource(updateInput('s1', 0, { idempotencyKey: 'a-update' })).resource.revision
    ).toBe(1)
    expect(() => b.mutateResource(updateInput('s1', 0, { idempotencyKey: 'b-update' }))).toThrow(
      ResourceRevisionConflictError
    )
    a.close()
    b.close()
  })
})

describe('resource queries', () => {
  it('filters, includes deleted, counts, and orders resources', () => {
    const store = open()
    store.mutateResource(createInput('b', { kind: 'run', createdAt: 20 }))
    store.mutateResource(createInput('a', { kind: 'session', createdAt: 10 }))
    store.mutateResource(createInput('c', { kind: 'session', createdAt: 30 }))
    store.mutateResource(deleteInput('c', 0, { kind: 'session', createdAt: 31 }))
    expect(store.listResources().map((item) => item.id)).toEqual(['a', 'b'])
    expect(store.listResources({ kind: 'session' }).map((item) => item.id)).toEqual(['a'])
    expect(store.listResources({ includeDeleted: true }).map((item) => item.id)).toEqual([
      'a',
      'b',
      'c'
    ])
    expect(store.countResources()).toBe(2)
    expect(store.countResources({ kind: 'session', includeDeleted: true })).toBe(2)
  })

  it('uses the composite cursor without gaps or duplicates at equal timestamps', () => {
    const store = open()
    for (const id of ['a', 'b', 'c', 'd']) store.mutateResource(createInput(id, { createdAt: 10 }))
    const first = store.listResources({ limit: 2 })
    const last = first[1]
    const second = store.listResources({
      limit: 2,
      after: {
        updatedAt: last.updatedAt,
        resourceKind: last.kind,
        resourceId: last.id
      }
    })
    expect([...first, ...second].map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it.each([0, 10001])('rejects invalid resource list limit %s', (limit) => {
    expect(() => open().listResources({ limit })).toThrow(RangeError)
  })

  it.each([
    null,
    { updatedAt: -1, resourceKind: 'session', resourceId: 'x' },
    { updatedAt: 1, resourceKind: '', resourceId: 'x' }
  ])('rejects invalid resource cursor %#', (after) => {
    expect(() => open().listResources({ after: after as never })).toThrow()
  })

  it('lists stable frozen mutation history, honors limit, and survives reopen', () => {
    const store = open()
    store.mutateResource(createInput('s1'))
    store.mutateResource(updateInput('s1', 0))
    store.mutateResource(deleteInput('s1', 1))
    const first = store.listResourceMutations('session', 's1', 2)
    expect(first.map((item) => item.resource.revision)).toEqual([0, 1])
    expect(Object.isFrozen(first[0])).toBe(true)
    expect(Object.isFrozen(first[0].resource.state)).toBe(true)
    store.close()
    expect(
      open()
        .listResourceMutations('session', 's1')
        .map((item) => item.resource.revision)
    ).toEqual([0, 1, 2])
  })

  it.each([0, 10001])('rejects invalid mutation list limit %s', (limit) => {
    expect(() => open().listResourceMutations('session', 'x', limit)).toThrow(RangeError)
  })
})

describe('resource state validation', () => {
  const validArtifact = {
    sha256: 'a'.repeat(64),
    mimeType: 'image/png',
    size: 12,
    relativePath: 'images/a.png',
    metadata: { safe: ['yes', 1] },
    future: { supported: true }
  }

  it('round-trips valid artifacts and safe unknown fields', () => {
    const result = open().mutateResource(
      createInput('artifact-1', { kind: 'artifact', state: validArtifact })
    )
    expect(result.resource.state).toEqual(validArtifact)
  })

  it.each([
    ['uppercase sha', { ...validArtifact, sha256: 'A'.repeat(64) }],
    ['short sha', { ...validArtifact, sha256: 'a'.repeat(63) }],
    ['empty mime', { ...validArtifact, mimeType: ' ' }],
    ['negative size', { ...validArtifact, size: -1 }],
    ['unsafe size', { ...validArtifact, size: Number.MAX_SAFE_INTEGER + 1 }]
  ])('rejects artifact %s', (_name, state) => {
    expect(() => open().mutateResource(createInput('bad', { kind: 'artifact', state }))).toThrow(
      ResourceValidationError
    )
  })

  it.each([
    '/absolute',
    'C:/absolute',
    'a\\b',
    '../a',
    './a',
    'a/../b',
    'a/./b',
    'a//b',
    'a/',
    '/a',
    'a\u0000b'
  ])('rejects artifact path %j', (relativePath) => {
    expect(() =>
      open().mutateResource(
        createInput('bad', {
          kind: 'artifact',
          state: { ...validArtifact, relativePath }
        })
      )
    ).toThrow(ResourceValidationError)
  })

  it.each(['content', 'data', 'path', 'filePath', 'bytes', 'buffer', 'absolutePath'])(
    'rejects artifact forbidden field %s',
    (field) => {
      expect(() =>
        open().mutateResource(
          createInput('bad', {
            kind: 'artifact',
            state: { ...validArtifact, [field]: 'x' }
          })
        )
      ).toThrow(ResourceValidationError)
    }
  )

  it('accepts sanitized legacy references and rejects raw or duplicated descriptors', () => {
    const legacyRef = {
      normalizedDescriptor: { label: 'legacy artifact' },
      omittedFields: ['content', 'path']
    }
    const state = {
      storage: 'legacy-reference',
      artifactId: 'legacy-1',
      source: 'tool',
      createdAt: 1,
      legacyRef
    }
    expect(
      open().mutateResource(
        createInput('legacy-1', {
          kind: 'artifact',
          state
        })
      ).resource.state
    ).toMatchObject(state)
    expect(() =>
      open().mutateResource(
        createInput('bad-legacy', {
          kind: 'artifact',
          state: {
            ...state,
            artifactId: 'bad-legacy',
            legacyRef: { ...legacyRef, rawDescriptor: { secret: true } }
          }
        })
      )
    ).toThrow(ResourceValidationError)
    expect(() =>
      open().mutateResource(
        createInput('duplicated-legacy', {
          kind: 'artifact',
          state: {
            ...state,
            artifactId: 'duplicated-legacy',
            legacyRef: {
              ...legacyRef,
              normalizedDescriptor: { artifactId: 'duplicated-legacy' }
            }
          }
        })
      )
    ).toThrow(ResourceValidationError)
  })

  it.each([{}, { status: '' }, { status: ' pending ' }])(
    'rejects invalid approval state %#',
    (state) => {
      expect(() =>
        open().mutateResource(createInput('approval', { kind: 'approval', state }))
      ).toThrow(ResourceValidationError)
    }
  )

  it.each([null, 1, 'x', [], new Date()])('rejects non-record generic state %#', (state) => {
    expect(() => open().mutateResource(createInput('generic', { kind: 'custom', state }))).toThrow(
      ResourceValidationError
    )
  })

  it('rejects cyclic, function, and unsafe artifact metadata', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const state of [
      cycle,
      { fn: () => true },
      { ...validArtifact, metadata: { fn: () => true } }
    ]) {
      expect(() =>
        open().mutateResource(createInput(`bad-${serial}`, { kind: 'artifact', state }))
      ).toThrow(ResourceValidationError)
    }
  })
})

describe('resource corruption detection', () => {
  it('refuses to open a database containing an orphan mutation', () => {
    const store = open()
    store.close()
    const db = raw()
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare(
      `INSERT INTO resource_mutations VALUES
      ('orphan','session','missing','create',NULL,0,'missing-event','{}','{}',1)`
    ).run()
    db.close()
    expect(() => open()).toThrow(CorruptEventStoreError)
  })

  it('detects invalid resource state_json through get and list', () => {
    const store = open()
    store.mutateResource(createInput('s1'))
    const db = raw()
    db.prepare("UPDATE resources SET state_json = '{'").run()
    db.close()
    expect(() => store.getResource('session', 's1')).toThrow(CorruptEventStoreError)
    expect(() => store.listResources()).toThrow(CorruptEventStoreError)
  })

  it.each([
    ['command_json', "UPDATE resource_mutations SET command_json='{}'"],
    ['result_json', "UPDATE resource_mutations SET result_json='{}'"],
    ['event_id', "UPDATE resource_mutations SET event_id='missing'"],
    ['column', 'UPDATE resource_mutations SET resulting_revision=9']
  ])('detects corrupted mutation %s in list/replay', (_name, sql) => {
    const store = open()
    const input = createInput('s1')
    store.mutateResource(input)
    const db = raw()
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(sql)
    db.close()
    expect(() => store.listResourceMutations('session', 's1')).toThrow(CorruptEventStoreError)
    expect(() => store.mutateResource(input)).toThrow(CorruptEventStoreError)
  })

  it('audits the complete chain before applying list limits or idempotent replay', () => {
    const store = open()
    const create = createInput('s1', { createdAt: 100 })
    store.mutateResource(create)
    store.mutateResource(updateInput('s1', 0, { createdAt: 101 }))
    store.mutateResource(updateInput('s1', 1, { createdAt: 102 }))
    const db = raw()
    const row = db
      .prepare(
        'SELECT command_json, result_json FROM resource_mutations WHERE resulting_revision=1'
      )
      .get() as { command_json: string; result_json: string }
    const command = JSON.parse(row.command_json) as Record<string, unknown>
    const result = JSON.parse(row.result_json) as {
      resource: Record<string, unknown>
      inserted: true
    }
    command.createdAt = 103
    result.resource.updatedAt = 103
    db.prepare(
      `UPDATE resource_mutations SET command_json=?, result_json=?, created_at=103
       WHERE resulting_revision=1`
    ).run(canonicalForTest(command), canonicalForTest(result))
    db.close()
    expect(() => store.listResourceMutations('session', 's1', 1)).toThrow(
      'Resource mutation chain is invalid.'
    )
    expect(() => store.mutateResource(create)).toThrow('Resource mutation chain is invalid.')
    store.close()
    expect(() => open()).toThrow('Resource mutation chain is invalid.')
  })

  it('rejects a self-consistent delete result whose state differs from its predecessor', () => {
    const store = open()
    store.mutateResource(createInput('s1'))
    store.mutateResource(deleteInput('s1', 0))
    const db = raw()
    const row = db
      .prepare('SELECT result_json FROM resource_mutations WHERE resulting_revision=1')
      .get() as { result_json: string }
    const result = JSON.parse(row.result_json) as {
      resource: Record<string, unknown>
      inserted: true
    }
    result.resource.state = { title: 'tampered', nested: { active: true } }
    db.prepare('UPDATE resource_mutations SET result_json=? WHERE resulting_revision=1').run(
      canonicalForTest(result)
    )
    db.prepare("UPDATE resources SET state_json=? WHERE resource_id='s1'").run(
      canonicalForTest(result.resource.state)
    )
    db.close()
    expect(() => store.listResourceMutations('session', 's1')).toThrow(
      'Resource mutation chain is invalid.'
    )
  })

  it('rejects a self-consistent revision gap', () => {
    const store = open()
    store.mutateResource(createInput('s1'))
    store.mutateResource(updateInput('s1', 0))
    store.mutateResource(deleteInput('s1', 1))
    const db = raw()
    const gap = db
      .prepare(
        'SELECT command_json, result_json FROM resource_mutations WHERE resulting_revision=1'
      )
      .get() as { command_json: string; result_json: string }
    const gapCommand = JSON.parse(gap.command_json) as Record<string, unknown>
    const gapResult = JSON.parse(gap.result_json) as {
      resource: Record<string, unknown>
      inserted: true
    }
    gapCommand.expectedRevision = 1
    gapResult.resource.revision = 2
    db.prepare(
      `UPDATE resource_mutations SET expected_revision=1, resulting_revision=2,
       command_json=?, result_json=? WHERE resulting_revision=1`
    ).run(canonicalForTest(gapCommand), canonicalForTest(gapResult))
    db.close()
    expect(() => store.listResourceMutations('session', 's1')).toThrow(
      'Resource mutation chain is invalid.'
    )
  })

  it('rejects a resource row without mutations and a current row differing from the last result', () => {
    const store = open()
    store.mutateResource(createInput('s1'))
    store.close()
    let db = raw()
    db.prepare("UPDATE resources SET state_json='{}' WHERE resource_id='s1'").run()
    db.close()
    expect(() => open()).toThrow('Resource mutation chain is invalid.')

    const secondPath = join(directory, 'missing-chain.sqlite')
    const second = open(secondPath)
    second.mutateResource(createInput('s2'))
    second.close()
    db = raw(secondPath)
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare("DELETE FROM resource_mutations WHERE resource_id='s2'").run()
    db.close()
    expect(() => open(secondPath)).toThrow('Resource mutation chain is invalid.')
  })
})

describe('resource schema migration', () => {
  it('migrates a populated v2 event and snapshot database to v3 without data loss', () => {
    createV2(databasePath)
    const store = open()
    expect(store.getStorageInfo().schemaVersion).toBe(3)
    expect(store.getEvent('v2-event')?.id).toBe('v2-event')
    expect(store.getSnapshot('v2-snapshot')?.state).toEqual({ ok: true })
    const db = raw()
    expect(
      db.prepare("SELECT value FROM schema_metadata WHERE key='migrated_from_version'").get()
    ).toEqual({ value: '2' })
    expect(
      db.prepare("SELECT value FROM schema_metadata WHERE key='migrated_to_v3_at'").get()
    ).toBeDefined()
    db.close()
  })

  it('rolls back malformed v2 resource-table conflicts and preserves user_version 2', () => {
    createV2(databasePath)
    const db = raw()
    db.exec('CREATE TABLE resources(bad TEXT)')
    db.close()
    expect(() => open()).toThrow(CorruptEventStoreError)
    const check = raw()
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    expect(
      check.prepare("SELECT sql FROM sqlite_master WHERE name='resources'").get()?.sql
    ).toContain('bad TEXT')
    check.close()
  })
})
