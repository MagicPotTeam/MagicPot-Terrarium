import type { CanvasModel3DItem } from '../types'
import {
  DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
  getSceneInstanceCloneCacheKey
} from './modelLoaders/sceneInstanceCloneCacheKey'
import {
  readCanvasModel3DInspectionMetadataCache,
  type ModelInspectionMetadata
} from './modelLoaders/modelInspectionMetadataCache'

export const hasCanvas3DStageItems = (items: readonly CanvasModel3DItem[]) => items.length > 0

export const readCanvasModel3DInspectionMetadata = ({
  item,
  sessionKey
}: {
  item: CanvasModel3DItem
  sessionKey?: string
}): ModelInspectionMetadata | null => {
  const resolvedSessionKey = sessionKey?.trim() || DEFAULT_CANVAS_MODEL3D_SESSION_KEY
  return readCanvasModel3DInspectionMetadataCache(
    getSceneInstanceCloneCacheKey({
      sessionKey: resolvedSessionKey,
      src: item.src,
      fileName: item.fileName,
      itemId: item.id,
      textures: item.textures
    })
  )
}
