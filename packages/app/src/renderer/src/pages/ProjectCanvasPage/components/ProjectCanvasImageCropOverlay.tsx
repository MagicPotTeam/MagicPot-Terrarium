import React from 'react'
import { Box } from '@mui/material'
import { getCanvasImageAssetSize } from '../canvasImageAssetUtils'
import type { CanvasImageAsset, CanvasImageItem } from '../types'
import { STAGE_VIEWPORT_LAYER_BASE_STYLE } from '../useStageViewportTransformDriver'
import { resolveResizedCropBox } from './projectCanvasImageCropUtils'

type CropBox = {
  x: number
  y: number
  width: number
  height: number
}

type CanvasPoint = {
  x: number
  y: number
}

type ResizeHandle =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-right'
  | 'bottom-right'
  | 'bottom-center'
  | 'bottom-left'
  | 'middle-left'

type DragSession = {
  kind: 'drag'
  pointerId: number
  startPoint: CanvasPoint
  startBox: CropBox
}

type ResizeSession = {
  kind: 'resize'
  pointerId: number
  handle: ResizeHandle
  startPoint: CanvasPoint
  startBox: CropBox
}

type InteractionSession = DragSession | ResizeSession

export type ProjectCanvasImageCropOverlayHandle = {
  confirm: () => void
}

type CanvasCropBoxChangeDetail = {
  itemId: string
  active: boolean
  cropBox: CropBox | null
}

type ProjectCanvasImageCropOverlayProps = {
  item: CanvasImageItem
  stagePos: { x: number; y: number }
  stageScale: number
  stagePosRef?: React.RefObject<{ x: number; y: number }>
  stageScaleRef?: React.RefObject<number>
  registerViewportLayer?: (el: HTMLElement | null) => void
  onConfirm: (updates: {
    x: number
    y: number
    width: number
    height: number
    scaleX: number
    scaleY: number
    crop: { x: number; y: number; width: number; height: number }
  }) => void
  onCancel: () => void
}

const MIN_CROP_BOX_SIZE = 5
const HANDLE_VISUAL_SIZE = 12
const HANDLE_HIT_SIZE = 40
const MAX_HANDLE_SCALE_COMPENSATION = 2.5
const MAX_BORDER_SCALE_COMPENSATION = 1.75

const HANDLE_POSITIONS: Array<{ handle: ResizeHandle; left: string; top: string; cursor: string }> =
  [
    { handle: 'top-left', left: '0%', top: '0%', cursor: 'nwse-resize' },
    { handle: 'top-center', left: '50%', top: '0%', cursor: 'ns-resize' },
    { handle: 'top-right', left: '100%', top: '0%', cursor: 'nesw-resize' },
    { handle: 'middle-right', left: '100%', top: '50%', cursor: 'ew-resize' },
    { handle: 'bottom-right', left: '100%', top: '100%', cursor: 'nwse-resize' },
    { handle: 'bottom-center', left: '50%', top: '100%', cursor: 'ns-resize' },
    { handle: 'bottom-left', left: '0%', top: '100%', cursor: 'nesw-resize' },
    { handle: 'middle-left', left: '0%', top: '50%', cursor: 'ew-resize' }
  ] as const

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function rotateVector(point: CanvasPoint, degrees: number): CanvasPoint {
  const radians = toRadians(degrees)
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  }
}

