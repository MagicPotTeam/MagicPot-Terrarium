import type { CanvasModel3DItem } from '../types'

type Canvas3DStageLikeProps = {
  items: CanvasModel3DItem[]
  selectedIds: Set<string>
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
  sessionKey?: string
  isViewportInteracting?: boolean
  onViewportSyncReady?: unknown
}

export type Canvas3DStageRenderKickProps = {
  loadStateVersion: number
  renderPumpFrames: number
}

const areCanvas3DStageItemsEqual = (
  previousItems: readonly CanvasModel3DItem[],
  nextItems: readonly CanvasModel3DItem[]
) => {
  if (previousItems.length !== nextItems.length) {
    return false
  }

  for (let index = 0; index < previousItems.length; index += 1) {
    if (previousItems[index] !== nextItems[index]) {
      return false
    }
  }

  return true
}

const areCanvas3DStageSelectedIdsEqual = (
  previousSelectedIds: ReadonlySet<string>,
  nextSelectedIds: ReadonlySet<string>
) => {
  if (previousSelectedIds.size !== nextSelectedIds.size) {
    return false
  }

  for (const selectedId of previousSelectedIds) {
    if (!nextSelectedIds.has(selectedId)) {
      return false
    }
  }

  return true
}

export const areCanvas3DStagePropsEqual = (
  previousProps: Canvas3DStageLikeProps,
  nextProps: Canvas3DStageLikeProps
) =>
  areCanvas3DStageItemsEqual(previousProps.items, nextProps.items) &&
  areCanvas3DStageSelectedIdsEqual(previousProps.selectedIds, nextProps.selectedIds) &&
  previousProps.stagePos.x === nextProps.stagePos.x &&
  previousProps.stagePos.y === nextProps.stagePos.y &&
  previousProps.stageScale === nextProps.stageScale &&
  previousProps.stageSize.width === nextProps.stageSize.width &&
  previousProps.stageSize.height === nextProps.stageSize.height &&
  previousProps.sessionKey === nextProps.sessionKey &&
  previousProps.isViewportInteracting === nextProps.isViewportInteracting &&
  previousProps.onViewportSyncReady === nextProps.onViewportSyncReady

export const areCanvas3DStageRenderKickPropsEqual = (
  previousProps: Canvas3DStageRenderKickProps,
  nextProps: Canvas3DStageRenderKickProps
) =>
  previousProps.loadStateVersion === nextProps.loadStateVersion &&
  previousProps.renderPumpFrames === nextProps.renderPumpFrames
