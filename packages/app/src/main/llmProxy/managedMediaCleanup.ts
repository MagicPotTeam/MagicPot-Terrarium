import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isPathInsideRoot } from './managedMediaStore'
import { parseManagedMediaDerivativeManifest } from './managedMediaDerivativeManifest'

const MEDIA_ID = /^[a-f0-9]{64}$/u
const ORIGINAL_PATH = /^originals\/([a-f0-9]{2})\/([a-f0-9]{64})\.([a-z0-9]+)$/u
const METADATA_SCHEMA = 'magicpot.managed-media/v1'
const MEDIA_SCOPE_PATTERN = /^[a-z0-9_](?:[a-z0-9._-]{0,126}[a-z0-9_])?$/u
const TASK_ROOT_PREFIX = 'comfy-outputs/tasks/'
const GLOBAL_ROOT_PREFIX = 'comfy-outputs/global'
const LIFECYCLE_NAMESPACE_PREFIXES = ['task/', 'model/'] as const
const USER_OUTPUT_ROOT_PREFIX = 'user-output'

type Manifest = Record<string, unknown>
type Skipped = { relativePath: string; reason: string }

const DEFAULT_STAGING_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_STAGING_BYTES = 64 * 1024 * 1024
const MAX_CLEANUP_JSON_BYTES = 64 * 1024
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

/** Retention limits for task-owned staging material. */
export type ManagedMediaRetentionPolicy = Readonly<{
  stagingTtlMs: number
  /** Minimum age for a complete, unreferenced durable media record. */
  orphanTtlMs: number
  maxStagingBytes: number
}>

/** Non-sensitive counters emitted with every cleanup plan and result. */
export type ManagedMediaCleanupAudit = Readonly<{
  stagingFileCount: number
  stagingBytes: number
  staleStagingFileCount: number
  staleStagingBytes: number
  quotaBytes: number
  quotaExceeded: boolean
  durableOrphanRecordCount: number
  retainedDurableOrphanRecordCount: number
  orphanTtlMs: number
}>

export const DEFAULT_MANAGED_MEDIA_RETENTION: ManagedMediaRetentionPolicy = Object.freeze({
  stagingTtlMs: DEFAULT_STAGING_TTL_MS,
  orphanTtlMs: DEFAULT_ORPHAN_TTL_MS,
  maxStagingBytes: DEFAULT_MAX_STAGING_BYTES
})

export type ManagedMediaCleanupAction =
  | {
      /** Planner action for one validated derivative image file. */
      kind: 'derivative-file'
      mediaId: string
      /** Base-relative path; task/global stores carry a safe logical prefix. */
      relativePath: string
    }
  | {
      /** Planner action for one validated content-addressed original image. */
      kind: 'original-file'
      mediaId: string
      relativePath: string
    }
  | {
      /** Planner action for the metadata paired with an orphan original. */
      kind: 'metadata-file'
      mediaId: string
      relativePath: string
    }
  | {
      /** Planner action for one regular orphan staging file. */
      kind: 'temp-file'
      relativePath: string
    }
  | {
      kind: 'reclaim-record'
      relativePath: string
      legacyLine?: string
    }
export type ManagedMediaCleanupPlan = {
  root: string
  referencedMediaIds: ReadonlySet<string>
  /** Positive durable occurrence counts, keyed by every referenced media ID. */
  referenceCounts: Readonly<Record<string, number>>
  actions: ManagedMediaCleanupAction[]
  skipped: Skipped[]
  retention: ManagedMediaRetentionPolicy
  audit: ManagedMediaCleanupAudit
}
export type PlanManagedMediaCleanupInput = {
  chatMediaRoot: string
  /** Complete authoritative set of original sha256 IDs referenced by durable state. */
  referencedMediaIds: Iterable<string>
  /** Optional durable occurrence counts; legacy callers default each ID to one. */
  referenceCounts?: Readonly<Record<string, number>>
  /** Optional lifecycle policy; defaults protect fresh task material for one day. */
  retention?: Partial<ManagedMediaRetentionPolicy>
  /** Injectable wall-clock time used to evaluate staging TTL. */
  now?: number
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a),
    right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function normalizeReferences(values: Iterable<string>): ReadonlySet<string> {
  if (values == null || typeof values[Symbol.iterator] !== 'function')
    throw new TypeError('referencedMediaIds must be an authoritative iterable')
  const result = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || !MEDIA_ID.test(value))
      throw new TypeError('referencedMediaIds contains an invalid managed media ID')
    result.add(value)
  }
  return result
}

