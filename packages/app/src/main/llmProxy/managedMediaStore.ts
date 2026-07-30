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
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

type SupportedMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

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
  originalFileName: string
  relativePath: string
  provenance: ManagedMediaProvenance
  createdAt: string
}
export type ImportManagedMediaInput = {
  bytes: Uint8Array
  mimeType: string
  originalFileName: string
  provenance: ManagedMediaProvenance
  maxBytes?: number
}
export type ImportedManagedMedia = {
  reference: MediaReference
  absolutePath: string
  localMediaUrl: string
  metadataPath: string
}
export type ManagedMediaStoreDependencies = {
  fs?: typeof fs
  now?: () => Date
  randomId?: () => string
  /** Existing canonical userData/.chat_media root authorized by the local-media protocol. */
  authorizedRoot: string
}

function comparisonPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
export function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function canonicalOriginalFileName(value: string): string {
  const raw = String(value || '')
    .normalize('NFC')
    .trim()
  if (/[. ]$/u.test(raw)) throw new Error('Invalid original media filename')
  const normalized = raw
  const stem = normalized.split('.')[0].toUpperCase()
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    Buffer.byteLength(normalized, 'utf8') > 255 ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    /[<>:"|?*\p{Cc}]/u.test(normalized) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)
  ) {
    throw new Error('Invalid original media filename')
  }
  return normalized
}

