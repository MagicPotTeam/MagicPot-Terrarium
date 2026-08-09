import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  type BigIntStats,
  type Stats
} from 'node:fs'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { types as utilTypes } from 'node:util'
import type { MagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import { parseMagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import { invokeCrashHook } from './crashHooks'

import {
  EVENT_STORE_APPLICATION_ID,
  EVENT_STORE_SCHEMA_VERSION,
  EventStoreOpenError,
  NodeSQLiteAdapter,
  openReadOnlyDatabase,
  openReadWriteDatabase,
  type SQLiteRow
} from './sqliteAdapter'
import {
  CREATED_AT_INDEX_DDL,
  EVENTS_DDL,
  IDEMPOTENCY_INDEX_DDL,
  RESOURCE_MUTATIONS_CREATED_INDEX_DDL,
  RESOURCE_MUTATIONS_DDL,
  RESOURCE_MUTATIONS_RESOURCE_REVISION_INDEX_DDL,
  RESOURCES_DDL,
  RESOURCES_KIND_DELETED_UPDATED_INDEX_DDL,
  RESOURCES_UPDATED_INDEX_DDL,
  SCHEMA_METADATA_DDL,
  SNAPSHOTS_DDL,
  SNAPSHOT_COVERED_INDEX_DDL,
  SNAPSHOT_VERSION_INDEX_DDL,
  STREAM_INDEX_DDL
} from './schema'
import { acquireEventStoreWriteLock, acquireInstanceLease, type InstanceLease } from './writeLock'

const DEFAULT_READ_LIMIT = 100
const MAX_READ_LIMIT = 1000
export const MAX_APPEND_BATCH_SIZE = 1000
export const MAX_RESOURCE_MUTATION_BATCH_SIZE = 1000
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
type OpenStoreState = { openCount: number; backupCount: number }
const openStoreRegistry = new Map<string, OpenStoreState>()

type FileSnapshot = Readonly<{
  realPath: string
  dev: bigint
  ino: bigint
  size: bigint
  mtimeMs: bigint
}>

type InspectedDatabasePath = Readonly<{
  snapshot?: FileSnapshot
  expectedRealPath?: string
}>

export class EventStoreConflictError extends Error {
  readonly code = 'MAGIC_AGENT_EVENT_STORE_CONFLICT'
  constructor(message: string) {
    super(message)
    this.name = 'EventStoreConflictError'
  }
}
export class EventStoreWriteLockedError extends Error {
  readonly code = 'MAGIC_AGENT_EVENT_STORE_WRITE_LOCKED'
  constructor(cause?: unknown) {
    super('MagicAgent Event Store is locked by another writer.', { cause })
    this.name = 'EventStoreWriteLockedError'
  }
}
export class CorruptEventStoreError extends Error {
  readonly code = 'MAGIC_AGENT_EVENT_STORE_CORRUPT'
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'CorruptEventStoreError'
  }
}
export class EventStoreClosedError extends Error {
  readonly code = 'MAGIC_AGENT_EVENT_STORE_CLOSED'
  constructor() {
    super('MagicAgent Event Store is closed.')
    this.name = 'EventStoreClosedError'
  }
}
export class BackupInProgressError extends Error {
  readonly code = 'MAGIC_AGENT_BACKUP_IN_PROGRESS'
  constructor() {
    super('A MagicAgent Event Store backup is in progress.')
    this.name = 'BackupInProgressError'
  }
}
export class UnsupportedEventStoreError extends Error {
  readonly code = 'MAGIC_AGENT_EVENT_STORE_UNSUPPORTED'
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedEventStoreError'
  }
}
export class RecoveryLimitExceededError extends Error {
  readonly code = 'MAGIC_AGENT_RECOVERY_LIMIT_EXCEEDED'
  constructor(readonly limit: number) {
    super(`Recovery requires more than ${limit} tail events.`)
    this.name = 'RecoveryLimitExceededError'
  }
}
export class RecoverySnapshotDecodeError extends Error {
  readonly code = 'MAGIC_AGENT_RECOVERY_SNAPSHOT_DECODE'
  constructor(cause: unknown) {
    super('Recovery snapshot decoder failed.', { cause })
    this.name = 'RecoverySnapshotDecodeError'
  }
}
export class RecoveryReducerError extends Error {
  readonly code = 'MAGIC_AGENT_RECOVERY_REDUCER'
  constructor(
    readonly eventId: string,
    cause: unknown
  ) {
    super(`Recovery reducer failed for event ${eventId}.`, { cause })
    this.name = 'RecoveryReducerError'
  }
}
export class RecoveryBundleError extends Error {
  readonly code = 'MAGIC_AGENT_RECOVERY_BUNDLE'
  constructor(cause?: unknown) {
    const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : ''
    super(`Recovery bundle is invalid.${detail}`, { cause })
    this.name = 'RecoveryBundleError'
  }
}
export type RecoveryStateValidationStage = 'snapshot-decode' | 'initial' | 'reducer' | 'final'
export class RecoveryStateValidationError extends Error {
  readonly code = 'MAGIC_AGENT_RECOVERY_STATE_VALIDATION'
  constructor(
    readonly stage: RecoveryStateValidationStage,
    readonly eventId: string | undefined,
    cause: unknown
  ) {
    super(`Recovery state is not JSON-safe at ${stage}${eventId ? ` for event ${eventId}` : ''}.`, {
      cause
    })
    this.name = 'RecoveryStateValidationError'
  }
}

export type ResourceKind =
  | 'session'
  | 'run'
  | 'agent'
  | 'channel'
  | 'approval'
  | 'artifact'
  | 'drive'
  | 'runtime-channel'
  | 'runtime-channel-message'
  | 'runtime-channel-wire'
  | 'runtime-channel-forwarding'
  | (string & {})
export type StoredResource<T = unknown> = Readonly<{
  kind: ResourceKind
  id: string
  revision: number
  state: T
  deleted: boolean
  createdAt: number
  updatedAt: number
}>
export type ResourceCursor = Readonly<{
  updatedAt: number
  resourceKind: ResourceKind
  resourceId: string
}>
export type ResourceMutationInput = Readonly<{
  operation: 'create' | 'update' | 'delete'
  kind: ResourceKind
  id: string
  idempotencyKey: string
  expectedRevision?: number
  state?: unknown
  createdAt: number
  event: MagicAgentEvent<unknown>
}>
export type ResourceMutationResult<T = unknown> = Readonly<{
  resource: StoredResource<T>
  inserted: boolean
}>
export type StoredResourceMutation = Readonly<{
  idempotencyKey: string
  operation: 'create' | 'update' | 'delete'
  resource: StoredResource
  expectedRevision?: number
  eventId: string
  createdAt: number
}>

export class ResourceNotFoundError extends Error {
  readonly code = 'MAGIC_AGENT_RESOURCE_NOT_FOUND'
  constructor(kind: string, id: string) {
    super(`Resource not found: ${kind}/${id}.`)
    this.name = 'ResourceNotFoundError'
  }
}
export class ResourceRevisionConflictError extends Error {
  readonly code = 'MAGIC_AGENT_RESOURCE_REVISION_CONFLICT'
  constructor(kind: string, id: string) {
    super(`Resource revision conflict: ${kind}/${id}.`)
    this.name = 'ResourceRevisionConflictError'
  }
}
export class ResourceValidationError extends Error {
  readonly code = 'MAGIC_AGENT_RESOURCE_VALIDATION'
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'ResourceValidationError'
  }
}

export type AppendResult = Readonly<{
  eventId: string
  streamId: string
  sequence: number
  inserted: boolean
}>
export type StorageInfo = Readonly<{
  schemaVersion: number
  journalMode: string
  sqliteVersion: string
  path: string
}>
export type CheckpointMode = 'PASSIVE' | 'FULL' | 'TRUNCATE'
export type CheckpointResult = Readonly<{ busy: number; log: number; checkpointed: number }>
export type SnapshotInput = Readonly<{
  snapshotId: string
  streamId: string
  snapshotVersion: number
  coveredSequence: number
  stateType: string
  state: unknown
  metadata?: unknown
  createdAt: number
}>
export type StoredSnapshot = Readonly<SnapshotInput & { insertedAt: number }>
export type AppendSnapshotResult = Readonly<{
  snapshotId: string
  streamId: string
  snapshotVersion: number
  inserted: boolean
}>
export type RecoveryBundle = Readonly<{
  snapshot: StoredSnapshot | null
  events: readonly MagicAgentEvent<unknown>[]
}>

type StoredEvent = {
  event: MagicAgentEvent<unknown>
  canonical: string
  idempotencyKey?: string
  payloadJson: string
}

type RequiredColumn = Readonly<{ name: string; type: string; notnull: number; pk: number }>
const METADATA_COLUMNS: RequiredColumn[] = [
  { name: 'key', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'updated_at', type: 'REAL', notnull: 1, pk: 0 }
]
const EVENT_COLUMNS: RequiredColumn[] = [
  { name: 'event_id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'protocol_version', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'stream_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'sequence', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'type', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'created_at', type: 'REAL', notnull: 1, pk: 0 },
  { name: 'correlation_id', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'causation_id', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'idempotency_key', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'payload_json', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'envelope_json', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'inserted_at', type: 'REAL', notnull: 1, pk: 0 }
]
const SNAPSHOT_COLUMNS: RequiredColumn[] = [
  { name: 'snapshot_id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'stream_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'snapshot_version', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'covered_sequence', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'state_type', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'state_json', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'metadata_json', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'created_at', type: 'REAL', notnull: 1, pk: 0 },
  { name: 'inserted_at', type: 'REAL', notnull: 1, pk: 0 }
]

