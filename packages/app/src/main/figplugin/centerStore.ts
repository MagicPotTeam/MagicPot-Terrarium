import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { validateServiceValue } from '@shared/api/apiUtils/serviceValidation'
import { figPluginCenterSvcDef } from '@shared/api/svcFigPluginCenter'
import {
  FigPluginCenterResponseSchema,
  getFigPluginCenterIdempotencyFingerprint,
  type FigPluginCenterFailureReason,
  type FigPluginCenterOperation,
  type FigPluginCenterRedactedStatus,
  type FigPluginCenterResponse
} from '@shared/figplugin/center'
import {
  FIGPLUGIN_MAX_CONFIG_BYTES,
  FigPluginIdSchema,
  FigPluginManifestSchema,
  FigPluginSafeRelativePathSchema,
  canonicalFigPluginJson,
  measureFigPluginConfigBytes,
  type FigPluginHost,
  type FigPluginManifest
} from '@shared/figplugin/manifest'
import {
  FigPluginManagementError,
  figPluginManagedConfigureRequestSchema,
  figPluginManagedMutationSchema,
  figPluginManagedRemoveRequestSchema,
  figPluginManagedTargetSchema,
  figPluginPackageInstallRequestSchema,
  parseFigPluginManagementValue,
  type FigPluginManagedConfigureRequest,
  type FigPluginManagedList,
  type FigPluginManagedMutation,
  type FigPluginManagedRemoveRequest,
  type FigPluginManagedSummary,
  type FigPluginManagedTarget
} from '@shared/figplugin/management'
import {
  FIGPLUGIN_PACKAGE_FORMAT,
  FigPluginPackageSchema,
  canonicalFigPluginPackageIndex,
  MAX_CONTENT_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES
} from '@shared/figplugin/package'
import type { VerifiedFigPluginPackage } from './packageVerifier'

export type FigPluginRuntimeDescriptor = {
  pluginId: string
  host: FigPluginHost
  generation: number
  artifactSha256: string
  signerFingerprint: string
  manifestSha256: string
  bridgeOrigin: string
  profileId: string
  capabilities?: FigPluginManifest['capabilities']
  limits: FigPluginManifest['limits']
}

const MAX_STORE_BYTES = 8 * 1024 * 1024
const MAX_LIST_BYTES = 16 * 1024 * 1024
const MAX_LIST_MS = 10_000
const MAX_RECEIPTS = 512
const MAX_MANAGED_RECEIPTS = 256
const MAX_RECORDS = 256
const MAX_SCAN = 512
const MAX_OWNED_BYTES = 128 * 1024 * 1024
type ReadBudget = { remainingBytes: number; deadlineAt: number }
class ReadBudgetExceeded extends Error {}
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const SettingsSchema = figPluginManagedConfigureRequestSchema.shape.settings
const InventorySchema = z
  .array(
    z
      .object({
        path: FigPluginSafeRelativePathSchema,
        bytes: z.number().int().min(1).max(MAX_FILE_BYTES),
        sha256: HashSchema
      })
      .strict()
  )
  .min(1)
  .max(MAX_FILES)
const PackageRecordSchema = z
  .object({
    artifactSha256: HashSchema,
    keyFingerprint: HashSchema,
    inventory: InventorySchema,
    locationId: HashSchema,
    cleanupPending: z.boolean().optional()
  })
  .strict()
type PackageRecord = z.infer<typeof PackageRecordSchema>
const RecordSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]).default(1),
    pluginId: FigPluginIdSchema,
    manifest: FigPluginManifestSchema.nullable(),
    removedManifest: FigPluginManifestSchema.nullable().default(null),
    config: z.record(z.string(), z.unknown()).nullable(),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    packageRecord: PackageRecordSchema.nullable().optional(),
    configRefs: SettingsSchema.nullable().optional(),
    // Retired inventories remain in the same authoritative record until safe cleanup succeeds.
    cleanupPackages: z.array(PackageRecordSchema).max(16).default([]),
    managedReceipts: z
      .array(
        z
          .object({
            key: HashSchema,
            fingerprint: HashSchema,
            result: figPluginManagedMutationSchema
          })
          .strict()
      )
      .max(MAX_MANAGED_RECEIPTS)
      .default([]),
    receipts: z
      .array(
        z
          .object({
            key: HashSchema,
            fingerprint: HashSchema,
            response: FigPluginCenterResponseSchema.refine(
              (response) =>
                response.ok &&
                (response.kind === 'install' ||
                  response.kind === 'configure' ||
                  response.kind === 'uninstall') &&
                !response.status.ready &&
                response.status.activeCalls === 0 &&
                (response.status.state === 'disabled' || response.status.state === 'uninstalled')
            )
          })
          .strict()
      )
      .max(MAX_RECEIPTS)
  })
  .strict()
type StoreRecord = z.infer<typeof RecordSchema>

// Serialize across service/store instances in this main process, not just one object.
const queues = new Map<string, Promise<void>>()
const runtimeListeners = new Map<string, Set<(pluginId: string) => void>>()
const lockKey = (filename: string): string =>
  process.platform === 'win32' ? filename.toLowerCase() : filename
async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const result = previous.then(operation)
  const settled = result.then(
    () => undefined,
    () => undefined
  )
  queues.set(key, settled)
  try {
    return await result
  } finally {
    if (queues.get(key) === settled) queues.delete(key)
  }
}

const identity = (manifest: FigPluginManifest) => ({
  schemaVersion: manifest.schemaVersion,
  id: manifest.id,
  version: manifest.version,
  host: manifest.host,
  capabilities: manifest.capabilities
})

// Manifests reach here only after schema validation, including exact loopback-origin syntax.
const runtimeBridgeOrigin = (manifest: FigPluginManifest | null): string | undefined =>
  manifest?.schemaVersion === 2 &&
  manifest.permissions.network === 'desktop-bridge' &&
  manifest.bridge?.protocol === 1 &&
  manifest.capabilities.includes('dialogue') &&
  manifest.capabilities.includes('asset-transfer') &&
  manifest.permissions.dialogue === 'prompt' &&
  manifest.permissions.assetTransfer === 'read'
    ? manifest.bridge.origin
    : undefined

