import * as THREE from 'three'

import type { ModelBounds } from './modelLoaders/shared'

type Canvas3DStageModelBoundsCacheEntry = ModelBounds

const canvas3DStageModelBoundsCache = new Map<string, Canvas3DStageModelBoundsCacheEntry>()

const cloneModelBounds = (bounds: ModelBounds): ModelBounds => ({
  center: bounds.center.clone(),
  size: bounds.size.clone(),
  radius: bounds.radius
})

export const readCanvas3DStageModelBoundsCache = (cacheKey: string | undefined) => {
  if (!cacheKey) {
    return null
  }

  const cachedBounds = canvas3DStageModelBoundsCache.get(cacheKey)
  return cachedBounds ? cloneModelBounds(cachedBounds) : null
}

export const writeCanvas3DStageModelBoundsCache = (
  cacheKey: string | undefined,
  bounds: ModelBounds
) => {
  if (!cacheKey) {
    return
  }

  canvas3DStageModelBoundsCache.set(cacheKey, cloneModelBounds(bounds))
}

export const clearCanvas3DStageModelBoundsCache = () => {
  canvas3DStageModelBoundsCache.clear()
}

export const getCanvas3DStageModelBoundsCacheCount = () => canvas3DStageModelBoundsCache.size

export const createCanvas3DStageModelBounds = ({
  center = new THREE.Vector3(),
  size = new THREE.Vector3(1, 1, 1),
  radius = size.length() / 2
}: Partial<ModelBounds> = {}): ModelBounds => ({
  center,
  size,
  radius
})
