import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MediaReference } from '../../shared/mediaReference'
import {
  generateCanvasThumbnailsViaSidecar,
  type CanvasThumbnailSidecarThumbnailFormat,
  type CanvasThumbnailSidecarThumbnailManifest
} from '../api/canvasThumbnailSidecarAdapter'
import { isPathInsideRoot, resolveManagedMediaReference } from './managedMediaStore'

export const MANAGED_MEDIA_DERIVATIVE_MAX_EDGES = [256, 512, 1024, 2048] as const
export type ManagedMediaDerivativeMaxEdge = (typeof MANAGED_MEDIA_DERIVATIVE_MAX_EDGES)[number]
export type ManagedMediaDerivativeFormat = 'png' | 'webp' | 'jpeg'

const SCHEMA = 'magicpot.managed-media-derivative/v3'
const ENCODER_VERSION = 'canvas-thumbnail-sidecar/v1'
const ORIENTATION_POLICY = 'apply-exif-before-resize/v1'
const MAX_DECODED_PIXELS = 64 * 1024 * 1024
const MAX_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_GENERATED_BYTES = 25 * 1024 * 1024
const IO_CHUNK_BYTES = 64 * 1024
const LOCK_RETRY_MS = 20
const LOCK_TIMEOUT_MS = 30_000
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const inflight = new Map<string, Promise<EnsureManagedMediaDerivativeResult>>()

type ImageMime = 'image/png' | 'image/webp' | 'image/jpeg'
export type ManagedMediaDerivativeDescriptor = {
  purpose: 'managed-media-derivative'
  maxEdge: ManagedMediaDerivativeMaxEdge
  relativePath: string
  mimeType: ImageMime
  sizeBytes: number
  width: number
  height: number
  sha256: string
  localMediaUrl: string
}
export type UnsupportedManagedMediaDerivative = {
  purpose: 'original-fallback'
  status: 'unsupported'
  reason: 'animated-gif'
  maxEdge: ManagedMediaDerivativeMaxEdge
  original: Awaited<ReturnType<typeof resolveManagedMediaReference>>
}
export type EnsureManagedMediaDerivativeResult =
  | ManagedMediaDerivativeDescriptor
  | UnsupportedManagedMediaDerivative
export type EnsureManagedMediaDerivativeInput = {
  authorizedRoot: string
  reference: MediaReference
  maxEdge: ManagedMediaDerivativeMaxEdge
  format?: ManagedMediaDerivativeFormat
}
type DerivativeMetadata = ManagedMediaDerivativeDescriptor & {
  schema: typeof SCHEMA
  identity: string
  originalSha256: string
  format: ManagedMediaDerivativeFormat
  encoderVersion: typeof ENCODER_VERSION
  orientationPolicy: typeof ORIENTATION_POLICY
}

type BoundOutput = {
  generatedPath: string
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  reportedSize: number
}

export function selectManagedMediaDerivativeBucket(
  requiredCssEdge: number,
  dpr: number,
  originalDimensions?: { width: number; height: number }
): ManagedMediaDerivativeMaxEdge {
  const requested = Math.max(1, requiredCssEdge) * Math.max(1, dpr)
  const originalMax = originalDimensions
    ? Math.max(originalDimensions.width, originalDimensions.height)
    : Number.POSITIVE_INFINITY
  const needed = Math.min(requested, Math.max(1, originalMax))
  return (
    MANAGED_MEDIA_DERIVATIVE_MAX_EDGES.find((edge) => edge >= needed) ??
    MANAGED_MEDIA_DERIVATIVE_MAX_EDGES.at(-1)!
  )
}

