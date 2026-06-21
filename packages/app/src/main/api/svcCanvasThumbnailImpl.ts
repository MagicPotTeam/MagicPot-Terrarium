import { app, nativeImage } from 'electron'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'path'
import { pathToFileURL } from 'node:url'
import type {
  CanvasThumbnailManifest,
  CanvasThumbnailCacheRootReq,
  CanvasThumbnailGenerateSetReq,
  CanvasThumbnailGenerateSetResp,
  CanvasThumbnailNativeReq,
  CanvasThumbnailNativeResp,
  CanvasThumbnailReadManifestReq,
  CanvasThumbnailReadManifestResp,
  CanvasThumbnailSourceFileMetadataReq,
  CanvasThumbnailSourceFileMetadataResp,
  CanvasThumbnailSvc,
  CanvasThumbnailWriteSetReq,
  CanvasThumbnailWriteSetResp
} from '@shared/api/svcCanvasThumbnail'
import {
  generateCanvasThumbnailsViaSidecar,
  type CanvasThumbnailSidecarResult,
  type CanvasThumbnailSidecarBatchThumbnailResponse
} from './canvasThumbnailSidecarAdapter'

const THUMBNAIL_CACHE_DIRNAME = 'project-canvas-thumbnail-cache'
const CACHE_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/
const CACHE_FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}\.(?:png|webp)$/i
const MANIFEST_FILENAME = 'manifest.json'
const SUPPORTED_THUMBNAIL_MIME_TYPES = new Set(['image/png', 'image/webp'])
const DEFAULT_GENERATED_THUMBNAIL_LEVELS = [128, 256, 512, 1024, 2048]
const DEFAULT_SIDECAR_MAX_DECODED_PIXELS = 64 * 1024 * 1024
const REPO_TEST_CACHE_ROOT_DIRNAMES = ['.magicpot-trash', '.tmp', 'tmp', 'temp', 'test-results']
const TEMP_TEST_CACHE_ROOT_PATTERN =
  /^magicpot-(?:canvas-thumbnail|project-canvas-thumbnail|thumbnail-cache|test|benchmark)[a-zA-Z0-9_.-]*$/i

type SourceIdentity = {
  canonicalPath: string
  sizeBytes: number
  lastModifiedMs: number
  cacheKey: string
}

type CacheEntryResolution = {
  cacheRoot: string
  entryDir: string
}

type CanvasThumbnailSidecarRunner = typeof generateCanvasThumbnailsViaSidecar

export type CanvasThumbnailSvcImplOptions = {
  generateViaSidecar?: CanvasThumbnailSidecarRunner
}

function getDefaultCacheRoot(): string {
  return path.resolve(app.getPath('userData'), THUMBNAIL_CACHE_DIRNAME)
}

async function realpathIfExists(fullPath: string): Promise<string | null> {
  try {
    return await fs.realpath(fullPath)
  } catch {
    return null
  }
}

async function canonicalizeExistingOrParent(fullPath: string): Promise<string> {
  const resolved = path.resolve(fullPath)
  const canonical = await realpathIfExists(resolved)
  if (canonical) {
    return canonical
  }

  const parent = path.dirname(resolved)
  if (parent === resolved) {
    return resolved
  }

  return path.join(await canonicalizeExistingOrParent(parent), path.basename(resolved))
}

