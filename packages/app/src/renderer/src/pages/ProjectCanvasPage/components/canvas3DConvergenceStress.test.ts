import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'

import type { CanvasModel3DItem } from '../types'
import {
  resolveCanvas3DStageActivatedIds,
  resolveCanvas3DStageActivationBatchPolicy,
  resolveCanvas3DStageLoadQueue,
  resolveCanvas3DStageNextActivationBatch
} from './canvas3DStageLoadQueue'
import {
  clearCachedSceneInstanceClones,
  getCachedSceneInstanceCloneCount,
  readCachedSceneInstanceClone,
  writeCachedSceneInstanceClone
} from './modelLoaders/sceneInstanceCloneCache'
import { getSceneInstanceCloneCacheKey } from './modelLoaders/sceneInstanceCloneCacheKey'

function createModelItem(
  id: string,
  overrides: Partial<CanvasModel3DItem> = {}
): CanvasModel3DItem {
  return {
    id,
    type: 'model3d',
    src: `https://example.com/${id}.glb`,
    fileName: `${id}.glb`,
    x: 0,
    y: 0,
    width: 240,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

describe('canvas3D convergence stress', () => {
  afterEach(() => {
    clearCachedSceneInstanceClones()
  })

  it('reuses canonical clone cache keys across repeated stage and viewer requests', () => {
    const sessionKey = 'canvas:thread:project-4:thread:agent-2'
    const assetFamilies = [
      {
        src: 'https://example.com/shared-a.glb',
        fileName: 'shared-a.glb',
        textures: {
          albedo: 'blob:shared-a-albedo',
          normal: 'blob:shared-a-normal'
        }
      },
      {
        src: 'https://example.com/shared-b.fbx',
        fileName: 'shared-b.fbx',
        textures: {
          albedo: 'blob:shared-b-albedo'
        }
      },
      {
        src: 'https://example.com/shared-c.obj',
        fileName: 'shared-c.obj',
        textures: {
          albedo: 'blob:shared-c-albedo',
          roughness: 'blob:shared-c-roughness'
        }
      },
      {
        src: 'https://example.com/shared-d.gltf',
        fileName: 'shared-d.gltf',
        textures: undefined
      }
    ] as const

    const requestedKeys: string[] = []

    for (let index = 0; index < 32; index += 1) {
      const assetFamily = assetFamilies[index % assetFamilies.length]
      const cacheKey = getSceneInstanceCloneCacheKey({
        sessionKey,
        src: assetFamily.src,
        fileName: assetFamily.fileName,
        itemId: `alias-${index}`,
        textures: assetFamily.textures
      })
      requestedKeys.push(cacheKey)

      if (!readCachedSceneInstanceClone(cacheKey)) {
        const renderSceneData = new THREE.Group()
        renderSceneData.name = cacheKey
        writeCachedSceneInstanceClone({
          cacheKey,
          renderSceneData,
          maxEntries: 48
        })
      }
    }

    expect(new Set(requestedKeys).size).toBe(assetFamilies.length)
    expect(getCachedSceneInstanceCloneCount()).toBe(assetFamilies.length)

    for (const cacheKey of requestedKeys) {
      expect(readCachedSceneInstanceClone(cacheKey)?.name).toBe(cacheKey)
    }
  })

  it('keeps recently reused clone entries resident while evicting colder assets under pressure', () => {
    const cacheKeys = Array.from({ length: 6 }, (_, index) =>
      getSceneInstanceCloneCacheKey({
        sessionKey: 'canvas:thread:project-4:thread:agent-2',
        src: `https://example.com/hot-${index}.glb`,
        fileName: `hot-${index}.glb`,
        itemId: `item-${index}`
      })
    )

    cacheKeys.slice(0, 4).forEach((cacheKey) => {
      writeCachedSceneInstanceClone({
        cacheKey,
        renderSceneData: new THREE.Group(),
        maxEntries: 4
      })
    })

    const hotEntryA = readCachedSceneInstanceClone(cacheKeys[0])
    const hotEntryB = readCachedSceneInstanceClone(cacheKeys[1])

    writeCachedSceneInstanceClone({
      cacheKey: cacheKeys[4],
      renderSceneData: new THREE.Group(),
      maxEntries: 4
    })
    writeCachedSceneInstanceClone({
      cacheKey: cacheKeys[5],
      renderSceneData: new THREE.Group(),
      maxEntries: 4
    })

    expect(getCachedSceneInstanceCloneCount()).toBe(4)
    expect(readCachedSceneInstanceClone(cacheKeys[0])).not.toBeNull()
    expect(readCachedSceneInstanceClone(cacheKeys[0])).not.toBe(hotEntryA)
    expect(readCachedSceneInstanceClone(cacheKeys[1])).not.toBeNull()
    expect(readCachedSceneInstanceClone(cacheKeys[1])).not.toBe(hotEntryB)
    expect(readCachedSceneInstanceClone(cacheKeys[2])).toBeNull()
    expect(readCachedSceneInstanceClone(cacheKeys[3])).toBeNull()
    expect(readCachedSceneInstanceClone(cacheKeys[4])).toBeInstanceOf(THREE.Group)
    expect(readCachedSceneInstanceClone(cacheKeys[5])).toBeInstanceOf(THREE.Group)
  })

  it('activates heavy 3D scenes in bounded batches while keeping tiny previews loadable', () => {
    const heavyTextures = {
      albedo: 'blob:heavy-albedo',
      normal: 'blob:heavy-normal',
      roughness: 'blob:heavy-roughness'
    }
    const selectedLightItem = createModelItem('selected-light', {
      fileName: 'selected-light.glb',
      width: 320,
      height: 220,
      zIndex: 999
    })
    const heavyItems = Array.from({ length: 10 }, (_, index) =>
      createModelItem(`heavy-${index}`, {
        fileName: `heavy-${index}.fbx`,
        src: `https://example.com/heavy-${index}.fbx`,
        width: 640,
        height: 480,
        textures: heavyTextures,
        zIndex: 100 - index
      })
    )
    const tinyPreviewItems = Array.from({ length: 3 }, (_, index) =>
      createModelItem(`tiny-${index}`, {
        width: 24,
        height: 24,
        zIndex: index
      })
    )

    const { prioritizedLoadIds, prioritizedLoadItems, placeholderOnlyIds, immediateLoadLimit } =
      resolveCanvas3DStageLoadQueue({
        items: [selectedLightItem, ...heavyItems, ...tinyPreviewItems],
        selectedIds: new Set([selectedLightItem.id]),
        stageScale: 1
      })

    expect(prioritizedLoadIds[0]).toBe(selectedLightItem.id)
    expect(Array.from(placeholderOnlyIds)).toEqual([])
    expect(prioritizedLoadIds.slice(1, 4)).toEqual(['tiny-2', 'tiny-1', 'tiny-0'])
    expect(immediateLoadLimit).toBe(4)

    const activatedIds = resolveCanvas3DStageActivatedIds({
      prioritizedLoadIds,
      previousActivatedIds: new Set(),
      immediateLoadLimit
    })
    const observedPolicies: Array<{ batchSize: number; delayMs: number }> = []
    let guard = 0

    while (activatedIds.size < prioritizedLoadIds.length && guard < prioritizedLoadIds.length * 2) {
      const policy = resolveCanvas3DStageActivationBatchPolicy({
        prioritizedItems: prioritizedLoadItems,
        activatedIds
      })
      const nextBatch = resolveCanvas3DStageNextActivationBatch({
        prioritizedLoadIds,
        activatedIds,
        batchSize: policy.batchSize
      })

      observedPolicies.push(policy)
      expect(nextBatch.length).toBeGreaterThan(0)
      nextBatch.forEach((itemId) => activatedIds.add(itemId))
      guard += 1
    }

    expect(guard).toBe(prioritizedLoadIds.length - immediateLoadLimit)
    expect(Array.from(activatedIds)).toEqual(prioritizedLoadIds)
    expect(observedPolicies.every((policy) => policy.batchSize === 1)).toBe(true)
    expect(observedPolicies.every((policy) => policy.delayMs === 180)).toBe(true)
  })
})
