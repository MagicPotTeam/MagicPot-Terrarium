import type { CanvasModel3DItem } from '../types'

import type { CanvasSyncDetail } from './canvasSync'

export const resolveCanvas3DStagePreviewItem = (
  item: CanvasModel3DItem,
  preview: CanvasSyncDetail | null
): CanvasModel3DItem => {
  if (!preview) {
    return item
  }

  return {
    ...item,
    x: preview.x,
    y: preview.y,
    rotation: preview.rotation,
    scaleX: preview.scaleX,
    scaleY: preview.scaleY
  }
}

export type Canvas3DStageModelItemRenderState = {
  item: CanvasModel3DItem
  preview: CanvasSyncDetail | null
  isSelected: boolean
  stageScale: number
  isFullModelActivated: boolean
  shouldMountFullModel: boolean
  sessionKey?: string
}

export const areCanvas3DStageModelItemRenderStatesEqual = (
  previousState: Canvas3DStageModelItemRenderState,
  nextState: Canvas3DStageModelItemRenderState
) =>
  previousState.item === nextState.item &&
  previousState.preview === nextState.preview &&
  previousState.isSelected === nextState.isSelected &&
  previousState.stageScale === nextState.stageScale &&
  previousState.isFullModelActivated === nextState.isFullModelActivated &&
  previousState.shouldMountFullModel === nextState.shouldMountFullModel &&
  previousState.sessionKey === nextState.sessionKey