const RESOURCE_COLUMNS: RequiredColumn[] = [
  { name: 'resource_kind', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'resource_id', type: 'TEXT', notnull: 1, pk: 2 },
  { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'state_json', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'deleted', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'created_at', type: 'REAL', notnull: 1, pk: 0 },
  { name: 'updated_at', type: 'REAL', notnull: 1, pk: 0 }
]
const RESOURCE_MUTATION_COLUMNS: RequiredColumn[] = [
  { name: 'idempotency_key', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'resource_kind', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'resource_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'operation', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'expected_revision', type: 'INTEGER', notnull: 0, pk: 0 },
  { name: 'resulting_revision', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'event_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'command_json', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'result_json', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'created_at', type: 'REAL', notnull: 1, pk: 0 }
]

export class MagicAgentEventStore {
  private readonly adapter!: NodeSQLiteAdapter
  private readonly databasePath?: string
  private closed = false
  private registryPath?: string
  private instanceLease?: InstanceLease

  constructor(path: string, options: { timeout?: number } = {}) {
    const timeout = options.timeout ?? 5000
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      throw new RangeError('SQLite timeout must be a non-negative safe integer.')
    }
    this.databasePath = path === ':memory:' ? undefined : resolve(path)
    let release: (() => void) | undefined
    try {
      try {
        release = this.databasePath ? acquireEventStoreWriteLock(this.databasePath) : undefined
      } catch (error) {
        throw new EventStoreOpenError(path, error)
      }
      if (this.databasePath && existsSync(`${this.databasePath}.restore-journal.json`)) {
        throw new EventStoreOpenError(
          path,
          new Error('A pending restore journal must be recovered before opening the Event Store.')
        )
      }
      const file = inspectDatabasePath(path)
      let expectedSnapshot = file.snapshot
      if (expectedSnapshot && expectedSnapshot.size > 0n) {
        const probe = openReadOnlyDatabase(path)
        try {
          validateDatabase(probe, true)
        } finally {
          probe.close()
        }
        const afterProbe = capturePathSnapshot(path)
        assertSameFile(expectedSnapshot, afterProbe, path)
        expectedSnapshot = afterProbe
      }
      this.adapter = openReadWriteDatabase(path, timeout)
      try {
        if (path !== ':memory:') {
          const openedSnapshot = captureOpenedDatabaseSnapshot(this.adapter, path)
          const requestedSnapshot = capturePathSnapshot(path)
          if (
            !file.expectedRealPath ||
            normalizeFilePath(openedSnapshot.realPath) !== normalizeFilePath(file.expectedRealPath)
          )
            throw new EventStoreOpenError(
              path,
              new Error('SQLite opened a different path than the requested database file.')
            )
          assertSameFile(requestedSnapshot, openedSnapshot, path)
          if (expectedSnapshot) assertSameFile(expectedSnapshot, openedSnapshot, path)
        }
        this.initialize()
        if (path !== ':memory:') {
          this.instanceLease = acquireInstanceLease(path)
          this.registryPath = normalizeFilePath(capturePathSnapshot(path).realPath)
          const state = openStoreRegistry.get(this.registryPath) ?? { openCount: 0, backupCount: 0 }
          state.openCount += 1
          openStoreRegistry.set(this.registryPath, state)
        }
      } catch (error) {
        try {
          this.adapter.close()
        } catch {
          /* preserve initialization error */
        }
        try {
          this.instanceLease?.release()
        } catch {
          /* preserve initialization error */
        }
        this.instanceLease = undefined
        throw error
      }
    } finally {
      release?.()
    }
  }

  appendBatch(inputs: readonly MagicAgentEvent<unknown>[]): AppendResult[] {
    this.assertOpen()
    this.assertNotBackingUp()
    if (!Array.isArray(inputs)) throw new TypeError('inputs must be an array.')
    if (inputs.length > MAX_APPEND_BATCH_SIZE) {
      throw new RangeError(`appendBatch accepts at most ${MAX_APPEND_BATCH_SIZE} events.`)
    }
    if (inputs.length === 0) return []
    const events = inputs.map(prepareEvent)
    const release = this.acquireWriteLock()
    try {
      let results: AppendResult[]
      let committed = false
      try {
        this.adapter.exec('BEGIN IMMEDIATE')
        results = events.map((item) => appendPreparedEvent(this.adapter, item))
        invokeCrashHook('event.before-commit')
        this.adapter.exec('COMMIT')
        committed = true
      } catch (error) {
        if (!committed) {
          try {
            this.adapter.exec('ROLLBACK')
          } catch {
            /* preserve transaction error */
          }
        }
        throw normalizeSQLiteConflict(error)
      }
      invokeCrashHook('event.after-commit')
      return results
    } finally {
      release?.()
    }
  }

  readStream(
    streamId: string,
    options: { afterSequence?: number; limit?: number } = {}
  ): MagicAgentEvent<unknown>[] {
    this.assertOpen()
    requireInputString(streamId, 'streamId')
    if (options === null || typeof options !== 'object' || Array.isArray(options))
      throw new TypeError('options must be an object.')
    const after = options.afterSequence ?? -1
    if (!Number.isSafeInteger(after) || after < -1)
      throw new RangeError('afterSequence must be a safe integer greater than or equal to -1.')
    const limit = options.limit ?? DEFAULT_READ_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
      throw new RangeError(`limit must be an integer between 1 and ${MAX_READ_LIMIT}.`)
    return this.adapter
      .all(
        'SELECT * FROM events WHERE stream_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?',
        streamId,
        after,
        limit
      )
      .map(readStoredEvent)
  }

  getEvent(eventId: string): MagicAgentEvent<unknown> | undefined {
    this.assertOpen()
    requireInputString(eventId, 'eventId')
    const row = this.adapter.get('SELECT * FROM events WHERE event_id = ?', eventId)
    return row ? readStoredEvent(row) : undefined
  }

  getLastSequence(streamId: string): number | undefined {
    this.assertOpen()
    requireInputString(streamId, 'streamId')
    const value = this.adapter.get(
      'SELECT MAX(sequence) AS value FROM events WHERE stream_id = ?',
      streamId
    )?.value
    return value === null || value === undefined
      ? undefined
      : requireSafeInteger(value, 'last sequence')
  }

  countEvents(): number {
    this.assertOpen()
    return requireSafeInteger(
      this.adapter.get('SELECT COUNT(*) AS value FROM events')?.value,
      'event count'
    )
  }

  mutateResource<T = unknown>(input: ResourceMutationInput): ResourceMutationResult<T> {
    return this.mutateResourcesBatch([input])[0] as ResourceMutationResult<T>
  }

  mutateResourcesBatch(inputs: readonly ResourceMutationInput[]): ResourceMutationResult[] {
    this.assertOpen()
    this.assertNotBackingUp()
    if (!Array.isArray(inputs)) throw new TypeError('inputs must be an array.')
    if (inputs.length > MAX_RESOURCE_MUTATION_BATCH_SIZE)
      throw new RangeError(
        `mutateResourcesBatch accepts at most ${MAX_RESOURCE_MUTATION_BATCH_SIZE} mutations.`
      )
    if (inputs.length === 0) return []
    const commands = inputs.map(prepareResourceMutation)
    validatePreparedResourceMutationBatch(commands)
    const release = this.acquireWriteLock()
    try {
      let results: ResourceMutationResult[]
      let committed = false
      try {
        this.adapter.exec('BEGIN IMMEDIATE')
        const replayRows = commands.map((command) =>
          this.adapter.get(
            'SELECT * FROM resource_mutations WHERE idempotency_key = ?',
            command.idempotencyKey
          )
        )
        const replayCount = replayRows.filter(Boolean).length
        if (replayCount !== 0 && replayCount !== commands.length)
          throw new EventStoreConflictError(
            'Resource mutation batch mixes replayed and new commands.'
          )
        results = commands.map((command, index) =>
          executePreparedResourceMutation(this.adapter, command, replayRows[index])
        )
        invokeCrashHook('resource.before-commit')
        this.adapter.exec('COMMIT')
        committed = true
      } catch (error) {
        if (!committed) {
          try {
            this.adapter.exec('ROLLBACK')
          } catch {
            /* preserve error */
          }
        }
        throw normalizeSQLiteConflict(error)
      }
      invokeCrashHook('resource.after-commit')
      return results
    } finally {
      release?.()
    }
  }
  getResource<T = unknown>(
    kind: ResourceKind,
    id: string,
    options: { includeDeleted?: boolean } = {}
  ): StoredResource<T> | undefined {
    this.assertOpen()
    if (!isPlainRecord(options)) throw new TypeError('options must be a plain object.')
    requireInputString(kind, 'kind')
    requireInputString(id, 'id')
    const row = this.adapter.get(
      `SELECT * FROM resources WHERE resource_kind = ? AND resource_id = ?
      ${options.includeDeleted ? '' : 'AND deleted = 0'}`,
      kind,
      id
    )
    return row ? (readResource(row) as StoredResource<T>) : undefined
  }

  listResources(
    options: {
      kind?: ResourceKind
      includeDeleted?: boolean
      after?: ResourceCursor
      limit?: number
    } = {}
  ): StoredResource[] {
    this.assertOpen()
    if (!isPlainRecord(options)) throw new TypeError('options must be a plain object.')
    const limit = options.limit ?? DEFAULT_READ_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
      throw new RangeError('invalid limit')
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (options.kind !== undefined) {
      requireInputString(options.kind, 'kind')
      clauses.push('resource_kind = ?')
      params.push(options.kind)
    }
    if (!options.includeDeleted) clauses.push('deleted = 0')
    if (options.after !== undefined) {
      if (!isPlainRecord(options.after)) throw new TypeError('after must be a cursor object.')
      const { updatedAt, resourceKind, resourceId } = options.after
      if (!Number.isFinite(updatedAt) || updatedAt < 0)
        throw new RangeError('invalid cursor updatedAt')
      requireInputString(resourceKind, 'after.resourceKind')
      requireInputString(resourceId, 'after.resourceId')
      clauses.push(`(updated_at > ? OR updated_at = ? AND resource_kind > ? OR
        updated_at = ? AND resource_kind = ? AND resource_id > ?)`)
      params.push(updatedAt, updatedAt, resourceKind, updatedAt, resourceKind, resourceId)
    }
    return this.adapter
      .all(
        `SELECT * FROM resources ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY updated_at ASC, resource_kind ASC, resource_id ASC LIMIT ?`,
        ...params,
        limit
      )
      .map(readResource)
  }

  countResources(options: { kind?: ResourceKind; includeDeleted?: boolean } = {}): number {
    this.assertOpen()
    if (!isPlainRecord(options)) throw new TypeError('options must be a plain object.')
    const clauses: string[] = []
    const params: string[] = []
    if (options.kind !== undefined) {
      requireInputString(options.kind, 'kind')
      clauses.push('resource_kind = ?')
      params.push(options.kind)
    }
    if (!options.includeDeleted) clauses.push('deleted = 0')
    return requireSafeInteger(
      this.adapter.get(
        `SELECT COUNT(*) AS value FROM resources ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`,
        ...params
      )?.value,
      'resource count'
    )
  }

  getResourceRevision(kind: ResourceKind, id: string): number | undefined {
    return this.getResource(kind, id, { includeDeleted: true })?.revision
  }

  listResourceMutations(
    kind: ResourceKind,
    id: string,
    limit = DEFAULT_READ_LIMIT
  ): StoredResourceMutation[] {
    this.assertOpen()
    requireInputString(kind, 'kind')
    requireInputString(id, 'id')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
      throw new RangeError(`limit must be an integer between 1 and ${MAX_READ_LIMIT}.`)
    const resourceRow = this.adapter.get(
      'SELECT * FROM resources WHERE resource_kind = ? AND resource_id = ?',
      kind,
      id
    )
    const rows = this.adapter.all(
      `SELECT * FROM resource_mutations WHERE resource_kind = ? AND resource_id = ?
      ORDER BY resulting_revision ASC`,
      kind,
      id
    )
    if (!resourceRow && rows.length === 0) return []
    return validateResourceMutationChain(this.adapter, resourceRow, rows).slice(0, limit)
  }

  appendSnapshot(input: SnapshotInput): AppendSnapshotResult {
    this.assertOpen()
    this.assertNotBackingUp()
    const item = prepareSnapshot(input)
    const release = this.acquireWriteLock()
    let committed = false
    try {
      this.adapter.exec('BEGIN IMMEDIATE')
      const byId = this.adapter.get(
        'SELECT * FROM snapshots WHERE snapshot_id = ?',
        item.snapshotId
      )
      const byVersion = this.adapter.get(
        'SELECT * FROM snapshots WHERE stream_id = ? AND snapshot_version = ?',
        item.streamId,
        item.snapshotVersion
      )
      for (const row of [byId, byVersion]) {
        if (row) {
          if (canonicalSnapshotRow(row) === item.canonical) {
            invokeCrashHook('snapshot.before-commit')
            this.adapter.exec('COMMIT')
            committed = true
            invokeCrashHook('snapshot.after-commit')
            return snapshotResult(item, false)
          }
          throw new EventStoreConflictError('Snapshot identity or version conflict.')
        }
      }
      const last = this.getLastSequence(item.streamId)
      const coveredEvent =
        item.coveredSequence === -1
          ? undefined
          : this.adapter.get(
              'SELECT event_id FROM events WHERE stream_id = ? AND sequence = ?',
              item.streamId,
              item.coveredSequence
            )
      if (
        last === undefined
          ? item.coveredSequence !== -1
          : item.coveredSequence === -1 || !coveredEvent
      )
        throw new EventStoreConflictError(
          'Snapshot coveredSequence must identify an existing stream event.'
        )
      const latest = this.adapter.get(
        'SELECT snapshot_version, covered_sequence FROM snapshots WHERE stream_id = ? ORDER BY snapshot_version DESC LIMIT 1',
        item.streamId
      )
      if (
        latest &&
        (item.snapshotVersion <= requireSafeInteger(latest.snapshot_version, 'snapshot version') ||
          item.coveredSequence <= requireSafeInteger(latest.covered_sequence, 'covered sequence'))
      )
        throw new EventStoreConflictError('Snapshot version and coverage must increase strictly.')
      this.adapter
        .prepare(
          `INSERT INTO snapshots (snapshot_id, stream_id, snapshot_version, covered_sequence,
          state_type, state_json, metadata_json, created_at, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) `
        )
        .run(
          item.snapshotId,
          item.streamId,
          item.snapshotVersion,
          item.coveredSequence,
          item.stateType,
          item.stateJson,
          item.metadataJson,
          item.createdAt,
          Date.now()
        )
      invokeCrashHook('snapshot.before-commit')
      this.adapter.exec('COMMIT')
      committed = true
      invokeCrashHook('snapshot.after-commit')
      return snapshotResult(item, true)
    } catch (error) {
      if (committed) throw error
      try {
        this.adapter.exec('ROLLBACK')
      } catch {
        /* preserve error */
      }
      throw normalizeSQLiteConflict(error)
    } finally {
      release?.()
    }
  }

  getSnapshot(snapshotId: string): StoredSnapshot | undefined {
    this.assertOpen()
    requireInputString(snapshotId, 'snapshotId')
    const row = this.adapter.get('SELECT * FROM snapshots WHERE snapshot_id = ?', snapshotId)
    return row ? readStoredSnapshot(row) : undefined
  }

  getLatestSnapshot(streamId: string): StoredSnapshot | undefined {
    this.assertOpen()
    requireInputString(streamId, 'streamId')
    const row = this.adapter.get(
      'SELECT * FROM snapshots WHERE stream_id = ? ORDER BY snapshot_version DESC LIMIT 1',
      streamId
    )
    return row ? readStoredSnapshot(row) : undefined
  }

  listSnapshots(
    streamId: string,
    options: { afterVersion?: number; limit?: number } = {}
  ): StoredSnapshot[] {
    this.assertOpen()
    requireInputString(streamId, 'streamId')
    if (!isPlainRecord(options)) throw new TypeError('options must be a plain object.')
    const after = options.afterVersion ?? -1
    if (!Number.isSafeInteger(after) || after < -1)
      throw new RangeError('afterVersion must be a safe integer greater than or equal to -1.')
    const limit = options.limit ?? DEFAULT_READ_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
      throw new RangeError(`limit must be an integer between 1 and ${MAX_READ_LIMIT}.`)
    return this.adapter
      .all(
        'SELECT * FROM snapshots WHERE stream_id = ? AND snapshot_version > ? ORDER BY snapshot_version ASC LIMIT ?',
        streamId,
        after,
        limit
      )
      .map(readStoredSnapshot)
  }

  countSnapshots(): number {
    this.assertOpen()
    return requireSafeInteger(
      this.adapter.get('SELECT COUNT(*) AS value FROM snapshots')?.value,
      'snapshot count'
    )
  }

  recoverStream(streamId: string, options: { eventLimit?: number } = {}): RecoveryBundle {
    this.assertOpen()
    requireInputString(streamId, 'streamId')
    if (!isPlainRecord(options)) throw new TypeError('options must be a plain object.')
    const limit = options.eventLimit ?? MAX_READ_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_READ_LIMIT)
      throw new RangeError(`eventLimit must be an integer between 0 and ${MAX_READ_LIMIT}.`)
    this.adapter.exec('BEGIN')
    try {
      const snapshotRow = this.adapter.get(
        'SELECT * FROM snapshots WHERE stream_id = ? ORDER BY snapshot_version DESC LIMIT 1',
        streamId
      )
      const snapshot = snapshotRow ? readStoredSnapshot(snapshotRow) : null
      const rows = this.adapter.all(
        'SELECT * FROM events WHERE stream_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?',
        streamId,
        snapshot?.coveredSequence ?? -1,
        limit + 1
      )
      if (rows.length > limit) throw new RecoveryLimitExceededError(limit)
      const events = rows.map(readStoredEvent)
      for (let index = 1; index < events.length; index += 1)
        if (events[index].sequence <= events[index - 1].sequence)
          throw new CorruptEventStoreError('Recovery events are not strictly increasing.')
      const bundle = deepFreeze({ snapshot, events })
      this.adapter.exec('COMMIT')
      return bundle
    } catch (error) {
      try {
        this.adapter.exec('ROLLBACK')
      } catch {
        /* preserve recovery error */
      }
      throw error
    }
  }

  getStorageInfo(): StorageInfo {
    this.assertOpen()
    return {
      schemaVersion: pragmaInteger(this.adapter, 'user_version'),
      journalMode: pragmaText(this.adapter, 'journal_mode'),
      sqliteVersion: requireString(
        this.adapter.get('SELECT sqlite_version() AS value')?.value,
        'SQLite version'
      ),
      path: this.adapter.path
    }
  }

  checkpoint(mode: CheckpointMode): CheckpointResult {
    this.assertOpen()
    this.assertNotBackingUp()
    if (mode !== 'PASSIVE' && mode !== 'FULL' && mode !== 'TRUNCATE')
      throw new TypeError('Unsupported checkpoint mode.')
    const release = this.acquireWriteLock()
    try {
      const row = this.adapter.get(`PRAGMA wal_checkpoint(${mode})`)
      if (!row) throw new CorruptEventStoreError('SQLite checkpoint returned no result.')
      return {
        busy: requireSafeInteger(row.busy, 'checkpoint busy'),
        log: requireSafeInteger(row.log, 'checkpoint log'),
        checkpointed: requireSafeInteger(row.checkpointed, 'checkpointed frames')
      }
    } finally {
      release?.()
    }
  }

  close(): void {
    if (this.closed) return
    this.assertNotBackingUp()
    this.closed = true
    try {
      this.adapter.close()
    } finally {
      try {
        this.instanceLease?.release()
      } finally {
        this.instanceLease = undefined
        if (this.registryPath) decrementOpenStore(this.registryPath)
      }
    }
  }

  async createBackup(
    targetPath: string,
    options: { createdAt?: number; rate?: number } = {}
  ): Promise<import('./backupRestore').BackupManifest> {
    this.assertOpen()
    const registryPath = this.registryPath
    if (!registryPath) throw new BackupInProgressError()
    const state = openStoreRegistry.get(registryPath)
    if (!state || state.backupCount > 0) throw new BackupInProgressError()
    state.backupCount += 1
    let release: (() => void) | undefined
    try {
      release = this.acquireWriteLock()
      const { _internalCreateEventStoreBackup } = await import('./backupRestore')
      return await _internalCreateEventStoreBackup(this.adapter, targetPath, options)
    } finally {
      try {
        release?.()
      } finally {
        state.backupCount -= 1
      }
    }
  }

  private initialize(): void {
    const state = validateDatabase(this.adapter, false)
    this.configureConnection()
    if (state === 'empty') {
      this.setWal()
      this.createSchema()
      validateExistingSchema(this.adapter, 3)
      this.setSynchronousNormal()
      return
    }
    this.setWal()
    if (state === 'v1') this.migrateV1()
    if (state === 'v1' || state === 'v2') this.migrateV2()
    else validateExistingSchema(this.adapter, 3)
    this.setSynchronousNormal()
  }

  private configureConnection(): void {
    this.adapter.exec('PRAGMA foreign_keys = ON')
    this.adapter.exec(`PRAGMA busy_timeout = ${this.adapter.timeout}`)
    this.adapter.exec('PRAGMA trusted_schema = OFF')
    if (pragmaInteger(this.adapter, 'foreign_keys') !== 1)
      throw new UnsupportedEventStoreError('SQLite foreign key enforcement could not be enabled.')
  }

  private setWal(): void {
    const mode = pragmaTextSet(this.adapter, 'journal_mode', 'WAL')
    if (this.adapter.path !== ':memory:' && mode.toLowerCase() !== 'wal')
      throw new UnsupportedEventStoreError(`SQLite refused WAL journal mode: ${mode}.`)
  }

  private setSynchronousNormal(): void {
    this.adapter.exec('PRAGMA synchronous = NORMAL')
  }

  private createSchema(): void {
    this.adapter.exec('BEGIN IMMEDIATE')
    try {
      this.adapter.exec(`${SCHEMA_METADATA_DDL};
      ${EVENTS_DDL};
      ${IDEMPOTENCY_INDEX_DDL};
      ${STREAM_INDEX_DDL};
      ${CREATED_AT_INDEX_DDL};
      ${SNAPSHOTS_DDL};
      ${SNAPSHOT_VERSION_INDEX_DDL};
      ${SNAPSHOT_COVERED_INDEX_DDL};
      ${RESOURCES_DDL};
      ${RESOURCES_KIND_DELETED_UPDATED_INDEX_DDL};
      ${RESOURCES_UPDATED_INDEX_DDL};
      ${RESOURCE_MUTATIONS_DDL};
      ${RESOURCE_MUTATIONS_RESOURCE_REVISION_INDEX_DDL};
      ${RESOURCE_MUTATIONS_CREATED_INDEX_DDL};
      PRAGMA application_id = ${EVENT_STORE_APPLICATION_ID};
      PRAGMA user_version = ${EVENT_STORE_SCHEMA_VERSION};`)
      const now = Date.now()
      const metadata = this.adapter.prepare(
        'INSERT INTO schema_metadata (key, value, updated_at) VALUES (?, ?, ?)'
      )
      metadata.run('schema_version', String(EVENT_STORE_SCHEMA_VERSION), now)
      metadata.run('created_at', String(now), now)
      validateExistingSchema(this.adapter, 3)
      this.adapter.exec('COMMIT')
    } catch (error) {
      try {
        this.adapter.exec('ROLLBACK')
      } catch {
        /* preserve initialization error */
      }
      throw error
    }
  }

  private migrateV1(): void {
    validateExistingSchema(this.adapter, 1)
    this.adapter.exec('BEGIN IMMEDIATE')
    try {
      if (
        pragmaInteger(this.adapter, 'application_id') !== EVENT_STORE_APPLICATION_ID ||
        pragmaInteger(this.adapter, 'user_version') !== 1
      )
        throw new UnsupportedEventStoreError('Event Store identity changed during migration.')
      validateExistingSchema(this.adapter, 1)
      this.adapter.exec(
        `${SNAPSHOTS_DDL}; ${SNAPSHOT_VERSION_INDEX_DDL}; ${SNAPSHOT_COVERED_INDEX_DDL};`
      )
      const now = Date.now()
      this.adapter
        .prepare('UPDATE schema_metadata SET value = ?, updated_at = ? WHERE key = ?')
        .run('2', now, 'schema_version')
      this.adapter
        .prepare(
          `INSERT INTO schema_metadata (key, value, updated_at) VALUES ('migrated_at', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(String(now), now)
      this.adapter.exec('PRAGMA user_version = 2')
      validateExistingSchema(this.adapter, 2)
      this.adapter.exec('COMMIT')
    } catch (error) {
      try {
        this.adapter.exec('ROLLBACK')
      } catch {
        /* preserve error */
      }
      throw error
    }
    validateExistingSchema(this.adapter, 2)
  }

  private migrateV2(): void {
    validateExistingSchema(this.adapter, 2)
    this.adapter.exec('BEGIN IMMEDIATE')
    try {
      this.adapter.exec(`${RESOURCES_DDL}; ${RESOURCES_KIND_DELETED_UPDATED_INDEX_DDL};
        ${RESOURCES_UPDATED_INDEX_DDL}; ${RESOURCE_MUTATIONS_DDL};
        ${RESOURCE_MUTATIONS_RESOURCE_REVISION_INDEX_DDL}; ${RESOURCE_MUTATIONS_CREATED_INDEX_DDL};`)
      const now = Date.now()
      this.adapter
        .prepare('UPDATE schema_metadata SET value = ?, updated_at = ? WHERE key = ?')
        .run('3', now, 'schema_version')
      this.adapter
        .prepare(
          `INSERT INTO schema_metadata (key, value, updated_at) VALUES ('migrated_to_v3_at', ?, ?)`
        )
        .run(String(now), now)
      this.adapter
        .prepare(
          `INSERT INTO schema_metadata (key, value, updated_at) VALUES ('migrated_from_version', '2', ?)`
        )
        .run(now)
      this.adapter.exec('PRAGMA user_version = 3')
      validateExistingSchema(this.adapter, 3)
      this.adapter.exec('COMMIT')
    } catch (error) {
      try {
        this.adapter.exec('ROLLBACK')
      } catch {
        /* preserve error */
      }
      throw error
    }
    validateExistingSchema(this.adapter, 3)
  }

  private acquireWriteLock(): (() => void) | undefined {
    if (!this.databasePath) return undefined
    try {
      return acquireEventStoreWriteLock(this.databasePath)
    } catch (error) {
      if (isFsError(error, 'ELOCKED')) throw new EventStoreWriteLockedError(error)
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new EventStoreClosedError()
  }

  private assertNotBackingUp(): void {
    if (this.registryPath && (openStoreRegistry.get(this.registryPath)?.backupCount ?? 0) > 0)
      throw new BackupInProgressError()
  }
}

function decrementOpenStore(path: string): void {
  const state = openStoreRegistry.get(path)
  if (!state) return
  state.openCount -= 1
  if (state.openCount <= 0 && state.backupCount <= 0) openStoreRegistry.delete(path)
}

export function _isEventStorePathOpen(path: string): boolean {
  return (openStoreRegistry.get(normalizeFilePath(path))?.openCount ?? 0) > 0
}

function appendPreparedEvent(
  adapter: NodeSQLiteAdapter,
  candidate: StoredEvent,
  options: { requireInserted?: boolean } = {}
): AppendResult {
  const byId = adapter.get('SELECT * FROM events WHERE event_id = ?', candidate.event.id)
  if (byId) {
    if (canonicalStoredRow(byId) === candidate.canonical) {
      if (options.requireInserted)
        throw new EventStoreConflictError('Resource mutation event already exists.')
      return resultFor(candidate, false)
    }
    throw new EventStoreConflictError(`eventId conflict: ${candidate.event.id}.`)
  }
  if (candidate.idempotencyKey) {
    const byKey = adapter.get(
      'SELECT * FROM events WHERE idempotency_key = ?',
      candidate.idempotencyKey
    )
    if (byKey) {
      if (canonicalStoredRow(byKey) === candidate.canonical) {
        if (options.requireInserted)
          throw new EventStoreConflictError('Resource mutation event already exists.')
        return resultFor(candidate, false)
      }
      throw new EventStoreConflictError(`idempotencyKey conflict: ${candidate.idempotencyKey}.`)
    }
  }
  if (
    adapter.get(
      'SELECT event_id FROM events WHERE stream_id = ? AND sequence = ?',
      candidate.event.streamId,
      candidate.event.sequence
    )
  )
    throw new EventStoreConflictError(
      `stream sequence conflict: ${candidate.event.streamId}@${candidate.event.sequence}.`
    )
  const coverage = adapter.get(
    'SELECT MAX(covered_sequence) AS value FROM snapshots WHERE stream_id = ?',
    candidate.event.streamId
  )?.value
  if (
    coverage !== null &&
    coverage !== undefined &&
    candidate.event.sequence <= requireSafeInteger(coverage, 'snapshot coverage')
  )
    throw new EventStoreConflictError('event sequence is covered by snapshot')
  const event = candidate.event
  adapter
    .prepare(
      `INSERT INTO events (
      event_id, protocol_version, stream_id, sequence, type, created_at,
      correlation_id, causation_id, idempotency_key, payload_json, envelope_json, inserted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.id,
      event.protocolVersion,
      event.streamId,
      event.sequence,
      event.type,
      event.createdAt,
      event.correlationId ?? null,
      event.causationId ?? null,
      candidate.idempotencyKey ?? null,
      candidate.payloadJson,
      candidate.canonical,
      Date.now()
    )
  return resultFor(candidate, true)
}

function prepareSnapshot(
  input: SnapshotInput
): SnapshotInput & { stateJson: string; metadataJson: string | null; canonical: string } {
  if (!input || typeof input !== 'object') throw new TypeError('snapshot input must be an object.')
  requireInputString(input.snapshotId, 'snapshotId')
  requireInputString(input.streamId, 'streamId')
  requireInputString(input.stateType, 'stateType')
  if (!Number.isSafeInteger(input.snapshotVersion) || input.snapshotVersion < 0)
    throw new RangeError('snapshotVersion is invalid.')
  if (!Number.isSafeInteger(input.coveredSequence) || input.coveredSequence < -1)
    throw new RangeError('coveredSequence is invalid.')
  if (!Number.isFinite(input.createdAt) || input.createdAt < 0)
    throw new RangeError('createdAt must be finite and non-negative.')
  const stateJson = canonicalJson(input.state)
  const metadataJson = input.metadata === undefined ? null : canonicalJson(input.metadata)
  const canonical = canonicalJson({
    snapshotId: input.snapshotId,
    streamId: input.streamId,
    snapshotVersion: input.snapshotVersion,
    coveredSequence: input.coveredSequence,
    stateType: input.stateType,
    state: input.state,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    createdAt: input.createdAt
  })
  return { ...input, stateJson, metadataJson, canonical }
}
function readStoredSnapshot(row: SQLiteRow): StoredSnapshot {
  try {
    const stateJson = requireString(row.state_json, 'state_json')
    const state = parseCanonicalJson(stateJson, 'state_json')
    const metadataJson = row.metadata_json
    const snapshot: StoredSnapshot = {
      snapshotId: requireNonEmptyStoredString(row.snapshot_id, 'snapshot_id'),
      streamId: requireNonEmptyStoredString(row.stream_id, 'stream_id'),
      snapshotVersion: requireNonNegativeSafeInteger(row.snapshot_version, 'snapshot_version'),
      coveredSequence: requireCoveredSequence(row.covered_sequence),
      stateType: requireNonEmptyStoredString(row.state_type, 'state_type'),
      state,
      ...(metadataJson === null
        ? {}
        : {
            metadata: parseCanonicalJson(
              requireString(metadataJson, 'metadata_json'),
              'metadata_json'
            )
          }),
      createdAt: requireNonNegativeFinite(row.created_at, 'created_at'),
      insertedAt: requireNonNegativeFinite(row.inserted_at, 'inserted_at')
    }
    return deepFreeze(snapshot)
  } catch (error) {
    if (error instanceof CorruptEventStoreError) throw error
    throw new CorruptEventStoreError('Stored snapshot is invalid or inconsistent.', error)
  }
}
function canonicalSnapshotRow(row: SQLiteRow): string {
  const value = readStoredSnapshot(row)
  return canonicalJson({
    snapshotId: value.snapshotId,
    streamId: value.streamId,
    snapshotVersion: value.snapshotVersion,
    coveredSequence: value.coveredSequence,
    stateType: value.stateType,
    state: value.state,
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
    createdAt: value.createdAt
  })
}
function snapshotResult(item: SnapshotInput, inserted: boolean): AppendSnapshotResult {
  return {
    snapshotId: item.snapshotId,
    streamId: item.streamId,
    snapshotVersion: item.snapshotVersion,
    inserted
  }
}
export function parseCanonicalJson(value: string, name = 'JSON'): unknown {
  const parsed = parseJsonColumn(value, name)
  if (canonicalJson(parsed) !== value)
    throw new CorruptEventStoreError(`${name} is not canonical JSON.`)
  return deepFreeze(parsed)
}
export function deepFreeze<T>(value: T): T {
  // Intentionally limited to already validated JSON-safe plain clones.
  const seen = new WeakSet<object>()
  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object' || seen.has(current)) return
    seen.add(current)
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
    } else {
      for (const key of Object.keys(current)) visit((current as Record<string, unknown>)[key])
    }
    if (!Object.isFrozen(current)) Object.freeze(current)
  }
  visit(value)
  return value
}
export function restoreWithReducer<T>(
  bundle: RecoveryBundle,
  initialState: T,
  reducer: (state: T, event: MagicAgentEvent<unknown>) => T,
  decodeSnapshot?: (state: unknown, stateType: string) => T
): Readonly<{ state: T; lastSequence: number; snapshotVersion?: number }> {
  let snapshot: StoredSnapshot | null
  let events: MagicAgentEvent<unknown>[]
  try {
    if (!isPlainRecord(bundle) || !Array.isArray(bundle.events)) throw new Error('invalid shape')
    snapshot = bundle.snapshot === null ? null : validateStoredSnapshot(bundle.snapshot)
    events = bundle.events.map((candidate) => {
      const parsed = parseMagicAgentEvent(candidate)
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.value
    })
  } catch (error) {
    throw new RecoveryBundleError(error)
  }
  if (snapshot && !decodeSnapshot)
    throw new TypeError('decodeSnapshot is required when a snapshot is present.')
  let expectedStreamId = snapshot?.streamId
  let lastSequence = snapshot?.coveredSequence ?? -1
  let state: T
  if (snapshot) {
    try {
      state = decodeSnapshot!(snapshot.state, snapshot.stateType)
    } catch (error) {
      throw new RecoverySnapshotDecodeError(error)
    }
    state = canonicalStateClone(state, 'snapshot-decode')
  } else state = canonicalStateClone(initialState, 'initial')
  for (const event of events) {
    if (expectedStreamId === undefined) expectedStreamId = event.streamId
    if (event.streamId !== expectedStreamId || event.sequence <= lastSequence)
      throw new RecoveryBundleError(new Error('stream or sequence is invalid'))
    try {
      state = reducer(state, event)
    } catch (error) {
      throw new RecoveryReducerError(event.id, error)
    }
    state = canonicalStateClone(state, 'reducer', event.id)
    lastSequence = event.sequence
  }
  state = canonicalStateClone(state, 'final')
  return deepFreeze({
    state,
    lastSequence,
    ...(snapshot ? { snapshotVersion: snapshot.snapshotVersion } : {})
  })
}

function validateStoredSnapshot(value: unknown): StoredSnapshot {
  if (!isPlainRecord(value)) throw new Error('snapshot is not a plain record')
  const allowed = new Set([
    'snapshotId',
    'streamId',
    'snapshotVersion',
    'coveredSequence',
    'stateType',
    'state',
    'metadata',
    'createdAt',
    'insertedAt'
  ])
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key)))
    throw new Error('snapshot has unexpected fields')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('unsafe snapshot field')
  }
  prepareSnapshot(value as unknown as SnapshotInput)
  const insertedAt = (value as Record<string, unknown>).insertedAt
  if (typeof insertedAt !== 'number' || !Number.isFinite(insertedAt) || insertedAt < 0)
    throw new Error('insertedAt is invalid')
  return deepFreeze(JSON.parse(canonicalJson(value)) as StoredSnapshot)
}