function normalizeReferenceCounts(
  ids: ReadonlySet<string>,
  value: Readonly<Record<string, number>> | undefined
): Readonly<Record<string, number>> {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new TypeError('referenceCounts must be an object')
  const source: Readonly<Record<string, number>> = value ?? {}
  const result: Record<string, number> = {}
  for (const id of ids) {
    const count = source[id] ?? 1
    if (!Number.isSafeInteger(count) || count <= 0)
      throw new TypeError('referenceCounts must contain positive safe integers')
    result[id] = count
  }
  for (const id of Object.keys(source)) {
    if (!ids.has(id)) throw new TypeError('referenceCounts contains an unknown media ID')
  }
  return Object.freeze(result)
}

function normalizeRetention(
  value: Partial<ManagedMediaRetentionPolicy> | undefined
): ManagedMediaRetentionPolicy {
  const stagingTtlMs = value?.stagingTtlMs ?? DEFAULT_MANAGED_MEDIA_RETENTION.stagingTtlMs
  const orphanTtlMs = value?.orphanTtlMs ?? DEFAULT_MANAGED_MEDIA_RETENTION.orphanTtlMs
  const maxStagingBytes = value?.maxStagingBytes ?? DEFAULT_MANAGED_MEDIA_RETENTION.maxStagingBytes
  if (!Number.isSafeInteger(stagingTtlMs) || stagingTtlMs < 0)
    throw new RangeError('stagingTtlMs must be a non-negative safe integer')
  if (!Number.isSafeInteger(orphanTtlMs) || orphanTtlMs < 0)
    throw new RangeError('orphanTtlMs must be a non-negative safe integer')
  if (!Number.isSafeInteger(maxStagingBytes) || maxStagingBytes <= 0)
    throw new RangeError('maxStagingBytes must be a positive safe integer')
  return Object.freeze({ stagingTtlMs, orphanTtlMs, maxStagingBytes })
}

function normalizeNow(value: number | undefined): number {
  const now = value ?? Date.now()
  if (!Number.isFinite(now)) throw new RangeError('now must be a finite number')
  return now
}

function emptyCleanupAudit(quotaBytes: number, orphanTtlMs: number): ManagedMediaCleanupAudit {
  return {
    stagingFileCount: 0,
    stagingBytes: 0,
    staleStagingFileCount: 0,
    staleStagingBytes: 0,
    quotaBytes,
    quotaExceeded: false,
    durableOrphanRecordCount: 0,
    retainedDurableOrphanRecordCount: 0,
    orphanTtlMs
  }
}

/** Verify every component is a real directory, not a symlink or mount-through path. */
async function safeDirectory(root: string, value: string): Promise<boolean> {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(value)
  if (!isPathInsideRoot(resolvedRoot, resolved)) return false
  let current = resolvedRoot
  for (const segment of path.relative(resolvedRoot, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !samePath(await fs.realpath(current), current)
    )
      return false
  }
  return true
}

async function safeFile(root: string, value: string): Promise<boolean> {
  const resolved = path.resolve(value)
  if (!isPathInsideRoot(path.resolve(root), resolved) || samePath(root, resolved)) return false
  if (!(await safeDirectory(root, path.dirname(resolved)))) return false
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return stat.isFile() && !stat.isSymbolicLink() && samePath(await fs.realpath(resolved), resolved)
}

function absoluteFromRelative(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\'))
    throw new Error('path is not a canonical managed-media relative path')
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('path contains traversal')
  const absolute = path.join(root, ...parts)
  if (!isPathInsideRoot(root, absolute) || samePath(root, absolute))
    throw new Error('path escapes managed-media root')
  return absolute
}

type ManagedMediaRoot = { root: string; prefix: string }

function prefixedRelativePath(prefix: string, relativePath: string): string {
  return prefix ? `${prefix}/${relativePath}` : relativePath
}

function prefixCleanupAction(
  prefix: string,
  action: ManagedMediaCleanupAction
): ManagedMediaCleanupAction {
  return { ...action, relativePath: prefixedRelativePath(prefix, action.relativePath) }
}

