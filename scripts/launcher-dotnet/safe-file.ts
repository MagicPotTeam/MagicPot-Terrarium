import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, parse as parsePath, resolve } from 'node:path'

export interface PublishHooks {
  beforeLink?: (context: { temporary: string; output: string; parent: string }) => void
  afterLink?: (context: { temporary: string; output: string; parent: string }) => void
  afterVerify?: (context: {
    temporary: string
    output: string
    parent: string
    outputFd: number
  }) => void
}
export interface NativeFileIdentity {
  volumeSerial: bigint
  fileIndex: bigint
}
export interface SafeFileRequest {
  root: string
  path: string
}
export interface SafeDeleteRequest extends SafeFileRequest {
  identity: NativeFileIdentity
}
export interface SafeDeleteDelegate {
  inspect: (request: SafeFileRequest) => NativeFileIdentity
  delete: (request: SafeDeleteRequest) => { status: 'deleted' | 'deleted-foreign-preserved' }
}
export const safeFileTestHooks: { safeDelete?: SafeDeleteDelegate } = {}

export function resolveSafeDeleteDelegate(): SafeDeleteDelegate {
  if (process.env.NODE_ENV === 'test' && safeFileTestHooks.safeDelete)
    return safeFileTestHooks.safeDelete
  const configured = process.env.MAGICPOT_SAFE_FILE_OPS
  if (process.platform !== 'win32' && !(process.env.NODE_ENV === 'test' && configured))
    throw new Error('Windows SafeFileOps helper is required for cleanup')
  const executable =
    configured ?? resolve(process.cwd(), 'dist/launcher-tools/win-x64/MagicPot.SafeFileOps.exe')
  if (!isAbsolute(executable) || !existsSync(executable))
    throw new Error('Windows SafeFileOps helper is unavailable; output requires quarantine')
  const invoke = (arguments_: string[]) => {
    const testCommand =
      process.env.NODE_ENV === 'test' &&
      process.platform === 'win32' &&
      executable.toLowerCase().endsWith('.cmd')
    return spawnSync(executable, arguments_, {
      encoding: 'utf8',
      windowsHide: true,
      shell: testCommand
    })
  }
  return {
    inspect: (request) => {
      const result = invoke(['inspect-file', '--root', request.root, '--path', request.path])
      if (result.error || result.status !== 0)
        throw new Error('SafeFileOps inspection failed; path requires quarantine')
      let parsed: { status?: string; volumeSerial?: string; fileIndex?: string }
      try {
        parsed = JSON.parse(result.stdout.trim()) as typeof parsed
      } catch {
        throw new Error('SafeFileOps returned invalid output')
      }
      if (
        parsed.status !== 'inspected' ||
        !/^\d+$/.test(parsed.volumeSerial ?? '') ||
        !/^\d+$/.test(parsed.fileIndex ?? '')
      )
        throw new Error('SafeFileOps refused inspection; path requires quarantine')
      return { volumeSerial: BigInt(parsed.volumeSerial!), fileIndex: BigInt(parsed.fileIndex!) }
    },
    delete: (request) => {
      const result = invoke([
        'delete-file',
        '--root',
        request.root,
        '--path',
        request.path,
        '--volume-serial',
        request.identity.volumeSerial.toString(),
        '--file-index',
        request.identity.fileIndex.toString()
      ])
      if (result.error || result.status !== 0)
        throw new Error(
          `SafeFileOps cleanup failed; path requires quarantine${process.env.NODE_ENV === 'test' ? ` (${result.error?.message ?? result.status}: ${result.stderr.trim()})` : ''}`
        )
      let parsed: { status?: string }
      try {
        parsed = JSON.parse(result.stdout.trim()) as { status?: string }
      } catch {
        throw new Error('SafeFileOps returned invalid output')
      }
      if (parsed.status !== 'deleted' && parsed.status !== 'deleted-foreign-preserved')
        throw new Error('SafeFileOps refused cleanup; path requires quarantine')
      return { status: parsed.status }
    }
  }
}
function inspectIdentity(root: string, path: string, nodeIdentity: Stats): NativeFileIdentity {
  const absolute = resolve(path),
    before = lstatSync(absolute),
    identity = resolveSafeDeleteDelegate().inspect({ root: resolve(root), path: absolute }),
    after = lstatSync(absolute)
  if (
    !sameIdentity(nodeIdentity, before) ||
    !sameIdentity(before, after) ||
    before.isSymbolicLink() ||
    !before.isFile()
  )
    throw new Error('foreign')
  return identity
}
function deleteIdentity(
  root: string,
  path: string,
  nodeIdentity: Stats,
  identity: NativeFileIdentity
): void {
  const current = lstatSync(path)
  if (!sameIdentity(nodeIdentity, current) || current.isSymbolicLink() || !current.isFile())
    throw new Error('foreign')
  const result = resolveSafeDeleteDelegate().delete({
    root: resolve(root),
    path: resolve(path),
    identity
  })
  if (result.status === 'deleted-foreign-preserved') throw new Error('foreign')
}
export function systemCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}
export function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
export function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
export function sameStableFile(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}
export function assertNoSymlinkChain(path: string, includeFinal: boolean, reason: string): void {
  const absolute = resolve(path),
    root = parsePath(absolute).root,
    parts: string[] = []
  let current = includeFinal ? absolute : dirname(absolute)
  while (normalizedPath(current) !== normalizedPath(root)) {
    parts.push(current)
    current = dirname(current)
  }
  parts.push(root)
  for (const part of parts.reverse()) {
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error(reason)
    } catch (error) {
      if (error instanceof Error && error.message === reason) throw error
      throw new Error(reason)
    }
  }
}

