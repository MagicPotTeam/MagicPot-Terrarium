import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

// A persistent protocol anchor excludes legacy mkdir writers. The renewable
// owner directory lives inside it; bare legacy directories fail closed.
export const MANAGED_MEDIA_GENERATION_LOCK_FILE = '.generation-lock'
export const MANAGED_MEDIA_GENERATION_LOCK_STALE_MS = 30_000
export const MANAGED_MEDIA_GENERATION_LOCK_WAIT_TIMEOUT_MS = 30_000
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const OWNER_NAME = new RegExp(`^(${UUID})\\.json$`, 'u')
const ARTIFACT_NAME = new RegExp(
  `^\\.(work|commit|quarantine|generation-candidate)-(\\d+)-([0-9a-f]{16})-(\\d+)-(${UUID})$`,
  'u'
)
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const MAX_SCAN_ENTRIES = 128
const MAX_OWNER_BYTES = 2_048
const PROTOCOL_MARKER = 'protocol-v2.json'
const PROTOCOL_TEXT = '{"schema":"magicpot.managed-media-generation-lock/v2"}\n'

export type ManagedMediaGenerationLockOwner = Readonly<{
  schema: 2
  token: string
  pid: number
  hostname: string
  createdAt: number
}>

export type AcquireManagedMediaGenerationLockOptions = Readonly<{
  now?: () => number
  pid?: number
  hostname?: string
  token?: () => string
  staleAfterMs?: number
  waitTimeoutMs?: number
  retryDelayMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
}>

export type ManagedMediaGenerationLock = Readonly<{
  path: string
  owner: ManagedMediaGenerationLockOwner
  release: () => Promise<void>
}>

