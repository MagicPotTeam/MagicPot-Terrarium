import * as THREE from 'three'
import { SkeletonUtils } from 'three-stdlib'

export const DEFAULT_SCENE_INSTANCE_CLONE_CACHE_LIMIT = 48

export type CachedSceneInstanceAsset = THREE.Object3D | THREE.BufferGeometry

type SceneInstanceCloneCacheEntry = {
  renderSceneData: CachedSceneInstanceAsset
}

const sceneInstanceCloneCache = new Map<string, SceneInstanceCloneCacheEntry>()

const cloneSceneInstanceTemplate = (sceneData: CachedSceneInstanceAsset) =>
  sceneData instanceof THREE.BufferGeometry ? sceneData.clone() : SkeletonUtils.clone(sceneData)

const touchSceneInstanceCloneCacheEntry = (
  cacheKey: string,
  entry: SceneInstanceCloneCacheEntry
) => {
  sceneInstanceCloneCache.delete(cacheKey)
  sceneInstanceCloneCache.set(cacheKey, entry)
}

export const readCachedSceneInstanceClone = (cacheKey: string | undefined) => {
  if (!cacheKey) return null

  const cacheEntry = sceneInstanceCloneCache.get(cacheKey)
  if (!cacheEntry) {
    return null
  }

  touchSceneInstanceCloneCacheEntry(cacheKey, cacheEntry)
  return cloneSceneInstanceTemplate(cacheEntry.renderSceneData)
}

export const peekCachedSceneInstanceCloneTemplate = (cacheKey: string | undefined) => {
  if (!cacheKey) return null

  const cacheEntry = sceneInstanceCloneCache.get(cacheKey)
  if (!cacheEntry) {
    return null
  }

  touchSceneInstanceCloneCacheEntry(cacheKey, cacheEntry)
  return cacheEntry.renderSceneData
}

export const hasCachedSceneInstanceClone = (cacheKey: string | undefined) =>
  Boolean(cacheKey && sceneInstanceCloneCache.has(cacheKey))

export const writeCachedSceneInstanceClone = ({
  cacheKey,
  renderSceneData,
  maxEntries = DEFAULT_SCENE_INSTANCE_CLONE_CACHE_LIMIT
}: {
  cacheKey: string | undefined
  renderSceneData: CachedSceneInstanceAsset
  maxEntries?: number
}) => {
  if (!cacheKey) return

  touchSceneInstanceCloneCacheEntry(cacheKey, {
    renderSceneData
  })

  while (sceneInstanceCloneCache.size > maxEntries) {
    const oldestCacheKey = sceneInstanceCloneCache.keys().next().value
    if (oldestCacheKey === undefined) break
    sceneInstanceCloneCache.delete(oldestCacheKey)
  }
}

export const clearCachedSceneInstanceClones = () => {
  sceneInstanceCloneCache.clear()
}

export const getCachedSceneInstanceCloneCount = () => sceneInstanceCloneCache.size