/** Split a planner path into a validated store prefix and local store path. */
function splitCleanupRelativePath(value: string): { prefix: string; localPath: string } {
  for (const namespacePrefix of LIFECYCLE_NAMESPACE_PREFIXES) {
    if (value.startsWith(namespacePrefix)) {
      const remainder = value.slice(namespacePrefix.length)
      const separator = remainder.indexOf('/')
      if (separator <= 0) throw new Error('cleanup path has an invalid namespace scope')
      const scope = remainder.slice(0, separator)
      if (!MEDIA_SCOPE_PATTERN.test(scope))
        throw new Error('cleanup path has an invalid namespace scope')
      return {
        prefix: `${namespacePrefix.slice(0, -1)}/${scope}`,
        localPath: remainder.slice(separator + 1)
      }
    }
  }
  if (value === USER_OUTPUT_ROOT_PREFIX || value.startsWith(`${USER_OUTPUT_ROOT_PREFIX}/`))
    throw new Error('user-output namespace is protected from managed-media cleanup')
  if (value.startsWith(`${TASK_ROOT_PREFIX}`)) {
    const remainder = value.slice(TASK_ROOT_PREFIX.length)
    const separator = remainder.indexOf('/')
    if (separator <= 0) throw new Error('cleanup path has an invalid task scope')
    const scope = remainder.slice(0, separator)
    if (!MEDIA_SCOPE_PATTERN.test(scope)) throw new Error('cleanup path has an invalid task scope')
    return { prefix: `${TASK_ROOT_PREFIX}${scope}`, localPath: remainder.slice(separator + 1) }
  }
  if (value.startsWith(`${GLOBAL_ROOT_PREFIX}/`)) {
    return { prefix: GLOBAL_ROOT_PREFIX, localPath: value.slice(`${GLOBAL_ROOT_PREFIX}/`.length) }
  }
  return { prefix: '', localPath: value }
}