type RecoveryPolicy = Readonly<{
  now: () => number
  hostname: string
  staleAfterMs: number
  isProcessAlive: (pid: number) => boolean
}>

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    !!error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code))
  )
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${UUID}$`, 'u').test(value)
}

function parseOwner(value: unknown): ManagedMediaGenerationLockOwner | undefined {
  if (typeof value !== 'object' || !value || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'createdAt,hostname,pid,schema,token' ||
    record.schema !== 2 ||
    !validToken(record.token) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    (record.pid as number) > 2_147_483_647 ||
    typeof record.hostname !== 'string' ||
    !record.hostname.length ||
    record.hostname.length > 255 ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) <= 0
  )
    return undefined
  return record as unknown as ManagedMediaGenerationLockOwner
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Permission/unknown errors and PID reuse are conservatively live.
    return !hasCode(error, 'ESRCH')
  }
}

async function validateDirectory(directory: string): Promise<Stats> {
  const stat = await fs.lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Unsafe managed media generation directory')
  const real = await fs.realpath(directory)
  if (!samePath(real, directory)) {
    await fs.lstat(directory)
    throw new Error('Unsafe managed media generation canonical directory')
  }
  return stat
}

async function validateIdentityRoot(identityRoot: string): Promise<string> {
  if (!path.isAbsolute(identityRoot)) throw new TypeError('Generation root must be absolute')
  const root = path.resolve(identityRoot)
  const filesystemRoot = path.parse(root).root
  let current = filesystemRoot
  for (const segment of path.relative(filesystemRoot, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    await validateDirectory(current)
  }
  return root
}

async function readEntries(directory: string, maximum: number): Promise<string[]> {
  const handle = await fs.opendir(directory)
  try {
    const names: string[] = []
    while (names.length < maximum) {
      const entry = await handle.read()
      if (!entry) break
      names.push(entry.name)
    }
    return names
  } finally {
    await handle.close()
  }
}

async function readRecord(directory: string, filename: string): Promise<string> {
  await validateDirectory(directory)
  const target = path.join(directory, filename)
  const before = await fs.lstat(target)
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAX_OWNER_BYTES
  )
    throw new Error('Unsafe generation owner record')
  const handle = await fs.open(target, constants.O_RDONLY | NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!sameIdentity(before, opened) || !opened.isFile() || opened.size !== before.size)
      throw new Error('Generation owner record changed while opening')
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new Error('Generation owner record is truncated')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    )
      throw new Error('Generation owner record changed while reading')
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function readOwner(
  directory: string,
  filename: string
): Promise<ManagedMediaGenerationLockOwner> {
  const token = OWNER_NAME.exec(filename)?.[1]
  if (!token) throw new Error('Unrecognized generation owner file')
  const owner = parseOwner(JSON.parse(await readRecord(directory, filename)))
  if (!owner || owner.token !== token) throw new Error('Invalid generation owner record')
  return owner
}

async function ensureProtocolAnchor(root: string): Promise<string> {
  const anchor = path.join(root, MANAGED_MEDIA_GENERATION_LOCK_FILE)
  try {
    await fs.mkdir(anchor, { mode: 0o700 })
    const handle = await fs.open(path.join(anchor, PROTOCOL_MARKER), 'wx', 0o600)
    try {
      await handle.writeFile(PROTOCOL_TEXT)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await readRecord(anchor, PROTOCOL_MARKER)) !== PROTOCOL_TEXT)
        throw new Error('Unrecognized managed media generation lock protocol')
      return anchor
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
      if (attempt >= 4)
        throw new Error('Ownerless/legacy managed media generation lock requires explicit recovery')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

function expiredDeadOwner(owner: ManagedMediaGenerationLockOwner, policy: RecoveryPolicy): boolean {
  return (
    owner.hostname.toLowerCase() === policy.hostname.toLowerCase() &&
    policy.now() - owner.createdAt >= policy.staleAfterMs &&
    !policy.isProcessAlive(owner.pid)
  )
}

async function removeEmptyLock(lockDirectory: string): Promise<void> {
  try {
    // An acquiring process can atomically replace this empty retired lock
    // with a nonempty one. rmdir then fails rather than touching its owner.
    await fs.rmdir(lockDirectory)
  } catch (error) {
    if (!hasCode(error, 'ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES')) throw error
  }
}

async function retireOwner(lockDirectory: string, token: string): Promise<void> {
  await validateDirectory(lockDirectory)
  const target = path.join(lockDirectory, `${token}.json`)
  try {
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe generation owner release')
    // Never rename/remove the contested lock directory based on a snapshot.
    // This token-specific unlink cannot remove a subsequent owner's record;
    // racing recoverers either unlink this same dead token or see ENOENT.
    await validateDirectory(lockDirectory)
    await fs.unlink(target)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  await removeEmptyLock(lockDirectory)
}

/** Read-only guard for cleanup. This is not an atomic lock acquisition. */
export async function isManagedMediaGenerationIdle(identityRoot: string): Promise<boolean> {
  const root = await validateIdentityRoot(identityRoot)
  const anchor = path.join(root, MANAGED_MEDIA_GENERATION_LOCK_FILE)
  try {
    await fs.lstat(anchor)
  } catch (error) {
    return hasCode(error, 'ENOENT')
  }
  try {
    if ((await readRecord(anchor, PROTOCOL_MARKER)) !== PROTOCOL_TEXT) return false
    const names = await readEntries(anchor, 2)
    return names.length === 1 && names[0] === PROTOCOL_MARKER
  } catch {
    return false
  }
}

async function recoverDeadLock(lockDirectory: string, policy: RecoveryPolicy): Promise<void> {
  try {
    await validateDirectory(lockDirectory)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  const names = await readEntries(lockDirectory, 2).catch((error) => {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  })
  if (names.length === 0) {
    await removeEmptyLock(lockDirectory)
    return
  }
  if (names.length !== 1 || !OWNER_NAME.test(names[0]))
    throw new Error('Unrecognized managed media generation lock; refusing recovery')
  try {
    const owner = await readOwner(lockDirectory, names[0])
    if (expiredDeadOwner(owner, policy)) await retireOwner(lockDirectory, owner.token)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
}

export function managedMediaGenerationHostTag(hostname: string): string {
  return createHash('sha256').update(hostname.toLowerCase()).digest('hex').slice(0, 16)
}

export function managedMediaGenerationArtifactName(
  kind: 'work' | 'commit' | 'quarantine' | 'generation-candidate',
  owner: ManagedMediaGenerationLockOwner
): string {
  return `.${kind}-${owner.pid}-${managedMediaGenerationHostTag(owner.hostname)}-${owner.createdAt}-${owner.token}`
}

export async function acquireManagedMediaGenerationLock(
  identityRoot: string,
  input: AcquireManagedMediaGenerationLockOptions = {}
): Promise<ManagedMediaGenerationLock> {
  const root = await validateIdentityRoot(identityRoot)
  const now = input.now ?? Date.now
  const staleAfterMs = input.staleAfterMs ?? MANAGED_MEDIA_GENERATION_LOCK_STALE_MS
  const waitTimeoutMs = input.waitTimeoutMs ?? MANAGED_MEDIA_GENERATION_LOCK_WAIT_TIMEOUT_MS
  const retryDelayMs = input.retryDelayMs ?? 20
  for (const value of [staleAfterMs, waitTimeoutMs])
    if (!Number.isFinite(value) || value < 0)
      throw new TypeError('Lock timeouts must be non-negative')
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0)
    throw new TypeError('retryDelayMs must be positive')
  const owner = parseOwner({
    schema: 2,
    token: (input.token ?? randomUUID)(),
    pid: input.pid ?? process.pid,
    hostname: input.hostname ?? os.hostname(),
    createdAt: now()
  })
  if (!owner)
    throw new TypeError(
      'Generation lock owner must have a UUID, valid PID, bounded hostname and positive time'
    )
  const policy: RecoveryPolicy = {
    now,
    hostname: owner.hostname,
    staleAfterMs,
    isProcessAlive: input.isProcessAlive ?? localProcessIsAlive
  }
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const anchor = await ensureProtocolAnchor(root)
  const lockDirectory = path.join(anchor, 'active')
  const candidate = path.join(
    root,
    managedMediaGenerationArtifactName('generation-candidate', owner)
  )
  await fs.mkdir(candidate, { mode: 0o700 })
  let published = false
  try {
    const handle = await fs.open(path.join(candidate, `${owner.token}.json`), 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const started = performance.now()
    for (;;) {
      await validateIdentityRoot(root)
      try {
        // Atomic publication of a NONEMPTY directory. A live owner always has
        // its unique token file, so POSIX/Windows rename cannot replace it.
        await fs.rename(candidate, lockDirectory)
        published = true
        let released = false
        return {
          path: lockDirectory,
          owner,
          async release(): Promise<void> {
            if (released) return
            await validateIdentityRoot(root)
            await retireOwner(lockDirectory, owner.token).catch((error) => {
              if (!hasCode(error, 'ENOENT')) throw error
            })
            released = true
          }
        }
      } catch (error) {
        if (!hasCode(error, 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES')) throw error
      }
      await recoverDeadLock(lockDirectory, policy)
      if (performance.now() - started >= waitTimeoutMs)
        throw new Error('Timed out waiting for managed media generation lock')
      await sleep(
        Math.min(retryDelayMs, Math.max(1, waitTimeoutMs - (performance.now() - started)))
      )
    }
  } finally {
    if (!published) await retireOwner(candidate, owner.token).catch(() => undefined)
  }
}

export type ManagedMediaGenerationArtifactCleanupOptions = Readonly<{
  now?: () => number
  staleAfterMs?: number
  hostname?: string
  isProcessAlive?: (pid: number) => boolean
  maxEntries?: number
}>

async function removeArtifactWithoutTraversal(target: string): Promise<void> {
  const stat = await fs.lstat(target)
  if (stat.isSymbolicLink()) {
    await fs.unlink(target)
    return
  }
  if (!stat.isDirectory()) throw new Error('Generation artifact is not a directory')
  // Node has no portable handle-relative unlink/rmdir API. Recursing after
  // lstat/realpath checks still permits a parent-swap race to delete external
  // files. Fail closed on nonempty trees, even for this process's work files.
  // rmdir is atomic and never traverses a nonempty directory or junction.
  await fs.rmdir(target)
}

/** Caller holds the identity lock; foreign hosts, live owners and old names are preserved. */
export async function cleanupManagedMediaGenerationArtifacts(
  identityRoot: string,
  input: ManagedMediaGenerationArtifactCleanupOptions = {}
): Promise<void> {
  const root = await validateIdentityRoot(identityRoot)
  const now = input.now ?? Date.now
  const staleAfterMs = input.staleAfterMs ?? MANAGED_MEDIA_GENERATION_LOCK_STALE_MS
  const hostTag = managedMediaGenerationHostTag(input.hostname ?? os.hostname())
  const alive = input.isProcessAlive ?? localProcessIsAlive
  const limit = input.maxEntries ?? MAX_SCAN_ENTRIES
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isFinite(staleAfterMs) ||
    staleAfterMs < 0
  )
    throw new TypeError('Invalid managed media generation cleanup bounds')
  for (const name of await readEntries(root, Math.min(limit, MAX_SCAN_ENTRIES))) {
    const match = ARTIFACT_NAME.exec(name)
    if (!match || match[3] !== hostTag) continue
    const pid = Number(match[2])
    const createdAt = Number(match[4])
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      pid > 2_147_483_647 ||
      !Number.isSafeInteger(createdAt) ||
      createdAt <= 0 ||
      now() - createdAt < staleAfterMs ||
      alive(pid)
    )
      continue
    const target = path.join(root, name)
    try {
      const stat = await fs.lstat(target)
      if (now() - stat.mtimeMs < staleAfterMs) continue
      await validateIdentityRoot(root)
      await removeArtifactWithoutTraversal(target)
    } catch {
      // Cleanup is bounded best effort, never a reason to fail a valid commit.
    }
  }
}

export async function removeManagedMediaGenerationTree(
  identityRoot: string,
  artifactPath: string
): Promise<void> {
  const root = await validateIdentityRoot(identityRoot)
  const target = path.resolve(artifactPath)
  if (!samePath(path.dirname(target), root) || !ARTIFACT_NAME.test(path.basename(target)))
    throw new Error('Managed media generation artifact path is unsafe')
  try {
    await removeArtifactWithoutTraversal(target)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
}

/**
 * Bounded cleanup of this live operation's private trees, not stale or
 * user-supplied trees. Managed parents must remain controlled by the app;
 * Node's path APIs cannot provide a hostile same-user mutation guarantee.
 */
export async function removeOwnedManagedMediaGenerationTree(
  identityRoot: string,
  artifactPath: string,
  owner: ManagedMediaGenerationLockOwner
): Promise<void> {
  const root = await validateIdentityRoot(identityRoot)
  const target = path.resolve(artifactPath)
  const match = ARTIFACT_NAME.exec(path.basename(target))
  if (
    !samePath(path.dirname(target), root) ||
    !match ||
    match[2] !== String(owner.pid) ||
    match[3] !== managedMediaGenerationHostTag(owner.hostname) ||
    match[4] !== String(owner.createdAt) ||
    match[5] !== owner.token
  )
    throw new Error('Generation tree does not belong to this operation')
  const budget = { entries: 0, bytes: 0 }
  async function remove(current: string, depth: number): Promise<void> {
    if (depth > 16 || budget.entries >= 4_096)
      throw new Error('Owned generation cleanup exceeded depth/entry bounds')
    await validateIdentityRoot(path.dirname(current))
    const before = await fs.lstat(current)
    budget.entries += 1
    if (before.isSymbolicLink() || before.isFile()) {
      budget.bytes += before.isFile() ? before.size : 0
      if (budget.bytes > 64 * 1024 * 1024)
        throw new Error('Owned generation cleanup exceeded its byte bound')
      await validateIdentityRoot(path.dirname(current))
      const after = await fs.lstat(current)
      if (!sameIdentity(before, after)) throw new Error('Owned generation file changed')
      await fs.unlink(current)
      return
    }
    if (!before.isDirectory()) throw new Error('Unsafe owned generation entry')
    await validateDirectory(current)
    const names = await readEntries(current, 4_097 - budget.entries)
    if (names.length > 4_096 - budget.entries)
      throw new Error('Owned generation cleanup exceeded its entry bound')
    for (const name of names) await remove(path.join(current, name), depth + 1)
    await validateIdentityRoot(path.dirname(current))
    if (!sameIdentity(before, await validateDirectory(current)))
      throw new Error('Owned generation directory changed')
    await fs.rmdir(current)
  }
  try {
    await remove(target, 0)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
}
