import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const UPDATE_LOCK_FILE = 'update.lock'

export interface UpdateLockOwner {
  schema: 1
  token: string
  pid: number
  hostname: string
  createdAt: string
}

export interface UpdateLock {
  path: string
  owner: UpdateLockOwner
  release(): Promise<void>
}

export interface AcquireUpdateLockOptions {
  now?: () => Date
  pid?: number
  hostname?: string
  token?: () => string
  staleAfterMs?: number
  isProcessAlive?: (pid: number) => boolean
  releaseTimeoutMs?: number
  retryDelayMs?: number
  sleep?: (milliseconds: number) => Promise<void>
}

export interface WaitForUpdateLockOptions extends AcquireUpdateLockOptions {
  waitTimeoutMs?: number
  retryIntervalMs?: number
}

export class UpdateLockError extends Error {
  readonly owner?: UpdateLockOwner

  constructor(message: string, owner?: UpdateLockOwner) {
    super(message)
    this.name = 'UpdateLockError'
    this.owner = owner
  }
}

export class UpdateLockBusyError extends UpdateLockError {
  constructor(message: string, owner?: UpdateLockOwner) {
    super(message, owner)
    this.name = 'UpdateLockBusyError'
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function isTransientLockSharingError(error: unknown): boolean {
  return ['EBUSY', 'EACCES', 'EPERM'].some((code) => hasErrorCode(error, code))
}

function sameHostname(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

async function lockIo<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isTransientLockSharingError(error)) throw new UpdateLockBusyError(message)
    throw error
  }
}

const OWNER_FIELDS = ['schema', 'token', 'pid', 'hostname', 'createdAt'] as const
const MAX_OWNER_TOKEN_LENGTH = 256
const MAX_INT32 = 2_147_483_647

function parseOwner(text: string): UpdateLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const fields = Object.keys(record)
    if (
      fields.length !== OWNER_FIELDS.length ||
      !OWNER_FIELDS.every((field) => fields.includes(field))
    )
      return undefined
    if (
      record.schema !== 1 ||
      typeof record.token !== 'string' ||
      record.token.length === 0 ||
      record.token.length > MAX_OWNER_TOKEN_LENGTH ||
      !Number.isInteger(record.pid) ||
      (record.pid as number) <= 0 ||
      (record.pid as number) > MAX_INT32 ||
      typeof record.hostname !== 'string' ||
      record.hostname.length === 0 ||
      typeof record.createdAt !== 'string'
    )
      return undefined
    const timestamp = Date.parse(record.createdAt)
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== record.createdAt)
      return undefined
    return record as unknown as UpdateLockOwner
  } catch {
    return undefined
  }
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false
    return true
  }
}

interface LockSnapshot {
  owner: UpdateLockOwner | undefined
  size: number
  birthtimeMs: number
  mtimeMs: number
}

async function snapshotLock(lockPath: string): Promise<LockSnapshot | undefined> {
  try {
    const before = await fs.stat(lockPath)
    const owner = parseOwner(await fs.readFile(lockPath, 'utf8'))
    const after = await fs.stat(lockPath)
    if (
      before.size !== after.size ||
      before.birthtimeMs !== after.birthtimeMs ||
      before.mtimeMs !== after.mtimeMs
    )
      return undefined
    return { owner, size: after.size, birthtimeMs: after.birthtimeMs, mtimeMs: after.mtimeMs }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
}

function sameSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return (
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.owner?.token === right.owner?.token
  )
}

async function recoverStaleLock(
  lockPath: string,
  before: LockSnapshot | undefined,
  now: Date,
  options: AcquireUpdateLockOptions
): Promise<boolean> {
  const existing = before?.owner
  if (options.staleAfterMs === undefined || !existing) return false
  if (!Number.isFinite(options.staleAfterMs) || options.staleAfterMs < 0)
    throw new TypeError('Update lock staleAfterMs must be a non-negative finite number')
  if (now.getTime() - Date.parse(existing.createdAt) < options.staleAfterMs) return false
  const hostname = options.hostname ?? os.hostname()
  if (!sameHostname(existing.hostname, hostname)) return false
  if ((options.isProcessAlive ?? localProcessIsAlive)(existing.pid)) return false

  const after = await lockIo('Update lock metadata is temporarily unavailable', () =>
    snapshotLock(lockPath)
  )
  if (!before || !after || !sameSnapshot(before, after)) return false

  const quarantinePath = `${lockPath}.${existing.token}.${(options.token ?? randomUUID)()}.stale`
  try {
    await lockIo('Update lock is temporarily unavailable for stale recovery', () =>
      fs.rename(lockPath, quarantinePath)
    )
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'EEXIST')) return false
    throw error
  }
  let moved: LockSnapshot | undefined
  try {
    moved = await lockIo('Quarantined update lock metadata is temporarily unreadable', () =>
      snapshotLock(quarantinePath)
    )
  } catch (error) {
    await lockIo('Quarantined update lock could not be restored', () =>
      fs.rename(quarantinePath, lockPath)
    )
    throw error
  }
  if (!moved || !sameSnapshot(after, moved)) {
    await lockIo('Quarantined update lock could not be restored', () =>
      fs.rename(quarantinePath, lockPath)
    )
    return false
  }
  try {
    await lockIo('Quarantined update lock is temporarily unavailable for cleanup', () =>
      fs.unlink(quarantinePath)
    )
    return true
  } catch (error) {
    await lockIo('Quarantined update lock could not be restored', () =>
      fs.rename(quarantinePath, lockPath)
    )
    throw error
  }
}

