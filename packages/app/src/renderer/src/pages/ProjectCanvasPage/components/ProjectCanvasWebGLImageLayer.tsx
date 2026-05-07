import { Box } from '@mui/material'
import { Application, Container, Rectangle, Sprite, Texture } from 'pixi.js'
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { CanvasImageAsset, CanvasImageItem } from '../types'
import { buildCanvasSpatialIndex, queryCanvasSpatialIndex } from '../canvasSpatialIndex'
import { getCanvasViewportBounds } from '../canvasViewportPlacementUtils'
import { getCanvasItemBounds } from '../projectCanvasPageShared'
import {
  buildProjectCanvasRenderableImage,
  getProjectCanvasRenderTextureKey,
  getProjectCanvasRenderTransformKey,
  type ProjectCanvasImagePreview,
  type ProjectCanvasRenderableImage
} from '../projectCanvasRenderBoundary'
import { getCanvasImageAssetSize } from '../canvasImageAssetUtils'
import {
  PROJECT_CANVAS_IMAGE_LOD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE,
  resolveCanvasImageLodDecision,
  isCanvasImageSelectedSourceUpgradeEligible
} from '../canvasImageLodPolicy'
import { isCanvasThumbnailSetFresh, pickBestCanvasThumbnailLevel } from '../canvasThumbnailCache'
import type { CanvasImageThumbnailLevel, CanvasImageThumbnailSet } from '../canvasThumbnailTypes'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from '../projectCanvasViewportScale'
import type { ProjectCanvasWebGLRuntimeMetrics } from '../projectCanvasWebGLRuntimeState'
import {
  canReadCanvasLocalImageSource,
  createCanvasLocalImageObjectUrl,
  readCanvasLocalImageBlobFromSource
} from '../canvasLocalImageSource'

type ProjectCanvasWebGLImageLayerProps = {
  items: CanvasImageItem[]
  selectedIds?: ReadonlySet<string>
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize?: { width: number; height: number }
  isViewportInteracting?: boolean
  onReadyChange?: (ready: boolean) => void
  onResidentIdsChange?: (residentIds: Set<string>) => void
  onResolvedIdsChange?: (resolvedIds: Set<string>) => void
  onFailedIdsChange?: (failedIds: Set<string>) => void
  onMetricsChange?: (metrics: ProjectCanvasWebGLImageLayerMetrics) => void
}

type CachedImageRecord = {
  image: CanvasImageAsset
  src: string
}

type SpriteRecord = {
  sprite: Sprite
  texture: Texture
  sourceTexture?: Texture
  textureKey: string
  transformKey: string
  textureWidth: number
  textureHeight: number
  textureByteSize: number
  lastUsedAt: number
}

type SourceUpgradeQueueEntry = {
  itemId: string
  src: string
  priority: number
}

type ResizablePixiApplication = Application & {
  renderer?: {
    resize?: (width: number, height: number) => void
  }
}

export const PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT = 512
export const PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES = 768 * 1024 * 1024
export const PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES = 128 * 1024 * 1024
export const PROJECT_CANVAS_WEBGL_SELECTED_RESIDENT_LIMIT = 64
export const PROJECT_CANVAS_WEBGL_SELECTED_PROTECTED_LIMIT = 32
const PROJECT_CANVAS_WEBGL_IMAGE_VISIBLE_OVERSCAN_PX = 320
const VIEWPORT_RECONCILE_DEBOUNCE_MS = 48
const PROJECT_CANVAS_WEBGL_METRICS_THROTTLE_MS = 250
export const PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_MAX_SIDE = 4096
const PROJECT_CANVAS_WEBGL_SOURCE_UPGRADE_CONCURRENCY = 2
const PROJECT_CANVAS_WEBGL_SOURCE_UPGRADE_VIEWPORT_IDLE_DELAY_MS = 80
const PROJECT_CANVAS_WEBGL_IMAGE_VERSION_INTERACTION_MAX_DEFER_MS = 180
const PROJECT_CANVAS_WEBGL_THUMBNAIL_UPGRADE_CONCURRENCY = 6
const PROJECT_CANVAS_WEBGL_THUMBNAIL_LOD_SCREEN_GAIN = 1.5
const PROJECT_CANVAS_WEBGL_THUMBNAIL_LOD_TEXTURE_BUDGET_RATIO = 0.75
const PROJECT_CANVAS_WEBGL_DENSE_SOURCE_UPGRADE_CANDIDATE_LIMIT = 96
const PROJECT_CANVAS_WEBGL_DENSE_SOURCE_UPGRADE_MAX_SCALE = 0.5
const PROJECT_CANVAS_WEBGL_IMAGE_ELEMENT_SOURCE_DECODE_MAX_BYTES = 256 * 1024 * 1024
const PROJECT_CANVAS_WEBGL_IMAGE_ELEMENT_LOAD_TIMEOUT_MS = 15_000
const PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_LOAD_TIMEOUT_MS = 12_000
export const PROJECT_CANVAS_WEBGL_INITIAL_IMAGE_LOAD_CONCURRENCY = 8
export const PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE = 16
export const PROJECT_CANVAS_WEBGL_OVERVIEW_SPRITE_RECONCILE_BATCH_SIZE = 128
const PROJECT_CANVAS_WEBGL_SOURCE_OVERVIEW_MAX_SCALE =
  PROJECT_CANVAS_IMAGE_LOD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE
const PROJECT_CANVAS_WEBGL_OVERVIEW_BATCH_MAX_SCALE = 0.25

export type ProjectCanvasWebGLImageLayerMetrics = ProjectCanvasWebGLRuntimeMetrics

export type ProjectCanvasWebGLImageLayerHandle = {
  syncItemPreview: (itemId: string, preview: ProjectCanvasImagePreview | null) => void
  syncViewport: (pos: { x: number; y: number }, scale: number) => void
  setViewportInteracting: (active: boolean) => void
}

function applySpriteTransform(
  sprite: Sprite,
  metrics: { textureWidth: number; textureHeight: number },
  item: ProjectCanvasImagePreview
) {
  sprite.position.set(item.x, item.y)
  sprite.scale.set(
    (item.width / metrics.textureWidth) * item.scaleX,
    (item.height / metrics.textureHeight) * item.scaleY
  )
  sprite.rotation = (item.rotation * Math.PI) / 180
}

function getProjectCanvasTextureByteSize(
  renderItem: Pick<ProjectCanvasRenderableImage, 'sourceWidth' | 'sourceHeight'>
) {
  const width = Math.max(1, Math.round(renderItem.sourceWidth))
  const height = Math.max(1, Math.round(renderItem.sourceHeight))
  return width * height * 4
}

function canUploadProjectCanvasTexture(textureByteSize: number) {
  return (
    Number.isFinite(textureByteSize) &&
    textureByteSize > 0 &&
    textureByteSize <= PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES
  )
}

function getProjectCanvasSpriteReconcileBatchSize(stageScale: number) {
  const safeScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  return safeScale <= PROJECT_CANVAS_WEBGL_OVERVIEW_BATCH_MAX_SCALE
    ? PROJECT_CANVAS_WEBGL_OVERVIEW_SPRITE_RECONCILE_BATCH_SIZE
    : PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE
}

function shouldSuppressIntermediateOverviewRender(stageScale: number) {
  const safeScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  return safeScale <= PROJECT_CANVAS_WEBGL_OVERVIEW_BATCH_MAX_SCALE
}

function closeCanvasImageAssetIfPossible(value: unknown) {
  const close = (value as { close?: unknown } | null | undefined)?.close
  if (typeof close === 'function') {
    close.call(value)
  }
}

function withProjectCanvasWebGLTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let settled = false

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return
      }

      settled = true
      reject(new Error(message))
    }, timeoutMs)

    promise.then(
      (value) => {
        if (settled) {
          closeCanvasImageAssetIfPossible(value)
          return
        }

        settled = true
        window.clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        if (settled) {
          return
        }

        settled = true
        window.clearTimeout(timeoutId)
        reject(error)
      }
    )
  })
}

function getPreviewVisibilityBounds(preview: ProjectCanvasImagePreview) {
  const width = Math.abs(preview.width * preview.scaleX)
  const height = Math.abs(preview.height * preview.scaleY)
  return {
    minX: preview.x,
    minY: preview.y,
    maxX: preview.x + width,
    maxY: preview.y + height
  }
}

function doCanvasBoundsIntersect(
  left: { minX: number; minY: number; maxX: number; maxY: number },
  right: { minX: number; minY: number; maxX: number; maxY: number }
) {
  return (
    left.maxX >= right.minX &&
    left.minX <= right.maxX &&
    left.maxY >= right.minY &&
    left.minY <= right.maxY
  )
}

function destroyProjectCanvasTexture(texture: Texture | null | undefined, destroySource: boolean) {
  if (!texture) {
    return
  }

  texture.destroy(destroySource)
}

function destroyProjectCanvasSpriteRecord(record: SpriteRecord) {
  record.sprite.removeFromParent()
  record.sprite.destroy()

  if (record.texture !== record.sourceTexture) {
    destroyProjectCanvasTexture(record.texture, false)
  }
  destroyProjectCanvasTexture(record.sourceTexture ?? record.texture, true)
}

function getProjectCanvasTextureScaleMode(): 'linear' {
  return 'linear'
}

function applyProjectCanvasTextureScaleMode(record: SpriteRecord) {
  const textureSource = (record.sourceTexture ?? record.texture).source as
    | { scaleMode?: 'nearest' | 'linear' }
    | undefined
  if (!textureSource) {
    return
  }

  const nextScaleMode = getProjectCanvasTextureScaleMode()
  if (textureSource.scaleMode !== nextScaleMode) {
    textureSource.scaleMode = nextScaleMode
  }
}

function getProjectCanvasRenderDeviceScale() {
  return typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
    ? Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    : 1
}

function areProjectCanvasWebGLMetricsEqual(
  left: ProjectCanvasWebGLImageLayerMetrics | null,
  right: ProjectCanvasWebGLImageLayerMetrics
) {
  return (
    left !== null &&
    left.isInitialized === right.isInitialized &&
    left.imageCount === right.imageCount &&
    left.loadedImageCount === right.loadedImageCount &&
    left.failedImageCount === right.failedImageCount &&
    left.residentImageCount === right.residentImageCount &&
    left.residentTextureBytes === right.residentTextureBytes &&
    left.residentCandidateTextureBytes === right.residentCandidateTextureBytes &&
    left.residentTextureBudgetBytes === right.residentTextureBudgetBytes &&
    left.pendingImageCount === right.pendingImageCount &&
    left.spriteCount === right.spriteCount &&
    left.residentCandidateImageCount === right.residentCandidateImageCount &&
    left.viewportCulledImageCount === right.viewportCulledImageCount &&
    left.usingPreviewImageCount === right.usingPreviewImageCount &&
    left.usingSourceImageCount === right.usingSourceImageCount &&
    left.thumbnailPreviewImageCount === right.thumbnailPreviewImageCount &&
    left.placeholderImageCount === right.placeholderImageCount &&
    left.sourceUpgradeSuppressedImageCount === right.sourceUpgradeSuppressedImageCount &&
    left.sourceUpgradeablePreviewImageCount === right.sourceUpgradeablePreviewImageCount &&
    left.sourceUpgradePendingImageCount === right.sourceUpgradePendingImageCount &&
    left.sourceUpgradeFailedImageCount === right.sourceUpgradeFailedImageCount &&
    left.missingImageCount === right.missingImageCount &&
    left.renderCount === right.renderCount &&
    left.lastRenderDurationMs === right.lastRenderDurationMs &&
    left.lastUpdateReason === right.lastUpdateReason
  )
}

