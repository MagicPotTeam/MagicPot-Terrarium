import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { constants, type BigIntStats } from 'node:fs'
import fs from 'node:fs/promises'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import { MAX_IMAGE_BYTES } from './imageValidation'
import { MAX_BACKGROUND_REMOVAL_LIFETIME_MS, type BackgroundRemovalScope } from './runner'

export type SelectedSourceDeadline = {
  /** Both absolute deadlines MUST already exist before the chooser, owned by the orchestrator. */
  expiresAt: number
  monotonicDeadline: number
  signal?: AbortSignal
}
export type SelectedSourceError =
  | 'BUSY'
  | 'UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'CANCELLED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'PATH_DENIED'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'FILE_CHANGED'
  | 'IO_ERROR'
export type SelectedSourceResult =
  | {
      status: 'source'
      bytes: Buffer
      sha256: string
      scope: Readonly<BackgroundRemovalScope>
      expiresAt: number
    }
  | { status: 'error'; error: SelectedSourceError }
/** Trusted main/test adapter only; never accept adapters or paths through renderer IPC. */
export type SelectedSourceIO = {
  lstat: (value: string) => Promise<BigIntStats>
  realpath: (value: string) => Promise<string>
  statfs: (value: string) => Promise<{ type: bigint }>
  open: (
    value: string,
    flags: number
  ) => Promise<{
    stat: () => Promise<BigIntStats>
    read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<number>
    close: () => Promise<void>
  }>
}
export type TrustedSelectedSourceOptions = {
  chooseNative?: (
    context: Readonly<BackgroundRemovalScope>,
    signal: AbortSignal
  ) => Promise<string | null>
  /** Check ALL scope fields against live main authority; invalidate synchronously on unmount/replacement. */
  isCurrent?: (scope: Readonly<BackgroundRemovalScope>) => boolean
  io?: SelectedSourceIO
}
const nativeIO: SelectedSourceIO = {
  lstat: (value) => fs.lstat(value, { bigint: true }),
  realpath: (value) => fs.realpath(value),
  statfs: (value) => fs.statfs(value, { bigint: true }),
  open: async (value, flags) => {
    const handle = await fs.open(value, flags)
    return {
      stat: () => handle.stat({ bigint: true }),
      read: async (buffer, offset, length, position) =>
        (await handle.read(buffer, offset, length, position)).bytesRead,
      close: () => handle.close()
    }
  }
}
const windows = process.platform === 'win32'
// Same conservative allowlist as agentLocalFiles/readGrants. Windows libuv statfs type 0
// cannot attest physical locality (e.g. mapped drives); canonical DOS, never UNC, is required.
const localFileSystems = new Set(
  windows
    ? [0n]
    : process.platform === 'darwin'
      ? [17n, 24n]
      : [
          0x5346544en,
          0x4d44n,
          0x2011bab0n,
          0xef53n,
          0x58465342n,
          0x9123683en,
          0x01021994n,
          0x794c7630n,
          0x858458f6n,
          0x2fc12fc1n,
          0x15013346n,
          0x9660n
        ]
)
class SourceFault {
  constructor(readonly error: SelectedSourceError) {}
}
function fail(error: SelectedSourceError): never {
  throw new SourceFault(error)
}
const failure = (error: SelectedSourceError): SelectedSourceResult => ({ status: 'error', error })
function safeError(error: unknown): SelectedSourceError {
  if (error instanceof SourceFault) return error.error
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'NOT_FOUND'
  if (code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') return 'PATH_DENIED'
  return 'IO_ERROR'
}
function allowedComponent(part: string): boolean {
  if (!part || part.length > 255 || part === '.' || part === '..') return false
  if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part)) return false
  if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))
    return false
  const lower = part.toLowerCase()
  if (
    lower === '.kohakuterrarium' ||
    /\.(?:kohakutr|kt|drives|lock|sqlite3?|db)(?:$|[-.])/.test(lower)
  )
    return false
  if (/^\.env(?:$|[._-])/.test(lower) || lower === '.envrc') return false
  if (
    /^(?:\.ssh|\.git|\.aws|\.azure|\.gnupg|\.kube|\.npmrc|\.netrc|\.pypirc|\.dockercfg)$/.test(
      lower
    )
  )
    return false
  if (/^(?:auth\.json|cookies?(?:$|[._-])|credentials?(?:$|[._-])|secrets?(?:$|[._-]))/.test(lower))
    return false
  return !/\.(?:pem|key|p12|pfx|p8|ppk|jks|keystore|keychain|kdb|kdbx|credential|credentials|secret|token|crt|cer|der)$/i.test(
    part
  )
}
function localAbsolute(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096) fail('PATH_DENIED')
  for (const character of value) {
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) fail('PATH_DENIED')
  }
  if (/^[\\/]{2}/.test(value) || !path.isAbsolute(value)) fail('PATH_DENIED')
  if (windows ? !/^[A-Za-z]:[\\/]/.test(value) : value.includes('\\')) fail('PATH_DENIED')
  if (
    value
      .slice(path.parse(value).root.length)
      .split(/[\\/]/)
      .some((part) => !allowedComponent(part))
  )
    fail('PATH_DENIED')
  return value // Never trim/resolve away a rejected component to grant a different file.
}
const samePath = (a: string, b: string) =>
  windows ? a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase() : a === b