function status(record: StoreRecord, host: FigPluginHost): FigPluginCenterRedactedStatus {
  return {
    redacted: true,
    pluginId: record.pluginId,
    host,
    state: record.manifest ? 'disabled' : 'uninstalled',
    installed: record.manifest !== null,
    configured: record.config !== null || record.configRefs != null,
    ready: false,
    activeCalls: 0,
    ...(record.manifest
      ? {
          manifestIdentity: identity(record.manifest),
          lastFailure: { reason: 'not-ready' as const, retryable: false }
        }
      : {})
  }
}

function responseBase(operation: FigPluginCenterOperation) {
  return {
    schemaVersion: 1 as const,
    requestId: operation.requestId,
    idempotencyKey: operation.idempotencyKey,
    completedAt: new Date().toISOString()
  }
}

function failure(
  operation: FigPluginCenterOperation,
  reason: FigPluginCenterFailureReason,
  message: string
): FigPluginCenterResponse {
  return {
    ...responseBase(operation),
    kind: operation.kind,
    ok: false,
    failure: {
      type: 'figplugin-center-failure',
      reason,
      message,
      retryable: false,
      requestId: operation.requestId,
      idempotencyKey: operation.idempotencyKey
    }
  }
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const checkDeadline = (deadlineAt: number): void => {
  if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt)
    throw new FigPluginManagementError('TIMEOUT')
}
const locationId = (manifest: FigPluginManifest, artifactSha256: string): string =>
  digest(canonicalFigPluginJson([manifest, artifactSha256]))

/** The existing metadata records also own packages. Nothing here loads or executes their code. */
export class FigPluginCenterStore {
  constructor(private readonly root: string | (() => string)) {}

  private resolveRoot(): string {
    return path.resolve(typeof this.root === 'function' ? this.root() : this.root)
  }

  onRuntimeInvalidated = (listener: (pluginId: string) => void): (() => void) => {
    // Resolve on registration, not construction: Electron's userData root may not be ready yet.
    const key = lockKey(this.resolveRoot()) + ':capacity'
    const listeners = runtimeListeners.get(key) ?? new Set<(pluginId: string) => void>()
    const subscription = (pluginId: string): void => listener(pluginId)
    listeners.add(subscription)
    runtimeListeners.set(key, listeners)
    return () => {
      listeners.delete(subscription)
      if (listeners.size === 0 && runtimeListeners.get(key) === listeners)
        runtimeListeners.delete(key)
    }
  }

  private invalidateRuntime(root: string, pluginId: string): void {
    // Synchronous, pre-commit revocation under the root lock. A failed write still revokes
    // sessions conservatively; cleanup-only commits and historical replays never emit.
    for (const listener of [...(runtimeListeners.get(lockKey(root) + ':capacity') ?? [])]) {
      try {
        listener(pluginId)
      } catch {
        // One disposed/broken consumer must not prevent other revocations or the mutation.
      }
    }
  }

  private async withRoot<T>(
    operation: (root: string) => Promise<T>,
    deadlineAt = Number.MAX_SAFE_INTEGER
  ): Promise<T> {
    const root = this.resolveRoot()
    // Capacity checks and pointer commits must be atomic across different plugin IDs too.
    return serialized(lockKey(root) + ':capacity', async () => {
      checkDeadline(deadlineAt)
      await this.ensureRoot(root)
      checkDeadline(deadlineAt)
      return operation(root)
    })
  }

