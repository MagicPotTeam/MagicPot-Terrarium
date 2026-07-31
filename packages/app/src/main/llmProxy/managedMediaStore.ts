import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MEDIA_REFERENCE_VERSION,
  normalizeMediaReference,
  type MediaReference
} from '../../shared/mediaReference'

export const MANAGED_MEDIA_METADATA_VERSION = 1 as const
export const DEFAULT_MANAGED_MEDIA_MAX_BYTES = 25 * 1024 * 1024

const METADATA_SCHEMA = 'magicpot.managed-media/v1'
const MAX_METADATA_BYTES = 64 * 1024
const MAX_IMAGE_DIMENSION = 65_535
const MAX_JPEG_HEADER_BYTES = 1024 * 1024
const IO_CHUNK_BYTES = 64 * 1024
const MAX_STRUCTURAL_CHUNKS = 16_384
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

type SupportedMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
type FileHandle = Awaited<ReturnType<typeof fs.open>>

const extensions: Record<SupportedMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export type ManagedMediaProvenance = { source: string; [key: string]: unknown }
export type ManagedMediaMetadata = {
  schema: typeof METADATA_SCHEMA
  version: typeof MANAGED_MEDIA_METADATA_VERSION
  sha256: string
  sizeBytes: number
  mimeType: SupportedMimeType
  extension: string
  relativePath: string
}
export type ImportManagedMediaInput = {
  bytes: Uint8Array
  mimeType: string
  originalFileName: string
  provenance: ManagedMediaProvenance
  maxBytes?: number
  signal?: AbortSignal
}
type ImportManagedMediaCommon = Omit<ImportManagedMediaInput, 'bytes'> & { chatMediaRoot: string }
export type ImportManagedMediaFileInput = ImportManagedMediaCommon & { sourcePath: string }
export type ImportManagedMediaStreamInput = ImportManagedMediaCommon & {
  stream: AsyncIterable<Uint8Array | string> | NodeJS.ReadableStream
}
export type ImportedManagedMedia = {
  reference: MediaReference
  absolutePath: string
  localMediaUrl: string
  metadataPath: string
}
export type ResolvedManagedMedia = ImportedManagedMedia & {
  metadata: ManagedMediaMetadata
  /** Integrity was checked through an open no-follow handle immediately before this result. */
  integrityVerified: true
  verifiedAt: string
}
export type ManagedMediaStoreDependencies = {
  fs?: typeof fs
  now?: () => Date
  randomId?: () => string
  /** Existing canonical userData/.chat_media root authorized by the local-media protocol. */
  authorizedRoot: string
}
export type ManagedMediaResolutionErrorCode = 'MANAGED_MEDIA_MISSING' | 'MANAGED_MEDIA_CORRUPT'
export class ManagedMediaResolutionError extends Error {
  constructor(
    public readonly code: ManagedMediaResolutionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ManagedMediaResolutionError'
  }
}
export type ManagedMediaImportErrorCode =
  | 'MANAGED_MEDIA_ABORTED'
  | 'MANAGED_MEDIA_INVALID'
  | 'MANAGED_MEDIA_UNSUPPORTED'
  | 'MANAGED_MEDIA_TOO_LARGE'
  | 'MANAGED_MEDIA_IO'
export class ManagedMediaImportError extends Error {
  constructor(
    public readonly code: ManagedMediaImportErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = code === 'MANAGED_MEDIA_ABORTED' ? 'AbortError' : 'ManagedMediaImportError'
  }
}

function comparisonPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
export function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
function abortError(): Error {
  return new ManagedMediaImportError('MANAGED_MEDIA_ABORTED', 'Managed media import aborted')
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}
function sizeLimit(value?: number): number {
  const maxBytes = value ?? DEFAULT_MANAGED_MEDIA_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new ManagedMediaImportError('MANAGED_MEDIA_INVALID', 'Invalid managed media size limit')
  return maxBytes
}
function canonicalOriginalFileName(value: string): string {
  const normalized = String(value || '')
    .normalize('NFC')
    .trim()
  const stem = normalized.split('.')[0].toUpperCase()
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    Buffer.byteLength(normalized, 'utf8') > 255 ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    /[. ]$/u.test(normalized) ||
    /[<>:"|?*\p{Cc}]/u.test(normalized) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)
  )
    throw new Error('Invalid original media filename')
  return normalized
}
function normalizeMime(value: string): SupportedMimeType {
  const mime = String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (!(mime in extensions))
    throw new ManagedMediaImportError(
      'MANAGED_MEDIA_UNSUPPORTED',
      `Unsupported managed media MIME type: ${mime || '(empty)'}`
    )
  return mime as SupportedMimeType
}
function dimensionsAreSafe(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION
}
function serializeProvenance(value: ManagedMediaProvenance): ManagedMediaProvenance {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.source !== 'string' ||
    !value.source.trim()
  )
    throw new Error('Managed media provenance requires a source')
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error('Managed media provenance must be JSON serializable')
  }
  if (!serialized || Buffer.byteLength(serialized) > MAX_METADATA_BYTES / 2)
    throw new Error('Managed media provenance is too large')
  return JSON.parse(serialized) as ManagedMediaProvenance
}