function isPathInsideOrEqual(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertPathInsideRoot(root: string, target: string): void {
  if (isPathInsideOrEqual(path.resolve(root), path.resolve(target))) {
    return
  }

  throw new Error(`Canvas thumbnail cache path escaped root: ${target}`)
}

async function getAllowedExplicitCacheRootBases(defaultCacheRoot: string): Promise<string[]> {
  const roots = [
    defaultCacheRoot,
    ...REPO_TEST_CACHE_ROOT_DIRNAMES.map((dirname) => path.join(process.cwd(), dirname))
  ]
  const envTestRoot = process.env.MAGICPOT_TEST_TRASH_ROOT?.trim()
  if (envTestRoot) {
    roots.push(envTestRoot)
  }

  return Promise.all(roots.map((root) => canonicalizeExistingOrParent(root)))
}

async function isAllowedTempCacheRoot(canonicalRoot: string): Promise<boolean> {
  const tempRoot = await canonicalizeExistingOrParent(os.tmpdir())
  if (!isPathInsideOrEqual(tempRoot, canonicalRoot) || canonicalRoot === tempRoot) {
    return false
  }

  const relative = path.relative(tempRoot, canonicalRoot)
  const firstSegment = relative.split(/[\\/]+/)[0]
  return TEMP_TEST_CACHE_ROOT_PATTERN.test(firstSegment)
}

async function assertAllowedExplicitCacheRoot(
  canonicalRoot: string,
  requestedRoot: string,
  defaultCacheRoot: string
): Promise<void> {
  const allowedBases = await getAllowedExplicitCacheRootBases(defaultCacheRoot)
  if (allowedBases.some((base) => isPathInsideOrEqual(base, canonicalRoot))) {
    return
  }

  if (await isAllowedTempCacheRoot(canonicalRoot)) {
    return
  }

  throw new Error(`Unsafe canvas thumbnail cache root: ${requestedRoot}`)
}

async function resolveCacheRoot(cacheRootDir?: string): Promise<string> {
  const explicitRoot = cacheRootDir?.trim()
  const defaultCacheRoot = await canonicalizeExistingOrParent(getDefaultCacheRoot())
  if (!explicitRoot) {
    return defaultCacheRoot
  }

  const requestedRoot = path.resolve(explicitRoot)
  const canonicalRoot = await canonicalizeExistingOrParent(requestedRoot)
  await assertAllowedExplicitCacheRoot(canonicalRoot, requestedRoot, defaultCacheRoot)
  return canonicalRoot
}

async function ensureCacheRoot(cacheRootDir?: string): Promise<string> {
  const cacheRoot = await resolveCacheRoot(cacheRootDir)
  await fs.mkdir(cacheRoot, { recursive: true })
  const canonicalRoot = (await realpathIfExists(cacheRoot)) ?? cacheRoot

  if (cacheRootDir?.trim()) {
    const defaultCacheRoot = await canonicalizeExistingOrParent(getDefaultCacheRoot())
    await assertAllowedExplicitCacheRoot(
      canonicalRoot,
      path.resolve(cacheRootDir),
      defaultCacheRoot
    )
  }

  return canonicalRoot
}

function assertSafeCacheKey(cacheKey: string): void {
  if (!CACHE_KEY_PATTERN.test(cacheKey)) {
    throw new Error(`Invalid canvas thumbnail cache key: ${cacheKey}`)
  }
}

function assertSafeCacheFilename(filename: string): void {
  if (!CACHE_FILE_PATTERN.test(filename) || filename.includes('..')) {
    throw new Error(`Invalid canvas thumbnail filename: ${filename}`)
  }
}

async function resolveCacheEntryDir(
  cacheKey: string,
  cacheRootDir: string | undefined,
  options: { create: boolean }
): Promise<CacheEntryResolution> {
  assertSafeCacheKey(cacheKey)
  const cacheRoot = options.create
    ? await ensureCacheRoot(cacheRootDir)
    : await resolveCacheRoot(cacheRootDir)
  const requestedEntryDir = path.resolve(cacheRoot, cacheKey)
  assertPathInsideRoot(cacheRoot, requestedEntryDir)

  if (options.create) {
    await fs.mkdir(requestedEntryDir, { recursive: true })
  }

  const canonicalEntryDir = (await realpathIfExists(requestedEntryDir)) ?? requestedEntryDir
  assertPathInsideRoot(cacheRoot, canonicalEntryDir)
  return { cacheRoot, entryDir: canonicalEntryDir }
}

function getCacheFilePath(entryDir: string, filename: string): string {
  assertSafeCacheFilename(filename)
  const fullPath = path.resolve(entryDir, filename)
  assertPathInsideRoot(entryDir, fullPath)
  return fullPath
}

function toLocalMediaUrl(fullPath: string): string {
  return pathToFileURL(fullPath)
    .toString()
    .replace(/^file:/, 'local-media:')
}

function normalizeIdentityPath(canonicalPath: string): string {
  let normalized = canonicalPath.trim().replace(/\\/g, '/')
  if (normalized.startsWith('//?/UNC/')) {
    normalized = `//${normalized.slice('//?/UNC/'.length)}`
  } else if (normalized.startsWith('//?/')) {
    normalized = normalized.slice('//?/'.length)
  }
  return normalized.replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)
}

