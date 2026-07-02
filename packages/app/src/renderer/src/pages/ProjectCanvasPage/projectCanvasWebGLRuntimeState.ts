import type { CanvasThumbnailRuntimeMetrics } from './canvasThumbnailTypes'

export type ProjectCanvasWebGLRuntimeMetrics = {
  isInitialized: boolean
  imageCount: number
  loadedImageCount: number
  failedImageCount: number
  residentImageCount: number
  residentTextureBytes: number
  residentCandidateTextureBytes: number
  residentTextureBudgetBytes: number
  pendingImageCount: number
  spriteCount: number
  residentCandidateImageCount: number
  viewportCulledImageCount: number
  usingPreviewImageCount: number
  usingSourceImageCount: number
  thumbnailPreviewImageCount: number
  placeholderImageCount: number
  sourceUpgradeSuppressedImageCount: number
  sourceUpgradeablePreviewImageCount: number
  sourceUpgradePendingImageCount: number
  sourceUpgradeFailedImageCount: number
  missingImageCount: number
  activeObjectUrlCount: number
  revokedObjectUrlCount: number
  activeImageBitmapCount: number
  closedImageBitmapCount: number
  releaseErrorCount: number
  decodedInFlightBytes: number
  activeSourceUpgradeCount: number
  residentTextureBudgetPressureCount: number
  textureBudgetEvictionCount: number
  sourceImageCacheCount: number
  thumbnailImageCacheCount: number
  sourceUpgradeQueueCount: number
  thumbnailLoadQueueCount: number
  initialLoadQueueCount: number
  renderCount: number
  lastRenderDurationMs: number | null
  lastUpdateReason: 'initialize' | 'items' | 'preview' | 'cleanup'
}

export type ProjectCanvasMetricsSnapshot = {
  version: 1
  viewport: {
    scale: number
    x: number
    y: number
  }
  reactCommits: number
  totalItemCount: number
  totalImageItemCount: number
  visibleItemCount: number
  visibleImageItemCount: number
  renderSurface: Record<string, number>
  fallbackImages: Record<string, number>
  thumbnailCache: ProjectCanvasThumbnailCacheMetrics
  webgl: ProjectCanvasWebGLRuntimeMetrics & {
    residentLimit: number
    residentRemainingCapacity: number
    residentTextureRemainingBytes: number
    residentBudgetState: string
  }
}

export type ProjectCanvasThumbnailCacheMetrics = CanvasThumbnailRuntimeMetrics & {
  cacheGeneratedCount: number
  cacheSidecarGeneratedCount: number
  cacheNativeGeneratedCount: number
  cacheStaleCount: number
  cacheFailedCount: number
}

const fallbackThumbnailCacheMetrics: ProjectCanvasThumbnailCacheMetrics = {
  thumbnailCount: 0,
  cacheHitCount: 0,
  generatedCount: 0,
  sidecarGeneratedCount: 0,
  nativeGeneratedCount: 0,
  staleCount: 0,
  failedCount: 0,
  cacheGeneratedCount: 0,
  cacheSidecarGeneratedCount: 0,
  cacheNativeGeneratedCount: 0,
  cacheStaleCount: 0,
  cacheFailedCount: 0
}

const fallbackWebGLMetrics: ProjectCanvasWebGLRuntimeMetrics = {
  isInitialized: false,
  imageCount: 0,
  loadedImageCount: 0,
  failedImageCount: 0,
  residentImageCount: 0,
  residentTextureBytes: 0,
  residentCandidateTextureBytes: 0,
  residentTextureBudgetBytes: 0,
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
  activeObjectUrlCount: 0,
  revokedObjectUrlCount: 0,
  activeImageBitmapCount: 0,
  closedImageBitmapCount: 0,
  releaseErrorCount: 0,
  decodedInFlightBytes: 0,
  activeSourceUpgradeCount: 0,
  residentTextureBudgetPressureCount: 0,
  textureBudgetEvictionCount: 0,
  sourceImageCacheCount: 0,
  thumbnailImageCacheCount: 0,
  sourceUpgradeQueueCount: 0,
  thumbnailLoadQueueCount: 0,
  initialLoadQueueCount: 0,
  renderCount: 0,
  lastRenderDurationMs: null,
  lastUpdateReason: 'cleanup'
}

