import type { CanvasTool } from './projectCanvasPageShared'
import type { AnnotationShape } from './types'

export function getCanvasCursorStyle(tool: CanvasTool, isPanning: boolean): string {
  if (tool === 'hand') {
    return isPanning ? 'grabbing' : 'grab'
  }

  if (
    tool === 'annotate' ||
    tool === 'export-select' ||
    tool === 'crop-select' ||
    tool === 'extract-select'
  ) {
    return 'crosshair'
  }

  return 'default'
}

export function shouldForceCanvasCrosshair(tool: CanvasTool, annoTool: AnnotationShape): boolean {
  return (
    (tool === 'annotate' && annoTool !== 'text-anno') ||
    tool === 'export-select' ||
    tool === 'crop-select' ||
    tool === 'extract-select'
  )
}
