import React from 'react'
import { Box } from '@mui/material'
import type { CanvasImageItem } from '../types'
import {
  resolveCanvasImageDisplayCrop,
  resolveCanvasImageDomPreviewLayout
} from '../canvasImageDisplayUtils'
import { resolveCanvasImageLodDecision } from '../canvasImageLodPolicy'
import { getCanvasImageAssetSize } from '../canvasImageAssetUtils'
import {
  canReadCanvasLocalImageSource,
  createCanvasLocalImageObjectUrl
} from '../canvasLocalImageSource'

type CanvasImageDomPreviewProps = {
  item: CanvasImageItem
  previewMode?: string
  borderRadius?: string | number
  backgroundColor?: string
  stageScale?: number
  sourceImagePreview?: boolean
}

export const CANVAS_IMAGE_DOM_PREVIEW_MAX_BACKING_SIDE = 4096

function getCanvasImageDomPreviewDeviceScale() {
  return Math.min(4, Math.max(1, window.devicePixelRatio || 1))
}

function drawImageAssetToCanvas(canvas: HTMLCanvasElement, item: CanvasImageItem): boolean {
  const image = item.image
  if (!image) {
    return false
  }

  const context = canvas.getContext('2d')
  if (!context) {
    return false
  }

  const targetWidth = Math.max(1, Math.round(item.width))
  const targetHeight = Math.max(1, Math.round(item.height))
  const pixelRatio = getCanvasImageDomPreviewDeviceScale()
  const rawBackingWidth = Math.max(1, targetWidth * pixelRatio)
  const rawBackingHeight = Math.max(1, targetHeight * pixelRatio)
  const backingScale = Math.min(
    1,
    CANVAS_IMAGE_DOM_PREVIEW_MAX_BACKING_SIDE / Math.max(rawBackingWidth, rawBackingHeight)
  )
  const backingWidth = Math.max(1, Math.round(rawBackingWidth * backingScale))
  const backingHeight = Math.max(1, Math.round(rawBackingHeight * backingScale))
  if (canvas.width !== backingWidth) {
    canvas.width = backingWidth
  }
  if (canvas.height !== backingHeight) {
    canvas.height = backingHeight
  }

  context.setTransform(backingWidth / targetWidth, 0, 0, backingHeight / targetHeight, 0, 0)
  context.clearRect(0, 0, targetWidth, targetHeight)
  context.imageSmoothingEnabled = true
  if ('imageSmoothingQuality' in context) {
    context.imageSmoothingQuality = 'high'
  }

  const crop = resolveCanvasImageDisplayCrop(item, image)
  const { width: sourceWidth, height: sourceHeight } = getCanvasImageAssetSize(image)

  try {
    if (crop) {
      context.drawImage(
        image as CanvasImageSource,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        targetWidth,
        targetHeight
      )
      return true
    }

    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return false
    }

    context.drawImage(
      image as CanvasImageSource,
      0,
      0,
      sourceWidth,
      sourceHeight,
      0,
      0,
      targetWidth,
      targetHeight
    )
    return true
  } catch {
    return false
  }
}

export default function CanvasImageDomPreview({
  item,
  previewMode,
  borderRadius = 'inherit',
  backgroundColor,
  stageScale = 1,
  sourceImagePreview = false
}: CanvasImageDomPreviewProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [canvasReady, setCanvasReady] = React.useState(false)
  const [materializedSource, setMaterializedSource] = React.useState<{
    originalSrc: string
    objectUrl: string | null
    failed: boolean
  } | null>(null)
  const hasImageAsset = Boolean(item.image)
  const shouldDrawAssetCanvas = hasImageAsset && !sourceImagePreview

  React.useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !shouldDrawAssetCanvas) {
      setCanvasReady(false)
      return
    }

    setCanvasReady(drawImageAssetToCanvas(canvas, item))
  }, [
    item,
    item.crop,
    item.height,
    item.image,
    item.sourceHeight,
    item.sourceWidth,
    item.width,
    shouldDrawAssetCanvas
  ])

  const lodDecision = React.useMemo(
    () =>
      resolveCanvasImageLodDecision({
        item,
        image: item.image,
        stageScale,
        isVisible: true,
        deviceScale: getCanvasImageDomPreviewDeviceScale()
      }),
    [item, stageScale]
  )
  const shouldRenderFallbackImage =
    hasImageAsset && !canvasReady && lodDecision.shouldUseSourceTexture
  const shouldRenderSourceImage = sourceImagePreview || shouldRenderFallbackImage
  const shouldMaterializeLocalSource =
    shouldRenderSourceImage && canReadCanvasLocalImageSource(item.src)
  const fallbackLayout = React.useMemo(
    () => (shouldRenderSourceImage ? resolveCanvasImageDomPreviewLayout(item) : null),
    [item, shouldRenderSourceImage]
  )
  const materializedObjectUrl =
    materializedSource?.originalSrc === item.src ? materializedSource.objectUrl : null
  const materializedFailed =
    materializedSource?.originalSrc === item.src ? materializedSource.failed : false
  const previewImageSrc = shouldMaterializeLocalSource
    ? (materializedObjectUrl ?? (materializedFailed ? item.src : null))
    : item.src

  React.useEffect(() => {
    if (!shouldMaterializeLocalSource) {
      setMaterializedSource(null)
      return
    }

    let cancelled = false
    let objectUrl: string | null = null
    setMaterializedSource(null)

    void createCanvasLocalImageObjectUrl(item.src, item.fileName).then((resolvedSrc) => {
      objectUrl = resolvedSrc
      if (cancelled) {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
        }
        return
      }

      setMaterializedSource({
        originalSrc: item.src,
        objectUrl,
        failed: !objectUrl
      })
    })

    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [item.fileName, item.src, shouldMaterializeLocalSource])

  return (
    <Box
      data-canvas-image-dom-preview={previewMode}
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        borderRadius,
        ...(backgroundColor ? { backgroundColor } : {}),
        pointerEvents: 'none'
      }}
    >
      {shouldDrawAssetCanvas ? (
        <Box
          component="canvas"
          ref={canvasRef}
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            display: 'block',
            userSelect: 'none',
            pointerEvents: 'none',
            opacity: canvasReady ? 1 : 0
          }}
        />
      ) : null}
      {shouldRenderSourceImage && previewImageSrc ? (
        <Box
          component="img"
          src={previewImageSrc}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          data-canvas-source-image-preview={sourceImagePreview ? 'true' : undefined}
          sx={{
            position: 'absolute',
            left: fallbackLayout?.left ?? 0,
            top: fallbackLayout?.top ?? 0,
            width: fallbackLayout?.width ?? '100%',
            height: fallbackLayout?.height ?? '100%',
            display: 'block',
            userSelect: 'none',
            pointerEvents: 'none',
            imageRendering: 'auto'
          }}
        />
      ) : null}
    </Box>
  )
}
