import {
  CANVAS_THUMBNAIL_LEVELS,
  type CanvasThumbnailLevelSize,
  type CanvasThumbnailMimeType,
  type CanvasThumbnailWorkerGenerateMessage,
  type CanvasThumbnailWorkerGeneratedLevel,
  type CanvasThumbnailWorkerMessage
} from './canvasThumbnailTypes'

type CanvasLike = OffscreenCanvas | HTMLCanvasElement

// One job holds a canvas per level until that level is encoded.
const MAX_IDLE_THUMBNAIL_CANVASES = CANVAS_THUMBNAIL_LEVELS.length
// An idle canvas keeps its object (and context) for the next level, but not its pixels: the
// next level resizes it anyway, which reallocates them.
const MAX_RETAINED_IDLE_THUMBNAIL_CANVAS_PIXELS = 1
// A thumbnail level is drawn once and then read back by the encoder, so it is made on a CPU
// canvas. An accelerated canvas gives each worker a GPU context of its own: every full-size
// source is uploaded through Chromium's upload staging, which keeps its largest chunks until
// the worker ends (two workers held 104 MB of it from the first seconds of a 100 x 2048 px
// import until 30 s after it, next to a GPU decode cache of up to 1.1 GB), only to read the
// pixels back for encoding.
const THUMBNAIL_CANVAS_CONTEXT_SETTINGS: CanvasRenderingContext2DSettings = {
  willReadFrequently: true
}

class ThumbnailCanvasPool {
  private readonly idle: CanvasLike[] = []

  acquire(width: number, height: number): CanvasLike | null {
    const canvas = this.idle.pop() ?? createThumbnailCanvas(width, height)
    if (!canvas) {
      return null
    }

    canvas.width = width
    canvas.height = height
    return canvas
  }

  release(canvas: CanvasLike): void {
    if (canvas.width * canvas.height > MAX_RETAINED_IDLE_THUMBNAIL_CANVAS_PIXELS) {
      canvas.width = 1
      canvas.height = 1
    }
    if (this.idle.length >= MAX_IDLE_THUMBNAIL_CANVASES) {
      return
    }

    this.idle.push(canvas)
  }
}

const thumbnailCanvasPool = new ThumbnailCanvasPool()

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
  const context = canvas.getContext('2d', THUMBNAIL_CANVAS_CONTEXT_SETTINGS) as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
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

export type CanvasThumbnailLevelPlan = {
  maxSide: CanvasThumbnailLevelSize
  width: number
  height: number
}

/**
 * The levels that get a file: only those strictly below the source size. A level at or above it
 * would be the source's own pixels encoded a second time (for a 1024 px source the "1024" and
 * "2048" levels were two identical full-size files and two thirds of the job's time); the
 * source itself stands for those. An image smaller than every level still gets one file (the
 * smallest level, at the image's own size), so that a set is never empty.
 */
export function planCanvasThumbnailLevels({
  sourceWidth,
  sourceHeight,
  levels = CANVAS_THUMBNAIL_LEVELS
}: {
  sourceWidth: number
  sourceHeight: number
  levels?: readonly CanvasThumbnailLevelSize[]
}): CanvasThumbnailLevelPlan[] {
  const ordered = [...new Set(levels)].sort((left, right) => left - right)
  const sourceMaxSide = Math.max(sourceWidth, sourceHeight)
  const belowSource = ordered.filter((maxSide) => maxSide < sourceMaxSide)
  const planned = belowSource.length > 0 ? belowSource : ordered.slice(0, 1)
  return planned.map((maxSide) => ({
    maxSide,
    ...getThumbnailDimensions({ sourceWidth, sourceHeight, maxSide })
  }))
}

/**
 * The level to hand over before the others are encoded: the smallest planned level that covers
 * `firstLevelMaxSide`. None when no planned level covers the size (the source itself is then
 * what gets displayed), and none when it is the largest planned level: the levels below it
 * take a few milliseconds, the job would end right after it anyway.
 */
export function pickCanvasThumbnailFirstLevel(
  plans: readonly CanvasThumbnailLevelPlan[],
  firstLevelMaxSide: number | undefined
): CanvasThumbnailLevelPlan | null {
  if (
    typeof firstLevelMaxSide !== 'number' ||
    !Number.isFinite(firstLevelMaxSide) ||
    firstLevelMaxSide <= 0
  ) {
    return null
  }
  const index = plans.findIndex((plan) => plan.maxSide >= firstLevelMaxSide)
  return index >= 0 && index < plans.length - 1 ? plans[index] : null
}

