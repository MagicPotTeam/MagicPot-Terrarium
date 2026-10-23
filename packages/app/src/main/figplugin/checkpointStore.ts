import fs, { type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  figPluginRuntimeBindingSchema,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  figPluginVisualBaselineSchema,
  FIGPLUGIN_VISUAL_BASELINE_TTL_MS
} from '@shared/figplugin/execution'
import { hostPlanSchema, type HostContext } from '@shared/figplugin/hostPlan'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import {
  savedTaskCheckpointsSchema,
  taskRecoveryRebindSchema,
  type SavedTaskCheckpoint,
  type TaskRecoveryRebind
} from '@shared/figplugin/taskRecovery'

export const CHECKPOINT_MAX_RECORDS = 16
export const CHECKPOINT_MAX_RECORD_BYTES = 64 * 1024
export const CHECKPOINT_MAX_BYTES = 1024 * 1024
const MAX_DATABASE_BYTES = 4 * 1024 * 1024
const APPLICATION_ID = 0x4d504643
const TABLE =
  'CREATE TABLE checkpoints (id INTEGER PRIMARY KEY CHECK (id = 1), payload BLOB NOT NULL) STRICT'
const id = z.string().min(1).max(128)
const scopeSchema = z
  .object({
    host: z.enum(['figma', 'photoshop']),
    documentId: id,
    scopeId: id,
    adapterVersion: z.string().min(1).max(64),
    targetIds: z.array(id).min(1).max(20),
    recoveryIdentity: z.string().regex(/^[a-f0-9]{32}$/),
    anchors: z
      .array(
        z
          .object({
            id,
            type: id,
            parentId: id.nullable(),
            ancestors: z.array(z.object({ id, type: id }).strict()).max(32),
            children: z.array(id).max(100).optional(),
            fontKey: z.string().max(4096).optional()
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict()
const recordSchema = z
  .object({
    value: figPluginVisualBaselineSchema,
    binding: figPluginRuntimeBindingSchema,
    recoveryPlan: hostPlanSchema,
    recoveryScope: scopeSchema
  })
  .strict()
  .superRefine((record, ctx) => {
    const { value, binding, recoveryPlan: plan, recoveryScope: scope } = record
    const equal = (a: unknown, b: unknown) =>
      canonicalFigPluginJson(a) === canonicalFigPluginJson(b)
    const targets = [...new Set(plan.steps.map((step) => step.targetId))].sort()
    const bad =
      value.storage !== 'encrypted-local' ||
      value.expiresAt - value.acceptedAt > FIGPLUGIN_VISUAL_BASELINE_TTL_MS ||
      value.pluginId !== binding.pluginId ||
      value.projectId !== binding.projectId ||
      value.host !== binding.host ||
      scope.host !== value.host ||
      scope.documentId !== value.documentId ||
      scope.scopeId !== value.scopeId ||
      scope.adapterVersion !== value.adapterVersion ||
      plan.captureId !== value.captureId ||
      hash(plan) !== value.planSha256 ||
      !equal(targets, scope.targetIds) ||
      !equal(targets, value.targets.map((target) => target.targetId).sort()) ||
      new Set(scope.anchors.map((anchor) => anchor.id)).size !== scope.anchors.length ||
      targets.some((target) => !scope.anchors.some((anchor) => anchor.id === target)) ||
      Buffer.byteLength(JSON.stringify(record), 'utf8') > CHECKPOINT_MAX_RECORD_BYTES
    if (bad)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid saved checkpoint binding' })
  })
const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.array(recordSchema).max(CHECKPOINT_MAX_RECORDS)
  })
  .strict()
export type SavedCheckpoint = z.output<typeof recordSchema>
export type CheckpointCodec = {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}
export interface RecoveryCheckpointStore {
  save(record: SavedCheckpoint): void
  find(binding: FigPluginRuntimeBinding, context: HostContext): SavedCheckpoint | undefined
  findForRebind(
    binding: FigPluginRuntimeBinding,
    context: HostContext,
    baselineId: string
  ): SavedCheckpoint | undefined
  listSummaries(): SavedTaskCheckpoint[]
  consume(record: SavedCheckpoint, round: number, rebind?: TaskRecoveryRebind): void
  removeWhere(predicate: (record: SavedCheckpoint) => boolean): void
}
const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalFigPluginJson(value)).digest('hex')
const unavailable = (): Error => new Error('FIGPLUGIN_CHECKPOINT_UNAVAILABLE')
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const scopeKey = (r: SavedCheckpoint): string =>
  JSON.stringify([
    r.value.pluginId,
    r.value.host,
    r.value.projectId,
    r.value.documentId,
    r.value.scopeId
  ])
// Re-pairing supplies a NEW per-process keyed model revision. Only this no-model data
// retrieval ignores the old opaque revision; package, profile ID and project remain exact.
const recoveryBinding = (binding: FigPluginRuntimeBinding): unknown => {
  const { profileRevision: _revision, ...stable } = binding
  return stable
}
const identity = (r: SavedCheckpoint): string =>
  hash({
    ...r,
    binding: recoveryBinding(r.binding),
    value: { ...r.value, correctionRoundsUsed: 0 }
  })
const missing = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'

/** Encrypted data, never an executable grant. Transactions serialize round consumption even
 * across independent connections. Bounded synchronous SQLite operations keep the final
 * persistence-before-intent decision atomic in the existing main-process authority lane.
 * OS-owned private directories remain required: SQLite cannot open via an O_NOFOLLOW handle.
 */
export class FigPluginCheckpointStore implements RecoveryCheckpointStore {
  readonly file: string
  constructor(
    private readonly root: string,
    private readonly codec: CheckpointCodec,
    private readonly now: () => number = Date.now
  ) {
    if (!path.isAbsolute(root) || root.includes('\0') || /^[\\/]{2}/.test(root)) throw unavailable()
    this.root = path.resolve(root)
    this.file = path.join(this.root, 'accepted-checkpoints.sqlite')
  }
  private directories(create: boolean): Array<{ name: string; info: BigIntStats }> | undefined {
    const parsed = path.parse(this.root),
      parts = this.root.slice(parsed.root.length).split(path.sep).filter(Boolean)
    if (parts.length > 64) throw unavailable()
    let current = parsed.root
    const chain: Array<{ name: string; info: BigIntStats }> = []
    for (const part of ['', ...parts]) {
      current = path.join(current, part)
      let stat: BigIntStats
      try {
        stat = fs.lstatSync(current, { bigint: true })
      } catch (error) {
        if (!missing(error)) throw error
        if (!create) return undefined
        fs.mkdirSync(current, { mode: 0o700 })
        stat = fs.lstatSync(current, { bigint: true })
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable()
      chain.push({ name: current, info: stat })
    }
    return chain
  }
  private check(chain: Array<{ name: string; info: BigIntStats }>): void {
    for (const item of chain) {
      const stat = fs.lstatSync(item.name, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, item.info))
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
        stat.size > BigInt(MAX_DATABASE_BYTES)
      )
        throw unavailable()
      return stat
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
  }
  private transaction<T>(create: boolean, work: (records: SavedCheckpoint[]) => T, empty: T): T {
    let db: DatabaseSync | undefined
    let created = false,
      committed = false
    let createdInfo: BigIntStats | undefined
    let chain: Array<{ name: string; info: BigIntStats }> | undefined
    try {
      chain = this.directories(false)
      let original = chain ? this.regular(this.file) : undefined
      if (!original && !create) return empty
      if (!this.codec.available()) throw unavailable()
      chain = chain ?? this.directories(true)!
      this.check(chain)
      this.regular(this.file + '-journal')
      if (this.regular(this.file + '-wal') || this.regular(this.file + '-shm')) throw unavailable()
      if (!original) {
        const fd = fs.openSync(this.file, 'wx', 0o600)
        fs.closeSync(fd)
        original = this.regular(this.file)
        createdInfo = original
        created = true
      }
      if (!original || (!created && original.size === 0n)) throw unavailable()
      db = new DatabaseSync(this.file, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false
      })
      if (!sameIdentity(original, this.regular(this.file)!)) throw unavailable()
      this.check(chain)
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw unavailable()
      db.exec(
        'PRAGMA busy_timeout=100; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL'
      )
      db.exec('BEGIN IMMEDIATE')
      if (created) {
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; ${TABLE}`)
      } else {
        if (
          db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
          db.prepare('PRAGMA user_version').get()?.user_version !== 1
        )
          throw unavailable()
        const schema = db
          .prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
          .all()
        if (schema.length !== 1 || schema[0].name !== 'checkpoints' || schema[0].sql !== TABLE)
          throw unavailable()
      }
      db.exec('PRAGMA max_page_count=1024')
      const rows = db.prepare('SELECT payload FROM checkpoints').all()
      if (rows.length > 1) throw unavailable()
      let records: SavedCheckpoint[] = []
      if (rows.length) {
        const blob = rows[0].payload
        if (
          !(blob instanceof Uint8Array) ||
          blob.byteLength < 1 ||
          blob.byteLength > CHECKPOINT_MAX_BYTES + 65536
        )
          throw unavailable()
        const text = this.codec.decrypt(Buffer.from(blob))
        if (Buffer.byteLength(text, 'utf8') > CHECKPOINT_MAX_BYTES) throw unavailable()
        records = envelopeSchema.parse(JSON.parse(text)).records
        if (
          new Set(records.map((r) => r.value.baselineId)).size !== records.length ||
          new Set(records.map(scopeKey)).size !== records.length
        )
          throw unavailable()
      }
      const at = this.now()
      if (!Number.isSafeInteger(at) || at < 0 || records.some((r) => r.value.acceptedAt > at))
        throw unavailable()
      records = records.filter((r) => r.value.expiresAt > at)
      const result = work(records)
      const text = JSON.stringify(envelopeSchema.parse({ schemaVersion: 1, records }))
      if (Buffer.byteLength(text, 'utf8') > CHECKPOINT_MAX_BYTES) throw unavailable()
      const encrypted = this.codec.encrypt(text)
      if (
        !Buffer.isBuffer(encrypted) ||
        encrypted.length < 1 ||
        encrypted.length > CHECKPOINT_MAX_BYTES + 65536
      )
        throw unavailable()
      this.check(chain)
      if (!sameIdentity(original, this.regular(this.file)!)) throw unavailable()
      db.prepare(
        'INSERT INTO checkpoints(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
      ).run(encrypted)
      db.exec('COMMIT')
      committed = true
      return structuredClone(result)
    } catch {
      if (db)
        try {
          db.exec('ROLLBACK')
        } catch {
          // Preserve the sanitized failure even if SQLite could not start a transaction.
        }
      throw unavailable()
    } finally {
      db?.close()
      if (created && !committed && createdInfo && chain) {
        try {
          this.check(chain)
          const current = this.regular(this.file)
          if (current && current.size === 0n && sameIdentity(current, createdInfo))
            fs.unlinkSync(this.file)
        } catch {
          /* Never remove a replaced or partially committed database. */
        }
      }
    }
  }
  save(input: SavedCheckpoint): void {
    const record = recordSchema.parse(input)
    if (
      record.value.correctionRoundsUsed !== 0 ||
      record.value.acceptedAt > this.now() ||
      record.value.expiresAt <= this.now()
    )
      throw unavailable()
    this.transaction(
      true,
      (records) => {
        const previous = records.find(
          (r) =>
            r.value.baselineId === record.value.baselineId ||
            r.value.sourceExecutionId === record.value.sourceExecutionId
        )
        if (previous) {
          if (
            identity(previous) !== identity(record) ||
            previous.value.correctionRoundsUsed !== record.value.correctionRoundsUsed
          )
            throw unavailable()
          return
        }
        const existing = records.findIndex((r) => scopeKey(r) === scopeKey(record))
        if (existing >= 0) records.splice(existing, 1)
        if (records.length >= CHECKPOINT_MAX_RECORDS) throw unavailable()
        records.push(structuredClone(record))
      },
      undefined
    )
  }
  find(binding: FigPluginRuntimeBinding, context: HostContext): SavedCheckpoint | undefined {
    return this.transaction(
      false,
      (records) => {
        const saved = records.find(
          (r) =>
            canonicalFigPluginJson(recoveryBinding(r.binding)) ===
              canonicalFigPluginJson(recoveryBinding(binding)) &&
            r.recoveryScope.recoveryIdentity === context.recoveryIdentity &&
            r.value.documentId === context.documentId &&
            r.value.scopeId === context.scopeId &&
            r.value.host === context.host
        )
        return saved ? { ...saved, binding: structuredClone(binding) } : undefined
      },
      undefined
    )
  }
  listSummaries(): SavedTaskCheckpoint[] {
    return this.transaction(
      false,
      (records) =>
        savedTaskCheckpointsSchema.parse(
          records
            .map((r) => ({
              baselineId: r.value.baselineId,
              pluginId: r.value.pluginId,
              projectId: r.value.projectId,
              host: r.value.host,
              documentId: r.value.documentId,
              scopeId: r.value.scopeId,
              targetIds: r.recoveryScope.targetIds,
              acceptedAt: r.value.acceptedAt,
              expiresAt: r.value.expiresAt,
              correctionRoundsUsed: r.value.correctionRoundsUsed,
              maxCorrectionRounds: r.value.maxCorrectionRounds
            }))
            .sort((a, b) => b.acceptedAt - a.acceptedAt)
        ),
      []
    )
  }
  /** A candidate is data only. A separate native write consent must acknowledge the changed
   * instance before consume can rebind it. Still no cross-document/node-ID remapping. */
  findForRebind(
    binding: FigPluginRuntimeBinding,
    context: HostContext,
    baselineId: string
  ): SavedCheckpoint | undefined {
    if (!/^[a-f0-9]{32}$/.test(baselineId) || !context.recoveryIdentity) throw unavailable()
    return this.transaction(
      false,
      (records) => {
        const saved = records.find(
          (r) =>
            r.value.baselineId === baselineId &&
            canonicalFigPluginJson(recoveryBinding(r.binding)) ===
              canonicalFigPluginJson(recoveryBinding(binding)) &&
            r.value.documentId === context.documentId &&
            r.value.scopeId === context.scopeId &&
            r.value.host === context.host
        )
        return saved ? { ...saved, binding: structuredClone(binding) } : undefined
      },
      undefined
    )
  }
  consume(record: SavedCheckpoint, round: number, rebind?: TaskRecoveryRebind): void {
    if (rebind) {
      taskRecoveryRebindSchema.parse(rebind)
      if (record.recoveryScope.recoveryIdentity !== rebind.previousIdentity) throw unavailable()
    }
    let consumed = false
    this.transaction(
      false,
      (records) => {
        const current = records.find((r) => r.value.baselineId === record.value.baselineId)
        if (
          !current ||
          identity(current) !== identity(record) ||
          current.value.correctionRoundsUsed !== record.value.correctionRoundsUsed ||
          round !== current.value.correctionRoundsUsed + 1 ||
          round > 3
        )
          throw unavailable()
        current.value.correctionRoundsUsed = round
        if (rebind) current.recoveryScope.recoveryIdentity = rebind.nextIdentity
        consumed = true
      },
      undefined
    )
    if (!consumed) throw unavailable()
  }
  removeWhere(predicate: (record: SavedCheckpoint) => boolean): void {
    this.transaction(
      false,
      (records) => {
        for (let i = records.length - 1; i >= 0; i--)
          if (predicate(structuredClone(records[i]))) records.splice(i, 1)
      },
      undefined
    )
  }
}
