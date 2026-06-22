import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCanvas3DStageModelBounds } from './canvas3DStageModelBoundsCache'
import {
  clearCanvas3DStagePreviewTextureCache,
  getCanvas3DStagePreviewTextureCacheCount,
  getCanvas3DStagePreviewTextureKey,
  readCanvas3DStagePreviewTexture,
  resolveCanvas3DStagePreviewShape,
  writeCanvas3DStagePreviewTexture
} from './canvas3DStagePreviewTextureCache'

describe('canvas3DStagePreviewTextureCache', () => {
  afterEach(() => {
    clearCanvas3DStagePreviewTextureCache()
    vi.restoreAllMocks()
  })

  it('normalizes preview shape ratios from model bounds', () => {
    expect(
      resolveCanvas3DStagePreviewShape(
        createCanvas3DStageModelBounds({
          size: new THREE.Vector3(2, 6, 0.5)
        })
      )
    ).toEqual({
      widthRatio: 0.33,
      heightRatio: 1,
      depthRatio: 0.24
    })
  })

  it('includes extension and normalized shape in preview cache keys', () => {
    expect(
      getCanvas3DStagePreviewTextureKey({
        instanceCacheKey: 'stage|item-1',
        fileName: 'spaceship.glb',
        bounds: createCanvas3DStageModelBounds({
          size: new THREE.Vector3(3, 4, 2)
        })
      })
    ).toBe('stage|item-1|glb|0.75|1.00|0.50')
  })

  it('reuses cached preview textures for repeated reads', () => {
    const bounds = createCanvas3DStageModelBounds({
      size: new THREE.Vector3(3, 5, 2)
    })
    const cacheKey = getCanvas3DStagePreviewTextureKey({
      instanceCacheKey: 'stage|item-2',
      fileName: 'robot.fbx',
      bounds
    })
    const texture = new THREE.Texture()

    const firstTexture = writeCanvas3DStagePreviewTexture({
      cacheKey,
      texture
    })
    const secondTexture = readCanvas3DStagePreviewTexture(cacheKey)

    expect(firstTexture).not.toBeNull()
    expect(firstTexture).toBe(secondTexture)
    expect(firstTexture).toBe(texture)
    expect(getCanvas3DStagePreviewTextureCacheCount()).toBe(1)
  })

  it('evicts over-limit preview textures and disposes the removed texture', () => {
    const disposeSpies: ReturnType<typeof vi.spyOn>[] = []

    for (let index = 0; index < 49; index += 1) {
      const texture = new THREE.Texture()
      disposeSpies.push(vi.spyOn(texture, 'dispose'))

      writeCanvas3DStagePreviewTexture({
        cacheKey: `stage|item-${index}|glb|1.00|1.00|1.00`,
        texture
      })
    }

    expect(getCanvas3DStagePreviewTextureCacheCount()).toBe(48)
    expect(disposeSpies[0]).toHaveBeenCalledTimes(1)
    expect(disposeSpies.slice(1).every((disposeSpy) => disposeSpy.mock.calls.length === 0)).toBe(
      true
    )
  })
})
