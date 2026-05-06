import { GIFEncoder, applyPalette, quantize } from 'gifenc'

import type { CanvasImageItem, CanvasModel3DItem, CanvasVideoItem } from './types'

export type CanvasExportBounds = {
  x: number
  y: number
  width: number
  height: number
}

type GroupPlaybackItem = CanvasImageItem | CanvasVideoItem | CanvasModel3DItem

type GroupPlaybackGifOptions = {
  width: number
  height: number
  bgColor?: string
  imageDelay?: number
  modelDelay?: number
  videoFps?: number
  maxVideoFrames?: number
  sessionKey?: string
}

type GroupPlaybackVideoFramePlanEntry = {
  delayMs: number
  timeSeconds: number
}

const DEFAULT_GROUP_PLAYBACK_GIF_BG = '#020617'
const DEFAULT_GROUP_PLAYBACK_IMAGE_DELAY_MS = 800
const DEFAULT_GROUP_PLAYBACK_MODEL_DELAY_MS = 3000
const DEFAULT_GROUP_PLAYBACK_VIDEO_FPS = 6
const DEFAULT_GROUP_PLAYBACK_MAX_VIDEO_FRAMES = 48
const DEFAULT_GROUP_PLAYBACK_SINGLE_VIDEO_DELAY_MS = 1000
const GROUP_PLAYBACK_VIDEO_MIN_DELAY_MS = 40
const GROUP_PLAYBACK_VIDEO_CAPTURE_END_EPSILON_SECONDS = 0.05

function getCanvasItemTransformedBounds(
  item: Pick<
    CanvasImageItem | CanvasVideoItem | CanvasModel3DItem,
    'x' | 'y' | 'width' | 'height' | 'scaleX' | 'scaleY'
  >
): CanvasExportBounds {
  const scaledWidth = Math.abs(item.width * (item.scaleX || 1))
  const scaledHeight = Math.abs(item.height * (item.scaleY || 1))
  return {
    x: Math.min(item.x, item.x + item.width * (item.scaleX || 1)),
    y: Math.min(item.y, item.y + item.height * (item.scaleY || 1)),
    width: scaledWidth,
    height: scaledHeight
  }
}

export function orderGroupItemsByGroupIds<
  T extends CanvasImageItem | CanvasVideoItem | CanvasModel3DItem
>(groupItemIds: string[], items: T[]): T[] {
  const itemMap = new Map(items.map((item) => [item.id, item] as const))
  return groupItemIds
    .map((itemId) => itemMap.get(itemId) ?? null)
    .filter((item): item is T => Boolean(item))
}

export function getNextGroupPlaybackIndex(currentIndex: number, itemCount: number): number | null {
  if (itemCount <= 0) return null
  const nextIndex = currentIndex + 1
  return nextIndex < itemCount ? nextIndex : null
}

export function findNextValidGroupPlaybackIndex(
  itemIds: string[],
  currentIndex: number,
  isItemAvailable: (itemId: string) => boolean
): number | null {
  for (let index = Math.max(currentIndex + 1, 0); index < itemIds.length; index += 1) {
    if (isItemAvailable(itemIds[index])) {
      return index
    }
  }

  return null
}

export function getGroupPlaybackLocateBounds(
  item: GroupPlaybackItem | null,
  groupBounds: CanvasExportBounds
): CanvasExportBounds {
  return item ? getCanvasItemTransformedBounds(item) : groupBounds
}

export function shouldSuppressStandaloneModel3DSurface(item: GroupPlaybackItem | null): boolean {
  return item?.type === 'model3d'
}

export function shouldRenderStandaloneModel3DItemDuringGroupPlayback(
  activePlaybackItemId: string | null,
  item: GroupPlaybackItem
): boolean {
  return item.type !== 'model3d' || item.id !== activePlaybackItemId
}

