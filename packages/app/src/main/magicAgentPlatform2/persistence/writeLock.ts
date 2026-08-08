import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats
} from 'node:fs'
import * as nodeFs from 'node:fs'
import { basename, dirname, join, parse, resolve } from 'node:path'

import lockfileModule from 'proper-lockfile'

const lockfile = lockfileModule as unknown as {
  lockSync(path: string, options: LockOptions): () => void
}

type LockOptions = Readonly<{
  realpath: false
  stale: number
  update: number
  retries: 0
  fs: typeof nodeFs
}>
type LockOwner = Readonly<{ pid: number; token: string; createdAt: number }>

const STALE_MS = 30_000
const UPDATE_MS = 10_000
const LEASE_NAME =
  /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.lease$/i

export type WriteLockRelease = () => void
export type InstanceLease = Readonly<{ path: string; release(): void }>

export function acquireEventStoreWriteLock(databasePath: string): WriteLockRelease {
  const anchor = prepareAdjacentPath(databasePath, '.magicagent.lock-target')
  ensureAnchor(anchor)
  const ownerPath = `${anchor}.owner`
  const lockPath = `${anchor}.lock`

  if (pathExists(lockPath)) recoverDeadWriteLock(anchor)
  else removeDeadOwnerWithoutLock(ownerPath)

  let release: () => void
  try {
    release = lockfile.lockSync(anchor, lockOptions())
  } catch (error) {
    if (!isLockedError(error)) throw error
    recoverDeadWriteLock(anchor)
    release = lockfile.lockSync(anchor, lockOptions())
  }

  const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() }
  let ownerIdentity: Stats
  try {
    removeDeadOwnerWithoutLock(ownerPath)
    createJsonAnchor(ownerPath, owner)
    ownerIdentity = lstatSync(ownerPath)
    fsyncDirectory(dirname(ownerPath))
  } catch (error) {
    release()
    throw error
  }

  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const current = readOwner(ownerPath)
      if (current.owner.token !== owner.token || current.owner.pid !== owner.pid)
        throw new Error(`Event-store write-lock owner changed before release: ${ownerPath}`)
      unlinkIfIdentityMatches(ownerPath, ownerIdentity, true)
      fsyncDirectory(dirname(ownerPath))
    } finally {
      release()
    }
  }
}

export function acquireInstanceLease(databasePath: string): InstanceLease {
  const directory = prepareInstanceDirectory(databasePath)
  const anchor = join(directory, `${process.pid}-${randomUUID()}.lease`)
  createJsonAnchor(anchor, {
    pid: process.pid,
    startedAt: Date.now() - Math.floor(process.uptime() * 1_000)
  })
  const identity = lstatSync(anchor)
  let releaseLock: (() => void) | undefined
  try {
    releaseLock = lockfile.lockSync(anchor, lockOptions())
  } catch (error) {
    unlinkIfIdentityMatches(anchor, identity)
    throw error
  }

  let released = false
  return {
    path: anchor,
    release(): void {
      if (released) return
      released = true
      try {
        releaseLock?.()
      } finally {
        unlinkIfIdentityMatches(anchor, identity)
      }
    }
  }
}

export function assertNoActiveInstanceLeases(databasePath: string): void {
  const directory = prepareInstanceDirectory(databasePath)
  scanAndCleanInstanceLeases(directory)
  scanAndCleanInstanceLeases(directory)
}

function scanAndCleanInstanceLeases(directory: string): void {
  const entries = readdirSync(directory, { withFileTypes: true })
  const anchors = new Set(
    entries.filter((entry) => LEASE_NAME.test(entry.name)).map((entry) => entry.name)
  )

  for (const entry of entries) {
    if (anchors.has(entry.name)) {
      const stat = lstatSync(join(directory, entry.name))
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(
          `Event-store instance lease must be a regular non-symbolic file: ${entry.name}`
        )
      continue
    }
    const anchorName = entry.name.endsWith('.lock') ? entry.name.slice(0, -5) : ''
    if (anchorName && LEASE_NAME.test(anchorName)) {
      const stat = lstatSync(join(directory, entry.name))
      if (!stat.isSymbolicLink() && stat.isDirectory()) continue
      throw new Error(`Unsafe event-store instance lease lock directory: ${entry.name}`)
    }
    throw new Error(`Unsafe event-store instance lease entry: ${entry.name}`)
  }

  for (const name of anchors) {
    const match = LEASE_NAME.exec(name)
    const pid = match ? Number(match[1]) : 0
    // PID reuse can conservatively report an old lease as active; fail-closed is safer than deletion.
    if (!Number.isSafeInteger(pid) || pid <= 0 || isPidAlive(pid)) {
      throw new Error(
        `Restore target is open by an active instance lease: ${join(directory, name)}`
      )
    }
    const anchor = join(directory, name)
    const identity = lstatSync(anchor)
    if (identity.isSymbolicLink() || !identity.isFile())
      throw new Error(`Event-store instance lease changed during inspection: ${anchor}`)
    removeEmptyLockDirectory(`${anchor}.lock`, 'Inactive instance lease')
    unlinkIfIdentityMatches(anchor, identity, true)
    fsyncDirectory(directory)
  }

  if (readdirSync(directory).some((name) => LEASE_NAME.test(name)))
    throw new Error('Event-store instance leases changed during restore inspection.')
}

