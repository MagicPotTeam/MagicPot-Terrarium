import {
  getCanvasSpatialTileGeometry,
  type CanvasSpatialTileDescriptor
} from './canvasSpatialTileTypes'

export const CANVAS_SPATIAL_TILE_CONTENT_SIZE = 512 as const
export const CANVAS_SPATIAL_TILE_GUTTER = 2 as const
export const CANVAS_SPATIAL_TILE_CANVAS_SIZE =
  CANVAS_SPATIAL_TILE_CONTENT_SIZE + CANVAS_SPATIAL_TILE_GUTTER * 2

const MAX_IDLE_TILE_CANVASES = 2
const MAX_RETAINED_TILE_CANVAS_PIXELS = CANVAS_SPATIAL_TILE_CANVAS_SIZE ** 2

export type CanvasSpatialTileDecodedBitmap = {
  width: number
  height: number
}

export type CanvasSpatialTileCanvasContext = {
  clearRect: (x: number, y: number, width: number, height: number) => void
  drawImage: (
    image: CanvasSpatialTileDecodedBitmap,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number
  ) => void
}

export type CanvasSpatialTileCanvasLike = {
  width: number
  height: number
  getContext: (contextId: '2d') => CanvasSpatialTileCanvasContext | null
}

export type CanvasSpatialTileCanvasFactory = (
  width: number,
  height: number
) => CanvasSpatialTileCanvasLike | null

export type CanvasSpatialTileCanvasPool = {
  acquire: (width: number, height: number) => CanvasSpatialTileCanvasLike | null
  release: (canvas: CanvasSpatialTileCanvasLike) => void
}

export function createCanvasSpatialTileCanvasPool(
  createCanvas: CanvasSpatialTileCanvasFactory,
  maxIdleCanvases = MAX_IDLE_TILE_CANVASES
): CanvasSpatialTileCanvasPool {
  const idle: CanvasSpatialTileCanvasLike[] = []

  return {
    acquire(width, height) {
      const canvas = idle.pop() ?? createCanvas(width, height)
      if (!canvas) return null
      canvas.width = width
      canvas.height = height
      return canvas
    },
    release(canvas) {
      if (
        canvas.width * canvas.height > MAX_RETAINED_TILE_CANVAS_PIXELS ||
        idle.length >= maxIdleCanvases
      ) {
        canvas.width = 1
        canvas.height = 1
        return
      }
      idle.push(canvas)
    }
  }
}

export type CanvasSpatialTileCanvasRender = {
  canvas: CanvasSpatialTileCanvasLike
  contentRect: { x: number; y: number; width: number; height: number }
  release: () => void
}

export function drawDecodedCanvasSpatialTile({
  bitmap,
  descriptor,
  address,
  pool
}: {
  bitmap: CanvasSpatialTileDecodedBitmap
  descriptor: CanvasSpatialTileDescriptor
  address: { level: number; x: number; y: number }
  pool: CanvasSpatialTileCanvasPool
}): CanvasSpatialTileCanvasRender {
  const geometry = getCanvasSpatialTileGeometry(descriptor, address)
  const { decodeRect } = geometry
  if (
    decodeRect.width <= 0 ||
    decodeRect.height <= 0 ||
    decodeRect.width > CANVAS_SPATIAL_TILE_CANVAS_SIZE ||
    decodeRect.height > CANVAS_SPATIAL_TILE_CANVAS_SIZE
  ) {
    throw new Error('Spatial tile decode rect exceeds the bounded tile canvas.')
  }
  if (bitmap.width < decodeRect.width || bitmap.height < decodeRect.height) {
    throw new Error('Decoded spatial tile bitmap is smaller than its decode rect.')
  }

  const canvas = pool.acquire(decodeRect.width, decodeRect.height)
  if (!canvas) throw new Error('No spatial tile canvas is available.')

  try {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Failed to create spatial tile canvas context.')
    context.clearRect(0, 0, decodeRect.width, decodeRect.height)
    context.drawImage(bitmap, 0, 0, decodeRect.width, decodeRect.height)
    let released = false
    return {
      canvas,
      contentRect: {
        x: geometry.contentOffset.x,
        y: geometry.contentOffset.y,
        width: geometry.levelRect.width,
        height: geometry.levelRect.height
      },
      release: () => {
        if (released) return
        released = true
        pool.release(canvas)
      }
    }
  } catch (error) {
    pool.release(canvas)
    throw error
  }
}