function waitForMediaEvent(
  media: HTMLMediaElement,
  type: 'loadeddata' | 'loadedmetadata' | 'seeked'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener(type, handleResolve)
      media.removeEventListener('error', handleError)
    }

    const handleResolve = () => {
      cleanup()
      resolve()
    }

    const handleError = () => {
      cleanup()
      reject(new Error(`Failed while waiting for media event "${type}".`))
    }

    media.addEventListener(type, handleResolve, { once: true })
    media.addEventListener('error', handleError, { once: true })
  })
}

function clearGifFrameCanvas(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  bgColor: string
) {
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = bgColor
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.restore()
}

function writeCurrentCanvasFrame(
  gif: ReturnType<typeof GIFEncoder>,
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  delayMs: number
) {
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  const palette = quantize(imageData.data, 256)
  const index = applyPalette(imageData.data, palette)
  gif.writeFrame(index, canvas.width, canvas.height, { delay: delayMs, palette })
}

function withPlaybackCanvasTransform(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  item: GroupPlaybackItem,
  draw: () => void
) {
  const hasTransform = Boolean(item.rotation || item.scaleX < 0 || item.scaleY < 0)
  if (!hasTransform) {
    draw()
    return
  }

  context.save()
  context.translate(canvas.width / 2, canvas.height / 2)
  if (item.rotation) {
    context.rotate((item.rotation * Math.PI) / 180)
  }
  context.scale(item.scaleX < 0 ? -1 : 1, item.scaleY < 0 ? -1 : 1)
  context.translate(-canvas.width / 2, -canvas.height / 2)
  draw()
  context.restore()
}

function resolvePlaybackTargetRect(item: GroupPlaybackItem, canvas: HTMLCanvasElement) {
  const sourceBoxWidth = Math.max(1, Math.abs(item.width * (item.scaleX || 1)))
  const sourceBoxHeight = Math.max(1, Math.abs(item.height * (item.scaleY || 1)))
  const scale = Math.min(canvas.width / sourceBoxWidth, canvas.height / sourceBoxHeight)
  const width = Math.max(1, sourceBoxWidth * scale)
  const height = Math.max(1, sourceBoxHeight * scale)
  return {
    height,
    width,
    x: (canvas.width - width) / 2,
    y: (canvas.height - height) / 2
  }
}

function drawSourceIntoPlaybackRect(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetRect: CanvasExportBounds,
  crop?: CanvasImageItem['crop']
) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetRect.width <= 0 || targetRect.height <= 0) {
    return
  }

  if (crop && crop.width > 0 && crop.height > 0) {
    const sx = (crop.x / 100) * sourceWidth
    const sy = (crop.y / 100) * sourceHeight
    const sw = (crop.width / 100) * sourceWidth
    const sh = (crop.height / 100) * sourceHeight
    context.drawImage(
      source,
      sx,
      sy,
      sw,
      sh,
      targetRect.x,
      targetRect.y,
      targetRect.width,
      targetRect.height
    )
    return
  }

  const sourceAspect = sourceWidth / sourceHeight
  const targetAspect = targetRect.width / targetRect.height

  let drawWidth = targetRect.width
  let drawHeight = targetRect.height
  let drawX = targetRect.x
  let drawY = targetRect.y

  if (sourceAspect > targetAspect) {
    drawHeight = targetRect.width / sourceAspect
    drawY = targetRect.y + (targetRect.height - drawHeight) / 2
  } else {
    drawWidth = targetRect.height * sourceAspect
    drawX = targetRect.x + (targetRect.width - drawWidth) / 2
  }

  context.drawImage(source, drawX, drawY, drawWidth, drawHeight)
}

async function loadPlaybackImage(item: CanvasImageItem): Promise<HTMLImageElement> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = item.src
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error(`Failed to load image "${item.fileName || item.id}".`))
  })
  return image
}

function drawPlaybackImageFrame(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  item: CanvasImageItem,
  image: HTMLImageElement
) {
  const targetRect = resolvePlaybackTargetRect(item, canvas)
  withPlaybackCanvasTransform(context, canvas, item, () => {
    drawSourceIntoPlaybackRect(
      context,
      image,
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      targetRect,
      item.crop
    )
  })
}