function canonicalStateClone<T>(
  value: T,
  stage: RecoveryStateValidationStage,
  eventId?: string
): T {
  try {
    return deepFreeze(JSON.parse(canonicalJson(value)) as T)
  } catch (error) {
    throw new RecoveryStateValidationError(stage, eventId, error)
  }
}

function prepareEvent(input: MagicAgentEvent<unknown>): StoredEvent {
  const canonical = canonicalJson(input)
  const parsed = parseMagicAgentEvent(input)
  if (!parsed.ok) throw new TypeError(`Invalid MagicAgentEvent: ${parsed.error}`)
  const record = parsed.value as Record<string, unknown>
  const idempotencyValue = record.idempotencyKey
  if (
    idempotencyValue !== undefined &&
    (typeof idempotencyValue !== 'string' || idempotencyValue.trim().length === 0)
  )
    throw new TypeError('Invalid MagicAgentEvent: idempotencyKey must be a non-empty string.')
  return {
    event: parsed.value,
    canonical,
    idempotencyKey: typeof idempotencyValue === 'string' ? idempotencyValue : undefined,
    payloadJson: canonicalJson(parsed.value.payload)
  }
}

function readStoredEvent(row: SQLiteRow): MagicAgentEvent<unknown> {
  try {
    const envelopeJson = requireString(row.envelope_json, 'envelope_json')
    const event = parseJsonColumn(envelopeJson, 'envelope_json')
    const parsed = parseMagicAgentEvent(event)
    if (!parsed.ok) throw new Error(parsed.error)
    const record = parsed.value as Record<string, unknown>
    compare(row.protocol_version, parsed.value.protocolVersion, 'protocol_version')
    compare(row.event_id, parsed.value.id, 'event_id')
    compare(row.stream_id, parsed.value.streamId, 'stream_id')
    compare(row.sequence, parsed.value.sequence, 'sequence')
    compare(row.type, parsed.value.type, 'type')
    compare(row.created_at, parsed.value.createdAt, 'created_at')
    compareNullable(row.correlation_id, parsed.value.correlationId, 'correlation_id')
    compareNullable(row.causation_id, parsed.value.causationId, 'causation_id')
    compareNullable(row.idempotency_key, record.idempotencyKey, 'idempotency_key')
    if (requireString(row.payload_json, 'payload_json') !== canonicalJson(parsed.value.payload))
      throw new Error('payload_json does not match envelope')
    if (canonicalJson(parsed.value) !== envelopeJson)
      throw new Error('envelope_json is not canonical')
    return deepFreeze(parsed.value)
  } catch (error) {
    if (error instanceof CorruptEventStoreError) throw error
    throw new CorruptEventStoreError('Stored event is invalid or inconsistent.', error)
  }
}
function canonicalStoredRow(row: SQLiteRow): string {
  readStoredEvent(row)
  return requireString(row.envelope_json, 'envelope_json')
}

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const visit = (current: unknown): string => {
    if (current === null) return 'null'
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current)
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('JSON numbers must be finite.')
      return JSON.stringify(current)
    }
    if (typeof current !== 'object') throw new TypeError('Value is not JSON-safe.')
    if (utilTypes.isProxy(current)) throw new TypeError('Proxies are not JSON-safe.')
    if (ancestors.has(current)) throw new TypeError('Cyclic values are not JSON-safe.')
    ancestors.add(current)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current)
      if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol'))
        throw new TypeError('Symbol JSON keys are not allowed.')
      if (Array.isArray(current)) {
        if (Object.keys(descriptors).some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))
          throw new TypeError('Arrays may not have named fields.')
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)]
          if (!descriptor) throw new TypeError('Sparse arrays are not JSON-safe.')
          if (!descriptor.enumerable || !('value' in descriptor))
            throw new TypeError('Array fields must be enumerable data fields.')
        }
        return `[${Array.from({ length: current.length }, (_, index) => visit(descriptors[String(index)].value)).join(',')}]`
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Only plain objects are JSON-safe.')
      const fields = Object.keys(descriptors)
        .sort()
        .map((key) => {
          if (DANGEROUS_KEYS.has(key)) throw new TypeError(`Dangerous JSON key: ${key}.`)
          const descriptor = descriptors[key]
          if (!descriptor.enumerable)
            throw new TypeError('Non-enumerable JSON fields are not allowed.')
          if (!('value' in descriptor)) throw new TypeError('JSON getters are not allowed.')
          return `${JSON.stringify(key)}:${visit(descriptor.value)}`
        })
      return `{${fields.join(',')}}`
    } finally {
      ancestors.delete(current)
    }
  }
  return visit(value)
}

