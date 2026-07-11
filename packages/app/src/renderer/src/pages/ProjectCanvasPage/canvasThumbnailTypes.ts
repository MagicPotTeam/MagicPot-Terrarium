import type {
  CanvasThumbnailGenerateSetResp,
  CanvasThumbnailManifest
} from '@shared/api/svcCanvasThumbnail'

export const CANVAS_THUMBNAIL_LEVELS = [128, 256, 512, 1024, 2048] as const
export type CanvasThumbnailLevelSize = (typeof CANVAS_THUMBNAIL_LEVELS)[number]

export type CanvasImageSourceIdentity = {
  kind: 'local-file'
  canonicalPath: string
  sizeBytes: number
  lastModifiedMs: number
  cacheKey: string
  cacheRootDir?: string
}

export type CanvasImageThumbnailLevel = {
  maxSide: CanvasThumbnailLevelSize
  src: string
  filename: string
  mimeType: 'image/webp' | 'image/png'
  width: number
  height: number
  sizeBytes: number
}

export type CanvasThumbnailMimeType = CanvasImageThumbnailLevel['mimeType']

export type CanvasThumbnailFormat = 'webp' | 'png'

export type CanvasImageThumbnailSet = {
  version: 1
  cacheKey: string
  sourceIdentity: CanvasImageSourceIdentity
  levels: CanvasImageThumbnailLevel[]
  createdAt: string
  updatedAt: string
}

export type CanvasThumbnailEnsureStatus =
  | 'cache-hit'
  | 'cache-miss'
  | 'cache-stale'
  | 'generated'
  | 'sidecar-generated'
  | 'native-generated'
  | 'failed'

export type CanvasThumbnailEnsureResult = {
  thumbnailSet: CanvasImageThumbnailSet | null
  status: CanvasThumbnailEnsureStatus
}

export type CanvasThumbnailRuntimeMetrics = {
  thumbnailCount: number
  cacheHitCount: number
  generatedCount: number
  sidecarGeneratedCount: number
  nativeGeneratedCount: number
  staleCount: number
  failedCount: number
  workerPoolWorkerCount?: number
  workerPoolIdleWorkerCount?: number
  workerPoolActiveRequestCount?: number
  workerPoolQueuedRequestCount?: number
  workerPoolInFlightKeyCount?: number
  workerPoolDedupedRequestCount?: number
  workerPoolRejectedRequestCount?: number
  workerPoolTimedOutRequestCount?: number
  workerPoolFailedWorkerCount?: number
  workerPoolCompletedRequestCount?: number
  workerPoolMaxWorkers?: number
  workerPoolMaxQueueSize?: number
}

export const CANVAS_THUMBNAIL_RUNTIME_COUNTER_KEYS = [
  'thumbnailCount',
  'cacheHitCount',
  'generatedCount',
  'sidecarGeneratedCount',
  'nativeGeneratedCount',
  'staleCount',
  'failedCount'
] as const satisfies readonly (keyof CanvasThumbnailRuntimeMetrics)[]

export const CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_MAPPINGS = [
  ['workerPoolWorkerCount', 'workerCount'],
  ['workerPoolIdleWorkerCount', 'idleWorkerCount'],
  ['workerPoolActiveRequestCount', 'activeRequestCount'],
  ['workerPoolQueuedRequestCount', 'queuedRequestCount'],
  ['workerPoolInFlightKeyCount', 'inFlightKeyCount'],
  ['workerPoolDedupedRequestCount', 'dedupedRequestCount'],
  ['workerPoolRejectedRequestCount', 'rejectedRequestCount'],
  ['workerPoolTimedOutRequestCount', 'timedOutRequestCount'],
  ['workerPoolFailedWorkerCount', 'failedWorkerCount'],
  ['workerPoolCompletedRequestCount', 'completedRequestCount'],
  ['workerPoolMaxWorkers', 'maxWorkers'],
  ['workerPoolMaxQueueSize', 'maxQueueSize']
] as const

export const CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_KEYS =
  CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_MAPPINGS.map(([runtimeMetricKey]) => runtimeMetricKey)

export const CANVAS_THUMBNAIL_RUNTIME_METRIC_KEYS = [
  ...CANVAS_THUMBNAIL_RUNTIME_COUNTER_KEYS,
  ...CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_KEYS
] as const satisfies readonly (keyof CanvasThumbnailRuntimeMetrics)[]

export type CanvasThumbnailManifestLike = CanvasThumbnailManifest

export type CanvasGeneratedThumbnailLevel = {
  maxSide: CanvasThumbnailLevelSize
  width: number
  height: number
  mimeType: CanvasThumbnailMimeType
  format: CanvasThumbnailFormat
  filename: string
  src: string
  sizeBytes: number
  blob: Blob
}

export type CanvasThumbnailNativeResult = {
  data: ArrayBuffer | Uint8Array | number[]
  width: number
  height: number
  mimeType?: string
}

export type CanvasThumbnailCacheWriteFile = {
  filename: string
  data: Uint8Array
}

export type CanvasThumbnailReadManifestResponse =
  | { manifest: CanvasThumbnailManifestLike | null }
  | CanvasThumbnailManifestLike
  | null

export type CanvasThumbnailWriteSetResponse =
  | { manifest: CanvasThumbnailManifestLike }
  | CanvasThumbnailManifestLike
  | null

export type CanvasThumbnailIpcBridge = {
  readThumbnailManifest?: (input: {
    cacheKey: string
    cacheRootDir?: string
  }) => Promise<CanvasThumbnailReadManifestResponse>
  writeThumbnailSet?: (input: {
    cacheKey: string
    cacheRootDir?: string
    manifest: CanvasThumbnailManifestLike
    files: CanvasThumbnailCacheWriteFile[]
  }) => Promise<CanvasThumbnailWriteSetResponse>
  generateThumbnailSet?: (input: {
    fullPath: string
    cacheRootDir?: string
    levels?: number[]
    format?: 'image/png' | 'image/webp'
  }) => Promise<CanvasThumbnailGenerateSetResp | null>
  createNativeThumbnail?: (input: {
    fullPath: string
    maxSide: CanvasThumbnailLevelSize
  }) => Promise<CanvasThumbnailNativeResult | null>
}

export type CanvasThumbnailGenerationRequest = {
  source: Blob
  identity: CanvasImageSourceIdentity
  levels?: readonly CanvasThumbnailLevelSize[]
  preferWebp?: boolean
}

export type CanvasThumbnailWorkerGenerateMessage = {
  type: 'generate'
  requestId: string
  source: Blob
  levels: readonly CanvasThumbnailLevelSize[]
  preferWebp: boolean
}

export type CanvasThumbnailWorkerGeneratedLevel = {
  maxSide: CanvasThumbnailLevelSize
  width: number
  height: number
  mimeType: CanvasThumbnailMimeType
  format: CanvasThumbnailFormat
  blob: Blob
}

export type CanvasThumbnailWorkerSuccessMessage = {
  type: 'success'
  requestId: string
  levels: CanvasThumbnailWorkerGeneratedLevel[]
}

export type CanvasThumbnailWorkerErrorMessage = {
  type: 'error'
  requestId: string
  error: string
}

export type CanvasThumbnailWorkerMessage =
  | CanvasThumbnailWorkerSuccessMessage
  | CanvasThumbnailWorkerErrorMessage
