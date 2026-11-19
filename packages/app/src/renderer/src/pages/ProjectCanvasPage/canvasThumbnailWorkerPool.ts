import {
  CANVAS_THUMBNAIL_LEVELS,
  type CanvasThumbnailGenerationRequest,
  type CanvasThumbnailLevelSize,
  type CanvasThumbnailWorkerGenerateMessage,
  type CanvasThumbnailWorkerGeneratedLevel,
  type CanvasThumbnailWorkerMessage
} from './canvasThumbnailTypes'

const DEFAULT_WORKER_POOL_MAX_SIZE = 4
export const DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_MAX_QUEUE_SIZE = 32
export const DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_IDLE_TTL_MS = 30_000
/**
 * Decoded pixels the running jobs may hold together. A worker keeps the full decoded source
 * (4 bytes per pixel) plus its level canvases, so the number of jobs that run side by side
 * follows from their size: four small images, three 4096 x 3072 ones, one 8K sheet at a time.
 */
export const DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_MAX_IN_FLIGHT_BYTES = 256 * 1024 * 1024
const UNKNOWN_SOURCE_DECODED_BYTES_PER_ENCODED_BYTE = 12
const UNKNOWN_SOURCE_MIN_DECODED_BYTES = 16 * 1024 * 1024
const LARGEST_LEVEL_CANVAS_BYTES = 2048 * 2048 * 4
// Once the pool has nothing running and nothing queued (an import finished), its idle workers
// end this soon instead of after the idle TTL: each one holds a V8 isolate and what its last
// decode left behind. The wait covers the gaps between the jobs of one import and between
// jobs that come a few seconds apart (a board opening, a pan onto items without thumbnails,
// small drag-ins), which would otherwise each pay a worker start; a later job starts a worker
// again.
export const DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_DRAINED_TTL_MS = 3_000

export type CanvasThumbnailWorkerPoolOptions = {
  maxWorkers: number
  maxQueueSize: number
  requestTimeoutMs: number
  idleWorkerTtlMs: number
  drainedWorkerTtlMs?: number
  maxInFlightBytes?: number
}

/**
 * What one job holds while it runs: the decoded source plus the level canvases (the largest
 * level and the quarter-sized ones below it). Without a known pixel size the decoded source is
 * estimated from the encoded size, generously.
 */
export function estimateCanvasThumbnailJobBytes(
  request: Pick<CanvasThumbnailGenerationRequest, 'source' | 'sourceWidth' | 'sourceHeight'>
): number {
  const { sourceWidth, sourceHeight } = request
  const decodedBytes =
    typeof sourceWidth === 'number' &&
    typeof sourceHeight === 'number' &&
    Number.isFinite(sourceWidth) &&
    Number.isFinite(sourceHeight) &&
    sourceWidth > 0 &&
    sourceHeight > 0
      ? Math.ceil(sourceWidth) * Math.ceil(sourceHeight) * 4
      : Math.max(
          UNKNOWN_SOURCE_MIN_DECODED_BYTES,
          Math.max(0, request.source.size) * UNKNOWN_SOURCE_DECODED_BYTES_PER_ENCODED_BYTE
        )
  return decodedBytes + Math.ceil((Math.min(decodedBytes, LARGEST_LEVEL_CANVAS_BYTES) * 4) / 3)
}

type NormalizedCanvasThumbnailWorkerPoolOptions = Required<CanvasThumbnailWorkerPoolOptions>

export type CanvasThumbnailWorkerPoolMetrics = {
  workerCount: number
  idleWorkerCount: number
  activeRequestCount: number
  queuedRequestCount: number
  inFlightKeyCount: number
  dedupedRequestCount: number
  rejectedRequestCount: number
  timedOutRequestCount: number
  failedWorkerCount: number
  completedRequestCount: number
  maxWorkers: number
  maxQueueSize: number
  inFlightBytes: number
  maxInFlightBytes: number
}

type CanvasThumbnailFirstLevelListener = NonNullable<
  CanvasThumbnailGenerationRequest['onFirstLevel']