function recoverDeadWriteLock(anchor: string): void {
  const ownerPath = `${anchor}.owner`
  let read: ReturnType<typeof readOwner>
  try {
    read = readOwner(ownerPath)
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'ENOENT')
      throw new Error(`Event-store write-lock requires manual cleanup: ${anchor}.lock`, { cause })
    throw cause
  }
  if (isPidAlive(read.owner.pid)) throw lockedError(anchor)
  const verify = readOwner(ownerPath)
  if (verify.owner.token !== read.owner.token || !sameStats(read.identity, verify.identity))
    throw new Error(`Event-store write-lock owner changed during inspection: ${ownerPath}`)
  removeEmptyLockDirectory(`${anchor}.lock`, 'Dead event-store write lock')
  unlinkIfIdentityMatches(ownerPath, read.identity, true)
  fsyncDirectory(dirname(anchor))
}

function removeDeadOwnerWithoutLock(ownerPath: string): void {
  let read: ReturnType<typeof readOwner>
  try {
    read = readOwner(ownerPath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
  if (isPidAlive(read.owner.pid))
    throw new Error(`Live event-store write-lock owner exists without its lock: ${ownerPath}`)
  const verify = readOwner(ownerPath)
  if (verify.owner.token !== read.owner.token || !sameStats(read.identity, verify.identity))
    throw new Error(`Event-store write-lock owner changed during inspection: ${ownerPath}`)
  unlinkIfIdentityMatches(ownerPath, read.identity, true)
  fsyncDirectory(dirname(ownerPath))
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function readOwner(path: string): { owner: LockOwner; identity: Stats } {
  const identity = lstatSync(path)
  if (identity.isSymbolicLink() || !identity.isFile())
    throw new Error(`Event-store write-lock owner requires manual cleanup: ${path}`)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new Error(`Event-store write-lock owner requires manual cleanup: ${path}`, { cause })
  }
  const owner = value as Partial<LockOwner>
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid ?? 0) <= 0 ||
    typeof owner.token !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(owner.token) ||
    typeof owner.createdAt !== 'number' ||
    !Number.isFinite(owner.createdAt)
  )
    throw new Error(`Event-store write-lock owner requires manual cleanup: ${path}`)
  const current = lstatSync(path)
  if (!sameStats(identity, current))
    throw new Error(`Event-store write-lock owner changed during inspection: ${path}`)
  return { owner: owner as LockOwner, identity }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'EPERM') return true
    if (isNodeError(error) && error.code === 'ESRCH') return false
    throw error
  }
}

function removeEmptyLockDirectory(path: string, label: string): void {
  let identity: Stats
  try {
    identity = lstatSync(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
  if (identity.isSymbolicLink() || !identity.isDirectory())
    throw new Error(`${label} directory requires manual cleanup: ${path}`)
  const current = lstatSync(path)
  if (!sameStats(identity, current)) throw new Error(`${label} directory changed: ${path}`)
  try {
    rmdirSync(path)
  } catch (cause) {
    throw new Error(`${label} directory requires manual cleanup: ${path}`, { cause })
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    try {
      fsyncSync(fd)
    } catch (error) {
      if (process.platform !== 'win32' || !isNodeError(error) || error.code !== 'EPERM') throw error
    }
  } finally {
    closeSync(fd)
  }
}

export function instanceLeaseDirectory(databasePath: string): string {
  const database = resolve(databasePath)
  return join(dirname(database), `${basename(database)}.magicagent.instances`)
}

function prepareAdjacentPath(databasePath: string, suffix: string): string {
  const database = resolve(databasePath)
  const parentInput = dirname(database)
  mkdirSync(parentInput, { recursive: true })
  assertSafeDirectoryChain(parentInput)
  return join(realpathSync(parentInput), `${basename(database)}${suffix}`)
}

function prepareInstanceDirectory(databasePath: string): string {
  const directory = prepareAdjacentPath(databasePath, '.magicagent.instances')
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
  }
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`Event-store instance lease directory is unsafe: ${directory}`)
  if (process.platform === 'win32' && normalize(realpathSync(directory)) !== normalize(directory))
    throw new Error(`Event-store instance lease directory is a reparse point: ${directory}`)
  return directory
}

function ensureAnchor(anchor: string): void {
  try {
    createJsonAnchor(anchor, {
      pid: process.pid,
      startedAt: Date.now() - Math.floor(process.uptime() * 1_000)
    })
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
  }
  const stat = lstatSync(anchor)
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`Event-store lock anchor must be a regular non-symbolic file: ${anchor}`)
}

function createJsonAnchor(path: string, value: unknown): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    writeSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function unlinkIfIdentityMatches(path: string, identity: Stats, required = false): void {
  let current: Stats
  try {
    current = lstatSync(path)
  } catch (error) {
    if (!required && isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
  if (current.isSymbolicLink() || !current.isFile() || !sameStats(identity, current)) {
    if (required) throw new Error(`Refusing to remove changed lock metadata: ${path}`)
    return
  }
  unlinkSync(path)
}

function sameStats(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
function lockOptions(): LockOptions {
  return { realpath: false, stale: STALE_MS, update: UPDATE_MS, retries: 0, fs: nodeFs }
}

function assertSafeDirectoryChain(path: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Event-store lock parent is unsafe: ${current}`)
    if (process.platform === 'win32' && normalize(realpathSync(current)) !== normalize(current))
      throw new Error(`Event-store lock parent is a reparse point: ${current}`)
  }
}
function normalize(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
function isLockedError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ELOCKED'
}
function lockedError(path: string): Error {
  return Object.assign(new Error(`Lock file is already being held: ${path}`), { code: 'ELOCKED' })
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
