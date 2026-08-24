import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import type { ComfyInstanceKind, ComfyInstanceState } from '@shared/comfy/dispatch'
import { isIP } from 'node:net'
import { normalizeComfyInstanceOrigin } from './instanceRegistry'
import { isUnsafeComfyAddress } from './networkPolicy'
import {
  assertComfyOutputRouteSchema,
  assertComfyOutputRouteTableAndLegacyIndexSchema,
  assertComfyStateTableBoundary,
  COMFY_OUTPUT_ROUTE_ENDPOINT_INDEX_DDL,
  COMFY_OUTPUT_ROUTE_INSTANCE_INDEX_DDL,
  COMFY_OUTPUT_ROUTE_TABLE_DDL,
  COMFY_STATE_APPLICATION_ID,
  COMFY_STATE_SCHEMA_VERSION,
  comfyBatchStateDatabasePath,
  readComfyStateUserTableNames
} from './statePaths'

export type ComfyOutputRoute = Readonly<{
  routeId: string
  instanceId: string
  origin: string
  kind: ComfyInstanceKind
  createdAt: number
}>

const readIntegerPragma = (
  database: DatabaseSync,
  pragma: 'application_id' | 'user_version'
): number => {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
  const value = row?.[pragma]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Comfy output route database returned an invalid ${pragma}.`)
  }
  return value
}

const normalizeOrigin = (origin: string, kind: ComfyInstanceKind): string =>
  normalizeComfyInstanceOrigin(origin, kind)

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  if (normalized.toLowerCase() === 'localhost' || normalized.toLowerCase().endsWith('.localhost')) {
    return true
  }
  if (normalized === '::1') return true
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  return false
}

const assertStoredOriginPolicy = (origin: string, kind: ComfyInstanceKind): void => {
  const canonical = normalizeOrigin(origin, kind)
  if (canonical !== origin) throw new Error('Comfy output route database returned a malformed row.')
  const parsed = new URL(origin)
  const hostname = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname
  if (kind === 'local' && !isLoopbackHostname(hostname)) {
    throw new Error('Comfy output route database returned an unsafe local route.')
  }
  if (kind === 'remote' && isIP(hostname) !== 0 && isUnsafeComfyAddress(hostname)) {
    throw new Error('Comfy output route database returned an unsafe remote route.')
  }
}

const assertCaptureInput = (instance: Pick<ComfyInstanceState, 'id' | 'origin' | 'kind'>): void => {
  if (!instance || typeof instance.id !== 'string' || !instance.id.trim()) {
    throw new TypeError('Comfy output route instance id must be a non-empty string.')
  }
  if (typeof instance.origin !== 'string' || !instance.origin.trim()) {
    throw new TypeError('Comfy output route origin must be a non-empty string.')
  }
  if (instance.kind !== 'local' && instance.kind !== 'remote') {
    throw new TypeError('Comfy output route kind must be local or remote.')
  }
}

export class SqliteComfyOutputRouteStore {
  private readonly database: DatabaseSync

  constructor(readonly databasePath: string = ':memory:') {
    if (typeof databasePath !== 'string' || !databasePath.trim()) {
      throw new TypeError('Comfy output route database path must be a non-empty string.')
    }
    if (databasePath !== ':memory:') {
      const resolved = path.resolve(databasePath)
      mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 })
      if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
        throw new Error(`Comfy output route database must not be a symbolic link: ${resolved}`)
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
    const routeTableExists = userTableNames.includes('comfy_output_routes')
    if (applicationId !== 0 && applicationId !== COMFY_STATE_APPLICATION_ID) {
      throw new Error('Comfy output route database belongs to a different application.')
    }
    if (applicationId === 0 && (schemaVersion !== 0 || userTableNames.length > 0)) {
      throw new Error('Comfy output route database has an unrecognized existing schema.')
    }
    if (
      applicationId === COMFY_STATE_APPLICATION_ID &&
      ![0, COMFY_STATE_SCHEMA_VERSION].includes(schemaVersion)
    ) {
      throw new Error(`Unsupported Comfy output route schema version: ${schemaVersion}.`)
    }
    assertComfyStateTableBoundary(userTableNames)
    if (
      applicationId === COMFY_STATE_APPLICATION_ID &&
      schemaVersion === COMFY_STATE_SCHEMA_VERSION &&
      userTableNames.length === 0
    ) {
      throw new Error('Comfy output route database is missing its authoritative tables.')
    }
    const endpointIndexExists = Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM sqlite_schema
           WHERE type = 'index' AND name = 'comfy_output_routes_endpoint_uidx'`
        )
        .get()
    )
    if (routeTableExists) {
      assertComfyOutputRouteTableAndLegacyIndexSchema(this.database)
      if (endpointIndexExists) assertComfyOutputRouteSchema(this.database)
    }
    this.database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA fullfsync = ON;
      PRAGMA checkpoint_fullfsync = ON;
    `)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (!routeTableExists) {
        this.database.exec(
          `${COMFY_OUTPUT_ROUTE_TABLE_DDL};${COMFY_OUTPUT_ROUTE_INSTANCE_INDEX_DDL};${COMFY_OUTPUT_ROUTE_ENDPOINT_INDEX_DDL};`
        )
      } else if (!endpointIndexExists) {
        this.database.exec(`${COMFY_OUTPUT_ROUTE_ENDPOINT_INDEX_DDL};`)
      }
      this.database.exec(`
        PRAGMA application_id = ${COMFY_STATE_APPLICATION_ID};
        PRAGMA user_version = ${COMFY_STATE_SCHEMA_VERSION};
      `)
      assertComfyOutputRouteSchema(this.database)
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
      throw new Error('Comfy output route database identity could not be established.')
    }
    assertComfyOutputRouteSchema(this.database)
    const integrity = this.database.prepare('PRAGMA quick_check').get() as
      Record<string, unknown> | undefined
    if (!integrity || !Object.values(integrity).includes('ok')) {
      throw new Error('Comfy output route database failed SQLite quick_check.')
    }
  }

  capture(instance: Pick<ComfyInstanceState, 'id' | 'origin' | 'kind'>): ComfyOutputRoute {
    assertCaptureInput(instance)
    const endpoint = {
      instanceId: instance.id.trim(),
      origin: normalizeOrigin(instance.origin, instance.kind),
      kind: instance.kind
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.database
        .prepare(
          `SELECT route_id, instance_id, origin, kind, created_at
           FROM comfy_output_routes
           WHERE instance_id = ? AND origin = ? AND kind = ?
           ORDER BY created_at ASC, route_id ASC
           LIMIT 1`
        )
        .get(endpoint.instanceId, endpoint.origin, endpoint.kind) as
        Record<string, unknown> | undefined
      if (existing) {
        this.database.exec('COMMIT')
        return this.parseRouteRow(existing)
      }
      const route: ComfyOutputRoute = {
        routeId: `route-${randomUUID()}`,
        ...endpoint,
        createdAt: Date.now()
      }
      this.database
        .prepare(
          `INSERT INTO comfy_output_routes(route_id, instance_id, origin, kind, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(route.routeId, route.instanceId, route.origin, route.kind, route.createdAt)
      this.database.exec('COMMIT')
      return route
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Preserve the original transaction error.
      }
      throw error
    }
  }

  private parseRouteRow(row: Record<string, unknown>): ComfyOutputRoute {
    if (
      typeof row.route_id !== 'string' ||
      !/^route-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        row.route_id
      ) ||
      row.route_id.length > 64 ||
      typeof row.instance_id !== 'string' ||
      !row.instance_id ||
      row.instance_id !== row.instance_id.trim() ||
      row.instance_id.length > 256 ||
      typeof row.origin !== 'string' ||
      !row.origin ||
      row.origin !== row.origin.trim() ||
      row.origin.length > 2048 ||
      (row.kind !== 'local' && row.kind !== 'remote') ||
      typeof row.created_at !== 'number' ||
      !Number.isSafeInteger(row.created_at) ||
      row.created_at < 0
    ) {
      throw new Error('Comfy output route database returned a malformed row.')
    }
    assertStoredOriginPolicy(row.origin, row.kind)
    return {
      routeId: row.route_id,
      instanceId: row.instance_id,
      origin: row.origin,
      kind: row.kind,
      createdAt: row.created_at
    }
  }

  get(routeId: string): ComfyOutputRoute | undefined {
    if (typeof routeId !== 'string' || !routeId.trim()) return undefined
    const row = this.database
      .prepare(
        `SELECT route_id, instance_id, origin, kind, created_at
         FROM comfy_output_routes WHERE route_id = ?`
      )
      .get(routeId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return this.parseRouteRow(row)
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }
}

let outputRouteStore: SqliteComfyOutputRouteStore | null = null

const defaultOutputRouteDatabasePath = (): string =>
  process.env.NODE_ENV === 'test'
    ? ':memory:'
    : comfyBatchStateDatabasePath(app.getPath('userData'))

export const getComfyOutputRouteStore = (): SqliteComfyOutputRouteStore => {
  outputRouteStore ??= new SqliteComfyOutputRouteStore(defaultOutputRouteDatabasePath())
  return outputRouteStore
}

export const closeComfyOutputRouteStore = (): void => {
  outputRouteStore?.close()
  outputRouteStore = null
}
