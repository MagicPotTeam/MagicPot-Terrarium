import type React from 'react'

export type WebGLCanvasMode = 'viewer' | 'editor' | 'mask' | 'hybrid'

export type WebGLCanvasCapability = 'viewer-path' | 'editor-path' | 'mask-path'

export type WebGLCanvasLayerKind = 'viewer' | 'editor' | 'mask'

export type WebGLCanvasPrimitiveKind = 'rect' | 'ellipse' | 'line' | 'polygon'

export type WebGLCanvasPoint = {
  x: number
  y: number
}

export type WebGLCanvasPrimitive = {
  id: string
  kind: WebGLCanvasPrimitiveKind
  x: number
  y: number
  width: number
  height: number
  rotation?: number
  points?: WebGLCanvasPoint[]
  fill?: string
  stroke?: string
  strokeWidth?: number
  alpha?: number
  zIndex?: number
  closed?: boolean
}

export type WebGLCanvasImagePreview = {
  x: number
  y: number
  width: number
  height: number
  scaleX: number
  scaleY: number
  rotation: number
}

export type WebGLCanvasImageItem = {
  id: string
  image: HTMLImageElement
  src?: string
  x: number
  y: number
  width: number
  height: number
  scaleX: number
  scaleY: number
  rotation: number
  zIndex: number
}

export type WebGLCanvasSceneMetrics = {
  ready: boolean
  viewerItemCount: number
  primitiveCount: number
  lastUpdateReason: 'initialize' | 'viewer' | 'editor' | 'mask' | 'cleanup'
}

export type WebGLCanvasHostState = {
  ready: boolean
  mode: WebGLCanvasMode
  capabilities: WebGLCanvasCapability[]
}

export type WebGLCanvasScenePlan = {
  layers: WebGLCanvasLayerKind[]
  capabilities: WebGLCanvasCapability[]
}

export type WebGLCanvasSceneChildren = React.ReactNode
