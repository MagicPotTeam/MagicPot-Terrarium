import {
  CANVAS_THUMBNAIL_LEVELS,
  CANVAS_THUMBNAIL_RUNTIME_COUNTER_KEYS,
  CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_MAPPINGS,
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
  type CanvasThumbnailWorkerGeneratedLevel
} from './canvasThumbnailTypes'
import {
  canvasThumbnailManifestFromSet,
  canvasThumbnailSetFromManifest,
  createCanvasThumbnailSet
} from './canvasThumbnailCache'
import { generateCanvasThumbnailLevelsInScope } from './canvasThumbnailGeneration.worker'
import {
  CanvasThumbnailWorkerPool,
  DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_DRAINED_TTL_MS,
  DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_IDLE_TTL_MS,
  DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_MAX_QUEUE_SIZE,
  getDefaultCanvasThumbnailWorkerPoolMaxSize,
  type CanvasThumbnailWorkerPoolMetrics,
  type CanvasThumbnailWorkerPoolOptions
} from './canvasThumbnailWorkerPool'

const WORKER_REQUEST_TIMEOUT_MS = 30_000

function createCanvasThumbnailRuntimeMetrics(): CanvasThumbnailRuntimeMetrics {
  return Object.fromEntries(
    CANVAS_THUMBNAIL_RUNTIME_COUNTER_KEYS.map((key) => [key, 0])
  ) as CanvasThumbnailRuntimeMetrics
}

function createDefaultCanvasThumbnailWorkerPoolOptions(): CanvasThumbnailWorkerPoolOptions {
  return {
    maxWorkers: getDefaultCanvasThumbnailWorkerPoolMaxSize(),
    maxQueueSize: DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_MAX_QUEUE_SIZE,
    requestTimeoutMs: WORKER_REQUEST_TIMEOUT_MS,
    idleWorkerTtlMs: DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_IDLE_TTL_MS,
    drainedWorkerTtlMs: DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_DRAINED_TTL_MS
  }
}

const canvasThumbnailRuntimeMetrics = createCanvasThumbnailRuntimeMetrics()

function mergeCanvasThumbnailWorkerPoolMetrics(
  metrics: CanvasThumbnailRuntimeMetrics
): CanvasThumbnailRuntimeMetrics {
  const workerPoolMetrics = canvasThumbnailWorkerPool.getMetrics()
  const merged = { ...metrics }
  CANVAS_THUMBNAIL_WORKER_POOL_RUNTIME_METRIC_MAPPINGS.forEach(
    ([runtimeMetricKey, workerPoolMetricKey]) => {
      merged[runtimeMetricKey] = workerPoolMetrics[workerPoolMetricKey]
    }
  )
  return merged
}

type WarmCanvasThumbnailReadResult = {
  status: Extract<CanvasThumbnailEnsureStatus, 'cache-hit' | 'cache-miss' | 'cache-stale'>
  thumbnailSet: CanvasImageThumbnailSet | null
  manifest: CanvasThumbnailManifestLike | null
}

function getCanvasThumbnailIpcBridge(): CanvasThumbnailIpcBridge | null {
  const api = (typeof window !== 'undefined' ? window.api : undefined) as
    { svcCanvasThumbnail?: CanvasThumbnailIpcBridge } | undefined
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
    case 'sidecar-generated':
      canvasThumbnailRuntimeMetrics.sidecarGeneratedCount += 1
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
  return mergeCanvasThumbnailWorkerPoolMetrics(canvasThumbnailRuntimeMetrics)
}

export function resetCanvasThumbnailRuntimeMetrics(): void {
  CANVAS_THUMBNAIL_RUNTIME_COUNTER_KEYS.forEach((key) => {
    canvasThumbnailRuntimeMetrics[key] = 0
  })
  canvasThumbnailWorkerPool.resetCounters()
}

/**
 * Object URLs of thumbnail levels that live in this session only: pasted and other path-less
 * images, and sets whose cache write failed. They stay outside the image layer's shared
 * object-URL registry (128 slots): three to five URLs per pasted image filled it after about 25
 * images, and every later image lost its thumbnails and kept a full-size decode plus a 512 px
 * bitmap preview instead. Levels of files on disk never get a URL: they are read from the cache.
 *
 * The newest URLs are kept, within a count and a byte bound; the oldest are revoked. The image
 * layer then fails to load that level once and keeps the item's own preview.
 */
export const CANVAS_THUMBNAIL_TRANSIENT_URL_MAX_COUNT = 768
export const CANVAS_THUMBNAIL_TRANSIENT_URL_MAX_BYTES = 64 * 1024 * 1024
/** URL -> bytes of its blob, oldest first. */
const transientThumbnailObjectUrls = new Map<string, number>()
let transientThumbnailObjectUrlBytes = 0

