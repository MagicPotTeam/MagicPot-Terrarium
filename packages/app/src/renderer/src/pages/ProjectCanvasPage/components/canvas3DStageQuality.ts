export const CANVAS_3D_STAGE_VIEWPORT_SETTLE_MS = 140

export type Canvas3DStageLightingPreset = 'full' | 'balanced' | 'flat'
export type Canvas3DStageFrameloop = 'always' | 'demand'

export const resolveCanvas3DStageDpr = ({
  itemCount,
  activatedItemCount,
  isViewportMoving
}: {
  itemCount: number
  activatedItemCount: number
  isViewportMoving: boolean
}): [number, number] => {
  if (isViewportMoving) return [1, 1]
  if (activatedItemCount >= 10 || itemCount >= 14) return [1, 1.1]
  if (activatedItemCount >= 6 || itemCount >= 8) return [1, 1.25]
  return [1, 1.5]
}

export const resolveCanvas3DStageRenderPumpFrames = ({
  isViewportMoving,
  pendingActivationCount,
  mountedItemCount
}: {
  isViewportMoving: boolean
  pendingActivationCount: number
  mountedItemCount: number
}) => {
  if (isViewportMoving) return 2
  if (pendingActivationCount > 0) {
    if (mountedItemCount === 0) return 2
    if (mountedItemCount >= 6) return 4
    return 3
  }
  if (mountedItemCount === 0) return 1
  if (mountedItemCount >= 6) return 3
  return 2
}

export const resolveCanvas3DStageFrameloop = ({
  isViewportMoving
}: {
  isViewportMoving: boolean
}): Canvas3DStageFrameloop => {
  void isViewportMoving
  return 'demand'
}

export const resolveCanvas3DStageMountedIds = ({
  activatedIds,
  isViewportMoving
}: {
  activatedIds: ReadonlySet<string>
  prioritizedLoadIds: readonly string[]
  isViewportMoving: boolean
}) => {
  if (isViewportMoving) {
    return new Set(activatedIds)
  }
  return new Set(activatedIds)
}

export const resolveCanvas3DStageLightingPreset = ({
  activatedItemCount
}: {
  activatedItemCount: number
}): Canvas3DStageLightingPreset => {
  void activatedItemCount
  return 'full'
}

export const shouldCanvas3DStageRenderLighting = ({
  mountedItemCount
}: {
  mountedItemCount: number
}) => mountedItemCount > 0