function fnv1a32(value: string, seed: number): string {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function buildCanvasThumbnailCacheIdentityString(input: {
  canonicalPath: string
  sizeBytes: number
  lastModifiedMs: number
}): string {
  return [
    normalizeIdentityPath(input.canonicalPath),
    Math.max(0, Math.floor(input.sizeBytes)),
    Math.max(0, Math.floor(input.lastModifiedMs))
  ].join('\n')
}

function buildCanvasThumbnailCacheKey(input: {
  canonicalPath: string
  sizeBytes: number
  lastModifiedMs: number
}): string {
  const identity = buildCanvasThumbnailCacheIdentityString(input)
  return `thumb-${fnv1a32(identity, 0x811c9dc5)}${fnv1a32(identity, 0x9e3779b9)}`
}

async function getSourceIdentityForManifest(
  manifest: CanvasThumbnailManifest
): Promise<SourceIdentity> {
  const requestedPath = path.resolve(manifest.canonicalPath)
  const canonicalSourcePath = await fs.realpath(requestedPath)
  const stats = await fs.stat(canonicalSourcePath)
  if (!stats.isFile()) {
    throw new Error('Canvas thumbnail manifest source is not a file.')
  }

  const canonicalPath = normalizeIdentityPath(canonicalSourcePath)
  const manifestCanonicalPath = normalizeIdentityPath(manifest.canonicalPath)
  const sizeBytes = Math.floor(stats.size)
  const lastModifiedMs = Math.floor(stats.mtimeMs)
  if (
    !manifestCanonicalPath ||
    manifestCanonicalPath !== canonicalPath ||
    Math.floor(manifest.sourceSizeBytes) !== sizeBytes ||
    Math.floor(manifest.sourceLastModifiedMs) !== lastModifiedMs
  ) {
    throw new Error('Canvas thumbnail manifest source identity does not match the source file.')
  }

  const cacheKey = buildCanvasThumbnailCacheKey({
    canonicalPath,
    sizeBytes,
    lastModifiedMs
  })
  if (manifest.cacheKey !== cacheKey) {
    throw new Error('Canvas thumbnail manifest cache key does not match the source identity.')
  }

  return {
    canonicalPath,
    sizeBytes,
    lastModifiedMs,
    cacheKey
  }
}

async function validateManifest(
  manifest: CanvasThumbnailManifest,
  cacheKey: string
): Promise<CanvasThumbnailManifest> {
  if (!manifest || manifest.version !== 1 || manifest.cacheKey !== cacheKey) {
    throw new Error('Invalid canvas thumbnail manifest identity.')
  }

  assertSafeCacheKey(manifest.cacheKey)

  if (
    typeof manifest.canonicalPath !== 'string' ||
    !Number.isFinite(manifest.sourceSizeBytes) ||
    manifest.sourceSizeBytes <= 0 ||
    !Number.isFinite(manifest.sourceLastModifiedMs) ||
    manifest.sourceLastModifiedMs <= 0 ||
    typeof manifest.createdAt !== 'string' ||
    typeof manifest.updatedAt !== 'string' ||
    !Array.isArray(manifest.levels) ||
    manifest.levels.length === 0
  ) {
    throw new Error('Invalid canvas thumbnail manifest payload.')
  }

  for (const level of manifest.levels) {
    assertSafeCacheFilename(level.filename)
    if (
      !Number.isFinite(level.maxSide) ||
      !Number.isFinite(level.width) ||
      !Number.isFinite(level.height) ||
      !Number.isFinite(level.sizeBytes) ||
      !SUPPORTED_THUMBNAIL_MIME_TYPES.has(level.mimeType)
    ) {
      throw new Error('Invalid canvas thumbnail manifest level.')
    }
  }

  const sourceIdentity = await getSourceIdentityForManifest(manifest)
  return {
    ...manifest,
    cacheKey: sourceIdentity.cacheKey,
    canonicalPath: sourceIdentity.canonicalPath,
    sourceSizeBytes: sourceIdentity.sizeBytes,
    sourceLastModifiedMs: sourceIdentity.lastModifiedMs
  }
}

function normalizeManifestFileUrls(
  manifest: CanvasThumbnailManifest,
  entryDir: string
): CanvasThumbnailManifest {
  return {
    ...manifest,
    levels: manifest.levels.map((level) => ({
      ...level,
      src: toLocalMediaUrl(getCacheFilePath(entryDir, level.filename))
    }))
  }
}

async function readJsonFile<T>(fullPath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(fullPath, 'utf8')) as T
  } catch {
    return null
  }
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.access(fullPath)
    return true
  } catch {
    return false
  }
}

function normalizeGeneratedLevels(levels: number[] | undefined): number[] {
  const normalized = [
    ...new Set(
      (levels ?? DEFAULT_GENERATED_THUMBNAIL_LEVELS)
        .map((level) => Math.floor(Number(level)))
        .filter((level) => Number.isFinite(level) && level > 0 && level <= 8192)
    )
  ]
  return normalized.length > 0
    ? normalized.sort((left, right) => left - right)
    : DEFAULT_GENERATED_THUMBNAIL_LEVELS
}