async function entries(value: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(value, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.lstat(value)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Read planner metadata through one bounded, no-follow handle. A separate
 * lstat/readFile pair can be raced by a symlink replacement and can allocate
 * an attacker-controlled amount of memory; cleanup must fail closed instead.
 */
async function readBoundedJsonFile(value: string): Promise<Manifest> {
  let before: Awaited<ReturnType<typeof fs.lstat>>
  try {
    before = await fs.lstat(value)
  } catch {
    throw new Error('metadata file is unavailable')
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CLEANUP_JSON_BYTES)
    throw new Error('metadata file is unsafe or too large')

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(value, fsConstants.O_RDONLY | NOFOLLOW)
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.size > MAX_CLEANUP_JSON_BYTES ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    )
      throw new Error('metadata file changed during cleanup')
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new Error('metadata file ended unexpectedly')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error('metadata file changed during cleanup')
    return JSON.parse(bytes.toString('utf8')) as Manifest
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function planDerivatives(
  root: string,
  mediaId: string,
  skipped: Skipped[],
  durableFiles: string[]
): Promise<ManagedMediaCleanupAction[]> {
  const baseRelative = `derivatives/${mediaId.slice(0, 2)}/${mediaId}`
  const base = absoluteFromRelative(root, baseRelative)
  if (!(await safeDirectory(root, base))) {
    if (
      await fs.lstat(base).then(
        () => true,
        () => false
      )
    )
      skipped.push({ relativePath: baseRelative, reason: 'unsafe derivative identity path' })
    return []
  }
  const actions: ManagedMediaCleanupAction[] = []
  for (const entry of await entries(base)) {
    const identityRelative = `${baseRelative}/${entry.name}`
    if (entry.isSymbolicLink() || !entry.isDirectory() || !MEDIA_ID.test(entry.name)) {
      skipped.push({ relativePath: identityRelative, reason: 'unrecognized derivative identity' })
      continue
    }
    const committedRelative = `${identityRelative}/committed`
    const manifestRelative = `${committedRelative}/manifest.json`
    try {
      const committed = absoluteFromRelative(root, committedRelative)
      const manifestPath = absoluteFromRelative(root, manifestRelative)
      if (!(await safeDirectory(root, committed)) || !(await safeFile(root, manifestPath)))
        throw new Error('unsafe or missing derivative manifest')
      const manifest = parseManagedMediaDerivativeManifest(
        await readBoundedJsonFile(manifestPath),
        {
          root,
          originalSha256: mediaId,
          identity: entry.name
        }
      )
      const imagePath = absoluteFromRelative(root, manifest.relativePath)
      if (!(await safeFile(root, imagePath)))
        throw new Error('unsafe, missing, or non-regular derivative image')
      durableFiles.push(manifestRelative, manifest.relativePath)
      actions.push({ kind: 'derivative-file', mediaId, relativePath: manifest.relativePath })
    } catch (error) {
      skipped.push({ relativePath: identityRelative, reason: (error as Error).message })
    }
  }
  return actions
}

/**
 * Plan the rest of an orphan content-addressed record only when every
 * derivative entry was understood. Unknown derivative entries fail closed and
 * leave the record intact for a later cleanup pass.
 */
async function planOrphanMediaFiles(
  root: string,
  mediaId: string,
  metadataRelativePath: string,
  originalRelativePath: string,
  skipped: Skipped[],
  now: number,
  orphanTtlMs: number
): Promise<{ actions: ManagedMediaCleanupAction[]; durable: boolean; retained: boolean }> {
  const skippedBefore = skipped.length
  const durableFiles = [metadataRelativePath, originalRelativePath]
  const derivativeActions = await planDerivatives(root, mediaId, skipped, durableFiles)
  // A partially understood record must stay intact.  Returning the valid
  // derivative actions here would delete part of a record while an unknown
  // identity or malformed manifest remains, making a later recovery pass
  // impossible to reason about.
  if (skipped.length !== skippedBefore) return { actions: [], durable: false, retained: false }

  const metadataPath = absoluteFromRelative(root, metadataRelativePath)
  const originalPath = absoluteFromRelative(root, originalRelativePath)
  if (!(await safeFile(root, metadataPath)) || !(await safeFile(root, originalPath))) {
    skipped.push({
      relativePath: metadataRelativePath,
      reason: 'orphan media files are no longer safe'
    })
    return { actions: [], durable: false, retained: false }
  }

  const staleBefore = now - orphanTtlMs
  let hasFreshFile = false
  for (const relativePath of durableFiles) {
    const filePath = absoluteFromRelative(root, relativePath)
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(filePath)
    } catch {
      skipped.push({
        relativePath: metadataRelativePath,
        reason: 'orphan media timestamp is unavailable'
      })
      return { actions: [], durable: true, retained: true }
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !Number.isFinite(stat.mtimeMs)) {
      skipped.push({
        relativePath: metadataRelativePath,
        reason: 'orphan media timestamp is unavailable'
      })
      return { actions: [], durable: true, retained: true }
    }
    if (stat.mtimeMs > staleBefore) hasFreshFile = true
  }
  if (hasFreshFile) {
    skipped.push({
      relativePath: metadataRelativePath,
      reason: 'orphan media record is within retention TTL'
    })
    return { actions: [], durable: true, retained: true }
  }
  return {
    actions: [
      ...derivativeActions,
      { kind: 'metadata-file', mediaId, relativePath: metadataRelativePath },
      { kind: 'original-file', mediaId, relativePath: originalRelativePath }
    ],
    durable: true,
    retained: false
  }
}

async function planTemporaryFiles(
  root: string,
  skipped: Skipped[],
  retention: ManagedMediaRetentionPolicy,
  now: number
): Promise<{ actions: ManagedMediaCleanupAction[]; audit: ManagedMediaCleanupAudit }> {
  const relativeRoot = '.staging'
  const stagingRoot = absoluteFromRelative(root, relativeRoot)
  if (!(await safeDirectory(root, stagingRoot)))
    return {
      actions: [],
      audit: emptyCleanupAudit(retention.maxStagingBytes, retention.orphanTtlMs)
    }
  const candidates: Array<{ relativePath: string; size: number; mtimeMs: number }> = []
  let stagingFileCount = 0
  let stagingBytes = 0
  let staleStagingFileCount = 0
  let staleStagingBytes = 0
  const staleBefore = now - retention.stagingTtlMs
  for (const entry of await entries(stagingRoot)) {
    const relativePath = `${relativeRoot}/${entry.name}`
    if (!entry.name.endsWith('.tmp') || entry.isSymbolicLink() || !entry.isFile()) {
      skipped.push({ relativePath, reason: 'unrecognized staging entry' })
      continue
    }
    try {
      const target = absoluteFromRelative(root, relativePath)
      if (!(await safeFile(root, target))) throw new Error('unsafe staging file')
      const stat = await fs.stat(target)
      stagingFileCount += 1
      stagingBytes += stat.size
      // A zero TTL is an explicit "no retention" policy. Treat every
      // regular staging file as reclaimable even when filesystem timestamp
      // granularity briefly reports an mtime a few milliseconds in the
      // future relative to the injected wall clock.
      const stale = retention.stagingTtlMs === 0 || stat.mtimeMs <= staleBefore
      if (stale) {
        staleStagingFileCount += 1
        staleStagingBytes += stat.size
        candidates.push({ relativePath, size: stat.size, mtimeMs: stat.mtimeMs })
      } else {
        skipped.push({ relativePath, reason: 'staging file is within retention TTL' })
      }
    } catch (error) {
      skipped.push({ relativePath, reason: (error as Error).message })
    }
  }
  const quotaExceeded = stagingBytes > retention.maxStagingBytes
  const bytesToReclaim = Math.max(0, stagingBytes - retention.maxStagingBytes)
  // Reclaim the oldest expired files first when the staging quota is exceeded.
  // Fresh files are never deleted solely because a quota is exceeded.
  const ordered = candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let selectedBytes = 0
  const selected = new Set<string>()
  for (const candidate of ordered) {
    if (!quotaExceeded || selectedBytes < bytesToReclaim) {
      selected.add(candidate.relativePath)
      selectedBytes += candidate.size
    }
  }
  for (const candidate of ordered) {
    if (!selected.has(candidate.relativePath))
      skipped.push({
        relativePath: candidate.relativePath,
        reason: 'staging file retained because the quota is satisfied by older expired files'
      })
  }
  const audit = {
    stagingFileCount,
    stagingBytes,
    staleStagingFileCount,
    staleStagingBytes,
    quotaBytes: retention.maxStagingBytes,
    quotaExceeded,
    durableOrphanRecordCount: 0,
    retainedDurableOrphanRecordCount: 0,
    orphanTtlMs: retention.orphanTtlMs
  }
  return {
    actions: ordered
      .filter((candidate) => selected.has(candidate.relativePath))
      .map(({ relativePath }) => ({ kind: 'temp-file' as const, relativePath })),
    audit
  }
}

export type ExecuteManagedMediaCleanupOptions = {
  dryRun?: boolean
  /** Stop before deleting when a newer authoritative reference snapshot arrives. */
  shouldContinue?: () => boolean
}
export type ManagedMediaCleanupResult = {
  dryRun: boolean
  deleted: string[]
  skipped: Skipped[]
  audit: ManagedMediaCleanupAudit & { deletedCount: number; skippedCount: number }
}

/**
 * Non-sensitive summary returned by the final shutdown sweep.  The sweep is
 * intentionally limited to expired staging files; durable originals and
 * derivatives still require a fresh renderer reference snapshot.
 */
export type ManagedMediaShutdownCleanupAudit = Readonly<{
  rootsScanned: number
  stagingFileCount: number
  stagingBytes: number
  staleStagingFileCount: number
  staleStagingBytes: number
  quotaBytes: number
  quotaExceededRootCount: number
  deletedCount: number
  skippedCount: number
}>

export type ManagedMediaShutdownCleanupInput = {
  /** Base `.chat_media` directory; task roots are discovered below it. */
  chatMediaRoot: string
  retention?: Partial<ManagedMediaRetentionPolicy>
  now?: number
}

async function discoverManagedMediaRoots(
  baseRoot: string,
  skipped: Skipped[]
): Promise<ManagedMediaRoot[]> {
  const roots: ManagedMediaRoot[] = [{ root: baseRoot, prefix: '' }]

  // Lifecycle namespace roots are additive to the legacy base/Comfy layout.
  // Only canonical task/model scopes become GC roots.  User output remains
  // user-managed and is recorded as protected without enumerating its files.
  for (const namespace of ['task', 'model'] as const) {
    const namespaceRelative = namespace
    const namespaceRoot = absoluteFromRelative(baseRoot, namespaceRelative)
    if (!(await safeDirectory(baseRoot, namespaceRoot))) {
      if (await pathExists(namespaceRoot))
        skipped.push({
          relativePath: namespaceRelative,
          reason: `unsafe ${namespace} namespace root`
        })
      continue
    }
    for (const entry of await entries(namespaceRoot)) {
      const scopeRelative = `${namespaceRelative}/${entry.name}`
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        skipped.push({
          relativePath: scopeRelative,
          reason: 'unsafe or non-directory namespace scope'
        })
        continue
      }
      if (!MEDIA_SCOPE_PATTERN.test(entry.name)) {
        skipped.push({ relativePath: scopeRelative, reason: 'unknown namespace scope' })
        continue
      }
      const scopeRoot = path.join(namespaceRoot, entry.name)
      if (!(await safeDirectory(baseRoot, scopeRoot))) {
        skipped.push({ relativePath: scopeRelative, reason: 'unsafe namespace scope' })
        continue
      }
      roots.push({ root: scopeRoot, prefix: scopeRelative })
    }
  }

  const userOutputRoot = absoluteFromRelative(baseRoot, USER_OUTPUT_ROOT_PREFIX)
  if (await pathExists(userOutputRoot)) {
    skipped.push({
      relativePath: USER_OUTPUT_ROOT_PREFIX,
      reason: 'user-output namespace is user-managed and excluded from cleanup'
    })
  }

  const globalRoot = absoluteFromRelative(baseRoot, GLOBAL_ROOT_PREFIX)
  if (await safeDirectory(baseRoot, globalRoot)) {
    roots.push({ root: globalRoot, prefix: GLOBAL_ROOT_PREFIX })
  } else if (await pathExists(globalRoot)) {
    skipped.push({ relativePath: GLOBAL_ROOT_PREFIX, reason: 'unsafe global output root' })
  }

  const tasksRelative = 'comfy-outputs/tasks'
  const tasksRoot = absoluteFromRelative(baseRoot, tasksRelative)
  if (!(await safeDirectory(baseRoot, tasksRoot))) {
    if (await pathExists(tasksRoot))
      skipped.push({ relativePath: tasksRelative, reason: 'unsafe task roots directory' })
    return roots
  }

  for (const entry of await entries(tasksRoot)) {
    const taskRelative = `${tasksRelative}/${entry.name}`
    // Task scopes are untrusted input. Never follow a symlink, malformed
    // scope, or a directory that fails the canonical containment checks.
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      skipped.push({ relativePath: taskRelative, reason: 'unsafe or non-directory task root' })
      continue
    }
    if (!MEDIA_SCOPE_PATTERN.test(entry.name)) {
      skipped.push({ relativePath: taskRelative, reason: 'unknown task scope' })
      continue
    }
    const taskRoot = path.join(tasksRoot, entry.name)
    if (!(await safeDirectory(baseRoot, taskRoot))) {
      skipped.push({ relativePath: taskRelative, reason: 'unsafe task root' })
      continue
    }
    roots.push({ root: taskRoot, prefix: taskRelative })
  }
  return roots
}

