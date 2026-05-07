import React, { useEffect, useMemo, useRef } from 'react'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasImageItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from '../types'
import type { ProjectCanvasImagePreview } from '../projectCanvasRenderBoundary'
import { cancelCanvasSync, scheduleCanvasSync } from './canvasSync'
import CanvasImageDomPreview from './CanvasImageDomPreview'
import ProjectCanvasRectItemInteractionOverlay, {
  type ProjectCanvasRectItemTransform
} from './ProjectCanvasRectItemInteractionOverlay'

type PlaceholderItem =
  | CanvasAnnotationItem
  | CanvasFileItem
  | CanvasImageItem
  | CanvasModel3DItem
  | CanvasTextItem
  | CanvasVideoItem

type CanvasProxyRect = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
}

type CanvasItemPlaceholderProps = {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  item: PlaceholderItem
  isSelected: boolean
  isDraggable?: boolean
  renderMode?: string
  visualVariant?: 'transparent' | 'image-fallback'
  proxyRect?: CanvasProxyRect
  stagePos: { x: number; y: number }
  stageScale: number
  stagePosRef?: React.MutableRefObject<{ x: number; y: number }>
  stageScaleRef?: React.MutableRefObject<number>
  onPreviewChange?: (itemId: string, preview: ProjectCanvasImagePreview | null) => void
  onRectPreviewChange?: (itemId: string, preview: ProjectCanvasRectItemTransform | null) => void
  allowPointerPassthrough?: boolean
  onDragStart?: (itemId: string) => void
  onSelect: (additiveSelection?: boolean) => void
  onDoubleClick?: () => void
  onDragEnd: (id: string, x: number, y: number, evt?: PointerEvent) => void
  onTransformEnd: (id: string, attrs: Partial<PlaceholderItem>) => void
  onContextMenu?: (event: MouseEvent | PointerEvent) => void
  onHoverChange?: (isHovering: boolean) => void
}

const CanvasItemPlaceholder: React.FC<CanvasItemPlaceholderProps> = ({
  canvasContainerRef,
  item,
  isSelected,
  isDraggable = !item.locked,
  renderMode,
  visualVariant = 'transparent',
  proxyRect,
  stagePos,
  stageScale,
  stagePosRef,
  stageScaleRef,
  onPreviewChange,
  onRectPreviewChange,
  allowPointerPassthrough = false,
  onDragStart,
  onSelect,
  onDoubleClick,
  onDragEnd,
  onTransformEnd,
  onContextMenu,
  onHoverChange
}) => {
  const isBodyCursorOwnedRef = useRef(false)

  useEffect(() => {
    return () => {
      if (isBodyCursorOwnedRef.current && document.body.style.cursor === 'move') {
        document.body.style.removeProperty('cursor')
      }
      isBodyCursorOwnedRef.current = false
      cancelCanvasSync(item.id)
      onPreviewChange?.(item.id, null)
      onRectPreviewChange?.(item.id, null)
    }
  }, [item.id, onPreviewChange, onRectPreviewChange])

  const interactionItem = useMemo(
    () => ({
      id: item.id,
      x: proxyRect?.x ?? item.x,
      y: proxyRect?.y ?? item.y,
      width: proxyRect?.width ?? item.width,
      height: proxyRect?.height ?? item.height,
      scaleX: proxyRect?.scaleX ?? item.scaleX,
      scaleY: proxyRect?.scaleY ?? item.scaleY,
      rotation: proxyRect?.rotation ?? item.rotation,
      zIndex: item.zIndex
    }),
    [item, proxyRect]
  )
  const previewContent = useMemo(() => {
    if (item.type !== 'image' || visualVariant !== 'image-fallback') {
      return null
    }

    return (
      <CanvasImageDomPreview
        item={item}
        previewMode="image-fallback"
        stageScale={stageScale}
        sourceImagePreview={!item.image}
      />
    )
  }, [item, stageScale, visualVariant])

  const handlePreviewChange = React.useCallback(
    (_itemId: string, preview: ProjectCanvasRectItemTransform | null) => {
      if (item.type === 'annotation') {
        onRectPreviewChange?.(item.id, preview)
        return
      }

      if (preview) {
        scheduleCanvasSync(item.id, preview)
      } else {
        cancelCanvasSync(item.id)
      }

      if (item.type !== 'image') {
        onRectPreviewChange?.(item.id, preview)
        return
      }

      onPreviewChange?.(
        item.id,
        preview
          ? {
              ...preview,
              width: item.width,
              height: item.height
            }
          : null
      )
    },
    [item, onPreviewChange, onRectPreviewChange]
  )

  const handleHoverStateChange = React.useCallback(
    (isHovering: boolean) => {
      if (isHovering) {
        document.body.style.cursor = 'move'
        isBodyCursorOwnedRef.current = true
      } else if (isBodyCursorOwnedRef.current && document.body.style.cursor === 'move') {
        document.body.style.removeProperty('cursor')
        isBodyCursorOwnedRef.current = false
      }
      window.dispatchEvent(new CustomEvent(`canvas-hover-${item.id}`, { detail: isHovering }))
      onHoverChange?.(isHovering)
    },
    [item.id, onHoverChange]
  )

  return (
    <ProjectCanvasRectItemInteractionOverlay
      canvasContainerRef={canvasContainerRef}
      item={interactionItem}
      isSelected={isSelected}
      isDraggable={isDraggable}
      showTransformer={false}
      previewContent={previewContent}
      visualVariant={visualVariant}
      stagePos={stagePos}
      stageScale={stageScale}
      stagePosRef={stagePosRef}
      stageScaleRef={stageScaleRef}
      overlayRole={renderMode ?? 'dom-placeholder-proxy'}
      onPreviewChange={handlePreviewChange}
      allowPointerPassthrough={allowPointerPassthrough}
      onDragStart={onDragStart}
      onSelect={onSelect}
      onDragEnd={onDragEnd}
      onTransformEnd={(id, attrs) => onTransformEnd(id, attrs as Partial<PlaceholderItem>)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onHoverChange={handleHoverStateChange}
    />
  )
}

export default React.memo(CanvasItemPlaceholder, (prev, next) => {
  const canUseStageRefs =
    prev.stagePosRef != null &&
    prev.stageScaleRef != null &&
    prev.stagePosRef === next.stagePosRef &&
    prev.stageScaleRef === next.stageScaleRef
  const requiresViewportSync =
    prev.visualVariant === 'image-fallback' || next.visualVariant === 'image-fallback'

  return (
    prev.canvasContainerRef === next.canvasContainerRef &&
    prev.item === next.item &&
    prev.isSelected === next.isSelected &&
    prev.isDraggable === next.isDraggable &&
    prev.renderMode === next.renderMode &&
    prev.visualVariant === next.visualVariant &&
    prev.proxyRect === next.proxyRect &&
    prev.allowPointerPassthrough === next.allowPointerPassthrough &&
    (!requiresViewportSync
      ? canUseStageRefs || (prev.stagePos === next.stagePos && prev.stageScale === next.stageScale)
      : prev.stagePos.x === next.stagePos.x &&
        prev.stagePos.y === next.stagePos.y &&
        prev.stageScale === next.stageScale) &&
    prev.stagePosRef === next.stagePosRef &&
    prev.stageScaleRef === next.stageScaleRef
  )
})