function shouldUseAnonymousCrossOrigin(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

function shouldLoadSourceTexture(
  item: CanvasImageItem,
  image: CanvasImageAsset | null | undefined,
  stageScale: number,
  options: {
    force?: boolean
    isVisible?: boolean
    sourceTextureByteSize?: number
    residentTextureBytes?: number
    existingTextureBytes?: number
    residentTextureBudgetBytes?: number
  } = {}
) {
  return resolveCanvasImageLodDecision({
    item,
    image,
    stageScale,
    forceSource: options.force,
    isVisible: options.isVisible,
    sourceTextureByteSize: options.sourceTextureByteSize,
    residentTextureBytes: options.residentTextureBytes,
    existingTextureBytes: options.existingTextureBytes,
    residentTextureBudgetBytes: options.residentTextureBudgetBytes,
    deviceScale: getProjectCanvasRenderDeviceScale()
  }).shouldUseSourceTexture
}

function shouldForceSelectedSourceTextureUpgrade(
  itemId: string,
  selectedIds: ReadonlySet<string> | undefined,
  stageScale: number
) {
  const safeScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  if (safeScale <= PROJECT_CANVAS_WEBGL_SOURCE_OVERVIEW_MAX_SCALE) {
    return false
  }

  return isCanvasImageSelectedSourceUpgradeEligible(
    itemId,
    selectedIds,
    PROJECT_CANVAS_WEBGL_SELECTED_PROTECTED_LIMIT
  )
}

function loadImageElementDirect(
  src: string,
  options: { crossOrigin?: 'anonymous' | null } = {}
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false
    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return
      }

      settled = true
      image.onload = null
      image.onerror = null
      reject(new Error('Timed out loading image element.'))
    }, PROJECT_CANVAS_WEBGL_IMAGE_ELEMENT_LOAD_TIMEOUT_MS)
    const settle = (callback: () => void) => {
      if (settled) {
        return
      }

      settled = true
      window.clearTimeout(timeoutId)
      image.onload = null
      image.onerror = null
      callback()
    }
    if (options.crossOrigin) {
      image.crossOrigin = options.crossOrigin
    }
    image.onload = () => settle(() => resolve(image))
    image.onerror = () =>
      settle(() => reject(new Error('Failed to load downscaled source texture.')))
    image.src = src
  })
}

function loadImageElement(
  src: string,
  options: { crossOrigin?: 'anonymous' | null } = {}
): Promise<HTMLImageElement> {
  if (!canReadCanvasLocalImageSource(src)) {
    return loadImageElementDirect(src, options)
  }

  return createCanvasLocalImageObjectUrl(src).then((localObjectUrl) =>
    loadImageElementDirect(localObjectUrl ?? src, options)
  )
}

function resolveBoundedSourceTextureSize(width: number, height: number) {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const maxSide = Math.max(safeWidth, safeHeight)
  const uploadMaxSide = Math.max(
    1,
    Math.floor(Math.sqrt(PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES / 4))
  )
  const targetMaxSide = Math.min(PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_MAX_SIDE, uploadMaxSide)
  const sideScale = maxSide > targetMaxSide ? targetMaxSide / maxSide : 1
  let targetWidth = Math.max(1, Math.round(safeWidth * sideScale))
  let targetHeight = Math.max(1, Math.round(safeHeight * sideScale))
  const byteSize = targetWidth * targetHeight * 4

  if (byteSize > PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES) {
    const byteScale = Math.sqrt(PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES / byteSize)
    targetWidth = Math.max(1, Math.floor(targetWidth * byteScale))
    targetHeight = Math.max(1, Math.floor(targetHeight * byteScale))
  }

  return {
    width: targetWidth,
    height: targetHeight
  }
}

function estimateSourceTextureByteSize(
  item: CanvasImageItem,
  image: CanvasImageAsset | null | undefined
) {
  const imageSize = getCanvasImageAssetSize(image)
  const sourceWidth = item.sourceWidth ?? imageSize.width ?? item.width
  const sourceHeight = item.sourceHeight ?? imageSize.height ?? item.height
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return undefined
  }

  const targetSize = resolveBoundedSourceTextureSize(sourceWidth, sourceHeight)
  return targetSize.width * targetSize.height * 4
}

function getCanvasThumbnailLevelTextureByteSize(level: CanvasImageThumbnailLevel): number {
  const width =
    Number.isFinite(level.width) && level.width > 0 ? Math.round(level.width) : level.maxSide
  const height =
    Number.isFinite(level.height) && level.height > 0 ? Math.round(level.height) : level.maxSide
  return Math.max(1, width) * Math.max(1, height) * 4
}

function getCanvasThumbnailLodTextureBudgetBytes(residentCandidateImageCount: number): number {
  const residentCount = Math.min(
    PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT,
    Math.max(1, Math.floor(residentCandidateImageCount || 1))
  )
  return (
    (PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES *
      PROJECT_CANVAS_WEBGL_THUMBNAIL_LOD_TEXTURE_BUDGET_RATIO) /
    residentCount
  )
}

function pickBudgetedCanvasThumbnailLevel(
  thumbnailSet: CanvasImageThumbnailSet,
  requestedMaxSide: number,
  residentCandidateImageCount: number
) {
  const targetLevel = pickBestCanvasThumbnailLevel(thumbnailSet, requestedMaxSide)
  if (!targetLevel) {
    return null
  }

  const maxTextureBytes = getCanvasThumbnailLodTextureBudgetBytes(residentCandidateImageCount)
  const sortedLevels = [...thumbnailSet.levels].sort((left, right) => left.maxSide - right.maxSide)
  const budgetedLevels = sortedLevels.filter((level) => {
    return (
      level.maxSide <= targetLevel.maxSide &&
      getCanvasThumbnailLevelTextureByteSize(level) <= maxTextureBytes
    )
  })

  return budgetedLevels[budgetedLevels.length - 1] ?? sortedLevels[0] ?? null
}

function resolveCanvasImageThumbnailLodLevel(
  item: CanvasImageItem,
  image: CanvasImageAsset | null | undefined,
  stageScale: number,
  options: {
    currentThumbnailSrc?: string | null
    residentCandidateImageCount?: number
  } = {}
) {
  if (!isCanvasThumbnailSetFresh(item.thumbnailSet, item.sourceIdentity)) {
    return null
  }

  const imageSize = getCanvasImageAssetSize(image)
  const previewMaxSide =
    Number.isFinite(imageSize.width) && Number.isFinite(imageSize.height)
      ? Math.max(imageSize.width, imageSize.height)
      : 0
  const safeScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  const projectedMaxSide =
    Math.max(Math.abs(item.width * item.scaleX), Math.abs(item.height * item.scaleY)) * safeScale
  const deviceScale = getProjectCanvasRenderDeviceScale()
  const requestedMaxSide = Math.ceil(
    Math.max(
      previewMaxSide,
      projectedMaxSide * deviceScale * PROJECT_CANVAS_WEBGL_THUMBNAIL_LOD_SCREEN_GAIN
    )
  )
  const level = pickBudgetedCanvasThumbnailLevel(
    item.thumbnailSet,
    requestedMaxSide,
    options.residentCandidateImageCount ?? 1
  )

  if (!level?.src || level.src === options.currentThumbnailSrc) {
    return null
  }

  if (!options.currentThumbnailSrc && level.maxSide <= previewMaxSide) {
    return null
  }

  return level
}

async function loadBoundedSourceTextureFromUrl({
  src,
  sourceWidth,
  sourceHeight
}: {
  src: string
  sourceWidth: number
  sourceHeight: number
}): Promise<CanvasImageAsset | null> {
  if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') {
    return null
  }

  const targetSize = resolveBoundedSourceTextureSize(sourceWidth, sourceHeight)
  if (!canUploadProjectCanvasTexture(targetSize.width * targetSize.height * 4)) {
    return null
  }

  const localBlob = await readCanvasLocalImageBlobFromSource(src)
  let blob = localBlob
  if (!blob) {
    const response = await fetch(src)
    if (!response.ok && response.status !== 0) {
      throw new Error(`Failed to fetch bounded source texture: ${response.status}`)
    }

    blob = await response.blob()
  }

  return createImageBitmap(blob, {
    resizeWidth: targetSize.width,
    resizeHeight: targetSize.height,
    resizeQuality: 'high'
  })
}

async function downscaleSourceTextureForWebGL(image: HTMLImageElement): Promise<CanvasImageAsset> {
  const width = image.naturalWidth || image.width || 0
  const height = image.naturalHeight || image.height || 0
  const maxSide = Math.max(width, height)
  if (
    maxSide <= PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_MAX_SIDE ||
    width <= 0 ||
    height <= 0 ||
    typeof document === 'undefined'
  ) {
    return image
  }

  const canvas = document.createElement('canvas')
  const { width: targetWidth, height: targetHeight } = resolveBoundedSourceTextureSize(
    width,
    height
  )
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(image, {
        resizeWidth: targetWidth,
        resizeHeight: targetHeight,
        resizeQuality: 'high'
      })
    } catch {
      // Fall through to canvas downscaling when ImageBitmap resize is unavailable.
    }
  }

  canvas.width = targetWidth
  canvas.height = targetHeight

  const context = canvas.getContext('2d')
  if (!context || typeof canvas.toBlob !== 'function') {
    return image
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/webp', 0.92)
  })
  if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return image
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    return await loadImageElement(objectUrl)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function loadBoundedSourceTextureViaImageElement({
  src,
  useAnonymousCrossOrigin
}: {
  src: string
  useAnonymousCrossOrigin: boolean
}): Promise<CanvasImageAsset> {
  const image = await loadImageElement(src, {
    crossOrigin: useAnonymousCrossOrigin ? 'anonymous' : null
  })
  return downscaleSourceTextureForWebGL(image)
}

const ProjectCanvasWebGLImageLayer = forwardRef<
  ProjectCanvasWebGLImageLayerHandle,
  ProjectCanvasWebGLImageLayerProps