async function canonicalAuthorizedRoot(root: string, fileSystem: typeof fs): Promise<string> {
  const resolved = path.resolve(root)
  try {
    const [stat, canonical] = await Promise.all([
      fileSystem.lstat(resolved),
      fileSystem.realpath(resolved)
    ])
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      comparisonPath(canonical) !== comparisonPath(resolved)
    )
      throw new Error()
    return canonical
  } catch {
    throw new Error('Authorized chat-media root must be an existing canonical directory')
  }
}
async function prepareContainedDirectory(
  canonicalRoot: string,
  directory: string,
  fileSystem: typeof fs
): Promise<void> {
  if (!isPathInsideRoot(canonicalRoot, directory))
    throw new Error('Managed media path escapes its root')
  let current = canonicalRoot
  for (const segment of path.relative(canonicalRoot, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      await fileSystem.mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const [stat, canonical] = await Promise.all([
      fileSystem.lstat(current),
      fileSystem.realpath(current)
    ])
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      comparisonPath(canonical) !== comparisonPath(current) ||
      !isPathInsideRoot(canonicalRoot, canonical)
    )
      throw new Error('Managed media directory is not safely contained by its root')
  }
}
async function prepareStoreRoot(
  root: string,
  authorizedRoot: string,
  fileSystem: typeof fs
): Promise<string> {
  const resolved = path.resolve(root)
  if (!isPathInsideRoot(authorizedRoot, resolved))
    throw new Error('Managed media root is not authorized')
  await prepareContainedDirectory(authorizedRoot, resolved, fileSystem)
  return fileSystem.realpath(resolved)
}
async function existingStoreRoot(
  root: string,
  authorizedRoot: string,
  fileSystem: typeof fs
): Promise<string> {
  const resolved = path.resolve(root)
  if (!isPathInsideRoot(authorizedRoot, resolved))
    throw new ManagedMediaResolutionError(
      'MANAGED_MEDIA_CORRUPT',
      'Managed media root is not authorized'
    )
  try {
    const [stat, canonical] = await Promise.all([
      fileSystem.lstat(resolved),
      fileSystem.realpath(resolved)
    ])
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      comparisonPath(canonical) !== comparisonPath(resolved) ||
      !isPathInsideRoot(authorizedRoot, canonical)
    )
      throw new Error()
    return canonical
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ManagedMediaResolutionError(
        'MANAGED_MEDIA_MISSING',
        'Managed media store is missing',
        {
          cause: error
        }
      )
    throw new ManagedMediaResolutionError(
      'MANAGED_MEDIA_CORRUPT',
      'Managed media store is unsafe',
      {
        cause: error
      }
    )
  }
}
async function validateExistingPath(
  canonicalRoot: string,
  target: string,
  finalKind: 'directory' | 'file',
  fileSystem: typeof fs
): Promise<void> {
  if (!isPathInsideRoot(canonicalRoot, target)) throw new Error('Managed media path escapes root')
  let current = canonicalRoot
  const segments = path.relative(canonicalRoot, target).split(path.sep).filter(Boolean)
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    const [stat, canonical] = await Promise.all([
      fileSystem.lstat(current),
      fileSystem.realpath(current)
    ])
    const isFinal = index === segments.length - 1
    if (
      stat.isSymbolicLink() ||
      comparisonPath(canonical) !== comparisonPath(current) ||
      !isPathInsideRoot(canonicalRoot, canonical) ||
      (isFinal
        ? finalKind === 'file'
          ? !stat.isFile()
          : !stat.isDirectory()
        : !stat.isDirectory())
    )
      throw new Error('Managed media path is not safely contained')
  }
}

