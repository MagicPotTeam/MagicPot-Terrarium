import {
  CANVAS_THUMBNAIL_LEVELS,
  type CanvasGeneratedThumbnailLevel,
  type CanvasImageSourceIdentity,
  type CanvasImageThumbnailLevel,
  type CanvasImageThumbnailSet,
  type CanvasThumbnailCacheWriteFile,
  type CanvasThumbnailEnsureResult,
  type CanvasThumbnailEnsureStatus,
  type CanvasThumbnailGenerationRequest,
  type CanvasThumbnailIpcBridge,
  type CanvasThumbnailLevelSize,
  type CanvasThumbnailManifestLike,
  type CanvasThumbnailNativeResult,
  type CanvasThumbnailRuntimeMetrics,
  type CanvasThumbnailWorkerGenerateMessage,
  type CanvasThumbnailWorkerMessage
} from './canvasThumbnailTypes'
import {
  canvasThumbnailManifestFromSet,
  canvasThumbnailSetFromManifest,
  createCanvasThumbnailSet
} from './canvasThumbnailCache'
import { generateCanvasThumbnailLevelsInScope } from './canvasThumbnailGeneration.worker'

const WORKER_REQUEST_TIMEOUT_MS = 30_000

const canvasThumbnailRuntimeMetrics: CanvasThumbnailRuntimeMetrics = {
  thumbnailCount: 0,
  cacheHitCount: 0,
  generatedCount: 0,
  nativeGeneratedCount: 0,
  staleCount: 0,
  failedCount: 0
}

type WarmCanvasThumbnailReadResult = {
  status: Extract<CanvasThumbnailEnsureStatus, 'cache-hit' | 'cache-miss' | 'cache-stale'>
  thumbnailSet: CanvasImageThumbnailSet | null
  manifest: CanvasThumbnailManifestLike | null
}

function getCanvasThumbnailIpcBridge(): CanvasThumbnailIpcBridge | null {
  const api = (typeof window !== 'undefined' ? window.api : undefined) as
    | { svcCanvasThumbnail?: CanvasThumbnailIpcBridge }
    | undefined
  return api?.svcCanvasThumbnail ?? null
}

function recordCanvasThumbnailRuntimeStatus(
  status: CanvasThumbnailEnsureStatus,
  thumbnailResolved: boolean
): void {
  if (thumbnailResolved) {
    canvasThumbnailRuntimeMetrics.thumbnailCount += 1
  }

  switch (status) {
    case 'cache-hit':
      canvasThumbnailRuntimeMetrics.cacheHitCount += 1
      break
    case 'generated':
      canvasThumbnailRuntimeMetrics.generatedCount += 1
      break
    case 'native-generated':
      canvasThumbnailRuntimeMetrics.nativeGeneratedCount += 1
      break
    case 'cache-stale':
      canvasThumbnailRuntimeMetrics.staleCount += 1
      break
    case 'failed':
      canvasThumbnailRuntimeMetrics.failedCount += 1
      break
    case 'cache-miss':
      break
  }
}

export function getCanvasThumbnailRuntimeMetrics(): CanvasThumbnailRuntimeMetrics {
  return { ...canvasThumbnailRuntimeMetrics }
}

export function resetCanvasThumbnailRuntimeMetrics(): void {
  canvasThumbnailRuntimeMetrics.thumbnailCount = 0
  canvasThumbnailRuntimeMetrics.cacheHitCount = 0
  canvasThumbnailRuntimeMetrics.generatedCount = 0
  canvasThumbnailRuntimeMetrics.nativeGeneratedCount = 0
  canvasThumbnailRuntimeMetrics.staleCount = 0
  canvasThumbnailRuntimeMetrics.failedCount = 0
}

function createObjectUrl(blob: Blob): string {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(blob)
  }
  return ''
}

