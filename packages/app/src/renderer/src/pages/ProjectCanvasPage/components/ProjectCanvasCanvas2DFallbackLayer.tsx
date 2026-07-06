import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef
} from 'react'
import type { CanvasImageAsset, CanvasImageItem } from '../types'
import type { ProjectCanvasImagePreview } from '../projectCanvasRenderBoundary'
import { getCanvasImageAssetSize } from '../canvasImageAssetUtils'
import { resolveCanvasImageDisplayCrop } from '../canvasImageDisplayUtils'
import { getCanvasViewportBounds } from '../canvasViewportPlacementUtils'
import {
  buildCanvasSpatialIndex,
  queryCanvasSpatialIndex,
  type CanvasSpatialIndex
} from '../canvasSpatialIndex'

export type ProjectCanvasCanvas2DFallbackLayerHandle = {
  syncItemPreview: (itemId: string, preview: ProjectCanvasImagePreview | null) => void
  syncViewport: (pos: { x: number; y: number }, scale: number) => void
  setViewportInteracting: (active: boolean) => void
}

export type ProjectCanvasCanvas2DFallbackDrawFailure = {
  itemId?: string
  src?: string
  phase: 'context' | 'load' | 'draw'
  error: unknown
}

export type ProjectCanvasCanvas2DFallbackLayerProps = {
  items: CanvasImageItem[]
  selectedIds?: ReadonlySet<string>
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize?: { width: number; height: number }
  isViewportInteracting?: boolean
  isPerformanceThrottled?: boolean
  maxDevicePixelRatio?: number
  maxBackingPixels?: number
  overscanPx?: number
  onReadyChange?: (ready: boolean) => void
  onResolvedIdsChange?: (ids: Set<string>) => void
  onFailedIdsChange?: (ids: Set<string>) => void
  onDrawFailure?: (failure: ProjectCanvasCanvas2DFallbackDrawFailure) => void
}

type CachedImageRecord = {
  src: string
  status: 'loading' | 'loaded' | 'failed'
  image: HTMLImageElement | null
}

const DEFAULT_MAX_DEVICE_PIXEL_RATIO = 2
const DEFAULT_MAX_BACKING_PIXELS = 24 * 1024 * 1024
const DEFAULT_OVERSCAN_PX = 320

function getSafeDevicePixelRatio(
  maxDevicePixelRatio: number,
  maxBackingPixels: number,
  size: { width: number; height: number }
) {
  const cssWidth = Math.max(1, Math.round(size.width))
  const cssHeight = Math.max(1, Math.round(size.height))
  const rawRatio = Math.min(
    Math.max(1, window.devicePixelRatio || 1),
    Math.max(1, maxDevicePixelRatio)
  )
  const rawBackingPixels = cssWidth * cssHeight * rawRatio * rawRatio
  if (rawBackingPixels <= maxBackingPixels) {
    return rawRatio
  }

  return Math.max(0.25, Math.sqrt(maxBackingPixels / Math.max(1, cssWidth * cssHeight)))
}