async function discoverShutdownRoots(
  baseRoot: string
): Promise<{ roots: string[]; skippedCount: number }> {
  const skipped: Skipped[] = []
  return {
    roots: (await discoverManagedMediaRoots(baseRoot, skipped)).map(({ root }) => root),
    skippedCount: skipped.length
  }
}

/**
 * Remove only expired `.staging/*.tmp` files while the app is stopping.
 *
 * Renderer reference state may be unavailable during shutdown, so this pass
 * deliberately does not inspect or delete originals, metadata, or derivatives.
 * It also returns counters only; filenames and media content never leave the
 * cleanup boundary.
 */
export async function cleanupManagedMediaStagingOnShutdown(
  input: ManagedMediaShutdownCleanupInput
): Promise<ManagedMediaShutdownCleanupAudit> {
  const baseRoot = path.resolve(input.chatMediaRoot)
  if (
    !(await safeDirectory(path.dirname(baseRoot), baseRoot)) ||
    !samePath(baseRoot, await fs.realpath(baseRoot))
  )
    throw new Error('Managed media cleanup root must be an existing canonical directory')

  const retention = normalizeRetention(input.retention)
  const now = normalizeNow(input.now)
  const discovered = await discoverShutdownRoots(baseRoot)
  const roots = discovered.roots
  const audit: {
    rootsScanned: number
    stagingFileCount: number
    stagingBytes: number
    staleStagingFileCount: number
    staleStagingBytes: number
    quotaBytes: number
    quotaExceededRootCount: number
    deletedCount: number
    skippedCount: number
  } = {
    rootsScanned: 0,
    stagingFileCount: 0,
    stagingBytes: 0,
    staleStagingFileCount: 0,
    staleStagingBytes: 0,
    quotaBytes: 0,
    quotaExceededRootCount: 0,
    deletedCount: 0,
    skippedCount: discovered.skippedCount
  }

  for (const root of roots) {
    const skipped: Skipped[] = []
    const temporary = await planTemporaryFiles(root, skipped, retention, now)
    audit.rootsScanned += 1
    audit.stagingFileCount += temporary.audit.stagingFileCount
    audit.stagingBytes += temporary.audit.stagingBytes
    audit.staleStagingFileCount += temporary.audit.staleStagingFileCount
    audit.staleStagingBytes += temporary.audit.staleStagingBytes
    audit.quotaBytes += temporary.audit.quotaBytes
    if (temporary.audit.quotaExceeded) audit.quotaExceededRootCount += 1

    // Reuse the same guarded executor as the normal planner.  No media IDs
    // are supplied, and this plan contains only temp-file actions.
    const result = await executeManagedMediaCleanup(
      {
        root,
        referencedMediaIds: new Set<string>(),
        referenceCounts: Object.freeze({}),
        actions: temporary.actions,
        skipped,
        retention,
        audit: temporary.audit
      },
      { dryRun: false }
    )
    audit.deletedCount += result.deleted.length
    // Include planner skips (for example fresh files inside the TTL) as well
    // as execution-time races, while still exposing counters only.
    audit.skippedCount += skipped.length + result.skipped.length
  }

  return Object.freeze(audit)
}