>

type CanvasThumbnailWorkerJob = {
  key: string
  requestId: string
  request: CanvasThumbnailGenerationRequest
  bytes: number
  firstLevel: CanvasThumbnailWorkerGeneratedLevel | null
  firstLevelListeners: CanvasThumbnailFirstLevelListener[]
  levels: readonly CanvasThumbnailLevelSize[]
  promise: Promise<readonly CanvasThumbnailWorkerGeneratedLevel[] | null>
  resolve: (levels: readonly CanvasThumbnailWorkerGeneratedLevel[] | null) => void
  reject: (error: unknown) => void
  worker: Worker | null
  timeoutId: number | null
}

type CanvasThumbnailWorkerPoolSetTimeout = (handler: () => void, timeoutMs: number) => number
type CanvasThumbnailWorkerPoolClearTimeout = (timeoutId: number) => void

export type CanvasThumbnailWorkerPoolDependencies = {
  createWorker: () => Worker | null
  createRequestId?: () => string
  setTimeout?: CanvasThumbnailWorkerPoolSetTimeout
  clearTimeout?: CanvasThumbnailWorkerPoolClearTimeout
}

function normalizeCanvasThumbnailWorkerLevels(
  levels?: readonly CanvasThumbnailLevelSize[]
): readonly CanvasThumbnailLevelSize[] {
  if (!levels?.length) {
    return CANVAS_THUMBNAIL_LEVELS
  }

  const requested = new Set(levels)
  return CANVAS_THUMBNAIL_LEVELS.filter((level) => requested.has(level))
}

/**
 * Two logical cores stay free for the renderer's main thread and the GPU process. How many of
 * the workers run side by side is then decided by bytes (maxInFlightBytes), not by this count.
 */
export function getDefaultCanvasThumbnailWorkerPoolMaxSize(): number {
  const hardwareConcurrency =
    typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
      ? Math.floor(navigator.hardwareConcurrency)
      : DEFAULT_WORKER_POOL_MAX_SIZE
  return Math.max(1, Math.min(DEFAULT_WORKER_POOL_MAX_SIZE, hardwareConcurrency - 2))
}

function createCanvasThumbnailWorkerPoolRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
}

export function createCanvasThumbnailWorkerPoolRequestKey({
  source,
  identity,
  levels,
  preferWebp
}: CanvasThumbnailGenerationRequest & { levels?: readonly CanvasThumbnailLevelSize[] }): string {
  const normalizedLevels = normalizeCanvasThumbnailWorkerLevels(levels)
  const identityKeyParts =
    identity.kind === 'local-file'
      ? [
          identity.canonicalPath,
          Math.floor(identity.sizeBytes),
          Math.floor(identity.lastModifiedMs),
          identity.cacheRootDir ?? ''
        ]
      : [
          identity.sourceKey,
          Math.floor(identity.sizeBytes),
          identity.mimeType,
          identity.fileName ?? ''
        ]

  return [
    identity.cacheKey,
    ...identityKeyParts,
    source.size,
    source.type,
    normalizedLevels.join(','),
    preferWebp ?? true
  ].join('|')
}

function defaultSetWorkerPoolTimeout(handler: () => void, timeoutMs: number): number {
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
    return window.setTimeout(handler, timeoutMs)
  }
  return globalThis.setTimeout(handler, timeoutMs) as unknown as number
}

function defaultClearWorkerPoolTimeout(timeoutId: number): void {
  if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
    window.clearTimeout(timeoutId)
    return
  }
  globalThis.clearTimeout(timeoutId as unknown as ReturnType<typeof globalThis.setTimeout>)
}