function inspectDatabasePath(path: string): InspectedDatabasePath {
  if (path === ':memory:') return {}
  try {
    const absolutePath = resolve(path)
    const parent = dirname(absolutePath)
    assertNoSymlinkInExistingPath(parent, path)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink())
      throw new EventStoreOpenError(path, new Error('Symbolic links are not accepted.'))
    if (!stat.isFile())
      throw new EventStoreOpenError(path, new Error('Path is not a regular file.'))
    accessSync(path, fsConstants.R_OK | fsConstants.W_OK)
    const snapshot = capturePathSnapshot(path)
    return { snapshot, expectedRealPath: snapshot.realPath }
  } catch (error) {
    if (isFsError(error, 'ENOENT')) {
      try {
        const absolutePath = resolve(path)
        const parent = dirname(absolutePath)
        assertNoSymlinkInExistingPath(parent, path)
        mkdirSync(parent, { recursive: true })
        assertNoSymlinkInExistingPath(parent, path)
        return { expectedRealPath: join(realpathSync(parent), basename(absolutePath)) }
      } catch (parentError) {
        if (parentError instanceof EventStoreOpenError) throw parentError
        throw new EventStoreOpenError(path, parentError)
      }
    }
    if (error instanceof EventStoreOpenError) throw error
    throw new EventStoreOpenError(path, error)
  }
}

