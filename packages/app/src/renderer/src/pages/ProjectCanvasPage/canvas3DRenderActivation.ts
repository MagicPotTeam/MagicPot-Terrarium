export const CANVAS_3D_RENDER_ACTIVATION_IMMEDIATE_MS = 0
export const CANVAS_3D_RENDER_ACTIVATION_STANDARD_MS = 40
export const CANVAS_3D_RENDER_ACTIVATION_LINKED_ASSETS_MS = 180
export const CANVAS_3D_RENDER_ACTIVATION_AWAITING_TEXTURES_MS = 260

const getCanvas3DModelExtension = (fileName: string | undefined) =>
  fileName?.toLowerCase().split('.').pop() || ''

export const resolveCanvas3DRenderActivationDelay = ({
  fileName,
  hasLinkedAssets,
  isAwaitingTexturePrompt
}: {
  fileName?: string
  hasLinkedAssets?: boolean
  isAwaitingTexturePrompt?: boolean
}) => {
  if (isAwaitingTexturePrompt) {
    return CANVAS_3D_RENDER_ACTIVATION_AWAITING_TEXTURES_MS
  }

  if (hasLinkedAssets) {
    return CANVAS_3D_RENDER_ACTIVATION_LINKED_ASSETS_MS
  }

  if (getCanvas3DModelExtension(fileName) === 'glb') {
    return CANVAS_3D_RENDER_ACTIVATION_IMMEDIATE_MS
  }

  return CANVAS_3D_RENDER_ACTIVATION_STANDARD_MS
}