const PROJECT_CANVAS_WEBGL_RUNTIME_METRIC_KEYS = [
  'isInitialized',
  'imageCount',
  'loadedImageCount',
  'failedImageCount',
  'residentImageCount',
  'residentTextureBytes',
  'residentCandidateTextureBytes',
  'residentTextureBudgetBytes',
  'pendingImageCount',
  'spriteCount',
  'residentCandidateImageCount',
  'viewportCulledImageCount',
  'usingPreviewImageCount',
  'usingSourceImageCount',
  'thumbnailPreviewImageCount',
  'placeholderImageCount',
  'sourceUpgradeSuppressedImageCount',
  'sourceUpgradeablePreviewImageCount',
  'sourceUpgradePendingImageCount',
  'sourceUpgradeFailedImageCount',
  'missingImageCount',
  'activeObjectUrlCount',
  'revokedObjectUrlCount',
  'activeImageBitmapCount',
  'closedImageBitmapCount',
  'releaseErrorCount',
  'decodedInFlightBytes',
  'activeSourceUpgradeCount',
  'residentTextureBudgetPressureCount',
  'textureBudgetEvictionCount',
  'sourceImageCacheCount',
  'thumbnailImageCacheCount',
  'sourceUpgradeQueueCount',
  'thumbnailLoadQueueCount',
  'initialLoadQueueCount',
  'renderCount',
  'lastRenderDurationMs',
  'lastUpdateReason'
] as const satisfies readonly (keyof ProjectCanvasWebGLRuntimeMetrics)[]

type AssertNever<T extends never> = T
type _ProjectCanvasWebGLRuntimeMetricKeysAreExhaustive = AssertNever<
  Exclude<
    keyof ProjectCanvasWebGLRuntimeMetrics,
    (typeof PROJECT_CANVAS_WEBGL_RUNTIME_METRIC_KEYS)[number]
  >
>

export type ProjectCanvasWebGLPendingRuntimeIdKey = 'residentIds' | 'resolvedIds' | 'failedIds'

export type ProjectCanvasWebGLPendingRuntimeState<TMetrics> = {
  residentIds: ReadonlySet<string> | null
  resolvedIds: ReadonlySet<string> | null
  failedIds: ReadonlySet<string> | null
  metrics: TMetrics | null
}

export function createProjectCanvasWebGLPendingRuntimeState<
  TMetrics
>(): ProjectCanvasWebGLPendingRuntimeState<TMetrics> {
  return {
    residentIds: null,
    resolvedIds: null,
    failedIds: null,
    metrics: null
  }
}

export function areProjectCanvasSetsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>) {
  if (left === right) {
    return true
  }

  if (left.size !== right.size) {
    return false
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false
    }
  }

  return true
}

export function areProjectCanvasWebGLRuntimeMetricsEqual(
  left: ProjectCanvasWebGLRuntimeMetrics | null,
  right: ProjectCanvasWebGLRuntimeMetrics
) {
  return (
    left !== null &&
    PROJECT_CANVAS_WEBGL_RUNTIME_METRIC_KEYS.every((key) => left[key] === right[key])
  )
}

const PROJECT_CANVAS_WEBGL_REACT_STATE_IGNORED_METRIC_KEYS = new Set<
  keyof ProjectCanvasWebGLRuntimeMetrics
>([
  'renderCount',
  'lastRenderDurationMs',
  'lastUpdateReason',
  'activeObjectUrlCount',
  'revokedObjectUrlCount',
  'activeImageBitmapCount',
  'closedImageBitmapCount',
  'releaseErrorCount',
  'decodedInFlightBytes',
  'activeSourceUpgradeCount',
  'residentTextureBudgetPressureCount',
  'textureBudgetEvictionCount',
  'sourceImageCacheCount',
  'thumbnailImageCacheCount',
  'sourceUpgradeQueueCount',
  'thumbnailLoadQueueCount',
  'initialLoadQueueCount'
])