function normalizeWorkerPoolOptions(
  options: CanvasThumbnailWorkerPoolOptions
): NormalizedCanvasThumbnailWorkerPoolOptions {
  const drainedWorkerTtlMs = Number(
    options.drainedWorkerTtlMs ?? DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_DRAINED_TTL_MS
  )
  const maxInFlightBytes = Number(
    options.maxInFlightBytes ?? DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_MAX_IN_FLIGHT_BYTES
  )
  return {
    maxWorkers: Math.max(1, Math.floor(options.maxWorkers)),
    maxQueueSize: Math.max(0, Math.floor(options.maxQueueSize)),
    requestTimeoutMs: Math.max(1, Math.floor(options.requestTimeoutMs)),
    idleWorkerTtlMs: Math.max(0, Math.floor(options.idleWorkerTtlMs)),
    drainedWorkerTtlMs: Number.isFinite(drainedWorkerTtlMs)
      ? Math.max(0, Math.floor(drainedWorkerTtlMs))
      : DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_DRAINED_TTL_MS,
    maxInFlightBytes: Number.isFinite(maxInFlightBytes)
      ? Math.max(1, Math.floor(maxInFlightBytes))
      : DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_MAX_IN_FLIGHT_BYTES
  }
}

export class CanvasThumbnailWorkerPool {
  private workers: Worker[] = []
  private idleWorkers: Worker[] = []
  private activeJobsByWorker = new Map<Worker, CanvasThumbnailWorkerJob>()
  private queue: CanvasThumbnailWorkerJob[] = []
  private inFlightByKey = new Map<string, CanvasThumbnailWorkerJob>()
  private idleTimeoutsByWorker = new Map<Worker, number>()
  private dedupedRequestCount = 0
  private rejectedRequestCount = 0
  private timedOutRequestCount = 0
  private failedWorkerCount = 0
  private completedRequestCount = 0
  private options: NormalizedCanvasThumbnailWorkerPoolOptions
  private readonly createWorker: () => Worker | null
  private readonly createRequestId: () => string
  private readonly setTimeout: CanvasThumbnailWorkerPoolSetTimeout
  private readonly clearTimeout: CanvasThumbnailWorkerPoolClearTimeout

  constructor(
    options: CanvasThumbnailWorkerPoolOptions,
    dependencies: CanvasThumbnailWorkerPoolDependencies
  ) {
    this.options = normalizeWorkerPoolOptions(options)
    this.createWorker = dependencies.createWorker
    this.createRequestId = dependencies.createRequestId ?? createCanvasThumbnailWorkerPoolRequestId
    this.setTimeout = dependencies.setTimeout ?? defaultSetWorkerPoolTimeout
    this.clearTimeout = dependencies.clearTimeout ?? defaultClearWorkerPoolTimeout
  }

  generate(
    request: CanvasThumbnailGenerationRequest
  ): Promise<readonly CanvasThumbnailWorkerGeneratedLevel[] | null> {
    const levels = normalizeCanvasThumbnailWorkerLevels(request.levels)
    const key = createCanvasThumbnailWorkerPoolRequestKey({ ...request, levels })
    const existing = this.inFlightByKey.get(key)
    if (existing) {
      this.dedupedRequestCount += 1
      if (request.onFirstLevel) {
        if (existing.firstLevel) {
          this.notifyFirstLevel(request.onFirstLevel, existing.firstLevel)
        } else {
          existing.firstLevelListeners.push(request.onFirstLevel)
        }
      }
      return existing.promise
    }

    let resolveJob: (levels: readonly CanvasThumbnailWorkerGeneratedLevel[] | null) => void = () =>
      undefined
    let rejectJob: (error: unknown) => void = () => undefined
    const job: CanvasThumbnailWorkerJob = {
      key,
      requestId: this.createRequestId(),
      request,
      bytes: estimateCanvasThumbnailJobBytes(request),
      firstLevel: null,
      firstLevelListeners: request.onFirstLevel ? [request.onFirstLevel] : [],
      levels,
      promise: new Promise<readonly CanvasThumbnailWorkerGeneratedLevel[] | null>(
        (resolve, reject) => {
          resolveJob = resolve
          rejectJob = reject
        }
      ),
      resolve: (levelsResult) => resolveJob(levelsResult),
      reject: (error) => rejectJob(error),
      worker: null,
      timeoutId: null
    }

    this.inFlightByKey.set(key, job)
    // First come, first served: a job never overtakes one that waits for its byte budget.
    const dispatched = this.queue.length > 0 ? 'full' : this.dispatch(job)
    if (dispatched === 'started') {
      return job.promise
    }
    if (dispatched === 'unavailable') {
      this.inFlightByKey.delete(key)
      job.resolve(null)
      return job.promise
    }
    if (this.queue.length >= this.options.maxQueueSize) {
      this.inFlightByKey.delete(key)
      this.rejectedRequestCount += 1
      job.resolve(null)
      return job.promise
    }

    this.queue.push(job)
    return job.promise
  }

