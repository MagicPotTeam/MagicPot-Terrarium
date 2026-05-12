import type { CanvasThumbnailManifest } from '@shared/api/svcCanvasThumbnail'
import type {
  CanvasImageSourceIdentity,
  CanvasImageThumbnailLevel,
  CanvasImageThumbnailSet,
  CanvasThumbnailLevelSize
} from './canvasThumbnailTypes'
import { CANVAS_THUMBNAIL_LEVELS } from './canvasThumbnailTypes'

type SourceIdentityInput = {
  canonicalPath: string
  sizeBytes: number
  lastModifiedMs: number
  cacheRootDir?: string
}

const CACHE_KEY_PREFIX = 'thumb'

function normalizeIdentityPath(canonicalPath: string): string {
  return canonicalPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)
}

function fnv1a32(value: string, seed: number): string {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function buildCanvasThumbnailCacheIdentityString(input: SourceIdentityInput): string {
  return [
    normalizeIdentityPath(input.canonicalPath),
    Math.max(0, Math.floor(input.sizeBytes)),
    Math.max(0, Math.floor(input.lastModifiedMs))
  ].join('\n')
}

export function buildCanvasThumbnailCacheKey(input: SourceIdentityInput): string {
  const identity = buildCanvasThumbnailCacheIdentityString(input)
  return `${CACHE_KEY_PREFIX}-${fnv1a32(identity, 0x811c9dc5)}${fnv1a32(identity, 0x9e3779b9)}`
}

export function buildCanvasImageSourceIdentity(
  input: SourceIdentityInput
): CanvasImageSourceIdentity | null {
  const canonicalPath = normalizeIdentityPath(input.canonicalPath)
  const sizeBytes = Math.max(0, Math.floor(input.sizeBytes))
  const lastModifiedMs = Math.max(0, Math.floor(input.lastModifiedMs))
  if (!canonicalPath || sizeBytes <= 0 || lastModifiedMs <= 0) {
    return null
  }

  return {
    kind: 'local-file',
    canonicalPath,
    sizeBytes,
    lastModifiedMs,
    cacheKey: buildCanvasThumbnailCacheKey({
      canonicalPath,
      sizeBytes,
      lastModifiedMs
    }),
    ...(input.cacheRootDir?.trim() ? { cacheRootDir: input.cacheRootDir.trim() } : {})
  }
}

export const buildCanvasThumbnailSourceIdentity = buildCanvasImageSourceIdentity

export function isCanvasThumbnailSetFresh(
  thumbnailSet: CanvasImageThumbnailSet | null | undefined,
  sourceIdentity: CanvasImageSourceIdentity | null | undefined
): thumbnailSet is CanvasImageThumbnailSet {
  return Boolean(
    thumbnailSet &&
    sourceIdentity &&
    thumbnailSet.version === 1 &&
    thumbnailSet.cacheKey === sourceIdentity.cacheKey &&
    thumbnailSet.sourceIdentity.canonicalPath === sourceIdentity.canonicalPath &&
    thumbnailSet.sourceIdentity.sizeBytes === sourceIdentity.sizeBytes &&
    thumbnailSet.sourceIdentity.lastModifiedMs === sourceIdentity.lastModifiedMs &&
    CANVAS_THUMBNAIL_LEVELS.every((level) =>
      thumbnailSet.levels.some((candidate) => candidate.maxSide === level && candidate.src)
    )
  )
}

export function pickCanvasThumbnailLevel(
  thumbnailSet: CanvasImageThumbnailSet | null | undefined,
  targetMaxSide: number
): CanvasImageThumbnailLevel | null {
  if (!thumbnailSet || thumbnailSet.levels.length === 0) {
    return null
  }

  const safeTarget = Math.max(1, Math.floor(targetMaxSide))
  const sorted = [...thumbnailSet.levels].sort((left, right) => left.maxSide - right.maxSide)
  return sorted.find((level) => level.maxSide >= safeTarget) ?? sorted[sorted.length - 1] ?? null
}

export const pickBestCanvasThumbnailLevel = pickCanvasThumbnailLevel

export function isCanvasThumbnailSetComplete(
  thumbnailSet: CanvasImageThumbnailSet | null | undefined
): thumbnailSet is CanvasImageThumbnailSet {
  if (!thumbnailSet || thumbnailSet.version !== 1) {
    return false
  }

  return CANVAS_THUMBNAIL_LEVELS.every((level) =>
    thumbnailSet.levels.some((candidate) => candidate.maxSide === level && candidate.src)
  )
}

export function canvasThumbnailSetFromManifest(
  manifest: CanvasThumbnailManifest | null | undefined,
  sourceIdentity: CanvasImageSourceIdentity
): CanvasImageThumbnailSet | null {
  if (!manifest || manifest.version !== 1 || manifest.cacheKey !== sourceIdentity.cacheKey) {
    return null
  }

  const levels = manifest.levels
    .filter((level): level is typeof level & { maxSide: CanvasThumbnailLevelSize } => {
      return CANVAS_THUMBNAIL_LEVELS.includes(level.maxSide as CanvasThumbnailLevelSize)
    })
    .map(
      (level): CanvasImageThumbnailLevel => ({
        maxSide: level.maxSide,
        src: level.src,
        filename: level.filename,
        mimeType: level.mimeType === 'image/webp' ? 'image/webp' : 'image/png',
        width: level.width,
        height: level.height,
        sizeBytes: level.sizeBytes
      })
    )

  const thumbnailSet: CanvasImageThumbnailSet = {
    version: 1,
    cacheKey: manifest.cacheKey,
    sourceIdentity,
    levels,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  }

  return isCanvasThumbnailSetFresh(thumbnailSet, sourceIdentity) ? thumbnailSet : null
}

export function createCanvasThumbnailSet({
  identity,
  levels,
  now = new Date()
}: {
  identity: CanvasImageSourceIdentity
  levels: CanvasImageThumbnailLevel[]
  now?: Date
}): CanvasImageThumbnailSet {
  const timestamp = now.toISOString()
  return {
    version: 1,
    cacheKey: identity.cacheKey,
    sourceIdentity: identity,
    levels: [...levels].sort((left, right) => left.maxSide - right.maxSide),
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

export function validateCanvasThumbnailManifestForIdentity(
  manifest: CanvasThumbnailManifest | null | undefined,
  sourceIdentity: CanvasImageSourceIdentity
): {
  status: 'hit' | 'miss' | 'stale' | 'incomplete'
  thumbnailSet: CanvasImageThumbnailSet | null
} {
  if (!manifest) {
    return { status: 'miss', thumbnailSet: null }
  }

  if (
    manifest.cacheKey !== sourceIdentity.cacheKey ||
    manifest.canonicalPath !== sourceIdentity.canonicalPath ||
    Math.floor(manifest.sourceSizeBytes) !== sourceIdentity.sizeBytes ||
    Math.floor(manifest.sourceLastModifiedMs) !== sourceIdentity.lastModifiedMs
  ) {
    return { status: 'stale', thumbnailSet: null }
  }

  const thumbnailSet = canvasThumbnailSetFromManifest(manifest, sourceIdentity)
  if (!thumbnailSet) {
    return { status: 'incomplete', thumbnailSet: null }
  }

  return { status: 'hit', thumbnailSet }
}

export function canvasThumbnailManifestFromSet(
  thumbnailSet: CanvasImageThumbnailSet
): CanvasThumbnailManifest {
  return {
    version: 1,
    cacheKey: thumbnailSet.cacheKey,
    canonicalPath: thumbnailSet.sourceIdentity.canonicalPath,
    sourceSizeBytes: thumbnailSet.sourceIdentity.sizeBytes,
    sourceLastModifiedMs: thumbnailSet.sourceIdentity.lastModifiedMs,
    levels: thumbnailSet.levels.map((level) => ({
      maxSide: level.maxSide,
      filename: level.filename,
      src: level.src,
      mimeType: level.mimeType,
      width: level.width,
      height: level.height,
      sizeBytes: level.sizeBytes
    })),
    createdAt: thumbnailSet.createdAt,
    updatedAt: thumbnailSet.updatedAt
  }
}