  private async managed<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof FigPluginManagementError) throw error
      throw new FigPluginManagementError('IO_ERROR')
    }
  }

  private async withRecord<T>(
    pluginId: string,
    operation: (root: string, filename: string, record: StoreRecord) => Promise<T>,
    deadlineAt = Number.MAX_SAFE_INTEGER
  ): Promise<T> {
    return this.withRoot(async (root) => {
      const filename = path.join(root, `${digest(pluginId)}.json`)
      return serialized(lockKey(filename), async () =>
        operation(root, filename, await this.load(filename, pluginId))
      )
    }, deadlineAt)
  }

  listManaged = async (): Promise<FigPluginManagedList> => {
    const budget: ReadBudget = {
      remainingBytes: MAX_LIST_BYTES,
      deadlineAt: Date.now() + MAX_LIST_MS
    }
    const result: FigPluginManagedList = { items: [], truncated: false, skippedRecords: 0 }
    return this.managed(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.withRoot(async (root) => {
            const scan = await this.scan(root, MAX_SCAN, budget.deadlineAt)
            result.truncated = scan.truncated
            for (const name of scan.names) {
              checkDeadline(budget.deadlineAt)
              if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
              if (result.items.length === MAX_RECORDS || budget.remainingBytes === 0) {
                result.truncated = true
                break
              }
              try {
                const record = await this.load(path.join(root, name), undefined, budget)
                checkDeadline(budget.deadlineAt)
                if (record.manifest || (record.removedManifest && this.cleanupPending(record)))
                  result.items.push(this.summary(record))
              } catch (error) {
                if (error instanceof ReadBudgetExceeded) {
                  result.truncated = true
                  break
                }
                if (error instanceof FigPluginManagementError && error.code === 'TIMEOUT')
                  throw error
                result.skippedRecords += 1
              }
            }
          }, budget.deadlineAt),
          // Queue wait counts too. The queued callback checks expiry before touching the root.
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              budget.deadlineAt = 0
              reject(new FigPluginManagementError('TIMEOUT'))
            }, MAX_LIST_MS)
          })
        ])
      } catch (error) {
        if (!(error instanceof FigPluginManagementError) || error.code !== 'TIMEOUT') throw error
        result.truncated = true
      } finally {
        clearTimeout(timer)
      }
      // Snapshot partial results if an in-flight filesystem call outlives the deadline.
      return {
        ...result,
        items: [...result.items].sort((a, b) =>
          a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0
        )
      }
    })
  }

  getManagedGeneration = async (pluginId: string): Promise<number> => {
    const id = parseFigPluginManagementValue(FigPluginIdSchema, pluginId)
    return this.managed(() =>
      this.withRecord(id, async (_root, _filename, record) => record.generation)
    )
  }

  installVerifiedPackage = async (
    verified: VerifiedFigPluginPackage,
    expectedGeneration: number,
    idempotencyKey: string,
    deadlineAt = Date.now() + 30_000
  ): Promise<FigPluginManagedMutation> => {
    const request = parseFigPluginManagementValue(
      figPluginPackageInstallRequestSchema.omit({ receiptId: true }),
      { expectedGeneration, idempotencyKey }
    )
    // Snapshot buffers before any queue wait. The verifier is main-only; still recheck its content boundary.
    let snapshot: VerifiedFigPluginPackage
    let owned: PackageRecord
    try {
      const pkg = FigPluginPackageSchema.parse(verified.package)
      if (
        !HashSchema.safeParse(verified.keyFingerprint).success ||
        verified.artifactSha256 !== digest(canonicalFigPluginPackageIndex(pkg)) ||
        pkg.manifest.provenance.artifactSha256 !== verified.artifactSha256 ||
        verified.files.length !== pkg.files.length
      )
        throw new Error('Invalid verified package')
      const files = verified.files.map((file) => {
        if (!Buffer.isBuffer(file.data) || file.data.length > MAX_FILE_BYTES)
          throw new Error('Invalid file')
        return { path: file.path, data: Buffer.from(file.data) }
      })
      let bytes = 0
      const seen = new Set<string>()
      for (const file of files) {
        const declared = pkg.files.find((item) => item.path === file.path)
        if (
          !declared ||
          seen.has(file.path) ||
          file.data.length !== declared.bytes ||
          digest(file.data) !== declared.sha256 ||
          !file.data.equals(Buffer.from(declared.contentBase64, 'base64'))
        )
          throw new Error('Invalid content')
        seen.add(file.path)
        bytes += file.data.length
      }
      if (bytes > MAX_CONTENT_BYTES) throw new Error('Invalid content size')
      owned = {
        artifactSha256: verified.artifactSha256,
        keyFingerprint: verified.keyFingerprint,
        inventory: pkg.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
        locationId: locationId(pkg.manifest, verified.artifactSha256)
      }
      this.inventoryTree(owned.inventory)
      snapshot = {
        package: pkg,
        files,
        artifactSha256: owned.artifactSha256,
        keyFingerprint: owned.keyFingerprint
      }
    } catch {
      throw new FigPluginManagementError('INVALID_PACKAGE')
    }
    return this.managed(() =>
      this.withRecord(snapshot.package.manifest.id, async (root, filename, record) => {
        const key = digest(request.idempotencyKey)
        const fingerprint = digest(
          canonicalFigPluginJson([
            'install',
            record.pluginId,
            request.expectedGeneration,
            snapshot.package.manifest,
            owned.artifactSha256,
            owned.keyFingerprint
          ])
        )
        const replay = this.replay(record, key, fingerprint)
        if (replay) return replay
        this.checkGeneration(record, request.expectedGeneration)
        checkDeadline(deadlineAt)
        this.receiptCapacity(record, false)
        if (record.cleanupPackages.length >= 16) throw new FigPluginManagementError('BUSY')
        if (
          record.configRefs != null &&
          measureFigPluginConfigBytes(record.configRefs) >
            snapshot.package.manifest.limits.maxConfigBytes
        )
          throw new FigPluginManagementError('INVALID_PACKAGE')
        await this.checkCapacity(root, record.pluginId, owned, deadlineAt)
        const directory = this.packagePath(root, record.pluginId, owned)
        await this.stage(root, directory, snapshot, owned, deadlineAt)
        if (record.packageRecord && record.packageRecord.locationId !== owned.locationId) {
          record.cleanupPackages.push(record.packageRecord)
        }
        // Never accidentally retire the version being reinstalled after a failed removal.
        record.cleanupPackages = record.cleanupPackages.filter(
          (item) => item.locationId !== owned.locationId
        )
        record.schemaVersion = 2
        record.manifest = snapshot.package.manifest
        record.removedManifest = null
        record.packageRecord = owned
        record.generation += 1
        const result = {
          completed: true,
          generation: record.generation,
          cleanupPending: record.cleanupPackages.length > 0
        }
        record.managedReceipts.push({ key, fingerprint, result })
        // A failed pointer commit intentionally retains the unreferenced directory. A retry may
        // reuse it only after full integrity checks; unrelated orphan directories fail capacity closed.
        await this.safeDirectory(directory)
        this.invalidateRuntime(root, record.pluginId)
        await this.commit(root, filename, record, deadlineAt)
        return this.finishCleanup(root, filename, record, key, deadlineAt)
      })
    )
  }

  configureManaged = async (
    input: FigPluginManagedConfigureRequest,
    deadlineAt = Date.now() + 30_000
  ): Promise<FigPluginManagedMutation> => {
    const request = parseFigPluginManagementValue(figPluginManagedConfigureRequestSchema, input)
    return this.managed(() =>
      this.withRecord(request.pluginId, async (root, filename, record) => {
        this.checkGeneration(record, request.expectedGeneration)
        checkDeadline(deadlineAt)
        if (!record.manifest) throw new FigPluginManagementError('NOT_INSTALLED')
        if (measureFigPluginConfigBytes(request.settings) > record.manifest.limits.maxConfigBytes)
          throw new FigPluginManagementError('INVALID_PACKAGE')
        record.schemaVersion = 2
        record.configRefs = request.settings
        record.generation += 1
        this.invalidateRuntime(root, record.pluginId)
        await this.commit(root, filename, record, deadlineAt)
        return {
          completed: true,
          generation: record.generation,
          cleanupPending: this.cleanupPending(record)
        }
      })
    )
  }

  removeManaged = async (
    input: FigPluginManagedRemoveRequest,
    deadlineAt = Date.now() + 30_000
  ): Promise<FigPluginManagedMutation> => {
    const request = parseFigPluginManagementValue(figPluginManagedRemoveRequestSchema, input)
    return this.managed(() =>
      this.withRecord(request.pluginId, async (root, filename, record) => {
        const key = digest(request.idempotencyKey)
        const fingerprint = digest(
          canonicalFigPluginJson(['remove', request.pluginId, request.expectedGeneration])
        )
        const replay = this.replay(record, key, fingerprint)
        if (replay) {
          // Cleanup may retry after expiry/CAS changes, but never touch a newer installation.
          if (
            replay.cleanupPending &&
            record.generation === replay.generation &&
            !record.manifest
          ) {
            return this.finishCleanup(root, filename, record, key, deadlineAt)
          }
          return replay
        }
        this.checkGeneration(record, request.expectedGeneration)
        checkDeadline(deadlineAt)
        this.receiptCapacity(record, true)
        await this.checkRecordCapacity(root, filename)
        record.schemaVersion = 2
        record.removedManifest = record.manifest ?? record.removedManifest
        record.manifest = null
        record.config = null
        record.configRefs = null
        if (record.packageRecord) record.packageRecord.cleanupPending = true
        if (!this.cleanupPending(record)) record.removedManifest = null
        record.generation += 1
        const result = {
          completed: true,
          generation: record.generation,
          cleanupPending: this.cleanupPending(record)
        }
        record.managedReceipts.push({ key, fingerprint, result })
        // Tombstone and replay receipt are durable before even attempting deletion.
        this.invalidateRuntime(root, record.pluginId)
        await this.commit(root, filename, record, deadlineAt)
        return this.finishCleanup(root, filename, record, key, deadlineAt)
      })
    )
  }

  getRuntimeDescriptor = async (
    input: FigPluginManagedTarget,
    deadlineAt = Date.now() + 10_000
  ): Promise<FigPluginRuntimeDescriptor> => {
    const request = parseFigPluginManagementValue(figPluginManagedTargetSchema, input)
    return this.managed(() =>
      this.withRecord(
        request.pluginId,
        async (root, _filename, record) => {
          checkDeadline(deadlineAt)
          this.checkGeneration(record, request.expectedGeneration)
          const manifest = record.manifest
          const pkg = record.packageRecord
          if (!manifest || !pkg) throw new FigPluginManagementError('NOT_INSTALLED')
          const bridgeOrigin = runtimeBridgeOrigin(manifest)
          const profileId = record.configRefs?.analysisProfileId
          if (!bridgeOrigin || !profileId)
            throw new FigPluginManagementError('CONFIGURATION_CHANGED')
          // Import verified the signature/native policy in main. The validated normalized manifest
          // is bound to this inventory by load(); recheck every installed byte without loading code.
          try {
            await this.verifyOwned(this.packagePath(root, record.pluginId, pkg), pkg, deadlineAt)
          } catch (error) {
            if (error instanceof FigPluginManagementError && error.code === 'TIMEOUT') throw error
            throw new FigPluginManagementError('INTEGRITY_FAILED')
          }
          checkDeadline(deadlineAt)
          return {
            pluginId: record.pluginId,
            host: manifest.host,
            generation: record.generation,
            artifactSha256: pkg.artifactSha256,
            signerFingerprint: pkg.keyFingerprint,
            manifestSha256: digest(canonicalFigPluginJson(manifest)),
            bridgeOrigin,
            profileId,
            capabilities: [...manifest.capabilities],
            limits: { ...manifest.limits }
          }
        },
        deadlineAt
      )
    )
  }

  getOwnedEntryPath = async (
    input: FigPluginManagedTarget,
    deadlineAt = Date.now() + 30_000
  ): Promise<string> => {
    const request = parseFigPluginManagementValue(figPluginManagedTargetSchema, input)
    return this.managed(() =>
      this.withRecord(request.pluginId, async (root, _filename, record) => {
        this.checkGeneration(record, request.expectedGeneration)
        if (!record.manifest || !record.packageRecord || !record.manifest.entryPath)
          throw new FigPluginManagementError('NOT_INSTALLED')
        const directory = this.packagePath(root, record.pluginId, record.packageRecord)
        try {
          await this.verifyOwned(directory, record.packageRecord, deadlineAt)
        } catch (error) {
          if (error instanceof FigPluginManagementError && error.code === 'TIMEOUT') throw error
          throw new FigPluginManagementError('INTEGRITY_FAILED')
        }
        checkDeadline(deadlineAt)
        return path.join(directory, record.manifest.entryPath)
      })
    )
  }

  private summary(record: StoreRecord): FigPluginManagedSummary {
    const manifest = (record.manifest ?? record.removedManifest)!
    const pkg = record.packageRecord
    const bridgeOrigin = pkg ? runtimeBridgeOrigin(record.manifest) : undefined
    return {
      pluginId: record.pluginId,
      name: manifest.name,
      version: manifest.version,
      host: manifest.host,
      generation: record.generation,
      capabilities: manifest.capabilities,
      manifestSha256: digest(canonicalFigPluginJson(manifest)),
      materialization: !record.manifest
        ? 'cleanup-pending'
        : pkg
          ? 'verified-package'
          : 'metadata-only',
      ...(pkg ? { signerFingerprint: pkg.keyFingerprint, artifactSha256: pkg.artifactSha256 } : {}),
      ...(bridgeOrigin ? { bridgeOrigin } : {}),
      fileCount: pkg?.inventory.length ?? 0,
      contentBytes: pkg?.inventory.reduce((sum, file) => sum + file.bytes, 0) ?? 0,
      configured: record.manifest !== null && (record.config !== null || record.configRefs != null),
      ready: false,
      state: record.manifest ? 'disabled' : 'uninstalled',
      cleanupPending: this.cleanupPending(record),
      settings: record.manifest ? (record.configRefs ?? {}) : {}
    }
  }

  private cleanupPending(record: StoreRecord): boolean {
    return record.packageRecord?.cleanupPending === true || record.cleanupPackages.length > 0
  }

  private replay(
    record: StoreRecord,
    key: string,
    fingerprint: string
  ): FigPluginManagedMutation | undefined {
    const receipt = record.managedReceipts.find((item) => item.key === key)
    if (!receipt) return undefined
    if (receipt.fingerprint !== fingerprint)
      throw new FigPluginManagementError('IDEMPOTENCY_CONFLICT')
    return { ...receipt.result }
  }

  private receiptCapacity(record: StoreRecord, removing: boolean): void {
    if (record.managedReceipts.length >= MAX_MANAGED_RECEIPTS - (removing ? 0 : 1))
      throw new FigPluginManagementError('BUSY')
  }

  private checkGeneration(record: StoreRecord, expected: number): void {
    if (record.generation !== expected) throw new FigPluginManagementError('CONFIGURATION_CHANGED')
    if (record.generation === Number.MAX_SAFE_INTEGER) throw new FigPluginManagementError('BUSY')
  }

  private async commit(
    root: string,
    filename: string,
    record: StoreRecord,
    deadlineAt: number
  ): Promise<void> {
    checkDeadline(deadlineAt)
    if (!(await this.save(root, filename, record, deadlineAt)))
      throw new FigPluginManagementError('TIMEOUT')
  }

  private async finishCleanup(
    root: string,
    filename: string,
    record: StoreRecord,
    key: string,
    deadlineAt: number
  ): Promise<FigPluginManagedMutation> {
    const receipt = record.managedReceipts.find((item) => item.key === key)!
    if (!receipt.result.cleanupPending) return { ...receipt.result }
    // Post-commit failures can only leave cleanup pending, never turn a successful removal
    // into a failed/ambiguous mutation. Generation identifies the committed tombstone.
    try {
      checkDeadline(deadlineAt)
      for (const pkg of record.cleanupPackages) {
        await this.deleteOwned(
          this.packagePath(root, record.pluginId, pkg),
          pkg.inventory,
          deadlineAt
        )
      }
      if (!record.manifest && record.packageRecord) {
        await this.deleteOwned(
          this.packagePath(root, record.pluginId, record.packageRecord),
          record.packageRecord.inventory,
          deadlineAt
        )
      }
      record.cleanupPackages = []
      record.removedManifest = null
      if (!record.manifest) record.packageRecord = null
      const result = { ...receipt.result, cleanupPending: false }
      receipt.result = result
      await this.commit(root, filename, record, deadlineAt)
      return { ...result }
    } catch {
      return { completed: true, generation: receipt.result.generation, cleanupPending: true }
    }
  }

  private packagePath(root: string, pluginId: string, pkg: PackageRecord): string {
    return path.join(root, 'packages', digest(pluginId), pkg.locationId)
  }

  /** At most 512 directory entries, including ignored names; no unbounded readdir. */
  private async scan(
    directory: string,
    limit = MAX_SCAN,
    deadlineAt = Number.MAX_SAFE_INTEGER
  ): Promise<{ names: string[]; truncated: boolean }> {
    checkDeadline(deadlineAt)
    await this.safeDirectory(directory)
    checkDeadline(deadlineAt)
    const handle = await fs.opendir(directory, { bufferSize: 1 })
    const names: string[] = []
    try {
      while (names.length < limit) {
        checkDeadline(deadlineAt)
        const entry = await handle.read()
        checkDeadline(deadlineAt)
        if (!entry) return { names, truncated: false }
        names.push(entry.name)
      }
      return { names, truncated: true }
    } finally {
      await handle.close()
    }
  }

  private async checkRecordCapacity(root: string, filename: string): Promise<void> {
    const scan = await this.scan(root)
    const names = scan.names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    if (
      scan.truncated ||
      names.length > MAX_RECORDS ||
      (names.length === MAX_RECORDS && !names.includes(path.basename(filename)))
    )
      throw new FigPluginManagementError('BUSY')
  }

  private async checkCapacity(
    root: string,
    pluginId: string,
    incoming: PackageRecord,
    deadlineAt: number
  ): Promise<void> {
    await this.checkRecordCapacity(root, path.join(root, `${digest(pluginId)}.json`))
    const scan = await this.scan(root)
    const known = new Map<string, Map<string, PackageRecord>>()
    const add = (id: string, pkg: PackageRecord): void => {
      const versions = known.get(digest(id)) ?? new Map<string, PackageRecord>()
      versions.set(pkg.locationId, pkg)
      known.set(digest(id), versions)
    }
    for (const name of scan.names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      checkDeadline(deadlineAt)
      const record = await this.load(path.join(root, name))
      // A retained tombstone also owns its now-empty per-ID parent directory.
      known.set(digest(record.pluginId), new Map())
      if (record.packageRecord) add(record.pluginId, record.packageRecord)
      for (const pkg of record.cleanupPackages)
        add(record.pluginId, { ...pkg, cleanupPending: true })
    }
    add(pluginId, incoming)
    let bytes = 0
    for (const versions of known.values()) {
      for (const pkg of versions.values())
        bytes += pkg.inventory.reduce((sum, file) => sum + file.bytes, 0)
    }
    // Missing cleanup files still count: only a successful cleanup commit releases their quota.
    if (bytes > MAX_OWNED_BYTES) throw new FigPluginManagementError('BUSY')
    const packages = path.join(root, 'packages')
    await this.safeDirectory(packages, true)
    const parents = await this.scan(packages)
    if (parents.truncated) throw new FigPluginManagementError('BUSY')
    let scanned = parents.names.length
    for (const parent of parents.names) {
      const versions = known.get(parent)
      if (!versions || scanned >= MAX_SCAN) throw new FigPluginManagementError('BUSY')
      const entries = await this.scan(path.join(packages, parent), MAX_SCAN - scanned)
      scanned += entries.names.length
      if (entries.truncated) throw new FigPluginManagementError('BUSY')
      for (const name of entries.names) {
        const pkg = versions.get(name)
        // Orphans have no authoritative inventory: retain them, don't guess ownership or
        // ignore their disk usage. Reinstalling the same verified candidate can recover one.
        if (!pkg) throw new FigPluginManagementError('BUSY')
        checkDeadline(deadlineAt)
        await this.verifyOwned(
          path.join(packages, parent, name),
          pkg,
          deadlineAt,
          pkg.cleanupPending === true
        )
      }
    }
  }

  private inventoryTree(inventory: PackageRecord['inventory']): Map<string, Set<string>> {
    const tree = new Map<string, Set<string>>([['', new Set()]])
    const files = new Set<string>()
    const entries = new Map<string, string>()
    for (const file of inventory) {
      const parts = file.path.split('/')
      let parent = ''
      for (let index = 0; index < parts.length; index += 1) {
        const segment = parts[index]
        const relative = parent ? `${parent}/${segment}` : segment
        const canonical = relative.toLowerCase()
        const previous = entries.get(canonical)
        if (
          (previous && previous !== relative) ||
          (index < parts.length - 1 && files.has(canonical))
        )
          throw new Error('Path collision')
        entries.set(canonical, relative)
        tree.get(parent)!.add(segment)
        if (index < parts.length - 1) {
          if (!tree.has(relative)) tree.set(relative, new Set())
        } else {
          if (files.has(canonical) || tree.has(relative)) throw new Error('Path collision')
          files.add(canonical)
        }
        parent = relative
      }
    }
    if (entries.size >= MAX_SCAN) throw new Error('Inventory tree is full')
    return tree
  }

  private async verifyOwned(
    directory: string,
    pkg: PackageRecord,
    deadlineAt: number,
    allowMissing = false
  ): Promise<void> {
    const tree = this.inventoryTree(pkg.inventory)
    let scanned = 0
    for (const [relative, expected] of tree) {
      checkDeadline(deadlineAt)
      try {
        const result = await this.scan(path.join(directory, relative), MAX_SCAN - scanned)
        scanned += result.names.length
        if (
          result.truncated ||
          (!allowMissing && result.names.length !== expected.size) ||
          result.names.some((name) => !expected.has(name))
        )
          throw new Error('Unexpected package entries')
      } catch (error) {
        if (!allowMissing || !missing(error)) throw error
      }
    }
    for (const file of pkg.inventory) {
      checkDeadline(deadlineAt)
      try {
        const data = await this.readRegular(path.join(directory, file.path), MAX_FILE_BYTES)
        if (data.length !== file.bytes || digest(data) !== file.sha256)
          throw new Error('Package content changed')
      } catch (error) {
        if (!allowMissing || !missing(error)) throw error
      }
    }
    await this.safeDirectory(directory)
  }

  private async stage(
    root: string,
    directory: string,
    verified: VerifiedFigPluginPackage,
    pkg: PackageRecord,
    deadlineAt: number
  ): Promise<void> {
    let exists = true
    try {
      await fs.lstat(directory)
    } catch (error) {
      if (!missing(error)) throw error
      exists = false
    }
    if (exists) {
      await this.verifyOwned(directory, pkg, deadlineAt)
      return
    }
    const parent = path.dirname(directory)
    await this.safeDirectory(parent, true)
    const staging = path.join(parent, `.staging-${randomUUID()}`)
    await fs.mkdir(staging, { mode: 0o700 })
    let renamed = false
    try {
      for (const file of verified.files) {
        checkDeadline(deadlineAt)
        const filename = path.join(staging, file.path)
        await this.safeDirectory(path.dirname(filename), true)
        const handle = await fs.open(filename, 'wx', 0o600)
        try {
          await handle.writeFile(file.data)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      await this.verifyOwned(staging, pkg, deadlineAt)
      await this.ensureRoot(root)
      await this.safeDirectory(parent)
      checkDeadline(deadlineAt)
      await fs.rename(staging, directory)
      renamed = true
    } finally {
      if (!renamed)
        await this.deleteOwned(staging, pkg.inventory, Number.MAX_SAFE_INTEGER).catch(
          () => undefined
        )
    }
  }

  private async deleteOwned(
    directory: string,
    inventory: PackageRecord['inventory'],
    deadlineAt: number
  ): Promise<void> {
    try {
      await this.safeDirectory(directory)
    } catch (error) {
      if (missing(error)) return
      throw error
    }
    // Never recursively rm: unknown files, substituted links and modified content survive.
    const directories = [...this.inventoryTree(inventory).keys()].sort(
      (a, b) => b.length - a.length
    )
    // Detect already-modified content before removing any other file. A later OS unlink
    // failure can still leave partial cleanup, but known user changes do not destroy peers.
    for (const file of inventory) {
      checkDeadline(deadlineAt)
      try {
        const data = await this.readRegular(path.join(directory, file.path), MAX_FILE_BYTES)
        if (data.length !== file.bytes || digest(data) !== file.sha256)
          throw new Error('Package content changed')
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    for (const file of inventory) {
      checkDeadline(deadlineAt)
      const filename = path.join(directory, file.path)
      try {
        const data = await this.readRegular(filename, MAX_FILE_BYTES)
        if (data.length !== file.bytes || digest(data) !== file.sha256)
          throw new Error('Package content changed')
        checkDeadline(deadlineAt)
        await fs.unlink(filename)
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    for (const relative of directories) {
      checkDeadline(deadlineAt)
      const target = path.join(directory, relative)
      try {
        await this.safeDirectory(target)
        await fs.rmdir(target)
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
  }

  execute = async (input: unknown): Promise<FigPluginCenterResponse> => {
    const operation = validateServiceValue(input, figPluginCenterSvcDef.execute.request)
    const startedAt = Date.now()
    if (operation.cancellation.requested) {
      return failure(operation, 'cancelled', 'Operation was cancelled.')
    }
    if (operation.kind === 'inspect') {
      return {
        ...responseBase(operation),
        kind: 'inspect',
        ok: true,
        pluginId: operation.manifest.id,
        manifest: operation.manifest
      }
    }
    if (operation.kind === 'call') {
      return failure(operation, 'not-ready', 'HostAdapter is unavailable; calls are unsupported.')
    }

    try {
      const pluginId = operation.kind === 'install' ? operation.manifest.id : operation.pluginId
      return await this.withRecord(pluginId, async (root, filename, record) => {
        // Only committed JSON is authoritative after a crash; never promote partial temp files.
        const tempPattern = new RegExp(`^\\.${digest(pluginId)}\\.json\\.[a-f0-9-]{36}\\.tmp$`)
        for (const name of (await this.scan(root)).names) {
          if (!tempPattern.test(name)) continue
          const temp = path.join(root, name)
          const info = await fs.lstat(temp)
          if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) await fs.unlink(temp)
        }
        return this.apply(root, filename, record, operation, startedAt)
      })
    } catch {
      // Never propagate filesystem paths, config, manifests, or raw errors to IPC/logging.
      return failure(operation, 'internal-error', 'FIGPLUGIN store is unavailable.')
    }
  }

  private async safeDirectory(directory: string, create = false): Promise<void> {
    const resolved = path.resolve(directory)
    let current = path.parse(resolved).root
    const parts = path.relative(current, resolved).split(path.sep).filter(Boolean)
    for (const part of ['', ...parts]) {
      if (part) current = path.join(current, part)
      let info: Awaited<ReturnType<typeof fs.lstat>>
      try {
        info = await fs.lstat(current)
      } catch (error) {
        if (!create || !missing(error)) throw error
        try {
          await fs.mkdir(current, { mode: 0o700 })
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
        }
        info = await fs.lstat(current)
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe directory')
    }
  }

  private async ensureRoot(root: string): Promise<void> {
    await this.safeDirectory(root, true)
  }

  private async readRegular(
    filename: string,
    maximum: number,
    budget?: ReadBudget
  ): Promise<Buffer> {
    if (budget) checkDeadline(budget.deadlineAt)
    await this.safeDirectory(path.dirname(filename))
    const info = await fs.lstat(filename)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum)
      throw new Error('Unsafe file')
    if (budget) {
      checkDeadline(budget.deadlineAt)
      if (info.size > budget.remainingBytes) throw new ReadBudgetExceeded()
    }
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.ino !== info.ino ||
        opened.dev !== info.dev ||
        opened.size !== info.size
      )
        throw new Error('File changed')
      // Charge actual reads (including a growth probe), even if parsing or validation later fails.
      const buffer = Buffer.alloc(Math.min(info.size + 1, budget?.remainingBytes ?? info.size + 1))
      let offset = 0
      while (offset < buffer.length) {
        if (budget) checkDeadline(budget.deadlineAt)
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (budget) budget.remainingBytes -= bytesRead
        if (!bytesRead) break
        offset += bytesRead
      }
      const after = await handle.stat()
      const current = await fs.lstat(filename)
      if (
        offset !== info.size ||
        after.size !== info.size ||
        after.nlink !== 1 ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.ino !== info.ino ||
        current.dev !== info.dev
      )
        throw new Error('File changed')
      await this.safeDirectory(path.dirname(filename))
      if (budget) checkDeadline(budget.deadlineAt)
      return buffer.subarray(0, offset)
    } finally {
      await handle.close()
    }
  }

  private async load(
    filename: string,
    pluginId?: string,
    budget?: ReadBudget
  ): Promise<StoreRecord> {
    let text: Buffer
    try {
      text = await this.readRegular(filename, MAX_STORE_BYTES, budget)
    } catch (error) {
      if (!missing(error) || pluginId === undefined) throw error
      return RecordSchema.parse({
        schemaVersion: 1,
        pluginId,
        manifest: null,
        config: null,
        receipts: []
      })
    }
    if (budget) checkDeadline(budget.deadlineAt)
    const record = RecordSchema.parse(JSON.parse(text.toString('utf8')))
    if (
      (pluginId !== undefined && record.pluginId !== pluginId) ||
      path.basename(filename) !== `${digest(record.pluginId)}.json` ||
      (record.manifest && record.manifest.id !== record.pluginId) ||
      (record.removedManifest && record.removedManifest.id !== record.pluginId) ||
      (record.manifest && record.receipts.length === MAX_RECEIPTS && !record.packageRecord) ||
      (!record.manifest && (record.config !== null || record.configRefs != null)) ||
      new Set(record.receipts.map((receipt) => receipt.key)).size !== record.receipts.length ||
      new Set(record.managedReceipts.map((receipt) => receipt.key)).size !==
        record.managedReceipts.length ||
      record.managedReceipts.some(
        (receipt) => !receipt.result.completed || receipt.result.generation > record.generation
      ) ||
      record.receipts.some(
        (receipt) => !receipt.response.ok || receipt.response.pluginId !== record.pluginId
      )
    )
      throw new Error('Invalid store identity')
    // Legacy config is preserved but never consumed by the managed package. A new manifest's
    // smaller config limit applies to references, not to historical opaque metadata.
    if (
      record.config !== null &&
      measureFigPluginConfigBytes(record.config) >
        (record.packageRecord ? FIGPLUGIN_MAX_CONFIG_BYTES : record.manifest!.limits.maxConfigBytes)
    )
      throw new Error('Invalid stored configuration')
    if (
      record.configRefs != null &&
      measureFigPluginConfigBytes(record.configRefs) > record.manifest!.limits.maxConfigBytes
    )
      throw new Error('Invalid stored references')
    for (const pkg of [
      ...record.cleanupPackages,
      ...(record.packageRecord ? [record.packageRecord] : [])
    ]) {
      this.inventoryTree(pkg.inventory)
      if (
        pkg.inventory.reduce((sum, file) => sum + file.bytes, 0) > MAX_CONTENT_BYTES ||
        digest(
          canonicalFigPluginJson({
            format: FIGPLUGIN_PACKAGE_FORMAT,
            files: [...pkg.inventory].sort((a, b) =>
              a.path < b.path ? -1 : a.path > b.path ? 1 : 0
            )
          })
        ) !== pkg.artifactSha256
      )
        throw new Error('Invalid inventory')
    }
    if (record.packageRecord) {
      const pkg = record.packageRecord
      if (!record.manifest && !pkg.cleanupPending) throw new Error('Invalid package tombstone')
      if (record.manifest && pkg.cleanupPending) throw new Error('Invalid package identity')
      const manifest = record.manifest ?? record.removedManifest
      if (manifest) {
        if (
          pkg.locationId !== locationId(manifest, pkg.artifactSha256) ||
          pkg.artifactSha256 !== manifest.provenance.artifactSha256 ||
          !pkg.inventory.some((file) => file.path === manifest.entryPath) ||
          manifest.assets.length !== pkg.inventory.length ||
          manifest.assets.some(
            (asset) =>
              !pkg.inventory.some(
                (file) =>
                  file.path === asset.path &&
                  file.bytes === asset.sizeBytes &&
                  file.sha256 === asset.sha256
              )
          )
        )
          throw new Error('Invalid package identity')
      }
    }
    return record
  }

  private async save(
    root: string,
    filename: string,
    record: StoreRecord,
    deadlineAt: number
  ): Promise<boolean> {
    const bytes = Buffer.from(canonicalFigPluginJson(record), 'utf8')
    if (bytes.byteLength > MAX_STORE_BYTES) throw new Error('Store record is full')
    await this.ensureRoot(root)
    const temp = path.join(root, `.${path.basename(filename)}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(temp, 'wx', 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.ensureRoot(root)
      try {
        const info = await fs.lstat(filename)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error('Unsafe store record')
      } catch (error) {
        if (!missing(error)) throw error
      }
      // Rename is the commit point. Report its actual outcome even after deadline expiry.
      // No delete-and-retry fallback: failed replacement must preserve the previous record.
      if (Date.now() >= deadlineAt) return false
      await fs.rename(temp, filename)
      return true
    } finally {
      await handle?.close().catch(() => undefined)
      await fs.unlink(temp).catch(() => undefined)
    }
  }

  private async apply(
    root: string,
    filename: string,
    record: StoreRecord,
    operation: Exclude<FigPluginCenterOperation, { kind: 'inspect' | 'call' }>,
    startedAt: number
  ): Promise<FigPluginCenterResponse> {
    const host = operation.kind === 'install' ? operation.manifest.host : operation.host
    const base = { ...responseBase(operation), pluginId: record.pluginId, ok: true as const }
    if (Date.now() - startedAt >= operation.timeoutMs) {
      return failure(operation, 'timeout', 'Operation timed out before applying changes.')
    }
    if (operation.kind === 'status' || operation.kind === 'copy-path') {
      if (record.manifest && record.manifest.host !== host) {
        return failure(
          operation,
          'manifest-mismatch',
          'Host does not match the installed manifest.'
        )
      }
      if (operation.kind === 'status')
        return { ...base, kind: 'status', status: status(record, host) }
      if (!record.manifest) return failure(operation, 'not-installed', 'Plugin is not installed.')
      return { ...base, kind: 'copy-path', host, path: operation.path, displayOnly: true }
    }
    if (record.packageRecord || record.cleanupPackages.length) {
      return failure(operation, 'not-ready', 'Verified packages require managed operations.')
    }
    const key = digest(canonicalFigPluginJson([operation.kind, operation.idempotencyKey]))
    // Keep a separately bound complete config for receipt-format compatibility.
    const fingerprint = digest(
      operation.kind === 'configure'
        ? canonicalFigPluginJson([
            getFigPluginCenterIdempotencyFingerprint({ ...operation, config: {} }),
            canonicalFigPluginJson(operation.config)
          ])
        : getFigPluginCenterIdempotencyFingerprint(operation)
    )
    const replay = record.receipts.find((receipt) => receipt.key === key)
    if (replay) {
      if (replay.fingerprint !== fingerprint)
        return failure(operation, 'idempotency-conflict', 'Idempotency key has different content.')
      return { ...replay.response, requestId: operation.requestId }
    }
    // Historical replay is independent of current host, but new mutations are not.
    if (record.manifest && record.manifest.host !== host)
      return failure(operation, 'manifest-mismatch', 'Host does not match the installed manifest.')
    if (record.receipts.length >= MAX_RECEIPTS - 1 && operation.kind !== 'uninstall')
      return failure(operation, 'busy', 'Plugin operation history is full.')
    if (record.generation === Number.MAX_SAFE_INTEGER)
      return failure(operation, 'busy', 'Plugin operation history is full.')
    await this.checkRecordCapacity(root, filename)
    let response: FigPluginCenterResponse
    if (operation.kind === 'install') {
      if (
        record.manifest &&
        canonicalFigPluginJson(record.manifest) !== canonicalFigPluginJson(operation.manifest)
      )
        return failure(operation, 'manifest-mismatch', 'A different manifest is already installed.')
      record.manifest = operation.manifest
      record.removedManifest = null
      response = {
        ...base,
        kind: 'install',
        manifestIdentity: identity(operation.manifest),
        status: status(record, host)
      }
    } else if (operation.kind === 'configure') {
      if (!record.manifest) return failure(operation, 'not-installed', 'Plugin is not installed.')
      const configBytes = measureFigPluginConfigBytes(operation.config)
      if (
        configBytes !== operation.configBytes ||
        configBytes > Math.min(FIGPLUGIN_MAX_CONFIG_BYTES, record.manifest.limits.maxConfigBytes)
      )
        return failure(operation, 'payload-too-large', 'Configuration exceeds the manifest limit.')
      record.config = operation.config
      response = { ...base, kind: 'configure', status: status(record, host) }
    } else {
      const alreadyUninstalled = record.manifest === null
      record.manifest = null
      record.removedManifest = null
      record.config = null
      record.configRefs = null
      response = {
        ...base,
        kind: 'uninstall',
        host,
        status: status(record, host),
        alreadyUninstalled,
        idempotent: true
      }
      if (record.receipts.length === MAX_RECEIPTS) return response
    }
    record.generation += 1
    record.receipts.push({ key, fingerprint, response })
    if (Date.now() - startedAt >= operation.timeoutMs)
      return failure(operation, 'timeout', 'Operation timed out before applying changes.')
    this.invalidateRuntime(root, record.pluginId)
    if (!(await this.save(root, filename, record, startedAt + operation.timeoutMs)))
      return failure(operation, 'timeout', 'Operation timed out before committing changes.')
    return response
  }
}
