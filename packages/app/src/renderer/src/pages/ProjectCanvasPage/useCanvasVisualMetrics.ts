import { useCallback } from 'react'
import type { RefObject } from 'react'
import type { CanvasTargetAssetMetadata } from '@shared/canvasTarget'
import type { CanvasExportBounds } from './groupPlaybackUtils'
import type { CanvasItem } from './types'
import { findCanvasItemOverlayElement } from './canvasDomOverlayLookup'
import { buildCanvasTargetAssetMetadata } from './canvasTargetWorkflow'
import { getCanvasItemBounds } from './projectCanvasPageShared'
import {
  DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
  getSceneInstanceCloneCacheKey
} from './components/modelLoaders/sceneInstanceCloneCacheKey'
import { readCanvasModel3DInspectionMetadataCache } from './components/modelLoaders/modelInspectionMetadataCache'
import {
  summarizeProjectCanvasRuntimeSurfaces,
  type ProjectCanvasRuntimeSurfaceSummary
} from './projectCanvasRenderBoundary'

export type CanvasRenderSurfaceSummary = ProjectCanvasRuntimeSurfaceSummary

const EMPTY_CANVAS_LOADED_IMAGE_IDS = new Set<string>()
const EMPTY_CANVAS_RESIDENT_IMAGE_IDS = new Set<string>()

type StageNodeLike = {
  getClientRect?: () => CanvasExportBounds
}

type StageLike = {
  findOne?: (selector: string) => StageNodeLike | null | undefined
}

type StageRefLike = {
  getStage?: () => StageLike | null
}

type UseCanvasVisualMetricsOptions = {
  canvasContainerRef: RefObject<HTMLDivElement | null>
  renderSurfaceRuntime?: {
    cropTargetId?: string | null
    webglReady?: boolean
    loadedImageIds?: ReadonlySet<string>
    residentImageIds?: ReadonlySet<string>
  }
  stagePos: { x: number; y: number }
  stageRef: RefObject<StageRefLike | null>
  stageScale: number
  sessionKey?: string
}