async function loadPlaybackVideo(item: CanvasVideoItem): Promise<HTMLVideoElement> {
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  video.src = item.src
  video.load()

  if (video.readyState < 1) {
    await waitForMediaEvent(video, 'loadedmetadata')
  }
  if (video.readyState < 2) {
    await waitForMediaEvent(video, 'loadeddata')
  }

  return video
}

async function seekPlaybackVideo(video: HTMLVideoElement, timeSeconds: number) {
  const duration = Number.isFinite(video.duration) ? Math.max(video.duration, 0) : 0
  const clampedTime = Math.min(Math.max(timeSeconds, 0), duration)
  if (Math.abs((video.currentTime || 0) - clampedTime) <= 0.01) {
    return
  }

  const seekPromise = waitForMediaEvent(video, 'seeked')
  video.currentTime = clampedTime
  await seekPromise
}

function drawPlaybackVideoFrame(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  item: CanvasVideoItem,
  video: HTMLVideoElement
) {
  const targetRect = resolvePlaybackTargetRect(item, canvas)
  withPlaybackCanvasTransform(context, canvas, item, () => {
    drawSourceIntoPlaybackRect(context, video, video.videoWidth, video.videoHeight, targetRect)
  })
}

export function resolveGroupPlaybackVideoFramePlan(
  durationSeconds: number,
  fps = DEFAULT_GROUP_PLAYBACK_VIDEO_FPS,
  maxFrames = DEFAULT_GROUP_PLAYBACK_MAX_VIDEO_FRAMES
): GroupPlaybackVideoFramePlanEntry[] {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_GROUP_PLAYBACK_VIDEO_FPS
  const safeMaxFrames =
    Number.isFinite(maxFrames) && maxFrames > 0
      ? Math.max(1, Math.floor(maxFrames))
      : DEFAULT_GROUP_PLAYBACK_MAX_VIDEO_FRAMES

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [{ delayMs: DEFAULT_GROUP_PLAYBACK_SINGLE_VIDEO_DELAY_MS, timeSeconds: 0 }]
  }

  const effectiveDuration = Math.max(
    durationSeconds - GROUP_PLAYBACK_VIDEO_CAPTURE_END_EPSILON_SECONDS,
    0
  )
  const frameCount = Math.max(1, Math.min(safeMaxFrames, Math.ceil(durationSeconds * safeFps)))
  const delayMs = Math.max(
    GROUP_PLAYBACK_VIDEO_MIN_DELAY_MS,
    Math.round((durationSeconds * 1000) / frameCount)
  )

  if (frameCount === 1) {
    return [{ delayMs, timeSeconds: 0 }]
  }

  return Array.from({ length: frameCount }, (_, index) => ({
    delayMs,
    timeSeconds: effectiveDuration * (index / (frameCount - 1))
  }))
}

type DrawablePreviewSource = CanvasImageSource & {
  height: number
  width: number
}

function isDrawablePreviewSource(value: unknown): value is DrawablePreviewSource {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { width?: unknown }).width === 'number' &&
    typeof (value as { height?: unknown }).height === 'number'
  )
}