function normalizeGeneratedFormat(format: CanvasThumbnailGenerateSetReq['format']): 'png' | 'webp' {
  return format === 'image/png' ? 'png' : 'webp'
}

function getSidecarResultMessage(
  result: CanvasThumbnailSidecarResult<CanvasThumbnailSidecarBatchThumbnailResponse>
): string {
  if (result.ok) {
    return ''
  }
  return result.message
}

export class CanvasThumbnailSvcImpl implements CanvasThumbnailSvc {
  private readonly generateViaSidecar: CanvasThumbnailSidecarRunner

  constructor(options: CanvasThumbnailSvcImplOptions = {}) {
    this.generateViaSidecar = options.generateViaSidecar ?? generateCanvasThumbnailsViaSidecar
  }

  getSourceFileMetadata = async (
    req: CanvasThumbnailSourceFileMetadataReq
  ): Promise<CanvasThumbnailSourceFileMetadataResp> => {
    const requestedPath = path.resolve(req.fullPath)
    let canonicalPath = requestedPath
    let stats
    try {
      canonicalPath = await fs.realpath(requestedPath)
      stats = await fs.stat(canonicalPath)
    } catch {
      return {
        exists: false,
        canonicalPath,
        sizeBytes: 0,
        lastModifiedMs: 0
      }
    }
    if (!stats.isFile()) {
      return {
        exists: false,
        canonicalPath,
        sizeBytes: 0,
        lastModifiedMs: 0
      }
    }

    return {
      exists: true,
      canonicalPath,
      sizeBytes: stats.size,
      lastModifiedMs: stats.mtimeMs
    }
  }

  getThumbnailCacheRoot = async (
    req?: CanvasThumbnailCacheRootReq
  ): Promise<{ cacheRoot: string }> => {
    const cacheRoot = await ensureCacheRoot(req?.cacheRootDir)
    return { cacheRoot }
  }

  readThumbnailManifest = async (
    req: CanvasThumbnailReadManifestReq
  ): Promise<CanvasThumbnailReadManifestResp> => {
    const { entryDir } = await resolveCacheEntryDir(req.cacheKey, req.cacheRootDir, {
      create: false
    })
    const manifest = await readJsonFile<CanvasThumbnailManifest>(
      path.join(entryDir, MANIFEST_FILENAME)
    )
    if (!manifest) {
      return { manifest: null }
    }

    let validated: CanvasThumbnailManifest
    try {
      validated = await validateManifest(manifest, req.cacheKey)
    } catch {
      return { manifest: null }
    }

    const normalized = normalizeManifestFileUrls(validated, entryDir)
    const hasAllFiles = (
      await Promise.all(
        normalized.levels.map((level) => pathExists(getCacheFilePath(entryDir, level.filename)))
      )
    ).every(Boolean)
    return { manifest: hasAllFiles ? normalized : null }
  }

  writeThumbnailSet = async (
    req: CanvasThumbnailWriteSetReq
  ): Promise<CanvasThumbnailWriteSetResp> => {
    const { entryDir } = await resolveCacheEntryDir(req.cacheKey, req.cacheRootDir, {
      create: true
    })
    const manifest = await validateManifest(req.manifest, req.cacheKey)
    const expectedFilenames = new Set(manifest.levels.map((level) => level.filename))
    const writtenFilenames = new Set<string>()

    for (const file of req.files) {
      assertSafeCacheFilename(file.filename)
      if (!expectedFilenames.has(file.filename)) {
        throw new Error(`Canvas thumbnail file is not referenced by manifest: ${file.filename}`)
      }

      await fs.writeFile(getCacheFilePath(entryDir, file.filename), Buffer.from(file.data))
      writtenFilenames.add(file.filename)
    }

    for (const filename of expectedFilenames) {
      if (!writtenFilenames.has(filename)) {
        throw new Error(`Missing canvas thumbnail file for manifest level: ${filename}`)
      }
    }

    const manifestToPersist: CanvasThumbnailManifest = {
      ...manifest,
      levels: manifest.levels.map((level) => {
        return {
          ...level,
          src: ''
        }
      })
    }
    const manifestPath = path.join(entryDir, MANIFEST_FILENAME)
    const tempManifestPath = path.join(entryDir, `${MANIFEST_FILENAME}.tmp`)
    await fs.writeFile(tempManifestPath, JSON.stringify(manifestToPersist, null, 2), 'utf8')
    await fs.rename(tempManifestPath, manifestPath)

    return { manifest: normalizeManifestFileUrls(manifestToPersist, entryDir) }
  }