async function revalidateParent(
  canonicalRoot: string,
  destination: string,
  fileSystem: typeof fs
): Promise<void> {
  const parent = path.dirname(destination)
  const [stat, canonical] = await Promise.all([
    fileSystem.lstat(parent),
    fileSystem.realpath(parent)
  ])
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    comparisonPath(parent) !== comparisonPath(canonical) ||
    !isPathInsideRoot(canonicalRoot, canonical)
  )
    throw new Error('Managed media publication parent changed')
}
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}
async function hashHandle(handle: FileHandle, expectedSize: number): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, Math.max(1, expectedSize)))
  let position = 0
  while (position < expectedSize) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, expectedSize - position),
      position
    )
    if (!bytesRead) throw new Error('Managed media file changed while reading')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}
async function readRegularFile(
  filePath: string,
  maxBytes: number,
  fileSystem: typeof fs
): Promise<Buffer> {
  const before = await fileSystem.lstat(filePath)
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes)
    throw new Error('Managed media destination conflicts with existing content')
  const handle = await fileSystem.open(filePath, fsConstants.O_RDONLY | NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== before.size)
      throw new Error('Managed media destination changed while reading')
    return await readAt(handle, 0, opened.size)
  } finally {
    await handle.close()
  }
}

async function validatePng(handle: FileHandle, size: number): Promise<boolean> {
  if (size < 45) return false
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!(await readAt(handle, 0, 8)).equals(signature)) return false
  let offset = 8
  let sawIhdr = false
  let chunks = 0
  while (offset + 12 <= size && chunks++ < MAX_STRUCTURAL_CHUNKS) {
    const header = await readAt(handle, offset, 12)
    if (header.length !== 12) return false
    const length = header.readUInt32BE(0)
    if (length > size - offset - 12) return false
    const type = header.subarray(4, 8).toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) return false
    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13) return false
      const ihdr = await readAt(handle, offset + 8, 13)
      if (ihdr.length !== 13) return false
      const colorType = ihdr[9]
      const bitDepth = ihdr[8]
      const validDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        ([4, 6].includes(colorType) && [8, 16].includes(bitDepth))
      sawIhdr =
        dimensionsAreSafe(ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)) &&
        validDepth &&
        ihdr[10] === 0 &&
        ihdr[11] === 0 &&
        ihdr[12] <= 1
    }
    offset += 12 + length
    if (type === 'IEND') return sawIhdr && length === 0 && offset === size
  }
  return false
}
async function validateJpeg(handle: FileHandle, size: number): Promise<boolean> {
  if (size < 6) return false
  const ends = Buffer.concat([await readAt(handle, 0, 2), await readAt(handle, size - 2, 2)])
  if (!ends.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))) return false
  let offset = 2
  let dimensions = false
  while (offset < size - 2 && offset <= MAX_JPEG_HEADER_BYTES) {
    const prefix = await readAt(handle, offset, 4)
    if (prefix.length < 2 || prefix[0] !== 0xff) return false
    let markerIndex = 1
    while (markerIndex < prefix.length && prefix[markerIndex] === 0xff) markerIndex += 1
    if (markerIndex >= prefix.length) {
      offset += prefix.length - 1
      continue
    }
    const marker = prefix[markerIndex]
    offset += markerIndex + 1
    if (marker === 0xd9) return dimensions
    if (marker === 0xda) return dimensions
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const lengthBytes = await readAt(handle, offset, 2)
    if (lengthBytes.length !== 2) return false
    const length = lengthBytes.readUInt16BE(0)
    if (length < 2 || offset + length > size || offset + length > MAX_JPEG_HEADER_BYTES)
      return false
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker
      )
    ) {
      if (length < 7) return false
      const frame = await readAt(handle, offset + 3, 4)
      if (frame.length !== 4) return false
      dimensions = dimensionsAreSafe(frame.readUInt16BE(0), frame.readUInt16BE(2))
    }
    offset += length
  }
  return false
}
async function validateGif(handle: FileHandle, size: number): Promise<boolean> {
  if (size < 14) return false
  const header = await readAt(handle, 0, 13)
  const magic = header.subarray(0, 6).toString('ascii')
  if (
    !['GIF87a', 'GIF89a'].includes(magic) ||
    !dimensionsAreSafe(header.readUInt16LE(6), header.readUInt16LE(8))
  )
    return false
  let offset = 13
  if (header[10] & 0x80) offset += 3 * 2 ** ((header[10] & 0x07) + 1)
  let blocks = 0
  while (offset < size && blocks++ < MAX_STRUCTURAL_CHUNKS) {
    const marker = (await readAt(handle, offset++, 1))[0]
    if (marker === 0x3b) return offset === size
    if (marker === 0x2c) {
      const descriptor = await readAt(handle, offset, 9)
      if (
        descriptor.length !== 9 ||
        !dimensionsAreSafe(descriptor.readUInt16LE(4), descriptor.readUInt16LE(6))
      )
        return false
      offset += 9
      if (descriptor[8] & 0x80) offset += 3 * 2 ** ((descriptor[8] & 0x07) + 1)
      if (offset >= size) return false
      offset += 1
    } else if (marker === 0x21) {
      if (offset >= size) return false
      offset += 1
    } else return false
    for (;;) {
      if (offset >= size || blocks++ >= MAX_STRUCTURAL_CHUNKS) return false
      const blockSize = (await readAt(handle, offset++, 1))[0]
      if (!blockSize) break
      if (offset + blockSize > size) return false
      offset += blockSize
    }
  }
  return false
}
async function validateWebp(handle: FileHandle, size: number): Promise<boolean> {
  if (size < 30) return false
  const bytes = await readAt(handle, 0, 30)
  if (
    bytes.length !== 30 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WEBP' ||
    bytes.readUInt32LE(4) + 8 !== size
  )
    return false
  const kind = bytes.subarray(12, 16).toString('ascii')
  const chunkSize = bytes.readUInt32LE(16)
  if (20 + chunkSize > size) return false
  if (kind === 'VP8X' && chunkSize >= 10)
    return dimensionsAreSafe(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3))
  if (kind === 'VP8L' && chunkSize >= 5 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21)
    return dimensionsAreSafe((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  return (
    kind === 'VP8 ' &&
    chunkSize >= 10 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a &&
    dimensionsAreSafe(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
  )
}
async function validateImageFile(
  filePath: string,
  size: number,
  mime: SupportedMimeType,
  fileSystem: typeof fs
): Promise<void> {
  const handle = await fileSystem.open(filePath, fsConstants.O_RDONLY | NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== size) throw new Error('Managed media staging file changed')
    const valid = await (
      {
        'image/png': validatePng,
        'image/jpeg': validateJpeg,
        'image/gif': validateGif,
        'image/webp': validateWebp
      } as const
    )[mime](handle, size)
    if (!valid)
      throw new ManagedMediaImportError(
        'MANAGED_MEDIA_INVALID',
        `Managed media bytes do not match ${mime} or are structurally invalid`
      )
  } finally {
    await handle.close()
  }
}

function unsupportedLink(error: unknown): boolean {
  return ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(
    (error as NodeJS.ErrnoException).code ?? ''
  )
}
async function copyHandle(
  source: FileHandle,
  destination: FileHandle,
  size: number
): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, size))
  let position = 0
  while (position < size) {
    const { bytesRead } = await source.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position
    )
    if (!bytesRead) throw new Error('Managed media staging file changed')
    let written = 0
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written)
      if (!result.bytesWritten) throw new Error('Managed media write made no progress')
      written += result.bytesWritten
    }
    position += bytesRead
  }
}
async function publishStagedNoClobber(
  canonicalRoot: string,
  destination: string,
  stagedPath: string,
  size: number,
  fileSystem: typeof fs
): Promise<'created' | 'exists'> {
  await revalidateParent(canonicalRoot, destination, fileSystem)
  let created = false
  try {
    try {
      await fileSystem.link(stagedPath, destination)
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
      if (!unsupportedLink(error)) throw error
      let destinationHandle: FileHandle | undefined
      let sourceHandle: FileHandle | undefined
      try {
        destinationHandle = await fileSystem.open(
          destination,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
          0o600
        )
        created = true
        sourceHandle = await fileSystem.open(stagedPath, fsConstants.O_RDONLY | NOFOLLOW)
        await copyHandle(sourceHandle, destinationHandle, size)
        await destinationHandle.sync()
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
        throw fallbackError
      } finally {
        await sourceHandle?.close().catch(() => undefined)
        await destinationHandle?.close().catch(() => undefined)
      }
    }
    await revalidateParent(canonicalRoot, destination, fileSystem)
    const target = await fileSystem.lstat(destination)
    if (target.isSymbolicLink() || !target.isFile() || target.size !== size)
      throw new Error('Managed media publication target is unsafe')
    return 'created'
  } catch (error) {
    if (created) await fileSystem.unlink(destination).catch(() => undefined)
    throw error
  }
}
async function publishBytesNoClobber(
  canonicalRoot: string,
  destination: string,
  bytes: Buffer,
  fileSystem: typeof fs,
  randomId: () => string
): Promise<'created' | 'exists'> {
  const temporaryPath = path.join(path.dirname(destination), `.managed-media-${randomId()}.tmp`)
  let handle: FileHandle | undefined
  try {
    handle = await fileSystem.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      0o600
    )
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    return await publishStagedNoClobber(
      canonicalRoot,
      destination,
      temporaryPath,
      bytes.length,
      fileSystem
    )
  } finally {
    await handle?.close().catch(() => undefined)
    await fileSystem.unlink(temporaryPath).catch(() => undefined)
  }
}
function metadataIsConsistent(
  value: unknown,
  expected: ManagedMediaMetadata
): value is ManagedMediaMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const metadata = value as Record<string, unknown>
  return (
    metadata.schema === expected.schema &&
    metadata.version === expected.version &&
    metadata.sha256 === expected.sha256 &&
    metadata.sizeBytes === expected.sizeBytes &&
    metadata.mimeType === expected.mimeType &&
    metadata.extension === expected.extension &&
    metadata.relativePath === expected.relativePath
  )
}
function metadataMatchesReference(
  value: unknown,
  reference: MediaReference
): value is ManagedMediaMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const metadata = value as Record<string, unknown>
  const expectedExtension = extensions[reference.mimeType as SupportedMimeType]
  return (
    metadata.schema === METADATA_SCHEMA &&
    metadata.version === MANAGED_MEDIA_METADATA_VERSION &&
    metadata.sha256 === reference.sha256 &&
    metadata.sizeBytes === reference.sizeBytes &&
    metadata.mimeType === reference.mimeType &&
    metadata.extension === expectedExtension &&
    metadata.relativePath === reference.relativePath
  )
}
function localUrl(absolutePath: string): string {
  const fileUrl = pathToFileURL(absolutePath).toString()
  return `local-media://${fileUrl.slice('file://'.length)}`
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal
): Promise<IteratorResult<T>> {
  if (!signal) return iterator.next()
  throwIfAborted(signal)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function stageIterable(
  canonicalRoot: string,
  iterable: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
  signal: AbortSignal | undefined,
  fileSystem: typeof fs,
  randomId: () => string
): Promise<{ stagedPath: string; size: number; sha256: string }> {
  const stagingDirectory = path.join(canonicalRoot, '.staging')
  await prepareContainedDirectory(canonicalRoot, stagingDirectory, fileSystem)
  const stagedPath = path.join(stagingDirectory, `${randomId()}.tmp`)
  let handle: FileHandle | undefined
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    handle = await fileSystem.open(
      stagedPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      0o600
    )
    const hash = createHash('sha256')
    let size = 0
    let chunkCount = 0
    for (;;) {
      const result = await nextWithAbort(iterator, signal)
      if (result.done) break
      if (++chunkCount > MAX_STRUCTURAL_CHUNKS)
        throw new ManagedMediaImportError(
          'MANAGED_MEDIA_INVALID',
          'Managed media stream contains too many chunks'
        )
      const byteLength =
        typeof result.value === 'string' ? Buffer.byteLength(result.value) : result.value.byteLength
      if (!byteLength) continue
      if (byteLength > maxBytes - size)
        throw new ManagedMediaImportError(
          'MANAGED_MEDIA_TOO_LARGE',
          `Managed media exceeds the ${maxBytes} byte limit`
        )
      const chunk =
        typeof result.value === 'string'
          ? Buffer.from(result.value)
          : Buffer.from(result.value.buffer, result.value.byteOffset, result.value.byteLength)
      let written = 0
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written)
        if (!result.bytesWritten) throw new Error('Managed media write made no progress')
        written += result.bytesWritten
      }
      hash.update(chunk)
      size += chunk.length
    }
    throwIfAborted(signal)
    if (!size)
      throw new ManagedMediaImportError('MANAGED_MEDIA_INVALID', 'Managed media cannot be empty')
    await handle.sync()
    await handle.close()
    handle = undefined
    return { stagedPath, size, sha256: hash.digest('hex') }
  } catch (error) {
    const destroy = (iterable as { destroy?: (error?: Error) => void }).destroy
    if (typeof destroy === 'function')
      destroy.call(iterable, error instanceof Error ? error : undefined)
    await iterator.return?.().catch(() => undefined)
    await handle?.close().catch(() => undefined)
    await fileSystem.unlink(stagedPath).catch(() => undefined)
    throw error
  }
}
async function publishImport(
  canonicalRoot: string,
  staged: { stagedPath: string; size: number; sha256: string },
  input: Omit<ImportManagedMediaInput, 'bytes'>,
  dependencies: ManagedMediaStoreDependencies
): Promise<ImportedManagedMedia> {
  const fileSystem = dependencies.fs ?? fs
  const randomId = dependencies.randomId ?? randomUUID
  const mimeType = normalizeMime(input.mimeType)
  const originalFileName = canonicalOriginalFileName(input.originalFileName)
  serializeProvenance(input.provenance)
  await validateImageFile(staged.stagedPath, staged.size, mimeType, fileSystem)
  const extension = extensions[mimeType]
  const relativePath = `originals/${staged.sha256.slice(0, 2)}/${staged.sha256}.${extension}`
  const originalsDirectory = path.join(canonicalRoot, 'originals', staged.sha256.slice(0, 2))
  const metadataDirectory = path.join(canonicalRoot, 'metadata')
  await prepareContainedDirectory(canonicalRoot, originalsDirectory, fileSystem)
  await prepareContainedDirectory(canonicalRoot, metadataDirectory, fileSystem)
  const absolutePath = path.join(canonicalRoot, ...relativePath.split('/'))
  const metadataPath = path.join(metadataDirectory, `${staged.sha256}.json`)
  const originalPublication = await publishStagedNoClobber(
    canonicalRoot,
    absolutePath,
    staged.stagedPath,
    staged.size,
    fileSystem
  )
  let metadataCreated = false
  try {
    const originalHandle = await fileSystem.open(absolutePath, fsConstants.O_RDONLY | NOFOLLOW)
    try {
      const stat = await originalHandle.stat()
      if (
        !stat.isFile() ||
        stat.size !== staged.size ||
        (await hashHandle(originalHandle, staged.size)) !== staged.sha256
      )
        throw new Error('Managed media destination conflicts with existing content')
    } finally {
      await originalHandle.close()
    }
    const metadata: ManagedMediaMetadata = {
      schema: METADATA_SCHEMA,
      version: MANAGED_MEDIA_METADATA_VERSION,
      sha256: staged.sha256,
      sizeBytes: staged.size,
      mimeType,
      extension,
      relativePath
    }
    const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)
    if (metadataBytes.length > MAX_METADATA_BYTES)
      throw new Error('Managed media metadata is too large')
    const metadataPublication = await publishBytesNoClobber(
      canonicalRoot,
      metadataPath,
      metadataBytes,
      fileSystem,
      randomId
    )
    metadataCreated = metadataPublication === 'created'
    if (metadataPublication === 'exists') {
      let valid = false
      try {
        valid = metadataIsConsistent(
          JSON.parse(
            (await readRegularFile(metadataPath, MAX_METADATA_BYTES, fileSystem)).toString()
          ),
          metadata
        )
      } catch {
        valid = false
      }
      if (!valid) throw new Error('Managed media metadata conflicts with existing content')
    }
    const stored = JSON.parse(
      (await readRegularFile(metadataPath, MAX_METADATA_BYTES, fileSystem)).toString()
    ) as unknown
    if (!metadataIsConsistent(stored, metadata))
      throw new Error('Managed media metadata conflicts with existing content')
    const reference = normalizeMediaReference({
      version: MEDIA_REFERENCE_VERSION,
      kind: 'managed',
      relativePath,
      sha256: staged.sha256,
      sizeBytes: staged.size,
      mimeType,
      originalFileName
    })
    if (!reference) throw new Error('Failed to construct managed media reference')
    return { reference, absolutePath, localMediaUrl: localUrl(absolutePath), metadataPath }
  } catch (error) {
    if (originalPublication === 'created')
      await fileSystem.unlink(absolutePath).catch(() => undefined)
    if (metadataCreated) await fileSystem.unlink(metadataPath).catch(() => undefined)
    throw error
  }
}

