import React, { useRef, useEffect } from 'react'
import { Box, IconButton } from '@mui/material'
import { Close as CloseIcon, TouchApp as InteractiveIcon } from '@mui/icons-material'
import type { CanvasHtmlItem } from '../types'
import { CANVAS_OCR_HOVER_EVENT, type CanvasOcrHoverDetail } from '../ocrCanvasUtils'

interface HtmlOverlayProps {
  item: CanvasHtmlItem
  isSelected: boolean
  stagePos: { x: number; y: number }
  stageScale: number
  activeOcrHover: CanvasOcrHoverDetail | null
  allowPointerPassthrough?: boolean
  onSelect: () => void
  onUpdateItem: (id: string, updates: Partial<CanvasHtmlItem>) => void
  onDelete: (id: string) => void
}

const HtmlOverlay: React.FC<HtmlOverlayProps> = ({
  item,
  isSelected,
  stagePos,
  stageScale,
  activeOcrHover,
  allowPointerPassthrough = false,
  onSelect,
  onUpdateItem,
  onDelete
}) => {
  const boxRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Canvas coordinates (parent container handles translate + scale)
  const canvasW = item.width * item.scaleX
  const canvasH = item.height * item.scaleY

  // Sync overlay drag position (canvas coords)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!boxRef.current) return
      const cw = item.width * detail.scaleX
      const ch = item.height * detail.scaleY
      const node = boxRef.current
      node.style.width = `${cw}px`
      node.style.height = `${ch}px`
      const rot = detail.rotation ? ` rotate(${detail.rotation}deg)` : ''
      node.style.transform = `translate3d(${detail.x}px, ${detail.y}px, 0)${rot}`
    }
    window.addEventListener(`canvas-sync-${item.id}`, handler)

    return () => {
      window.removeEventListener(`canvas-sync-${item.id}`, handler)
    }
  }, [item.id, item.width, item.height])

  useEffect(() => {
    if (!item.ocrBundleId || !contentRef.current) {
      return
    }

    const root = contentRef.current
    const dispatchHover = (detail: CanvasOcrHoverDetail) => {
      window.dispatchEvent(new CustomEvent(CANVAS_OCR_HOVER_EVENT, { detail }))
    }

    let activeCell: HTMLElement | null = null

    const clearHover = () => {
      activeCell = null
      dispatchHover({
        bundleId: item.ocrBundleId!,
        bboxIds: [],
        cellIds: []
      })
    }

    const handlePointerOver = (event: PointerEvent) => {
      const nextCell = (event.target as HTMLElement | null)?.closest?.(
        '[data-ocr-cell-id]'
      ) as HTMLElement | null

      if (!nextCell || nextCell === activeCell) {
        return
      }

      activeCell = nextCell
      const cellId = nextCell.dataset.ocrCellId?.trim()
      const bboxIds = nextCell.dataset.ocrBboxIds
        ?.split(',')
        .map((value) => value.trim())
        .filter(Boolean)

      dispatchHover({
        bundleId: item.ocrBundleId!,
        bboxIds: bboxIds || [],
        cellIds: cellId ? [cellId] : []
      })
    }

    root.addEventListener('pointerover', handlePointerOver)
    root.addEventListener('pointerleave', clearHover)

    return () => {
      root.removeEventListener('pointerover', handlePointerOver)
      root.removeEventListener('pointerleave', clearHover)
      clearHover()
    }
  }, [item.ocrBundleId])

  useEffect(() => {
    const root = contentRef.current
    if (!root) {
      return
    }

    const cells = Array.from(root.querySelectorAll<HTMLElement>('[data-ocr-cell-id]'))
    for (const cell of cells) {
      const isActive =
        Boolean(item.ocrBundleId) &&
        activeOcrHover?.bundleId === item.ocrBundleId &&
        Boolean(cell.dataset.ocrCellId) &&
        Boolean(activeOcrHover?.cellIds.includes(cell.dataset.ocrCellId as string))

      cell.classList.toggle('is-active', isActive)
    }
  }, [activeOcrHover, item.ocrBundleId, item.htmlData])

  const toggleInteractive = (e: React.MouseEvent) => {
    e.stopPropagation()
    onUpdateItem(item.id, { interactive: !item.interactive })
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(item.id)
  }

  return (
    <Box
      ref={boxRef}
      data-canvas-item-id={item.id}
      data-canvas-overlay="html"
      data-canvas-render-surface="html-overlay"
      onPointerDown={onSelect}
      style={{
        width: canvasW,
        height: canvasH,
        transform: `translate3d(${item.x}px, ${item.y}px, 0)${item.rotation ? ` rotate(${item.rotation}deg)` : ''}`
      }}
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        willChange: 'transform, width, height',
        transformOrigin: '0 0',
        zIndex: item.zIndex,
        borderRadius: '6px',
        overflow: 'hidden',
        border: isSelected ? '2px solid #6366f1' : '1px solid rgba(100,100,100,0.2)',
        boxShadow: isSelected ? '0 0 16px rgba(99,102,241,0.4)' : '0 2px 8px rgba(0,0,0,0.3)',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        pointerEvents: allowPointerPassthrough ? 'none' : item.interactive ? 'auto' : 'none',
        ...(allowPointerPassthrough
          ? {
              '& *': {
                pointerEvents: 'none !important'
              }
            }
          : null),
        bgcolor: '#ffffff',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* 顶部控制条 (悬停或选中时显示) */}
      {(isSelected || item.interactive) && (
        <Box
          sx={{
            height: 24,
            bgcolor: 'rgba(230, 230, 230, 0.9)',
            borderBottom: '1px solid #ccc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 1,
            pointerEvents: allowPointerPassthrough ? 'none' : 'auto',
            cursor: 'default'
          }}
          onPointerDown={(e) => {
            // allows the top bar to keep the drag surface hit-tested if we stop propagating?
            // actually we let it fall through or we might just use onSelect
          }}
        >
          <Box sx={{ fontSize: 10, color: '#666', fontWeight: 600 }}>A2UI Component</Box>
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <IconButton
              size="small"
              onClick={toggleInteractive}
              sx={{ p: 0.2 }}
              title={item.interactive ? '禁用交互 (允许拖拽)' : '启用交互'}
            >
              <InteractiveIcon
                sx={{ fontSize: 14, color: item.interactive ? '#6366f1' : '#999' }}
              />
            </IconButton>
            <IconButton size="small" onClick={handleDelete} sx={{ p: 0.2 }}>
              <CloseIcon sx={{ fontSize: 14, color: '#ef4444' }} />
            </IconButton>
          </Box>
        </Box>
      )}

      {/* 渲染的主内容 */}
      <Box
        ref={contentRef}
        sx={{
          flex: 1,
          overflow: 'auto',
          width: '100%',
          height: '100%'
        }}
        dangerouslySetInnerHTML={{ __html: item.htmlData }}
      />
    </Box>
  )
}

export default React.memo(
  HtmlOverlay,
  (prev, next) =>
    prev.item === next.item &&
    prev.isSelected === next.isSelected &&
    prev.allowPointerPassthrough === next.allowPointerPassthrough &&
    prev.stageScale === next.stageScale &&
    prev.activeOcrHover === next.activeOcrHover
)
