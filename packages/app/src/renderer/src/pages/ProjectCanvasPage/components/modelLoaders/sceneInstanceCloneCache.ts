import * as THREE from 'three'
import { SkeletonUtils } from 'three-stdlib'

export const DEFAULT_SCENE_INSTANCE_CLONE_CACHE_LIMIT = 48

export type CachedSceneInstanceAsset = THREE.Object3D | THREE.BufferGeometry

type SceneInstanceCloneCacheEntry = {
  renderSceneData: THREE.Object3D
}

const sceneInstanceCloneCache = new Map<string, SceneInstanceCloneCacheEntry>()
const disposedSceneInstanceMaterials = new WeakSet<THREE.Material>()
const sceneInstanceMaterialLeases = new WeakMap<
  THREE.Object3D,
  { count: number; generation: number }
>()

const getSceneObjectMaterials = (
  object: THREE.Object3D
): THREE.Material | THREE.Material[] | null => {
  if (
    !(object as THREE.Mesh).isMesh &&
    !(object as THREE.Line).isLine &&
    !(object as THREE.Points).isPoints &&
    !(object as THREE.Sprite).isSprite
  ) {
    return null
  }
  return (object as THREE.Mesh).material
}

export function cloneSceneInstanceAsset(sceneData: THREE.BufferGeometry): THREE.BufferGeometry
export function cloneSceneInstanceAsset(sceneData: THREE.Object3D): THREE.Object3D
export function cloneSceneInstanceAsset(
  sceneData: CachedSceneInstanceAsset
): CachedSceneInstanceAsset {
  if (sceneData instanceof THREE.BufferGeometry) return sceneData

  const clone = SkeletonUtils.clone(sceneData)
  const materialClones = new Map<THREE.Material, THREE.Material>()
  const restoreSharedTextureReferences = (
    originalValue: unknown,
    clonedValue: unknown,
    visited = new WeakSet<object>()
  ): void => {
    if (
      !originalValue ||
      !clonedValue ||
      typeof originalValue !== 'object' ||
      typeof clonedValue !== 'object'
    ) {
      return
    }
    if (visited.has(originalValue)) return
    visited.add(originalValue)

    const originalRecord = originalValue as Record<string, unknown>
    const clonedRecord = clonedValue as Record<string, unknown>
    Object.keys(originalRecord).forEach((key) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return

      const originalChild = originalRecord[key]
      if ((originalChild as THREE.Texture | undefined)?.isTexture) {
        clonedRecord[key] = originalChild
        return
      }
      const clonedChild = clonedRecord[key]
      if (
        originalChild &&
        clonedChild &&
        typeof originalChild === 'object' &&
        typeof clonedChild === 'object'
      ) {
        restoreSharedTextureReferences(originalChild, clonedChild, visited)
      }
    })
  }
  const cloneMaterial = (material: THREE.Material): THREE.Material => {
    const existingClone = materialClones.get(material)
    if (existingClone) return existingClone
    const materialClone = material.clone()
    restoreSharedTextureReferences(material, materialClone)
    materialClones.set(material, materialClone)
    return materialClone
  }

  clone.traverse((child) => {
    const materials = getSceneObjectMaterials(child)
    if (!materials) return
    ;(child as THREE.Mesh).material = Array.isArray(materials)
      ? materials.map(cloneMaterial)
      : cloneMaterial(materials)
  })

  return clone
}

export const disposeSceneInstanceMaterials = (sceneData: CachedSceneInstanceAsset): void => {
  if (sceneData instanceof THREE.BufferGeometry) return

  const visitedMaterials = new Set<THREE.Material>()
  sceneData.traverse((child) => {
    const childMaterials = getSceneObjectMaterials(child)
    if (!childMaterials) return

    const materials = Array.isArray(childMaterials) ? childMaterials : [childMaterials]
    materials.forEach((material) => {
      if (
        !material ||
        visitedMaterials.has(material) ||
        disposedSceneInstanceMaterials.has(material)
      ) {
        return
      }
      visitedMaterials.add(material)
      disposedSceneInstanceMaterials.add(material)
      material.dispose()
    })
  })
}

