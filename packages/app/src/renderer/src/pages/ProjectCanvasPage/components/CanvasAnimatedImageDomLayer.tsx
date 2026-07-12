import { Box } from '@mui/material'
import React from 'react'
import type { CanvasImageItem } from '../types'
import { STAGE_VIEWPORT_LAYER_BASE_STYLE } from '../useStageViewportTransformDriver'
import CanvasImageDomPreview from './CanvasImageDomPreview'

export type CanvasAnimatedImageDomLayerProps = {
  items: CanvasImageItem[]
  stageScale: number
  registerViewportLayer: (element: HTMLElement | null) => void
}

type CanvasAnimatedImageItemProps = {
  item: CanvasImageItem
  stageScale: number
}

function buildCanvasAnimatedImageTransform(
  item: Pick<CanvasImageItem, 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'>
) {
  return `translate3d(${item.x}px, ${item.y}px, 0) rotate(${item.rotation}deg) scale(${item.scaleX}, ${item.scaleY})`
}

function CanvasAnimatedImageItem({ item, stageScale }: CanvasAnimatedImageItemProps) {
  const itemRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const element = itemRef.current
    if (!element) {
      return
    }

    const applyTransform = (source: CanvasImageItem) => {
      element.style.transform = buildCanvasAnimatedImageTransform(source)
    }
    const handleCanvasSync = (event: Event) => {
      const detail = (event as CustomEvent<Partial<CanvasImageItem>>).detail
      applyTransform({ ...item, ...detail })
    }

    applyTransform(item)
    window.addEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
    return () => {
      window.removeEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
    }
  }, [item])

  return (
    <Box
      ref={itemRef}
      data-project-canvas-animated-image-item-id={item.id}
      sx={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: item.width,
        height: item.height,
        overflow: 'hidden',
        transform: buildCanvasAnimatedImageTransform(item),
        transformOrigin: '0 0',
        pointerEvents: 'none',
        zIndex: item.zIndex
      }}
    >
      <CanvasImageDomPreview
        item={item}
        previewMode="animated-gif-source"
        borderRadius="4px"
        stageScale={stageScale}
        sourceImagePreview
      />
    </Box>
  )
}

export default function CanvasAnimatedImageDomLayer({
  items,
  stageScale,
  registerViewportLayer
}: CanvasAnimatedImageDomLayerProps) {
  if (items.length === 0) {
    return null
  }

  return (
    <Box
      data-project-canvas-animated-image-layer="dom"
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'visible',
        pointerEvents: 'none'
      }}
    >
      <div ref={registerViewportLayer} style={STAGE_VIEWPORT_LAYER_BASE_STYLE}>
        {items.map((item) => (
          <CanvasAnimatedImageItem key={item.id} item={item} stageScale={stageScale} />
        ))}
      </div>
    </Box>
  )
}
