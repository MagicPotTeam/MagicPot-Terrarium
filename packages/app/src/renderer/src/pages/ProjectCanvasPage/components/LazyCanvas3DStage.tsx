import React, { Suspense, lazy } from 'react'
import Box from '@mui/material/Box'
import type { CanvasModel3DItem } from '../types'
import { hasCanvas3DStageItems } from './lazyCanvas3DStageUtils'

const Canvas3DStage = lazy(() => import('./Canvas3DStage'))

type Canvas3DStageViewportSync = (stagePos: { x: number; y: number }, stageScale: number) => void

type LazyCanvas3DStageProps = {
  items: CanvasModel3DItem[]
  selectedIds: Set<string>
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
  sessionKey?: string
  isViewportInteracting?: boolean
  isPerformanceThrottled?: boolean
  onViewportSyncReady?: (sync: Canvas3DStageViewportSync | null) => void
}

const MODEL3D_STAGE_FALLBACK_BACKGROUND = 'rgba(15, 23, 42, 0.86)'
const MODEL3D_STAGE_FALLBACK_BORDER = '1px solid rgba(148, 163, 184, 0.2)'

const getLazyCanvas3DStageItemKey = (item: CanvasModel3DItem) =>
  `${item.id}:${item.fileName}:${item.src}`

const Canvas3DStageFallback: React.FC<{
  items: CanvasModel3DItem[]
  stagePos: { x: number; y: number }
  stageScale: number
}> = ({ items, stagePos, stageScale }) => {
  if (!hasCanvas3DStageItems(items)) {
    return null
  }

  return (
    <div
      data-testid="lazy-canvas-3d-stage-fallback"
      data-project-canvas-3d-lazy-fallback-count={items.length}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        background: 'transparent'
      }}
    >
      {items.map((item) => {
        const safeStageScale = Math.max(Math.abs(stageScale), 0.0001)
        return (
          <Box
            key={getLazyCanvas3DStageItemKey(item)}
            data-canvas-item-id={item.id}
            data-canvas-overlay="model3d-lazy-placeholder"
            sx={{
              position: 'absolute',
              left: stagePos.x + item.x * safeStageScale,
              top: stagePos.y + item.y * safeStageScale,
              width: Math.max(1, Math.abs(item.width * item.scaleX) * safeStageScale),
              height: Math.max(1, Math.abs(item.height * item.scaleY) * safeStageScale),
              transform: `rotate(${item.rotation}deg)`,
              transformOrigin: '0 0',
              borderRadius: '6px',
              border: MODEL3D_STAGE_FALLBACK_BORDER,
              background: MODEL3D_STAGE_FALLBACK_BACKGROUND,
              boxSizing: 'border-box'
            }}
          />
        )
      })}
    </div>
  )
}

const LazyCanvas3DStage: React.FC<LazyCanvas3DStageProps> = (props) => {
  const { items, stagePos, stageScale, stageSize, onViewportSyncReady } = props
  const shouldRenderStage =
    hasCanvas3DStageItems(items) && stageSize.width > 0 && stageSize.height > 0

  React.useEffect(() => {
    if (!shouldRenderStage) {
      onViewportSyncReady?.(null)
    }
  }, [onViewportSyncReady, shouldRenderStage])

  if (!shouldRenderStage) {
    return null
  }

  return (
    <Suspense
      fallback={<Canvas3DStageFallback items={items} stagePos={stagePos} stageScale={stageScale} />}
    >
      <Canvas3DStage {...props} />
    </Suspense>
  )
}

export type { Canvas3DStageViewportSync, LazyCanvas3DStageProps }
export default React.memo(LazyCanvas3DStage)