  generateThumbnailSet = async (
    req: CanvasThumbnailGenerateSetReq
  ): Promise<CanvasThumbnailGenerateSetResp> => {
    const requestedPath = path.resolve(req.fullPath)
    const metadata = await this.getSourceFileMetadata({ fullPath: requestedPath })
    if (!metadata.exists) {
      return {
        manifest: null,
        status: 'failed',
        error: `Cannot generate thumbnail set for missing file: ${requestedPath}`,
        sidecar: { used: false, fallback: false }
      }
    }

    const sourceIdentity: SourceIdentity = {
      canonicalPath: normalizeIdentityPath(metadata.canonicalPath),
      sizeBytes: Math.floor(metadata.sizeBytes),
      lastModifiedMs: Math.floor(metadata.lastModifiedMs),
      cacheKey: buildCanvasThumbnailCacheKey({
        canonicalPath: metadata.canonicalPath,
        sizeBytes: metadata.sizeBytes,
        lastModifiedMs: metadata.lastModifiedMs
      })
    }
    const cacheRoot = await ensureCacheRoot(req.cacheRootDir)
    const levels = normalizeGeneratedLevels(req.levels)

    let sidecarResult: CanvasThumbnailSidecarResult<CanvasThumbnailSidecarBatchThumbnailResponse>
    try {
      sidecarResult = await this.generateViaSidecar(
        {
          cacheRoot,
          items: [{ id: sourceIdentity.cacheKey, path: metadata.canonicalPath }],
          thumbnail: {
            levels,
            format: normalizeGeneratedFormat(req.format),
            allowUpscale: false
          },
          maxConcurrency: req.maxConcurrency ?? 1,
          maxDecodedPixels: req.maxDecodedPixels ?? DEFAULT_SIDECAR_MAX_DECODED_PIXELS,
          hash: 'sha256'
        },
        {
          timeoutMs: req.timeoutMs
        }
      )
    } catch (error) {
      return {
        manifest: null,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        sidecar: { used: true, fallback: false }
      }
    }

    if (!sidecarResult.ok) {
      return {
        manifest: null,
        status: 'fallback',
        error: getSidecarResultMessage(sidecarResult),
        sidecar: {
          used: false,
          fallback: true,
          reason: sidecarResult.reason,
          message: sidecarResult.message
        }
      }
    }

    if (
      normalizeIdentityPath(sidecarResult.response.cacheRoot) !== normalizeIdentityPath(cacheRoot)
    ) {
      return {
        manifest: null,
        status: 'failed',
        error: 'Canvas thumbnail sidecar returned a cache root outside the authorized root.',
        sidecar: { used: true, fallback: false }
      }
    }

    const itemResult = sidecarResult.response.results.find(
      (result) => result.id === sourceIdentity.cacheKey
    )
    if (!itemResult?.ok || !itemResult.manifest) {
      return {
        manifest: null,
        status: 'failed',
        error:
          itemResult?.error?.message ?? 'Canvas thumbnail sidecar did not generate a manifest.',
        sidecar: { used: true, fallback: false }
      }
    }

    try {
      const read = await this.readThumbnailManifest({
        cacheKey: sourceIdentity.cacheKey,
        ...(req.cacheRootDir ? { cacheRootDir: req.cacheRootDir } : {})
      })
      if (!read.manifest) {
        return {
          manifest: null,
          status: 'failed',
          error: 'Canvas thumbnail sidecar output failed manifest validation.',
          sidecar: { used: true, fallback: false }
        }
      }

      return {
        manifest: read.manifest,
        status: 'generated',
        sidecar: { used: true, fallback: false }
      }
    } catch (error) {
      return {
        manifest: null,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        sidecar: { used: true, fallback: false }
      }
    }
  }

  createNativeThumbnail = async (
    req: CanvasThumbnailNativeReq
  ): Promise<CanvasThumbnailNativeResp> => {
    const maxSide = Math.max(1, Math.min(8192, Math.floor(req.maxSide)))
    const requestedPath = path.resolve(req.fullPath)
    const metadata = await this.getSourceFileMetadata({ fullPath: requestedPath })
    if (!metadata.exists) {
      throw new Error(`Cannot create native thumbnail for missing file: ${requestedPath}`)
    }

    const thumbnail = await nativeImage.createThumbnailFromPath(metadata.canonicalPath, {
      width: maxSide,
      height: maxSide
    })
    const size = thumbnail.getSize()
    if (thumbnail.isEmpty() || size.width <= 0 || size.height <= 0) {
      throw new Error(`Failed to create native thumbnail for ${requestedPath}`)
    }

    return {
      data: new Uint8Array(thumbnail.toPNG()),
      width: size.width,
      height: size.height,
      mimeType: 'image/png'
    }
  }
}