function revokeTransientObjectUrl(src: string): void {
  const bytes = transientThumbnailObjectUrls.get(src)
  if (bytes === undefined) {
    return
  }
  transientThumbnailObjectUrls.delete(src)
  transientThumbnailObjectUrlBytes -= bytes
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(src)
  }
}

function createTransientObjectUrl(blob: Blob): string {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return ''
  }
  let url = ''
  try {
    url = URL.createObjectURL(blob)
  } catch {
    return ''
  }
  transientThumbnailObjectUrls.set(url, blob.size)
  transientThumbnailObjectUrlBytes += blob.size
  for (const oldest of transientThumbnailObjectUrls.keys()) {
    if (
      oldest === url ||
      (transientThumbnailObjectUrls.size <= CANVAS_THUMBNAIL_TRANSIENT_URL_MAX_COUNT &&
        transientThumbnailObjectUrlBytes <= CANVAS_THUMBNAIL_TRANSIENT_URL_MAX_BYTES)
    ) {
      break
    }
    revokeTransientObjectUrl(oldest)
  }
  return url
}

export function getCanvasThumbnailTransientObjectUrlMetrics(): { count: number; bytes: number } {
  return {
    count: transientThumbnailObjectUrls.size,
    bytes: transientThumbnailObjectUrlBytes
  }
}