  /**
   * Starts workers ahead of the jobs of an import, up to `count` and the pool's size: a worker's
   * first job also loads and compiles its code (0.4 s against 0.07 s for the next small image in
   * the container). Workers nobody uses end like any idle worker, after the drained TTL.
   */
  prewarm(count: number): number {
    const target = Math.min(this.options.maxWorkers, Math.max(0, Math.floor(count)))
    let started = 0
    while (this.workers.length < target) {
      const worker = this.spawnWorker()
      if (!worker) {
        break
      }
      started += 1
      this.releaseWorkerToIdle(worker)
    }
    this.shortenIdleTimeoutsWhenDrained()
    return started
  }

  configure(options: Partial<CanvasThumbnailWorkerPoolOptions>): void {
    this.options = normalizeWorkerPoolOptions({
      ...this.options,
      ...options
    })
    this.trimIdleWorkers()
    this.pumpQueue()
  }

  reset(): void {
    for (const job of this.inFlightByKey.values()) {
      this.clearJobTimeout(job)
      job.resolve(null)
    }
    for (const worker of [...this.workers]) {
      this.terminateWorker(worker)
    }
    this.queue = []
    this.inFlightByKey.clear()
    this.resetCounters()
  }

  resetCounters(): void {
    this.dedupedRequestCount = 0
    this.rejectedRequestCount = 0
    this.timedOutRequestCount = 0
    this.failedWorkerCount = 0
    this.completedRequestCount = 0
  }

  getMetrics(): CanvasThumbnailWorkerPoolMetrics {
    return {
      workerCount: this.workers.length,
      idleWorkerCount: this.idleWorkers.length,
      activeRequestCount: this.activeJobsByWorker.size,
      queuedRequestCount: this.queue.length,
      inFlightKeyCount: this.inFlightByKey.size,
      dedupedRequestCount: this.dedupedRequestCount,
      rejectedRequestCount: this.rejectedRequestCount,
      timedOutRequestCount: this.timedOutRequestCount,
      failedWorkerCount: this.failedWorkerCount,
      completedRequestCount: this.completedRequestCount,
      maxWorkers: this.options.maxWorkers,
      maxQueueSize: this.options.maxQueueSize,
      inFlightBytes: this.getInFlightBytes(),
      maxInFlightBytes: this.options.maxInFlightBytes
    }
  }

  private getInFlightBytes(): number {
    let bytes = 0
    for (const job of this.activeJobsByWorker.values()) {
      bytes += job.bytes
    }
    return bytes
  }

  private notifyFirstLevel(
    listener: CanvasThumbnailFirstLevelListener,
    level: CanvasThumbnailWorkerGeneratedLevel
  ): void {
    try {
      listener(level)
    } catch (error) {
      console.warn('[Canvas] Thumbnail first-level listener failed.', error)
    }
  }