function localUrl(absolutePath: string): string {
  const fileUrl = pathToFileURL(absolutePath).toString()
  return `local-media://${fileUrl.slice('file://'.length)}`
}
function identityFor(
  originalSha256: string,
  maxEdge: ManagedMediaDerivativeMaxEdge,
  format: ManagedMediaDerivativeFormat
): string {
  return createHash('sha256')
    .update(`${originalSha256}\0${maxEdge}\0${format}\0${ENCODER_VERSION}\0${ORIENTATION_POLICY}`)
    .digest('hex')
}
function expectedMime(format: ManagedMediaDerivativeFormat): ImageMime {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`
}
function extensionFor(format: ManagedMediaDerivativeFormat): string {
  return format === 'jpeg' ? 'jpg' : format
}
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
async function canonicalRoot(root: string): Promise<string> {
  const resolved = path.resolve(root)
  const [stat, real] = await Promise.all([fs.lstat(resolved), fs.realpath(resolved)])
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(real, resolved))
    throw new Error('Authorized media root must be an existing canonical directory')
  return real
}
async function validateDirectoryChain(root: string, directory: string): Promise<void> {
  if (!isPathInsideRoot(root, directory)) throw new Error('Derivative path escapes authorized root')
  let current = await canonicalRoot(root)
  for (const segment of path
    .relative(current, path.resolve(directory))
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment)
    const [stat, real] = await Promise.all([fs.lstat(current), fs.realpath(current)])
    if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(real, current))
      throw new Error('Derivative directory chain is unsafe')
  }
}
async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  if (!isPathInsideRoot(root, directory)) throw new Error('Derivative path escapes authorized root')
  let current = root
  for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    await fs.mkdir(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    await validateDirectoryChain(root, current)
  }
}
async function readSafeFile(root: string, filePath: string, maxBytes: number): Promise<Buffer> {
  await validateDirectoryChain(root, path.dirname(filePath))
  const before = await fs.lstat(filePath)
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0 || before.size > maxBytes)
    throw new Error('Derivative file is unsafe')
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw new Error('Derivative file changed while opening')
    const bytes = Buffer.alloc(opened.size)
    let position = 0
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position)
      if (!bytesRead) throw new Error('Derivative file was truncated')
      position += bytesRead
    }
    const after = await handle.stat()
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error('Derivative file changed while reading')
    return bytes
  } finally {
    await handle.close()
  }
}
async function hashSafeFile(
  root: string,
  filePath: string,
  maxBytes: number
): Promise<{ sizeBytes: number; sha256: string }> {
  await validateDirectoryChain(root, path.dirname(filePath))
  const before = await fs.lstat(filePath)
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0 || before.size > maxBytes)
    throw new Error('Derivative image is unsafe')
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw new Error('Derivative image changed while opening')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, opened.size))
    let position = 0
    while (position < opened.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, opened.size - position),
        position
      )
      if (!bytesRead) throw new Error('Derivative image was truncated')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error('Derivative image changed while hashing')
    return { sizeBytes: opened.size, sha256: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function createVerifiedSnapshot(
  root: string,
  sourcePath: string,
  expectedSize: number,
  expectedHash: string,
  ownedRoot: string
): Promise<string> {
  await validateDirectoryChain(root, path.dirname(sourcePath))
  const before = await fs.lstat(sourcePath)
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size !== expectedSize ||
    expectedSize > MAX_SOURCE_BYTES
  )
    throw new Error('Managed media original is unsafe')
  const source = await fs.open(sourcePath, fsConstants.O_RDONLY | NOFOLLOW)
  const snapshotPath = path.join(ownedRoot, `source${path.extname(sourcePath).toLowerCase()}`)
  const destination = await fs.open(
    snapshotPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
    0o600
  )
  try {
    const opened = await source.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== expectedSize
    )
      throw new Error('Managed media original changed before snapshot')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, expectedSize))
    let position = 0
    while (position < expectedSize) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSize - position),
        position
      )
      if (!bytesRead) throw new Error('Managed media original changed during snapshot')
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written)
        if (!result.bytesWritten) throw new Error('Snapshot write made no progress')
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await destination.sync()
    const after = await source.stat()
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error('Managed media original changed during snapshot')
    if (hash.digest('hex') !== expectedHash) throw new Error('Managed media snapshot hash mismatch')
  } finally {
    await destination.close().catch(() => undefined)
    await source.close().catch(() => undefined)
  }
  await fs.chmod(snapshotPath, 0o400).catch(() => undefined)
  return snapshotPath
}
function resolveSidecarPath(workRoot: string, value: string): string {
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(workRoot, value)
  if (!isPathInsideRoot(workRoot, resolved)) throw new Error('Sidecar output escaped work root')
  return resolved
}
function dimensionsMatch(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  maxEdge: number
): boolean {
  if (
    width <= 0 ||
    height <= 0 ||
    width > sourceWidth ||
    height > sourceHeight ||
    Math.max(width, height) > maxEdge
  )
    return false
  return (
    Math.abs(width * sourceHeight - height * sourceWidth) <= Math.max(sourceWidth, sourceHeight)
  )
}
function bindManifest(
  manifest: CanvasThumbnailSidecarThumbnailManifest,
  identity: string,
  snapshotPath: string,
  snapshotSize: number,
  snapshotHash: string,
  workRoot: string,
  maxEdge: number,
  format: ManagedMediaDerivativeFormat
): BoundOutput {
  const canonicalSnapshot = path.resolve(snapshotPath)
  const sourceIdentity = manifest.sourceIdentity
  if (
    manifest.id !== identity ||
    manifest.hash.algorithm !== 'sha256' ||
    manifest.hash.hex !== snapshotHash ||
    !sourceIdentity ||
    sourceIdentity.kind !== 'local-file' ||
    !samePath(sourceIdentity.canonicalPath, canonicalSnapshot) ||
    sourceIdentity.sizeBytes !== snapshotSize ||
    !samePath(manifest.canonicalPath ?? '', canonicalSnapshot) ||
    manifest.sourceSizeBytes !== snapshotSize ||
    !samePath(manifest.source.path, canonicalSnapshot) ||
    !samePath(manifest.source.canonicalPath ?? '', canonicalSnapshot) ||
    manifest.source.byteLength !== snapshotSize ||
    manifest.source.sizeBytes !== snapshotSize ||
    !samePath(sourceIdentity.cacheRootDir, workRoot) ||
    manifest.levels?.length !== 1
  )
    throw new Error('Sidecar source identity response mismatch')
  const level = manifest.levels[0]
  const mime = expectedMime(format)
  const sidecarFormats = format === 'jpeg' ? ['jpeg', 'jpg'] : [format]
  if (
    level.maxSide !== maxEdge ||
    manifest.thumbnail.maxSide !== maxEdge ||
    !samePath(level.path, manifest.thumbnail.path) ||
    level.width !== manifest.thumbnail.width ||
    level.height !== manifest.thumbnail.height ||
    level.mimeType !== mime ||
    manifest.thumbnail.mimeType !== mime ||
    !sidecarFormats.includes(manifest.thumbnail.format) ||
    level.sizeBytes !== manifest.thumbnail.sizeBytes ||
    level.filename !== path.basename(level.path) ||
    !samePath(level.src, level.path)
  )
    throw new Error('Sidecar requested level or format response mismatch')
  const entryRoot = path.resolve(workRoot, sourceIdentity.cacheKey)
  if (
    !samePath(manifest.cacheKey ?? '', sourceIdentity.cacheKey) ||
    !isPathInsideRoot(workRoot, entryRoot)
  )
    throw new Error('Sidecar cache identity mismatch')
  const generatedPath = resolveSidecarPath(workRoot, level.path)
  const manifestPath = resolveSidecarPath(workRoot, manifest.manifestPath)
  if (!isPathInsideRoot(entryRoot, generatedPath) || !isPathInsideRoot(entryRoot, manifestPath))
    throw new Error('Sidecar content-tag output is outside expected cache entry')
  const sourceWidth =
    manifest.source.orientedWidth ?? manifest.source.postOrientationWidth ?? manifest.source.width
  const sourceHeight =
    manifest.source.orientedHeight ??
    manifest.source.postOrientationHeight ??
    manifest.source.height
  if (!dimensionsMatch(sourceWidth, sourceHeight, level.width, level.height, maxEdge))
    throw new Error('Sidecar output dimensions violate aspect or no-upscale policy')
  return {
    generatedPath,
    width: level.width,
    height: level.height,
    sourceWidth,
    sourceHeight,
    reportedSize: level.sizeBytes
  }
}

async function copyAndHashFreshOutput(
  root: string,
  bound: BoundOutput,
  destinationPath: string
): Promise<{ sizeBytes: number; sha256: string }> {
  await validateDirectoryChain(root, path.dirname(bound.generatedPath))
  const before = await fs.lstat(bound.generatedPath)
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAX_GENERATED_BYTES ||
    before.size !== bound.reportedSize
  )
    throw new Error('Sidecar output is unsafe or size-mismatched')
  const source = await fs.open(bound.generatedPath, fsConstants.O_RDONLY | NOFOLLOW)
  const destination = await fs.open(
    destinationPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
    0o600
  )
  try {
    const opened = await source.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw new Error('Sidecar output changed while opening')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, opened.size))
    let position = 0
    while (position < opened.size) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, opened.size - position),
        position
      )
      if (!bytesRead) throw new Error('Sidecar output was truncated')
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written)
        if (!result.bytesWritten) throw new Error('Derivative write made no progress')
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await destination.sync()
    const after = await source.stat()
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error('Sidecar output changed while publishing')
    return { sizeBytes: opened.size, sha256: hash.digest('hex') }
  } finally {
    await destination.close().catch(() => undefined)
    await source.close().catch(() => undefined)
  }
}

async function validateCommitted(
  root: string,
  committedDir: string,
  identity: string,
  originalSha256: string,
  maxEdge: ManagedMediaDerivativeMaxEdge,
  format: ManagedMediaDerivativeFormat
): Promise<ManagedMediaDerivativeDescriptor> {
  await validateDirectoryChain(root, committedDir)
  const metadata = JSON.parse(
    (await readSafeFile(root, path.join(committedDir, 'manifest.json'), 64 * 1024)).toString('utf8')
  ) as DerivativeMetadata
  const imagePath = path.join(committedDir, `image.${extensionFor(format)}`)
  const relativePath = path.relative(root, imagePath).split(path.sep).join('/')
  if (
    metadata.schema !== SCHEMA ||
    metadata.identity !== identity ||
    metadata.originalSha256 !== originalSha256 ||
    metadata.format !== format ||
    metadata.maxEdge !== maxEdge ||
    metadata.relativePath !== relativePath ||
    metadata.encoderVersion !== ENCODER_VERSION ||
    metadata.orientationPolicy !== ORIENTATION_POLICY ||
    metadata.mimeType !== expectedMime(format) ||
    metadata.purpose !== 'managed-media-derivative' ||
    metadata.localMediaUrl !== localUrl(imagePath) ||
    !dimensionsMatch(metadata.width, metadata.height, metadata.width, metadata.height, maxEdge)
  )
    throw new Error('Derivative commit manifest mismatch')
  const actual = await hashSafeFile(root, imagePath, MAX_GENERATED_BYTES)
  if (actual.sizeBytes !== metadata.sizeBytes || actual.sha256 !== metadata.sha256)
    throw new Error('Derivative content hash mismatch')
  return {
    purpose: metadata.purpose,
    maxEdge,
    relativePath,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
    width: metadata.width,
    height: metadata.height,
    sha256: metadata.sha256,
    localMediaUrl: metadata.localMediaUrl
  }
}

async function acquireLock(lockDir: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      await fs.mkdir(lockDir)
      return async () => fs.rm(lockDir, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for derivative generation lock')
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}

async function generate(
  root: string,
  original: Awaited<ReturnType<typeof resolveManagedMediaReference>>,
  maxEdge: ManagedMediaDerivativeMaxEdge,
  format: ManagedMediaDerivativeFormat
): Promise<ManagedMediaDerivativeDescriptor> {
  const originalSha256 = original.reference.sha256!
  const identity = identityFor(originalSha256, maxEdge, format)
  const identityRoot = path.join(
    root,
    'derivatives',
    originalSha256.slice(0, 2),
    originalSha256,
    identity
  )
  await ensureSafeDirectory(root, identityRoot)
  const committedDir = path.join(identityRoot, 'committed')
  try {
    return await validateCommitted(root, committedDir, identity, originalSha256, maxEdge, format)
  } catch {
    // Publication and repair are serialized below.
  }
  const release = await acquireLock(path.join(identityRoot, '.generation-lock'))
  try {
    try {
      return await validateCommitted(root, committedDir, identity, originalSha256, maxEdge, format)
    } catch {
      // This lock owner is responsible for creating or repairing the deterministic commit.
    }
    const owner = randomUUID()
    const ownedRoot = path.join(identityRoot, `.work-${owner}`)
    const sidecarRoot = path.join(ownedRoot, 'sidecar')
    const stagedCommit = path.join(identityRoot, `.commit-${owner}`)
    await ensureSafeDirectory(root, sidecarRoot)
    await ensureSafeDirectory(root, stagedCommit)
    try {
      const snapshotPath = await createVerifiedSnapshot(
        root,
        original.absolutePath,
        original.reference.sizeBytes!,
        originalSha256,
        ownedRoot
      )
      const result = await generateCanvasThumbnailsViaSidecar({
        cacheRoot: sidecarRoot,
        items: [{ id: identity, path: snapshotPath }],
        thumbnail: {
          levels: [maxEdge],
          allowUpscale: false,
          format: format as CanvasThumbnailSidecarThumbnailFormat
        },
        maxConcurrency: 1,
        maxDecodedPixels: MAX_DECODED_PIXELS,
        maxSourceBytes: Math.min(MAX_SOURCE_BYTES, original.reference.sizeBytes!),
        maxOutputPixels: maxEdge * maxEdge,
        maxGeneratedBytes: MAX_GENERATED_BYTES,
        hash: 'sha256'
      })
      if (!result.ok) throw new Error(`Managed derivative sidecar unavailable: ${result.reason}`)
      if (
        !result.response.ok ||
        !samePath(result.response.cacheRoot, sidecarRoot) ||
        result.response.results.length !== 1
      )
        throw new Error('Managed derivative sidecar returned an unexpected batch response')
      const item = result.response.results[0]
      if (item.id !== identity || !item.ok || !item.manifest)
        throw new Error(item.error?.message ?? 'Managed derivative sidecar failed')
      const bound = bindManifest(
        item.manifest,
        identity,
        snapshotPath,
        original.reference.sizeBytes!,
        originalSha256,
        sidecarRoot,
        maxEdge,
        format
      )
      const finalImage = path.join(committedDir, `image.${extensionFor(format)}`)
      const stagedImage = path.join(stagedCommit, `image.${extensionFor(format)}`)
      const content = await copyAndHashFreshOutput(root, bound, stagedImage)
      await fs.chmod(stagedImage, 0o400).catch(() => undefined)
      const descriptor: ManagedMediaDerivativeDescriptor = {
        purpose: 'managed-media-derivative',
        maxEdge,
        relativePath: path.relative(root, finalImage).split(path.sep).join('/'),
        mimeType: expectedMime(format),
        sizeBytes: content.sizeBytes,
        width: bound.width,
        height: bound.height,
        sha256: content.sha256,
        localMediaUrl: localUrl(finalImage)
      }
      const metadata: DerivativeMetadata = {
        ...descriptor,
        schema: SCHEMA,
        identity,
        originalSha256,
        format,
        encoderVersion: ENCODER_VERSION,
        orientationPolicy: ORIENTATION_POLICY
      }
      await fs.writeFile(
        path.join(stagedCommit, 'manifest.json'),
        `${JSON.stringify(metadata)}\n`,
        { flag: 'wx', mode: 0o600 }
      )
      await fs.chmod(path.join(stagedCommit, 'manifest.json'), 0o400).catch(() => undefined)
      try {
        await fs.rename(committedDir, path.join(identityRoot, `.quarantine-${Date.now()}-${owner}`))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await fs.rename(stagedCommit, committedDir)
      return await validateCommitted(root, committedDir, identity, originalSha256, maxEdge, format)
    } finally {
      await fs.rm(ownedRoot, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(stagedCommit, { recursive: true, force: true }).catch(() => undefined)
    }
  } finally {
    await release()
  }
}

export async function ensureManagedMediaDerivative(
  input: EnsureManagedMediaDerivativeInput
): Promise<EnsureManagedMediaDerivativeResult> {
  if (!MANAGED_MEDIA_DERIVATIVE_MAX_EDGES.includes(input.maxEdge))
    throw new TypeError('maxEdge must be one of 256, 512, 1024, or 2048')
  if (!input.reference || input.reference.kind !== 'managed')
    throw new TypeError('Managed media derivatives require a managed reference')
  const format = input.format ?? 'webp'
  if (!['png', 'webp', 'jpeg'].includes(format))
    throw new TypeError('Unsupported derivative format')
  const root = await canonicalRoot(input.authorizedRoot)
  const original = await resolveManagedMediaReference(root, input.reference, {
    authorizedRoot: root
  })
  if (original.metadata.mimeType === 'image/gif')
    return {
      purpose: 'original-fallback',
      status: 'unsupported',
      reason: 'animated-gif',
      maxEdge: input.maxEdge,
      original
    }
  const key = `${root}\0${original.reference.sha256}\0${input.maxEdge}\0${format}`
  const existing = inflight.get(key)
  if (existing) return existing
  const promise = generate(root, original, input.maxEdge, format)
  inflight.set(key, promise)
  try {
    return await promise
  } finally {
    if (inflight.get(key) === promise) inflight.delete(key)
  }
}