function assertNoSymlinkInExistingPath(target: string, requestedPath: string): void {
  const absolute = resolve(target)
  const root = parse(absolute).root
  const relative = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  let current = root
  for (const segment of relative) {
    current = join(current, segment)
    let stat: Stats
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (isFsError(error, 'ENOENT')) break
      throw error
    }
    if (stat.isSymbolicLink())
      throw new EventStoreOpenError(
        requestedPath,
        new Error(`Symbolic links are not accepted in the database parent chain: ${current}.`)
      )
    const resolvedCurrent = realpathSync(current)
    if (
      process.platform === 'win32' &&
      normalizeFilePath(resolvedCurrent) !== normalizeFilePath(current)
    )
      throw new EventStoreOpenError(
        requestedPath,
        new Error(`Reparse-point parent paths are not accepted: ${current}.`)
      )
  }
}

function capturePathSnapshot(path: string): FileSnapshot {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new EventStoreOpenError(
      path,
      new Error('Database path is not a regular non-symbolic file.')
    )
  const snapshot = snapshotFromStats(realpathSync(path), statSync(path, { bigint: true }))
  assertStableFileIdentityAvailable(path, snapshot)
  return snapshot
}

function captureOpenedDatabaseSnapshot(
  adapter: NodeSQLiteAdapter,
  requestedPath: string
): FileSnapshot {
  try {
    const row = adapter.all('PRAGMA database_list').find((entry) => entry.name === 'main')
    if (typeof row?.file !== 'string' || row.file.length === 0)
      throw new Error('SQLite did not report the main database file.')
    return capturePathSnapshot(row.file)
  } catch (error) {
    throw error instanceof EventStoreOpenError
      ? error
      : new EventStoreOpenError(requestedPath, error)
  }
}

function snapshotFromStats(realPath: string, stat: BigIntStats): FileSnapshot {
  return { realPath, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}

function assertStableFileIdentityAvailable(path: string, snapshot: FileSnapshot): void {
  if (snapshot.dev === 0n || snapshot.ino === 0n)
    throw new EventStoreOpenError(path, new Error('Stable file identity is unavailable.'))
}

function assertSameFile(expected: FileSnapshot, actual: FileSnapshot, path: string): void {
  const sameRealPath = normalizeFilePath(expected.realPath) === normalizeFilePath(actual.realPath)
  const sameIdentity = expected.dev === actual.dev && expected.ino === actual.ino
  if (!sameRealPath || !sameIdentity)
    throw new EventStoreOpenError(path, new Error('Database file identity changed while opening.'))
}

function normalizeFilePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isFsError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

type PreparedResourceMutation = ResourceMutationInput & {
  canonical: string
  stateJson: string
}
function prepareResourceMutation(input: ResourceMutationInput): PreparedResourceMutation {
  if (!isPlainRecord(input))
    throw new ResourceValidationError('Resource mutation must be a plain object.')
  if (!['create', 'update', 'delete'].includes(input.operation))
    throw new ResourceValidationError('Invalid resource operation.')
  requireResourceString(input.kind, 'kind')
  requireResourceString(input.id, 'id')
  requireResourceString(input.idempotencyKey, 'idempotencyKey')
  if (!Number.isFinite(input.createdAt) || input.createdAt < 0)
    throw new ResourceValidationError('createdAt must be finite and non-negative.')
  if ('idempotencyKey' in input.event && input.event.idempotencyKey !== undefined)
    throw new ResourceValidationError('Resource mutation event idempotencyKey must be absent.')
  const event = prepareEvent(input.event).event
  if (input.operation === 'create') {
    if (input.expectedRevision !== undefined)
      throw new ResourceValidationError('create forbids expectedRevision.')
  } else if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision ?? -1) < 0) {
    throw new ResourceValidationError('update/delete require a non-negative expectedRevision.')
  }
  if (input.operation === 'delete' && input.state !== undefined)
    throw new ResourceValidationError('delete forbids state.')
  if (input.operation !== 'delete' && input.state === undefined)
    throw new ResourceValidationError('create/update require state.')
  if (input.operation !== 'delete') validateResourceState(input.kind, input.state)
  const stateJson = input.operation === 'delete' ? '' : canonicalJson(input.state)
  const state = input.operation === 'delete' ? undefined : parseCanonicalJson(stateJson, 'state')
  const commandValue: Record<string, unknown> = {
    operation: input.operation,
    kind: input.kind,
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
    event
  }
  if (input.expectedRevision !== undefined) commandValue.expectedRevision = input.expectedRevision
  if (input.operation !== 'delete') commandValue.state = state
  return { ...input, event, state, stateJson, canonical: canonicalJson(commandValue) }
}
function validatePreparedResourceMutationBatch(
  commands: readonly PreparedResourceMutation[]
): void {
  const idempotencyKeys = new Set<string>()
  const eventIds = new Set<string>()
  const streamSequences = new Set<string>()
  for (const command of commands) {
    const streamSequence = `${command.event.streamId}\u0000${command.event.sequence}`
    if (
      idempotencyKeys.has(command.idempotencyKey) ||
      eventIds.has(command.event.id) ||
      streamSequences.has(streamSequence)
    )
      throw new ResourceValidationError('Resource mutation batch contains duplicate identities.')
    idempotencyKeys.add(command.idempotencyKey)
    eventIds.add(command.event.id)
    streamSequences.add(streamSequence)
  }
}