export interface SafeReadResult {
  bytes: Buffer
  stat: Stats
  realPath: string
}
export function safeReadRegularFileByFd(
  path: string,
  maximum: number,
  reason: string,
  afterOpen?: (fd: number) => void
): SafeReadResult {
  const absolute = resolve(path)
  assertNoSymlinkChain(absolute, true, reason)
  const linked = lstatSync(absolute)
  if (
    linked.isSymbolicLink() ||
    !linked.isFile() ||
    linked.nlink !== 1 ||
    linked.size < 0 ||
    linked.size > maximum
  )
    throw new Error(reason)
  const fd = openSync(absolute, constants.O_RDONLY)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || !sameStableFile(linked, opened))
      throw new Error(reason)
    afterOpen?.(fd)
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error(reason)
      offset += count
    }
    const afterRead = fstatSync(fd)
    assertNoSymlinkChain(absolute, true, reason)
    const realPath = realpathSync(absolute),
      finalPath = lstatSync(absolute),
      realPathStat = lstatSync(realPath),
      stat = fstatSync(fd)
    if (
      !sameStableFile(opened, afterRead) ||
      !sameStableFile(afterRead, stat) ||
      finalPath.isSymbolicLink() ||
      realPathStat.isSymbolicLink() ||
      !sameStableFile(stat, finalPath) ||
      !sameStableFile(stat, realPathStat)
    )
      throw new Error(reason)
    return { bytes, stat, realPath }
  } finally {
    closeSync(fd)
  }
}

export function safeReadRegularFile(
  path: string,
  maximum: number,
  reason: string,
  afterOpen?: (fd: number) => void
): Buffer {
  return safeReadRegularFileByFd(path, maximum, reason, afterOpen).bytes
}

interface ParentIdentity {
  realPath: string
  stat: Stats
}
function snapshotParent(parent: string): ParentIdentity {
  const reason = 'output parent failed safety checks'
  assertNoSymlinkChain(parent, true, reason)
  const linked = lstatSync(parent),
    target = statSync(parent)
  if (
    linked.isSymbolicLink() ||
    !linked.isDirectory() ||
    !target.isDirectory() ||
    !sameIdentity(linked, target)
  )
    throw new Error(reason)
  return { realPath: realpathSync(parent), stat: target }
}
function assertParent(parent: string, expected: ParentIdentity): void {
  const current = snapshotParent(parent)
  if (
    normalizedPath(current.realPath) !== normalizedPath(expected.realPath) ||
    !sameIdentity(current.stat, expected.stat)
  )
    throw new Error('output parent changed during publication')
}
function hashFd(fd: number, size: number): Buffer {
  const hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  while (offset < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset)
    if (!count) throw new Error('published output failed safety checks')
    hash.update(buffer.subarray(0, count))
    offset += count
  }
  return hash.digest()
}
function readExactly(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset)
    if (!count) throw new Error('published output failed safety checks')
    offset += count
  }
  return bytes
}
function assertPath(path: string, expected: Stats, links: number): Stats {
  const stat = lstatSync(path)
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !sameIdentity(stat, expected) ||
    stat.nlink !== links
  )
    throw new Error('published output failed safety checks')
  return stat
}
function absent(path: string): void {
  try {
    lstatSync(path)
    throw new Error('output already exists')
  } catch (error) {
    if (error instanceof Error && error.message === 'output already exists') throw error
    if (systemCode(error) !== 'ENOENT')
      throw new Error('output availability could not be determined')
  }
}
export type RemoveOwnUnverifiedOutputResult =
  | { status: 'removed' | 'absent' | 'foreign' }
  | { status: 'error'; error: Error }