export async function acquireUpdateLock(
  root: string,
  options: AcquireUpdateLockOptions = {}
): Promise<UpdateLock> {
  if (!path.isAbsolute(root)) throw new TypeError('Update lock root must be absolute')
  const releaseTimeoutMs = options.releaseTimeoutMs ?? 5_000
  const retryDelayMs = options.retryDelayMs ?? 50
  if (!Number.isFinite(releaseTimeoutMs) || releaseTimeoutMs < 0)
    throw new TypeError('releaseTimeoutMs must be non-negative')
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0)
    throw new TypeError('retryDelayMs must be positive')
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  await fs.mkdir(root, { recursive: true })
  const lockPath = path.join(root, UPDATE_LOCK_FILE)
  const now = (options.now ?? (() => new Date()))()
  const owner: UpdateLockOwner = {
    schema: 1,
    token: (options.token ?? randomUUID)(),
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? os.hostname(),
    createdAt: now.toISOString()
  }

  let handle: fs.FileHandle
  for (;;) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error
      let snapshot: LockSnapshot | undefined
      try {
        snapshot = await snapshotLock(lockPath)
      } catch (readError) {
        if (isTransientLockSharingError(readError))
          throw new UpdateLockBusyError('Update lock owner metadata is temporarily unreadable')
        throw readError
      }
      const existing = snapshot?.owner
      if (await recoverStaleLock(lockPath, snapshot, now, options)) continue
      throw new UpdateLockBusyError(
        existing
          ? `Update lock is held by pid ${existing.pid} on ${existing.hostname}`
          : 'Update lock exists with unreadable owner metadata',
        existing
      )
    }
  }

  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await fs.unlink(lockPath).catch(() => undefined)
    throw error
  }

  let released = false
  let handleClosed = false
  return {
    path: lockPath,
    owner,
    async release(): Promise<void> {
      if (released) return
      if (!handleClosed) {
        await handle.close()
        handleClosed = true
      }
      const startedAt = Date.now()
      for (;;) {
        try {
          const current = (await snapshotLock(lockPath))?.owner
          if (!current || current.token !== owner.token)
            throw new UpdateLockError('Update lock ownership changed before release', current)
          await fs.unlink(lockPath)
          released = true
          return
        } catch (error) {
          if (!isTransientLockSharingError(error) || Date.now() - startedAt >= releaseTimeoutMs)
            throw error
          await sleep(
            Math.min(retryDelayMs, Math.max(0, releaseTimeoutMs - (Date.now() - startedAt)))
          )
        }
      }
    }
  }
}

export async function withUpdateLock<T>(
  root: string,
  operation: () => Promise<T>,
  options: AcquireUpdateLockOptions = {}
): Promise<T> {
  const lock = await acquireUpdateLock(root, options)
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}

export async function withWaitedUpdateLock<T>(
  root: string,
  operation: () => Promise<T>,
  options: WaitForUpdateLockOptions = {}
): Promise<T> {
  const waitTimeoutMs = options.waitTimeoutMs ?? 5_000
  const retryIntervalMs = options.retryIntervalMs ?? 50
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0)
    throw new TypeError('waitTimeoutMs must be non-negative')
  if (!Number.isFinite(retryIntervalMs) || retryIntervalMs <= 0)
    throw new TypeError('retryIntervalMs must be positive')
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const startedAt = Date.now()
  let lock: UpdateLock
  for (;;) {
    try {
      lock = await acquireUpdateLock(root, options)
      break
    } catch (error) {
      if (!(error instanceof UpdateLockBusyError) || Date.now() - startedAt >= waitTimeoutMs)
        throw error
      await sleep(Math.min(retryIntervalMs, Math.max(0, waitTimeoutMs - (Date.now() - startedAt))))
    }
  }
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}
