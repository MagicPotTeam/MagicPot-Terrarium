import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'

import {
  clearCanvas3DStageModelBoundsCache,
  createCanvas3DStageModelBounds,
  getCanvas3DStageModelBoundsCacheCount,
  readCanvas3DStageModelBoundsCache,
  writeCanvas3DStageModelBoundsCache
} from './canvas3DStageModelBoundsCache'

describe('canvas3DStageModelBoundsCache', () => {
  afterEach(() => {
    clearCanvas3DStageModelBoundsCache()
  })

  it('returns a cloned bounds snapshot for a cached key', () => {
    writeCanvas3DStageModelBoundsCache(
      'stage:model-a',
      createCanvas3DStageModelBounds({
        center: new THREE.Vector3(1, 2, 3),
        size: new THREE.Vector3(4, 5, 6),
        radius: 7
      })
    )

    const cachedBounds = readCanvas3DStageModelBoundsCache('stage:model-a')
    expect(cachedBounds).toEqual({
      center: new THREE.Vector3(1, 2, 3),
      size: new THREE.Vector3(4, 5, 6),
      radius: 7
    })
    expect(cachedBounds?.center).not.toBe(
      readCanvas3DStageModelBoundsCache('stage:model-a')?.center
    )
  })

  it('ignores undefined cache keys', () => {
    writeCanvas3DStageModelBoundsCache(undefined, createCanvas3DStageModelBounds())

    expect(readCanvas3DStageModelBoundsCache(undefined)).toBeNull()
    expect(getCanvas3DStageModelBoundsCacheCount()).toBe(0)
  })
})