/** Execute only planner-confirmed files; dry-run is the safe default. */
export async function executeManagedMediaCleanup(
  plan: ManagedMediaCleanupPlan,
  options: ExecuteManagedMediaCleanupOptions = {}
): Promise<ManagedMediaCleanupResult> {
  const dryRun = options.dryRun !== false
  const deleted: string[] = []
  const skipped: Skipped[] = []
  for (const action of plan.actions) {
    if (options.shouldContinue && !options.shouldContinue()) {
      skipped.push({ relativePath: action.relativePath, reason: 'reference snapshot changed' })
      break
    }
    if (
      (action.kind === 'derivative-file' ||
        action.kind === 'original-file' ||
        action.kind === 'metadata-file') &&
      plan.referencedMediaIds.has(action.mediaId)
    ) {
      skipped.push({
        relativePath: action.relativePath,
        reason: 'referenced media is never deleted'
      })
      continue
    }
    let target: string
    try {
      const scopedPath = splitCleanupRelativePath(action.relativePath)
      const actionRoot = scopedPath.prefix
        ? path.join(plan.root, ...scopedPath.prefix.split('/'))
        : plan.root
      const localPath = scopedPath.localPath
      target = absoluteFromRelative(actionRoot, localPath)
      if (
        action.kind === 'derivative-file'
          ? !localPath.startsWith(`derivatives/${action.mediaId.slice(0, 2)}/${action.mediaId}/`)
          : action.kind === 'original-file'
            ? !localPath.startsWith(`originals/${action.mediaId.slice(0, 2)}/${action.mediaId}.`)
            : action.kind === 'metadata-file'
              ? localPath !== `metadata/${action.mediaId}.json`
              : !localPath.startsWith('.staging/')
      )
        throw new Error('cleanup action is outside its allowed area')
      if (!(await safeDirectory(plan.root, actionRoot)))
        throw new Error('cleanup root is no longer safe')
      if (!(await safeFile(actionRoot, target))) throw new Error('cleanup target is no longer safe')
      if (options.shouldContinue && !options.shouldContinue()) {
        skipped.push({ relativePath: action.relativePath, reason: 'reference snapshot changed' })
        break
      }
      if (!dryRun) await fs.unlink(target)
      deleted.push(action.relativePath)
    } catch (error) {
      skipped.push({ relativePath: action.relativePath, reason: (error as Error).message })
    }
  }
  return {
    dryRun,
    deleted,
    skipped,
    audit: {
      ...plan.audit,
      deletedCount: deleted.length,
      skippedCount: skipped.length
    }
  }
}

