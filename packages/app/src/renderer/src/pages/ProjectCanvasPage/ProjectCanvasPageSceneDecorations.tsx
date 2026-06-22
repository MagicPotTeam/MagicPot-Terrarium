import React from 'react'
import { Box } from '@mui/material'

type StagePosition = {
  x: number
  y: number
}

type Bounds = {
  x: number
  y: number
  width: number
  height: number
}

type DrawingState = {
  shape: string
  startX: number
  startY: number
  x: number
  y: number
  w: number
  h: number
  endX?: number
  endY?: number
  points?: number[]
}

type SelectionRect = {
  x: number
  y: number
  w: number
  h: number
} | null

type SelectionRectRenderMode = 'imperative' | 'react'

type SelectionOverlayGroup = {
  id: string
  bounds: Bounds
}

type ExactSelectedGroup = {
  id: string
} | null

const SELECTION_RECT_BASE_STYLE = {
  position: 'absolute',
  overflow: 'visible'
} as const

function toRgbaHex(color: string, opacity: number): string | undefined {
  const normalized = color.trim()
  if (!normalized.startsWith('#')) {
    return opacity > 0 ? normalized : undefined
  }

  const hex = normalized.slice(1)
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : hex.length === 6
        ? hex
        : null

  if (!expanded) {
    return opacity > 0 ? normalized : undefined
  }

  const alpha = Math.round(Math.min(Math.max(opacity, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0')
  return `#${expanded}${alpha}`
}

function buildPreviewStrokeDash(stageScale: number): string {
  return `${8 / stageScale} ${4 / stageScale}`
}

function buildSelectionDash(tool: string, stageScale: number): string {
  if (tool === 'export-select') {
    return `${6 / stageScale} ${6 / stageScale}`
  }

  if (tool === 'target-select' || tool === 'crop-select' || tool === 'extract-select') {
    return `${8 / stageScale} ${4 / stageScale}`
  }

  return `${6 / stageScale} ${3 / stageScale}`
}

function getSelectionColors(tool: string) {
  if (tool === 'export-select') {
    return {
      fill: 'rgba(34,197,94,0.08)',
      stroke: '#22c55e'
    }
  }

  if (tool === 'target-select') {
    return {
      fill: 'rgba(249,115,22,0.10)',
      stroke: '#f97316'
    }
  }

  if (tool === 'extract-select') {
    return {
      fill: 'rgba(14,165,233,0.10)',
      stroke: '#0ea5e9'
    }
  }

  return {
    fill: 'rgba(99,102,241,0.08)',
    stroke: '#6366f1'
  }
}

function buildLineBounds(points: number[], padding: number) {
  const xs = points.filter((_, index) => index % 2 === 0)
  const ys = points.filter((_, index) => index % 2 === 1)
  const minX = Math.min(...xs) - padding
  const maxX = Math.max(...xs) + padding
  const minY = Math.min(...ys) - padding
  const maxY = Math.max(...ys) + padding

  return {
    left: minX,
    top: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    localPoints: points.map((value, index) => value - (index % 2 === 0 ? minX : minY))
  }
}

function applySelectionRectGeometry(
  svg: SVGSVGElement | null,
  rectEl: SVGRectElement | null,
  selectionRect: SelectionRect
) {
  if (!svg || !rectEl) {
    return
  }

  if (!selectionRect || selectionRect.w <= 2 || selectionRect.h <= 2) {
    svg.style.display = 'none'
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    rectEl.removeAttribute('width')
    rectEl.removeAttribute('height')
    return
  }

  svg.style.display = ''
  svg.style.left = `${selectionRect.x}px`
  svg.style.top = `${selectionRect.y}px`
  svg.setAttribute('width', String(selectionRect.w))
  svg.setAttribute('height', String(selectionRect.h))
  rectEl.setAttribute('width', String(selectionRect.w))
  rectEl.setAttribute('height', String(selectionRect.h))
}

export function ProjectCanvasPageSceneOverlay({
  annotationColor,
  annotationFillOpacity,
  drawingState,
  exactSelectedGroup,
  isFillableShape,
  onSelectionRectElementsChange,
  selectionOverlayGroups,
  selectionRect,
  selectionRectRenderMode = 'react',
  stagePos,
  stageScale,
  tool
}: {
  annotationColor: string
  annotationFillOpacity: number
  drawingState: DrawingState | null
  exactSelectedGroup: ExactSelectedGroup
  isFillableShape: (shape: string) => boolean
  onSelectionRectElementsChange?: (
    elements: { svg: SVGSVGElement; rect: SVGRectElement } | null
  ) => void
  selectionOverlayGroups: SelectionOverlayGroup[]
  selectionRect: SelectionRect
  selectionRectRenderMode?: SelectionRectRenderMode
  stagePos: StagePosition
  stageScale: number
  tool: string
}) {
  const selectionRectSvgRef = React.useRef<SVGSVGElement | null>(null)
  const selectionRectRectRef = React.useRef<SVGRectElement | null>(null)
  const publishSelectionRectElements = React.useCallback(() => {
    if (!onSelectionRectElementsChange) {
      return
    }

    const svg = selectionRectSvgRef.current
    const rect = selectionRectRectRef.current
    onSelectionRectElementsChange(svg && rect ? { svg, rect } : null)
  }, [onSelectionRectElementsChange])
  const handleSelectionRectSvgRef = React.useCallback(
    (node: SVGSVGElement | null) => {
      selectionRectSvgRef.current = node
      publishSelectionRectElements()
    },
    [publishSelectionRectElements]
  )
  const handleSelectionRectRectRef = React.useCallback(
    (node: SVGRectElement | null) => {
      selectionRectRectRef.current = node
      publishSelectionRectElements()
    },
    [publishSelectionRectElements]
  )

  React.useEffect(
    () => () => {
      onSelectionRectElementsChange?.(null)
    },
    [onSelectionRectElementsChange]
  )

  const arrowMarkerId = React.useId()
  const previewStrokeWidth = 2 / stageScale
  const previewStrokeDash = buildPreviewStrokeDash(stageScale)
  const fillPreview =
    annotationFillOpacity > 0 ? toRgbaHex(annotationColor, annotationFillOpacity) : undefined
  const shouldFillPreview = Boolean(
    fillPreview && drawingState && isFillableShape(drawingState.shape)
  )
  const selectionColors = getSelectionColors(tool)
  const selectionStrokeDash = buildSelectionDash(tool, stageScale)

  React.useLayoutEffect(() => {
    if (selectionRectRenderMode !== 'react') {
      return
    }

    applySelectionRectGeometry(
      selectionRectSvgRef.current,
      selectionRectRectRef.current,
      selectionRect
    )
  }, [selectionRect, selectionRectRenderMode])

  React.useLayoutEffect(() => {
    if (selectionRectRenderMode !== 'imperative') {
      return
    }

    applySelectionRectGeometry(selectionRectSvgRef.current, selectionRectRectRef.current, null)
  }, [selectionRectRenderMode])

  const renderDrawingPreview = () => {
    if (!drawingState) {
      return null
    }

    if (
      (drawingState.shape === 'arrow' || drawingState.shape === 'line') &&
      drawingState.endX != null &&
      drawingState.endY != null
    ) {
      const bounds = buildLineBounds(
        [drawingState.startX, drawingState.startY, drawingState.endX, drawingState.endY],
        Math.max(12 / stageScale, previewStrokeWidth * 2)
      )

      return (
        <svg
          style={{
            position: 'absolute',
            left: bounds.left,
            top: bounds.top,
            overflow: 'visible'
          }}
          width={bounds.width}
          height={bounds.height}
        >
          <defs>
            <marker
              id={arrowMarkerId}
              markerWidth={12 / stageScale}
              markerHeight={10 / stageScale}
              refX={12 / stageScale}
              refY={5 / stageScale}
              orient="auto"
            >
              <path
                d={`M0,0 L${12 / stageScale},${5 / stageScale} L0,${10 / stageScale} z`}
                fill={annotationColor}
              />
            </marker>
          </defs>
          <line
            x1={bounds.localPoints[0]}
            y1={bounds.localPoints[1]}
            x2={bounds.localPoints[2]}
            y2={bounds.localPoints[3]}
            stroke={annotationColor}
            strokeWidth={previewStrokeWidth}
            strokeDasharray={previewStrokeDash}
            markerEnd={drawingState.shape === 'arrow' ? `url(#${arrowMarkerId})` : undefined}
          />
        </svg>
      )
    }

    if (
      drawingState.shape === 'freedraw' &&
      drawingState.points &&
      drawingState.points.length > 2
    ) {
      const bounds = buildLineBounds(drawingState.points, previewStrokeWidth * 2)
      const polylinePoints = bounds.localPoints
        .reduce<string[]>((parts, value, index) => {
          if (index % 2 === 0) {
            parts.push(`${value},${bounds.localPoints[index + 1] ?? 0}`)
          }
          return parts
        }, [])
        .join(' ')

      return (
        <svg
          style={{
            position: 'absolute',
            left: bounds.left,
            top: bounds.top,
            overflow: 'visible'
          }}
          width={bounds.width}
          height={bounds.height}
        >
          <polyline
            points={polylinePoints}
            fill="none"
            stroke={annotationColor}
            strokeWidth={previewStrokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    }

    if (drawingState.shape === 'ellipse' && drawingState.w > 2 && drawingState.h > 2) {
      return (
        <svg
          style={{
            position: 'absolute',
            left: drawingState.x,
            top: drawingState.y,
            overflow: 'visible'
          }}
          width={drawingState.w}
          height={drawingState.h}
        >
          <ellipse
            cx={drawingState.w / 2}
            cy={drawingState.h / 2}
            rx={drawingState.w / 2}
            ry={drawingState.h / 2}
            fill={shouldFillPreview ? fillPreview : 'transparent'}
            stroke={annotationColor}
            strokeWidth={previewStrokeWidth}
            strokeDasharray={previewStrokeDash}
          />
        </svg>
      )
    }

    if (drawingState.shape === 'circle' && drawingState.w > 2 && drawingState.h > 2) {
      const radius = Math.min(drawingState.w, drawingState.h) / 2
      return (
        <svg
          style={{
            position: 'absolute',
            left: drawingState.x,
            top: drawingState.y,
            overflow: 'visible'
          }}
          width={drawingState.w}
          height={drawingState.h}
        >
          <ellipse
            cx={drawingState.w / 2}
            cy={drawingState.h / 2}
            rx={radius}
            ry={radius}
            fill={shouldFillPreview ? fillPreview : 'transparent'}
            stroke={annotationColor}
            strokeWidth={previewStrokeWidth}
            strokeDasharray={previewStrokeDash}
          />
        </svg>
      )
    }

    if (
      [
        'rect',
        'rhombus',
        'parallelogram',
        'double-line-rect',
        'document',
        'cylinder',
        'rounded-rect'
      ].includes(drawingState.shape) &&
      drawingState.w > 2 &&
      drawingState.h > 2
    ) {
      return (
        <svg
          style={{
            position: 'absolute',
            left: drawingState.x,
            top: drawingState.y,
            overflow: 'visible'
          }}
          width={drawingState.w}
          height={drawingState.h}
        >
          <rect
            x={0}
            y={0}
            width={drawingState.w}
            height={drawingState.h}
            rx={
              drawingState.shape === 'rounded-rect'
                ? Math.min(drawingState.w, drawingState.h) * 0.15
                : 3
            }
            ry={
              drawingState.shape === 'rounded-rect'
                ? Math.min(drawingState.w, drawingState.h) * 0.15
                : 3
            }
            fill={shouldFillPreview ? fillPreview : 'transparent'}
            stroke={annotationColor}
            strokeWidth={previewStrokeWidth}
            strokeDasharray={previewStrokeDash}
          />
        </svg>
      )
    }

    if (drawingState.shape === 'text-anno' && drawingState.w > 2 && drawingState.h > 2) {
      return (
        <svg
          style={{
            position: 'absolute',
            left: drawingState.x,
            top: drawingState.y,
            overflow: 'visible'
          }}
          width={drawingState.w}
          height={drawingState.h}
        >
          <rect
            x={0}
            y={0}
            width={drawingState.w}
            height={drawingState.h}
            fill="transparent"
            stroke={annotationColor}
            strokeWidth={previewStrokeWidth}
            strokeDasharray={previewStrokeDash}
          />
        </svg>
      )
    }

    return null
  }

  return (
    <Box
      data-project-canvas-scene-overlay="dom"
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none'
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          overflow: 'visible',
          pointerEvents: 'none',
          transform: `translate3d(${stagePos.x}px, ${stagePos.y}px, 0) scale(${stageScale})`,
          transformOrigin: '0 0',
          willChange: 'transform'
        }}
      >
        {renderDrawingPreview()}
        {/* Selection rect: always rendered, visibility driven imperatively via data attrs */}
        <svg
          ref={handleSelectionRectSvgRef}
          data-canvas-selection-rect="svg"
          style={SELECTION_RECT_BASE_STYLE}
        >
          <rect
            ref={handleSelectionRectRectRef}
            data-canvas-selection-rect="rect"
            x={0}
            y={0}
            fill={selectionColors.fill}
            stroke={selectionColors.stroke}
            strokeWidth={1 / stageScale}
            strokeDasharray={selectionStrokeDash}
          />
        </svg>
        {tool === 'select' &&
          selectionOverlayGroups.map((group) => (
            <svg
              key={`group-outline-${group.id}`}
              style={{
                position: 'absolute',
                left: group.bounds.x,
                top: group.bounds.y,
                overflow: 'visible'
              }}
              width={group.bounds.width}
              height={group.bounds.height}
            >
              <rect
                x={0}
                y={0}
                width={group.bounds.width}
                height={group.bounds.height}
                fill="transparent"
                stroke={exactSelectedGroup?.id === group.id ? '#22c55e' : '#60a5fa'}
                strokeWidth={1.5 / stageScale}
                strokeDasharray={`${8 / stageScale} ${4 / stageScale}`}
              />
            </svg>
          ))}
      </Box>
    </Box>
  )
}
