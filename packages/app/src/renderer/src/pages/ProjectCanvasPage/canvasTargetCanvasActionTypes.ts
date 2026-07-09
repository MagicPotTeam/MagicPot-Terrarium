import type { CanvasTool } from './projectCanvasPageShared'
import type { AnnotationShape, CanvasGroup, CanvasItem } from './types'

export type CanvasTargetBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type CanvasTargetSemanticCanvasActionState = {
  items: CanvasItem[]
  groups?: CanvasGroup[]
  selectedIds: Set<string>
  nextZIndex: number
  bgColor?: string
  showGrid?: boolean
  artifactCanvasItemIds?: Map<string, string[]>
  stageCanvasItemIds?: Map<string, string[]>
}

export type CanvasTargetSemanticCanvasActionResult = {
  items: CanvasItem[]
  selectedIds: Set<string>
  nextZIndex: number
  affectedIds: string[]
  createdIds: string[]
  resultIds: string[]
  content: string
  canvasDispatchCount: number
  fallbackReason?: string
  groups?: CanvasGroup[]
  bgColor?: string
  showGrid?: boolean
  tool?: CanvasTool
  annotationShape?: AnnotationShape
  annotationColor?: string
  annotationStrokeWidth?: number
  annotationFillOpacity?: number
}