  private dispatch(job: CanvasThumbnailWorkerJob): 'started' | 'full' | 'unavailable' {
    // Bytes in flight are capped, not the number of jobs. A job larger than the whole budget
    // still runs, but alone.
    if (
      this.activeJobsByWorker.size > 0 &&
      this.getInFlightBytes() + job.bytes > this.options.maxInFlightBytes
    ) {
      return 'full'
    }

    const worker = this.acquireWorker()
    if (!worker) {
      return this.workers.length >= this.options.maxWorkers ? 'full' : 'unavailable'
    }

    job.worker = worker
    this.activeJobsByWorker.set(worker, job)
    job.timeoutId = this.setTimeout(() => {
      this.failJob(job, new Error('Thumbnail worker timed out.'), true, true)
    }, this.options.requestTimeoutMs)

    const message: CanvasThumbnailWorkerGenerateMessage = {
      type: 'generate',
      requestId: job.requestId,
      source: job.request.source,
      levels: job.levels,
      preferWebp: job.request.preferWebp ?? true,
      ...(job.firstLevelListeners.length > 0 &&
      typeof job.request.firstLevelMaxSide === 'number' &&
      job.request.firstLevelMaxSide > 0
        ? { firstLevelMaxSide: job.request.firstLevelMaxSide }
        : {})
    }

    try {
      worker.postMessage(message)
    } catch (error) {
      this.failJob(job, error, true)
    }
    return 'started'
  }

  private acquireWorker(): Worker | null {
    const idleWorker = this.idleWorkers.shift()
    if (idleWorker) {
      this.clearIdleTimeout(idleWorker)
      return idleWorker
    }
    if (this.workers.length >= this.options.maxWorkers) {
      return null
    }

    return this.spawnWorker()
  }

  private spawnWorker(): Worker | null {
    const worker = this.createWorker()
    if (!worker) {
      return null
    }
    worker.addEventListener('message', this.onMessage)
    worker.addEventListener('error', this.onError)
    this.workers.push(worker)
    return worker
  }

  private succeedJob(
    job: CanvasThumbnailWorkerJob,
    levels: readonly CanvasThumbnailWorkerGeneratedLevel[]
  ): void {
    this.finishJob(job, false)
    this.completedRequestCount += 1
    job.resolve(levels)
  }

  private failJob(
    job: CanvasThumbnailWorkerJob,
    error: unknown,
    replaceWorker: boolean,
    timedOut = false
  ): void {
    if (timedOut) {
      this.timedOutRequestCount += 1
    }
    if (replaceWorker) {
      this.failedWorkerCount += 1
    }
    this.finishJob(job, replaceWorker)
    job.reject(error)
  }

  private finishJob(job: CanvasThumbnailWorkerJob, replaceWorker: boolean): void {
    this.clearJobTimeout(job)
    this.inFlightByKey.delete(job.key)
    const worker = job.worker
    job.worker = null
    if (worker) {
      this.activeJobsByWorker.delete(worker)
      if (replaceWorker) {
        this.terminateWorker(worker)
      } else if (this.workers.includes(worker) && this.workers.length <= this.options.maxWorkers) {
        this.releaseWorkerToIdle(worker)
      } else {
        this.terminateWorker(worker)
      }
    }
    this.pumpQueue()
    this.shortenIdleTimeoutsWhenDrained()
  }

  private isDrained(): boolean {
    return this.activeJobsByWorker.size === 0 && this.queue.length === 0
  }

  /**
   * Nothing runs and nothing waits: the idle workers end after the short drained TTL. A job
   * that arrives before that takes an idle worker as usual; a worker whose short wait runs out
   * while other work is running stays as a spare for the normal idle TTL.
   */
  private shortenIdleTimeoutsWhenDrained(): void {
    if (!this.isDrained() || this.options.drainedWorkerTtlMs >= this.options.idleWorkerTtlMs) {
      return
    }
    for (const worker of [...this.idleWorkers]) {
      this.armIdleTimeout(worker, this.options.drainedWorkerTtlMs, true)
    }
  }

  private clearJobTimeout(job: CanvasThumbnailWorkerJob): void {
    if (job.timeoutId !== null) {
      this.clearTimeout(job.timeoutId)
      job.timeoutId = null
    }
  }

  private releaseWorkerToIdle(worker: Worker): void {
    this.clearIdleTimeout(worker)
    this.idleWorkers.push(worker)
    if (this.options.idleWorkerTtlMs <= 0) {
      this.terminateWorker(worker)
      return
    }
    this.armIdleTimeout(worker, this.options.idleWorkerTtlMs, false)
  }