export async function planManagedMediaCleanup(
  input: PlanManagedMediaCleanupInput
): Promise<ManagedMediaCleanupPlan> {
  const root = path.resolve(input.chatMediaRoot)
  if (!(await safeDirectory(path.dirname(root), root)) || !samePath(root, await fs.realpath(root)))
    throw new Error('Managed media cleanup root must be an existing canonical directory')
  const referencedMediaIds = normalizeReferences(input.referencedMediaIds)
  const referenceCounts = normalizeReferenceCounts(referencedMediaIds, input.referenceCounts)
  const retention = normalizeRetention(input.retention)
  const now = normalizeNow(input.now)
  const skipped: Skipped[] = []
  const actions: ManagedMediaCleanupAction[] = []
  const audit = {
    stagingFileCount: 0,
    stagingBytes: 0,
    staleStagingFileCount: 0,
    staleStagingBytes: 0,
    quotaBytes: 0,
    quotaExceeded: false,
    durableOrphanRecordCount: 0,
    retainedDurableOrphanRecordCount: 0,
    orphanTtlMs: retention.orphanTtlMs
  }
  const roots = await discoverManagedMediaRoots(root, skipped)
  for (const store of roots) {
    const localSkipped: Skipped[] = []
    const temporary = await planTemporaryFiles(store.root, localSkipped, retention, now)
    const localActions: ManagedMediaCleanupAction[] = [...temporary.actions]
    const metadataRoot = path.join(store.root, 'metadata')
    if (await safeDirectory(store.root, metadataRoot)) {
      for (const entry of await entries(metadataRoot)) {
        const match = /^([a-f0-9]{64})\.json$/u.exec(entry.name)
        const relative = `metadata/${entry.name}`
        if (!match) {
          localSkipped.push({ relativePath: relative, reason: 'malformed metadata entry' })
          continue
        }
        if (referencedMediaIds.has(match[1])) continue
        if (entry.isSymbolicLink() || !entry.isFile()) {
          localSkipped.push({ relativePath: relative, reason: 'metadata is not a regular file' })
          continue
        }
        const mediaId = match[1]
        try {
          const metadataPath = absoluteFromRelative(store.root, relative)
          if (!(await safeFile(store.root, metadataPath))) throw new Error('unsafe metadata path')
          const metadata = await readBoundedJsonFile(metadataPath)
          if (
            metadata.schema !== METADATA_SCHEMA ||
            metadata.sha256 !== mediaId ||
            typeof metadata.relativePath !== 'string'
          )
            throw new Error('invalid metadata')
          const original = ORIGINAL_PATH.exec(metadata.relativePath)
          if (!original || original[1] !== mediaId.slice(0, 2) || original[2] !== mediaId)
            throw new Error('invalid original path')
          if (
            !(await safeFile(store.root, absoluteFromRelative(store.root, metadata.relativePath)))
          )
            throw new Error('unsafe or missing original')
          const orphanPlan = await planOrphanMediaFiles(
            store.root,
            mediaId,
            relative,
            metadata.relativePath,
            localSkipped,
            now,
            retention.orphanTtlMs
          )
          if (orphanPlan.durable) audit.durableOrphanRecordCount += 1
          if (orphanPlan.retained) audit.retainedDurableOrphanRecordCount += 1
          localActions.push(...orphanPlan.actions)
        } catch (error) {
          localSkipped.push({ relativePath: relative, reason: (error as Error).message })
        }
      }
    } else if (await pathExists(metadataRoot)) {
      localSkipped.push({ relativePath: 'metadata', reason: 'unsafe metadata root' })
    }
    actions.push(...localActions.map((action) => prefixCleanupAction(store.prefix, action)))
    skipped.push(
      ...localSkipped.map((entry) => ({
        ...entry,
        relativePath: prefixedRelativePath(store.prefix, entry.relativePath)
      }))
    )
    audit.stagingFileCount += temporary.audit.stagingFileCount
    audit.stagingBytes += temporary.audit.stagingBytes
    audit.staleStagingFileCount += temporary.audit.staleStagingFileCount
    audit.staleStagingBytes += temporary.audit.staleStagingBytes
    audit.quotaBytes += temporary.audit.quotaBytes
    audit.quotaExceeded = audit.quotaExceeded || temporary.audit.quotaExceeded
    audit.durableOrphanRecordCount += temporary.audit.durableOrphanRecordCount
    audit.retainedDurableOrphanRecordCount += temporary.audit.retainedDurableOrphanRecordCount
  }
  return {
    root,
    referencedMediaIds,
    referenceCounts,
    actions,
    skipped,
    retention,
    audit
  }
}