function normalizeMime(value: string): SupportedMimeType {
  const mime = String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (!(mime in extensions))
    throw new Error(`Unsupported managed media MIME type: ${mime || '(empty)'}`)
  return mime as SupportedMimeType
}
function dimensionsAreSafe(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION
}
function validatePng(bytes: Buffer): boolean {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) return false
  let offset = 8
  let sawIhdr = false
  let sawIend = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (length > bytes.length - offset - 12) return false
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13) return false
      sawIhdr = dimensionsAreSafe(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12))
    }
    offset += 12 + length
    if (type === 'IEND') {
      sawIend = length === 0 && offset === bytes.length
      break
    }
  }
  return sawIhdr && sawIend
}
function validateJpeg(bytes: Buffer): boolean {
  if (
    bytes.length < 6 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  )
    return false
  let offset = 2
  let dimensions = false
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset++]
    if (marker === 0xd9) break
    if (marker === 0xda) return dimensions
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return false
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return false
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker
      )
    ) {
      if (length < 7) return false
      dimensions = dimensionsAreSafe(bytes.readUInt16BE(offset + 3), bytes.readUInt16BE(offset + 5))
    }
    offset += length
  }
  return dimensions
}
function validateGif(bytes: Buffer): boolean {
  const header = bytes.subarray(0, 6).toString('ascii')
  return (
    bytes.length >= 14 &&
    (header === 'GIF87a' || header === 'GIF89a') &&
    dimensionsAreSafe(bytes.readUInt16LE(6), bytes.readUInt16LE(8)) &&
    bytes.at(-1) === 0x3b
  )
}
function validateWebp(bytes: Buffer): boolean {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WEBP' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return false
  const kind = bytes.subarray(12, 16).toString('ascii')
  const chunkSize = bytes.readUInt32LE(16)
  if (20 + chunkSize > bytes.length) return false
  if (kind === 'VP8X' && chunkSize >= 10) {
    return dimensionsAreSafe(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3))
  }
  if (kind === 'VP8L' && chunkSize >= 5 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21)
    return dimensionsAreSafe((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (
    kind === 'VP8 ' &&
    chunkSize >= 10 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return dimensionsAreSafe(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
  }
  return false
}
function validateImage(bytes: Buffer, mime: SupportedMimeType): boolean {
  return (
    {
      'image/png': validatePng,
      'image/jpeg': validateJpeg,
      'image/gif': validateGif,
      'image/webp': validateWebp
    } as const
  )[mime](bytes)
}

function serializeProvenance(value: ManagedMediaProvenance): ManagedMediaProvenance {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.source !== 'string' ||
    !value.source.trim()
  ) {
    throw new Error('Managed media provenance requires a source')
  }
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
  let stat: Awaited<ReturnType<typeof fileSystem.lstat>>
  let canonical: string
  try {
    stat = await fileSystem.lstat(resolved)
    canonical = await fileSystem.realpath(resolved)
  } catch {
    throw new Error('Authorized chat-media root must be an existing canonical directory')
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    comparisonPath(canonical) !== comparisonPath(resolved)
  ) {
    throw new Error('Authorized chat-media root must be an existing canonical directory')
  }
  return canonical
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
    const stat = await fileSystem.lstat(current)
    const canonical = await fileSystem.realpath(current)
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      comparisonPath(canonical) !== comparisonPath(current) ||
      !isPathInsideRoot(canonicalRoot, canonical)
    ) {
      throw new Error('Managed media directory is not safely contained by its root')
    }
  }
}
async function revalidateParent(
  canonicalRoot: string,
  destination: string,
  fileSystem: typeof fs
): Promise<void> {
  const parent = path.dirname(destination)
  const stat = await fileSystem.lstat(parent)
  const canonical = await fileSystem.realpath(parent)
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    comparisonPath(parent) !== comparisonPath(canonical) ||
    !isPathInsideRoot(canonicalRoot, canonical)
  ) {
    throw new Error('Managed media publication parent changed')
  }
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
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}
async function verifyOriginal(
  destination: string,
  bytes: Buffer,
  sha256: string,
  fileSystem: typeof fs
): Promise<void> {
  const existing = await readRegularFile(destination, bytes.length, fileSystem)
  if (
    existing.length !== bytes.length ||
    createHash('sha256').update(existing).digest('hex') !== sha256
  ) {
    throw new Error('Managed media destination conflicts with existing content')
  }
}
function unsupportedLink(error: unknown): boolean {
  return ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(
    (error as NodeJS.ErrnoException).code ?? ''
  )
}
async function publishNoClobber(
  canonicalRoot: string,
  destination: string,
  bytes: Buffer,
  fileSystem: typeof fs,
  randomId: () => string
): Promise<'created' | 'exists'> {
  const temporaryPath = path.join(path.dirname(destination), `.managed-media-${randomId()}.tmp`)
  let temporary: Awaited<ReturnType<typeof fileSystem.open>> | undefined
  let fallbackCreated = false
  try {
    await revalidateParent(canonicalRoot, destination, fileSystem)
    temporary = await fileSystem.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      0o600
    )
    await temporary.writeFile(bytes)
    await temporary.sync()
    await temporary.close()
    temporary = undefined
    await revalidateParent(canonicalRoot, destination, fileSystem)
    try {
      await fileSystem.link(temporaryPath, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
      if (!unsupportedLink(error)) throw error
      let destinationHandle: Awaited<ReturnType<typeof fileSystem.open>> | undefined
      try {
        destinationHandle = await fileSystem.open(
          destination,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
          0o600
        )
        fallbackCreated = true
        await destinationHandle.writeFile(bytes)
        await destinationHandle.sync()
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
        throw fallbackError
      } finally {
        await destinationHandle?.close().catch(() => undefined)
      }
    }
    await revalidateParent(canonicalRoot, destination, fileSystem)
    const target = await fileSystem.lstat(destination)
    if (target.isSymbolicLink() || !target.isFile())
      throw new Error('Managed media publication target is unsafe')
    return 'created'
  } catch (error) {
    if (fallbackCreated) await fileSystem.unlink(destination).catch(() => undefined)
    throw error
  } finally {
    await temporary?.close().catch(() => undefined)
    await fileSystem.unlink(temporaryPath).catch(() => undefined)
  }
  // A hostile process with write access can still rename a validated parent between syscalls;
  // Node does not expose portable directory-relative open/rename APIs to close that residual race.
}
async function replaceMetadata(
  canonicalRoot: string,
  destination: string,
  bytes: Buffer,
  fileSystem: typeof fs,
  randomId: () => string
): Promise<void> {
  const replacement = `${destination}.${randomId()}.replacement`
  try {
    const created = await publishNoClobber(canonicalRoot, replacement, bytes, fileSystem, randomId)
    if (created !== 'created') throw new Error('Managed media metadata replacement conflict')
    await revalidateParent(canonicalRoot, destination, fileSystem)
    await fileSystem.rename(replacement, destination)
    await revalidateParent(canonicalRoot, destination, fileSystem)
  } finally {
    await fileSystem.unlink(replacement).catch(() => undefined)
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
    metadata.originalFileName === expected.originalFileName &&
    metadata.relativePath === expected.relativePath &&
    JSON.stringify(metadata.provenance) === JSON.stringify(expected.provenance) &&
    typeof metadata.createdAt === 'string' &&
    Number.isFinite(Date.parse(metadata.createdAt))
  )
}
function localUrl(absolutePath: string): string {
  const fileUrl = pathToFileURL(absolutePath).toString()
  return `local-media://${fileUrl.slice('file://'.length)}`
}