export function useCanvasVisualMetrics({
  canvasContainerRef,
  renderSurfaceRuntime,
  sessionKey,
  stagePos,
  stageRef,
  stageScale
}: UseCanvasVisualMetricsOptions) {
  const resolvedSessionKey = sessionKey?.trim() || DEFAULT_CANVAS_MODEL3D_SESSION_KEY
  const stageRectToCanvasBounds = useCallback(
    (rect: CanvasExportBounds): CanvasExportBounds => {
      const scale = Math.max(Math.abs(stageScale), 0.0001)
      return {
        x: (rect.x - stagePos.x) / scale,
        y: (rect.y - stagePos.y) / scale,
        width: rect.width / scale,
        height: rect.height / scale
      }
    },
    [stagePos.x, stagePos.y, stageScale]
  )

  const canvasBoundsToStageRect = useCallback(
    (bounds: CanvasExportBounds | null): CanvasExportBounds | null => {
      if (!bounds) return null

      const scale = Math.max(Math.abs(stageScale), 0.0001)
      return {
        x: stagePos.x + bounds.x * scale,
        y: stagePos.y + bounds.y * scale,
        width: bounds.width * scale,
        height: bounds.height * scale
      }
    },
    [stagePos.x, stagePos.y, stageScale]
  )

  const getOverlayStageRect = useCallback(
    (item: CanvasItem): CanvasExportBounds | null => {
      const container = canvasContainerRef.current
      if (!container) return null

      const element = findCanvasItemOverlayElement(container, item)
      if (!element) return null

      const containerRect = container.getBoundingClientRect()
      const elementRect = element.getBoundingClientRect()

      return {
        x: elementRect.left - containerRect.left,
        y: elementRect.top - containerRect.top,
        width: elementRect.width,
        height: elementRect.height
      }
    },
    [canvasContainerRef]
  )

  const getCanvasItemVisualBounds = useCallback(
    (item: CanvasItem): CanvasExportBounds | null => {
      if (
        item.type === 'image' ||
        item.type === 'video' ||
        item.type === 'model3d' ||
        item.type === 'html'
      ) {
        const overlayRect = getOverlayStageRect(item)
        if (overlayRect && overlayRect.width > 0 && overlayRect.height > 0) {
          return stageRectToCanvasBounds(overlayRect)
        }
      }

      const stage = stageRef.current?.getStage?.()
      const node = stage?.findOne?.(`#${item.id}`)
      const nodeRect = node?.getClientRect?.()
      if (nodeRect) {
        if (nodeRect.width > 0 && nodeRect.height > 0) {
          return stageRectToCanvasBounds(nodeRect as CanvasExportBounds)
        }
      }

      const fallback = getCanvasItemBounds(item)
      return {
        x: fallback.minX,
        y: fallback.minY,
        width: Math.max(1, fallback.maxX - fallback.minX),
        height: Math.max(1, fallback.maxY - fallback.minY)
      }
    },
    [getOverlayStageRect, stageRectToCanvasBounds, stageRef]
  )

  const getCanvasItemsVisualBounds = useCallback(
    (targetItems: CanvasItem[]): CanvasExportBounds | null => {
      if (targetItems.length === 0) return null

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity

      for (const item of targetItems) {
        const bounds = getCanvasItemVisualBounds(item)
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue
        minX = Math.min(minX, bounds.x)
        minY = Math.min(minY, bounds.y)
        maxX = Math.max(maxX, bounds.x + bounds.width)
        maxY = Math.max(maxY, bounds.y + bounds.height)
      }

      if (
        !Number.isFinite(minX) ||
        !Number.isFinite(minY) ||
        !Number.isFinite(maxX) ||
        !Number.isFinite(maxY)
      ) {
        return null
      }

      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      }
    },
    [getCanvasItemVisualBounds]
  )

  const resolveCanvasTargetItemBounds = useCallback((item: CanvasItem) => {
    const bounds = getCanvasItemBounds(item)
    return {
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY
    }
  }, [])

  const getCanvasRuntimeAssetMetadataExtra = useCallback(
    (item: CanvasItem): Record<string, unknown> | undefined => {
      if (item.type === 'model3d') {
        const instanceCacheKey = getSceneInstanceCloneCacheKey({
          sessionKey: resolvedSessionKey,
          src: item.src,
          fileName: item.fileName,
          itemId: item.id,
          textures: item.textures
        })
        const inspectionMetadata = readCanvasModel3DInspectionMetadataCache(instanceCacheKey)
        if (!inspectionMetadata) {
          return undefined
        }

        return {
          vertexCount: inspectionMetadata.vertexCount,
          faceCount: inspectionMetadata.faceCount,
          materialCount: inspectionMetadata.materialCount,
          animationCount: inspectionMetadata.animationCount,
          boneCount: inspectionMetadata.boneCount,
          uvSetCount: inspectionMetadata.uvSetCount,
          normalData: inspectionMetadata.normalData,
          tangentData: inspectionMetadata.tangentData
        }
      }

      if (item.type !== 'video') return undefined

      const container = canvasContainerRef.current
      const video = container?.querySelector(
        `[data-canvas-item-id="${item.id}"] video`
      ) as HTMLVideoElement | null

      if (!video) return undefined

      const sourceWidth = video.videoWidth > 0 ? video.videoWidth : null
      const sourceHeight = video.videoHeight > 0 ? video.videoHeight : null
      const sourceAspectRatio =
        sourceWidth && sourceHeight ? Math.round((sourceWidth / sourceHeight) * 1000) / 1000 : null
      const durationSeconds =
        Number.isFinite(video.duration) && video.duration >= 0 ? video.duration : null
      const currentTimeSeconds =
        Number.isFinite(video.currentTime) && video.currentTime >= 0 ? video.currentTime : null

      return {
        sourceWidth,
        sourceHeight,
        sourceAspectRatio,
        durationSeconds,
        currentTimeSeconds,
        loop: video.loop
      }
    },
    [canvasContainerRef, resolvedSessionKey]
  )

  const buildCanvasAssetMetadata = useCallback(
    (targetItems: CanvasItem[]): CanvasTargetAssetMetadata[] =>
      targetItems.map((item) =>
        buildCanvasTargetAssetMetadata(item, getCanvasRuntimeAssetMetadataExtra(item))
      ),
    [getCanvasRuntimeAssetMetadataExtra]
  )

  const summarizeCanvasRuntimeSurfaces = useCallback(
    (targetItems: CanvasItem[]): CanvasRenderSurfaceSummary =>
      summarizeProjectCanvasRuntimeSurfaces({
        items: targetItems,
        cropTargetId: renderSurfaceRuntime?.cropTargetId,
        webglReady: renderSurfaceRuntime?.webglReady ?? false,
        loadedImageIds: renderSurfaceRuntime?.loadedImageIds ?? EMPTY_CANVAS_LOADED_IMAGE_IDS,
        residentImageIds: renderSurfaceRuntime?.residentImageIds ?? EMPTY_CANVAS_RESIDENT_IMAGE_IDS
      }),
    [
      renderSurfaceRuntime?.cropTargetId,
      renderSurfaceRuntime?.loadedImageIds,
      renderSurfaceRuntime?.residentImageIds,
      renderSurfaceRuntime?.webglReady
    ]
  )

  return {
    buildCanvasAssetMetadata,
    canvasBoundsToStageRect,
    getCanvasItemVisualBounds,
    getCanvasItemsVisualBounds,
    getCanvasRuntimeAssetMetadataExtra,
    getOverlayStageRect,
    resolveCanvasTargetItemBounds,
    summarizeCanvasRuntimeSurfaces,
    stageRectToCanvasBounds
  }
}