async function resolveModel3DPreviewSource(
  item: CanvasModel3DItem,
  sessionKey?: string
): Promise<DrawablePreviewSource | null> {
  const [
    { readCanvas3DStageModelBoundsCache },
    {
      getCanvas3DStagePreviewTextureKey,
      getOrCreateCanvas3DStagePreviewTexture,
      readCanvas3DStagePreviewTexture
    },
    { DEFAULT_CANVAS_MODEL3D_SESSION_KEY, getSceneInstanceCloneCacheKey }
  ] = await Promise.all([
    import('./components/canvas3DStageModelBoundsCache'),
    import('./components/canvas3DStagePreviewTextureCache'),
    import('./components/modelLoaders/sceneInstanceCloneCacheKey')
  ])

  const resolvedSessionKey = sessionKey?.trim() || DEFAULT_CANVAS_MODEL3D_SESSION_KEY
  const instanceCacheKey = getSceneInstanceCloneCacheKey({
    fileName: item.fileName,
    itemId: item.id,
    sessionKey: resolvedSessionKey,
    src: item.src,
    textures: item.textures
  })
  const modelBounds = readCanvas3DStageModelBoundsCache(instanceCacheKey)
  const previewTextureKey =
    getCanvas3DStagePreviewTextureKey({
      bounds: modelBounds,
      fileName: item.fileName,
      instanceCacheKey
    }) || `group-playback-gif:${instanceCacheKey}`

  let texture = readCanvas3DStagePreviewTexture(previewTextureKey)
  if (!texture) {
    texture = await getOrCreateCanvas3DStagePreviewTexture({
      cacheKey: previewTextureKey,
      instanceCacheKey
    })
  }

  return isDrawablePreviewSource(texture?.image) ? texture.image : null
}

function drawPlaybackModel3DFrame(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  item: CanvasModel3DItem,
  previewSource: DrawablePreviewSource
) {
  const targetRect = resolvePlaybackTargetRect(item, canvas)
  withPlaybackCanvasTransform(context, canvas, item, () => {
    drawSourceIntoPlaybackRect(
      context,
      previewSource,
      previewSource.width,
      previewSource.height,
      targetRect
    )
  })
}

export async function buildGroupPlaybackGif(
  items: GroupPlaybackItem[],
  options: GroupPlaybackGifOptions
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = options.width
  canvas.height = options.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('Cannot get 2D context.')
  }

  const gif = GIFEncoder()
  const bgColor = options.bgColor || DEFAULT_GROUP_PLAYBACK_GIF_BG
  const imageDelayMs = options.imageDelay ?? DEFAULT_GROUP_PLAYBACK_IMAGE_DELAY_MS
  const modelDelayMs = options.modelDelay ?? DEFAULT_GROUP_PLAYBACK_MODEL_DELAY_MS
  const videoFps = options.videoFps ?? DEFAULT_GROUP_PLAYBACK_VIDEO_FPS
  const maxVideoFrames = options.maxVideoFrames ?? DEFAULT_GROUP_PLAYBACK_MAX_VIDEO_FRAMES
  let hasValidFrames = false

  for (const item of items) {
    try {
      if (item.type === 'image') {
        const image = await loadPlaybackImage(item)
        clearGifFrameCanvas(context, canvas, bgColor)
        drawPlaybackImageFrame(context, canvas, item, image)
        writeCurrentCanvasFrame(gif, context, canvas, imageDelayMs)
        hasValidFrames = true
        continue
      }

      if (item.type === 'video') {
        const video = await loadPlaybackVideo(item)
        try {
          const framePlan = resolveGroupPlaybackVideoFramePlan(
            video.duration,
            videoFps,
            maxVideoFrames
          )
          for (const frame of framePlan) {
            await seekPlaybackVideo(video, frame.timeSeconds)
            clearGifFrameCanvas(context, canvas, bgColor)
            drawPlaybackVideoFrame(context, canvas, item, video)
            writeCurrentCanvasFrame(gif, context, canvas, frame.delayMs)
            hasValidFrames = true
          }
        } finally {
          video.pause()
          video.removeAttribute('src')
          video.load()
        }
        continue
      }

      if (item.type === 'model3d') {
        const previewSource = await resolveModel3DPreviewSource(item, options.sessionKey)
        if (!previewSource) {
          continue
        }
        clearGifFrameCanvas(context, canvas, bgColor)
        drawPlaybackModel3DFrame(context, canvas, item, previewSource)
        writeCurrentCanvasFrame(gif, context, canvas, modelDelayMs)
        hasValidFrames = true
      }
    } catch (error) {
      console.error('Error adding group playback GIF frame', error)
    }
  }

  if (!hasValidFrames) {
    throw new Error('No valid frames could be encoded into the GIF.')
  }

  gif.finish()
  return new Blob([gif.bytes()], { type: 'image/gif' })
}