function shouldUseAnonymousCrossOrigin(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

function getImageItemBounds(item: CanvasImageItem) {
  const scaledWidth = item.width * (item.scaleX || 1)
  const scaledHeight = item.height * (item.scaleY || 1)
  return {
    minX: Math.min(item.x, item.x + scaledWidth),
    minY: Math.min(item.y, item.y + scaledHeight),
    maxX: Math.max(item.x, item.x + scaledWidth),
    maxY: Math.max(item.y, item.y + scaledHeight)
  }
}

function sortCanvasImageItemsByZIndex(left: CanvasImageItem, right: CanvasImageItem) {
  return left.zIndex - right.zIndex
}

type Canvas2DFallbackVisibilityIndex = {
  items: CanvasImageItem[]
  spatialIndex: CanvasSpatialIndex<CanvasImageItem>
}

function buildCanvas2DFallbackVisibilityIndex(
  items: CanvasImageItem[]
): Canvas2DFallbackVisibilityIndex {
  const orderedItems = items.slice().sort(sortCanvasImageItemsByZIndex)
  return {
    items: orderedItems,
    spatialIndex: buildCanvasSpatialIndex(orderedItems, getImageItemBounds)
  }
}

function resolveVisibleItems({
  visibilityIndex,
  selectedIds,
  stagePos,
  stageScale,
  stageSize,
  overscanPx
}: {
  visibilityIndex: Canvas2DFallbackVisibilityIndex
  selectedIds: ReadonlySet<string>
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize?: { width: number; height: number }
  overscanPx: number
}) {
  if (!stageSize || stageSize.width <= 0 || stageSize.height <= 0) {
    return visibilityIndex.items
  }

  const safeScale = Math.max(Math.abs(stageScale), 0.0001)
  const viewport = getCanvasViewportBounds(stagePos, stageSize, stageScale || safeScale)
  const viewportBounds = {
    minX: Math.min(viewport.x, viewport.x + viewport.width) - overscanPx / safeScale,
    minY: Math.min(viewport.y, viewport.y + viewport.height) - overscanPx / safeScale,
    maxX: Math.max(viewport.x, viewport.x + viewport.width) + overscanPx / safeScale,
    maxY: Math.max(viewport.y, viewport.y + viewport.height) + overscanPx / safeScale
  }
  const visibleItemIds = new Set<string>()
  queryCanvasSpatialIndex(visibilityIndex.spatialIndex, viewportBounds).forEach((item) => {
    visibleItemIds.add(item.id)
  })
  selectedIds.forEach((itemId) => visibleItemIds.add(itemId))

  return visibilityIndex.items.filter((item) => visibleItemIds.has(item.id))
}

function drawCanvasImageItem({
  context,
  item,
  image,
  preview
}: {
  context: CanvasRenderingContext2D
  item: CanvasImageItem
  image: CanvasImageAsset
  preview?: ProjectCanvasImagePreview | null
}) {
  const transform = preview ?? item
  const crop = resolveCanvasImageDisplayCrop(item, image)
  const { width: sourceWidth, height: sourceHeight } = getCanvasImageAssetSize(image)
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return false
  }

  context.save()
  try {
    context.translate(transform.x, transform.y)
    context.rotate((transform.rotation * Math.PI) / 180)
    context.scale(transform.scaleX || 1, transform.scaleY || 1)

    if (crop) {
      context.drawImage(
        image as CanvasImageSource,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        transform.width,
        transform.height
      )
    } else {
      context.drawImage(
        image as CanvasImageSource,
        0,
        0,
        sourceWidth,
        sourceHeight,
        0,
        0,
        transform.width,
        transform.height
      )
    }
  } finally {
    context.restore()
  }

  return true
}

const ProjectCanvasCanvas2DFallbackLayer = forwardRef<
  ProjectCanvasCanvas2DFallbackLayerHandle,
  ProjectCanvasCanvas2DFallbackLayerProps
