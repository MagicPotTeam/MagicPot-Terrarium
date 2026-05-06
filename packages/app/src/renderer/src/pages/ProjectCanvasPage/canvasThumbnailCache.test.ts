import { describe, expect, it } from 'vitest'

import {
  buildCanvasImageSourceIdentity,
  buildCanvasThumbnailCacheKey,
  canvasThumbnailManifestFromSet,
  createCanvasThumbnailSet,
  isCanvasThumbnailSetComplete,
  pickBestCanvasThumbnailLevel,
  validateCanvasThumbnailManifestForIdentity
} from './canvasThumbnailCache'
import type {
  CanvasImageSourceIdentity,
  CanvasImageThumbnailLevel,
  CanvasThumbnailLevelSize
} from './canvasThumbnailTypes'

function createIdentity(
  overrides: Partial<CanvasImageSourceIdentity> = {}
): CanvasImageSourceIdentity {
  const identity = buildCanvasImageSourceIdentity({
    canonicalPath: overrides.canonicalPath ?? 'C:/Images/ref.png',
    sizeBytes: overrides.sizeBytes ?? 100,
    lastModifiedMs: overrides.lastModifiedMs ?? 200
  })
  if (!identity) {
    throw new Error('Expected test source identity to be valid.')
  }
  return identity
}

function createLevel(maxSide: CanvasThumbnailLevelSize): CanvasImageThumbnailLevel {
  return {
    maxSide,
    width: maxSide,
    height: Math.max(1, Math.floor(maxSide / 2)),
    mimeType: 'image/webp',
    filename: `${maxSide}.webp`,
    src: `local-media:///thumb/${maxSide}.webp`,
    sizeBytes: maxSide * 10
  }
}

function createCompleteLevels(): CanvasImageThumbnailLevel[] {
  return ([128, 256, 512, 1024, 2048] as const).map(createLevel)
}

describe('canvasThumbnailCache', () => {
  it('builds a stable hashed cache key from canonical path, size, and mtime', () => {
    const input = {
      canonicalPath: 'C:\\Images\\Ref.png',
      sizeBytes: 1234,
      lastModifiedMs: 9876
    }

    expect(buildCanvasThumbnailCacheKey(input)).toBe(buildCanvasThumbnailCacheKey(input))
    expect(buildCanvasThumbnailCacheKey(input)).toMatch(/^thumb-[0-9a-f]{16}$/)
    expect(buildCanvasThumbnailCacheKey({ ...input, sizeBytes: 1235 })).not.toBe(
      buildCanvasThumbnailCacheKey(input)
    )
    expect(buildCanvasThumbnailCacheKey({ ...input, lastModifiedMs: 9877 })).not.toBe(
      buildCanvasThumbnailCacheKey(input)
    )
  })

  it('normalizes separator style for cache identity hashing', () => {
    expect(
      buildCanvasThumbnailCacheKey({
        canonicalPath: 'C:\\Images\\Ref.png',
        sizeBytes: 1,
        lastModifiedMs: 2
      })
    ).toBe(
      buildCanvasThumbnailCacheKey({
        canonicalPath: 'c:/Images/Ref.png',
        sizeBytes: 1,
        lastModifiedMs: 2
      })
    )
  })

  it('detects stale manifests when source size or mtime changes', () => {
    const identity = createIdentity()
    const thumbnailSet = createCanvasThumbnailSet({
      identity,
      levels: createCompleteLevels()
    })
    const manifest = canvasThumbnailManifestFromSet(thumbnailSet)

    expect(validateCanvasThumbnailManifestForIdentity(manifest, identity).status).toBe('hit')

    const changedSize = createIdentity({
      canonicalPath: 'C:/Images/ref.png',
      sizeBytes: 101,
      lastModifiedMs: 200
    })
    expect(validateCanvasThumbnailManifestForIdentity(manifest, changedSize).status).toBe('stale')

    const changedMtime = createIdentity({
      canonicalPath: 'C:/Images/ref.png',
      sizeBytes: 100,
      lastModifiedMs: 201
    })
    expect(validateCanvasThumbnailManifestForIdentity(manifest, changedMtime).status).toBe('stale')
  })

  it('rejects incomplete warm cache manifests', () => {
    const identity = createIdentity()
    const thumbnailSet = createCanvasThumbnailSet({
      identity,
      levels: [createLevel(128), createLevel(512)]
    })
    const manifest = canvasThumbnailManifestFromSet(thumbnailSet)

    expect(isCanvasThumbnailSetComplete(thumbnailSet)).toBe(false)
    expect(validateCanvasThumbnailManifestForIdentity(manifest, identity).status).toBe('incomplete')
  })

  it('picks the smallest thumbnail level that covers the requested max side', () => {
    const identity = createIdentity()
    const thumbnailSet = createCanvasThumbnailSet({
      identity,
      levels: [
        createLevel(512),
        createLevel(128),
        createLevel(2048),
        createLevel(256),
        createLevel(1024)
      ]
    })

    expect(pickBestCanvasThumbnailLevel(thumbnailSet, 64)?.maxSide).toBe(128)
    expect(pickBestCanvasThumbnailLevel(thumbnailSet, 192)?.maxSide).toBe(256)
    expect(pickBestCanvasThumbnailLevel(thumbnailSet, 384)?.maxSide).toBe(512)
    expect(pickBestCanvasThumbnailLevel(thumbnailSet, 900)?.maxSide).toBe(1024)
    expect(pickBestCanvasThumbnailLevel(thumbnailSet, 1500)?.maxSide).toBe(2048)
    expect(pickBestCanvasThumbnailLevel(thumbnailSet, 4096)?.maxSide).toBe(2048)
  })
})
