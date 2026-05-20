import React from 'react'
import { Box } from '@mui/material'
import { getCanvasItemBounds } from '../projectCanvasPageShared'
import { measureCanvasAnnotationTextHeight } from '../canvasTextLayout'
import {
  resolveCanvasItemAttachmentScale,
  resolveAttachedCaptionDraftLayout,
  resolveAttachedCaptionScaleBasis
} from '../canvasAttachedCaptionUtils'
import type { CanvasAnnotationItem, CanvasItem } from '../types'
import type { CanvasSyncDetail } from './canvasSync'

type CanvasPoint = {
  x: number
  y: number
}

type CanvasAnnotationOverlayProps = {
  item: CanvasAnnotationItem
  attachedParentItem?: CanvasItem | null
  isEditing?: boolean
  isEmphasized?: boolean
  stageScale: number
}

const LABEL_LINE_HEIGHT = 1.05
const LABEL_MIN_SCREEN_FONT_SIZE = 3
const LABEL_MAX_SCREEN_FONT_SIZE = 72

function resolveCanvasAnnotationShape(item: CanvasAnnotationItem) {
  return item.shape || 'rect'
}

function rotateCanvasPoint(point: CanvasPoint, rotation: number): CanvasPoint {
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  }
}

function getCanvasPointBounds(
  points: CanvasPoint[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.length === 0) {
    return null
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  return { minX, minY, maxX, maxY }
}

function getCanvasAnnotationLocalPoints(item: CanvasAnnotationItem): CanvasPoint[] | null {
  const shape = resolveCanvasAnnotationShape(item)

  if ((shape === 'arrow' || shape === 'line') && item.endX != null && item.endY != null) {
    return [
      { x: 0, y: 0 },
      { x: item.endX - item.x, y: item.endY - item.y }
    ]
  }

  if (shape === 'freedraw' && item.points && item.points.length >= 2) {
    const points: CanvasPoint[] = []
    for (let index = 0; index < item.points.length; index += 2) {
      points.push({
        x: item.points[index] - item.x,
        y: item.points[index + 1] - item.y
      })
    }
    return points
  }

  return null
}

function getCanvasAnnotationVisualLocalPoints(item: CanvasAnnotationItem): CanvasPoint[] | null {
  const points = getCanvasAnnotationLocalPoints(item)
  if (!points) {
    return null
  }

  return points.map((point) => ({
    x: point.x * item.scaleX,
    y: point.y * item.scaleY
  }))
}

function getCanvasAnnotationRectLocalMinCorner(item: CanvasAnnotationItem): CanvasPoint {
  return {
    x: Math.min(0, item.width * item.scaleX),
    y: Math.min(0, item.height * item.scaleY)
  }
}

function getCanvasAnnotationOverlayBounds(item: CanvasAnnotationItem) {
  const shape = resolveCanvasAnnotationShape(item)
  if (shape === 'arrow' || shape === 'line' || shape === 'freedraw') {
    const localBounds = getCanvasPointBounds(getCanvasAnnotationVisualLocalPoints(item) ?? [])
    if (localBounds) {
      const offset = rotateCanvasPoint({ x: localBounds.minX, y: localBounds.minY }, item.rotation)
      return {
        x: item.x + offset.x,
        y: item.y + offset.y,
        width: Math.max(1, localBounds.maxX - localBounds.minX),
        height: Math.max(1, localBounds.maxY - localBounds.minY),
        minX: localBounds.minX,
        minY: localBounds.minY
      }
    }
  }

  const localMinCorner = getCanvasAnnotationRectLocalMinCorner(item)
  const offset = rotateCanvasPoint(localMinCorner, item.rotation)
  return {
    x: item.x + offset.x,
    y: item.y + offset.y,
    width: Math.max(1, Math.abs(item.width * item.scaleX)),
    height: Math.max(1, Math.abs(item.height * item.scaleY)),
    minX: localMinCorner.x,
    minY: localMinCorner.y
  }
}

function resolveCanvasItemVisualBounds(item: CanvasItem) {
  const bounds = getCanvasItemBounds(item)
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: Math.max(1, bounds.maxX - bounds.minX),
    height: Math.max(1, bounds.maxY - bounds.minY)
  }
}