export function areProjectCanvasWebGLRuntimeMetricsEqualForReactState(
  left: ProjectCanvasWebGLRuntimeMetrics | null,
  right: ProjectCanvasWebGLRuntimeMetrics
) {
  return (
    left !== null &&
    PROJECT_CANVAS_WEBGL_RUNTIME_METRIC_KEYS.every(
      (key) =>
        PROJECT_CANVAS_WEBGL_REACT_STATE_IGNORED_METRIC_KEYS.has(key) || left[key] === right[key]
    )
  )
}

export function buildProjectCanvasMetricsSnapshot({
  stageScale,
  stagePos,
  reactCommits,
  totalItemCount,
  totalImageItemCount,
  visibleItemCount,
  visibleImageItemCount,
  renderSurface,
  fallbackImages,
  thumbnailCacheMetrics,
  webglMetrics,
  residentLimit,
  residentRemainingCapacity,
  residentTextureRemainingBytes,
  residentBudgetState
}: {
  stageScale: number
  stagePos: { x: number; y: number }
  reactCommits: number
  totalItemCount: number
  totalImageItemCount: number
  visibleItemCount: number
  visibleImageItemCount: number
  renderSurface: Record<string, number>
  fallbackImages: Record<string, number>
  thumbnailCacheMetrics?: CanvasThumbnailRuntimeMetrics | null
  webglMetrics: ProjectCanvasWebGLRuntimeMetrics | null
  residentLimit: number
  residentRemainingCapacity: number
  residentTextureRemainingBytes: number
  residentBudgetState: string
}): ProjectCanvasMetricsSnapshot {
  const metrics = webglMetrics ?? fallbackWebGLMetrics
  const thumbnailMetrics = thumbnailCacheMetrics
    ? {
        ...thumbnailCacheMetrics,
        cacheGeneratedCount: thumbnailCacheMetrics.generatedCount,
        cacheSidecarGeneratedCount: thumbnailCacheMetrics.sidecarGeneratedCount,
        cacheNativeGeneratedCount: thumbnailCacheMetrics.nativeGeneratedCount,
        cacheStaleCount: thumbnailCacheMetrics.staleCount,
        cacheFailedCount: thumbnailCacheMetrics.failedCount
      }
    : fallbackThumbnailCacheMetrics

  return {
    version: 1,
    viewport: {
      scale: stageScale,
      x: stagePos.x,
      y: stagePos.y
    },
    reactCommits,
    totalItemCount,
    totalImageItemCount,
    visibleItemCount,
    visibleImageItemCount,
    renderSurface,
    fallbackImages,
    thumbnailCache: thumbnailMetrics,
    webgl: {
      ...metrics,
      residentLimit,
      residentRemainingCapacity,
      residentTextureRemainingBytes,
      residentBudgetState
    }
  }
}

export function parseProjectCanvasMetricsSnapshot(value?: string | null) {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as ProjectCanvasMetricsSnapshot
    return parsed && parsed.version === 1 ? parsed : null
  } catch {
    return null
  }
}

export function queueProjectCanvasWebGLPendingRuntimeIds<TMetrics>(
  state: ProjectCanvasWebGLPendingRuntimeState<TMetrics>,
  key: ProjectCanvasWebGLPendingRuntimeIdKey,
  ids: ReadonlySet<string>
): ProjectCanvasWebGLPendingRuntimeState<TMetrics> {
  return {
    ...state,
    [key]: new Set(ids)
  }
}

export function queueProjectCanvasWebGLPendingRuntimeMetrics<TMetrics>(
  state: ProjectCanvasWebGLPendingRuntimeState<TMetrics>,
  metrics: TMetrics
): ProjectCanvasWebGLPendingRuntimeState<TMetrics> {
  return {
    ...state,
    metrics
  }
}

export function takeProjectCanvasWebGLPendingRuntimeState<TMetrics>(
  state: ProjectCanvasWebGLPendingRuntimeState<TMetrics>
): {
  pending: ProjectCanvasWebGLPendingRuntimeState<TMetrics>
  next: ProjectCanvasWebGLPendingRuntimeState<TMetrics>
} {
  return {
    pending: state,
    next: createProjectCanvasWebGLPendingRuntimeState()
  }
}