function revokeObjectUrl(src: string): void {
  if (
    src.startsWith('blob:') &&
    typeof URL !== 'undefined' &&
    typeof URL.revokeObjectURL === 'function'
  ) {
    URL.revokeObjectURL(src)
  }
}

function getLevelFilename(level: CanvasThumbnailLevelSize, mimeType: string): string {
  return `${level}.${mimeType === 'image/webp' ? 'webp' : 'png'}`
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const buffer =
    typeof blob.arrayBuffer === 'function'
      ? await blob.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) {
              resolve(reader.result)
              return
            }
            reject(new Error('Failed to read thumbnail blob.'))
          }
          reader.onerror = () => reject(new Error('Failed to read thumbnail blob.'))
          reader.readAsArrayBuffer(blob)
        })

  return new Uint8Array(buffer)
}

function uint8ArrayFromNativeData(data: CanvasThumbnailNativeResult['data']): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  }

  return new Uint8Array(data)
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function normalizeLevelList(
  levels?: readonly CanvasThumbnailLevelSize[]
): readonly CanvasThumbnailLevelSize[] {
  if (!levels?.length) {
    return CANVAS_THUMBNAIL_LEVELS
  }

  const requested = new Set(levels)
  return CANVAS_THUMBNAIL_LEVELS.filter((level) => requested.has(level))
}

function createWorker(): Worker | null {
  if (typeof Worker !== 'function') {
    return null
  }

  try {
    return new Worker(new URL('./canvasThumbnailGeneration.worker.ts', import.meta.url), {
      type: 'module'
    })
  } catch {
    return null
  }
}