export async function importManagedMedia(
  root: string,
  input: ImportManagedMediaInput,
  dependencies: ManagedMediaStoreDependencies
): Promise<ImportedManagedMedia> {
  const fileSystem = dependencies.fs ?? fs
  const now = dependencies.now ?? (() => new Date())
  const randomId = dependencies.randomId ?? randomUUID
  const bytes = Buffer.from(input.bytes)
  const maxBytes = input.maxBytes ?? DEFAULT_MANAGED_MEDIA_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error('Invalid managed media size limit')
  if (!bytes.length) throw new Error('Managed media cannot be empty')
  if (bytes.length > maxBytes) throw new Error(`Managed media exceeds the ${maxBytes} byte limit`)
  const mimeType = normalizeMime(input.mimeType)
  if (!validateImage(bytes, mimeType))
    throw new Error(`Managed media bytes do not match ${mimeType} or are structurally invalid`)
  const originalFileName = canonicalOriginalFileName(input.originalFileName)
  const provenance = serializeProvenance(input.provenance)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const extension = extensions[mimeType]
  const relativePath = `originals/${sha256.slice(0, 2)}/${sha256}.${extension}`
  const authorizedRoot = await canonicalAuthorizedRoot(dependencies.authorizedRoot, fileSystem)
  const canonicalRoot = await prepareStoreRoot(root, authorizedRoot, fileSystem)
  const originalsDirectory = path.join(canonicalRoot, 'originals', sha256.slice(0, 2))
  const metadataDirectory = path.join(canonicalRoot, 'metadata')
  await prepareContainedDirectory(canonicalRoot, originalsDirectory, fileSystem)
  await prepareContainedDirectory(canonicalRoot, metadataDirectory, fileSystem)
  const absolutePath = path.join(canonicalRoot, ...relativePath.split('/'))
  const metadataPath = path.join(metadataDirectory, `${sha256}.json`)
  const originalPublication = await publishNoClobber(
    canonicalRoot,
    absolutePath,
    bytes,
    fileSystem,
    randomId
  )
  let metadataCreated = false
  try {
    await verifyOriginal(absolutePath, bytes, sha256, fileSystem)
    const metadata: ManagedMediaMetadata = {
      schema: METADATA_SCHEMA,
      version: MANAGED_MEDIA_METADATA_VERSION,
      sha256,
      sizeBytes: bytes.length,
      mimeType,
      extension,
      originalFileName,
      relativePath,
      provenance,
      createdAt: now().toISOString()
    }
    const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)
    if (metadataBytes.length > MAX_METADATA_BYTES)
      throw new Error('Managed media metadata is too large')
    const metadataPublication = await publishNoClobber(
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
            (await readRegularFile(metadataPath, MAX_METADATA_BYTES, fileSystem)).toString('utf8')
          ),
          metadata
        )
      } catch {
        valid = false
      }
      if (!valid)
        await replaceMetadata(canonicalRoot, metadataPath, metadataBytes, fileSystem, randomId)
    }
    const stored = JSON.parse(
      (await readRegularFile(metadataPath, MAX_METADATA_BYTES, fileSystem)).toString('utf8')
    ) as unknown
    if (!metadataIsConsistent(stored, metadata))
      throw new Error('Managed media metadata conflicts with existing content')
    const reference = normalizeMediaReference({
      version: MEDIA_REFERENCE_VERSION,
      kind: 'managed',
      relativePath,
      sha256,
      sizeBytes: bytes.length,
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
