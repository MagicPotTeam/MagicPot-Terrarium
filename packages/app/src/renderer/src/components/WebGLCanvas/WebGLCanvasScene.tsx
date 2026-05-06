import React from 'react'
import WebGLCanvasHost from './WebGLCanvasHost'
import WebGLCanvasPrimitiveLayer from './WebGLCanvasPrimitiveLayer'
import WebGLCanvasViewerLayer from './WebGLCanvasViewerLayer'
import { resolveWebGLCanvasScenePlan } from './webglCanvasSurfacePlan'
import type {
  WebGLCanvasImageItem,
  WebGLCanvasMode,
  WebGLCanvasPrimitive,
  WebGLCanvasSceneMetrics
} from './webglCanvasTypes'

type WebGLCanvasSceneProps = {
  mode?: WebGLCanvasMode
  viewerItems?: WebGLCanvasImageItem[]
  editorPrimitives?: WebGLCanvasPrimitive[]
  maskPrimitives?: WebGLCanvasPrimitive[]
  stagePos?: { x: number; y: number }
  stageScale?: number
  onReadyChange?: (ready: boolean) => void
  onMetricsChange?: (metrics: WebGLCanvasSceneMetrics) => void
  children?: React.ReactNode
}

export default function WebGLCanvasScene({
  mode = 'viewer',
  viewerItems = [],
  editorPrimitives = [],
  maskPrimitives = [],
  stagePos,
  stageScale,
  onReadyChange,
  onMetricsChange,
  children
}: WebGLCanvasSceneProps) {
  const plan = resolveWebGLCanvasScenePlan(
    mode,
    viewerItems.length > 0,
    editorPrimitives.length > 0,
    maskPrimitives.length > 0
  )

  React.useEffect(() => {
    onMetricsChange?.({
      ready: true,
      viewerItemCount: viewerItems.length,
      primitiveCount: editorPrimitives.length + maskPrimitives.length,
      lastUpdateReason: 'initialize'
    })
  }, [editorPrimitives.length, maskPrimitives.length, onMetricsChange, viewerItems.length])

  return (
    <WebGLCanvasHost mode={mode} onReadyChange={onReadyChange}>
      {plan.layers.includes('viewer') && (
        <WebGLCanvasViewerLayer items={viewerItems} stagePos={stagePos} stageScale={stageScale} />
      )}
      {plan.layers.includes('editor') && (
        <WebGLCanvasPrimitiveLayer primitives={editorPrimitives} role="editor" />
      )}
      {plan.layers.includes('mask') && (
        <WebGLCanvasPrimitiveLayer primitives={maskPrimitives} role="mask" />
      )}
      {children}
    </WebGLCanvasHost>
  )
}
