import React from 'react'
import { Box } from '@mui/material'
import type { CanvasTextItem } from '../types'
import { CANVAS_TEXT_LINE_HEIGHT, CANVAS_TEXT_PADDING, CANVAS_TEXT_WRAP } from '../canvasTextLayout'
import type { CanvasSyncDetail } from './canvasSync'

type CanvasTextOverlayProps = {
  item: CanvasTextItem
  isSelected: boolean
  showSelectionOutline?: boolean
  isEditing?: boolean
}

function buildCanvasTextTransform(options: {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
}) {
  const { x, y, rotation, scaleX, scaleY } = options
  return `translate3d(${x}px, ${y}px, 0) rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`
}

type CanvasTextOverlayTransform = Pick<CanvasTextItem, 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'>

export function CanvasTextOverlayContent({ item }: { item: CanvasTextItem }) {
  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        p: `${CANVAS_TEXT_PADDING}px`,
        color: item.fill,
        fontSize: `${item.fontSize}px`,
        fontFamily: item.fontFamily,
        fontWeight: item.fontWeight === 'bold' ? 700 : 400,
        lineHeight: CANVAS_TEXT_LINE_HEIGHT,
        whiteSpace: CANVAS_TEXT_WRAP === 'char' ? 'pre-wrap' : 'normal',
        wordBreak: CANVAS_TEXT_WRAP === 'char' ? 'break-all' : 'break-word',
        overflowWrap: 'anywhere',
        overflow: 'hidden'
      }}
    >
      {item.text}
    </Box>
  )
}

export function CanvasTextOverlayFrame({
  item,
  children,
  shouldShowSelectionOutline,
  isEditing = false
}: {
  item: CanvasTextItem
  children: React.ReactNode
  shouldShowSelectionOutline: boolean
  isEditing?: boolean
}) {
  return (
    <Box
      style={{
        width: item.width,
        height: item.height
      }}
      sx={{
        boxSizing: 'border-box',
        overflow: 'hidden',
        borderRadius: '6px',
        bgcolor: 'rgba(30,30,30,0.85)',
        boxShadow: shouldShowSelectionOutline
          ? 'inset 0 0 0 2px #6366f1, 0 0 12px rgba(99,102,241,0.5)'
          : 'inset 0 0 0 1px rgba(255,255,255,0.1)',
        opacity: isEditing ? 0 : 1,
        pointerEvents: 'none',
        userSelect: 'none'
      }}
    >
      {children}
    </Box>
  )
}

const CanvasTextOverlay: React.FC<CanvasTextOverlayProps> = ({
  item,
  isSelected,
  showSelectionOutline,
  isEditing = false
}) => {
  const shouldShowSelectionOutline = showSelectionOutline ?? isSelected
  const boxRef = React.useRef<HTMLDivElement | null>(null)

  const applyTextLayout = React.useCallback((detail: CanvasTextOverlayTransform) => {
    const node = boxRef.current
    if (!node) {
      return
    }

    node.style.transform = buildCanvasTextTransform(detail)
  }, [])

  const resetTextLayout = React.useCallback(() => {
    applyTextLayout({
      x: item.x,
      y: item.y,
      rotation: item.rotation,
      scaleX: item.scaleX,
      scaleY: item.scaleY
    })
  }, [applyTextLayout, item.rotation, item.scaleX, item.scaleY, item.x, item.y])

  React.useLayoutEffect(() => {
    resetTextLayout()
  }, [resetTextLayout])

  React.useEffect(() => {
    const handleCanvasSync = (event: Event) => {
      const detail = (event as CustomEvent<CanvasSyncDetail>).detail
      if (!detail) {
        return
      }

      applyTextLayout(detail)
    }

    const handleCanvasReset = () => {
      resetTextLayout()
    }

    window.addEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
    window.addEventListener(`canvas-reset-${item.id}`, handleCanvasReset)

    return () => {
      window.removeEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
      window.removeEventListener(`canvas-reset-${item.id}`, handleCanvasReset)
    }
  }, [applyTextLayout, item.id, resetTextLayout])

  return (
    <Box
      ref={boxRef}
      data-canvas-item-id={item.id}
      data-canvas-overlay="text"
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        willChange: 'transform',
        transformOrigin: '0 0',
        zIndex: item.zIndex
      }}
    >
      <CanvasTextOverlayFrame
        item={item}
        shouldShowSelectionOutline={shouldShowSelectionOutline}
        isEditing={isEditing}
      >
        <CanvasTextOverlayContent item={item} />
      </CanvasTextOverlayFrame>
    </Box>
  )
}

export default React.memo(
  CanvasTextOverlay,
  (prev, next) =>
    prev.item === next.item &&
    prev.isSelected === next.isSelected &&
    prev.showSelectionOutline === next.showSelectionOutline &&
    prev.isEditing === next.isEditing
)