export async function generateCanvasThumbnailLevelsInScope({
  source,
  levels = CANVAS_THUMBNAIL_LEVELS,
  preferWebp = true,
  firstLevelMaxSide,
  onFirstLevel
}: {
  source: Blob
  levels?: readonly CanvasThumbnailLevelSize[]
  preferWebp?: boolean
  /** Max side of the level that is encoded and handed over first (see onFirstLevel). */
  firstLevelMaxSide?: number
  /**
   * Called once, with the first encoded level, before the other levels are encoded. The same
   * level is part of the result again.
   */
  onFirstLevel?: (level: CanvasThumbnailWorkerGeneratedLevel) => void
}): Promise<CanvasThumbnailWorkerGeneratedLevel[]> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is unavailable.')
  }

  // Ascending by size. A canvas leaves this list (and goes back to the pool) once encoded.
  const drawn: Array<{ plan: CanvasThumbnailLevelPlan; canvas: CanvasLike | null }> = []
  try {
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

      // Draw first, encode afterwards. The largest level is drawn from the decoded source and
      // every smaller one from the level above it: one large downscale per job instead of one
      // per level (each of the five draws from a 4096 x 3072 source cost 70-130 ms).
      const plans = planCanvasThumbnailLevels({ sourceWidth, sourceHeight, levels })
      let previous: ImageBitmap | CanvasLike = bitmap
      for (let index = plans.length - 1; index >= 0; index -= 1) {
        const plan = plans[index]
        const canvas = thumbnailCanvasPool.acquire(plan.width, plan.height)
        if (!canvas) {
          throw new Error('No canvas implementation is available.')
        }
        drawn.unshift({ plan, canvas })

        const context = get2dContext(canvas)
        if (!context) {
          throw new Error('Failed to create thumbnail canvas context.')
        }
        context.clearRect(0, 0, plan.width, plan.height)
        context.drawImage(previous, 0, 0, plan.width, plan.height)
        previous = canvas
      }
    } finally {
      // The decoded source (4 bytes per pixel) is not needed while the levels are encoded.
      bitmap.close?.()
    }

    const encoded = new Map<CanvasThumbnailLevelSize, CanvasThumbnailWorkerGeneratedLevel>()
    const encodeLevel = async (entry: (typeof drawn)[number]) => {
      const { plan, canvas } = entry
      if (!canvas) {
        return encoded.get(plan.maxSide) ?? null
      }
      try {
        const { blob, mimeType } = await encodeThumbnailBlob(canvas, preferWebp)
        const level: CanvasThumbnailWorkerGeneratedLevel = {
          maxSide: plan.maxSide,
          width: plan.width,
          height: plan.height,
          mimeType,
          format: mimeType === 'image/webp' ? 'webp' : 'png',
          blob
        }
        encoded.set(plan.maxSide, level)
        return level
      } finally {
        entry.canvas = null
        thumbnailCanvasPool.release(canvas)
      }
    }

    const firstPlan = onFirstLevel
      ? pickCanvasThumbnailFirstLevel(
          drawn.map(({ plan }) => plan),
          firstLevelMaxSide
        )
      : null
    const firstEntry = firstPlan ? drawn.find(({ plan }) => plan === firstPlan) : undefined
    if (firstEntry) {
      const firstLevel = await encodeLevel(firstEntry)
      if (firstLevel) {
        onFirstLevel?.(firstLevel)
      }
    }

    const generated: CanvasThumbnailWorkerGeneratedLevel[] = []
    for (const entry of drawn) {
      const level = await encodeLevel(entry)
      if (level) {
        generated.push(level)
      }
    }
    return generated
  } finally {
    for (const entry of drawn) {
      if (entry.canvas) {
        thumbnailCanvasPool.release(entry.canvas)
        entry.canvas = null
      }
    }
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
      preferWebp: message.preferWebp,
      firstLevelMaxSide: message.firstLevelMaxSide,
      onFirstLevel: (level) => {
        workerScope.postMessage({
          type: 'first-level',
          requestId: message.requestId,
          level
        })
      }
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
