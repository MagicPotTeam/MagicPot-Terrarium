import fs, { type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
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
  createTaskRecoveryRebind,
  applyTaskRecoveryRebind,
  type SavedTaskCheckpoint,
  type TaskRecoveryRebind
} from '@shared/figplugin/taskRecovery'
import {
  figPluginRecoveryImagesSchema,
  recoveryImagesManifestContent,
  type FigPluginRecoveryImages
} from '@shared/figplugin/hostImageRecovery'
import { FIGPLUGIN_ASSET_MAX_BYTES } from '@shared/figplugin/hostAssets'
import { inspectSessionAssetImage } from './sessionAssetImage'
import {
  CHECKPOINT_IMAGE_MAX_CIPHER_BYTES,
  type CheckpointBinaryCodec
} from './checkpointBinaryCodec'

export const CHECKPOINT_MAX_RECORDS = 16
export const CHECKPOINT_MAX_RECORD_BYTES = 64 * 1024
export const CHECKPOINT_MAX_BYTES = 1024 * 1024
export const CHECKPOINT_MAX_IMAGE_BYTES = 64 * 1024 * 1024
export const CHECKPOINT_MAX_IMAGE_BLOBS = CHECKPOINT_MAX_RECORDS * 4
const LEGACY_MAX_DATABASE_BYTES = 4 * 1024 * 1024
const MAX_DATABASE_BYTES = 96 * 1024 * 1024
const APPLICATION_ID = 0x4d504643
const TABLE =
  'CREATE TABLE checkpoints (id INTEGER PRIMARY KEY CHECK (id = 1), payload BLOB NOT NULL) STRICT'
const IMAGE_TABLE =
  'CREATE TABLE checkpoint_images (id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL) STRICT'
const id = z.string().min(1).max(128)
const hex32 = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
const recoveryClaimLeaseSchema = z
  .object({
    executionId: hex32,
    round: z.number().int().min(1).max(3),
    claimedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
  .refine((value) => value.expiresAt > value.claimedAt, 'Invalid recovery claim lease')
  .refine((value) => value.expiresAt - value.claimedAt <= 120_000, 'Recovery claim lease too long')
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
    recoveryScope: scopeSchema,
    recoveryImages: figPluginRecoveryImagesSchema.optional(),
    // A claim lease is deliberately metadata-only. It prevents a restarted desktop from
    // silently minting another executable intent while the previous host write is ambiguous.
    activeRecovery: recoveryClaimLeaseSchema.optional()
  })
  .strict()
  .superRefine((record, ctx) => {
    const { value, binding, recoveryPlan: plan, recoveryScope: scope } = record
    const equal = (a: unknown, b: unknown) =>
      canonicalFigPluginJson(a) === canonicalFigPluginJson(b)
    const targets = [...new Set(plan.steps.map((step) => step.targetId))].sort()
    const imageSteps = plan.steps.filter(
      (step) => step.command === 'image.fill' || step.command === 'image.pixels'
    )
    const images = record.recoveryImages
    const invalidImages = images
      ? images.sourcePlanSha256 !== value.planSha256 ||
        createHash('sha256').update(recoveryImagesManifestContent(images)).digest('hex') !==
          images.manifestSha256 ||
        images.targets.length !== imageSteps.length ||
        imageSteps.some((step) => {
          const target = images.targets.find(
            (item) => item.targetId === step.targetId && item.command === step.command
          )
          return (
            !target ||
            target.assetId !== step.assetId ||
            target.sha256 !== step.sha256 ||
            step.command !== (value.host === 'figma' ? 'image.fill' : 'image.pixels') ||
            (step.command === 'image.fill' &&
              (target.command !== 'image.fill' || target.scaleMode !== step.scaleMode))
          )
        })
      : imageSteps.length !== 0
    const bad =
      invalidImages ||
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
      (record.activeRecovery !== undefined &&
        record.activeRecovery.round !== value.correctionRoundsUsed) ||
      new Set(scope.anchors.map((anchor) => anchor.id)).size !== scope.anchors.length ||
      targets.some((target) => !scope.anchors.some((anchor) => anchor.id === target)) ||
      Buffer.byteLength(JSON.stringify(record), 'utf8') > CHECKPOINT_MAX_RECORD_BYTES
    if (bad)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid saved checkpoint binding' })
  })
const legacyEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.array(recordSchema).max(CHECKPOINT_MAX_RECORDS)
  })
  .strict()
  .refine((value) => value.records.every((record) => record.recoveryImages === undefined))
const blobDirectorySchema = z
  .array(
    z
      .object({
        blobId: hex32,
        sourceKey: z
          .string()
          .length(64)
          .regex(/^[a-f0-9]{64}$/)
      })
      .strict()
  )
  .max(CHECKPOINT_MAX_IMAGE_BLOBS)
const imageEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(2),
    records: z.array(recordSchema).max(CHECKPOINT_MAX_RECORDS),
    blobs: blobDirectorySchema
  })
  .strict()
export type SavedCheckpoint = z.output<typeof recordSchema>
export type RecoveryClaimLease = z.output<typeof recoveryClaimLeaseSchema>
/** Non-sensitive lifecycle statistics returned by an explicit checkpoint cleanup pass. */
export type CheckpointCleanupSummary = Readonly<{
  expiredRecordCount: number
  retainedRecordCount: number
  databasePresent: boolean
}>
export type CheckpointCodec = {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
} & Partial<CheckpointBinaryCodec>
export type CheckpointImageInput = Readonly<{ assetId: string; bytes: Uint8Array }>
export type CheckpointImageBytes = { assetId: string; bytes: Buffer }
type ImageSource = FigPluginRecoveryImages['assets'][number]
type BlobDirectory = z.output<typeof blobDirectorySchema>
type CheckpointTransactionContext = {
  expiredRecordCount: number
  retainedRecordCount: number
  db: DatabaseSync
  blobs: BlobDirectory
  enableImages(): void
}
type CheckpointTransactionOptions = Readonly<{
  /** Explicit GC may remove rows no longer referenced by the authenticated envelope. */
  cleanupOrphanImageRows?: boolean
}>
export interface RecoveryCheckpointStore {
  save(record: SavedCheckpoint, images?: readonly CheckpointImageInput[]): void
  /** Main-only bytes, never a native lease. The caller must zero each returned buffer. */
  openRecoveryImages?(
    binding: FigPluginRuntimeBinding,
    baselineId: string,
    manifestSha256: string
  ): CheckpointImageBytes[]
  find(binding: FigPluginRuntimeBinding, context: HostContext): SavedCheckpoint | undefined
  findForRebind(
    binding: FigPluginRuntimeBinding,
    context: HostContext,
    baselineId: string,
    reopenDocument?: true
  ): SavedCheckpoint | undefined
  listSummaries(): SavedTaskCheckpoint[]
  consume(
    record: SavedCheckpoint,
    round: number,
    rebind?: TaskRecoveryRebind,
    lease?: RecoveryClaimLease
  ): void
  /** Clear a previously persisted claim lease after a terminal host receipt. */
  settleRecovery?(baselineId: string, executionId: string): void
  removeWhere(predicate: (record: SavedCheckpoint) => boolean): void
  /** Optional for stores that do not own persistent checkpoint retention. */
  cleanupExpired?(): CheckpointCleanupSummary
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
const identity = (r: SavedCheckpoint): string => {
  const { activeRecovery: _activeRecovery, ...withoutLease } = r
  return hash({
    ...withoutLease,
    binding: recoveryBinding(r.binding),
    value: { ...r.value, correctionRoundsUsed: 0 }
  })
}
const missing = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const sourceKey = (source: ImageSource): string => {
  const { assetId: _assetId, ...metadata } = source
  return hash(metadata)
}
const imageSources = (records: readonly SavedCheckpoint[]): Map<string, ImageSource> => {
  const sources = new Map<string, ImageSource>()
  for (const record of records)
    for (const source of record.recoveryImages?.assets ?? []) sources.set(sourceKey(source), source)
  if (
    sources.size > CHECKPOINT_MAX_IMAGE_BLOBS ||
    [...sources.values()].reduce((total, source) => total + source.sizeBytes, 0) >
      CHECKPOINT_MAX_IMAGE_BYTES
  )
    throw unavailable()
  return sources
}
const checkImageBytes = (source: ImageSource, bytes: Uint8Array): void => {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== source.sizeBytes ||
    bytes.byteLength > FIGPLUGIN_ASSET_MAX_BYTES ||
    createHash('sha256').update(bytes).digest('hex') !== source.sha256
  )
    throw unavailable()
  const inspected = inspectSessionAssetImage(bytes)
  if (
    inspected.mimeType !== source.mimeType ||
    inspected.width !== source.width ||
    inspected.height !== source.height
  )
    throw unavailable()
}
const blobContext = (entry: BlobDirectory[number]): string =>
  canonicalFigPluginJson({ purpose: 'figplugin-checkpoint-image-v1', ...entry })

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
  private transaction<T>(
    create: boolean,
    work: (records: SavedCheckpoint[], context: CheckpointTransactionContext) => T,
    empty: T,
    cloneResult = true,
    options?: CheckpointTransactionOptions
  ): T {
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
      let version = 1
      if (created) {
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; ${TABLE}`)
      } else {
        const storedVersion = db.prepare('PRAGMA user_version').get()?.user_version
        if (
          db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
          (storedVersion !== 1 && storedVersion !== 2)
        )
          throw unavailable()
        version = storedVersion
        if (version === 1 && original.size > BigInt(LEGACY_MAX_DATABASE_BYTES)) throw unavailable()
        const schema = db
          .prepare(
            "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
          )
          .all()
        const expected =
          version === 1
            ? [{ name: 'checkpoints', sql: TABLE }]
            : [
                { name: 'checkpoint_images', sql: IMAGE_TABLE },
                { name: 'checkpoints', sql: TABLE }
              ]
        if (
          schema.length !== expected.length ||
          schema.some(
            (row, index) => row.name !== expected[index].name || row.sql !== expected[index].sql
          )
        )
          throw unavailable()
      }
      if (db.prepare('PRAGMA page_size').get()?.page_size !== 4096) throw unavailable()
      db.exec(
        `PRAGMA max_page_count=${(version === 1 ? LEGACY_MAX_DATABASE_BYTES : MAX_DATABASE_BYTES) / 4096}`
      )
      const rows = db.prepare('SELECT payload FROM checkpoints').all()
      if (rows.length > 1) throw unavailable()
      let records: SavedCheckpoint[] = []
      let blobs: BlobDirectory = []
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
        const parsed: unknown = JSON.parse(text)
        if (version === 1) records = legacyEnvelopeSchema.parse(parsed).records
        else {
          const envelope = imageEnvelopeSchema.parse(parsed)
          records = envelope.records
          blobs = envelope.blobs
        }
        if (
          new Set(records.map((r) => r.value.baselineId)).size !== records.length ||
          new Set(records.map(scopeKey)).size !== records.length
        )
          throw unavailable()
      }
      const storedSources = imageSources(records)
      if (
        new Set(blobs.map((entry) => entry.blobId)).size !== blobs.length ||
        new Set(blobs.map((entry) => entry.sourceKey)).size !== blobs.length ||
        blobs.length !== storedSources.size ||
        blobs.some((entry) => !storedSources.has(entry.sourceKey))
      )
        throw unavailable()
      if (version === 2) {
        let rows = db.prepare('SELECT id,length(payload) AS bytes FROM checkpoint_images').all()
        if (options?.cleanupOrphanImageRows) {
          const referencedIds = new Set(blobs.map((entry) => entry.blobId))
          const orphans = rows.filter((row) => !referencedIds.has(row.id as string))
          if (
            orphans.some(
              (row) =>
                typeof row.id !== 'string' ||
                !hex32.safeParse(row.id as string).success ||
                typeof row.bytes !== 'number' ||
                !Number.isSafeInteger(row.bytes) ||
                row.bytes < 0 ||
                row.bytes > CHECKPOINT_IMAGE_MAX_CIPHER_BYTES
            )
          )
            throw unavailable()
          for (const orphan of orphans)
            db.prepare('DELETE FROM checkpoint_images WHERE id=?').run(orphan.id as string)
          if (orphans.length)
            rows = db.prepare('SELECT id,length(payload) AS bytes FROM checkpoint_images').all()
        }
        if (
          rows.length !== blobs.length ||
          rows.some((row) => {
            const entry = blobs.find((item) => item.blobId === row.id)
            const source = entry ? storedSources.get(entry.sourceKey) : undefined
            return (
              !source ||
              typeof row.bytes !== 'number' ||
              !Number.isSafeInteger(row.bytes) ||
              row.bytes <= source.sizeBytes ||
              row.bytes > CHECKPOINT_IMAGE_MAX_CIPHER_BYTES
            )
          })
        )
          throw unavailable()
      }
      const at = this.now()
      if (!Number.isSafeInteger(at) || at < 0 || records.some((r) => r.value.acceptedAt > at))
        throw unavailable()
      const beforeExpiryCount = records.length
      records = records.filter((r) => r.value.expiresAt > at)
      // Claim leases are short-lived crash fences. Once the host receipt could no longer
      // arrive, discard only the lease metadata and retain the accepted checkpoint/round.
      records = records.map((record) => {
        if (!record.activeRecovery || record.activeRecovery.expiresAt > at) return record
        const { activeRecovery: _expired, ...withoutLease } = record
        return withoutLease as SavedCheckpoint
      })
      const database = db
      const result = work(records, {
        expiredRecordCount: beforeExpiryCount - records.length,
        retainedRecordCount: records.length,
        db: database,
        blobs,
        enableImages: () => {
          if (version === 2) return
          database.exec(
            `${IMAGE_TABLE}; PRAGMA user_version=2; PRAGMA max_page_count=${MAX_DATABASE_BYTES / 4096}`
          )
          version = 2
        }
      })
      const liveSources = imageSources(records)
      for (let index = blobs.length - 1; index >= 0; index--) {
        if (liveSources.has(blobs[index].sourceKey)) continue
        database.prepare('DELETE FROM checkpoint_images WHERE id=?').run(blobs[index].blobId)
        blobs.splice(index, 1)
      }
      if (
        blobs.length !== liveSources.size ||
        blobs.some((entry) => !liveSources.has(entry.sourceKey))
      )
        throw unavailable()
      const text = JSON.stringify(
        version === 1
          ? legacyEnvelopeSchema.parse({ schemaVersion: 1, records })
          : imageEnvelopeSchema.parse({ schemaVersion: 2, records, blobs })
      )
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
      return cloneResult ? structuredClone(result) : result
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
  private readImageBlob(
    context: CheckpointTransactionContext,
    source: ImageSource,
    entry: BlobDirectory[number]
  ): Buffer {
    let bytes: Buffer | undefined
    try {
      if (!this.codec.decryptBytes || !this.codec.encryptBytes) throw unavailable()
      const row = context.db
        .prepare('SELECT payload FROM checkpoint_images WHERE id=?')
        .get(entry.blobId)
      const encrypted = row?.payload
      if (
        !(encrypted instanceof Uint8Array) ||
        encrypted.byteLength > CHECKPOINT_IMAGE_MAX_CIPHER_BYTES
      )
        throw unavailable()
      bytes = this.codec.decryptBytes(encrypted, blobContext(entry), source.sizeBytes)
      if (!Buffer.isBuffer(bytes)) throw unavailable()
      checkImageBytes(source, bytes)
      return bytes
    } catch {
      bytes?.fill(0)
      throw unavailable()
    }
  }

  private collectImageBlobs(
    records: SavedCheckpoint[],
    context: CheckpointTransactionContext
  ): void {
    const sources = imageSources(records)
    for (let index = context.blobs.length - 1; index >= 0; index--) {
      if (sources.has(context.blobs[index].sourceKey)) continue
      context.db
        .prepare('DELETE FROM checkpoint_images WHERE id=?')
        .run(context.blobs[index].blobId)
      context.blobs.splice(index, 1)
    }
  }

  private saveImageBlobs(
    record: SavedCheckpoint,
    inputs: readonly CheckpointImageBytes[],
    context: CheckpointTransactionContext
  ): void {
    if (!record.recoveryImages) return
    if (!this.codec.encryptBytes || !this.codec.decryptBytes) throw unavailable()
    context.enableImages()
    for (const source of record.recoveryImages.assets) {
      const key = sourceKey(source)
      const previous = context.blobs.find((item) => item.sourceKey === key)
      if (previous) {
        const verified = this.readImageBlob(context, source, previous)
        verified.fill(0)
        continue
      }
      const input = inputs.find((item) => item.assetId === source.assetId)
      if (!input) throw unavailable()
      const entry = { blobId: randomBytes(16).toString('hex'), sourceKey: key }
      const encrypted = this.codec.encryptBytes(input.bytes, blobContext(entry))
      if (
        !Buffer.isBuffer(encrypted) ||
        encrypted.length < 1 ||
        encrypted.length > CHECKPOINT_IMAGE_MAX_CIPHER_BYTES
      )
        throw unavailable()
      context.db
        .prepare('INSERT INTO checkpoint_images(id,payload) VALUES(?,?)')
        .run(entry.blobId, encrypted)
      const verified = this.readImageBlob(context, source, entry)
      verified.fill(0)
      context.blobs.push(entry)
    }
  }

  save(input: SavedCheckpoint, images?: readonly CheckpointImageInput[]): void {
    const record = recordSchema.parse(input)
    if (
      record.value.correctionRoundsUsed !== 0 ||
      record.value.acceptedAt > this.now() ||
      record.value.expiresAt <= this.now()
    )
      throw unavailable()
    const owned: CheckpointImageBytes[] = []
    try {
      const sources = record.recoveryImages?.assets ?? []
      if (
        (images !== undefined && !Array.isArray(images)) ||
        (images?.length ?? 0) !== sources.length ||
        new Set(images?.map((image) => image.assetId)).size !== sources.length
      )
        throw unavailable()
      for (const source of sources) {
        const selected = images?.find((image) => image.assetId === source.assetId)
        if (
          !selected ||
          !(selected.bytes instanceof Uint8Array) ||
          selected.bytes.byteLength !== source.sizeBytes
        )
          throw unavailable()
        const bytes = Buffer.from(selected.bytes)
        owned.push({ assetId: source.assetId, bytes })
        checkImageBytes(source, bytes)
      }
      this.transaction(
        true,
        (records, context) => {
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
            this.saveImageBlobs(record, owned, context)
            return
          }
          const existing = records.findIndex((r) => scopeKey(r) === scopeKey(record))
          if (existing >= 0) records.splice(existing, 1)
          if (records.length >= CHECKPOINT_MAX_RECORDS) throw unavailable()
          records.push(structuredClone(record))
          // Reclaim superseded ciphertext inside the same transaction, before allocating replacements.
          this.collectImageBlobs(records, context)
          this.saveImageBlobs(record, owned, context)
        },
        undefined
      )
    } catch {
      throw unavailable()
    } finally {
      for (const image of owned) image.bytes.fill(0)
    }
  }

  openRecoveryImages(
    inputBinding: FigPluginRuntimeBinding,
    baselineId: string,
    manifestSha256: string
  ): CheckpointImageBytes[] {
    const owned: CheckpointImageBytes[] = []
    try {
      const binding = figPluginRuntimeBindingSchema.parse(inputBinding)
      if (
        !hex32.safeParse(baselineId).success ||
        typeof manifestSha256 !== 'string' ||
        !/^[a-f0-9]{64}$(?![\s\S])/.test(manifestSha256)
      )
        throw unavailable()
      const result = this.transaction(
        false,
        (records, context) => {
          const record = records.find((item) => item.value.baselineId === baselineId)
          if (
            !record?.recoveryImages ||
            record.recoveryImages.manifestSha256 !== manifestSha256 ||
            canonicalFigPluginJson(recoveryBinding(record.binding)) !==
              canonicalFigPluginJson(recoveryBinding(binding))
          )
            throw unavailable()
          for (const source of record.recoveryImages.assets) {
            const entry = context.blobs.find((blob) => blob.sourceKey === sourceKey(source))
            if (!entry) throw unavailable()
            owned.push({
              assetId: source.assetId,
              bytes: this.readImageBlob(context, source, entry)
            })
          }
          return owned
        },
        [],
        false
      )
      if (result.length === 0) throw unavailable()
      return result
    } catch {
      for (const image of owned) image.bytes.fill(0)
      throw unavailable()
    }
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
    baselineId: string,
    reopenDocument?: true
  ): SavedCheckpoint | undefined {
    if (baselineId.length !== 32 || !/^[a-f0-9]{32}$/.test(baselineId) || !context.recoveryIdentity)
      throw unavailable()
    return this.transaction(
      false,
      (records) => {
        const saved = records.find(
          (r) =>
            r.value.baselineId === baselineId &&
            canonicalFigPluginJson(recoveryBinding(r.binding)) ===
              canonicalFigPluginJson(recoveryBinding(binding)) &&
            r.value.host === context.host &&
            ((r.value.documentId === context.documentId && r.value.scopeId === context.scopeId) ||
              (reopenDocument === true && context.host === 'photoshop'))
        )
        if (!saved) return undefined
        createTaskRecoveryRebind(saved.recoveryScope, context, reopenDocument === true)
        return { ...saved, binding: structuredClone(binding) }
      },
      undefined
    )
  }
  consume(
    record: SavedCheckpoint,
    round: number,
    rebind?: TaskRecoveryRebind,
    lease?: RecoveryClaimLease
  ): void {
    if (lease) recoveryClaimLeaseSchema.parse(lease)
    if (lease && lease.round !== round) throw unavailable()
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
          (current.activeRecovery !== undefined && current.activeRecovery.expiresAt > this.now()) ||
          round !== current.value.correctionRoundsUsed + 1 ||
          round > 3
        )
          throw unavailable()
        if (rebind) {
          const nextScope = applyTaskRecoveryRebind(current.recoveryScope, rebind)
          const next = {
            ...current,
            value: {
              ...current.value,
              documentId: nextScope.documentId,
              scopeId: nextScope.scopeId
            }
          }
          // Never overwrite an independently accepted checkpoint at the destination.
          if (records.some((other) => other !== current && scopeKey(other) === scopeKey(next)))
            throw unavailable()
          current.recoveryScope = scopeSchema.parse(nextScope)
          current.value = next.value
        }
        current.value.correctionRoundsUsed = round
        if (lease) current.activeRecovery = structuredClone(lease)
        consumed = true
      },
      undefined
    )
    if (!consumed) throw unavailable()
  }
  settleRecovery(baselineId: string, executionId: string): void {
    if (!hex32.safeParse(baselineId).success || !hex32.safeParse(executionId).success)
      throw unavailable()
    this.transaction(
      false,
      (records) => {
        const current = records.find((record) => record.value.baselineId === baselineId)
        if (!current || !current.activeRecovery) return
        if (current.activeRecovery.executionId !== executionId) throw unavailable()
        delete current.activeRecovery
      },
      undefined
    )
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
  /**
   * Remove expired checkpoints and return bounded, non-sensitive retention statistics.
   * Reads and cleanup share the same transaction, so a failed decrypt or integrity check
   * remains fail-closed and never replaces the last valid encrypted database.
   */
  cleanupExpired(): CheckpointCleanupSummary {
    return this.transaction<CheckpointCleanupSummary>(
      false,
      (_records, context) => ({
        expiredRecordCount: context.expiredRecordCount,
        retainedRecordCount: context.retainedRecordCount,
        databasePresent: true
      }),
      { expiredRecordCount: 0, retainedRecordCount: 0, databasePresent: false },
      true,
      { cleanupOrphanImageRows: true }
    )
  }
}