/**
 * Retains an instance across React effect lifetimes. Final disposal is deferred by one microtask,
 * so StrictMode's setup/cleanup/setup probe cannot dispose a memoized instance that immediately
 * becomes live again. Geometry and textures are borrowed from Three/useLoader and are never
 * disposed here; only materials cloned by cloneSceneInstanceAsset are owned by this boundary.
 */
export const retainSceneInstanceMaterials = (sceneData: CachedSceneInstanceAsset): (() => void) => {
  if (sceneData instanceof THREE.BufferGeometry) return () => undefined

  const lease = sceneInstanceMaterialLeases.get(sceneData) ?? { count: 0, generation: 0 }
  lease.count += 1
  lease.generation += 1
  sceneInstanceMaterialLeases.set(sceneData, lease)
  let released = false

  return () => {
    if (released) return
    released = true
    lease.count -= 1
    const releaseGeneration = ++lease.generation
    queueMicrotask(() => {
      if (lease.count !== 0 || lease.generation !== releaseGeneration) return
      sceneInstanceMaterialLeases.delete(sceneData)
      disposeSceneInstanceMaterials(sceneData)
    })
  }
}

const touchSceneInstanceCloneCacheEntry = (
  cacheKey: string,
  entry: SceneInstanceCloneCacheEntry
): void => {
  sceneInstanceCloneCache.delete(cacheKey)
  sceneInstanceCloneCache.set(cacheKey, entry)
}

export const readCachedSceneInstanceClone = (
  cacheKey: string | undefined
): THREE.Object3D | null => {
  if (!cacheKey) return null
  const cacheEntry = sceneInstanceCloneCache.get(cacheKey)
  if (!cacheEntry) return null

  touchSceneInstanceCloneCacheEntry(cacheKey, cacheEntry)
  return cloneSceneInstanceAsset(cacheEntry.renderSceneData)
}

export const peekCachedSceneInstanceCloneTemplate = (
  cacheKey: string | undefined
): THREE.Object3D | null => {
  if (!cacheKey) return null
  const cacheEntry = sceneInstanceCloneCache.get(cacheKey)
  if (!cacheEntry) return null

  touchSceneInstanceCloneCacheEntry(cacheKey, cacheEntry)
  return cacheEntry.renderSceneData
}

export const hasCachedSceneInstanceClone = (cacheKey: string | undefined): boolean =>
  Boolean(cacheKey && sceneInstanceCloneCache.has(cacheKey))

export const writeCachedSceneInstanceClone = ({
  cacheKey,
  renderSceneData,
  maxEntries = DEFAULT_SCENE_INSTANCE_CLONE_CACHE_LIMIT
}: {
  cacheKey: string | undefined
  renderSceneData: CachedSceneInstanceAsset
  maxEntries?: number
}): void => {
  if (!cacheKey) return

  // Standalone geometry is borrowed loader state and has no owned material state to cache.
  if (renderSceneData instanceof THREE.BufferGeometry) return

  const previousEntry = sceneInstanceCloneCache.get(cacheKey)
  if (previousEntry) disposeSceneInstanceMaterials(previousEntry.renderSceneData)
  touchSceneInstanceCloneCacheEntry(cacheKey, {
    renderSceneData: cloneSceneInstanceAsset(renderSceneData)
  })

  while (sceneInstanceCloneCache.size > maxEntries) {
    const oldestCacheKey = sceneInstanceCloneCache.keys().next().value
    if (oldestCacheKey === undefined) break
    const evictedEntry = sceneInstanceCloneCache.get(oldestCacheKey)
    sceneInstanceCloneCache.delete(oldestCacheKey)
    if (evictedEntry) disposeSceneInstanceMaterials(evictedEntry.renderSceneData)
  }
}

export const clearCachedSceneInstanceClones = (): void => {
  sceneInstanceCloneCache.forEach(({ renderSceneData }) =>
    disposeSceneInstanceMaterials(renderSceneData)
  )
  sceneInstanceCloneCache.clear()
}

export const getCachedSceneInstanceCloneCount = (): number => sceneInstanceCloneCache.size
