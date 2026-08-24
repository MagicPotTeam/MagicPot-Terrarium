import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { DEFERRED_COMFY_PERSIST_MAX_BYTES } from '@shared/comfy/deferredImages'

const READ_CHUNK_BYTES = 1024 * 1024
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
const WINDOWS_UNC_PATTERN = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u

type BigIntFileStats = Awaited<ReturnType<FileHandle['stat']>> & {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export type ReadPersistedDeferredFileOptions = Readonly<{
  filePath: string
  expectedSizeBytes: number
  signal?: AbortSignal
  /** Test/integration override. Production callers should use the app user-data authority root. */
  authorizedRoot?: string
}>

const authorityError = (reason: string): Error =>
  new Error(`Persisted deferred file authority rejected the file: ${reason}`)

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return (
    Boolean(relative) &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

const assertPathText = (value: unknown, label: string): string => {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    !path.isAbsolute(value)
  ) {
    throw authorityError(`${label} must be an absolute path without control characters`)
  }
  return path.resolve(value)
}

const sameIdentity = (
  left: Pick<BigIntFileStats, 'dev' | 'ino'>,
  right: Pick<BigIntFileStats, 'dev' | 'ino'>
): boolean => left.dev === right.dev && left.ino === right.ino

const sameStableFileState = (left: BigIntFileStats, right: BigIntFileStats): boolean =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

const lstatBigInt = async (filePath: string): Promise<BigIntFileStats> =>
  (await lstat(filePath, { bigint: true })) as BigIntFileStats

const assertNoLinkedComponents = async (
  root: string,
  candidate: string
): Promise<BigIntFileStats> => {
  const rootStats = await lstatBigInt(root)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw authorityError('authority root must be a real directory')
  }

  const relative = path.relative(root, candidate)
  const components = relative.split(path.sep).filter(Boolean)
  let current = root
  let finalStats = rootStats
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index])
    finalStats = await lstatBigInt(current)
    if (finalStats.isSymbolicLink()) {
      throw authorityError('symbolic links and junctions are not allowed')
    }
    if (index < components.length - 1 && !finalStats.isDirectory()) {
      throw authorityError('an authority-path component is not a directory')
    }
  }
  return finalStats
}

const readExactly = async (
  handle: FileHandle,
  expectedSizeBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> => {
  const bytes = new Uint8Array(expectedSizeBytes)
  let offset = 0
  while (offset < bytes.byteLength) {
    throwIfAborted(signal)
    const length = Math.min(READ_CHUNK_BYTES, bytes.byteLength - offset)
    const { bytesRead } = await handle.read(bytes, offset, length, offset)
    if (bytesRead <= 0) throw authorityError('file ended before the expected byte length')
    offset += bytesRead
  }
  throwIfAborted(signal)
  return bytes
}

/**
 * Reads a renderer-persisted deferred file under the app-owned qapp-input-images directory.
 * Path authorization and all reads happen in main; callers must still perform content-specific
 * validation (for example image decoding) after this authority check.
 */
export async function readPersistedDeferredFile(
  options: ReadPersistedDeferredFileOptions
): Promise<Uint8Array> {
  const expectedSizeBytes = options.expectedSizeBytes
  if (
    !Number.isSafeInteger(expectedSizeBytes) ||
    expectedSizeBytes < 0 ||
    expectedSizeBytes > DEFERRED_COMFY_PERSIST_MAX_BYTES
  ) {
    throw authorityError('expected size is outside the allowed range')
  }
  throwIfAborted(options.signal)

  const root = assertPathText(
    options.authorizedRoot ?? path.join(app.getPath('userData'), 'qapp-input-images'),
    'authority root'
  )
  const candidate = assertPathText(options.filePath, 'file path')
  if (!WINDOWS_UNC_PATTERN.test(root) && WINDOWS_UNC_PATTERN.test(options.filePath)) {
    throw authorityError('network paths are not allowed')
  }
  if (!isWithinRoot(root, candidate)) {
    throw authorityError('file path is outside the authority root')
  }

  const rootRealPath = await realpath(root)
  const prePathStats = await assertNoLinkedComponents(root, candidate)
  if (!prePathStats.isFile()) throw authorityError('path is not a regular file')
  const candidateRealPath = await realpath(candidate)
  if (!isWithinRoot(rootRealPath, candidateRealPath)) {
    throw authorityError('resolved file path is outside the authority root')
  }

  let handle: FileHandle | undefined
  try {
    throwIfAborted(options.signal)
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const preReadStats = (await handle.stat({ bigint: true })) as BigIntFileStats
    if (!preReadStats.isFile()) throw authorityError('opened path is not a regular file')
    if (!sameIdentity(prePathStats, preReadStats)) {
      throw authorityError('file was replaced before it could be opened')
    }
    if (preReadStats.size !== BigInt(expectedSizeBytes)) {
      throw authorityError('actual file size does not match the expected size')
    }

    const bytes = await readExactly(handle, expectedSizeBytes, options.signal)
    const postReadStats = (await handle.stat({ bigint: true })) as BigIntFileStats
    if (!sameStableFileState(preReadStats, postReadStats)) {
      throw authorityError('file changed while it was being read')
    }
    if (
      postReadStats.size !== BigInt(expectedSizeBytes) ||
      bytes.byteLength !== expectedSizeBytes
    ) {
      throw authorityError('read byte length does not match the expected size')
    }

    const postPathStats = await assertNoLinkedComponents(root, candidate)
    if (!postPathStats.isFile() || !sameIdentity(postReadStats, postPathStats)) {
      throw authorityError('file was replaced while it was being read')
    }
    const postRealPath = await realpath(candidate)
    if (postRealPath !== candidateRealPath || !isWithinRoot(rootRealPath, postRealPath)) {
      throw authorityError('resolved file path changed while it was being read')
    }
    throwIfAborted(options.signal)
    return bytes
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