function inverseRotateVector(point: CanvasPoint, degrees: number): CanvasPoint {
  return rotateVector(point, -degrees)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function swapHandleHorizontal(handle: ResizeHandle): ResizeHandle {
  switch (handle) {
    case 'top-left':
      return 'top-right'
    case 'middle-left':
      return 'middle-right'
    case 'bottom-left':
      return 'bottom-right'
    case 'top-right':
      return 'top-left'
    case 'middle-right':
      return 'middle-left'
    case 'bottom-right':
      return 'bottom-left'
    default:
      return handle
  }
}

function swapHandleVertical(handle: ResizeHandle): ResizeHandle {
  switch (handle) {
    case 'top-left':
      return 'bottom-left'
    case 'top-center':
      return 'bottom-center'
    case 'top-right':
      return 'bottom-right'
    case 'bottom-left':
      return 'top-left'
    case 'bottom-center':
      return 'top-center'
    case 'bottom-right':
      return 'top-right'
    default:
      return handle
  }
}

function resolveLocalResizeHandle(
  handle: ResizeHandle,
  scaleX: number,
  scaleY: number
): ResizeHandle {
  let resolved = handle
  if (scaleX < 0) {
    resolved = swapHandleHorizontal(resolved)
  }
  if (scaleY < 0) {
    resolved = swapHandleVertical(resolved)
  }
  return resolved
}

export const ProjectCanvasImageCropOverlay = React.forwardRef<
  ProjectCanvasImageCropOverlayHandle,
  ProjectCanvasImageCropOverlayProps
>(function ProjectCanvasImageCropOverlay(
  {
    item,
    stagePos,
    stageScale,
    stagePosRef,
    stageScaleRef,
    registerViewportLayer,
    onConfirm,
    onCancel
  },
  ref
) {
  const sessionRef = React.useRef<InteractionSession | null>(null)
  const cropBoxRef = React.useRef<CropBox>({
    x: 0,
    y: 0,
    width: 0,
    height: 0
  })
  const pendingCropBoxRef = React.useRef<CropBox | null>(null)
  const cropBoxFrameRef = React.useRef<number | null>(null)
  const cropBoxElementRef = React.useRef<HTMLDivElement | null>(null)
  const cropPreviewWindowRef = React.useRef<HTMLDivElement | null>(null)
  const cropPreviewImageRef = React.useRef<HTMLImageElement | null>(null)
  const [loadedImage, setLoadedImage] = React.useState<CanvasImageAsset | null>(item.image || null)

  React.useEffect(() => {
    if (item.image) {
      setLoadedImage(item.image)
      return
    }

    if (!item.src) {
      setLoadedImage(null)
      return
    }

    setLoadedImage(null)
    let cancelled = false
    const image = new Image()
    if (!item.src.startsWith('data:') && !item.src.startsWith('blob:')) {
      image.crossOrigin = 'anonymous'
    }
    image.onload = () => {
      if (!cancelled) {
        setLoadedImage(image)
      }
    }
    image.onerror = () => {
      if (!cancelled) {
        setLoadedImage(null)
        console.warn(`[ProjectCanvasImageCropOverlay] Failed to load image: ${item.id}`)
      }
    }
    image.src = item.src

    return () => {
      cancelled = true
      image.onload = null
      image.onerror = null
    }
  }, [item.id, item.image, item.src])

  const { width: loadedImageWidth, height: loadedImageHeight } =
    getCanvasImageAssetSize(loadedImage)
  const sourceWidth = item.sourceWidth || loadedImageWidth || item.width
  const sourceHeight = item.sourceHeight || loadedImageHeight || item.height
  const displayWidth = loadedImageWidth || sourceWidth
  const displayHeight = loadedImageHeight || sourceHeight
  const sourceToDisplayScaleX = sourceWidth > 0 ? displayWidth / sourceWidth : 1
  const sourceToDisplayScaleY = sourceHeight > 0 ? displayHeight / sourceHeight : 1
  const displayToSourceScaleX = displayWidth > 0 ? sourceWidth / displayWidth : 1
  const displayToSourceScaleY = displayHeight > 0 ? sourceHeight / displayHeight : 1

  const currentSourceCrop = React.useMemo(() => {
    let baseCrop = item.crop || { x: 0, y: 0, width: sourceWidth, height: sourceHeight }
    if (baseCrop.width <= 0 || baseCrop.height <= 0) {
      baseCrop = { x: 0, y: 0, width: sourceWidth, height: sourceHeight }
    }

    const clampedX = Math.max(0, Math.min(baseCrop.x, Math.max(sourceWidth - 1, 0)))
    const clampedY = Math.max(0, Math.min(baseCrop.y, Math.max(sourceHeight - 1, 0)))
    const clampedWidth = Math.max(1, Math.min(baseCrop.width, sourceWidth - clampedX))
    const clampedHeight = Math.max(1, Math.min(baseCrop.height, sourceHeight - clampedY))

    return {
      x: clampedX,
      y: clampedY,
      width: clampedWidth,
      height: clampedHeight
    }
  }, [item.crop, sourceHeight, sourceWidth])

  const currentDisplayCrop = React.useMemo(() => {
    const nextX = currentSourceCrop.x * sourceToDisplayScaleX
    const nextY = currentSourceCrop.y * sourceToDisplayScaleY
    const nextWidth = currentSourceCrop.width * sourceToDisplayScaleX
    const nextHeight = currentSourceCrop.height * sourceToDisplayScaleY

    return {
      x: nextX,
      y: nextY,
      width: Math.max(1, Math.min(nextWidth, displayWidth - nextX)),
      height: Math.max(1, Math.min(nextHeight, displayHeight - nextY))
    }
  }, [
    currentSourceCrop.height,
    currentSourceCrop.width,
    currentSourceCrop.x,
    currentSourceCrop.y,
    displayHeight,
    displayWidth,
    sourceToDisplayScaleX,
    sourceToDisplayScaleY
  ])

  const emitCropBoxChange = React.useCallback(
    (nextBox: CropBox | null, active: boolean) => {
      const detail: CanvasCropBoxChangeDetail = {
        itemId: item.id,
        active,
        cropBox: nextBox
          ? {
              x: nextBox.x,
              y: nextBox.y,
              width: nextBox.width,
              height: nextBox.height
            }
          : null
      }

      window.dispatchEvent(
        new CustomEvent<CanvasCropBoxChangeDetail>('canvas:crop-box-change', { detail })
      )
    },
    [item.id]
  )

  const applyCropBoxToDom = React.useCallback(
    (nextBox: CropBox) => {
      cropBoxRef.current = nextBox

      const cropBoxElement = cropBoxElementRef.current
      if (cropBoxElement) {
        cropBoxElement.style.left = `${nextBox.x}px`
        cropBoxElement.style.top = `${nextBox.y}px`
        cropBoxElement.style.width = `${nextBox.width}px`
        cropBoxElement.style.height = `${nextBox.height}px`
      }

      const previewWindowElement = cropPreviewWindowRef.current
      if (previewWindowElement) {
        previewWindowElement.style.left = `${nextBox.x}px`
        previewWindowElement.style.top = `${nextBox.y}px`
        previewWindowElement.style.width = `${nextBox.width}px`
        previewWindowElement.style.height = `${nextBox.height}px`
      }

      const previewImageElement = cropPreviewImageRef.current
      if (previewImageElement) {
        previewImageElement.style.left = `${-nextBox.x}px`
        previewImageElement.style.top = `${-nextBox.y}px`
      }

      emitCropBoxChange(nextBox, true)
    },
    [emitCropBoxChange]
  )

  const flushPendingCropBox = React.useCallback(() => {
    if (cropBoxFrameRef.current != null) {
      window.cancelAnimationFrame(cropBoxFrameRef.current)
      cropBoxFrameRef.current = null
    }

    const pendingBox = pendingCropBoxRef.current
    if (!pendingBox) {
      return
    }

    pendingCropBoxRef.current = null
    applyCropBoxToDom(pendingBox)
  }, [applyCropBoxToDom])

  const scheduleCropBoxUpdate = React.useCallback(
    (nextBox: CropBox) => {
      pendingCropBoxRef.current = nextBox
      if (cropBoxFrameRef.current != null) {
        return
      }

      cropBoxFrameRef.current = window.requestAnimationFrame(() => {
        cropBoxFrameRef.current = null
        const pendingBox = pendingCropBoxRef.current
        if (!pendingBox) {
          return
        }

        pendingCropBoxRef.current = null
        applyCropBoxToDom(pendingBox)
      })
    },
    [applyCropBoxToDom]
  )

  React.useLayoutEffect(() => {
    const nextBox = {
      x: currentDisplayCrop.x,
      y: currentDisplayCrop.y,
      width: currentDisplayCrop.width,
      height: currentDisplayCrop.height
    }

    sessionRef.current = null
    pendingCropBoxRef.current = nextBox
    flushPendingCropBox()
  }, [
    currentDisplayCrop.height,
    currentDisplayCrop.width,
    currentDisplayCrop.x,
    currentDisplayCrop.y,
    flushPendingCropBox
  ])

  React.useEffect(() => {
    return () => {
      if (cropBoxFrameRef.current != null) {
        window.cancelAnimationFrame(cropBoxFrameRef.current)
        cropBoxFrameRef.current = null
      }
      sessionRef.current = null
      pendingCropBoxRef.current = null
      emitCropBoxChange(null, false)
    }
  }, [emitCropBoxChange])

  const totalScaleX = item.scaleX * (item.width / currentDisplayCrop.width)
  const totalScaleY = item.scaleY * (item.height / currentDisplayCrop.height)

  const clampCropBox = React.useCallback(
    (nextBox: CropBox): CropBox => {
      const minimumWidth = Math.min(MIN_CROP_BOX_SIZE, displayWidth)
      const minimumHeight = Math.min(MIN_CROP_BOX_SIZE, displayHeight)
      let nextWidth = Math.max(minimumWidth, Math.min(nextBox.width, displayWidth))
      let nextHeight = Math.max(minimumHeight, Math.min(nextBox.height, displayHeight))
      const nextX = Math.max(0, Math.min(nextBox.x, displayWidth - nextWidth))
      const nextY = Math.max(0, Math.min(nextBox.y, displayHeight - nextHeight))

      if (nextX + nextWidth > displayWidth) {
        nextWidth = Math.max(minimumWidth, displayWidth - nextX)
      }
      if (nextY + nextHeight > displayHeight) {
        nextHeight = Math.max(minimumHeight, displayHeight - nextY)
      }

      return {
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight
      }
    },
    [displayHeight, displayWidth]
  )

  const getLocalImagePointFromClient = React.useCallback(
    (clientX: number, clientY: number): CanvasPoint | null => {
      const liveStagePos = stagePosRef?.current ?? stagePos
      const liveStageScale = stageScaleRef?.current ?? stageScale
      const scale = Math.max(Math.abs(liveStageScale), 0.0001)
      const absScaleX = Math.abs(totalScaleX)
      const absScaleY = Math.abs(totalScaleY)
      if (absScaleX < 0.0001 || absScaleY < 0.0001) {
        return null
      }

      const canvasX = (clientX - liveStagePos.x) / scale
      const canvasY = (clientY - liveStagePos.y) / scale
      const translated = {
        x: canvasX - item.x,
        y: canvasY - item.y
      }
      const local = inverseRotateVector(translated, item.rotation)

      return {
        x: local.x / totalScaleX + currentDisplayCrop.x,
        y: local.y / totalScaleY + currentDisplayCrop.y
      }
    },
    [
      currentDisplayCrop.x,
      currentDisplayCrop.y,
      item.rotation,
      item.x,
      item.y,
      stageScale,
      stagePos,
      stagePosRef,
      stageScaleRef,
      totalScaleX,
      totalScaleY
    ]
  )

  const handleApply = React.useCallback(() => {
    flushPendingCropBox()
    const cropBox = cropBoxRef.current
    const nextSourceCropX = Math.max(0, Math.min(sourceWidth, cropBox.x * displayToSourceScaleX))
    const nextSourceCropY = Math.max(0, Math.min(sourceHeight, cropBox.y * displayToSourceScaleY))
    const nextSourceCropWidth = Math.max(
      1,
      Math.min(sourceWidth - nextSourceCropX, cropBox.width * displayToSourceScaleX)
    )
    const nextSourceCropHeight = Math.max(
      1,
      Math.min(sourceHeight - nextSourceCropY, cropBox.height * displayToSourceScaleY)
    )

    const nextSourceCrop = {
      x: nextSourceCropX,
      y: nextSourceCropY,
      width: nextSourceCropWidth,
      height: nextSourceCropHeight
    }

    const localX = nextSourceCrop.x - currentSourceCrop.x
    const localY = nextSourceCrop.y - currentSourceCrop.y
    const sourceCropScaleX = item.width / currentSourceCrop.width
    const sourceCropScaleY = item.height / currentSourceCrop.height
    const rotatedOffset = rotateVector(
      {
        x: localX * item.scaleX * sourceCropScaleX,
        y: localY * item.scaleY * sourceCropScaleY
      },
      item.rotation
    )

    onConfirm({
      x: item.x + rotatedOffset.x,
      y: item.y + rotatedOffset.y,
      width: nextSourceCrop.width,
      height: nextSourceCrop.height,
      scaleX: item.scaleX * sourceCropScaleX,
      scaleY: item.scaleY * sourceCropScaleY,
      crop: nextSourceCrop
    })
  }, [
    currentSourceCrop.height,
    currentSourceCrop.width,
    currentSourceCrop.x,
    currentSourceCrop.y,
    displayToSourceScaleX,
    displayToSourceScaleY,
    flushPendingCropBox,
    item.height,
    item.rotation,
    item.scaleX,
    item.scaleY,
    item.width,
    item.x,
    item.y,
    onConfirm,
    sourceHeight,
    sourceWidth
  ])

  React.useImperativeHandle(
    ref,
    () => ({
      confirm: () => {
        handleApply()
      }
    }),
    [handleApply]
  )

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        handleApply()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [handleApply, onCancel])

  React.useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const session = sessionRef.current
      if (!session || event.pointerId !== session.pointerId) {
        return
      }

      const point = getLocalImagePointFromClient(event.clientX, event.clientY)
      if (!point) {
        return
      }

      if (session.kind === 'drag') {
        const nextBox = clampCropBox({
          x: session.startBox.x + (point.x - session.startPoint.x),
          y: session.startBox.y + (point.y - session.startPoint.y),
          width: session.startBox.width,
          height: session.startBox.height
        })
        scheduleCropBoxUpdate(nextBox)
        return
      }

      const localHandle = resolveLocalResizeHandle(session.handle, totalScaleX, totalScaleY)
      const nextBox = resolveResizedCropBox({
        handle: localHandle,
        pointer: point,
        startPoint: session.startPoint,
        startBox: session.startBox,
        boundsWidth: displayWidth,
        boundsHeight: displayHeight
      })
      scheduleCropBoxUpdate(nextBox)
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== sessionRef.current?.pointerId) {
        return
      }
      flushPendingCropBox()
      sessionRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
    }
  }, [
    clampCropBox,
    displayHeight,
    displayWidth,
    flushPendingCropBox,
    getLocalImagePointFromClient,
    scheduleCropBoxUpdate,
    totalScaleX,
    totalScaleY
  ])

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    const point = getLocalImagePointFromClient(event.clientX, event.clientY)
    if (!point) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    sessionRef.current = {
      kind: 'drag',
      pointerId: event.pointerId,
      startPoint: point,
      startBox: cropBoxRef.current
    }
  }

  const startResize = (handle: ResizeHandle) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    const point = getLocalImagePointFromClient(event.clientX, event.clientY)
    if (!point) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    sessionRef.current = {
      kind: 'resize',
      pointerId: event.pointerId,
      handle,
      startPoint: point,
      startBox: cropBoxRef.current
    }
  }

  if (!loadedImage) {
    return null
  }

  const stageScaleMagnitude = Math.max(Math.abs(stageScaleRef?.current ?? stageScale), 0.0001)
  const itemScaleMagnitude = Math.max(Math.abs(totalScaleX), Math.abs(totalScaleY), 0.0001)
  const screenScaleMagnitude = stageScaleMagnitude * itemScaleMagnitude
  const handleScaleCompensation = clamp(1 / screenScaleMagnitude, 1, MAX_HANDLE_SCALE_COMPENSATION)
  const cropBorderWidth = 2 * clamp(1 / screenScaleMagnitude, 1, MAX_BORDER_SCALE_COMPENSATION)
  const stageViewportLayerStyle: React.CSSProperties = registerViewportLayer
    ? STAGE_VIEWPORT_LAYER_BASE_STYLE
    : {
        position: 'absolute',
        left: stagePos.x,
        top: stagePos.y,
        width: 0,
        height: 0,
        overflow: 'visible',
        transform: `scale(${stageScale})`,
        transformOrigin: '0 0',
        pointerEvents: 'none'
      }

  return (
    <Box
      data-project-canvas-crop-overlay="dom"
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 6
      }}
    >
      <div ref={registerViewportLayer} style={stageViewportLayerStyle}>
        <Box
          sx={{
            position: 'absolute',
            left: item.x,
            top: item.y,
            width: 0,
            height: 0,
            overflow: 'visible',
            transform: `rotate(${item.rotation}deg) scale(${totalScaleX}, ${totalScaleY})`,
            transformOrigin: '0 0',
            pointerEvents: 'none'
          }}
        >
          <Box
            sx={{
              position: 'absolute',
              left: -currentDisplayCrop.x,
              top: -currentDisplayCrop.y,
              width: displayWidth,
              height: displayHeight,
              overflow: 'visible',
              pointerEvents: 'auto'
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <Box
              component="img"
              src={item.src}
              alt=""
              draggable={false}
              sx={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: displayWidth,
                height: displayHeight,
                opacity: 0.3,
                userSelect: 'none',
                pointerEvents: 'none'
              }}
            />
            <Box
              ref={cropPreviewWindowRef}
              sx={{
                position: 'absolute',
                left: currentDisplayCrop.x,
                top: currentDisplayCrop.y,
                width: currentDisplayCrop.width,
                height: currentDisplayCrop.height,
                overflow: 'hidden',
                pointerEvents: 'none',
                willChange: 'left, top, width, height'
              }}
            >
              <Box
                component="img"
                ref={cropPreviewImageRef}
                src={item.src}
                alt=""
                draggable={false}
                sx={{
                  position: 'absolute',
                  left: -currentDisplayCrop.x,
                  top: -currentDisplayCrop.y,
                  width: displayWidth,
                  height: displayHeight,
                  userSelect: 'none',
                  pointerEvents: 'none',
                  willChange: 'left, top'
                }}
              />
            </Box>
            <Box
              data-canvas-crop-box={item.id}
              ref={cropBoxElementRef}
              onPointerDown={startDrag}
              sx={{
                position: 'absolute',
                left: currentDisplayCrop.x,
                top: currentDisplayCrop.y,
                width: currentDisplayCrop.width,
                height: currentDisplayCrop.height,
                border: `${cropBorderWidth}px solid #38bdf8`,
                boxShadow: `${cropBorderWidth}px ${cropBorderWidth}px 0 rgba(255,255,255,0.5) inset`,
                cursor: 'default',
                touchAction: 'none',
                pointerEvents: 'auto',
                willChange: 'left, top, width, height'
              }}
            >
              {HANDLE_POSITIONS.map(({ handle, left, top, cursor }) => (
                <Box
                  key={handle}
                  data-canvas-crop-handle={handle}
                  onPointerDown={startResize(handle)}
                  sx={{
                    position: 'absolute',
                    left,
                    top,
                    width: HANDLE_HIT_SIZE,
                    height: HANDLE_HIT_SIZE,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transform: `translate(-50%, -50%) scale(${handleScaleCompensation})`,
                    transformOrigin: 'center',
                    cursor,
                    touchAction: 'none',
                    pointerEvents: 'auto',
                    zIndex: 1
                  }}
                >
                  <Box
                    sx={{
                      width: HANDLE_VISUAL_SIZE,
                      height: HANDLE_VISUAL_SIZE,
                      borderRadius: '2px',
                      bgcolor: '#ffffff',
                      border: `${1.5 * handleScaleCompensation}px solid #38bdf8`,
                      boxShadow: '0 2px 8px rgba(15,23,42,0.22)',
                      pointerEvents: 'none'
                    }}
                  />
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      </div>
    </Box>
  )
})

export default ProjectCanvasImageCropOverlay
