import {
  CANVAS_THUMBNAIL_LEVELS,
  type CanvasThumbnailGenerationRequest,
  type CanvasThumbnailLevelSize,
  type CanvasThumbnailWorkerGenerateMessage,
  type CanvasThumbnailWorkerGeneratedLevel,
  type CanvasThumbnailWorkerMessage
} from './canvasThumbnailTypes'

const DEFAULT_WORKER_POOL_MAX_SIZE = 2
export const DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_MAX_QUEUE_SIZE = 32
export const DEFAULT_CANVAS_THUMBNAIL_WORKER_POOL_IDLE_TTL_MS = 30_000

export type CanvasThumbnailWorkerPoolOptions = {
  maxWorkers: number
  maxQueueSize: number
  requestTimeoutMs: number
  idleWorkerTtlMs: number
}

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
}

type CanvasThumbnailWorkerJob = {
  key: string
  requestId: string
  request: CanvasThumbnailGenerationRequest
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

export function getDefaultCanvasThumbnailWorkerPoolMaxSize(): number {
  const hardwareConcurrency =
    typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
      ? Math.floor(navigator.hardwareConcurrency)
      : DEFAULT_WORKER_POOL_MAX_SIZE + 1
  return Math.max(1, Math.min(DEFAULT_WORKER_POOL_MAX_SIZE, hardwareConcurrency - 1))
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
  return [
    identity.cacheKey,
    identity.canonicalPath,
    Math.floor(identity.sizeBytes),
    Math.floor(identity.lastModifiedMs),
    identity.cacheRootDir ?? '',
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
): CanvasThumbnailWorkerPoolOptions {
  return {
    maxWorkers: Math.max(1, Math.floor(options.maxWorkers)),
    maxQueueSize: Math.max(0, Math.floor(options.maxQueueSize)),
    requestTimeoutMs: Math.max(1, Math.floor(options.requestTimeoutMs)),
    idleWorkerTtlMs: Math.max(0, Math.floor(options.idleWorkerTtlMs))
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
  private options: CanvasThumbnailWorkerPoolOptions
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
      return existing.promise
    }

    let resolveJob: (levels: readonly CanvasThumbnailWorkerGeneratedLevel[] | null) => void = () =>
      undefined
    let rejectJob: (error: unknown) => void = () => undefined
    const job: CanvasThumbnailWorkerJob = {
      key,
      requestId: this.createRequestId(),
      request,
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
    const dispatched = this.dispatch(job)
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
      maxQueueSize: this.options.maxQueueSize
    }
  }

  private dispatch(job: CanvasThumbnailWorkerJob): 'started' | 'full' | 'unavailable' {
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
      preferWebp: job.request.preferWebp ?? true
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
    const timeoutId = this.setTimeout(() => {
      if (!this.activeJobsByWorker.has(worker)) {
        this.terminateWorker(worker)
      }
    }, this.options.idleWorkerTtlMs)
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
