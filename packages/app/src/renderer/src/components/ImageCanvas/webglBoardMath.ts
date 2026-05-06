export type WebGLBoardCamera = {
  x: number
  y: number
  scale: number
}

export type WebGLBoardPoint = {
  x: number
  y: number
}

export type WebGLBoardRect = {
  x: number
  y: number
  width: number
  height: number
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function getBounds(items: WebGLBoardRect[]): WebGLBoardRect | null {
  if (items.length === 0) {
    return null
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const item of items) {
    if (!(item.width > 0) || !(item.height > 0)) {
      continue
    }

    minX = Math.min(minX, item.x)
    minY = Math.min(minY, item.y)
    maxX = Math.max(maxX, item.x + item.width)
    maxY = Math.max(maxY, item.y + item.height)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  }
}

export function fitCameraToBounds(
  viewport: { width: number; height: number },
  bounds: WebGLBoardRect,
  padding = 24
): WebGLBoardCamera {
  const safeWidth = Math.max(1, viewport.width - padding * 2)
  const safeHeight = Math.max(1, viewport.height - padding * 2)
  const scale = Math.min(safeWidth / bounds.width, safeHeight / bounds.height)

  return {
    scale,
    x: (viewport.width - bounds.width * scale) / 2 - bounds.x * scale,
    y: (viewport.height - bounds.height * scale) / 2 - bounds.y * scale
  }
}

export function screenToWorld(camera: WebGLBoardCamera, point: WebGLBoardPoint): WebGLBoardPoint {
  return {
    x: (point.x - camera.x) / camera.scale,
    y: (point.y - camera.y) / camera.scale
  }
}

export function zoomCameraAtPoint(
  camera: WebGLBoardCamera,
  point: WebGLBoardPoint,
  scaleMultiplier: number,
  minScale: number,
  maxScale: number
): WebGLBoardCamera {
  const nextScale = clamp(camera.scale * scaleMultiplier, minScale, maxScale)

  if (nextScale === camera.scale) {
    return camera
  }

  const worldPoint = screenToWorld(camera, point)

  return {
    scale: nextScale,
    x: point.x - worldPoint.x * nextScale,
    y: point.y - worldPoint.y * nextScale
  }
}