>(function ProjectCanvasCanvas2DFallbackLayer(
  {
    items,
    selectedIds = new Set<string>(),
    stagePos,
    stageScale,
    stageSize,
    isViewportInteracting = false,
    isPerformanceThrottled = false,
    maxDevicePixelRatio = DEFAULT_MAX_DEVICE_PIXEL_RATIO,
    maxBackingPixels = DEFAULT_MAX_BACKING_PIXELS,
    overscanPx = DEFAULT_OVERSCAN_PX,
    onReadyChange,
    onResolvedIdsChange,
    onFailedIdsChange,
    onDrawFailure
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const throttleTimerRef = useRef<number | null>(null)
  const lastDrawAtRef = useRef(0)
  const imageCacheRef = useRef(new Map<string, CachedImageRecord>())
  const previewStateRef = useRef(new Map<string, ProjectCanvasImagePreview>())
  const failedIdsRef = useRef(new Set<string>())
  const resolvedIdsRef = useRef(new Set<string>())
  const viewportRef = useRef({ pos: stagePos, scale: stageScale })
  const viewportInteractingRef = useRef(isViewportInteracting)
  const visibilityIndex = useMemo(() => buildCanvas2DFallbackVisibilityIndex(items), [items])
  const propsRef = useRef({
    items,
    visibilityIndex,
    selectedIds,
    stagePos,
    stageScale,
    stageSize,
    isViewportInteracting,
    isPerformanceThrottled,
    maxDevicePixelRatio,
    maxBackingPixels,
    overscanPx,
    onReadyChange,
    onResolvedIdsChange,
    onFailedIdsChange,
    onDrawFailure
  })

  const reportFailedIds = useCallback(() => {
    onFailedIdsChange?.(new Set(failedIdsRef.current))
  }, [onFailedIdsChange])

  const reportResolvedIds = useCallback(() => {
    onResolvedIdsChange?.(new Set(resolvedIdsRef.current))
  }, [onResolvedIdsChange])

  const markFailure = useCallback(
    (failure: ProjectCanvasCanvas2DFallbackDrawFailure) => {
      if (failure.itemId) {
        const sizeBefore = failedIdsRef.current.size
        failedIdsRef.current.add(failure.itemId)
        if (failedIdsRef.current.size !== sizeBefore) {
          reportFailedIds()
        }
      }
      onDrawFailure?.(failure)
    },
    [onDrawFailure, reportFailedIds]
  )

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null || throttleTimerRef.current !== null) {
      return
    }

    const { isPerformanceThrottled: throttled } = propsRef.current
    const minFrameDelay = throttled ? 100 : viewportInteractingRef.current ? 33 : 0
    const elapsed = window.performance.now() - lastDrawAtRef.current
    const requestFrame = () => {
      throttleTimerRef.current = null
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null
        drawNow()
      })
    }

    if (minFrameDelay > 0 && elapsed < minFrameDelay) {
      throttleTimerRef.current = window.setTimeout(requestFrame, minFrameDelay - elapsed)
      return
    }

    requestFrame()
  }, [])

  const resolveImageForItem = useCallback(
    (item: CanvasImageItem): CanvasImageAsset | null => {
      if (item.image) {
        return item.image
      }
      if (!item.src || viewportInteractingRef.current) {
        return null
      }

      const cached = imageCacheRef.current.get(item.id)
      if (cached?.src === item.src) {
        return cached.status === 'loaded' ? cached.image : null
      }

      const image = new Image()
      if (shouldUseAnonymousCrossOrigin(item.src)) {
        image.crossOrigin = 'anonymous'
      }
      image.decoding = 'async'
      image.draggable = false
      imageCacheRef.current.set(item.id, { src: item.src, status: 'loading', image })
      image.onload = () => {
        imageCacheRef.current.set(item.id, { src: item.src, status: 'loaded', image })
        scheduleDraw()
      }
      image.onerror = (error) => {
        imageCacheRef.current.set(item.id, { src: item.src, status: 'failed', image: null })
        markFailure({ itemId: item.id, src: item.src, phase: 'load', error })
        scheduleDraw()
      }
      image.src = item.src
      return null
    },
    [markFailure, scheduleDraw]
  )

  const drawNow = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const {
      visibilityIndex: currentVisibilityIndex,
      selectedIds: currentSelectedIds,
      stageSize: currentStageSize,
      maxDevicePixelRatio: currentMaxDpr,
      maxBackingPixels: currentMaxBackingPixels,
      overscanPx: currentOverscanPx,
      onReadyChange: currentOnReadyChange
    } = propsRef.current
    const { pos, scale } = viewportRef.current
    const cssSize = currentStageSize ?? {
      width: canvas.getBoundingClientRect().width,
      height: canvas.getBoundingClientRect().height
    }
    const cssWidth = Math.max(1, Math.round(cssSize.width || 1))
    const cssHeight = Math.max(1, Math.round(cssSize.height || 1))
    const dpr = getSafeDevicePixelRatio(currentMaxDpr, currentMaxBackingPixels, {
      width: cssWidth,
      height: cssHeight
    })
    const backingWidth = Math.max(1, Math.round(cssWidth * dpr))
    const backingHeight = Math.max(1, Math.round(cssHeight * dpr))
    if (canvas.width !== backingWidth) {
      canvas.width = backingWidth
    }
    if (canvas.height !== backingHeight) {
      canvas.height = backingHeight
    }

    const context = canvas.getContext('2d')
    if (!context) {
      currentOnReadyChange?.(false)
      markFailure({ phase: 'context', error: new Error('Canvas 2D context is unavailable.') })
      return
    }

    currentOnReadyChange?.(true)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, cssWidth, cssHeight)
    context.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in context) {
      context.imageSmoothingQuality = viewportInteractingRef.current ? 'low' : 'high'
    }

    const nextResolvedIds = new Set<string>()
    const visibleItems = resolveVisibleItems({
      visibilityIndex: currentVisibilityIndex,
      selectedIds: currentSelectedIds,
      stagePos: pos,
      stageScale: scale,
      stageSize: currentStageSize,
      overscanPx: currentOverscanPx
    })

    context.save()
    context.translate(pos.x, pos.y)
    context.scale(scale, scale)
    for (const item of visibleItems) {
      const image = resolveImageForItem(item)
      if (!image) {
        continue
      }

      try {
        if (
          drawCanvasImageItem({
            context,
            item,
            image,
            preview: previewStateRef.current.get(item.id) ?? null
          })
        ) {
          nextResolvedIds.add(item.id)
          if (failedIdsRef.current.delete(item.id)) {
            reportFailedIds()
          }
        }
      } catch (error) {
        try {
          context.restore()
          context.save()
          context.translate(pos.x, pos.y)
          context.scale(scale, scale)
        } catch {
          // If the context stack is already broken, continue with the next frame.
        }
        markFailure({ itemId: item.id, src: item.src, phase: 'draw', error })
      }
    }
    context.restore()

    if (
      nextResolvedIds.size !== resolvedIdsRef.current.size ||
      [...nextResolvedIds].some((id) => !resolvedIdsRef.current.has(id))
    ) {
      resolvedIdsRef.current = nextResolvedIds
      reportResolvedIds()
    }
    lastDrawAtRef.current = window.performance.now()
  }, [markFailure, reportFailedIds, reportResolvedIds, resolveImageForItem])

  useLayoutEffect(() => {
    propsRef.current = {
      items,
      visibilityIndex,
      selectedIds,
      stagePos,
      stageScale,
      stageSize,
      isViewportInteracting,
      isPerformanceThrottled,
      maxDevicePixelRatio,
      maxBackingPixels,
      overscanPx,
      onReadyChange,
      onResolvedIdsChange,
      onFailedIdsChange,
      onDrawFailure
    }
    viewportRef.current = { pos: stagePos, scale: stageScale }
    viewportInteractingRef.current = isViewportInteracting
    scheduleDraw()
  }, [
    items,
    visibilityIndex,
    selectedIds,
    stagePos,
    stageScale,
    stageSize,
    isViewportInteracting,
    isPerformanceThrottled,
    maxDevicePixelRatio,
    maxBackingPixels,
    overscanPx,
    onReadyChange,
    onResolvedIdsChange,
    onFailedIdsChange,
    onDrawFailure,
    scheduleDraw
  ])

  useEffect(() => {
    const activeItemIds = new Set(items.map((item) => item.id))
    for (const itemId of imageCacheRef.current.keys()) {
      if (!activeItemIds.has(itemId)) {
        imageCacheRef.current.delete(itemId)
      }
    }
    for (const itemId of failedIdsRef.current.keys()) {
      if (!activeItemIds.has(itemId)) {
        failedIdsRef.current.delete(itemId)
      }
    }
    reportFailedIds()
  }, [items, reportFailedIds])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current)
        throttleTimerRef.current = null
      }
      imageCacheRef.current.clear()
      previewStateRef.current.clear()
      failedIdsRef.current.clear()
      resolvedIdsRef.current.clear()
      onReadyChange?.(false)
      onResolvedIdsChange?.(new Set())
      onFailedIdsChange?.(new Set())
    }
  }, [onFailedIdsChange, onReadyChange, onResolvedIdsChange])

  useImperativeHandle(
    ref,
    () => ({
      syncItemPreview(itemId, preview) {
        if (preview) {
          previewStateRef.current.set(itemId, preview)
        } else {
          previewStateRef.current.delete(itemId)
        }
        scheduleDraw()
      },
      syncViewport(pos, scale) {
        viewportRef.current = { pos, scale }
        scheduleDraw()
      },
      setViewportInteracting(active) {
        viewportInteractingRef.current = active
        scheduleDraw()
      }
    }),
    [scheduleDraw]
  )

  return (
    <canvas
      ref={canvasRef}
      data-canvas-render-surface="canvas2d-image-fallback"
      data-canvas-render-role="raster-image-fallback-layer"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        pointerEvents: 'none',
        userSelect: 'none'
      }}
    />
  )
})

export default ProjectCanvasCanvas2DFallbackLayer