export async function importManagedMediaStream(
  input: ImportManagedMediaStreamInput,
  dependencies: ManagedMediaStoreDependencies
): Promise<ImportedManagedMedia> {
  const fileSystem = dependencies.fs ?? fs
  const randomId = dependencies.randomId ?? randomUUID
  const authorizedRoot = await canonicalAuthorizedRoot(dependencies.authorizedRoot, fileSystem)
  const canonicalRoot = await prepareStoreRoot(input.chatMediaRoot, authorizedRoot, fileSystem)
  throwIfAborted(input.signal)
  const iterable = input.stream as AsyncIterable<Uint8Array | string>
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function')
    throw new Error('Managed media stream must be async iterable')
  const staged = await stageIterable(
    canonicalRoot,
    iterable,
    sizeLimit(input.maxBytes),
    input.signal,
    fileSystem,
    randomId
  )
  try {
    return await publishImport(canonicalRoot, staged, input, dependencies)
  } finally {
    await fileSystem.unlink(staged.stagedPath).catch(() => undefined)
  }
}

export async function importManagedMediaFile(
  input: ImportManagedMediaFileInput,
  dependencies: ManagedMediaStoreDependencies
): Promise<ImportedManagedMedia> {
  const fileSystem = dependencies.fs ?? fs
  const randomId = dependencies.randomId ?? randomUUID
  const authorizedRoot = await canonicalAuthorizedRoot(dependencies.authorizedRoot, fileSystem)
  const canonicalRoot = await prepareStoreRoot(input.chatMediaRoot, authorizedRoot, fileSystem)
  throwIfAborted(input.signal)
  const resolvedSource = path.resolve(input.sourcePath)
  const sourceLstat = await fileSystem.lstat(resolvedSource)
  if (sourceLstat.isSymbolicLink() || !sourceLstat.isFile())
    throw new Error('Managed media source must be a regular non-symlink file')
  const canonicalSource = await fileSystem.realpath(resolvedSource)
  if (comparisonPath(canonicalSource) !== comparisonPath(resolvedSource))
    throw new Error('Managed media source must be canonical')
  if (isPathInsideRoot(canonicalRoot, canonicalSource))
    throw new Error('Managed media source cannot be a managed target or temporary file')
  const maxBytes = sizeLimit(input.maxBytes)
  if (!sourceLstat.size) throw new Error('Managed media cannot be empty')
  if (sourceLstat.size > maxBytes)
    throw new Error(`Managed media exceeds the ${maxBytes} byte limit`)
  const sourceHandle = await fileSystem.open(resolvedSource, fsConstants.O_RDONLY | NOFOLLOW)
  let staged: { stagedPath: string; size: number; sha256: string } | undefined
  try {
    const opened = await sourceHandle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== sourceLstat.dev ||
      opened.ino !== sourceLstat.ino ||
      opened.size !== sourceLstat.size ||
      opened.mtimeMs !== sourceLstat.mtimeMs
    )
      throw new Error('Managed media source changed before import')
    async function* chunks(): AsyncGenerator<Buffer> {
      const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, opened.size))
      let position = 0
      while (position < opened.size) {
        throwIfAborted(input.signal)
        const { bytesRead } = await sourceHandle.read(
          buffer,
          0,
          Math.min(buffer.length, opened.size - position),
          position
        )
        if (!bytesRead) throw new Error('Managed media source changed during import')
        position += bytesRead
        yield Buffer.from(buffer.subarray(0, bytesRead))
      }
    }
    staged = await stageIterable(
      canonicalRoot,
      chunks(),
      maxBytes,
      input.signal,
      fileSystem,
      randomId
    )
    const after = await sourceHandle.stat()
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error('Managed media source changed during import')
    return await publishImport(canonicalRoot, staged, input, dependencies)
  } finally {
    await sourceHandle.close().catch(() => undefined)
    if (staged) await fileSystem.unlink(staged.stagedPath).catch(() => undefined)
  }
}

