import { app, nativeImage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'node:url'
import type {
  CanvasThumbnailManifest,
  CanvasThumbnailCacheRootReq,
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

const THUMBNAIL_CACHE_DIRNAME = 'project-canvas-thumbnail-cache'
const CACHE_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/
const CACHE_FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}\.(?:png|webp)$/i
const MANIFEST_FILENAME = 'manifest.json'
const SUPPORTED_THUMBNAIL_MIME_TYPES = new Set(['image/png', 'image/webp'])

function getCacheRoot(cacheRootDir?: string): string {
  const explicitRoot = cacheRootDir?.trim()
  if (explicitRoot) {
    return path.resolve(explicitRoot)
  }

  return path.join(app.getPath('userData'), THUMBNAIL_CACHE_DIRNAME)
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

function assertPathInsideRoot(root: string, target: string): void {
  const relative = path.relative(root, target)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return
  }

  throw new Error(`Canvas thumbnail cache path escaped root: ${target}`)
}

function getCacheEntryDir(cacheKey: string, cacheRootDir?: string): string {
  assertSafeCacheKey(cacheKey)
  const cacheRoot = getCacheRoot(cacheRootDir)
  const entryDir = path.resolve(cacheRoot, cacheKey)
  assertPathInsideRoot(cacheRoot, entryDir)
  return entryDir
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

function validateManifest(
  manifest: CanvasThumbnailManifest,
  cacheKey: string
): CanvasThumbnailManifest {
  if (!manifest || manifest.version !== 1 || manifest.cacheKey !== cacheKey) {
    throw new Error('Invalid canvas thumbnail manifest identity.')
  }

  assertSafeCacheKey(manifest.cacheKey)

  if (
    typeof manifest.canonicalPath !== 'string' ||
    !Number.isFinite(manifest.sourceSizeBytes) ||
    !Number.isFinite(manifest.sourceLastModifiedMs) ||
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

  return manifest
}

function normalizeManifestFileUrls(
  manifest: CanvasThumbnailManifest,
  cacheRootDir?: string
): CanvasThumbnailManifest {
  const entryDir = getCacheEntryDir(manifest.cacheKey, cacheRootDir)
  return {
    ...manifest,
    levels: manifest.levels.map((level) => ({
      ...level,
      src: toLocalMediaUrl(getCacheFilePath(entryDir, level.filename))
    }))
  }
}

function readJsonFile<T>(fullPath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8')) as T
  } catch {
    return null
  }
}

export class CanvasThumbnailSvcImpl implements CanvasThumbnailSvc {
  getSourceFileMetadata = async (
    req: CanvasThumbnailSourceFileMetadataReq
  ): Promise<CanvasThumbnailSourceFileMetadataResp> => {
    const requestedPath = path.resolve(req.fullPath)
    if (!fs.existsSync(requestedPath)) {
      return {
        exists: false,
        canonicalPath: requestedPath,
        sizeBytes: 0,
        lastModifiedMs: 0
      }
    }

    const canonicalPath = fs.realpathSync.native(requestedPath)
    const stats = fs.statSync(canonicalPath)
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
    const cacheRoot = getCacheRoot(req?.cacheRootDir)
    fs.mkdirSync(cacheRoot, { recursive: true })
    return { cacheRoot }
  }

  readThumbnailManifest = async (
    req: CanvasThumbnailReadManifestReq
  ): Promise<CanvasThumbnailReadManifestResp> => {
    const entryDir = getCacheEntryDir(req.cacheKey, req.cacheRootDir)
    const manifest = readJsonFile<CanvasThumbnailManifest>(path.join(entryDir, MANIFEST_FILENAME))
    if (!manifest) {
      return { manifest: null }
    }

    let validated: CanvasThumbnailManifest
    try {
      validated = validateManifest(manifest, req.cacheKey)
    } catch {
      return { manifest: null }
    }

    const normalized = normalizeManifestFileUrls(validated, req.cacheRootDir)
    const hasAllFiles = normalized.levels.every((level) =>
      fs.existsSync(getCacheFilePath(entryDir, level.filename))
    )
    return { manifest: hasAllFiles ? normalized : null }
  }

  writeThumbnailSet = async (
    req: CanvasThumbnailWriteSetReq
  ): Promise<CanvasThumbnailWriteSetResp> => {
    const entryDir = getCacheEntryDir(req.cacheKey, req.cacheRootDir)
    const manifest = validateManifest(req.manifest, req.cacheKey)
    const expectedFilenames = new Set(manifest.levels.map((level) => level.filename))
    const writtenFilenames = new Set<string>()

    fs.mkdirSync(entryDir, { recursive: true })
    for (const file of req.files) {
      assertSafeCacheFilename(file.filename)
      if (!expectedFilenames.has(file.filename)) {
        throw new Error(`Canvas thumbnail file is not referenced by manifest: ${file.filename}`)
      }

      fs.writeFileSync(getCacheFilePath(entryDir, file.filename), Buffer.from(file.data))
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
    fs.writeFileSync(tempManifestPath, JSON.stringify(manifestToPersist, null, 2), 'utf8')
    fs.renameSync(tempManifestPath, manifestPath)

    return { manifest: normalizeManifestFileUrls(manifestToPersist, req.cacheRootDir) }
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
