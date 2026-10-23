import fs, { type BigIntStats } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export const NATIVE_WRITE_MAX_TTL_MS = 120_000
export const NATIVE_WRITE_DRAIN_MS = 30_000
export const NATIVE_WRITE_MAX_RESERVATIONS = 64
const MAX_FILE_BYTES = 256 * 1024
const APPLICATION_ID = 0x4d50574c
const TABLE =
  'CREATE TABLE reservations (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL) STRICT'
const hex = (length: number) =>
  z
    .string()
    .length(length)
    .regex(/^[a-f0-9]+$/)
const time = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - NATIVE_WRITE_DRAIN_MS)
export const nativeWriteReservationSchema = z
  .object({
    resourceKey: hex(64),
    actionId: hex(32),
    fingerprint: hex(64),
    expiresAt: time
  })
  .strict()
export type NativeWriteReservation = z.output<typeof nativeWriteReservationSchema>
const rowSchema = nativeWriteReservationSchema
  .extend({ acquiredAt: time })
  .strict()
  .refine(
    (v) => v.expiresAt > v.acquiredAt && v.expiresAt - v.acquiredAt <= NATIVE_WRITE_MAX_TTL_MS,
    'Invalid write reservation lifetime'
  )
const rowsSchema = z
  .array(rowSchema)
  .max(NATIVE_WRITE_MAX_RESERVATIONS)
  .superRefine((rows, ctx) => {
    if (
      new Set(rows.map((r) => r.resourceKey)).size !== rows.length ||
      new Set(rows.map((r) => r.actionId)).size !== rows.length
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate write reservation' })
  })
type Row = z.output<typeof rowSchema>
export interface NativeWriteCoordinator {
  reserve(reservation: NativeWriteReservation): boolean
  owns(reservation: NativeWriteReservation): boolean
  release(reservation: NativeWriteReservation): void
}
const unavailable = () => new Error('FIGPLUGIN_WRITE_COORDINATION_UNAVAILABLE')
const equal = (a: NativeWriteReservation, b: NativeWriteReservation): boolean =>
  a.resourceKey === b.resourceKey &&
  a.actionId === b.actionId &&
  a.fingerprint === b.fingerprint &&
  a.expiresAt === b.expiresAt

/** A reservation is exclusion data, NEVER authority to execute. Cancellation, session loss,
 * runtime disposal and invalid results must not release it. Only verified settled results
 * release early; otherwise the ORIGINAL grant deadline plus a bounded drain interval applies.
 * Host-side deadline/current-object checks remain required, including after asynchronous waits.
 */
abstract class WriteCoordinator implements NativeWriteCoordinator {
  constructor(protected readonly now: () => number) {}
  protected abstract transaction<T>(
    create: boolean,
    work: (rows: Row[], at: number) => T,
    empty: T
  ): T
  reserve(input: NativeWriteReservation): boolean {
    const r = nativeWriteReservationSchema.parse(input)
    return this.transaction(
      true,
      (rows, at) => {
        if (r.expiresAt <= at || r.expiresAt - at > NATIVE_WRITE_MAX_TTL_MS) throw unavailable()
        const old = rows.find((v) => v.resourceKey === r.resourceKey || v.actionId === r.actionId)
        if (old) return equal(old, r)
        if (rows.length >= NATIVE_WRITE_MAX_RESERVATIONS) return false
        rows.push({ ...r, acquiredAt: at })
        return true
      },
      false
    )
  }
  owns(input: NativeWriteReservation): boolean {
    const r = nativeWriteReservationSchema.parse(input)
    return this.transaction(
      false,
      (rows, at) => at < r.expiresAt && rows.some((v) => equal(v, r)),
      false
    )
  }
  release(input: NativeWriteReservation): void {
    const r = nativeWriteReservationSchema.parse(input)
    this.transaction(
      false,
      (rows) => {
        const index = rows.findIndex((v) => equal(v, r))
        if (index >= 0) rows.splice(index, 1)
      },
      undefined
    )
  }
}
const checkedRows = (input: unknown, at: number): Row[] => {
  const rows = rowsSchema.parse(input)
  if (!Number.isSafeInteger(at) || at < 0 || rows.some((r) => r.acquiredAt > at))
    throw unavailable()
  return rows.filter((r) => r.expiresAt + NATIVE_WRITE_DRAIN_MS > at)
}
/** Isolated injection default. Production uses the shared application-profile SQLite store. */
export class MemoryNativeWriteCoordinator extends WriteCoordinator {
  private rows: Row[] = []
  constructor(now: () => number = Date.now) {
    super(now)
  }
  protected transaction<T>(_create: boolean, work: (rows: Row[], at: number) => T, _empty: T): T {
    const at = this.now(),
      rows = checkedRows(this.rows, at)
    const result = work(rows, at)
    this.rows = rowsSchema.parse(rows)
    return result
  }
}
const sameFile = (a: BigIntStats, b: BigIntStats | undefined): boolean =>
  !!b && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const missing = (e: unknown): boolean =>
  !!e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT'

/** Shared across controllers/processes using the SAME application data directory. Persists only
 * opaque resource/intent hashes, random action IDs and times, never document text, tokens or plans.
 * Directory ownership is required: node:sqlite does not support descriptor-based O_NOFOLLOW open.
 * Clearing/copying the profile and external/uncooperative host writers are outside this boundary.
 */
export class SqliteNativeWriteCoordinator extends WriteCoordinator {
  readonly file: string
  private readonly root: string
  constructor(root: string, now: () => number = Date.now) {
    super(now)
    if (!path.isAbsolute(root) || root.includes('\0') || /^[\\/]{2}/.test(root)) throw unavailable()
    this.root = path.resolve(root)
    this.file = path.join(this.root, 'native-write-reservations.sqlite')
  }
  private directories(create: boolean): Array<{ name: string; stat: BigIntStats }> | undefined {
    const parsed = path.parse(this.root),
      parts = this.root.slice(parsed.root.length).split(path.sep).filter(Boolean)
    if (parts.length > 64) throw unavailable()
    let name = parsed.root
    const chain: Array<{ name: string; stat: BigIntStats }> = []
    for (const part of ['', ...parts]) {
      name = path.join(name, part)
      let stat: BigIntStats
      try {
        stat = fs.lstatSync(name, { bigint: true })
      } catch (error) {
        if (!missing(error)) throw error
        if (!create) return undefined
        try {
          fs.mkdirSync(name, { mode: 0o700 })
        } catch (e) {
          if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'EEXIST') throw e
        }
        stat = fs.lstatSync(name, { bigint: true })
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable()
      chain.push({ name, stat })
    }
    return chain
  }
  private check(chain: Array<{ name: string; stat: BigIntStats }>): void {
    for (const item of chain) {
      const current = fs.lstatSync(item.name, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(item.stat, current))
        throw unavailable()
    }
  }
  private regular(file: string): BigIntStats | undefined {
    try {
      const stat = fs.lstatSync(file, { bigint: true })
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        stat.size > BigInt(MAX_FILE_BYTES)
      )
        throw unavailable()
      return stat
    } catch (e) {
      if (missing(e)) return undefined
      throw e
    }
  }
  protected transaction<T>(create: boolean, work: (rows: Row[], at: number) => T, empty: T): T {
    let db: DatabaseSync | undefined,
      created = false,
      committed = false
    let original: BigIntStats | undefined
    let chain: ReturnType<SqliteNativeWriteCoordinator['directories']>
    try {
      chain = this.directories(false)
      original = chain ? this.regular(this.file) : undefined
      if (!original && !create) return empty
      chain ??= this.directories(true)!
      this.check(chain)
      this.regular(this.file + '-journal')
      if (this.regular(this.file + '-wal') || this.regular(this.file + '-shm')) throw unavailable()
      if (!original) {
        try {
          const fd = fs.openSync(this.file, 'wx', 0o600)
          fs.closeSync(fd)
          created = true
        } catch (e) {
          if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'EEXIST') throw e
        }
        original = this.regular(this.file)
      }
      if (!original || (!created && original.size === 0n)) throw unavailable()
      db = new DatabaseSync(this.file, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false
      })
      this.check(chain)
      if (!sameFile(original, this.regular(this.file))) throw unavailable()
      db.exec(
        'PRAGMA busy_timeout=200; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON'
      )
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw unavailable()
      db.exec('BEGIN IMMEDIATE')
      if (created)
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; ${TABLE}`)
      else {
        if (
          db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
          db.prepare('PRAGMA user_version').get()?.user_version !== 1
        )
          throw unavailable()
        const schema = db
          .prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
          .all()
        if (schema.length !== 1 || schema[0].name !== 'reservations' || schema[0].sql !== TABLE)
          throw unavailable()
      }
      db.exec('PRAGMA max_page_count=64')
      const records = db.prepare('SELECT payload FROM reservations').all()
      if (records.length > 1) throw unavailable()
      const text = records[0]?.payload ?? '[]'
      if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024) throw unavailable()
      const at = this.now(),
        rows = checkedRows(JSON.parse(text), at)
      const result = work(rows, at)
      const next = JSON.stringify(rowsSchema.parse(rows))
      if (Buffer.byteLength(next) > 32 * 1024) throw unavailable()
      this.check(chain)
      if (!sameFile(original, this.regular(this.file))) throw unavailable()
      if (text !== next || !records.length)
        db.prepare(
          'INSERT INTO reservations(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
        ).run(next)
      db.exec('COMMIT')
      committed = true
      return result
    } catch {
      if (db)
        try {
          db.exec('ROLLBACK')
        } catch {
          /* Preserve the sanitized original error. */
        }
      throw unavailable()
    } finally {
      db?.close()
      if (created && !committed && original && chain)
        try {
          this.check(chain)
          const current = this.regular(this.file)
          if (current?.size === 0n && sameFile(original, current)) fs.unlinkSync(this.file)
        } catch {
          /* Never erase a replaced or partially committed store. */
        }
    }
  }
}