async function generateLevelsWithWorker(
  request: CanvasThumbnailGenerationRequest
): Promise<CanvasGeneratedThumbnailLevel[] | null> {
  const worker = createWorker()
  if (!worker) {
    return null
  }

  const requestId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`
  const levels = normalizeLevelList(request.levels)

  try {
    return await new Promise<CanvasGeneratedThumbnailLevel[]>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup()
        reject(new Error('Thumbnail worker timed out.'))
      }, WORKER_REQUEST_TIMEOUT_MS)

      const cleanup = () => {
        window.clearTimeout(timeout)
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
      }

      const onError = () => {
        cleanup()
        reject(new Error('Thumbnail worker failed.'))
      }

      const onMessage = (event: MessageEvent<CanvasThumbnailWorkerMessage>) => {
        const message = event.data
        if (!message || message.requestId !== requestId) {
          return
        }

        cleanup()
        if (message.type === 'error') {
          reject(new Error(message.error))
          return
        }

        resolve(
          message.levels.map((level) => ({
            ...level,
            filename: getLevelFilename(level.maxSide, level.mimeType),
            src: createObjectUrl(level.blob),
            sizeBytes: level.blob.size
          }))
        )
      }

      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      const message: CanvasThumbnailWorkerGenerateMessage = {
        type: 'generate',
        requestId,
        source: request.source,
        levels,
        preferWebp: request.preferWebp ?? true
      }
      worker.postMessage(message)
    })
  } finally {
    worker.terminate()
  }
}

async function generateLevelsInRenderer(
  request: CanvasThumbnailGenerationRequest
): Promise<CanvasGeneratedThumbnailLevel[]> {
  const levels = await generateCanvasThumbnailLevelsInScope({
    source: request.source,
    levels: normalizeLevelList(request.levels),
    preferWebp: request.preferWebp ?? true
  })

  return levels.map((level) => ({
    ...level,
    filename: getLevelFilename(level.maxSide, level.mimeType),
    src: createObjectUrl(level.blob),
    sizeBytes: level.blob.size
  }))
}

export async function generateCanvasThumbnailLevels(
  request: CanvasThumbnailGenerationRequest
): Promise<CanvasGeneratedThumbnailLevel[]> {
  const workerLevels = await generateLevelsWithWorker(request).catch(() => null)
  if (workerLevels?.length) {
    return workerLevels
  }

  return await generateLevelsInRenderer(request)
}

function createThumbnailSetFromGeneratedLevels({
  identity,
  levels
}: {
  identity: CanvasImageSourceIdentity
  levels: CanvasGeneratedThumbnailLevel[]
}): CanvasImageThumbnailSet {
  return createCanvasThumbnailSet({
    identity,
    levels: levels.map(
      (level): CanvasImageThumbnailLevel => ({
        maxSide: level.maxSide,
        width: level.width,
        height: level.height,
        mimeType: level.mimeType,
        filename: level.filename,
        src: level.src,
        sizeBytes: level.sizeBytes
      })
    )
  })
}

async function buildWriteFiles(
  levels: CanvasGeneratedThumbnailLevel[]
): Promise<CanvasThumbnailCacheWriteFile[]> {
  return await Promise.all(
    levels.map(async (level) => ({
      filename: level.filename || getLevelFilename(level.maxSide, level.mimeType),
      data: await blobToUint8Array(level.blob)
    }))
  )
}

function extractManifestFromReadResponse(
  response: Awaited<ReturnType<NonNullable<CanvasThumbnailIpcBridge['readThumbnailManifest']>>>
): CanvasThumbnailManifestLike | null {
  if (!response) {
    return null
  }

  if ('manifest' in response) {
    return response.manifest
  }

  return response
}

function extractManifestFromWriteResponse(
  response: Awaited<ReturnType<NonNullable<CanvasThumbnailIpcBridge['writeThumbnailSet']>>>
): CanvasThumbnailManifestLike | null {
  if (!response) {
    return null
  }

  if ('manifest' in response) {
    return response.manifest
  }

  return response
}

function isManifestForIdentity(
  manifest: CanvasThumbnailManifestLike,
  identity: CanvasImageSourceIdentity
): boolean {
  return (
    manifest.version === 1 &&
    manifest.cacheKey === identity.cacheKey &&
    manifest.canonicalPath === identity.canonicalPath &&
    Math.floor(manifest.sourceSizeBytes) === identity.sizeBytes &&
    Math.floor(manifest.sourceLastModifiedMs) === identity.lastModifiedMs
  )
}

async function writeThumbnailSetToCache({
  bridge,
  identity,
  levels
}: {
  bridge: CanvasThumbnailIpcBridge | null
  identity: CanvasImageSourceIdentity
  levels: CanvasGeneratedThumbnailLevel[]
}): Promise<CanvasImageThumbnailSet> {
  const transientSet = createThumbnailSetFromGeneratedLevels({ identity, levels })
  if (!bridge?.writeThumbnailSet) {
    return transientSet
  }

  try {
    const persistedResponse = await bridge.writeThumbnailSet({
      cacheKey: identity.cacheKey,
      ...(identity.cacheRootDir ? { cacheRootDir: identity.cacheRootDir } : {}),
      manifest: canvasThumbnailManifestFromSet(transientSet),
      files: await buildWriteFiles(levels)
    })
    const persistedManifest = extractManifestFromWriteResponse(persistedResponse)
    if (persistedManifest && isManifestForIdentity(persistedManifest, identity)) {
      const persistedSet = canvasThumbnailSetFromManifest(persistedManifest, identity)
      if (persistedSet) {
        for (const level of levels) {
          revokeObjectUrl(level.src)
        }
        return persistedSet
      }
    }
  } catch (error) {
    console.warn('[Canvas] Failed to persist thumbnail set, using transient thumbnails.', error)
  }

  return transientSet
}

export async function readWarmCanvasThumbnailSet(
  identity: CanvasImageSourceIdentity,
  bridge = getCanvasThumbnailIpcBridge()
): Promise<WarmCanvasThumbnailReadResult> {
  if (!bridge?.readThumbnailManifest) {
    return { status: 'cache-miss', thumbnailSet: null, manifest: null }
  }

  try {
    const response = await bridge.readThumbnailManifest({
      cacheKey: identity.cacheKey,
      ...(identity.cacheRootDir ? { cacheRootDir: identity.cacheRootDir } : {})
    })
    const manifest = extractManifestFromReadResponse(response)
    if (!manifest) {
      return { status: 'cache-miss', thumbnailSet: null, manifest: null }
    }

    if (!isManifestForIdentity(manifest, identity)) {
      recordCanvasThumbnailRuntimeStatus('cache-stale', false)
      return { status: 'cache-stale', thumbnailSet: null, manifest }
    }

    const thumbnailSet = canvasThumbnailSetFromManifest(manifest, identity)
    if (!thumbnailSet) {
      recordCanvasThumbnailRuntimeStatus('cache-stale', false)
      return { status: 'cache-stale', thumbnailSet: null, manifest }
    }

    recordCanvasThumbnailRuntimeStatus('cache-hit', true)
    return { status: 'cache-hit', thumbnailSet, manifest }
  } catch {
    return { status: 'cache-miss', thumbnailSet: null, manifest: null }
  }
}

async function generateNativeThumbnailLevels({
  identity,
  bridge,
  levels
}: {
  identity: CanvasImageSourceIdentity
  bridge: CanvasThumbnailIpcBridge | null
  levels: readonly CanvasThumbnailLevelSize[]
}): Promise<CanvasGeneratedThumbnailLevel[]> {
  if (!bridge?.createNativeThumbnail) {
    return []
  }

  const generated: CanvasGeneratedThumbnailLevel[] = []
  for (const maxSide of levels) {
    const native = await bridge.createNativeThumbnail({
      fullPath: identity.canonicalPath,
      maxSide
    })
    if (!native) {
      continue
    }

    const data = uint8ArrayFromNativeData(native.data)
    const blob = new Blob([arrayBufferFromBytes(data)], { type: 'image/png' })
    generated.push({
      maxSide,
      width: Math.max(1, Math.floor(native.width)),
      height: Math.max(1, Math.floor(native.height)),
      mimeType: 'image/png',
      format: 'png',
      filename: getLevelFilename(maxSide, 'image/png'),
      sizeBytes: blob.size,
      blob,
      src: createObjectUrl(blob)
    })
  }

  return generated
}

export async function ensureCanvasThumbnailSet({
  source,
  identity,
  levels = CANVAS_THUMBNAIL_LEVELS,
  preferWebp = true,
  bridge = getCanvasThumbnailIpcBridge()
}: CanvasThumbnailGenerationRequest & {
  bridge?: CanvasThumbnailIpcBridge | null
}): Promise<CanvasThumbnailEnsureResult> {
  const warm = await readWarmCanvasThumbnailSet(identity, bridge)
  if (warm.status === 'cache-hit' && warm.thumbnailSet) {
    return {
      status: 'cache-hit',
      thumbnailSet: warm.thumbnailSet
    }
  }

  const requestedLevels = normalizeLevelList(levels)
  let generatedLevels = await generateCanvasThumbnailLevels({
    source,
    identity,
    levels: requestedLevels,
    preferWebp
  }).catch(() => [] as CanvasGeneratedThumbnailLevel[])
  let status: CanvasThumbnailEnsureStatus = 'generated'

  if (!generatedLevels.length) {
    generatedLevels = await generateNativeThumbnailLevels({
      identity,
      bridge,
      levels: requestedLevels
    })
    status = generatedLevels.length ? 'native-generated' : 'failed'
  }

  if (!generatedLevels.length) {
    recordCanvasThumbnailRuntimeStatus('failed', false)
    return {
      status: 'failed',
      thumbnailSet: null
    }
  }

  const thumbnailSet = await writeThumbnailSetToCache({
    bridge,
    identity,
    levels: generatedLevels
  })
  recordCanvasThumbnailRuntimeStatus(status, true)

  return {
    status,
    thumbnailSet
  }
}
