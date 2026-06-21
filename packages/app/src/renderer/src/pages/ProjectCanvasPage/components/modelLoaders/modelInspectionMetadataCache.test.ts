import { afterEach, describe, expect, it } from 'vitest'

import {
  MODEL_INSPECTION_METADATA_CACHE_MAX_ENTRIES,
  clearCanvasModel3DInspectionMetadataCache,
  getCanvasModel3DInspectionMetadataCacheCount,
  readCanvasModel3DInspectionMetadataCache,
  writeCanvasModel3DInspectionMetadataCache,
  type ModelInspectionMetadata
} from './modelInspectionMetadataCache'

const createMetadata = (seed = 0): ModelInspectionMetadata => ({
  vertexCount: seed + 1,
  faceCount: seed + 2,
  materialCount: seed + 3,
  animationCount: seed + 4,
  boneCount: seed + 5,
  uvSetCount: seed + 6,
  normalData: seed % 2 === 0,
  tangentData: seed % 2 === 1
})

describe('modelInspectionMetadataCache', () => {
  afterEach(() => {
    clearCanvasModel3DInspectionMetadataCache()
  })

  it('returns cloned metadata snapshots for cached keys', () => {
    writeCanvasModel3DInspectionMetadataCache('model:a', createMetadata(10))

    const firstRead = readCanvasModel3DInspectionMetadataCache('model:a')
    const secondRead = readCanvasModel3DInspectionMetadataCache('model:a')

    expect(firstRead).toEqual(createMetadata(10))
    expect(secondRead).toEqual(createMetadata(10))
    expect(firstRead).not.toBe(secondRead)
  })

  it('ignores undefined cache keys', () => {
    writeCanvasModel3DInspectionMetadataCache(undefined, createMetadata())

    expect(readCanvasModel3DInspectionMetadataCache(undefined)).toBeNull()
    expect(getCanvasModel3DInspectionMetadataCacheCount()).toBe(0)
  })

  it('bounds cached metadata with least-recently-used eviction', () => {
    for (let index = 0; index < MODEL_INSPECTION_METADATA_CACHE_MAX_ENTRIES; index += 1) {
      writeCanvasModel3DInspectionMetadataCache(`model:${index}`, createMetadata(index))
    }

    expect(readCanvasModel3DInspectionMetadataCache('model:0')).toEqual(createMetadata(0))
    writeCanvasModel3DInspectionMetadataCache('model:overflow', createMetadata(999))

    expect(getCanvasModel3DInspectionMetadataCacheCount()).toBe(
      MODEL_INSPECTION_METADATA_CACHE_MAX_ENTRIES
    )
    expect(readCanvasModel3DInspectionMetadataCache('model:1')).toBeNull()
    expect(readCanvasModel3DInspectionMetadataCache('model:0')).toEqual(createMetadata(0))
    expect(readCanvasModel3DInspectionMetadataCache('model:overflow')).toEqual(createMetadata(999))
  })
})
