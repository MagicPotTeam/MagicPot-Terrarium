import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CompleteManagedMediaReferenceSnapshot } from './managedMediaCleanupScheduler'

/**
 * Durable, content-free reference state used to bridge application restarts.
 * The snapshot is only a conservative baseline: the scheduler still waits for
 * a fresh complete renderer scan before deleting anything.
 */
export const MANAGED_MEDIA_REFERENCE_SNAPSHOT_SCHEMA =
  'magicpot.managed-media-reference-snapshot/v1' as const
export const MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE = '.managed-media-reference-snapshot.json'
const MAX_REFERENCE_IDS = 100_000
/** Keep restart-time reference loading bounded even if the file is corrupted. */
export const MAX_MANAGED_MEDIA_REFERENCE_SNAPSHOT_BYTES = 8 * 1024 * 1024
/** A restart baseline is only useful for one bounded retention window. */
export const MANAGED_MEDIA_REFERENCE_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1_000
/** Small clock skew is tolerated; a future baseline is never trusted indefinitely. */
export const MANAGED_MEDIA_REFERENCE_SNAPSHOT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000
/** Crash leftovers are bounded independently from the durable snapshot TTL. */
export const MANAGED_MEDIA_REFERENCE_SNAPSHOT_TEMP_TTL_MS = 24 * 60 * 60 * 1_000
const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

export type PersistedManagedMediaReferenceSnapshot = CompleteManagedMediaReferenceSnapshot & {
  persistedAt: number
}

export type ManagedMediaReferenceSnapshotTempCleanupAudit = Readonly<{
  scanned: number
  deleted: number
  retained: number
  skipped: number
}>

type SnapshotPayload = {
  schema: typeof MANAGED_MEDIA_REFERENCE_SNAPSHOT_SCHEMA
  complete: true
  chatMediaRoot: string
  referencedMediaIds: string[]
  referenceCounts: Record<string, number>
  persistedAt: number
}

function normalizeRoot(root: string): string {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('Invalid chat media root')
  return path.resolve(root)
}

function normalizeSnapshotTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a timestamp`)
  return value
}

function normalizeIds(ids: Iterable<string>): string[] {
  const values = Array.from(ids)
  if (values.length > MAX_REFERENCE_IDS) throw new RangeError('Too many managed media references')
  const unique = new Set<string>()
  for (const id of values) {
    if (typeof id !== 'string' || !SHA256.test(id))
      throw new TypeError('Invalid managed media reference ID')
    unique.add(id)
  }
  return [...unique].sort()
}

function normalizeReferenceCounts(ids: readonly string[], value: unknown): Record<string, number> {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new TypeError('Invalid managed media reference counts')
  const counts: Record<string, number> = {}
  const source = (value ?? {}) as Record<string, unknown>
  for (const id of ids) {
    const count = source[id] ?? 1
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0)
      throw new TypeError('Invalid managed media reference count')
    counts[id] = count
  }
  for (const id of Object.keys(source)) {
    if (!ids.includes(id)) throw new TypeError('Reference count has an unknown media ID')
  }
  return counts
}

function sameFileIdentity(
  left: Awaited<ReturnType<NonNullable<(typeof fs)['lstat']>>>,
  right: Awaited<ReturnType<NonNullable<(typeof fs)['lstat']>>>
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    (left.dev === undefined || right.dev === undefined || left.dev === right.dev) &&
    (left.ino === undefined || right.ino === undefined || left.ino === right.ino)
  )
}

async function readBoundedSnapshot(target: string): Promise<string | undefined> {
  let before: Awaited<ReturnType<typeof fs.lstat>>
  try {
    before = await fs.lstat(target)
  } catch {
    return undefined
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_MANAGED_MEDIA_REFERENCE_SNAPSHOT_BYTES
  )
    return undefined

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | NOFOLLOW)
    const opened = await handle.stat()
    if (
      !sameFileIdentity(before, opened) ||
      opened.size > MAX_MANAGED_MEDIA_REFERENCE_SNAPSHOT_BYTES
    )
      return undefined
    // Read only the size observed through the same no-follow handle. A concurrent
    // writer must not make restart recovery allocate an unbounded buffer.
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) return undefined
      offset += bytesRead
    }
    const after = await handle.stat()
    if (!sameFileIdentity(opened, after)) return undefined
    return bytes.toString('utf8')
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parseSnapshot(value: unknown): PersistedManagedMediaReferenceSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const persistedAt = candidate.persistedAt
  if (
    candidate.schema !== MANAGED_MEDIA_REFERENCE_SNAPSHOT_SCHEMA ||
    candidate.complete !== true ||
    typeof candidate.chatMediaRoot !== 'string' ||
    !Array.isArray(candidate.referencedMediaIds) ||
    typeof persistedAt !== 'number' ||
    !Number.isSafeInteger(persistedAt) ||
    persistedAt < 0
  )
    return undefined
  let ids: string[]
  try {
    ids = normalizeIds(candidate.referencedMediaIds as unknown[] as string[])
  } catch {
    return undefined
  }
  let referenceCounts: Record<string, number>
  try {
    referenceCounts = normalizeReferenceCounts(ids, candidate.referenceCounts)
  } catch {
    return undefined
  }
  return {
    complete: true,
    chatMediaRoot: normalizeRoot(candidate.chatMediaRoot),
    referencedMediaIds: ids,
    referenceCounts,
    persistedAt
  }
}

async function ensureCanonicalRoot(root: string): Promise<string> {
  const resolved = normalizeRoot(root)
  const [stat, real] = await Promise.all([fs.lstat(resolved), fs.realpath(resolved)])
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(real) !== resolved)
    throw new Error('Chat media root must be a canonical directory')
  return resolved
}

function isSnapshotTempName(value: string): boolean {
  const prefix = `${MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE}.`
  if (!value.startsWith(prefix) || !value.endsWith('.tmp')) return false
  const uuid = value.slice(prefix.length, -'.tmp'.length)
  return UUID.test(uuid)
}

/**
 * Remove only stale atomic-write leftovers in the snapshot store directory.
 * A crash between write and rename can otherwise accumulate unbounded files.
 * Exact naming, regular-file checks, no-follow identity checks, and TTL are
 * all required before unlinking; uncertainty leaves the entry untouched.
 */
export async function cleanupManagedMediaReferenceSnapshotTemps(
  chatMediaRoot: string,
  now = Date.now(),
  ttlMs = MANAGED_MEDIA_REFERENCE_SNAPSHOT_TEMP_TTL_MS
): Promise<ManagedMediaReferenceSnapshotTempCleanupAudit> {
  normalizeSnapshotTime(now, 'Snapshot time')
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0)
    throw new RangeError('Snapshot temp TTL must be a non-negative safe integer')
  const root = await ensureCanonicalRoot(chatMediaRoot)
  const audit = { scanned: 0, deleted: 0, retained: 0, skipped: 0 }
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return Object.freeze(audit)
  }
  const staleBefore = now - ttlMs
  for (const entry of entries) {
    if (!isSnapshotTempName(entry.name)) continue
    audit.scanned += 1
    const target = path.join(root, entry.name)
    try {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('unsafe snapshot temp')
      const before = await fs.lstat(target)
      if (
        before.isSymbolicLink() ||
        !before.isFile() ||
        before.size > MAX_MANAGED_MEDIA_REFERENCE_SNAPSHOT_BYTES ||
        !Number.isFinite(before.mtimeMs)
      )
        throw new Error('unsafe snapshot temp')
      if (before.mtimeMs > staleBefore) {
        audit.retained += 1
        continue
      }
      const handle = await fs.open(target, fsConstants.O_RDONLY | NOFOLLOW)
      try {
        const opened = await handle.stat()
        if (!sameFileIdentity(before, opened)) throw new Error('snapshot temp changed')
      } finally {
        await handle.close()
      }
      const current = await fs.lstat(target)
      if (!sameFileIdentity(before, current)) throw new Error('snapshot temp changed')
      await fs.unlink(target)
      audit.deleted += 1
    } catch {
      audit.skipped += 1
    }
  }
  return Object.freeze(audit)
}

/** Persist a bounded, sorted ID snapshot atomically beside managed media. */
export async function persistManagedMediaReferenceSnapshot(
  snapshot: CompleteManagedMediaReferenceSnapshot,
  now = Date.now()
): Promise<void> {
  const root = await ensureCanonicalRoot(snapshot.chatMediaRoot)
  normalizeSnapshotTime(now, 'Snapshot time')
  // Best-effort maintenance must never block a valid snapshot write.
  await cleanupManagedMediaReferenceSnapshotTemps(root, now).catch(() => undefined)
  const ids = normalizeIds(snapshot.referencedMediaIds)
  const payload: SnapshotPayload = {
    schema: MANAGED_MEDIA_REFERENCE_SNAPSHOT_SCHEMA,
    complete: true,
    chatMediaRoot: root,
    referencedMediaIds: ids,
    referenceCounts: normalizeReferenceCounts(ids, snapshot.referenceCounts),
    persistedAt: now
  }
  const serialized = `${JSON.stringify(payload)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MANAGED_MEDIA_REFERENCE_SNAPSHOT_BYTES)
    throw new RangeError('Managed media reference snapshot is too large')
  const target = path.join(root, MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE)
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await fs.rename(temp, target)
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined)
    throw error
  }
}

/** Load a valid snapshot; malformed or unsafe state is ignored fail-closed. */
export async function loadManagedMediaReferenceSnapshot(
  chatMediaRoot: string,
  now = Date.now()
): Promise<PersistedManagedMediaReferenceSnapshot | undefined> {
  try {
    normalizeSnapshotTime(now, 'Snapshot time')
  } catch {
    return undefined
  }
  let root: string
  try {
    root = await ensureCanonicalRoot(chatMediaRoot)
  } catch {
    return undefined
  }
  const target = path.join(root, MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE)
  try {
    await cleanupManagedMediaReferenceSnapshotTemps(root, now).catch(() => undefined)
    const contents = await readBoundedSnapshot(target)
    if (contents === undefined) return undefined
    const parsed = parseSnapshot(JSON.parse(contents))
    if (!parsed || path.resolve(parsed.chatMediaRoot) !== root) return undefined
    const age = now - parsed.persistedAt
    if (
      age > MANAGED_MEDIA_REFERENCE_SNAPSHOT_TTL_MS ||
      age < -MANAGED_MEDIA_REFERENCE_SNAPSHOT_MAX_FUTURE_SKEW_MS
    )
      return undefined
    return parsed
  } catch {
    return undefined
  }
}