>(function ProjectCanvasWebGLImageLayer(
  {
    items,
    selectedIds,
    stagePos,
    stageScale,
    stageSize,
    isViewportInteracting = false,
    onReadyChange,
    onResidentIdsChange,
    onResolvedIdsChange,
    onFailedIdsChange,
    onMetricsChange
  }: ProjectCanvasWebGLImageLayerProps,
  ref
) {
  const stagePosX = stagePos.x
  const stagePosY = stagePos.y
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<Application | null>(null)
  const worldRef = useRef<Container | null>(null)
  const imageCacheRef = useRef(new Map<string, CachedImageRecord>())
  const thumbnailCacheRef = useRef(new Map<string, CachedImageRecord>())
  const failedLoadSrcByIdRef = useRef(new Map<string, string>())
  const failedSourceUpgradeSrcByIdRef = useRef(new Map<string, string>())
  const skippedSourceUpgradeSrcByIdRef = useRef(new Map<string, string>())
  const pendingLoadsRef = useRef(new Set<string>())
  const pendingLoadSrcByIdRef = useRef(new Map<string, string>())
  const pendingThumbnailLoadSrcByIdRef = useRef(new Map<string, string>())
  const failedThumbnailLoadSrcByIdRef = useRef(new Map<string, string>())
  const thumbnailLoadQueueRef = useRef<SourceUpgradeQueueEntry[]>([])
  const activeThumbnailLoadCountRef = useRef(0)
  const initialLoadQueueRef = useRef<SourceUpgradeQueueEntry[]>([])
  const activeInitialLoadCountRef = useRef(0)
  const sourceUpgradeQueueRef = useRef<SourceUpgradeQueueEntry[]>([])
  const sourceUpgradeEligibleIdsRef = useRef(new Set<string>())
  const activeSourceUpgradeSrcByIdRef = useRef(new Map<string, string>())
  const activeSourceUpgradeCountRef = useRef(0)
  const spriteRecordsRef = useRef(new Map<string, SpriteRecord>())
  const previewStateRef = useRef(new Map<string, ProjectCanvasImagePreview>())
  const renderItemsRef = useRef(new Map<string, ProjectCanvasRenderableImage>())
  const currentItemsRef = useRef(items)
  const currentItemByIdRef = useRef(
    new Map<string, CanvasImageItem>(items.map((item) => [item.id, item]))
  )
  const currentItemIdsRef = useRef(new Set(items.map((item) => item.id)))
  const spriteUsageCounterRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const activeItemCountRef = useRef(0)
  const stagePosRef = useRef(stagePos)
  const stageScaleRef = useRef(stageScale)
  const stageSizeRef = useRef(stageSize)
  const selectedIdsRef = useRef(selectedIds)
  const residentCandidateIdsRef = useRef<ReadonlySet<string> | null>(null)
  const rendererSizeRef = useRef<{ width: number; height: number } | null>(null)
  const runtimeFailureHandlerRef = useRef<((error: unknown) => void) | null>(null)
  const viewportReconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sourceUpgradeIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sourceUpgradeAllowedAtRef = useRef(0)
  const isViewportInteractingRef = useRef(isViewportInteracting)
  const metricsReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasDeferredMetricsReportRef = useRef(false)
  const imageVersionDeferredTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasDeferredImageVersionUpdateRef = useRef(false)
  const lastReportedMetricsRef = useRef<ProjectCanvasWebGLImageLayerMetrics | null>(null)
  const spriteReconcileFrameRef = useRef<number | null>(null)
  const imageVersionFrameRef = useRef<number | null>(null)
  const imageElementLoadTimeoutsRef = useRef<Set<number>>(new Set())
  const metricsRef = useRef<ProjectCanvasWebGLImageLayerMetrics>({
    isInitialized: false,
    imageCount: 0,
    loadedImageCount: 0,
    failedImageCount: 0,
    residentImageCount: 0,
    residentTextureBytes: 0,
    residentCandidateTextureBytes: 0,
    residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
    pendingImageCount: 0,
    spriteCount: 0,
    residentCandidateImageCount: 0,
    viewportCulledImageCount: 0,
    usingPreviewImageCount: 0,
    usingSourceImageCount: 0,
    thumbnailPreviewImageCount: 0,
    placeholderImageCount: 0,
    sourceUpgradeSuppressedImageCount: 0,
    sourceUpgradeablePreviewImageCount: 0,
    sourceUpgradePendingImageCount: 0,
    sourceUpgradeFailedImageCount: 0,
    missingImageCount: 0,
    renderCount: 0,
    lastRenderDurationMs: null,
    lastUpdateReason: 'initialize'
  })
  const [isInitialized, setIsInitialized] = useState(false)
  const [imageVersion, setImageVersion] = useState(0)
  const [viewportVersion, setViewportVersion] = useState(0)
  selectedIdsRef.current = selectedIds
  const itemSpatialIndex = useMemo(
    () => buildCanvasSpatialIndex(items, getCanvasItemBounds),
    [items]
  )

  const queueImageVersionFrame = useCallback(() => {
    if (imageVersionFrameRef.current !== null) {
      return
    }

    imageVersionFrameRef.current = window.requestAnimationFrame(() => {
      imageVersionFrameRef.current = null
      setImageVersion((version) => version + 1)
    })
  }, [])

  const scheduleImageVersionUpdate = useCallback(() => {
    if (isViewportInteractingRef.current) {
      hasDeferredImageVersionUpdateRef.current = true
      if (imageVersionDeferredTimerRef.current === null) {
        imageVersionDeferredTimerRef.current = setTimeout(() => {
          imageVersionDeferredTimerRef.current = null
          if (!hasDeferredImageVersionUpdateRef.current) {
            return
          }

          hasDeferredImageVersionUpdateRef.current = false
          queueImageVersionFrame()
        }, PROJECT_CANVAS_WEBGL_IMAGE_VERSION_INTERACTION_MAX_DEFER_MS)
      }
      return
    }

    if (imageVersionDeferredTimerRef.current !== null) {
      clearTimeout(imageVersionDeferredTimerRef.current)
      imageVersionDeferredTimerRef.current = null
    }
    hasDeferredImageVersionUpdateRef.current = false
    queueImageVersionFrame()
  }, [queueImageVersionFrame])

  const flushMetricsReport = useCallback(
    (options: { force?: boolean } = {}) => {
      if (metricsReportTimerRef.current !== null) {
        clearTimeout(metricsReportTimerRef.current)
        metricsReportTimerRef.current = null
      }

      if (isViewportInteractingRef.current && !options.force) {
        hasDeferredMetricsReportRef.current = true
        return
      }

      hasDeferredMetricsReportRef.current = false
      const nextMetrics = { ...metricsRef.current }
      if (areProjectCanvasWebGLMetricsEqual(lastReportedMetricsRef.current, nextMetrics)) {
        return
      }
      lastReportedMetricsRef.current = nextMetrics
      onMetricsChange?.(nextMetrics)
    },
    [onMetricsChange]
  )

  const reportMetrics = useCallback(
    (
      patch: Partial<ProjectCanvasWebGLImageLayerMetrics>,
      options: { immediate?: boolean } = {}
    ) => {
      metricsRef.current = { ...metricsRef.current, ...patch }
      if (options.immediate) {
        flushMetricsReport()
        return
      }

      if (metricsReportTimerRef.current !== null) {
        return
      }

      metricsReportTimerRef.current = setTimeout(() => {
        metricsReportTimerRef.current = null
        if (isViewportInteractingRef.current) {
          hasDeferredMetricsReportRef.current = true
          return
        }
        const nextMetrics = { ...metricsRef.current }
        if (areProjectCanvasWebGLMetricsEqual(lastReportedMetricsRef.current, nextMetrics)) {
          return
        }
        lastReportedMetricsRef.current = nextMetrics
        onMetricsChange?.(nextMetrics)
      }, PROJECT_CANVAS_WEBGL_METRICS_THROTTLE_MS)
    },
    [flushMetricsReport, onMetricsChange]
  )

  const getResidentTextureBytes = useCallback(() => {
    let residentTextureBytes = 0
    spriteRecordsRef.current.forEach((record) => {
      residentTextureBytes += record.textureByteSize
    })
    return residentTextureBytes
  }, [])

  const collectImageHealthCounts = useCallback(
    (candidateIds?: ReadonlySet<string>) => {
      let usingPreviewImageCount = 0
      let usingSourceImageCount = 0
      let thumbnailPreviewImageCount = 0
      let placeholderImageCount = 0
      let sourceUpgradeSuppressedImageCount = 0
      let sourceUpgradeablePreviewImageCount = 0
      let sourceUpgradePendingImageCount = 0
      let sourceUpgradeFailedImageCount = 0
      let missingImageCount = 0

      const collectItem = (item: CanvasImageItem) => {
        const fallbackImage = item.image
        const cachedThumbnail = thumbnailCacheRef.current.get(item.id)
        const hasCurrentThumbnailCache =
          cachedThumbnail &&
          isCanvasThumbnailSetFresh(item.thumbnailSet, item.sourceIdentity) &&
          item.thumbnailSet.levels.some((level) => level.src === cachedThumbnail.src)
        const previewImage = hasCurrentThumbnailCache ? cachedThumbnail.image : fallbackImage
        const cached = imageCacheRef.current.get(item.id)
        const hasCachedSource = Boolean(cached && cached.src === item.src)
        const renderItem = renderItemsRef.current.get(item.id)
        const forceSelectedSourceTexture = shouldForceSelectedSourceTextureUpgrade(
          item.id,
          selectedIdsRef.current,
          stageScaleRef.current
        )
        const denseSourceUpgradeSuppressed = Boolean(
          candidateIds &&
          candidateIds.size > PROJECT_CANVAS_WEBGL_DENSE_SOURCE_UPGRADE_CANDIDATE_LIMIT &&
          Math.max(Math.abs(stageScaleRef.current), PROJECT_CANVAS_MIN_STAGE_SCALE) <
            PROJECT_CANVAS_WEBGL_DENSE_SOURCE_UPGRADE_MAX_SCALE &&
          !forceSelectedSourceTexture
        )
        const lodDecision = resolveCanvasImageLodDecision({
          item,
          image: previewImage ?? cached?.image ?? null,
          stageScale: stageScaleRef.current,
          forceSource: forceSelectedSourceTexture,
          isVisible: candidateIds ? candidateIds.has(item.id) : true,
          sourceTextureByteSize: estimateSourceTextureByteSize(item, previewImage ?? cached?.image),
          residentTextureBytes: getResidentTextureBytes(),
          existingTextureBytes: spriteRecordsRef.current.get(item.id)?.textureByteSize ?? 0,
          residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
          deviceScale: getProjectCanvasRenderDeviceScale()
        })
        const shouldUpgradeFallback = previewImage
          ? lodDecision.shouldUseSourceTexture && !denseSourceUpgradeSuppressed
          : false

        if (lodDecision.usesThumbnailPreview) {
          thumbnailPreviewImageCount += 1
        }
        if (lodDecision.usesPlaceholderPreview) {
          placeholderImageCount += 1
        }
        if (
          lodDecision.sourceTextureSuppressed ||
          (denseSourceUpgradeSuppressed && lodDecision.sourceTextureNeeded)
        ) {
          sourceUpgradeSuppressedImageCount += 1
        }

        if (renderItem) {
          if (previewImage && renderItem.image === previewImage) {
            usingPreviewImageCount += 1
            if (shouldUpgradeFallback) {
              sourceUpgradeablePreviewImageCount += 1
            }
          } else if (cached && cached.src === item.src && renderItem.image === cached.image) {
            usingSourceImageCount += 1
          } else if (!fallbackImage && hasCachedSource) {
            usingSourceImageCount += 1
          }
        }

        if (previewImage && shouldUpgradeFallback) {
          const sourceUpgradeFailed =
            failedSourceUpgradeSrcByIdRef.current.get(item.id) === item.src
          const sourceUpgradeSkipped =
            skippedSourceUpgradeSrcByIdRef.current.get(item.id) === item.src
          const stillRenderingPreview = Boolean(renderItem && renderItem.image === previewImage)
          if (
            !sourceUpgradeFailed &&
            !sourceUpgradeSkipped &&
            (!hasCachedSource || stillRenderingPreview)
          ) {
            sourceUpgradePendingImageCount += 1
          }
          if (sourceUpgradeFailed) {
            sourceUpgradeFailedImageCount += 1
          }
        }

        const pendingSrc = pendingLoadSrcByIdRef.current.get(item.id)
        if (!renderItem && !previewImage && !hasCachedSource && pendingSrc !== item.src) {
          missingImageCount += 1
        }
      }

      if (candidateIds) {
        candidateIds.forEach((itemId) => {
          const item = currentItemByIdRef.current.get(itemId)
          if (item) {
            collectItem(item)
          }
        })
      } else {
        currentItemsRef.current.forEach(collectItem)
      }

      return {
        usingPreviewImageCount,
        usingSourceImageCount,
        thumbnailPreviewImageCount,
        placeholderImageCount,
        sourceUpgradeSuppressedImageCount,
        sourceUpgradeablePreviewImageCount,
        sourceUpgradePendingImageCount,
        sourceUpgradeFailedImageCount,
        missingImageCount
      }
    },
    [getResidentTextureBytes]
  )

  const collectResolvedImageIds = useCallback(() => {
    const resolvedIds = new Set<string>()
    currentItemsRef.current.forEach((item) => {
      if (item.image) {
        resolvedIds.add(item.id)
        return
      }

      const cached = imageCacheRef.current.get(item.id)
      if (cached && cached.src === item.src) {
        resolvedIds.add(item.id)
      }
    })

    return resolvedIds
  }, [])

  const emitItemLoadMetricsSnapshot = useCallback(
    (
      patch: Partial<ProjectCanvasWebGLImageLayerMetrics> = {},
      lastUpdateReason: ProjectCanvasWebGLImageLayerMetrics['lastUpdateReason'] = 'items',
      options: { immediateMetrics?: boolean; emitIdSets?: boolean; emitMetrics?: boolean } = {}
    ) => {
      const residentIds = new Set(spriteRecordsRef.current.keys())
      const resolvedIds = collectResolvedImageIds()
      const failedIds = new Set(failedLoadSrcByIdRef.current.keys())
      const residentTextureBytes = getResidentTextureBytes()
      const imageHealthCounts = collectImageHealthCounts(
        residentCandidateIdsRef.current ?? undefined
      )
      if (options.emitIdSets !== false) {
        onResidentIdsChange?.(residentIds)
        onResolvedIdsChange?.(resolvedIds)
        onFailedIdsChange?.(failedIds)
      }
      const nextMetrics = {
        imageCount: activeItemCountRef.current,
        loadedImageCount: resolvedIds.size,
        failedImageCount: failedIds.size,
        residentImageCount: residentIds.size,
        residentTextureBytes,
        pendingImageCount:
          pendingLoadsRef.current.size + pendingThumbnailLoadSrcByIdRef.current.size,
        spriteCount: residentIds.size,
        residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
        ...imageHealthCounts,
        lastUpdateReason,
        ...patch
      }
      if (options.emitMetrics === false) {
        metricsRef.current = { ...metricsRef.current, ...nextMetrics }
        return
      }
      reportMetrics(nextMetrics, { immediate: options.immediateMetrics ?? true })
    },
    [
      collectResolvedImageIds,
      collectImageHealthCounts,
      getResidentTextureBytes,
      onResidentIdsChange,
      onResolvedIdsChange,
      onFailedIdsChange,
      reportMetrics
    ]
  )

  useEffect(() => {
    currentItemsRef.current = items
    currentItemByIdRef.current = new Map(items.map((item) => [item.id, item]))
    currentItemIdsRef.current = new Set(items.map((item) => item.id))
  }, [items])

  const renderApp = useCallback(() => {
    if (!appRef.current) {
      return
    }

    const startedAt = window.performance.now()
    try {
      appRef.current.render()
    } catch (error) {
      runtimeFailureHandlerRef.current?.(error)
      return
    }
    const lastRenderDurationMs = Math.max(0, window.performance.now() - startedAt)
    if (isViewportInteractingRef.current) {
      metricsRef.current.renderCount += 1
      metricsRef.current.lastRenderDurationMs = lastRenderDurationMs
      hasDeferredMetricsReportRef.current = true
      return
    }

    reportMetrics({
      renderCount: metricsRef.current.renderCount + 1,
      lastRenderDurationMs
    })
  }, [reportMetrics])

  const scheduleViewportReconcile = useCallback(
    (options: { allowDuringInteraction?: boolean } = {}) => {
      const allowDuringInteraction = options.allowDuringInteraction === true
      if (
        (isViewportInteractingRef.current && !allowDuringInteraction) ||
        viewportReconcileTimerRef.current !== null
      ) {
        return
      }

      viewportReconcileTimerRef.current = setTimeout(() => {
        viewportReconcileTimerRef.current = null
        if (isViewportInteractingRef.current && !allowDuringInteraction) {
          return
        }
        setViewportVersion((version) => version + 1)
      }, VIEWPORT_RECONCILE_DEBOUNCE_MS)
    },
    []
  )

  const forceViewportReconcile = useCallback(() => {
    if (viewportReconcileTimerRef.current !== null) {
      clearTimeout(viewportReconcileTimerRef.current)
      viewportReconcileTimerRef.current = null
    }
    setViewportVersion((version) => version + 1)
  }, [])

  const scheduleSourceUpgradeIdleReconcile = useCallback(() => {
    if (sourceUpgradeIdleTimerRef.current !== null) {
      clearTimeout(sourceUpgradeIdleTimerRef.current)
      sourceUpgradeIdleTimerRef.current = null
    }

    sourceUpgradeAllowedAtRef.current =
      window.performance.now() + PROJECT_CANVAS_WEBGL_SOURCE_UPGRADE_VIEWPORT_IDLE_DELAY_MS
    sourceUpgradeIdleTimerRef.current = setTimeout(() => {
      sourceUpgradeIdleTimerRef.current = null
      if (isViewportInteractingRef.current) {
        return
      }
      sourceUpgradeAllowedAtRef.current = 0
      setViewportVersion((version) => version + 1)
    }, PROJECT_CANVAS_WEBGL_SOURCE_UPGRADE_VIEWPORT_IDLE_DELAY_MS)
  }, [])

  const setViewportInteractingState = useCallback(
    (active: boolean) => {
      if (isViewportInteractingRef.current === active) {
        return
      }

      isViewportInteractingRef.current = active
      if (active) {
        if (viewportReconcileTimerRef.current != null) {
          clearTimeout(viewportReconcileTimerRef.current)
          viewportReconcileTimerRef.current = null
        }
        if (sourceUpgradeIdleTimerRef.current != null) {
          clearTimeout(sourceUpgradeIdleTimerRef.current)
          sourceUpgradeIdleTimerRef.current = null
        }
        sourceUpgradeAllowedAtRef.current = Number.POSITIVE_INFINITY
        thumbnailLoadQueueRef.current = []
        pendingThumbnailLoadSrcByIdRef.current.clear()
        return
      }

      if (hasDeferredMetricsReportRef.current) {
        flushMetricsReport({ force: true })
      }
      if (hasDeferredImageVersionUpdateRef.current) {
        scheduleImageVersionUpdate()
      }
      scheduleSourceUpgradeIdleReconcile()
      forceViewportReconcile()
    },
    [
      flushMetricsReport,
      forceViewportReconcile,
      scheduleImageVersionUpdate,
      scheduleSourceUpgradeIdleReconcile
    ]
  )

  useLayoutEffect(() => {
    setViewportInteractingState(isViewportInteracting)
  }, [isViewportInteracting, setViewportInteractingState])

  useLayoutEffect(() => {
    return () => {
      if (viewportReconcileTimerRef.current != null) {
        clearTimeout(viewportReconcileTimerRef.current)
        viewportReconcileTimerRef.current = null
      }
      if (sourceUpgradeIdleTimerRef.current != null) {
        clearTimeout(sourceUpgradeIdleTimerRef.current)
        sourceUpgradeIdleTimerRef.current = null
      }
      if (imageVersionDeferredTimerRef.current != null) {
        clearTimeout(imageVersionDeferredTimerRef.current)
        imageVersionDeferredTimerRef.current = null
      }
      imageElementLoadTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId)
      })
      imageElementLoadTimeoutsRef.current.clear()
    }
  }, [])

  const scheduleRender = useCallback(() => {
    if (!appRef.current || rafRef.current !== null) {
      return
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      renderApp()
    })
  }, [renderApp])

  const cancelScheduledRender = useCallback(() => {
    if (rafRef.current === null) {
      return
    }

    window.cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  const resizeRendererToStage = useCallback(
    (preferredSize?: { width: number; height: number }) => {
      const app = appRef.current
      const host = hostRef.current
      if (!app || !host) {
        return
      }

      const rect = preferredSize ? null : host.getBoundingClientRect()
      const rawWidth = preferredSize?.width ?? rect?.width ?? 0
      const rawHeight = preferredSize?.height ?? rect?.height ?? 0
      const width = Number.isFinite(rawWidth) && rawWidth > 0 ? Math.round(rawWidth) : 1
      const height = Number.isFinite(rawHeight) && rawHeight > 0 ? Math.round(rawHeight) : 1
      const lastSize = rendererSizeRef.current
      if (lastSize?.width === width && lastSize.height === height) {
        return
      }

      rendererSizeRef.current = { width, height }
      const canvas = app.canvas as HTMLCanvasElement
      canvas.style.position = 'absolute'
      canvas.style.inset = '0'
      canvas.style.display = 'block'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      ;(app as ResizablePixiApplication).renderer?.resize?.(width, height)
      scheduleRender()
    },
    [scheduleRender]
  )

  const applyViewportTransform = useCallback(
    (pos: { x: number; y: number }, scale: number) => {
      stagePosRef.current = pos
      stageScaleRef.current = scale

      const world = worldRef.current
      if (!world || !isInitialized) {
        return
      }

      world.position.set(pos.x, pos.y)
      world.scale.set(scale)
      renderApp()
    },
    [isInitialized, renderApp]
  )

  const markSpriteRecordUsed = useCallback((record: SpriteRecord) => {
    spriteUsageCounterRef.current += 1
    record.lastUsedAt = spriteUsageCounterRef.current
  }, [])

  const destroySpriteRecord = useCallback(
    (itemId: string, options?: { retainPreview?: boolean }) => {
      const record = spriteRecordsRef.current.get(itemId)
      if (!record) {
        return
      }

      destroyProjectCanvasSpriteRecord(record)
      spriteRecordsRef.current.delete(itemId)

      if (!options?.retainPreview) {
        previewStateRef.current.delete(itemId)
      }
    },
    []
  )

  const evictOldestResidentSprite = useCallback(
    (protectedIds?: ReadonlySet<string>) => {
      let oldestItemId: string | null = null
      let oldestLastUsedAt = Infinity

      spriteRecordsRef.current.forEach((record, itemId) => {
        if (protectedIds?.has(itemId)) {
          return
        }

        if (record.lastUsedAt < oldestLastUsedAt) {
          oldestLastUsedAt = record.lastUsedAt
          oldestItemId = itemId
        }
      })

      if (!oldestItemId) {
        return null
      }

      destroySpriteRecord(oldestItemId, { retainPreview: true })
      return oldestItemId
    },
    [destroySpriteRecord]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    let disposed = false
    const pendingLoads = pendingLoadsRef.current
    const failedLoadSrcById = failedLoadSrcByIdRef.current
    const failedSourceUpgradeSrcById = failedSourceUpgradeSrcByIdRef.current
    const spriteRecords = spriteRecordsRef.current
    const previewState = previewStateRef.current
    const renderItems = renderItemsRef.current
    let runtimeDisposed = false
    let contextLostCanvas: HTMLCanvasElement | null = null
    let contextLostHandler: ((event: Event) => void) | null = null

    const cleanupRuntime = (lastUpdateReason: 'cleanup' | 'initialize') => {
      if (runtimeDisposed) {
        return
      }

      runtimeDisposed = true
      runtimeFailureHandlerRef.current = null
      if (contextLostCanvas && contextLostHandler) {
        contextLostCanvas.removeEventListener('webglcontextlost', contextLostHandler)
      }
      contextLostCanvas = null
      contextLostHandler = null

      setIsInitialized(false)
      onReadyChange?.(false)
      onResidentIdsChange?.(new Set())
      onResolvedIdsChange?.(new Set())
      onFailedIdsChange?.(new Set())

      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (viewportReconcileTimerRef.current !== null) {
        clearTimeout(viewportReconcileTimerRef.current)
        viewportReconcileTimerRef.current = null
      }
      if (metricsReportTimerRef.current !== null) {
        clearTimeout(metricsReportTimerRef.current)
        metricsReportTimerRef.current = null
      }
      if (imageVersionDeferredTimerRef.current !== null) {
        clearTimeout(imageVersionDeferredTimerRef.current)
        imageVersionDeferredTimerRef.current = null
      }
      if (spriteReconcileFrameRef.current !== null) {
        window.cancelAnimationFrame(spriteReconcileFrameRef.current)
        spriteReconcileFrameRef.current = null
      }
      if (imageVersionFrameRef.current !== null) {
        window.cancelAnimationFrame(imageVersionFrameRef.current)
        imageVersionFrameRef.current = null
      }
      imageElementLoadTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId)
      })
      imageElementLoadTimeoutsRef.current.clear()

      hasDeferredImageVersionUpdateRef.current = false
      pendingLoads.clear()
      pendingLoadSrcByIdRef.current.clear()
      pendingThumbnailLoadSrcByIdRef.current.clear()
      failedThumbnailLoadSrcByIdRef.current.clear()
      thumbnailLoadQueueRef.current = []
      activeThumbnailLoadCountRef.current = 0
      initialLoadQueueRef.current = []
      activeInitialLoadCountRef.current = 0
      sourceUpgradeQueueRef.current = []
      sourceUpgradeEligibleIdsRef.current.clear()
      activeSourceUpgradeSrcByIdRef.current.clear()
      activeSourceUpgradeCountRef.current = 0
      failedLoadSrcById.clear()
      failedSourceUpgradeSrcById.clear()
      skippedSourceUpgradeSrcByIdRef.current.clear()
      thumbnailCacheRef.current.clear()
      spriteRecords.forEach((record) => {
        destroyProjectCanvasSpriteRecord(record)
      })
      spriteRecords.clear()
      spriteUsageCounterRef.current = 0
      activeItemCountRef.current = 0
      rendererSizeRef.current = null
      previewState.clear()
      renderItems.clear()
      reportMetrics(
        {
          isInitialized: false,
          imageCount: 0,
          loadedImageCount: 0,
          failedImageCount: 0,
          residentImageCount: 0,
          residentTextureBytes: 0,
          residentCandidateTextureBytes: 0,
          residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
          pendingImageCount: 0,
          spriteCount: 0,
          residentCandidateImageCount: 0,
          viewportCulledImageCount: 0,
          usingPreviewImageCount: 0,
          usingSourceImageCount: 0,
          thumbnailPreviewImageCount: 0,
          placeholderImageCount: 0,
          sourceUpgradeSuppressedImageCount: 0,
          sourceUpgradeablePreviewImageCount: 0,
          sourceUpgradePendingImageCount: 0,
          sourceUpgradeFailedImageCount: 0,
          missingImageCount: 0,
          lastUpdateReason
        },
        { immediate: true }
      )

      try {
        appRef.current?.destroy(true, { children: true })
      } catch (error) {
        console.warn('[Canvas WebGL] Failed to destroy Pixi runtime after GPU failure.', error)
      }
      appRef.current = null
      worldRef.current = null
      host.replaceChildren()
    }

    runtimeFailureHandlerRef.current = (error: unknown) => {
      console.warn(
        '[Canvas WebGL] Pixi render failed; falling back to non-WebGL image rendering.',
        error
      )
      cleanupRuntime('cleanup')
    }

    const initialize = async () => {
      try {
        const app = new Application()
        await app.init({
          resizeTo: host,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: getProjectCanvasRenderDeviceScale(),
          autoStart: false,
          sharedTicker: false,
          preference: 'webgl',
          powerPreference: 'high-performance'
        })

        if (disposed) {
          app.destroy(true, { children: true })
          return
        }

        const world = new Container()
        world.sortableChildren = true
        const canvas = app.canvas as HTMLCanvasElement
        const handleContextLost = (event: Event) => {
          event.preventDefault()
          console.warn(
            '[Canvas WebGL] WebGL context lost; falling back to non-WebGL image rendering.'
          )
          cleanupRuntime('cleanup')
        }

        app.stage.addChild(world)
        appRef.current = app
        worldRef.current = world
        contextLostCanvas = canvas
        contextLostHandler = handleContextLost
        canvas.addEventListener('webglcontextlost', handleContextLost)
        host.replaceChildren(canvas)
        resizeRendererToStage(stageSizeRef.current)
        setIsInitialized(true)
        onReadyChange?.(true)
        reportMetrics(
          {
            isInitialized: true,
            lastUpdateReason: 'initialize'
          },
          { immediate: true }
        )
        scheduleRender()
      } catch {
        onReadyChange?.(false)
      }
    }

    void initialize()

    return () => {
      disposed = true
      runtimeFailureHandlerRef.current = null
      cleanupRuntime('cleanup')
    }
  }, [
    onResidentIdsChange,
    onReadyChange,
    onResolvedIdsChange,
    onFailedIdsChange,
    reportMetrics,
    resizeRendererToStage,
    scheduleRender
  ])

  useImperativeHandle(
    ref,
    () => ({
      syncViewport(pos, scale) {
        applyViewportTransform(pos, scale)
        scheduleViewportReconcile({ allowDuringInteraction: true })
      },
      setViewportInteracting(active) {
        setViewportInteractingState(active)
      },
      syncItemPreview(itemId, preview) {
        const record = spriteRecordsRef.current.get(itemId)

        if (!record) {
          if (!preview) {
            previewStateRef.current.delete(itemId)
          } else {
            previewStateRef.current.set(itemId, preview)
          }
          return
        }

        if (!preview) {
          previewStateRef.current.delete(itemId)
          const renderItem = renderItemsRef.current.get(itemId)
          if (renderItem) {
            applySpriteTransform(
              record.sprite,
              { textureWidth: record.textureWidth, textureHeight: record.textureHeight },
              renderItem
            )
            record.transformKey = getProjectCanvasRenderTransformKey(renderItem)
          }
          markSpriteRecordUsed(record)
          cancelScheduledRender()
          renderApp()
          return
        }

        previewStateRef.current.set(itemId, preview)
        applySpriteTransform(
          record.sprite,
          { textureWidth: record.textureWidth, textureHeight: record.textureHeight },
          preview
        )
        record.transformKey = getProjectCanvasRenderTransformKey(preview)
        markSpriteRecordUsed(record)
        cancelScheduledRender()
        renderApp()
      }
    }),
    [
      applyViewportTransform,
      cancelScheduledRender,
      markSpriteRecordUsed,
      renderApp,
      scheduleViewportReconcile,
      setViewportInteractingState
    ]
  )

  useLayoutEffect(() => {
    stageSizeRef.current = stageSize
    resizeRendererToStage(stageSize)
  }, [resizeRendererToStage, stageSize, stageSize?.width, stageSize?.height])

  useEffect(() => {
    if (!isInitialized || typeof ResizeObserver === 'undefined') {
      return
    }

    const host = hostRef.current
    if (!host) {
      return
    }

    const observer = new ResizeObserver(() => {
      resizeRendererToStage()
      scheduleViewportReconcile()
    })
    observer.observe(host)
    resizeRendererToStage(stageSizeRef.current)

    return () => {
      observer.disconnect()
    }
  }, [isInitialized, resizeRendererToStage, scheduleViewportReconcile])

  useLayoutEffect(() => {
    applyViewportTransform({ x: stagePosX, y: stagePosY }, stageScale)
  }, [applyViewportTransform, stagePosX, stagePosY, stageScale])

  // Throttle viewport-only reconciliation so imperative pan/zoom can admit newly visible images
  // without forcing React work on every pointer/wheel frame.
  useEffect(() => {
    scheduleViewportReconcile()
  }, [
    scheduleViewportReconcile,
    stagePosX,
    stagePosY,
    stageScale,
    stageSize?.width,
    stageSize?.height
  ])

  useEffect(() => {
    const world = worldRef.current
    if (!world || !isInitialized) {
      return
    }

    activeItemCountRef.current = items.length
    if (currentItemsRef.current !== items) {
      currentItemsRef.current = items
      currentItemByIdRef.current = new Map(items.map((item) => [item.id, item]))
      currentItemIdsRef.current = new Set(items.map((item) => item.id))
    }
    const itemById = currentItemByIdRef.current
    const nextIds = currentItemIdsRef.current
    let suppressDenseSourceUpgrades = false
    let residentCandidateImageCountForThumbnailLod = 1

    const clearPendingLoad = (itemId: string, src: string) => {
      if (pendingLoadSrcByIdRef.current.get(itemId) === src) {
        pendingLoadsRef.current.delete(itemId)
        pendingLoadSrcByIdRef.current.delete(itemId)
      }
    }

    const isSourceUpgradeIdleBlocked = () =>
      window.performance.now() < sourceUpgradeAllowedAtRef.current

    const shouldSuppressSourceUpgradeForItem = (
      item: CanvasImageItem,
      forceSelectedSourceTexture: boolean
    ) =>
      isSourceUpgradeIdleBlocked() || (suppressDenseSourceUpgrades && !forceSelectedSourceTexture)

    const startImageLoad = (
      item: CanvasImageItem,
      mode: 'initial' | 'source-upgrade',
      priority = 0
    ) => {
      if (mode === 'initial') {
        queueInitialImageLoad(item, priority)
        return
      }

      startImageLoadNow(item, mode)
    }

    function startImageLoadNow(item: CanvasImageItem, mode: 'initial' | 'source-upgrade') {
      if (!item.src) {
        return
      }

      const finishInitialLoad = () => {
        if (mode !== 'initial') {
          return
        }

        activeInitialLoadCountRef.current = Math.max(0, activeInitialLoadCountRef.current - 1)
        pumpInitialImageLoadQueue()
      }

      const finishSourceUpgrade = () => {
        if (mode !== 'source-upgrade') {
          return
        }

        activeSourceUpgradeCountRef.current = Math.max(0, activeSourceUpgradeCountRef.current - 1)
        if (activeSourceUpgradeSrcByIdRef.current.get(item.id) === item.src) {
          activeSourceUpgradeSrcByIdRef.current.delete(item.id)
        }
        pumpSourceUpgradeQueue()
      }

      const markUnavailableSource = () => {
        const currentItem = currentItemByIdRef.current.get(item.id)
        if (currentItem && currentItem.src === item.src) {
          if (mode === 'source-upgrade' && item.image) {
            skippedSourceUpgradeSrcByIdRef.current.set(item.id, item.src)
          } else {
            failedLoadSrcByIdRef.current.set(item.id, item.src)
          }
          emitItemLoadMetricsSnapshot()
        } else if (currentItem) {
          scheduleImageVersionUpdate()
        }
      }

      const sourceDecodeByteSize = getProjectCanvasTextureByteSize({
        sourceWidth: item.sourceWidth ?? item.width,
        sourceHeight: item.sourceHeight ?? item.height
      })
      if (!canUploadProjectCanvasTexture(sourceDecodeByteSize)) {
        if (mode === 'source-upgrade') {
          activeSourceUpgradeCountRef.current += 1
          activeSourceUpgradeSrcByIdRef.current.set(item.id, item.src)
        } else {
          activeInitialLoadCountRef.current += 1
          pendingLoadsRef.current.add(item.id)
          pendingLoadSrcByIdRef.current.set(item.id, item.src)
        }

        void (async () => {
          try {
            let resolvedImage: CanvasImageAsset | null = null
            try {
              resolvedImage = await withProjectCanvasWebGLTimeout(
                loadBoundedSourceTextureFromUrl({
                  src: item.src,
                  sourceWidth: item.sourceWidth ?? item.width,
                  sourceHeight: item.sourceHeight ?? item.height
                }),
                PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_LOAD_TIMEOUT_MS,
                'Timed out loading bounded source texture.'
              )
            } catch {
              resolvedImage = null
            }
            if (
              !resolvedImage &&
              sourceDecodeByteSize <= PROJECT_CANVAS_WEBGL_IMAGE_ELEMENT_SOURCE_DECODE_MAX_BYTES
            ) {
              resolvedImage = await withProjectCanvasWebGLTimeout(
                loadBoundedSourceTextureViaImageElement({
                  src: item.src,
                  useAnonymousCrossOrigin: shouldUseAnonymousCrossOrigin(item.src)
                }),
                PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_LOAD_TIMEOUT_MS,
                'Timed out loading bounded source texture through an image element.'
              )
            }
            clearPendingLoad(item.id, item.src)
            finishInitialLoad()
            finishSourceUpgrade()

            if (!resolvedImage) {
              markUnavailableSource()
              return
            }

            const currentItem = currentItemByIdRef.current.get(item.id)
            if (currentItem && currentItem.src === item.src) {
              failedLoadSrcByIdRef.current.delete(item.id)
              failedSourceUpgradeSrcByIdRef.current.delete(item.id)
              skippedSourceUpgradeSrcByIdRef.current.delete(item.id)
              imageCacheRef.current.set(item.id, { image: resolvedImage, src: item.src })
              scheduleImageVersionUpdate()
            } else if (currentItem) {
              scheduleImageVersionUpdate()
            }
          } catch {
            clearPendingLoad(item.id, item.src)
            finishInitialLoad()
            finishSourceUpgrade()
            markUnavailableSource()
          }
        })()
        return
      }

      if (mode === 'source-upgrade') {
        activeSourceUpgradeCountRef.current += 1
        activeSourceUpgradeSrcByIdRef.current.set(item.id, item.src)
      } else {
        activeInitialLoadCountRef.current += 1
        pendingLoadsRef.current.add(item.id)
        pendingLoadSrcByIdRef.current.set(item.id, item.src)
      }

      const handleImageLoad = (img: HTMLImageElement) => {
        clearPendingLoad(item.id, item.src)
        void (async () => {
          let resolvedImage: CanvasImageAsset = img
          if (mode === 'source-upgrade') {
            try {
              resolvedImage = await withProjectCanvasWebGLTimeout(
                downscaleSourceTextureForWebGL(img),
                PROJECT_CANVAS_WEBGL_SOURCE_TEXTURE_LOAD_TIMEOUT_MS,
                'Timed out downscaling source texture.'
              )
            } catch {
              resolvedImage = img
            }
          }

          finishSourceUpgrade()
          finishInitialLoad()

          const currentItem = currentItemByIdRef.current.get(item.id)
          if (currentItem && currentItem.src === item.src) {
            failedLoadSrcByIdRef.current.delete(item.id)
            failedSourceUpgradeSrcByIdRef.current.delete(item.id)
            skippedSourceUpgradeSrcByIdRef.current.delete(item.id)
            imageCacheRef.current.set(item.id, { image: resolvedImage, src: item.src })
            scheduleImageVersionUpdate()
          } else if (currentItem) {
            scheduleImageVersionUpdate()
          }
        })()
      }

      const handleImageError = () => {
        clearPendingLoad(item.id, item.src)
        finishInitialLoad()
        finishSourceUpgrade()

        const currentItem = currentItemByIdRef.current.get(item.id)
        if (currentItem && currentItem.src === item.src) {
          if (mode === 'source-upgrade' && item.image) {
            failedSourceUpgradeSrcByIdRef.current.set(item.id, item.src)
          } else {
            failedLoadSrcByIdRef.current.set(item.id, item.src)
          }
          emitItemLoadMetricsSnapshot()
        } else if (currentItem) {
          scheduleImageVersionUpdate()
        }
      }

      const startImageElementLoad = (resolvedSrc: string) => {
        const img = new Image()
        let settled = false
        const timeoutId = window.setTimeout(() => {
          if (settled) {
            return
          }

          settled = true
          imageElementLoadTimeoutsRef.current.delete(timeoutId)
          img.onload = null
          img.onerror = null
          handleImageError()
        }, PROJECT_CANVAS_WEBGL_IMAGE_ELEMENT_LOAD_TIMEOUT_MS)
        imageElementLoadTimeoutsRef.current.add(timeoutId)
        const settleImageElementLoad = (callback: () => void) => {
          if (settled) {
            return
          }

          settled = true
          window.clearTimeout(timeoutId)
          imageElementLoadTimeoutsRef.current.delete(timeoutId)
          img.onload = null
          img.onerror = null
          callback()
        }
        if (shouldUseAnonymousCrossOrigin(item.src)) {
          img.crossOrigin = 'anonymous'
        }
        img.onload = () => settleImageElementLoad(() => handleImageLoad(img))
        img.onerror = () => settleImageElementLoad(handleImageError)
        img.src = resolvedSrc
      }

      if (canReadCanvasLocalImageSource(item.src)) {
        void createCanvasLocalImageObjectUrl(item.src)
          .then((localObjectUrl) => {
            startImageElementLoad(localObjectUrl ?? item.src)
          })
          .catch(() => {
            startImageElementLoad(item.src)
          })
      } else {
        startImageElementLoad(item.src)
      }
    }

    function pumpInitialImageLoadQueue() {
      while (
        activeInitialLoadCountRef.current < PROJECT_CANVAS_WEBGL_INITIAL_IMAGE_LOAD_CONCURRENCY &&
        initialLoadQueueRef.current.length > 0
      ) {
        initialLoadQueueRef.current.sort((left, right) => right.priority - left.priority)
        const queued = initialLoadQueueRef.current.shift()
        if (!queued) {
          return
        }

        const currentItem = currentItemByIdRef.current.get(queued.itemId)
        if (
          !currentItem ||
          currentItem.src !== queued.src ||
          pendingLoadSrcByIdRef.current.get(queued.itemId) !== queued.src
        ) {
          clearPendingLoad(queued.itemId, queued.src)
          continue
        }

        startImageLoadNow(currentItem, 'initial')
      }
    }

    function queueInitialImageLoad(item: CanvasImageItem, priority: number) {
      if (!item.src) {
        return
      }

      const pendingSrc = pendingLoadSrcByIdRef.current.get(item.id)
      if (pendingSrc === item.src) {
        const queued = initialLoadQueueRef.current.find(
          (entry) => entry.itemId === item.id && entry.src === item.src
        )
        if (queued) {
          queued.priority = Math.max(queued.priority, priority)
        }
        return
      }

      pendingLoadsRef.current.add(item.id)
      pendingLoadSrcByIdRef.current.set(item.id, item.src)
      initialLoadQueueRef.current.push({ itemId: item.id, src: item.src, priority })
      pumpInitialImageLoadQueue()
    }

    function pumpSourceUpgradeQueue() {
      if (isSourceUpgradeIdleBlocked()) {
        return
      }

      while (
        activeSourceUpgradeCountRef.current < PROJECT_CANVAS_WEBGL_SOURCE_UPGRADE_CONCURRENCY &&
        sourceUpgradeQueueRef.current.length > 0
      ) {
        const queued = sourceUpgradeQueueRef.current.shift()
        if (!queued) {
          return
        }

        if (activeSourceUpgradeSrcByIdRef.current.get(queued.itemId) === queued.src) {
          continue
        }

        const currentItem = currentItemByIdRef.current.get(queued.itemId)
        const forceSelectedSourceTexture = currentItem
          ? shouldForceSelectedSourceTextureUpgrade(
              currentItem.id,
              selectedIds,
              stageScaleRef.current
            )
          : false
        if (
          !currentItem ||
          currentItem.src !== queued.src ||
          pendingLoadSrcByIdRef.current.get(queued.itemId) !== queued.src ||
          !sourceUpgradeEligibleIdsRef.current.has(queued.itemId) ||
          !currentItem.image ||
          shouldSuppressSourceUpgradeForItem(currentItem, forceSelectedSourceTexture) ||
          !shouldLoadSourceTexture(currentItem, currentItem.image, stageScaleRef.current, {
            force: forceSelectedSourceTexture,
            isVisible: sourceUpgradeEligibleIdsRef.current.has(currentItem.id),
            sourceTextureByteSize: estimateSourceTextureByteSize(currentItem, currentItem.image),
            residentTextureBytes: getResidentTextureBytes(),
            existingTextureBytes:
              spriteRecordsRef.current.get(currentItem.id)?.textureByteSize ?? 0,
            residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES
          })
        ) {
          clearPendingLoad(queued.itemId, queued.src)
          continue
        }

        startImageLoad(currentItem, 'source-upgrade')
      }
    }

    const queueSourceUpgrade = (item: CanvasImageItem, priority: number) => {
      if (!item.src || pendingLoadSrcByIdRef.current.get(item.id) === item.src) {
        return
      }

      pendingLoadsRef.current.add(item.id)
      pendingLoadSrcByIdRef.current.set(item.id, item.src)
      sourceUpgradeQueueRef.current.push({ itemId: item.id, src: item.src, priority })
    }

    const clearPendingThumbnailLoad = (itemId: string, src: string) => {
      if (pendingThumbnailLoadSrcByIdRef.current.get(itemId) === src) {
        pendingThumbnailLoadSrcByIdRef.current.delete(itemId)
      }
    }

    function pumpThumbnailLoadQueue() {
      if (isViewportInteractingRef.current) {
        return
      }

      while (
        activeThumbnailLoadCountRef.current < PROJECT_CANVAS_WEBGL_THUMBNAIL_UPGRADE_CONCURRENCY &&
        thumbnailLoadQueueRef.current.length > 0
      ) {
        thumbnailLoadQueueRef.current.sort((left, right) => right.priority - left.priority)
        const queued = thumbnailLoadQueueRef.current.shift()
        if (!queued) {
          return
        }

        const currentItem = currentItemByIdRef.current.get(queued.itemId)
        if (
          !currentItem ||
          pendingThumbnailLoadSrcByIdRef.current.get(queued.itemId) !== queued.src
        ) {
          clearPendingThumbnailLoad(queued.itemId, queued.src)
          continue
        }

        activeThumbnailLoadCountRef.current += 1
        void loadImageElement(queued.src, {
          crossOrigin: shouldUseAnonymousCrossOrigin(queued.src) ? 'anonymous' : null
        })
          .then((image) => {
            clearPendingThumbnailLoad(queued.itemId, queued.src)
            const nextItem = currentItemByIdRef.current.get(queued.itemId)
            if (nextItem) {
              failedThumbnailLoadSrcByIdRef.current.delete(queued.itemId)
              thumbnailCacheRef.current.set(queued.itemId, {
                image,
                src: queued.src
              })
              scheduleImageVersionUpdate()
            }
          })
          .catch(() => {
            clearPendingThumbnailLoad(queued.itemId, queued.src)
            const nextItem = currentItemByIdRef.current.get(queued.itemId)
            if (nextItem) {
              failedThumbnailLoadSrcByIdRef.current.set(queued.itemId, queued.src)
              scheduleImageVersionUpdate()
            }
          })
          .finally(() => {
            activeThumbnailLoadCountRef.current = Math.max(
              0,
              activeThumbnailLoadCountRef.current - 1
            )
            pumpThumbnailLoadQueue()
          })
      }
    }

    const queueThumbnailLoad = (item: CanvasImageItem, src: string, priority: number) => {
      if (isViewportInteractingRef.current) {
        return false
      }

      if (failedThumbnailLoadSrcByIdRef.current.get(item.id) === src) {
        return false
      }

      const pendingSrc = pendingThumbnailLoadSrcByIdRef.current.get(item.id)
      if (pendingSrc === src) {
        const queued = thumbnailLoadQueueRef.current.find(
          (entry) => entry.itemId === item.id && entry.src === src
        )
        if (queued) {
          queued.priority = Math.max(queued.priority, priority)
        }
        pumpThumbnailLoadQueue()
        return true
      }

      pendingThumbnailLoadSrcByIdRef.current.set(item.id, src)
      thumbnailLoadQueueRef.current.push({ itemId: item.id, src, priority })
      pumpThumbnailLoadQueue()
      return true
    }

    const ensureImage = (item: CanvasImageItem, sourceUpgradePriority: number) => {
      const failedSourceUpgradeSrc = failedSourceUpgradeSrcByIdRef.current.get(item.id)
      const skippedSourceUpgradeSrc = skippedSourceUpgradeSrcByIdRef.current.get(item.id)
      if (failedSourceUpgradeSrc && failedSourceUpgradeSrc !== item.src) {
        failedSourceUpgradeSrcByIdRef.current.delete(item.id)
      }
      if (skippedSourceUpgradeSrc && skippedSourceUpgradeSrc !== item.src) {
        skippedSourceUpgradeSrcByIdRef.current.delete(item.id)
      }
      if (
        item.image &&
        (failedSourceUpgradeSrc === item.src || skippedSourceUpgradeSrc === item.src)
      ) {
        imageCacheRef.current.delete(item.id)
        return item.image
      }

      const cached = imageCacheRef.current.get(item.id)
      let fallbackImage = item.image
      const existingRecord = spriteRecordsRef.current.get(item.id)
      const forceSelectedSourceTexture = shouldForceSelectedSourceTextureUpgrade(
        item.id,
        selectedIds,
        stageScaleRef.current
      )
      const cachedThumbnail = thumbnailCacheRef.current.get(item.id)
      const hasCurrentThumbnailCache =
        cachedThumbnail &&
        isCanvasThumbnailSetFresh(item.thumbnailSet, item.sourceIdentity) &&
        item.thumbnailSet.levels.some((level) => level.src === cachedThumbnail.src)
      const currentThumbnail = hasCurrentThumbnailCache ? cachedThumbnail : null
      if (currentThumbnail) {
        fallbackImage = currentThumbnail.image
      } else if (cachedThumbnail) {
        thumbnailCacheRef.current.delete(item.id)
      }
      const failedThumbnailSrc = failedThumbnailLoadSrcByIdRef.current.get(item.id)
      if (
        failedThumbnailSrc &&
        !item.thumbnailSet?.levels.some((level) => level.src === failedThumbnailSrc)
      ) {
        failedThumbnailLoadSrcByIdRef.current.delete(item.id)
      }
      const thumbnailLevel = resolveCanvasImageThumbnailLodLevel(
        item,
        fallbackImage ?? null,
        stageScaleRef.current,
        {
          currentThumbnailSrc: currentThumbnail?.src ?? null,
          residentCandidateImageCount: residentCandidateImageCountForThumbnailLod
        }
      )
      let thumbnailUpgradeQueued = false
      if (thumbnailLevel?.src) {
        if (currentThumbnail?.src === thumbnailLevel.src) {
          fallbackImage = currentThumbnail.image
        } else if (fallbackImage) {
          thumbnailUpgradeQueued = queueThumbnailLoad(
            item,
            thumbnailLevel.src,
            sourceUpgradePriority
          )
        }
      }
      if (cached && cached.src === item.src) {
        failedLoadSrcByIdRef.current.delete(item.id)
        const cachedSourceDecision = resolveCanvasImageLodDecision({
          item,
          image: fallbackImage ?? null,
          stageScale: stageScaleRef.current,
          forceSource: forceSelectedSourceTexture,
          isVisible: true,
          sourceTextureByteSize: estimateSourceTextureByteSize(item, fallbackImage ?? cached.image),
          residentTextureBytes: getResidentTextureBytes(),
          existingTextureBytes: existingRecord?.textureByteSize ?? 0,
          residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
          deviceScale: getProjectCanvasRenderDeviceScale()
        })
        if (fallbackImage && !cachedSourceDecision.shouldUseSourceTexture) {
          return fallbackImage
        }
        if (!fallbackImage && !cachedSourceDecision.shouldUseSourceTexture) {
          return null
        }
        return cached.image
      }

      const shouldUpgradeToSource =
        fallbackImage &&
        shouldLoadSourceTexture(item, fallbackImage, stageScaleRef.current, {
          force: forceSelectedSourceTexture,
          isVisible: true,
          sourceTextureByteSize: estimateSourceTextureByteSize(item, fallbackImage),
          residentTextureBytes: getResidentTextureBytes(),
          existingTextureBytes: existingRecord?.textureByteSize ?? 0,
          residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES
        })
      if (
        shouldUpgradeToSource &&
        (failedSourceUpgradeSrc === item.src || skippedSourceUpgradeSrc === item.src)
      ) {
        return fallbackImage
      }
      if (fallbackImage && thumbnailUpgradeQueued && !forceSelectedSourceTexture) {
        failedLoadSrcByIdRef.current.delete(item.id)
        return fallbackImage
      }
      if (
        fallbackImage &&
        shouldUpgradeToSource &&
        shouldSuppressSourceUpgradeForItem(item, forceSelectedSourceTexture)
      ) {
        failedLoadSrcByIdRef.current.delete(item.id)
        return fallbackImage
      }
      if (fallbackImage && isViewportInteractingRef.current) {
        failedLoadSrcByIdRef.current.delete(item.id)
        return fallbackImage
      }
      if (fallbackImage && shouldUpgradeToSource) {
        failedLoadSrcByIdRef.current.delete(item.id)
        queueSourceUpgrade(item, sourceUpgradePriority)
        return fallbackImage
      }
      if (fallbackImage) {
        failedLoadSrcByIdRef.current.delete(item.id)
        return fallbackImage
      }

      const failedSrc = failedLoadSrcByIdRef.current.get(item.id)
      if (failedSrc === item.src) {
        return null
      }
      if (failedSrc) {
        failedLoadSrcByIdRef.current.delete(item.id)
      }
      if (isViewportInteractingRef.current) {
        return null
      }

      const initialSourceDecision = resolveCanvasImageLodDecision({
        item,
        image: null,
        stageScale: stageScaleRef.current,
        isVisible: true,
        sourceTextureByteSize: estimateSourceTextureByteSize(item, null),
        residentTextureBytes: getResidentTextureBytes(),
        existingTextureBytes: existingRecord?.textureByteSize ?? 0,
        residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
        deviceScale: getProjectCanvasRenderDeviceScale()
      })
      if (!initialSourceDecision.shouldUseSourceTexture) {
        return null
      }

      if (!item.src || pendingLoadSrcByIdRef.current.get(item.id) === item.src) {
        return null
      }

      startImageLoad(item, 'initial', sourceUpgradePriority)
      return null
    }

    failedLoadSrcByIdRef.current.forEach((_src, itemId) => {
      if (!nextIds.has(itemId)) {
        failedLoadSrcByIdRef.current.delete(itemId)
      }
    })
    failedSourceUpgradeSrcByIdRef.current.forEach((_src, itemId) => {
      if (!nextIds.has(itemId)) {
        failedSourceUpgradeSrcByIdRef.current.delete(itemId)
      }
    })
    skippedSourceUpgradeSrcByIdRef.current.forEach((_src, itemId) => {
      if (!nextIds.has(itemId)) {
        skippedSourceUpgradeSrcByIdRef.current.delete(itemId)
      }
    })
    pendingLoadSrcByIdRef.current.forEach((_src, itemId) => {
      if (!nextIds.has(itemId)) {
        pendingLoadSrcByIdRef.current.delete(itemId)
        pendingLoadsRef.current.delete(itemId)
      }
    })
    pendingThumbnailLoadSrcByIdRef.current.forEach((_src, itemId) => {
      if (!nextIds.has(itemId)) {
        pendingThumbnailLoadSrcByIdRef.current.delete(itemId)
      }
    })
    failedThumbnailLoadSrcByIdRef.current.forEach((_src, itemId) => {
      if (!nextIds.has(itemId)) {
        failedThumbnailLoadSrcByIdRef.current.delete(itemId)
      }
    })
    initialLoadQueueRef.current = initialLoadQueueRef.current.filter((entry) => {
      const shouldKeep =
        nextIds.has(entry.itemId) && pendingLoadSrcByIdRef.current.get(entry.itemId) === entry.src
      if (!shouldKeep) {
        clearPendingLoad(entry.itemId, entry.src)
      }
      return shouldKeep
    })
    sourceUpgradeQueueRef.current = sourceUpgradeQueueRef.current.filter(
      (entry) =>
        nextIds.has(entry.itemId) && pendingLoadSrcByIdRef.current.get(entry.itemId) === entry.src
    )
    thumbnailLoadQueueRef.current = thumbnailLoadQueueRef.current.filter(
      (entry) =>
        nextIds.has(entry.itemId) &&
        pendingThumbnailLoadSrcByIdRef.current.get(entry.itemId) === entry.src
    )
    const currentStageScale = stageScaleRef.current
    const currentStagePos = stagePosRef.current
    const currentStageSize = stageSizeRef.current
    const safeScale = Math.max(Math.abs(currentStageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
    const residentCandidateIds = new Set<string>()
    const selectedCount = selectedIds?.size ?? 0
    const shouldPinSelectedItems =
      selectedCount > 0 && selectedCount <= PROJECT_CANVAS_WEBGL_SELECTED_RESIDENT_LIMIT
    const shouldProtectSelectedItems =
      selectedCount > 0 && selectedCount <= PROJECT_CANVAS_WEBGL_SELECTED_PROTECTED_LIMIT
    const viewportBounds = currentStageSize
      ? getCanvasViewportBounds(currentStagePos, currentStageSize, safeScale)
      : null
    const expandedViewportBounds = viewportBounds
      ? {
          minX: viewportBounds.x - PROJECT_CANVAS_WEBGL_IMAGE_VISIBLE_OVERSCAN_PX / safeScale,
          minY: viewportBounds.y - PROJECT_CANVAS_WEBGL_IMAGE_VISIBLE_OVERSCAN_PX / safeScale,
          maxX:
            viewportBounds.x +
            viewportBounds.width +
            PROJECT_CANVAS_WEBGL_IMAGE_VISIBLE_OVERSCAN_PX / safeScale,
          maxY:
            viewportBounds.y +
            viewportBounds.height +
            PROJECT_CANVAS_WEBGL_IMAGE_VISIBLE_OVERSCAN_PX / safeScale
        }
      : null

    previewStateRef.current.forEach((preview, itemId) => {
      if (
        nextIds.has(itemId) &&
        (!expandedViewportBounds ||
          doCanvasBoundsIntersect(getPreviewVisibilityBounds(preview), expandedViewportBounds))
      ) {
        residentCandidateIds.add(itemId)
      }
    })
    if (shouldPinSelectedItems) {
      selectedIds?.forEach((itemId) => {
        if (nextIds.has(itemId)) {
          residentCandidateIds.add(itemId)
        }
      })
    }
    if (currentStageSize) {
      queryCanvasSpatialIndex(itemSpatialIndex, expandedViewportBounds!).forEach((item) => {
        residentCandidateIds.add(item.id)
      })
    } else {
      items.forEach((item) => residentCandidateIds.add(item.id))
    }
    suppressDenseSourceUpgrades =
      residentCandidateIds.size > PROJECT_CANVAS_WEBGL_DENSE_SOURCE_UPGRADE_CANDIDATE_LIMIT &&
      safeScale < PROJECT_CANVAS_WEBGL_DENSE_SOURCE_UPGRADE_MAX_SCALE
    sourceUpgradeEligibleIdsRef.current = residentCandidateIds
    residentCandidateIdsRef.current = residentCandidateIds
    sourceUpgradeQueueRef.current = sourceUpgradeQueueRef.current.filter((entry) => {
      const item = itemById.get(entry.itemId)
      if (!item) {
        clearPendingLoad(entry.itemId, entry.src)
        return false
      }
      const forceSelectedSourceTexture = shouldForceSelectedSourceTextureUpgrade(
        item.id,
        selectedIds,
        stageScaleRef.current
      )
      const shouldKeep =
        residentCandidateIds.has(entry.itemId) &&
        nextIds.has(entry.itemId) &&
        pendingLoadSrcByIdRef.current.get(entry.itemId) === entry.src &&
        !shouldSuppressSourceUpgradeForItem(item, forceSelectedSourceTexture)
      if (!shouldKeep) {
        clearPendingLoad(entry.itemId, entry.src)
      }
      return shouldKeep
    })

    const viewportCenter = viewportBounds
      ? {
          x: viewportBounds.x + viewportBounds.width / 2,
          y: viewportBounds.y + viewportBounds.height / 2
        }
      : null
    const getSourceUpgradePriority = (item: CanvasImageItem) => {
      const bounds = getCanvasItemBounds(item)
      const itemCenterX = bounds.minX + (bounds.maxX - bounds.minX) / 2
      const itemCenterY = bounds.minY + (bounds.maxY - bounds.minY) / 2
      const distanceFromCenter = viewportCenter
        ? Math.hypot(itemCenterX - viewportCenter.x, itemCenterY - viewportCenter.y)
        : 0
      return (
        (shouldPinSelectedItems && selectedIds?.has(item.id) ? 1_000_000 : 0) - distanceFromCenter
      )
    }
    const compareResidentCandidateItems = (left: CanvasImageItem, right: CanvasImageItem) => {
      const leftSelectedRank = shouldPinSelectedItems && selectedIds?.has(left.id) ? 1 : 0
      const rightSelectedRank = shouldPinSelectedItems && selectedIds?.has(right.id) ? 1 : 0
      if (leftSelectedRank !== rightSelectedRank) {
        return rightSelectedRank - leftSelectedRank
      }

      const leftPreviewRank = previewStateRef.current.has(left.id) ? 1 : 0
      const rightPreviewRank = previewStateRef.current.has(right.id) ? 1 : 0
      if (leftPreviewRank !== rightPreviewRank) {
        return rightPreviewRank - leftPreviewRank
      }

      const leftBounds = getCanvasItemBounds(left)
      const rightBounds = getCanvasItemBounds(right)
      if (leftBounds.minY !== rightBounds.minY) {
        return leftBounds.minY - rightBounds.minY
      }
      if (leftBounds.minX !== rightBounds.minX) {
        return leftBounds.minX - rightBounds.minX
      }

      return left.zIndex - right.zIndex
    }
    sourceUpgradeQueueRef.current = sourceUpgradeQueueRef.current
      .map((entry) => {
        const item = itemById.get(entry.itemId)
        return item ? { ...entry, priority: getSourceUpgradePriority(item) } : entry
      })
      .sort((left, right) => right.priority - left.priority)
    const residentCandidateItems: CanvasImageItem[] = []
    residentCandidateIds.forEach((itemId) => {
      const item = itemById.get(itemId)
      if (item) {
        residentCandidateItems.push(item)
      }
    })
    const orderedItems = residentCandidateItems.sort(compareResidentCandidateItems)
    const residentTargetIds = new Set<string>()
    const addResidentTarget = (itemId: string) => {
      if (
        residentTargetIds.size < PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT &&
        residentCandidateIds.has(itemId) &&
        nextIds.has(itemId)
      ) {
        residentTargetIds.add(itemId)
      }
    }
    previewStateRef.current.forEach((_preview, itemId) => addResidentTarget(itemId))
    if (shouldPinSelectedItems) {
      selectedIds?.forEach((itemId) => addResidentTarget(itemId))
    }
    orderedItems.forEach((item) => addResidentTarget(item.id))
    const residentCandidateImageCount = residentCandidateIds.size
    residentCandidateImageCountForThumbnailLod = residentCandidateImageCount
    const viewportCulledImageCount = Math.max(0, items.length - residentCandidateImageCount)
    const spriteReconcileBatchSize = getProjectCanvasSpriteReconcileBatchSize(safeScale)
    const shouldBatchNewSpriteCreation = residentCandidateImageCount >= spriteReconcileBatchSize * 2
    let newSpriteCreationBudget = shouldBatchNewSpriteCreation
      ? spriteReconcileFrameRef.current === null
        ? spriteReconcileBatchSize
        : 0
      : Number.POSITIVE_INFINITY
    let deferredNewSpriteCount = 0
    let residentCandidateTextureBytes = 0
    const nextRenderItems = new Map<string, ProjectCanvasRenderableImage>()

    for (const [itemId, record] of spriteRecordsRef.current) {
      if (
        nextIds.has(itemId) &&
        residentCandidateIds.has(itemId) &&
        residentTargetIds.has(itemId)
      ) {
        continue
      }

      destroySpriteRecord(itemId, { retainPreview: true })
      if (!nextIds.has(itemId)) {
        imageCacheRef.current.delete(itemId)
        thumbnailCacheRef.current.delete(itemId)
        renderItemsRef.current.delete(itemId)
      }
    }

    orderedItems.forEach((item) => {
      if (!residentCandidateIds.has(item.id) || !residentTargetIds.has(item.id)) {
        return
      }

      const preview = previewStateRef.current.get(item.id)
      if (
        preview &&
        item.x === preview.x &&
        item.y === preview.y &&
        item.width === preview.width &&
        item.height === preview.height &&
        item.scaleX === preview.scaleX &&
        item.scaleY === preview.scaleY &&
        item.rotation === preview.rotation
      ) {
        previewStateRef.current.delete(item.id)
      }

      let image = ensureImage(item, getSourceUpgradePriority(item))
      if (!image) {
        if (!item.image && shouldSuppressIntermediateOverviewRender(safeScale)) {
          destroySpriteRecord(item.id, { retainPreview: false })
          renderItemsRef.current.delete(item.id)
        }
        return
      }

      let renderItem: ProjectCanvasRenderableImage | null = buildProjectCanvasRenderableImage(
        item,
        image
      )
      if (!renderItem) {
        return
      }
      const existingRecord = spriteRecordsRef.current.get(item.id)
      let textureByteSize = getProjectCanvasTextureByteSize(renderItem)
      if (item.image && image !== item.image && !canUploadProjectCanvasTexture(textureByteSize)) {
        failedSourceUpgradeSrcByIdRef.current.set(item.id, item.src)
        imageCacheRef.current.delete(item.id)
        image = item.image
        renderItem = buildProjectCanvasRenderableImage(item, image)
        if (!renderItem) {
          return
        }
        textureByteSize = getProjectCanvasTextureByteSize(renderItem)
      }
      if (!canUploadProjectCanvasTexture(textureByteSize)) {
        if (!item.image) {
          failedLoadSrcByIdRef.current.set(item.id, item.src)
          imageCacheRef.current.delete(item.id)
        }
        if (existingRecord) {
          const previousRenderItem = renderItemsRef.current.get(item.id)
          if (previousRenderItem) {
            nextRenderItems.set(item.id, previousRenderItem)
          }
        }
        return
      }
      residentCandidateTextureBytes += textureByteSize

      const textureKey = getProjectCanvasRenderTextureKey(renderItem)
      const transformState = preview ?? renderItem
      const transformKey = getProjectCanvasRenderTransformKey(transformState)
      const preserveExistingRenderItem = () => {
        const previousRenderItem = renderItemsRef.current.get(item.id)
        if (previousRenderItem) {
          nextRenderItems.set(item.id, previousRenderItem)
        }
      }
      const needsNewSpriteRecord = !existingRecord || existingRecord.textureKey !== textureKey
      if (needsNewSpriteRecord && newSpriteCreationBudget <= 0) {
        if (existingRecord) {
          preserveExistingRenderItem()
        }
        deferredNewSpriteCount += 1
        return
      }

      if (existingRecord && existingRecord.textureKey === textureKey) {
        nextRenderItems.set(item.id, renderItem)
        existingRecord.sprite.zIndex = item.zIndex
        if (existingRecord.transformKey !== transformKey) {
          applySpriteTransform(
            existingRecord.sprite,
            {
              textureWidth: existingRecord.textureWidth,
              textureHeight: existingRecord.textureHeight
            },
            transformState
          )
          existingRecord.transformKey = transformKey
        }
        markSpriteRecordUsed(existingRecord)
        return
      }

      const protectedResidentIds = new Set<string>()
      previewStateRef.current.forEach((_preview, previewItemId) => {
        if (residentCandidateIds.has(previewItemId)) {
          protectedResidentIds.add(previewItemId)
        }
      })
      if (shouldProtectSelectedItems) {
        selectedIds?.forEach((selectedId) => {
          if (residentCandidateIds.has(selectedId)) {
            protectedResidentIds.add(selectedId)
          }
        })
      }
      protectedResidentIds.add(item.id)

      const currentResidentTextureBytes = () =>
        Math.max(0, getResidentTextureBytes() - (existingRecord?.textureByteSize ?? 0))

      while (
        spriteRecordsRef.current.size - (existingRecord ? 1 : 0) >=
          PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT ||
        (spriteRecordsRef.current.size > 0 &&
          currentResidentTextureBytes() + textureByteSize >
            PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES)
      ) {
        const evictedItemId = evictOldestResidentSprite(protectedResidentIds)
        if (!evictedItemId) {
          break
        }
      }

      const residentTextureBytes = currentResidentTextureBytes()
      const wouldExceedResidentLimit =
        spriteRecordsRef.current.size - (existingRecord ? 1 : 0) >=
        PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT
      const wouldExceedTextureBudget =
        spriteRecordsRef.current.size - (existingRecord ? 1 : 0) > 0 &&
        residentTextureBytes + textureByteSize > PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES

      if (wouldExceedResidentLimit || wouldExceedTextureBudget) {
        if (existingRecord) {
          preserveExistingRenderItem()
        }
        return
      }

      let baseTexture: Texture | null = null
      let texture: Texture | null = null
      try {
        baseTexture = Texture.from(image, true)
        if (!baseTexture) {
          throw new Error('Pixi returned an empty texture.')
        }
        ;(baseTexture.source as { scaleMode?: 'nearest' | 'linear' }).scaleMode =
          getProjectCanvasTextureScaleMode()
        texture =
          renderItem.crop && renderItem.crop.width > 0 && renderItem.crop.height > 0
            ? new Texture({
                source: baseTexture.source,
                frame: new Rectangle(
                  renderItem.crop.x,
                  renderItem.crop.y,
                  renderItem.crop.width,
                  renderItem.crop.height
                )
              })
            : baseTexture

        const sprite = new Sprite(texture)
        const textureWidth = Math.max(1, texture.width)
        const textureHeight = Math.max(1, texture.height)
        sprite.label = item.id
        applySpriteTransform(sprite, { textureWidth, textureHeight }, transformState)
        sprite.zIndex = renderItem.zIndex
        if (existingRecord) {
          destroySpriteRecord(item.id, { retainPreview: true })
        }
        spriteRecordsRef.current.set(item.id, {
          sprite,
          texture,
          sourceTexture: baseTexture,
          textureKey,
          transformKey,
          textureWidth,
          textureHeight,
          textureByteSize,
          lastUsedAt: 0
        })
        if (shouldBatchNewSpriteCreation) {
          newSpriteCreationBudget -= 1
        }
        markSpriteRecordUsed(spriteRecordsRef.current.get(item.id)!)
        world.addChild(sprite)
        nextRenderItems.set(item.id, renderItem)
      } catch (error) {
        if (item.image && image !== item.image) {
          failedSourceUpgradeSrcByIdRef.current.set(item.id, item.src)
          if (!existingRecord) {
            deferredNewSpriteCount += 1
          }
        } else if (!existingRecord) {
          failedLoadSrcByIdRef.current.set(item.id, item.src)
        }
        imageCacheRef.current.delete(item.id)
        if (existingRecord) {
          preserveExistingRenderItem()
        }
        if (texture && texture !== baseTexture) {
          texture.destroy(false)
        }
        baseTexture?.destroy(true)
        console.warn(
          '[Canvas WebGL] Failed to create image texture, skipping item:',
          item.id,
          error
        )
      }
    })

    sourceUpgradeQueueRef.current.sort((left, right) => right.priority - left.priority)
    pumpSourceUpgradeQueue()
    world.sortChildren()
    renderItemsRef.current = nextRenderItems
    const imageHealthCounts = collectImageHealthCounts(residentCandidateIds)
    const isSpriteReconcileDeferred = deferredNewSpriteCount > 0
    const shouldHideIntermediateOverviewRender =
      isSpriteReconcileDeferred && shouldSuppressIntermediateOverviewRender(safeScale)
    emitItemLoadMetricsSnapshot(
      {
        imageCount: items.length,
        residentCandidateImageCount,
        residentCandidateTextureBytes,
        viewportCulledImageCount,
        ...imageHealthCounts
      },
      'items',
      {
        emitIdSets: !isSpriteReconcileDeferred,
        emitMetrics: !isSpriteReconcileDeferred,
        immediateMetrics: !isSpriteReconcileDeferred
      }
    )
    if (shouldHideIntermediateOverviewRender) {
      cancelScheduledRender()
    } else {
      scheduleRender()
    }
    if (deferredNewSpriteCount > 0 && spriteReconcileFrameRef.current === null) {
      spriteReconcileFrameRef.current = window.requestAnimationFrame(() => {
        spriteReconcileFrameRef.current = null
        if (!isViewportInteractingRef.current) {
          setViewportVersion((version) => version + 1)
        }
      })
    }
  }, [
    destroySpriteRecord,
    collectImageHealthCounts,
    emitItemLoadMetricsSnapshot,
    evictOldestResidentSprite,
    imageVersion,
    isInitialized,
    itemSpatialIndex,
    items,
    markSpriteRecordUsed,
    cancelScheduledRender,
    scheduleRender,
    scheduleImageVersionUpdate,
    getResidentTextureBytes,
    selectedIds,
    viewportVersion
  ])

  return (
    <Box
      className="project-canvas-webgl-layer"
      ref={hostRef}
      data-canvas-render-surface="webgl-image"
      data-canvas-render-role="raster-image-layer"
      data-canvas-webgl-ready={String(isInitialized)}
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none'
      }}
    />
  )
})

