export const CANVAS_DUPLICATE_CHECK_RUNTIME_EVENT = 'canvas:duplicate-check-runtime'
export const CANVAS_DUPLICATE_CHECK_FOCUS_EVENT = 'canvas:duplicate-check-focus-items'

export type CanvasDuplicateCheckRuntimeSnapshot = {
  canvasId: string
  projectName: string
  imageItemIds: string[]
  selectedItemIds: string[]
  selectedImageItemIds: string[]
  updatedAt: string
}

export type CanvasDuplicateCheckFocusDetail = {
  canvasId: string
  itemIds: string[]
}

let lastCanvasDuplicateCheckRuntimeSnapshot: CanvasDuplicateCheckRuntimeSnapshot | null = null

export const publishCanvasDuplicateCheckRuntimeSnapshot = (
  snapshot: CanvasDuplicateCheckRuntimeSnapshot
): void => {
  lastCanvasDuplicateCheckRuntimeSnapshot = snapshot
  window.dispatchEvent(
    new CustomEvent<CanvasDuplicateCheckRuntimeSnapshot>(CANVAS_DUPLICATE_CHECK_RUNTIME_EVENT, {
      detail: snapshot
    })
  )
}

export const readCanvasDuplicateCheckRuntimeSnapshot =
  (): CanvasDuplicateCheckRuntimeSnapshot | null => lastCanvasDuplicateCheckRuntimeSnapshot
