import {
  CANVAS_THUMBNAIL_LEVELS,
  type CanvasThumbnailLevelSize,
  type CanvasThumbnailMimeType,
  type CanvasThumbnailWorkerGenerateMessage,
  type CanvasThumbnailWorkerGeneratedLevel,
  type CanvasThumbnailWorkerMessage
} from './canvasThumbnailTypes'

type CanvasLike = OffscreenCanvas | HTMLCanvasElement

function getImageBitmapWidth(bitmap: ImageBitmap): number {
  return typeof bitmap.width === 'number' ? bitmap.width : 0
}

function getImageBitmapHeight(bitmap: ImageBitmap): number {
  return typeof bitmap.height === 'number' ? bitmap.height : 0
}

function getThumbnailDimensions({
  sourceWidth,
  sourceHeight,
  maxSide
}: {
  sourceWidth: number
  sourceHeight: number
  maxSide: number
}): { width: number; height: number } {
  const sourceMaxSide = Math.max(sourceWidth, sourceHeight)
  if (!Number.isFinite(sourceMaxSide) || sourceMaxSide <= 0) {
    return { width: 1, height: 1 }
  }

  const scale = Math.min(1, maxSide / sourceMaxSide)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  }
}

function createThumbnailCanvas(width: number, height: number): CanvasLike | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height)
  }

  const documentRef = (globalThis as unknown as { document?: Document }).document
  if (documentRef?.createElement) {
    const canvas = documentRef.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }

  return null
}

function get2dContext(
  canvas: CanvasLike
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }

  context.imageSmoothingEnabled = true
  if ('imageSmoothingQuality' in context) {
    context.imageSmoothingQuality = 'high'
  }
  return context
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) {
    return null
  }

  const header = dataUrl.slice(0, commaIndex)
  const mimeMatch = /^data:([^;,]+)/.exec(header)
  const mimeType = mimeMatch?.[1] || 'image/png'
  const base64 = dataUrl.slice(commaIndex + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: mimeType })
}

async function canvasToBlob(
  canvas: CanvasLike,
  mimeType: CanvasThumbnailMimeType
): Promise<Blob | null> {
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
        (blob) => {
          if (!blob) {
            resolve(null)
            return
          }
          resolve(blob.type === mimeType || mimeType === 'image/png' ? blob : null)
        },
        mimeType,
        0.82
      )
    })
  }

  if ('toDataURL' in canvas && typeof canvas.toDataURL === 'function') {
    try {
      const dataUrl = canvas.toDataURL(mimeType, 0.82)
      return dataUrlToBlob(dataUrl)
    } catch {
      return null
    }
  }

  return null
}

async function encodeThumbnailBlob(
  canvas: CanvasLike,
  preferWebp: boolean
): Promise<{ blob: Blob; mimeType: CanvasThumbnailMimeType }> {
  if (preferWebp) {
    const webpBlob = await canvasToBlob(canvas, 'image/webp')
    if (webpBlob) {
      return { blob: webpBlob, mimeType: 'image/webp' }
    }
  }

  const pngBlob = await canvasToBlob(canvas, 'image/png')
  if (!pngBlob) {
    throw new Error('Failed to encode thumbnail canvas.')
  }
  return { blob: pngBlob, mimeType: 'image/png' }
}

export async function generateCanvasThumbnailLevelsInScope({
  source,
  levels = CANVAS_THUMBNAIL_LEVELS,
  preferWebp = true
}: {
  source: Blob
  levels?: readonly CanvasThumbnailLevelSize[]
  preferWebp?: boolean
}): Promise<CanvasThumbnailWorkerGeneratedLevel[]> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is unavailable.')
  }

  const bitmap = await createImageBitmap(source)
  try {
    const sourceWidth = getImageBitmapWidth(bitmap)
    const sourceHeight = getImageBitmapHeight(bitmap)
    if (
      !Number.isFinite(sourceWidth) ||
      !Number.isFinite(sourceHeight) ||
      sourceWidth <= 0 ||
      sourceHeight <= 0
    ) {
      throw new Error('Decoded image has invalid dimensions.')
    }

    const generated: CanvasThumbnailWorkerGeneratedLevel[] = []
    for (const maxSide of levels) {
      const { width, height } = getThumbnailDimensions({
        sourceWidth,
        sourceHeight,
        maxSide
      })
      const canvas = createThumbnailCanvas(width, height)
      if (!canvas) {
        throw new Error('No canvas implementation is available.')
      }

      const context = get2dContext(canvas)
      if (!context) {
        throw new Error('Failed to create thumbnail canvas context.')
      }

      context.clearRect(0, 0, width, height)
      context.drawImage(bitmap, 0, 0, width, height)

      const { blob, mimeType } = await encodeThumbnailBlob(canvas, preferWebp)
      generated.push({
        maxSide,
        width,
        height,
        mimeType,
        format: mimeType === 'image/webp' ? 'webp' : 'png',
        blob
      })
    }

    return generated
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
  return typeof scope.document === 'undefined' && typeof scope.postMessage === 'function'
}

if (isWorkerScope()) {
  const workerScope = globalThis as unknown as {
    addEventListener: (
      type: 'message',
      listener: (event: MessageEvent<CanvasThumbnailWorkerGenerateMessage>) => void
    ) => void
    postMessage: (message: CanvasThumbnailWorkerMessage) => void
  }

  workerScope.addEventListener('message', (event) => {
    const message = event.data
    if (!message || message.type !== 'generate') {
      return
    }

    void generateCanvasThumbnailLevelsInScope({
      source: message.source,
      levels: message.levels,
      preferWebp: message.preferWebp
    })
      .then((levels) => {
        workerScope.postMessage({
          type: 'success',
          requestId: message.requestId,
          levels
        })
      })
      .catch((error) => {
        workerScope.postMessage({
          type: 'error',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  })
}
