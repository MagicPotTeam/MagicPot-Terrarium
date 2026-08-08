import type {
  CanvasSpatialTileBrowserCropMessage,
  CanvasSpatialTileBrowserCropRequest,
  CanvasSpatialTileBrowserCropResult,
  CanvasSpatialTileWorkerMessage
} from './canvasSpatialTileWorkerProtocol'
import type { CanvasSpatialTileGeometry } from './canvasSpatialTileTypes'

const DEFAULT_TILE_FORMAT: CanvasSpatialTileBrowserCropResult['mimeType'] = 'image/webp'

type TileCanvas = OffscreenCanvas | HTMLCanvasElement

type TileContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

function createTileCanvas(width: number, height: number): TileCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height)
  }
  const documentRef = (globalThis as unknown as { document?: Document }).document
  if (!documentRef) {
    throw new Error('No canvas implementation is available.')
  }
  const canvas = documentRef.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function getTileContext(canvas: TileCanvas): TileContext {
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Failed to create spatial tile canvas context.')
  }
  context.imageSmoothingEnabled = true
  if ('imageSmoothingQuality' in context) {
    context.imageSmoothingQuality = 'high'
  }
  return context
}

async function encodeTile(
  canvas: TileCanvas,
  preferWebp: boolean
): Promise<{
  blob: Blob
  mimeType: CanvasSpatialTileBrowserCropResult['mimeType']
}> {
  if (preferWebp) {
    const webp = await canvasToBlob(canvas, 'image/webp')
    if (webp) return { blob: webp, mimeType: 'image/webp' }
  }
  const png = await canvasToBlob(canvas, 'image/png')
  if (!png) throw new Error('Failed to encode spatial tile.')
  return { blob: png, mimeType: 'image/png' }
}

async function canvasToBlob(canvas: TileCanvas, mimeType: 'image/webp' | 'image/png') {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    try {
      const blob = await canvas.convertToBlob({ type: mimeType, quality: 0.82 })
      return blob.type === mimeType || mimeType === 'image/png' ? blob : null
    } catch {
      return null
    }
  }
  if ('toBlob' in canvas && typeof canvas.toBlob === 'function') {
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob?.type === mimeType || mimeType === 'image/png' ? blob : null),
        mimeType,
        0.82
      )
    })
  }
  return null
}

function assertGeometry(geometry: CanvasSpatialTileGeometry): void {
  for (const rect of [geometry.decodeRect, geometry.levelRect, geometry.originalSourceRect]) {
    if (
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      throw new Error('Invalid spatial tile geometry.')
    }
  }
}

/** Browser crop path only: createImageBitmap may still fully decode the source internally. */
export async function generateCanvasSpatialTileBrowserCrop(
  request: CanvasSpatialTileBrowserCropRequest
): Promise<CanvasSpatialTileBrowserCropResult> {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap is unavailable.')
  assertGeometry(request.geometry)
  const sourceWidth = request.descriptor.sourceWidth
  const sourceHeight = request.descriptor.sourceHeight
  const { decodeRect, levelRect, contentOffset } = request.geometry
  const scale = request.scaleDenominator
  if (!Number.isInteger(scale) || scale <= 0 || (scale & (scale - 1)) !== 0) {
    throw new Error('Spatial tile scale must be a positive power of two.')
  }
  const sx = Math.max(0, Math.floor(decodeRect.x * scale))
  const sy = Math.max(0, Math.floor(decodeRect.y * scale))
  const right = Math.min(sourceWidth, Math.ceil((decodeRect.x + decodeRect.width) * scale))
  const bottom = Math.min(sourceHeight, Math.ceil((decodeRect.y + decodeRect.height) * scale))
  const sw = right - sx
  const sh = bottom - sy
  if (sw <= 0 || sh <= 0) throw new Error('Spatial tile crop is outside the source image.')
  const bitmap = await createImageBitmap(request.source, sx, sy, sw, sh, {
    resizeWidth: decodeRect.width,
    resizeHeight: decodeRect.height,
    resizeQuality: 'high'
  })
  try {
    const canvas = createTileCanvas(decodeRect.width, decodeRect.height)
    try {
      const context = getTileContext(canvas)
      context.clearRect(0, 0, decodeRect.width, decodeRect.height)
      context.drawImage(bitmap, 0, 0, decodeRect.width, decodeRect.height)
      const encoded = await encodeTile(canvas, request.preferWebp ?? true)
      return {
        blob: encoded.blob,
        mimeType: encoded.mimeType,
        width: decodeRect.width,
        height: decodeRect.height,
        contentRectInBitmap: {
          x: contentOffset.x,
          y: contentOffset.y,
          width: levelRect.width,
          height: levelRect.height
        },
        geometry: request.geometry
      }
    } finally {
      canvas.width = 1
      canvas.height = 1
    }
  } finally {
    bitmap.close?.()
  }
}

function isWorkerScope(): boolean {
  const scope = globalThis as unknown as {
    document?: Document
    postMessage?: unknown
    addEventListener?: unknown
  }
  return (
    typeof scope.document === 'undefined' &&
    typeof scope.postMessage === 'function' &&
    typeof scope.addEventListener === 'function'
  )
}

if (isWorkerScope()) {
  const scope = globalThis as unknown as {
    addEventListener: (
      type: 'message',
      listener: (event: MessageEvent<CanvasSpatialTileBrowserCropMessage>) => void
    ) => void
    postMessage: (message: CanvasSpatialTileWorkerMessage) => void
  }
  scope.addEventListener('message', (event) => {
    const message = event.data
    if (!message || message.type !== 'generate-browser-crop') return
    void generateCanvasSpatialTileBrowserCrop({
      source: message.source,
      descriptor: { sourceWidth: message.sourceWidth, sourceHeight: message.sourceHeight },
      geometry: message.geometry,
      scaleDenominator: message.scaleDenominator,
      preferWebp: message.preferWebp
    })
      .then((result) =>
        scope.postMessage({ type: 'success', requestId: message.requestId, result })
      )
      .catch((error) =>
        scope.postMessage({
          type: 'error',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error)
        })
      )
  })
}

export const CANVAS_SPATIAL_TILE_DEFAULT_FORMAT = DEFAULT_TILE_FORMAT
