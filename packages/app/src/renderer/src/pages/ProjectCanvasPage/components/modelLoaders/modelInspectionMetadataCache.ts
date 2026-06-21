export const CANVAS_MODEL3D_METADATA_UPDATED_EVENT = 'canvas:model3d-metadata-updated'

export type ModelInspectionMetadata = {
  vertexCount: number
  faceCount: number
  materialCount: number
  animationCount: number
  boneCount: number
  uvSetCount: number
  normalData: boolean
  tangentData: boolean
}

export const MODEL_INSPECTION_METADATA_CACHE_MAX_ENTRIES = 256

const modelInspectionMetadataCache = new Map<string, ModelInspectionMetadata>()

const trimModelInspectionMetadataCache = () => {
  while (modelInspectionMetadataCache.size > MODEL_INSPECTION_METADATA_CACHE_MAX_ENTRIES) {
    const oldestKey = modelInspectionMetadataCache.keys().next().value
    if (!oldestKey) {
      return
    }
    modelInspectionMetadataCache.delete(oldestKey)
  }
}

export const cloneModelInspectionMetadata = (
  metadata: ModelInspectionMetadata
): ModelInspectionMetadata => ({
  vertexCount: metadata.vertexCount,
  faceCount: metadata.faceCount,
  materialCount: metadata.materialCount,
  animationCount: metadata.animationCount,
  boneCount: metadata.boneCount,
  uvSetCount: metadata.uvSetCount,
  normalData: metadata.normalData,
  tangentData: metadata.tangentData
})

export const readCanvasModel3DInspectionMetadataCache = (cacheKey: string | undefined) => {
  if (!cacheKey) {
    return null
  }

  const metadata = modelInspectionMetadataCache.get(cacheKey)
  if (!metadata) {
    return null
  }

  modelInspectionMetadataCache.delete(cacheKey)
  modelInspectionMetadataCache.set(cacheKey, metadata)
  return cloneModelInspectionMetadata(metadata)
}

export const writeCanvasModel3DInspectionMetadataCache = (
  cacheKey: string | undefined,
  metadata: ModelInspectionMetadata
) => {
  if (!cacheKey) {
    return
  }

  modelInspectionMetadataCache.delete(cacheKey)
  modelInspectionMetadataCache.set(cacheKey, cloneModelInspectionMetadata(metadata))
  trimModelInspectionMetadataCache()
}

export const clearCanvasModel3DInspectionMetadataCache = () => {
  modelInspectionMetadataCache.clear()
}

export const getCanvasModel3DInspectionMetadataCacheCount = () => modelInspectionMetadataCache.size