function areProjectCanvasWebGLImageLayerPropsEqual(
  previousProps: Readonly<ProjectCanvasWebGLImageLayerProps>,
  nextProps: Readonly<ProjectCanvasWebGLImageLayerProps>
) {
  if (!areProjectCanvasSelectedIdSetsEqual(previousProps.selectedIds, nextProps.selectedIds)) {
    return false
  }

  if (previousProps.isViewportInteracting !== nextProps.isViewportInteracting) {
    return false
  }

  if (previousProps.stageScale !== nextProps.stageScale) {
    return false
  }

  if (
    previousProps.stagePos.x !== nextProps.stagePos.x ||
    previousProps.stagePos.y !== nextProps.stagePos.y
  ) {
    return false
  }

  if (
    previousProps.stageSize?.width !== nextProps.stageSize?.width ||
    previousProps.stageSize?.height !== nextProps.stageSize?.height
  ) {
    return false
  }

  if (
    previousProps.onReadyChange !== nextProps.onReadyChange ||
    previousProps.onResidentIdsChange !== nextProps.onResidentIdsChange ||
    previousProps.onResolvedIdsChange !== nextProps.onResolvedIdsChange ||
    previousProps.onFailedIdsChange !== nextProps.onFailedIdsChange ||
    previousProps.onMetricsChange !== nextProps.onMetricsChange
  ) {
    return false
  }

  if (previousProps.items === nextProps.items) {
    return true
  }

  if (previousProps.items.length !== nextProps.items.length) {
    return false
  }

  for (let index = 0; index < previousProps.items.length; index += 1) {
    if (previousProps.items[index] !== nextProps.items[index]) {
      return false
    }
  }

  return true
}

function areProjectCanvasSelectedIdSetsEqual(
  previousIds: ReadonlySet<string> | undefined,
  nextIds: ReadonlySet<string> | undefined
) {
  if (previousIds === nextIds) {
    return true
  }

  const previousSize = previousIds?.size ?? 0
  const nextSize = nextIds?.size ?? 0
  if (previousSize !== nextSize) {
    return false
  }
  if (previousSize === 0) {
    return true
  }
  if (!previousIds || !nextIds) {
    return false
  }

  for (const id of previousIds) {
    if (!nextIds.has(id)) {
      return false
    }
  }

  return true
}

export default memo(ProjectCanvasWebGLImageLayer, areProjectCanvasWebGLImageLayerPropsEqual)