function fitAnnotationLabelFontSize(
  label: string,
  width: number,
  height: number,
  stageScale: number
): number {
  const availableWidth = Math.max(1, width * stageScale)
  const availableHeight = Math.max(1, height * stageScale)
  let low = LABEL_MIN_SCREEN_FONT_SIZE
  let high = Math.max(
    LABEL_MIN_SCREEN_FONT_SIZE,
    Math.min(availableWidth, availableHeight, LABEL_MAX_SCREEN_FONT_SIZE)
  )

  const fits = (fontSize: number) =>
    measureCanvasAnnotationTextHeight({
      text: label,
      width: availableWidth,
      fontSize,
      fontWeight: 'bold'
    }) <= availableHeight

  if (!fits(low)) {
    return low / Math.max(stageScale, 0.0001)
  }

  while (high - low > 0.25) {
    const mid = (low + high) / 2
    if (fits(mid)) {
      low = mid
    } else {
      high = mid
    }
  }

  return low / Math.max(stageScale, 0.0001)
}

function getAnnotationLabelLayout(item: CanvasAnnotationItem, stageScale: number) {
  const width = Math.max(1, Math.abs(item.width * item.scaleX))
  const height = Math.max(1, Math.abs(item.height * item.scaleY))
  const shape = resolveCanvasAnnotationShape(item)
  const minExtent = 12 / Math.max(stageScale, 0.0001)
  const padding = Math.min(
    Math.max(4 / Math.max(stageScale, 0.0001), Math.min(width, height) * 0.08),
    Math.min(width, height) / 3
  )

  if (shape === 'circle' || shape === 'ellipse') {
    const innerWidth = Math.max(minExtent, width / Math.SQRT2 - padding * 2)
    const innerHeight = Math.max(minExtent, height / Math.SQRT2 - padding * 2)
    return {
      x: (width - innerWidth) / 2,
      y: (height - innerHeight) / 2,
      width: innerWidth,
      height: innerHeight
    }
  }

  return {
    x: padding,
    y: padding,
    width: Math.max(minExtent, width - padding * 2),
    height: Math.max(minExtent, height - padding * 2)
  }
}