const sameIdentity = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.isFile() === b.isFile() &&
  a.isDirectory() === b.isDirectory()
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.nlink === 1n &&
  b.nlink === 1n
function snapshotScope(input: BackgroundRemovalScope): Readonly<BackgroundRemovalScope> {
  const { senderId, documentEpoch, projectId, operationId, sourceId } = input
  if (
    ![senderId, documentEpoch].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    ![projectId, operationId, sourceId].every(
      (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
    )
  )
    fail('INVALID_REQUEST')
  return Object.freeze({ senderId, documentEpoch, projectId, operationId, sourceId })
}
type Inspection = { chain: BigIntStats[]; stat: BigIntStats }
type Operation = {
  scope: Readonly<BackgroundRemovalScope>
  expiresAt: number
  monotonicDeadline: number
  generation: number
  controller: AbortController
  error?: SelectedSourceError
  scratch?: Buffer
  bytes?: Buffer
}

/**
 * MAIN ONLY. One retained instance per owner; absent chooser/current authority means no IO.
 * Native choice authorizes ONLY local read, not processing, native Run approval or upload.
 * No asset/URL inference, inherited local-read grant, decode, IPC, receipt, persistence or cache.
 * Choice does not attest the inode at dialog time: integrity starts at the first checked stat.
 * Rechecks detect ordinary changes, not malicious-process/OS-race-free access; reparse points
 * represented as symlinks are denied. Adapters/objects/promise settlement are trusted main.
 * Uncooperative chooser/IO/close retains capacity until settlement. A failed close permanently
 * quarantines this instance (no retry/reset escape); cancellation is not hard realtime.
 * Detached mutable bytes and their digest are for trusted main only, not public media handles.
 * Orchestration MUST pass the same pre-choice deadline envelope to runner.prepare's optional
 * fourth argument. Its three-argument default creates a new lifetime; production remains unwired.
 */
export function createSelectedSourceReader(options: TrustedSelectedSourceOptions = {}) {
  const { chooseNative, isCurrent, io = nativeIO } = options
  let generation = 0
  let active: Operation | undefined
  let poisoned = false
  function stop(op: Operation, error: SelectedSourceError): void {
    if (op.error) return
    op.error = error // Before abort listeners can reenter.
    op.scratch?.fill(0)
    op.bytes?.fill(0)
    op.bytes = undefined
    op.controller.abort()
  }
  function localGuard(op: Operation): void {
    if (op.error) return
    if (active !== op || generation !== op.generation) stop(op, 'REVOKED')
    else if (Date.now() >= op.expiresAt || performance.now() >= op.monotonicDeadline)
      stop(op, 'EXPIRED')
  }
  function guard(op: Operation): void {
    localGuard(op)
    if (op.error) return
    let current = false
    try {
      current = isCurrent?.(op.scope) === true
    } catch {
      /* Only safe terminal reasons escape. */
    }
    localGuard(op)
    if (!current) stop(op, 'REVOKED')
  }
  function check(op: Operation): void {
    guard(op)
    if (op.error) fail(op.error)
  }
  async function step<T>(
    op: Operation,
    invoke: () => Promise<T>,
    acquire?: (value: T) => void
  ): Promise<T> {
    check(op)
    try {
      const pending = invoke()
      guard(op) // Drain even when synchronous callback reentry cancelled this operation.
      const value = await pending
      acquire?.(value) // Own an opened handle BEFORE a post-await check can throw.
      check(op)
      return value
    } catch (error) {
      check(op)
      throw error
    }
  }
  async function inspect(op: Operation, absolute: string): Promise<Inspection> {
    const root = path.parse(absolute).root
    const parts = absolute.slice(root.length).split(/[\\/]/)
    let current = root
    const chain: BigIntStats[] = []
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = path.join(current, parts[index])
      const stat = await step(op, () => io.lstat(current))
      check(op)
      if (
        stat.isSymbolicLink() ||
        (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
      )
        fail('PATH_DENIED')
      chain.push(stat)
    }
    const canonical = await step(op, () => io.realpath(absolute))
    check(op)
    if (!samePath(absolute, localAbsolute(canonical))) fail('PATH_DENIED')
    const fileSystem = await step(op, () => io.statfs(absolute))
    check(op)
    if (!localFileSystems.has(BigInt.asUintN(32, fileSystem.type))) fail('PATH_DENIED')
    return { chain, stat: chain[chain.length - 1] }
  }
  function matches(first: Inspection, next: Inspection): void {
    if (
      first.chain.length !== next.chain.length ||
      !first.chain.every((stat, index) => sameIdentity(stat, next.chain[index])) ||
      !sameFile(first.stat, next.stat)
    )
      fail('FILE_CHANGED')
  }
  async function readSelected(
    input: BackgroundRemovalScope,
    deadline: SelectedSourceDeadline
  ): Promise<SelectedSourceResult> {
    if (active) return failure('BUSY')
    if (poisoned || !chooseNative || !isCurrent) return failure('UNAVAILABLE')
    let op: Operation
    let signal: AbortSignal | undefined
    try {
      const scope = snapshotScope(input)
      const { expiresAt, monotonicDeadline } = deadline
      signal = deadline.signal
      const wallRemaining = expiresAt - Date.now()
      const monoRemaining = monotonicDeadline - performance.now()
      if (
        !Number.isFinite(expiresAt) ||
        !Number.isFinite(monotonicDeadline) ||
        Math.max(wallRemaining, monoRemaining) > MAX_BACKGROUND_REMOVAL_LIFETIME_MS ||
        (signal !== undefined && !(signal instanceof AbortSignal))
      )
        fail('INVALID_REQUEST')
      if (Math.min(wallRemaining, monoRemaining) <= 0) fail('EXPIRED')
      if (signal?.aborted) fail('CANCELLED')
      op = { scope, expiresAt, monotonicDeadline, generation, controller: new AbortController() }
    } catch (error) {
      return failure(error instanceof SourceFault ? error.error : 'INVALID_REQUEST')
    }
    active = op // Reserve before chooser/current callbacks, including synchronous reentry.
    const timer = setTimeout(
      () => stop(op, 'EXPIRED'),
      Math.min(op.expiresAt - Date.now(), op.monotonicDeadline - performance.now())
    )
    timer.unref()
    let subscription: ReturnType<typeof addAbortListener> | undefined
    let handle: Awaited<ReturnType<SelectedSourceIO['open']>> | undefined
    let error: SelectedSourceError | undefined
    let sha256 = ''
    try {
      if (signal) {
        const onAbort = () => stop(op, 'CANCELLED')
        // Installation belongs to the cleanup boundary too; earlier listeners cannot veto abort.
        subscription = addAbortListener(signal, onAbort)
        if (signal.aborted) onAbort()
      }
      const selected = await step(op, () => chooseNative(op.scope, op.controller.signal))
      check(op)
      if (selected === null) fail('CANCELLED')
      const absolute = localAbsolute(selected)
      const first = await step(op, () => inspect(op, absolute))
      check(op)
      if (first.stat.size < 0n || first.stat.size > BigInt(MAX_IMAGE_BYTES)) fail('TOO_LARGE')
      const opened = await step(
        op,
        () =>
          io.open(
            absolute,
            constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
          ),
        (value) => {
          handle = value
        }
      )
      check(op)
      const before = await step(op, () => opened.stat())
      check(op)
      if (!sameFile(first.stat, before)) fail('FILE_CHANGED')
      matches(first, await step(op, () => inspect(op, absolute)))
      check(op)
      const buffer = (op.scratch = Buffer.alloc(Number(before.size) + 1))
      let length = 0
      while (length < buffer.length) {
        const count = Math.min(16 * 1024, buffer.length - length)
        const read = await step(op, () => opened.read(buffer, length, count, length))
        check(op)
        if (!Number.isInteger(read) || read < 0 || read > count) fail('IO_ERROR')
        if (read === 0) break
        length += read
      }
      const after = await step(op, () => opened.stat())
      check(op)
      if (!sameFile(first.stat, after) || BigInt(length) !== first.stat.size) fail('FILE_CHANGED')
      matches(first, await step(op, () => inspect(op, absolute)))
      check(op)
      op.bytes = Buffer.alloc(length) // Unpooled copy, never an alias of IO's sentinel buffer.
      op.bytes.set(buffer.subarray(0, length))
      sha256 = createHash('sha256').update(op.bytes).digest('hex')
    } catch (caught) {
      error = safeError(caught)
    } finally {
      guard(op)
      // A late read may have repopulated the cancelled buffer; erase before a slow close.
      op.scratch?.fill(0)
      op.scratch = undefined
      if (handle) {
        try {
          const closing = handle.close() // Cleanup is mandatory even when the guard is terminal.
          guard(op)
          await closing
        } catch {
          poisoned = true
        }
        guard(op)
      }
    }
    guard(op) // No awaits after this outer delivery check, including cleanup.
    error = poisoned ? 'IO_ERROR' : (op.error ?? error)
    const bytes = op.bytes
    op.bytes = undefined
    clearTimeout(timer)
    subscription?.[Symbol.dispose]()
    active = undefined
    if (error || !bytes) {
      bytes?.fill(0)
      return failure(error ?? 'IO_ERROR')
    }
    return { status: 'source', bytes, sha256, scope: op.scope, expiresAt: op.expiresAt }
  }
  return {
    readSelected,
    cancel: () => {
      generation++
      if (active) stop(active, 'CANCELLED')
    },
    invalidate: () => {
      generation++
      if (active) stop(active, 'REVOKED')
    }
  }
}
