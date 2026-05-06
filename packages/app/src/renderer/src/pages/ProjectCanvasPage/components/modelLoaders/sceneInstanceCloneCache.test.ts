import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'

import {
  clearCachedSceneInstanceClones,
  getCachedSceneInstanceCloneCount,
  readCachedSceneInstanceClone,
  writeCachedSceneInstanceClone
} from './sceneInstanceCloneCache'

describe('sceneInstanceCloneCache', () => {
  afterEach(() => {
    clearCachedSceneInstanceClones()
  })

  it('returns a fresh clone for the same cache key and cached template object', () => {
    const renderSceneData = new THREE.Group()
    renderSceneData.name = 'template-group'

    writeCachedSceneInstanceClone({
      cacheKey: 'stage:model-1',
      renderSceneData
    })

    const firstRead = readCachedSceneInstanceClone('stage:model-1')
    const secondRead = readCachedSceneInstanceClone('stage:model-1')

    expect(firstRead).toBeInstanceOf(THREE.Group)
    expect(firstRead).not.toBe(renderSceneData)
    expect(secondRead).toBeInstanceOf(THREE.Group)
    expect(secondRead).not.toBe(renderSceneData)
    expect(secondRead).not.toBe(firstRead)
    expect(firstRead?.name).toBe('template-group')
    expect(secondRead?.name).toBe('template-group')
  })

  it('reuses the cached template across separate scene requests that share the cache key', () => {
    writeCachedSceneInstanceClone({
      cacheKey: 'stage:model-1',
      renderSceneData: new THREE.Group()
    })

    const firstRead = readCachedSceneInstanceClone('stage:model-1')
    const secondRead = readCachedSceneInstanceClone('stage:model-1')

    expect(firstRead).toBeInstanceOf(THREE.Group)
    expect(secondRead).toBeInstanceOf(THREE.Group)
    expect(secondRead).not.toBe(firstRead)
  })

  it('returns cloned geometries for cached buffer geometry assets', () => {
    const renderSceneData = new THREE.BoxGeometry(2, 4, 6)

    writeCachedSceneInstanceClone({
      cacheKey: 'stage:model-geometry',
      renderSceneData
    })

    const firstRead = readCachedSceneInstanceClone('stage:model-geometry')
    const secondRead = readCachedSceneInstanceClone('stage:model-geometry')

    expect(firstRead).toBeInstanceOf(THREE.BufferGeometry)
    expect(secondRead).toBeInstanceOf(THREE.BufferGeometry)
    expect(firstRead).not.toBe(renderSceneData)
    expect(secondRead).not.toBe(renderSceneData)
    expect(secondRead).not.toBe(firstRead)
  })

  it('evicts the oldest entries when the cache limit is exceeded', () => {
    writeCachedSceneInstanceClone({
      cacheKey: 'entry-a',
      renderSceneData: new THREE.Group(),
      maxEntries: 2
    })
    writeCachedSceneInstanceClone({
      cacheKey: 'entry-b',
      renderSceneData: new THREE.Group(),
      maxEntries: 2
    })
    writeCachedSceneInstanceClone({
      cacheKey: 'entry-c',
      renderSceneData: new THREE.Group(),
      maxEntries: 2
    })

    expect(getCachedSceneInstanceCloneCount()).toBe(2)
    expect(readCachedSceneInstanceClone('entry-a')).toBeNull()
  })
})