const CanvasAnnotationOverlay: React.FC<CanvasAnnotationOverlayProps> = ({
  item,
  attachedParentItem = null,
  isEditing = false,
  isEmphasized = false,
  stageScale
}) => {
  const overlayRef = React.useRef<HTMLDivElement | null>(null)
  const [previewTransform, setPreviewTransform] = React.useState<CanvasSyncDetail | null>(null)
  const [attachedPreviewLayout, setAttachedPreviewLayout] = React.useState<{
    x: number
    y: number
    width: number
    height: number
    fontSize: number
  } | null>(null)
  const previewTransformRef = React.useRef<CanvasSyncDetail | null>(previewTransform)

  React.useEffect(() => {
    previewTransformRef.current = previewTransform
  }, [previewTransform])

  const applyOverlayLayout = React.useCallback((layoutItem: CanvasAnnotationItem) => {
    const overlay = overlayRef.current
    if (!overlay) {
      return false
    }

    const overlayBounds = getCanvasAnnotationOverlayBounds(layoutItem)
    overlay.style.width = `${overlayBounds.width}px`
    overlay.style.height = `${overlayBounds.height}px`
    overlay.style.transform = `translate3d(${overlayBounds.x}px, ${overlayBounds.y}px, 0) rotate(${layoutItem.rotation}deg)`
    overlay.style.zIndex = String(layoutItem.zIndex)
    return true
  }, [])

  const resetCommittedOverlayLayout = React.useCallback(() => {
    applyOverlayLayout(item)
  }, [applyOverlayLayout, item])

  React.useEffect(() => {
    const handleCanvasSync = (event: Event) => {
      const detail = (event as CustomEvent<CanvasSyncDetail>).detail
      if (!detail) {
        return
      }

      const canApplyImperatively =
        Math.abs(detail.rotation - item.rotation) <= 0.001 &&
        Math.abs(detail.scaleX - item.scaleX) <= 0.001 &&
        Math.abs(detail.scaleY - item.scaleY) <= 0.001

      if (canApplyImperatively) {
        if (previewTransformRef.current !== null) {
          previewTransformRef.current = null
          setPreviewTransform(null)
        }
        applyOverlayLayout({
          ...item,
          x: detail.x,
          y: detail.y,
          rotation: detail.rotation,
          scaleX: detail.scaleX,
          scaleY: detail.scaleY
        })
        return
      }

      previewTransformRef.current = detail
      setPreviewTransform(detail)
    }

    const handleCanvasReset = () => {
      previewTransformRef.current = null
      setPreviewTransform(null)
      resetCommittedOverlayLayout()
    }

    window.addEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
    window.addEventListener(`canvas-reset-${item.id}`, handleCanvasReset)

    return () => {
      window.removeEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
      window.removeEventListener(`canvas-reset-${item.id}`, handleCanvasReset)
    }
  }, [applyOverlayLayout, item, resetCommittedOverlayLayout])

  React.useEffect(() => {
    previewTransformRef.current = null
    setPreviewTransform(null)
    resetCommittedOverlayLayout()
  }, [
    item.id,
    item.rotation,
    item.scaleX,
    item.scaleY,
    item.x,
    item.y,
    resetCommittedOverlayLayout
  ])

  React.useEffect(() => {
    if (
      !attachedParentItem ||
      item.attachedToId !== attachedParentItem.id ||
      item.attachmentPlacement !== 'bottom-center'
    ) {
      setAttachedPreviewLayout(null)
      return
    }

    const handleCanvasSync = (event: Event) => {
      const detail = (event as CustomEvent<CanvasSyncDetail>).detail
      if (!detail) {
        return
      }

      const parentPreviewItem = {
        ...attachedParentItem,
        x: detail.x,
        y: detail.y,
        rotation: detail.rotation,
        scaleX: detail.scaleX,
        scaleY: detail.scaleY
      }
      const parentBounds = resolveCanvasItemVisualBounds(parentPreviewItem)
      const parentScale = resolveCanvasItemAttachmentScale(parentPreviewItem)
      const scaleBasis = resolveAttachedCaptionScaleBasis(parentScale, item)
      setAttachedPreviewLayout(
        resolveAttachedCaptionDraftLayout(parentBounds, {
          parentScale,
          baseScale: scaleBasis.baseScale,
          baseFontSize: scaleBasis.baseFontSize,
          baseHeight: scaleBasis.baseHeight
        })
      )
    }

    const handleCanvasReset = () => {
      setAttachedPreviewLayout(null)
    }

    window.addEventListener(`canvas-sync-${attachedParentItem.id}`, handleCanvasSync)
    window.addEventListener(`canvas-reset-${attachedParentItem.id}`, handleCanvasReset)

    return () => {
      window.removeEventListener(`canvas-sync-${attachedParentItem.id}`, handleCanvasSync)
      window.removeEventListener(`canvas-reset-${attachedParentItem.id}`, handleCanvasReset)
    }
  }, [attachedParentItem, item])

  React.useEffect(() => {
    setAttachedPreviewLayout(null)
  }, [
    attachedParentItem?.id,
    item.attachedToId,
    item.id,
    item.width,
    item.height,
    item.fontSize,
    item.x,
    item.y
  ])

  const previewItem = React.useMemo(
    () =>
      previewTransform
        ? {
            ...item,
            x: previewTransform.x,
            y: previewTransform.y,
            rotation: previewTransform.rotation,
            scaleX: previewTransform.scaleX,
            scaleY: previewTransform.scaleY
          }
        : item,
    [item, previewTransform]
  )

  const renderedItem = React.useMemo(
    () =>
      attachedPreviewLayout && !previewTransform
        ? {
            ...previewItem,
            x: attachedPreviewLayout.x,
            y: attachedPreviewLayout.y,
            width: attachedPreviewLayout.width,
            height: attachedPreviewLayout.height,
            fontSize: attachedPreviewLayout.fontSize
          }
        : previewItem,
    [attachedPreviewLayout, previewItem, previewTransform]
  )

  const shape = resolveCanvasAnnotationShape(renderedItem)
  const overlayBounds = getCanvasAnnotationOverlayBounds(renderedItem)
  const stroke = isEmphasized ? '#f59e0b' : renderedItem.stroke
  const fillOpacity = isEmphasized
    ? Math.max(renderedItem.fillOpacity, 0.2)
    : renderedItem.fillOpacity
  const strokeWidth = renderedItem.strokeWidth * (isEmphasized ? 1.6 : 1)
  const rectShape = !['arrow', 'line', 'freedraw'].includes(shape)
  const signX = renderedItem.scaleX < 0 ? -1 : 1
  const signY = renderedItem.scaleY < 0 ? -1 : 1
  const mirrorTransform =
    rectShape && (signX < 0 || signY < 0)
      ? `translate(${signX < 0 ? overlayBounds.width : 0} ${signY < 0 ? overlayBounds.height : 0}) scale(${signX} ${signY})`
      : undefined
  const textMirrorTransform =
    rectShape && (signX < 0 || signY < 0)
      ? `translate(${signX < 0 ? overlayBounds.width : 0}px, ${signY < 0 ? overlayBounds.height : 0}px) scale(${signX}, ${signY})`
      : undefined

  const linePoints = getCanvasAnnotationVisualLocalPoints(renderedItem)
  const lineBounds = getCanvasPointBounds(linePoints ?? [])
  const normalizedLinePoints =
    linePoints && lineBounds
      ? linePoints.map((point) => ({
          x: point.x - lineBounds.minX,
          y: point.y - lineBounds.minY
        }))
      : []

  const labelLayout =
    renderedItem.label && rectShape && shape !== 'text-anno'
      ? getAnnotationLabelLayout(renderedItem, stageScale)
      : null
  const labelFontSize =
    labelLayout && renderedItem.label
      ? fitAnnotationLabelFontSize(
          renderedItem.label,
          labelLayout.width,
          labelLayout.height,
          stageScale
        )
      : 0
  const textFontSize =
    (renderedItem.fontSize || 36) * Math.max(Math.abs(renderedItem.scaleY), 0.0001)

  return (
    <Box
      ref={overlayRef}
      data-canvas-item-id={item.id}
      data-canvas-overlay="annotation"
      style={{
        width: overlayBounds.width,
        height: overlayBounds.height,
        transform: `translate3d(${overlayBounds.x}px, ${overlayBounds.y}px, 0) rotate(${renderedItem.rotation}deg)`
      }}
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        willChange: 'transform',
        transformOrigin: '0 0',
        zIndex: renderedItem.zIndex,
        pointerEvents: 'none',
        opacity: isEditing ? 0 : 1,
        overflow: 'visible'
      }}
    >
      {shape === 'text-anno' ? (
        <Box
          data-canvas-annotation-text
          sx={{
            width: '100%',
            height: '100%',
            color: stroke,
            fontSize: `${textFontSize}px`,
            fontWeight: renderedItem.fontWeight === 'bold' ? '700' : '400',
            lineHeight: '1',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            overflow: 'hidden',
            pointerEvents: 'none',
            userSelect: 'none',
            transform: textMirrorTransform,
            transformOrigin: '0 0'
          }}
        >
          {renderedItem.text || ''}
        </Box>
      ) : (
        <svg
          width={overlayBounds.width}
          height={overlayBounds.height}
          viewBox={`0 0 ${overlayBounds.width} ${overlayBounds.height}`}
          style={{ overflow: 'visible', display: 'block' }}
        >
          {shape === 'ellipse' && (
            <ellipse
              cx={overlayBounds.width / 2}
              cy={overlayBounds.height / 2}
              rx={overlayBounds.width / 2}
              ry={overlayBounds.height / 2}
              fill={stroke}
              fillOpacity={fillOpacity}
              stroke={stroke}
              strokeWidth={strokeWidth}
            />
          )}
          {shape === 'circle' && (
            <ellipse
              cx={overlayBounds.width / 2}
              cy={overlayBounds.height / 2}
              rx={Math.min(overlayBounds.width, overlayBounds.height) / 2}
              ry={Math.min(overlayBounds.width, overlayBounds.height) / 2}
              fill={stroke}
              fillOpacity={fillOpacity}
              stroke={stroke}
              strokeWidth={strokeWidth}
            />
          )}
          {(shape === 'rect' || shape === 'rounded-rect') && (
            <rect
              width={overlayBounds.width}
              height={overlayBounds.height}
              rx={
                shape === 'rounded-rect'
                  ? Math.min(overlayBounds.width, overlayBounds.height) * 0.15
                  : 3
              }
              fill={stroke}
              fillOpacity={fillOpacity}
              stroke={stroke}
              strokeWidth={strokeWidth}
            />
          )}
          {shape === 'rhombus' && (
            <g transform={mirrorTransform}>
              <polygon
                points={`${overlayBounds.width / 2},0 ${overlayBounds.width},${overlayBounds.height / 2} ${overlayBounds.width / 2},${overlayBounds.height} 0,${overlayBounds.height / 2}`}
                fill={stroke}
                fillOpacity={fillOpacity}
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
            </g>
          )}
          {shape === 'parallelogram' && (
            <g transform={mirrorTransform}>
              <polygon
                points={`${overlayBounds.width * 0.2},0 ${overlayBounds.width},0 ${overlayBounds.width * 0.8},${overlayBounds.height} 0,${overlayBounds.height}`}
                fill={stroke}
                fillOpacity={fillOpacity}
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
            </g>
          )}
          {shape === 'double-line-rect' && (
            <g transform={mirrorTransform}>
              <rect
                width={overlayBounds.width}
                height={overlayBounds.height}
                fill={stroke}
                fillOpacity={fillOpacity}
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
              <rect
                x={Math.min(overlayBounds.width, overlayBounds.height) * 0.1}
                y={Math.min(overlayBounds.width, overlayBounds.height) * 0.1}
                width={Math.max(
                  0,
                  overlayBounds.width - Math.min(overlayBounds.width, overlayBounds.height) * 0.2
                )}
                height={Math.max(
                  0,
                  overlayBounds.height - Math.min(overlayBounds.width, overlayBounds.height) * 0.2
                )}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
            </g>
          )}
          {shape === 'document' && (
            <g transform={mirrorTransform}>
              <path
                d={`M0 0 H${overlayBounds.width * 0.8} L${overlayBounds.width} ${overlayBounds.height * 0.2} V${overlayBounds.height} H0 Z M${overlayBounds.width * 0.8} 0 V${overlayBounds.height * 0.2} H${overlayBounds.width}`}
                fill={stroke}
                fillOpacity={fillOpacity}
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
            </g>
          )}
          {shape === 'cylinder' && (
            <g transform={mirrorTransform}>
              <path
                d={`M0 ${overlayBounds.height * 0.15} V${overlayBounds.height * 0.85} A${overlayBounds.width / 2} ${overlayBounds.height * 0.15} 0 0 0 ${overlayBounds.width} ${overlayBounds.height * 0.85} V${overlayBounds.height * 0.15} A${overlayBounds.width / 2} ${overlayBounds.height * 0.15} 0 0 0 0 ${overlayBounds.height * 0.15}`}
                fill={stroke}
                fillOpacity={fillOpacity}
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
              <ellipse
                cx={overlayBounds.width / 2}
                cy={overlayBounds.height * 0.15}
                rx={overlayBounds.width / 2}
                ry={Math.min(overlayBounds.height * 0.15, overlayBounds.width * 0.5)}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
            </g>
          )}
          {(shape === 'arrow' || shape === 'line') &&
            normalizedLinePoints.length >= 2 &&
            (() => {
              const start = normalizedLinePoints[0]
              const end = normalizedLinePoints[1]
              const dx = end.x - start.x
              const dy = end.y - start.y
              const length = Math.max(Math.hypot(dx, dy), 1)
              const ux = dx / length
              const uy = dy / length
              const pointerLength = 14 / Math.max(stageScale, 0.0001)
              const pointerWidth = 12 / Math.max(stageScale, 0.0001)
              const arrowBaseX = end.x - ux * pointerLength
              const arrowBaseY = end.y - uy * pointerLength
              const normalX = -uy
              const normalY = ux
              return (
                <>
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {shape === 'arrow' && (
                    <polygon
                      points={`${end.x},${end.y} ${arrowBaseX + normalX * (pointerWidth / 2)},${arrowBaseY + normalY * (pointerWidth / 2)} ${arrowBaseX - normalX * (pointerWidth / 2)},${arrowBaseY - normalY * (pointerWidth / 2)}`}
                      fill={stroke}
                    />
                  )}
                </>
              )
            })()}
          {shape === 'freedraw' && normalizedLinePoints.length >= 2 && (
            <polyline
              points={normalizedLinePoints.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {labelLayout && item.label && (
            <foreignObject
              x={labelLayout.x}
              y={labelLayout.y}
              width={labelLayout.width}
              height={labelLayout.height}
            >
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  color: stroke,
                  fontSize: `${labelFontSize}px`,
                  fontWeight: 700,
                  lineHeight: LABEL_LINE_HEIGHT.toString(),
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  overflow: 'hidden'
                }}
              >
                {renderedItem.label}
              </div>
            </foreignObject>
          )}
        </svg>
      )}
    </Box>
  )
}

export default React.memo(
  CanvasAnnotationOverlay,
  (prev, next) =>
    prev.item === next.item &&
    prev.attachedParentItem === next.attachedParentItem &&
    prev.isEditing === next.isEditing &&
    prev.isEmphasized === next.isEmphasized &&
    prev.stageScale === next.stageScale
)