  private armIdleTimeout(worker: Worker, ttlMs: number, onlyWhileDrained: boolean): void {
    this.clearIdleTimeout(worker)
    if (ttlMs <= 0) {
      if (!this.activeJobsByWorker.has(worker)) {
        this.terminateWorker(worker)
      }
      return
    }
    const timeoutId = this.setTimeout(() => {
      this.idleTimeoutsByWorker.delete(worker)
      if (this.activeJobsByWorker.has(worker) || !this.workers.includes(worker)) {
        return
      }
      if (onlyWhileDrained && !this.isDrained()) {
        this.armIdleTimeout(worker, this.options.idleWorkerTtlMs, false)
        return
      }
      this.terminateWorker(worker)
    }, ttlMs)
    this.idleTimeoutsByWorker.set(worker, timeoutId)
  }

  private clearIdleTimeout(worker: Worker): void {
    const timeoutId = this.idleTimeoutsByWorker.get(worker)
    if (timeoutId !== undefined) {
      this.clearTimeout(timeoutId)
      this.idleTimeoutsByWorker.delete(worker)
    }
  }

  private terminateWorker(worker: Worker): void {
    this.clearIdleTimeout(worker)
    worker.removeEventListener('message', this.onMessage)
    worker.removeEventListener('error', this.onError)
    worker.terminate()
    this.workers = this.workers.filter((candidate) => candidate !== worker)
    this.idleWorkers = this.idleWorkers.filter((candidate) => candidate !== worker)
    this.activeJobsByWorker.delete(worker)
  }

  private trimIdleWorkers(): void {
    while (this.workers.length > this.options.maxWorkers && this.idleWorkers.length > 0) {
      const worker = this.idleWorkers.pop()
      if (worker) {
        this.terminateWorker(worker)
      }
    }
  }

  private pumpQueue(): void {
    while (this.queue.length > 0) {
      const nextJob = this.queue.shift()
      if (!nextJob) {
        break
      }

      const dispatched = this.dispatch(nextJob)
      if (dispatched === 'started') {
        continue
      }
      if (dispatched === 'unavailable') {
        this.inFlightByKey.delete(nextJob.key)
        nextJob.resolve(null)
        continue
      }

      this.queue.unshift(nextJob)
      break
    }
  }

  private getKnownWorker(target: EventTarget | null): Worker | null {
    return this.workers.find((worker) => worker === target) ?? null
  }

  private findJobForMessage(
    event: MessageEvent<CanvasThumbnailWorkerMessage>
  ): CanvasThumbnailWorkerJob | null {
    const worker = this.getKnownWorker(event.currentTarget)
    const workerJob = worker ? this.activeJobsByWorker.get(worker) : null
    if (workerJob?.requestId === event.data?.requestId) {
      return workerJob
    }
    return (
      Array.from(this.activeJobsByWorker.values()).find(
        (job) => job.requestId === event.data?.requestId
      ) ?? null
    )
  }

  private onMessage = (event: MessageEvent<CanvasThumbnailWorkerMessage>): void => {
    const message = event.data
    if (!message?.requestId) {
      return
    }

    const job = this.findJobForMessage(event)
    if (!job) {
      return
    }
    if (message.type === 'first-level') {
      // Not the end of the job: its timeout keeps running and the worker stays busy.
      if (!job.firstLevel && message.level) {
        job.firstLevel = message.level
        for (const listener of job.firstLevelListeners.splice(0)) {
          this.notifyFirstLevel(listener, message.level)
        }
      }
      return
    }
    if (message.type === 'error') {
      this.failJob(job, new Error(message.error), false)
      return
    }
    this.succeedJob(job, message.levels)
  }

  private onError = (event: Event): void => {
    const worker = this.getKnownWorker(event.currentTarget)
    const job = worker ? this.activeJobsByWorker.get(worker) : null
    if (job) {
      this.failJob(job, new Error('Thumbnail worker failed.'), true)
    }
  }
}