function removeOwnUnverifiedOutput(
  output: string,
  sourceFd: number,
  nativeIdentity: NativeFileIdentity
): RemoveOwnUnverifiedOutputResult {
  const source = fstatSync(sourceFd)
  try {
    try {
      lstatSync(output)
    } catch (error) {
      if (systemCode(error) === 'ENOENT') return { status: 'absent' }
      throw error
    }
    deleteIdentity(dirname(output), output, source, nativeIdentity)
    const after = fstatSync(sourceFd)
    if (
      !sameIdentity(source, after) ||
      (after.nlink !== source.nlink - 1 && after.nlink !== source.nlink)
    )
      throw new Error('source identity changed after cleanup')
    return { status: after.nlink === source.nlink ? 'absent' : 'removed' }
  } catch (error) {
    if (error instanceof Error && error.message === 'foreign') return { status: 'foreign' }
    return {
      status: 'error',
      error: new Error('unverified output could not be removed safely', { cause: error })
    }
  }
}
function publicationFailure(
  publicationError: unknown,
  cleanup: RemoveOwnUnverifiedOutputResult
): never {
  if (cleanup.status === 'error')
    throw new AggregateError(
      [publicationError, cleanup.error],
      'publication failed and unverified output could not be removed'
    )
  if (cleanup.status === 'foreign') {
    const message =
      publicationError instanceof Error ? publicationError.message : 'publication failed'
    throw new Error(`${message}; output path was replaced and requires quarantine`, {
      cause: publicationError
    })
  }
  throw publicationError
}
export interface PublishExactFileOptions {
  tempPath: string
  tempFd: number
  output: string
  expectedSize: number
  expectedSha256: string
  verifyFromFd: (outputFd: number) => void | Promise<void>
  hooks?: PublishHooks
}
export async function publishExactFileNoReplace(options: PublishExactFileOptions): Promise<void> {
  const {
    tempPath,
    tempFd,
    output,
    expectedSize,
    expectedSha256,
    verifyFromFd,
    hooks = {}
  } = options
  if ((hooks.beforeLink || hooks.afterLink || hooks.afterVerify) && process.env.NODE_ENV !== 'test')
    throw new Error('publication hooks are test-only')
  const parent = dirname(output),
    parentIdentity = snapshotParent(parent),
    identity = fstatSync(tempFd),
    expectedHash = Buffer.from(expectedSha256, 'hex')
  absent(output)
  if (
    !identity.isFile() ||
    identity.nlink !== 1 ||
    identity.size !== expectedSize ||
    expectedHash.length !== 32
  )
    throw new Error('temporary output failed safety checks')
  fsyncSync(tempFd)
  if (
    !timingSafeEqual(hashFd(tempFd, expectedSize), expectedHash) ||
    !sameStableFile(identity, fstatSync(tempFd))
  )
    throw new Error('temporary output failed safety checks')
  const temporaryNativeIdentity = inspectIdentity(parent, tempPath, identity)
  let outputFd: number | undefined,
    outputNativeIdentity: NativeFileIdentity | undefined,
    temporaryRemoved = false,
    outputLinked = false,
    committed = false
  try {
    hooks.beforeLink?.({ temporary: tempPath, output, parent })
    assertParent(parent, parentIdentity)
    assertPath(tempPath, identity, 1)
    try {
      linkSync(tempPath, output)
      outputLinked = true
    } catch (error) {
      if (systemCode(error) === 'EEXIST') throw new Error('output already exists')
      throw new Error('could not atomically publish output')
    }
    outputFd = openSync(output, constants.O_RDONLY)
    const initiallyLinked = fstatSync(outputFd)
    outputNativeIdentity = inspectIdentity(parent, output, initiallyLinked)
    if (
      outputNativeIdentity.volumeSerial !== temporaryNativeIdentity.volumeSerial ||
      outputNativeIdentity.fileIndex !== temporaryNativeIdentity.fileIndex
    )
      throw new Error('published output failed safety checks')
    hooks.afterLink?.({ temporary: tempPath, output, parent })
    const linkedPath = assertPath(output, identity, 2),
      linkedFd = fstatSync(outputFd)
    if (
      !sameIdentity(linkedPath, linkedFd) ||
      !sameIdentity(linkedFd, identity) ||
      linkedFd.size !== expectedSize ||
      !timingSafeEqual(hashFd(outputFd, expectedSize), expectedHash)
    )
      throw new Error('published output failed safety checks')
    await verifyFromFd(outputFd)
    hooks.afterVerify?.({ temporary: tempPath, output, parent, outputFd })
    if (
      !sameStableFile(linkedFd, fstatSync(outputFd)) ||
      !timingSafeEqual(hashFd(outputFd, expectedSize), expectedHash)
    )
      throw new Error('published output failed safety checks')
    assertParent(parent, parentIdentity)
    assertPath(output, identity, 2)
    assertPath(tempPath, identity, 2)
    deleteIdentity(parent, tempPath, identity, temporaryNativeIdentity)
    temporaryRemoved = true
    const finalFd = fstatSync(outputFd),
      finalPath = assertPath(output, identity, 1)
    if (
      finalFd.nlink !== 1 ||
      !sameStableFile(finalFd, finalPath) ||
      finalFd.size !== expectedSize ||
      !timingSafeEqual(hashFd(outputFd, expectedSize), expectedHash)
    )
      throw new Error('published output failed safety checks')
    await verifyFromFd(outputFd)
    if (
      !sameStableFile(finalFd, fstatSync(outputFd)) ||
      !sameStableFile(finalPath, lstatSync(output)) ||
      !timingSafeEqual(hashFd(outputFd, expectedSize), expectedHash)
    )
      throw new Error('published output failed safety checks')
    assertParent(parent, parentIdentity)
    committed = true
  } catch (error) {
    if (outputLinked && !committed)
      publicationFailure(
        error,
        outputNativeIdentity
          ? removeOwnUnverifiedOutput(output, tempFd, outputNativeIdentity)
          : { status: 'foreign' }
      )
    throw error
  } finally {
    if (outputFd !== undefined) closeSync(outputFd)
    if (!temporaryRemoved)
      try {
        deleteIdentity(parent, tempPath, fstatSync(tempFd), temporaryNativeIdentity)
      } catch {
        /* preserve for quarantine */
      }
  }
}