/** Compatibility wrapper. New main-owned callers should prefer file or stream import. */
export async function importManagedMedia(
  root: string,
  input: ImportManagedMediaInput,
  dependencies: ManagedMediaStoreDependencies
): Promise<ImportedManagedMedia> {
  const maxBytes = sizeLimit(input.maxBytes)
  if (input.bytes.byteLength > maxBytes)
    throw new ManagedMediaImportError(
      'MANAGED_MEDIA_TOO_LARGE',
      `Managed media exceeds the ${maxBytes} byte limit`
    )
  const bytes = Buffer.isBuffer(input.bytes)
    ? input.bytes
    : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
  return importManagedMediaStream(
    {
      chatMediaRoot: root,
      stream: (async function* () {
        yield bytes
      })(),
      mimeType: input.mimeType,
      originalFileName: input.originalFileName,
      provenance: input.provenance,
      maxBytes: input.maxBytes,
      signal: input.signal
    },
    dependencies
  )
}

export async function resolveManagedMediaReference(
  chatMediaRoot: string,
  value: unknown,
  dependencies: Pick<ManagedMediaStoreDependencies, 'authorizedRoot' | 'fs'>
): Promise<ResolvedManagedMedia> {
  const fileSystem = dependencies.fs ?? fs
  const reference = normalizeMediaReference(value)
  if (!reference || reference.kind !== 'managed')
    throw new ManagedMediaResolutionError(
      'MANAGED_MEDIA_CORRUPT',
      'Invalid managed media reference'
    )
  let mimeType: SupportedMimeType
  try {
    mimeType = normalizeMime(reference.mimeType ?? '')
  } catch (error) {
    throw new ManagedMediaResolutionError(
      'MANAGED_MEDIA_CORRUPT',
      'Unsupported managed media reference type',
      { cause: error }
    )
  }
  const expectedPath = `originals/${reference.sha256?.slice(0, 2)}/${reference.sha256}.${extensions[mimeType]}`
  if (reference.relativePath !== expectedPath)
    throw new ManagedMediaResolutionError(
      'MANAGED_MEDIA_CORRUPT',
      'Forged managed media reference path'
    )
  let canonicalRoot: string
  try {
    const authorizedRoot = await canonicalAuthorizedRoot(dependencies.authorizedRoot, fileSystem)
    canonicalRoot = await existingStoreRoot(chatMediaRoot, authorizedRoot, fileSystem)
  } catch (error) {
    if (error instanceof ManagedMediaResolutionError) throw error
    throw new ManagedMediaResolutionError(
      'MANAGED_MEDIA_CORRUPT',
      'Managed media root is invalid',
      {
        cause: error
      }
    )
  }
  const absolutePath = path.join(canonicalRoot, ...reference.relativePath.split('/'))
  const metadataPath = path.join(canonicalRoot, 'metadata', `${reference.sha256}.json`)
  if (
    !isPathInsideRoot(canonicalRoot, absolutePath) ||
    !isPathInsideRoot(canonicalRoot, metadataPath)
  )
    throw new ManagedMediaResolutionError(
      'MANAGED_MEDIA_CORRUPT',
      'Managed media reference escapes root'
    )
  try {
    await validateExistingPath(
      canonicalRoot,
      path.join(canonicalRoot, 'metadata'),
      'directory',
      fileSystem
    )
    await validateExistingPath(
      canonicalRoot,
      path.join(canonicalRoot, 'originals'),
      'directory',
      fileSystem
    )
    await validateExistingPath(canonicalRoot, metadataPath, 'file', fileSystem)
    await validateExistingPath(canonicalRoot, absolutePath, 'file', fileSystem)
    const metadataBytes = await readRegularFile(metadataPath, MAX_METADATA_BYTES, fileSystem)
    const metadata = JSON.parse(metadataBytes.toString()) as unknown
    if (!metadataMatchesReference(metadata, reference))
      throw new ManagedMediaResolutionError(
        'MANAGED_MEDIA_CORRUPT',
        'Managed media metadata does not match reference'
      )
    const before = await fileSystem.lstat(absolutePath)
    if (before.isSymbolicLink() || !before.isFile() || before.size !== reference.sizeBytes)
      throw new ManagedMediaResolutionError(
        'MANAGED_MEDIA_CORRUPT',
        'Managed media original is unsafe'
      )
    const handle = await fileSystem.open(absolutePath, fsConstants.O_RDONLY | NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== reference.sizeBytes ||
        (await hashHandle(handle, opened.size)) !== reference.sha256
      )
        throw new ManagedMediaResolutionError(
          'MANAGED_MEDIA_CORRUPT',
          'Managed media original failed integrity validation'
        )
    } finally {
      await handle.close()
    }
    // Consumers must use this result immediately. Reopening absolutePath/localMediaUrl later has a
    // residual rename race because Node lacks portable directory-relative open APIs.
    return {
      reference,
      absolutePath,
      localMediaUrl: localUrl(absolutePath),
      metadataPath,
      metadata: metadata as ManagedMediaMetadata,
      integrityVerified: true,
      verifiedAt: new Date().toISOString()
    }
  } catch (error) {
    if (error instanceof ManagedMediaResolutionError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ManagedMediaResolutionError('MANAGED_MEDIA_MISSING', 'Managed media is missing', {
        cause: error
      })
    throw new ManagedMediaResolutionError('MANAGED_MEDIA_CORRUPT', 'Managed media is corrupt', {
      cause: error
    })
  }
}