function executePreparedResourceMutation(
  adapter: NodeSQLiteAdapter,
  command: PreparedResourceMutation,
  replay?: SQLiteRow
): ResourceMutationResult {
  if (replay) {
    const kind = requireNonEmptyStoredString(replay.resource_kind, 'resource kind')
    const id = requireNonEmptyStoredString(replay.resource_id, 'resource id')
    const chain = validateResourceMutationChain(
      adapter,
      adapter.get('SELECT * FROM resources WHERE resource_kind = ? AND resource_id = ?', kind, id),
      adapter.all(
        `SELECT * FROM resource_mutations WHERE resource_kind = ? AND resource_id = ?
        ORDER BY resulting_revision ASC`,
        kind,
        id
      )
    )
    const result = chain.find((mutation) => mutation.idempotencyKey === command.idempotencyKey)
    if (!result) throw new CorruptEventStoreError('Resource mutation chain is invalid.')
    readStoredMutation(adapter, replay, command.canonical)
    return { resource: result.resource, inserted: false }
  }
  const row = adapter.get(
    'SELECT * FROM resources WHERE resource_kind = ? AND resource_id = ?',
    command.kind,
    command.id
  )
  let resource: StoredResource
  if (command.operation === 'create') {
    if (row) throw new ResourceRevisionConflictError(command.kind, command.id)
    resource = deepFreeze({
      kind: command.kind,
      id: command.id,
      revision: 0,
      state: command.state,
      deleted: false,
      createdAt: command.createdAt,
      updatedAt: command.createdAt
    })
    adapter
      .prepare(
        `INSERT INTO resources
      (resource_kind, resource_id, revision, state_json, deleted, created_at, updated_at)
      VALUES (?, ?, 0, ?, 0, ?, ?)`
      )
      .run(command.kind, command.id, command.stateJson, command.createdAt, command.createdAt)
  } else {
    if (!row || row.deleted !== 0) throw new ResourceNotFoundError(command.kind, command.id)
    const current = readResource(row)
    if (command.expectedRevision !== current.revision || command.createdAt < current.updatedAt)
      throw new ResourceRevisionConflictError(command.kind, command.id)
    resource = deepFreeze({
      ...current,
      revision: current.revision + 1,
      state: command.operation === 'delete' ? current.state : command.state,
      deleted: command.operation === 'delete',
      updatedAt: command.createdAt
    })
    adapter
      .prepare(
        `UPDATE resources SET revision = ?, state_json = ?, deleted = ?, updated_at = ?
      WHERE resource_kind = ? AND resource_id = ?`
      )
      .run(
        resource.revision,
        canonicalJson(resource.state),
        resource.deleted ? 1 : 0,
        command.createdAt,
        command.kind,
        command.id
      )
  }
  appendPreparedEvent(adapter, prepareEvent(command.event), { requireInserted: true })
  adapter
    .prepare(
      `INSERT INTO resource_mutations
    (idempotency_key, resource_kind, resource_id, operation, expected_revision,
     resulting_revision, event_id, command_json, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      command.idempotencyKey,
      command.kind,
      command.id,
      command.operation,
      command.expectedRevision ?? null,
      resource.revision,
      command.event.id,
      command.canonical,
      canonicalJson({ resource, inserted: true }),
      command.createdAt
    )
  return { resource, inserted: true }
}
function validateResourceState(kind: string, state: unknown): void {
  if (!isPlainRecord(state))
    throw new ResourceValidationError('Resource state must be a plain record.')
  try {
    canonicalJson(state)
  } catch (error) {
    throw new ResourceValidationError('Resource state must be JSON-safe.', error)
  }
  if (
    kind === 'approval' &&
    (typeof state.status !== 'string' ||
      state.status.trim().length === 0 ||
      state.status !== state.status.trim())
  )
    throw new ResourceValidationError('Approval state requires status.')
  if (kind === 'artifact') {
    const forbidden = ['content', 'data', 'absolutePath', 'path', 'filePath', 'bytes', 'buffer']
    if (forbidden.some((key) => Object.hasOwn(state, key)))
      throw new ResourceValidationError('Artifact state contains forbidden content/path data.')
    if (state.storage === 'legacy-reference') {
      if (
        Object.hasOwn(state, 'normalizedRecord') ||
        Object.hasOwn(state, 'rawRecord') ||
        Object.hasOwn(state, 'rawDescriptor') ||
        Object.hasOwn(state, 'rawFile')
      )
        throw new ResourceValidationError('Legacy artifact state contains a plan-only record.')
      if (!isPlainRecord(state.legacyRef))
        throw new ResourceValidationError('Legacy artifact requires legacyRef.')
      const ref = state.legacyRef
      const allowedRefFields = new Set(['normalizedDescriptor', 'omittedFields'])
      if (Object.keys(ref).some((key) => !allowedRefFields.has(key)))
        throw new ResourceValidationError('Legacy artifact reference contains an unknown field.')
      if (forbidden.some((key) => Object.hasOwn(ref, key)))
        throw new ResourceValidationError(
          'Legacy artifact reference contains forbidden content/path data.'
        )
      requireResourceString(state.artifactId, 'artifactId')
      requireResourceString(state.source, 'source')
      for (const key of ['runId', 'kind'])
        if (state[key] !== undefined) requireResourceString(state[key], key)
      if (!Number.isFinite(state.createdAt) || (state.createdAt as number) < 0)
        throw new ResourceValidationError('Invalid legacy artifact createdAt.')
      const normalizedDescriptor = ref.normalizedDescriptor
      if (!isPlainRecord(normalizedDescriptor))
        throw new ResourceValidationError('Legacy artifact requires normalizedDescriptor.')
      const duplicatedIdentityFields = ['artifactId', 'runId', 'kind', 'source', 'createdAt']
      if (duplicatedIdentityFields.some((key) => Object.hasOwn(normalizedDescriptor, key)))
        throw new ResourceValidationError(
          'Legacy artifact normalizedDescriptor duplicates an identity field.'
        )
      if (
        !Array.isArray(ref.omittedFields) ||
        ref.omittedFields.some(
          (field) => typeof field !== 'string' || field.length === 0 || field !== field.trim()
        )
      )
        throw new ResourceValidationError('Invalid legacy artifact omittedFields.')
      return
    }
    if (state.storage !== undefined && state.storage !== 'managed')
      throw new ResourceValidationError('Invalid artifact storage discriminator.')
    if (typeof state.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(state.sha256))
      throw new ResourceValidationError('Invalid artifact sha256.')
    if (typeof state.mimeType !== 'string' || state.mimeType.trim().length === 0)
      throw new ResourceValidationError('Invalid artifact mimeType.')
    if (!Number.isSafeInteger(state.size) || (state.size as number) < 0)
      throw new ResourceValidationError('Invalid artifact size.')
    if (typeof state.relativePath !== 'string' || !validRelativePath(state.relativePath))
      throw new ResourceValidationError('Invalid artifact relativePath.')
  }
}
function validRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  )
    return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return false
  }
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}
function requireResourceString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim())
    throw new ResourceValidationError(`${name} must be non-empty and trimmed.`)
}
function readResource(row: SQLiteRow): StoredResource {
  try {
    const stateJson = requireString(row.state_json, 'resource state_json')
    const state = parseCanonicalJson(stateJson, 'resource state_json')
    if (!isPlainRecord(state)) throw new CorruptEventStoreError('Resource state is not a record.')
    const kind = requireNonEmptyStoredString(row.resource_kind, 'resource kind')
    try {
      validateResourceState(kind, state)
    } catch (error) {
      throw new CorruptEventStoreError('Stored resource state is invalid.', error)
    }
    const createdAt = requireNonNegativeFinite(row.created_at, 'resource created_at')
    const updatedAt = requireNonNegativeFinite(row.updated_at, 'resource updated_at')
    if (updatedAt < createdAt) throw new CorruptEventStoreError('Resource timestamps are invalid.')
    if (row.deleted !== 0 && row.deleted !== 1)
      throw new CorruptEventStoreError('Resource deleted flag is invalid.')
    return deepFreeze({
      kind,
      id: requireNonEmptyStoredString(row.resource_id, 'resource id'),
      revision: requireNonNegativeSafeInteger(row.revision, 'resource revision'),
      state,
      deleted: row.deleted === 1,
      createdAt,
      updatedAt
    })
  } catch (error) {
    if (error instanceof CorruptEventStoreError) throw error
    throw new CorruptEventStoreError('Stored resource is invalid.', error)
  }
}
function readMutationResult(
  row: SQLiteRow,
  operation: 'create' | 'update' | 'delete',
  expectedRevision: number | undefined
): { resource: StoredResource; inserted: true } {
  const value = parseCanonicalJson(
    requireString(row.result_json, 'mutation result'),
    'mutation result'
  )
  if (!isPlainRecord(value) || value.inserted !== true || !isPlainRecord(value.resource))
    throw new CorruptEventStoreError('Invalid mutation result.')
  const raw = value.resource
  const resource = readResource({
    resource_kind: raw.kind,
    resource_id: raw.id,
    revision: raw.revision,
    state_json: canonicalJson(raw.state),
    deleted: raw.deleted === true ? 1 : raw.deleted === false ? 0 : raw.deleted,
    created_at: raw.createdAt,
    updated_at: raw.updatedAt
  })
  const expectedDeleted = operation === 'delete'
  const expectedResultingRevision = operation === 'create' ? 0 : (expectedRevision as number) + 1
  if (
    resource.kind !== row.resource_kind ||
    resource.id !== row.resource_id ||
    resource.revision !== row.resulting_revision ||
    resource.revision !== expectedResultingRevision ||
    resource.deleted !== expectedDeleted ||
    resource.updatedAt !== row.created_at ||
    (operation === 'create' && resource.createdAt !== row.created_at)
  )
    throw new CorruptEventStoreError('Mutation result does not match columns or operation.')
  return { resource, inserted: true }
}
function readStoredMutation(
  adapter: NodeSQLiteAdapter,
  row: SQLiteRow,
  expectedCanonical?: string
): StoredResourceMutation {
  const commandJson = requireString(row.command_json, 'mutation command')
  const command = parseCanonicalJson(commandJson, 'mutation command')
  if (!isPlainRecord(command) || !isPlainRecord(command.event))
    throw new CorruptEventStoreError('Invalid mutation command.')
  const operation = requireString(row.operation, 'operation')
  if (!['create', 'update', 'delete'].includes(operation))
    throw new CorruptEventStoreError('Invalid mutation operation.')
  const typedOperation = operation as 'create' | 'update' | 'delete'
  const expected =
    row.expected_revision === null
      ? undefined
      : requireNonNegativeSafeInteger(row.expected_revision, 'expected revision')
  const parsed = parseMagicAgentEvent(command.event)
  if (!parsed.ok) throw new CorruptEventStoreError('Invalid mutation command event.')
  const eventId = requireNonEmptyStoredString(row.event_id, 'event id')
  const eventRow = adapter.get('SELECT * FROM events WHERE event_id = ?', eventId)
  if (!eventRow) throw new CorruptEventStoreError('Mutation event is missing.')
  const storedEvent = readStoredEvent(eventRow)
  if (canonicalJson(parsed.value) !== canonicalJson(storedEvent))
    throw new CorruptEventStoreError('Mutation command event does not match stored event.')
  const hasExpected = Object.hasOwn(command, 'expectedRevision')
  const hasState = Object.hasOwn(command, 'state')
  if (
    command.operation !== operation ||
    command.kind !== row.resource_kind ||
    command.id !== row.resource_id ||
    command.idempotencyKey !== row.idempotency_key ||
    command.createdAt !== row.created_at ||
    parsed.value.id !== eventId ||
    (expected === undefined
      ? hasExpected
      : !hasExpected || command.expectedRevision !== expected) ||
    (typedOperation === 'delete' ? hasState : !hasState) ||
    (typedOperation === 'create' ? expected !== undefined : expected === undefined)
  )
    throw new CorruptEventStoreError('Mutation command does not match columns or operation.')
  const result = readMutationResult(row, typedOperation, expected)
  if (
    typedOperation !== 'delete' &&
    canonicalJson(command.state) !== canonicalJson(result.resource.state)
  )
    throw new CorruptEventStoreError('Mutation command state does not match result.')
  if (expectedCanonical !== undefined && commandJson !== expectedCanonical)
    throw new EventStoreConflictError('Resource mutation idempotency conflict.')
  return deepFreeze({
    idempotencyKey: requireNonEmptyStoredString(row.idempotency_key, 'mutation key'),
    operation: typedOperation,
    resource: result.resource,
    ...(expected === undefined ? {} : { expectedRevision: expected }),
    eventId,
    createdAt: requireNonNegativeFinite(row.created_at, 'mutation created_at')
  })
}

function invalidResourceMutationChain(cause?: unknown): CorruptEventStoreError {
  return new CorruptEventStoreError('Resource mutation chain is invalid.', cause)
}

function validateResourceMutationChain(
  adapter: NodeSQLiteAdapter,
  resourceRow: SQLiteRow | undefined,
  rows: SQLiteRow[]
): StoredResourceMutation[] {
  try {
    if (!resourceRow || rows.length === 0) throw new Error('resource and mutation chain must exist')
    const current = readResource(resourceRow)
    const mutations = rows.map((row) => readStoredMutation(adapter, row))
    let previous: StoredResourceMutation | undefined
    for (const mutation of mutations) {
      const resource = mutation.resource
      if (resource.kind !== current.kind || resource.id !== current.id)
        throw new Error('mutation resource identity mismatch')
      if (!previous) {
        if (
          mutation.operation !== 'create' ||
          mutation.expectedRevision !== undefined ||
          resource.revision !== 0 ||
          resource.deleted
        )
          throw new Error('invalid first mutation')
      } else {
        if (previous.resource.deleted) throw new Error('mutation follows delete')
        if (
          mutation.operation === 'create' ||
          mutation.expectedRevision !== previous.resource.revision ||
          resource.revision !== previous.resource.revision + 1 ||
          mutation.createdAt < previous.createdAt ||
          resource.createdAt !== previous.resource.createdAt
        )
          throw new Error('mutation continuity mismatch')
        if (mutation.operation === 'update' && resource.deleted)
          throw new Error('update produced tombstone')
        if (
          mutation.operation === 'delete' &&
          (!resource.deleted ||
            canonicalJson(resource.state) !== canonicalJson(previous.resource.state))
        )
          throw new Error('invalid delete result')
      }
      previous = mutation
    }
    if (canonicalJson(previous?.resource) !== canonicalJson(current))
      throw new Error('last mutation does not match resource')
    return mutations
  } catch (error) {
    throw invalidResourceMutationChain(error)
  }
}

export function validateAllResourceMutationChains(adapter: NodeSQLiteAdapter): void {
  try {
    const resources = adapter.all('SELECT * FROM resources ORDER BY resource_kind, resource_id')
    const mutations = adapter.all(
      `SELECT * FROM resource_mutations
      ORDER BY resource_kind, resource_id, resulting_revision`
    )
    const rowsByResource = new Map<string, SQLiteRow[]>()
    for (const row of mutations) {
      const key = canonicalJson([String(row.resource_kind), String(row.resource_id)])
      const rows = rowsByResource.get(key) ?? []
      rows.push(row)
      rowsByResource.set(key, rows)
    }
    for (const resourceRow of resources) {
      const key = canonicalJson([
        String(resourceRow.resource_kind),
        String(resourceRow.resource_id)
      ])
      const rows = rowsByResource.get(key) ?? []
      validateResourceMutationChain(adapter, resourceRow, rows)
      rowsByResource.delete(key)
    }
    if (rowsByResource.size !== 0) throw new Error('mutation references a missing resource')
  } catch (error) {
    if (
      error instanceof CorruptEventStoreError &&
      error.message === 'Resource mutation chain is invalid.'
    )
      throw error
    throw invalidResourceMutationChain(error)
  }
}

export function validateDatabase(
  adapter: NodeSQLiteAdapter,
  requireExisting: boolean
): 'empty' | 'v1' | 'v2' | 'v3' {
  const applicationId = pragmaInteger(adapter, 'application_id')
  const userVersion = pragmaInteger(adapter, 'user_version')
  const userObjects = adapter.all(`SELECT type, name FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')`)
  if (applicationId === 0 && userVersion === 0) {
    if (userObjects.length !== 0) {
      throw new UnsupportedEventStoreError(
        'Refusing to initialize a non-empty unidentified SQLite database.'
      )
    }
    return 'empty'
  }
  if (applicationId !== EVENT_STORE_APPLICATION_ID || ![1, 2, 3].includes(userVersion)) {
    throw new UnsupportedEventStoreError(
      `Unsupported Event Store identity (${applicationId}/${userVersion}).`
    )
  }
  validateExistingSchema(adapter, userVersion as 1 | 2 | 3)
  return userVersion === 1 ? 'v1' : userVersion === 2 ? 'v2' : 'v3'
}

function validateExistingSchema(adapter: NodeSQLiteAdapter, version: 1 | 2 | 3): void {
  try {
    validateSchemaObjectWhitelist(adapter, version)
    validateTable(adapter, 'schema_metadata', METADATA_COLUMNS)
    validateTable(adapter, 'events', EVENT_COLUMNS)
    if (version >= 2) validateTable(adapter, 'snapshots', SNAPSHOT_COLUMNS)
    if (version === 3) {
      const foreignKeyErrors = adapter.all('PRAGMA foreign_key_check')
      if (foreignKeyErrors.length !== 0)
        throw new CorruptEventStoreError('Event Store contains foreign key violations.')
      validateTable(adapter, 'resources', RESOURCE_COLUMNS)
      validateTable(adapter, 'resource_mutations', RESOURCE_MUTATION_COLUMNS)
    }
    validateSchemaSql(adapter, version)
    validateNamedIndex(
      adapter,
      'schema_metadata',
      'sqlite_autoindex_schema_metadata_1',
      ['key'],
      true,
      false,
      'pk'
    )
    validateNamedIndex(
      adapter,
      'events',
      'sqlite_autoindex_events_1',
      ['event_id'],
      true,
      false,
      'pk'
    )
    validateNamedIndex(
      adapter,
      'events',
      'sqlite_autoindex_events_2',
      ['stream_id', 'sequence'],
      true,
      false,
      'u'
    )
    validateNamedIndex(
      adapter,
      'events',
      'events_idempotency_key_unique',
      ['idempotency_key'],
      true,
      true,
      'c'
    )
    validateNamedIndex(
      adapter,
      'events',
      'events_stream_sequence_idx',
      ['stream_id', 'sequence'],
      false,
      false,
      'c'
    )
    validateNamedIndex(
      adapter,
      'events',
      'events_created_at_idx',
      ['created_at'],
      false,
      false,
      'c'
    )
    if (version >= 2) {
      validateNamedIndex(
        adapter,
        'snapshots',
        'sqlite_autoindex_snapshots_1',
        ['snapshot_id'],
        true,
        false,
        'pk'
      )
      validateNamedIndex(
        adapter,
        'snapshots',
        'sqlite_autoindex_snapshots_2',
        ['stream_id', 'snapshot_version'],
        true,
        false,
        'u'
      )
      validateNamedIndex(
        adapter,
        'snapshots',
        'snapshots_stream_version_idx',
        ['stream_id', 'snapshot_version'],
        false,
        false,
        'c',
        [0, 1]
      )
      validateNamedIndex(
        adapter,
        'snapshots',
        'snapshots_stream_covered_idx',
        ['stream_id', 'covered_sequence'],
        false,
        false,
        'c'
      )
    }
    if (version === 3) {
      validateNamedIndex(
        adapter,
        'resources',
        'sqlite_autoindex_resources_1',
        ['resource_kind', 'resource_id'],
        true,
        false,
        'pk'
      )
      validateNamedIndex(
        adapter,
        'resources',
        'resources_kind_deleted_updated_idx',
        ['resource_kind', 'deleted', 'updated_at'],
        false,
        false,
        'c'
      )
      validateNamedIndex(
        adapter,
        'resources',
        'resources_updated_at_idx',
        ['updated_at'],
        false,
        false,
        'c'
      )
      validateNamedIndex(
        adapter,
        'resource_mutations',
        'sqlite_autoindex_resource_mutations_1',
        ['idempotency_key'],
        true,
        false,
        'pk'
      )
      validateNamedIndex(
        adapter,
        'resource_mutations',
        'resource_mutations_resource_revision_idx',
        ['resource_kind', 'resource_id', 'resulting_revision'],
        false,
        false,
        'c'
      )
      validateNamedIndex(
        adapter,
        'resource_mutations',
        'resource_mutations_created_at_idx',
        ['created_at'],
        false,
        false,
        'c'
      )
      const fks = adapter
        .all('PRAGMA foreign_key_list(resource_mutations)')
        .sort((a, b) => Number(a.id) - Number(b.id) || Number(a.seq) - Number(b.seq))
      const groups = new Map<number, SQLiteRow[]>()
      for (const fk of fks) {
        const id = requireSafeInteger(fk.id, 'foreign key id')
        const group = groups.get(id) ?? []
        group.push(fk)
        groups.set(id, group)
        if (fk.on_update !== 'NO ACTION' || fk.on_delete !== 'NO ACTION' || fk.match !== 'NONE')
          throw new Error('invalid resource mutation foreign key actions')
      }
      const eventGroup = [...groups.values()].find(
        (rows) =>
          rows.length === 1 &&
          rows[0].seq === 0 &&
          rows[0].table === 'events' &&
          rows[0].from === 'event_id' &&
          rows[0].to === 'event_id'
      )
      const resourceGroup = [...groups.values()].find(
        (rows) =>
          rows.length === 2 &&
          rows[0].seq === 0 &&
          rows[1].seq === 1 &&
          rows.every((row) => row.table === 'resources') &&
          rows[0].from === 'resource_kind' &&
          rows[0].to === 'resource_kind' &&
          rows[1].from === 'resource_id' &&
          rows[1].to === 'resource_id'
      )
      if (fks.length !== 3 || groups.size !== 2 || !eventGroup || !resourceGroup)
        throw new Error('invalid resource mutation foreign keys')
    }
    const metadataRows = adapter.all('SELECT key, value, updated_at FROM schema_metadata')
    const allowedKeys =
      version === 1
        ? ['schema_version', 'created_at']
        : version === 2
          ? ['schema_version', 'created_at', 'migrated_at']
          : metadataRows.some((row) => row.key === 'migrated_at')
            ? [
                'schema_version',
                'created_at',
                'migrated_at',
                'migrated_to_v3_at',
                'migrated_from_version'
              ]
            : metadataRows.some((row) => row.key === 'migrated_to_v3_at')
              ? ['schema_version', 'created_at', 'migrated_to_v3_at', 'migrated_from_version']
              : ['schema_version', 'created_at']
    if (
      metadataRows.length !== allowedKeys.length ||
      metadataRows.some((row) => !allowedKeys.includes(String(row.key)))
    )
      throw new Error('unexpected metadata rows')
    const metadata = new Map(metadataRows.map((row) => [row.key, row]))
    if (metadata.size !== metadataRows.length) throw new Error('duplicate metadata rows')
    const versionRow = metadata.get('schema_version')
    const created = metadata.get('created_at')
    if (versionRow?.value !== String(version)) throw new Error('invalid schema_version metadata')
    const createdAt = typeof created?.value === 'string' ? Number(created.value) : Number.NaN
    if (!Number.isFinite(createdAt) || createdAt < 0) throw new Error('invalid created_at metadata')
    const migrated = metadata.get('migrated_at')
    if (version === 1 && migrated) throw new Error('unexpected migrated_at metadata')
    if (version === 2 && !migrated) throw new Error('missing migrated_at metadata')
    const migratedV3 = metadata.get('migrated_to_v3_at')
    const migratedFrom = metadata.get('migrated_from_version')
    if (version < 3 && (migratedV3 || migratedFrom))
      throw new Error('unexpected v3 migration metadata')
    if (version === 3 && migrated && !migratedV3)
      throw new Error('missing migrated_to_v3_at metadata')
    if (migratedV3) {
      if (migratedFrom?.value !== '2' || migratedFrom.updated_at !== migratedV3.updated_at)
        throw new Error('invalid migrated_from_version metadata')
      const value = typeof migratedV3.value === 'string' ? Number(migratedV3.value) : Number.NaN
      const updated = requireNonNegativeFinite(
        migratedV3.updated_at,
        'migrated_to_v3_at metadata updated_at'
      )
      const migratedAt =
        migrated && typeof migrated.value === 'string' ? Number(migrated.value) : createdAt
      if (!Number.isFinite(value) || value < migratedAt || value < createdAt || value !== updated)
        throw new Error('invalid migrated_to_v3_at metadata')
    }
    const versionUpdatedAt = requireNonNegativeFinite(
      versionRow.updated_at,
      'schema_version metadata updated_at'
    )
    const createdUpdatedAt = requireNonNegativeFinite(
      created?.updated_at,
      'created_at metadata updated_at'
    )
    const migratedUpdatedAt = migrated
      ? requireNonNegativeFinite(migrated.updated_at, 'migrated_at metadata updated_at')
      : undefined
    for (const row of metadataRows)
      requireNonNegativeFinite(row.updated_at, `${String(row.key)} metadata updated_at`)
    if (createdAt !== createdUpdatedAt) throw new Error('inconsistent created_at metadata')
    if (migrated) {
      const migratedAt = typeof migrated.value === 'string' ? Number(migrated.value) : Number.NaN
      if (!Number.isFinite(migratedAt) || migratedAt < createdAt)
        throw new Error('invalid migrated_at metadata')
      if (migratedAt !== migratedUpdatedAt) throw new Error('inconsistent migrated_at metadata')
      if (versionUpdatedAt < createdAt)
        throw new Error('invalid schema_version metadata updated_at')
    }
    if (version === 3) validateAllResourceMutationChains(adapter)
  } catch (error) {
    if (error instanceof CorruptEventStoreError) throw error
    throw new CorruptEventStoreError(`Event Store v${version} schema is invalid.`, error)
  }
}

export type EventStoreDatabaseCounts = Readonly<{
  events: number
  snapshots: number
  resources: number
  mutations: number
}>

export function validateEventStoreDatabaseV3(adapter: NodeSQLiteAdapter): Readonly<{
  counts: EventStoreDatabaseCounts
  sqliteVersion: string
}> {
  if (validateDatabase(adapter, true) !== 'v3')
    throw new UnsupportedEventStoreError('Backup/restore requires Event Store schema v3.')
  const integrity = adapter.all('PRAGMA integrity_check')
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
    throw new CorruptEventStoreError('SQLite integrity_check failed.')
  if (adapter.all('PRAGMA foreign_key_check').length !== 0)
    throw new CorruptEventStoreError('Event Store contains foreign key violations.')
  adapter.all('SELECT * FROM events ORDER BY event_id').forEach(readStoredEvent)
  adapter.all('SELECT * FROM snapshots ORDER BY snapshot_id').forEach(readStoredSnapshot)
  auditStreamHistory(adapter)
  adapter.all('SELECT * FROM resources ORDER BY resource_kind, resource_id').forEach(readResource)
  validateAllResourceMutationChains(adapter)
  const count = (table: string): number =>
    requireSafeInteger(
      adapter.get(`SELECT COUNT(*) AS value FROM ${table}`)?.value,
      `${table} count`
    )
  return deepFreeze({
    counts: {
      events: count('events'),
      snapshots: count('snapshots'),
      resources: count('resources'),
      mutations: count('resource_mutations')
    },
    sqliteVersion: requireString(
      adapter.get('SELECT sqlite_version() AS value')?.value,
      'SQLite version'
    )
  })
}

function auditStreamHistory(adapter: NodeSQLiteAdapter): void {
  const streams = new Set<string>()
  for (const row of adapter.all(
    'SELECT DISTINCT stream_id FROM events UNION SELECT DISTINCT stream_id FROM snapshots'
  ))
    streams.add(requireNonEmptyStoredString(row.stream_id, 'stream id'))
  for (const streamId of streams) {
    const events = adapter.all(
      'SELECT sequence, inserted_at FROM events WHERE stream_id = ? ORDER BY sequence ASC',
      streamId
    )
    let previousSequence = -1
    const sequences = new Set<number>()
    for (const row of events) {
      const sequence = requireSafeInteger(row.sequence, 'event sequence')
      if (sequence <= previousSequence)
        throw new CorruptEventStoreError('Event history is not strictly increasing.')
      previousSequence = sequence
      sequences.add(sequence)
    }
    const snapshots = adapter.all(
      'SELECT snapshot_version, covered_sequence, inserted_at FROM snapshots WHERE stream_id = ? ORDER BY snapshot_version ASC',
      streamId
    )
    let previousVersion = -1
    let previousCoverage = -2
    for (const row of snapshots) {
      const version = requireSafeInteger(row.snapshot_version, 'snapshot version')
      const coverage = requireSafeInteger(row.covered_sequence, 'snapshot coverage')
      if (version <= previousVersion || coverage <= previousCoverage)
        throw new CorruptEventStoreError('Snapshot history is not strictly increasing.')
      if (coverage === -1 ? events.length !== 0 : !sequences.has(coverage))
        throw new CorruptEventStoreError('Snapshot coverage does not identify an event.')
      previousVersion = version
      previousCoverage = coverage
    }
  }
}

function validateSchemaObjectWhitelist(adapter: NodeSQLiteAdapter, version: 1 | 2 | 3): void {
  const allowed = new Map([
    ['table:schema_metadata', 'schema_metadata'],
    ['table:events', 'events'],
    ['index:events_idempotency_key_unique', 'events'],
    ['index:events_stream_sequence_idx', 'events'],
    ['index:events_created_at_idx', 'events'],
    ['index:sqlite_autoindex_schema_metadata_1', 'schema_metadata'],
    ['index:sqlite_autoindex_events_1', 'events'],
    ['index:sqlite_autoindex_events_2', 'events']
  ])
  if (version >= 2) {
    allowed.set('table:snapshots', 'snapshots')
    allowed.set('index:sqlite_autoindex_snapshots_1', 'snapshots')
    allowed.set('index:sqlite_autoindex_snapshots_2', 'snapshots')
    allowed.set('index:snapshots_stream_version_idx', 'snapshots')
    allowed.set('index:snapshots_stream_covered_idx', 'snapshots')
  }
  if (version === 3) {
    allowed.set('table:resources', 'resources')
    allowed.set('index:sqlite_autoindex_resources_1', 'resources')
    allowed.set('index:resources_kind_deleted_updated_idx', 'resources')
    allowed.set('index:resources_updated_at_idx', 'resources')
    allowed.set('table:resource_mutations', 'resource_mutations')
    allowed.set('index:sqlite_autoindex_resource_mutations_1', 'resource_mutations')
    allowed.set('index:resource_mutations_resource_revision_idx', 'resource_mutations')
    allowed.set('index:resource_mutations_created_at_idx', 'resource_mutations')
  }
  const objects = adapter.all(`SELECT type, name, tbl_name FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')`)
  if (
    objects.length !== allowed.size ||
    objects.some((row) => {
      const expectedTable = allowed.get(`${String(row.type)}:${String(row.name)}`)
      return expectedTable === undefined || row.tbl_name !== expectedTable
    })
  )
    throw new Error('unexpected schema object')
}

function validateSchemaSql(adapter: NodeSQLiteAdapter, version: 1 | 2 | 3): void {
  validateExactSchemaSql(adapter, 'schema_metadata', SCHEMA_METADATA_DDL)
  validateExactSchemaSql(adapter, 'events', EVENTS_DDL)
  if (version >= 2) validateExactSchemaSql(adapter, 'snapshots', SNAPSHOTS_DDL)
  if (version === 3) {
    validateExactSchemaSql(adapter, 'resources', RESOURCES_DDL)
    validateExactSchemaSql(adapter, 'resource_mutations', RESOURCE_MUTATIONS_DDL)
  }
}

function validateExactSchemaSql(adapter: NodeSQLiteAdapter, name: string, expected: string): void {
  const sql = adapter.get(
    'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?',
    'table',
    name
  )?.sql
  if (typeof sql !== 'string' || normalizeSql(sql) !== normalizeSql(expected))
    throw new Error(`${name} SQL does not exactly match the v1 schema`)
}

export function normalizeSql(sql: string): string {
  return sql
    .toLowerCase()
    .replaceAll('"', '')
    .replaceAll('`', '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replace(/\s+/g, '')
    .replace(/;+$/, '')
}

function validateTable(
  adapter: NodeSQLiteAdapter,
  name: string,
  expected: readonly RequiredColumn[]
): void {
  const table = adapter.get(`SELECT type, sql FROM sqlite_master WHERE name = ?`, name)
  if (table?.type !== 'table') throw new Error(`missing table ${name}`)
  const listed = adapter
    .all('PRAGMA table_list')
    .find((row) => row.name === name && row.type === 'table')
  if (listed?.strict !== 1) throw new Error(`${name} is not STRICT`)
  const columns = adapter.all(`PRAGMA table_info(${name})`)
  if (columns.length !== expected.length) throw new Error(`${name} has unexpected columns`)
  for (const requirement of expected) {
    const column = columns.find((row) => row.name === requirement.name)
    if (
      !column ||
      String(column.type).toUpperCase() !== requirement.type ||
      column.notnull !== requirement.notnull ||
      column.pk !== requirement.pk
    )
      throw new Error(`${name}.${requirement.name} is invalid`)
  }
}
function validateNamedIndex(
  adapter: NodeSQLiteAdapter,
  table: string,
  name: string,
  columns: readonly string[],
  unique: boolean,
  partial: boolean,
  origin: string,
  desc: readonly number[] = columns.map(() => 0)
): void {
  const row = adapter.get('SELECT type, tbl_name, sql FROM sqlite_master WHERE name = ?', name)
  if (row?.type !== 'index' || row.tbl_name !== table) throw new Error(`missing index ${name}`)
  const listed = adapter
    .all(`PRAGMA index_list(${quoteIdentifier(table)})`)
    .find((index) => index.name === name)
  if (
    !listed ||
    listed.unique !== Number(unique) ||
    listed.partial !== Number(partial) ||
    listed.origin !== origin ||
    !exactIndexColumns(adapter, name, columns, desc)
  )
    throw new Error(`invalid index ${name}`)
  if (
    partial &&
    (typeof row.sql !== 'string' || normalizeSql(row.sql) !== normalizeSql(IDEMPOTENCY_INDEX_DDL))
  )
    throw new Error(`invalid partial predicate for ${name}`)
}
function exactIndexColumns(
  adapter: NodeSQLiteAdapter,
  name: string,
  expected: readonly string[],
  desc: readonly number[]
): boolean {
  const rows = adapter.all(`PRAGMA index_xinfo(${quoteIdentifier(name)})`)
  const keys = rows.filter((row) => row.key === 1).sort((a, b) => Number(a.seqno) - Number(b.seqno))
  if (keys.length !== expected.length) return false
  return (
    keys.every(
      (row, index) =>
        row.seqno === index &&
        typeof row.cid === 'number' &&
        row.cid >= 0 &&
        row.name === expected[index] &&
        row.desc === desc[index] &&
        row.coll === 'BINARY' &&
        row.key === 1
    ) && rows.filter((row) => row.key === 0).every((row) => row.cid === -1)
  )
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
function parseJsonColumn(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new CorruptEventStoreError(`${name} contains invalid JSON.`, error)
  }
}
function compare(actual: unknown, expected: unknown, name: string): void {
  if (actual !== expected) throw new Error(`${name} does not match envelope`)
}
function compareNullable(actual: unknown, expected: unknown, name: string): void {
  compare(actual ?? null, expected ?? null, name)
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function requireInputString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError(`${name} must be a non-empty string.`)
}
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new CorruptEventStoreError(`${name} is not text.`)
  return value
}
function requireNonEmptyStoredString(value: unknown, name: string): string {
  const result = requireString(value, name)
  if (result.trim().length === 0) throw new CorruptEventStoreError(`${name} is empty.`)
  return result
}
function requireNonNegativeSafeInteger(value: unknown, name: string): number {
  const result = requireSafeInteger(value, name)
  if (result < 0) throw new CorruptEventStoreError(`${name} is negative.`)
  return result
}
function requireCoveredSequence(value: unknown): number {
  const result = requireSafeInteger(value, 'covered_sequence')
  if (result < -1) throw new CorruptEventStoreError('covered_sequence is below -1.')
  return result
}
function requireNonNegativeFinite(value: unknown, name: string): number {
  const result = requireFinite(value, name)
  if (result < 0) throw new CorruptEventStoreError(`${name} is negative.`)
  return result
}
function requireFinite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new CorruptEventStoreError(`${name} is not finite.`)
  return value
}
function requireSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new CorruptEventStoreError(`${name} is not a safe integer.`)
  return value
}
function pragmaInteger(adapter: NodeSQLiteAdapter, name: string): number {
  return requireSafeInteger(adapter.get(`PRAGMA ${name}`)?.[name], `PRAGMA ${name}`)
}
function pragmaText(adapter: NodeSQLiteAdapter, name: string): string {
  return requireString(adapter.get(`PRAGMA ${name}`)?.[name], `PRAGMA ${name}`)
}
function pragmaTextSet(adapter: NodeSQLiteAdapter, name: string, value: string): string {
  return requireString(adapter.get(`PRAGMA ${name} = ${value}`)?.[name], `PRAGMA ${name}`)
}
function resultFor(item: StoredEvent, inserted: boolean): AppendResult {
  return {
    eventId: item.event.id,
    streamId: item.event.streamId,
    sequence: item.event.sequence,
    inserted
  }
}
function normalizeSQLiteConflict(error: unknown): unknown {
  if (error instanceof EventStoreConflictError) return error
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message))
    return new EventStoreConflictError(`SQLite uniqueness conflict: ${error.message}`)
  return error
}