export function publishExactNoReplaceFromFile(
  path: string,
  temporary: string,
  temporaryFd: number
): void {
  const identity = fstatSync(temporaryFd)
  throw new Error(
    `publishExactNoReplaceFromFile is unsafe for unverified publication (${path}, ${temporary}, ${identity.size})`
  )
}

export function publishExactNoReplace(
  path: string,
  contents: string | Buffer,
  verify: (bytes: Buffer) => void = () => {},
  hooks: PublishHooks = {}
): void {
  if ((hooks.beforeLink || hooks.afterLink || hooks.afterVerify) && process.env.NODE_ENV !== 'test')
    throw new Error('publication hooks are test-only')
  const parent = dirname(path),
    temporary = resolve(
      parent,
      `.${basename(path)}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
    )
  const expected = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
  let outputLinked = false,
    committed = false,
    outputNativeIdentity: NativeFileIdentity | undefined,
    temporaryNativeIdentity: NativeFileIdentity | undefined
  try {
    writeFileSync(fd, expected)
    fsyncSync(fd)
    verify(readExactly(fd, expected.length))
    // This compatibility API remains synchronous and is only used for small manifests.
    const parentIdentity = snapshotParent(parent),
      identity = fstatSync(fd),
      digest = createHash('sha256').update(expected).digest()
    temporaryNativeIdentity = inspectIdentity(parent, temporary, identity)
    absent(path)
    hooks.beforeLink?.({ temporary, output: path, parent })
    assertParent(parent, parentIdentity)
    assertPath(temporary, identity, 1)
    try {
      linkSync(temporary, path)
    } catch (error) {
      if (systemCode(error) === 'EEXIST') throw new Error('output already exists')
      throw new Error('could not atomically publish output')
    }
    outputLinked = true
    const outputFd = openSync(path, constants.O_RDONLY)
    try {
      const initialOutputStat = fstatSync(outputFd)
      outputNativeIdentity = inspectIdentity(parent, path, initialOutputStat)
      if (
        outputNativeIdentity.volumeSerial !== temporaryNativeIdentity.volumeSerial ||
        outputNativeIdentity.fileIndex !== temporaryNativeIdentity.fileIndex
      )
        throw new Error('published output failed safety checks')
      hooks.afterLink?.({ temporary, output: path, parent })
      const outputStat = fstatSync(outputFd)
      if (
        !sameIdentity(identity, outputStat) ||
        !timingSafeEqual(hashFd(outputFd, expected.length), digest)
      )
        throw new Error('published output failed safety checks')
      verify(readExactly(outputFd, expected.length))
      deleteIdentity(parent, temporary, identity, temporaryNativeIdentity)
      const final = assertPath(path, identity, 1)
      if (!sameStableFile(final, fstatSync(outputFd)))
        throw new Error('published output failed safety checks')
      verify(readExactly(outputFd, expected.length))
      assertParent(parent, parentIdentity)
      committed = true
    } finally {
      closeSync(outputFd)
    }
  } catch (error) {
    if (outputLinked && !committed)
      publicationFailure(
        error,
        outputNativeIdentity
          ? removeOwnUnverifiedOutput(path, fd, outputNativeIdentity)
          : { status: 'foreign' }
      )
    throw error
  } finally {
    const identity = fstatSync(fd)
    if (temporaryNativeIdentity)
      try {
        deleteIdentity(parent, temporary, identity, temporaryNativeIdentity)
      } catch {
        /* preserve for quarantine */
      }
    closeSync(fd)
  }
}