export function revokeCanvasThumbnailTransientObjectUrlsForTest(): void {
  for (const src of Array.from(transientThumbnailObjectUrls.keys())) {
    revokeTransientObjectUrl(src)
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

/** No URL yet: a level of a file on disk goes to the cache and is read from there. */
function finalizeGeneratedThumbnailLevel(
  level: CanvasThumbnailWorkerGeneratedLevel
): CanvasGeneratedThumbnailLevel {
  return {
    ...level,
    filename: getLevelFilename(level.maxSide, level.mimeType),
    src: '',
    sizeBytes: level.blob.size
  }
}

const canvasThumbnailWorkerPool = new CanvasThumbnailWorkerPool(
  createDefaultCanvasThumbnailWorkerPoolOptions(),
  { createWorker }
)

async function generateLevelsWithWorker(
  request: CanvasThumbnailGenerationRequest
): Promise<CanvasGeneratedThumbnailLevel[] | null> {
  const workerLevels = await canvasThumbnailWorkerPool.generate(request)
  return workerLevels ? workerLevels.map(finalizeGeneratedThumbnailLevel) : null
}

export function getCanvasThumbnailWorkerPoolMetrics(): CanvasThumbnailWorkerPoolMetrics {
  return canvasThumbnailWorkerPool.getMetrics()
}

/** Starts thumbnail workers before the jobs of an import arrive (see CanvasThumbnailWorkerPool.prewarm). */
export function prewarmCanvasThumbnailWorkers(count: number): number {
  try {
    return canvasThumbnailWorkerPool.prewarm(count)
  } catch {
    return 0
  }
}

export function resetCanvasThumbnailWorkerPoolForTest(): void {
  canvasThumbnailWorkerPool.reset()
  canvasThumbnailWorkerPool.configure(createDefaultCanvasThumbnailWorkerPoolOptions())
}

export function configureCanvasThumbnailWorkerPoolForTest(
  options: Partial<CanvasThumbnailWorkerPoolOptions>
): void {
  canvasThumbnailWorkerPool.configure(options)
}

async function generateLevelsInRenderer(
  request: CanvasThumbnailGenerationRequest
): Promise<CanvasGeneratedThumbnailLevel[]> {
  const levels = await generateCanvasThumbnailLevelsInScope({
    source: request.source,
    levels: normalizeLevelList(request.levels),
    preferWebp: request.preferWebp ?? true,
    firstLevelMaxSide: request.firstLevelMaxSide,
    onFirstLevel: request.onFirstLevel
  })

  return levels.map(finalizeGeneratedThumbnailLevel)
}

export async function generateCanvasThumbnailLevels(
  request: CanvasThumbnailGenerationRequest
): Promise<CanvasGeneratedThumbnailLevel[]> {
  const workerLevels = await generateLevelsWithWorker(request).catch(() => null)
  if (workerLevels?.length) {
    return workerLevels
  }
  // A caller that gave up gets no renderer-side generation on the main thread.
  if (request.signal?.aborted) {
    return []
  }

  return await generateLevelsInRenderer(request)
}

/**
 * A set always lists every requested level. Only the levels below the source size are generated
 * and have a file; a requested level at or above it repeats the entry of the largest generated
 * file (same file name: no second encode, no second file). Whoever knows the source
 * (bindCanvasThumbnailSetToSource in canvasAssetIntakeHelpers) points such an entry at the
 * source itself, so "the level above the largest thumbnail" is the original picture.
 */
function createThumbnailSetFromGeneratedLevels({
  identity,
  levels,
  requestedLevels
}: {
  identity: CanvasImageSourceIdentity
  levels: CanvasGeneratedThumbnailLevel[]
  requestedLevels: readonly CanvasThumbnailLevelSize[]
}): CanvasImageThumbnailSet {
  const generated = [...levels].sort((left, right) => left.maxSide - right.maxSide)
  const largest = generated[generated.length - 1]
  const toSetLevel = (
    level: CanvasGeneratedThumbnailLevel,
    maxSide: CanvasThumbnailLevelSize
  ): CanvasImageThumbnailLevel => ({
    maxSide,
    width: level.width,
    height: level.height,
    mimeType: level.mimeType,
    filename: level.filename,
    src: level.src,
    sizeBytes: level.sizeBytes
  })
  const entries = generated.map((level) => toSetLevel(level, level.maxSide))
  if (largest) {
    for (const maxSide of requestedLevels) {
      if (maxSide > largest.maxSide && !generated.some((level) => level.maxSide === maxSide)) {
        entries.push(toSetLevel(largest, maxSide))
      }
    }
  }
  return createCanvasThumbnailSet({ identity, levels: entries })
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

function extractManifestFromGenerateResponse(
  response: Awaited<ReturnType<NonNullable<CanvasThumbnailIpcBridge['generateThumbnailSet']>>>
): CanvasThumbnailManifestLike | null {
  return response?.manifest ?? null
}

function isManifestForIdentity(
  manifest: CanvasThumbnailManifestLike,
  identity: CanvasImageSourceIdentity
): boolean {
  return (
    identity.kind === 'local-file' &&
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
  levels,
  requestedLevels
}: {
  bridge: CanvasThumbnailIpcBridge | null
  identity: CanvasImageSourceIdentity
  levels: CanvasGeneratedThumbnailLevel[]
  requestedLevels: readonly CanvasThumbnailLevelSize[]
}): Promise<CanvasImageThumbnailSet> {
  // Levels that cannot go to the cache are shown from session-only object URLs.
  const createTransientSet = () =>
    createThumbnailSetFromGeneratedLevels({
      identity,
      levels: levels.map((level) => ({ ...level, src: createTransientObjectUrl(level.blob) })),
      requestedLevels
    })
  if (identity.kind !== 'local-file' || !bridge?.writeThumbnailSet) {
    return createTransientSet()
  }

  try {
    const persistedResponse = await bridge.writeThumbnailSet({
      cacheKey: identity.cacheKey,
      ...(identity.cacheRootDir ? { cacheRootDir: identity.cacheRootDir } : {}),
      manifest: canvasThumbnailManifestFromSet(
        createThumbnailSetFromGeneratedLevels({ identity, levels, requestedLevels })
      ),
      files: await buildWriteFiles(levels)
    })
    const persistedManifest = extractManifestFromWriteResponse(persistedResponse)
    if (persistedManifest && isManifestForIdentity(persistedManifest, identity)) {
      const persistedSet = canvasThumbnailSetFromManifest(persistedManifest, identity)
      if (persistedSet) {
        return persistedSet
      }
    }
  } catch (error) {
    console.warn('[Canvas] Failed to persist thumbnail set, using transient thumbnails.', error)
  }

  return createTransientSet()
}

export async function readWarmCanvasThumbnailSet(
  identity: CanvasImageSourceIdentity,
  bridge = getCanvasThumbnailIpcBridge()
): Promise<WarmCanvasThumbnailReadResult> {
  if (identity.kind !== 'local-file' || !bridge?.readThumbnailManifest) {
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

/**
 * The native sidecar is asked once per image only while it can answer. Asking main cost one
 * round trip per image (about 5 ms each on a 100-image import) just to hear "switched off".
 */
const CANVAS_THUMBNAIL_SIDECAR_MAX_CONSECUTIVE_FAILURES = 3
const SIDECAR_ABSENT_REASONS: ReadonlySet<string> = new Set([
  'feature-disabled',
  'binary-not-found'
])
type CanvasThumbnailSidecarState = { absent: boolean; consecutiveFailures: number }
const sidecarStateByBridge = new WeakMap<CanvasThumbnailIpcBridge, CanvasThumbnailSidecarState>()

function getSidecarState(bridge: CanvasThumbnailIpcBridge): CanvasThumbnailSidecarState {
  let state = sidecarStateByBridge.get(bridge)
  if (!state) {
    state = { absent: false, consecutiveFailures: 0 }
    sidecarStateByBridge.set(bridge, state)
  }
  return state
}

async function generateSidecarThumbnailSet({
  identity,
  bridge,
  levels,
  preferWebp
}: {
  identity: CanvasImageSourceIdentity
  bridge: CanvasThumbnailIpcBridge | null
  levels: readonly CanvasThumbnailLevelSize[]
  preferWebp: boolean
}): Promise<CanvasImageThumbnailSet | null> {
  if (identity.kind !== 'local-file' || !bridge?.generateThumbnailSet) {
    return null
  }

  // A sidecar that is switched off or not installed stays so for the session, and one that
  // keeps failing is not paid for with a process start per image: the worker takes over.
  const state = getSidecarState(bridge)
  if (
    state.absent ||
    state.consecutiveFailures >= CANVAS_THUMBNAIL_SIDECAR_MAX_CONSECUTIVE_FAILURES
  ) {
    return null
  }

  try {
    const response = await bridge.generateThumbnailSet({
      fullPath: identity.canonicalPath,
      ...(identity.cacheRootDir ? { cacheRootDir: identity.cacheRootDir } : {}),
      levels: [...levels],
      format: preferWebp ? 'image/webp' : 'image/png'
    })
    const manifest = extractManifestFromGenerateResponse(response)
    const thumbnailSet =
      manifest && isManifestForIdentity(manifest, identity)
        ? canvasThumbnailSetFromManifest(manifest, identity)
        : null
    if (thumbnailSet) {
      state.consecutiveFailures = 0
      return thumbnailSet
    }
    const reason = response?.sidecar?.reason
    if (typeof reason === 'string' && SIDECAR_ABSENT_REASONS.has(reason)) {
      state.absent = true
    } else {
      state.consecutiveFailures += 1
    }
    return null
  } catch (error) {
    state.consecutiveFailures += 1
    console.warn('[Canvas] Native sidecar thumbnail generation failed, falling back.', error)
    return null
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
  if (identity.kind !== 'local-file' || !bridge?.createNativeThumbnail) {
    return []
  }

  const generated: CanvasGeneratedThumbnailLevel[] = []
  for (const maxSide of levels) {
    const native = await bridge.createNativeThumbnail({
      fullPath: identity.canonicalPath,
      ...(identity.cacheRootDir ? { cacheRootDir: identity.cacheRootDir } : {}),
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
      src: ''
    })
  }

  return generated
}

export async function ensureCanvasThumbnailSet({
  source,
  identity,
  levels = CANVAS_THUMBNAIL_LEVELS,
  preferWebp = true,
  sourceWidth,
  sourceHeight,
  firstLevelMaxSide,
  onFirstLevel,
  signal,
  onQueued,
  onDispatch,
  skipWarmRead = false,
  bridge = getCanvasThumbnailIpcBridge()
}: CanvasThumbnailGenerationRequest & {
  /** The caller has just read the cache and missed: do not ask main a second time. */
  skipWarmRead?: boolean
  bridge?: CanvasThumbnailIpcBridge | null
}): Promise<CanvasThumbnailEnsureResult> {
  if (!skipWarmRead) {
    const warm = await readWarmCanvasThumbnailSet(identity, bridge)
    if (warm.status === 'cache-hit' && warm.thumbnailSet) {
      return {
        status: 'cache-hit',
        thumbnailSet: warm.thumbnailSet
      }
    }
  }

  const requestedLevels = normalizeLevelList(levels)
  const sidecarThumbnailSet = await generateSidecarThumbnailSet({
    identity,
    bridge,
    levels: requestedLevels,
    preferWebp
  })
  if (sidecarThumbnailSet) {
    recordCanvasThumbnailRuntimeStatus('sidecar-generated', true)
    return {
      status: 'sidecar-generated',
      thumbnailSet: sidecarThumbnailSet
    }
  }

  let generatedLevels = await generateCanvasThumbnailLevels({
    source,
    identity,
    levels: requestedLevels,
    preferWebp,
    sourceWidth,
    sourceHeight,
    firstLevelMaxSide,
    onFirstLevel,
    signal,
    onQueued,
    onDispatch
  }).catch(() => [] as CanvasGeneratedThumbnailLevel[])
  let status: CanvasThumbnailEnsureStatus = 'generated'

  if (!generatedLevels.length && !signal?.aborted) {
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
    levels: generatedLevels,
    requestedLevels
  })
  recordCanvasThumbnailRuntimeStatus(status, true)

  return {
    status,
    thumbnailSet,
    generatedLevels
  }
}
