import { Box } from '@mui/material'
import React from 'react'
import type { CanvasImageItem } from '../types'
import { STAGE_VIEWPORT_LAYER_BASE_STYLE } from '../useStageViewportTransformDriver'
import CanvasImageDomPreview from './CanvasImageDomPreview'

export type CanvasHighResolutionImageDomLayerProps = {
  items: CanvasImageItem[]
  stageScale: number
  registerViewportLayer: (element: HTMLElement | null) => void
}

function buildCanvasImageDomTransform(
  item: Pick<CanvasImageItem, 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'>
) {
  return `translate3d(${item.x}px, ${item.y}px, 0) rotate(${item.rotation}deg) scale(${item.scaleX}, ${item.scaleY})`
}

function CanvasHighResolutionImageItem({
  item,
  stageScale
}: {
  item: CanvasImageItem
  stageScale: number
}) {
  const itemRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const element = itemRef.current
    if (!element) {
      return
    }

    const applyTransform = (source: CanvasImageItem) => {
      element.style.transform = buildCanvasImageDomTransform(source)
    }
    const handleCanvasSync = (event: Event) => {
      const detail = (event as CustomEvent<Partial<CanvasImageItem>>).detail
      applyTransform({ ...item, ...detail })
    }
    const handleCanvasReset = () => {
      applyTransform(item)
    }

    applyTransform(item)
    window.addEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
    window.addEventListener(`canvas-reset-${item.id}`, handleCanvasReset)
    return () => {
      window.removeEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
      window.removeEventListener(`canvas-reset-${item.id}`, handleCanvasReset)
    }
  }, [item])

  return (
    <Box
      ref={itemRef}
      data-project-canvas-high-res-image-item-id={item.id}
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: item.width,
        height: item.height,
        overflow: 'hidden',
        transform: buildCanvasImageDomTransform(item),
        transformOrigin: '0 0',
        pointerEvents: 'none',
        zIndex: item.zIndex
      }}
    >
      <CanvasImageDomPreview
        item={item}
        previewMode="high-res-source"
        borderRadius="4px"
        stageScale={stageScale}
        sourceImagePreview
      />
    </Box>
  )
}

export default function CanvasHighResolutionImageDomLayer({
  items,
  stageScale,
  registerViewportLayer
}: CanvasHighResolutionImageDomLayerProps) {
  if (items.length === 0) {
    return null
  }

  return (
    <Box
      data-project-canvas-high-res-image-layer="dom"
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'visible',
        pointerEvents: 'none'
      }}
    >
      <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
        {items.map((item) => (
          <CanvasHighResolutionImageItem key={item.id} item={item} stageScale={stageScale} />
        ))}
      </div>
    </Box>
  )
}
