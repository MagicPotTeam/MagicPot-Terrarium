type CropBox = {
  x: number
  y: number
  width: number
  height: number
}

type CanvasPoint = {
  x: number
  y: number
}

type ResizeHandle =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-right'
  | 'bottom-right'
  | 'bottom-center'
  | 'bottom-left'
  | 'middle-left'

const MIN_CROP_BOX_SIZE = 5

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function resolveResizedCropBox(options: {
  handle: ResizeHandle
  pointer: CanvasPoint
  startPoint: CanvasPoint
  startBox: CropBox
  boundsWidth: number
  boundsHeight: number
}): CropBox {
  const { handle, pointer, startPoint, startBox, boundsWidth, boundsHeight } = options
  const startRight = startBox.x + startBox.width
  const startBottom = startBox.y + startBox.height
  const minimumWidth = Math.min(MIN_CROP_BOX_SIZE, boundsWidth)
  const minimumHeight = Math.min(MIN_CROP_BOX_SIZE, boundsHeight)
  const deltaX = pointer.x - startPoint.x
  const deltaY = pointer.y - startPoint.y

  const includesLeft = handle === 'top-left' || handle === 'middle-left' || handle === 'bottom-left'
  const includesRight =
    handle === 'top-right' || handle === 'middle-right' || handle === 'bottom-right'
  const includesTop = handle === 'top-left' || handle === 'top-center' || handle === 'top-right'
  const includesBottom =
    handle === 'bottom-left' || handle === 'bottom-center' || handle === 'bottom-right'

  const nextLeft = includesLeft
    ? clamp(startBox.x + deltaX, 0, startRight - minimumWidth)
    : startBox.x
  const nextTop = includesTop
    ? clamp(startBox.y + deltaY, 0, startBottom - minimumHeight)
    : startBox.y
  const nextRight = includesRight
    ? clamp(startRight + deltaX, nextLeft + minimumWidth, boundsWidth)
    : startRight
  const nextBottom = includesBottom
    ? clamp(startBottom + deltaY, nextTop + minimumHeight, boundsHeight)
    : startBottom

  return {
    x: nextLeft,
    y: nextTop,
    width: Math.max(minimumWidth, nextRight - nextLeft),
    height: Math.max(minimumHeight, nextBottom - nextTop)
  }
}
