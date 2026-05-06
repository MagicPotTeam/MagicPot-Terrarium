import React from 'react'
import WebGLCanvasScene from '../../../components/WebGLCanvas/WebGLCanvasScene'
import type {
  WebGLCanvasImageItem,
  WebGLCanvasMode,
  WebGLCanvasPrimitive,
  WebGLCanvasSceneMetrics
} from '../../../components/WebGLCanvas/webglCanvasTypes'

type ProjectCanvasWebGLSceneProps = {
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

export default function ProjectCanvasWebGLScene(props: ProjectCanvasWebGLSceneProps) {
  return <WebGLCanvasScene {...props} />
}
