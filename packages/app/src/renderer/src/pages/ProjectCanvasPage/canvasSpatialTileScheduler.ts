import type {
  CanvasSpatialTileBrowserCropRequest,
  CanvasSpatialTileBrowserCropResult
} from './canvasSpatialTileWorkerProtocol'

export type CanvasSpatialTileSchedulerPriority = 'visible' | 'overscan'
export type CanvasSpatialTileSchedulerTask = CanvasSpatialTileBrowserCropRequest & {
  tileKey: string
  priority: CanvasSpatialTileSchedulerPriority
  signal?: AbortSignal
  generation?: number
  scopeKey?: string
  isGenerationCurrent?: () => boolean
  onStaleResult?: (result: CanvasSpatialTileBrowserCropResult) => void
}
export type CanvasSpatialTileSchedulerExecutor = {
  generate: (
    request: CanvasSpatialTileBrowserCropRequest
  ) => Promise<CanvasSpatialTileBrowserCropResult>
}
export type CanvasSpatialTileSchedulerMetrics = {
  queued: number
  running: number
  completed: number
  cancelled: number
  deduped: number
  failed: number
  staleDisposed: number
}

type Entry = {
  task: CanvasSpatialTileSchedulerTask
  resolve: (result: CanvasSpatialTileBrowserCropResult) => void
  reject: (error: unknown) => void
  stale: boolean
  abortListener?: () => void
}

const abortError = () => new DOMException('Tile generation cancelled.', 'AbortError')

export class CanvasSpatialTileScheduler {
  private readonly queue: Entry[] = []
  private readonly entries = new Map<string, Entry>()
  private running = 0
  private readonly metricsState: CanvasSpatialTileSchedulerMetrics = {
    queued: 0,
    running: 0,
    completed: 0,
    cancelled: 0,
    deduped: 0,
    failed: 0,
    staleDisposed: 0
  }

  constructor(
    private readonly executor: CanvasSpatialTileSchedulerExecutor,
    private readonly maxConcurrent = 2
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
      throw new Error('maxConcurrent must be positive.')
  }

  schedule(task: CanvasSpatialTileSchedulerTask): Promise<CanvasSpatialTileBrowserCropResult> {
    const existing = this.entries.get(task.tileKey)
    if (existing) {
      this.metricsState.deduped++
      if (!existing.stale && existing.task.priority === 'overscan' && task.priority === 'visible') {
        existing.task.priority = 'visible'
        this.sortQueue()
      }
      return new Promise((resolve, reject) => {
        const originalResolve = existing.resolve
        const originalReject = existing.reject
        existing.resolve = (result) => {
          originalResolve(result)
          resolve(result)
        }
        existing.reject = (error) => {
          originalReject(error)
          reject(error)
        }
      })
    }
    const promise = new Promise<CanvasSpatialTileBrowserCropResult>((resolve, reject) => {
      const entry: Entry = { task, resolve, reject, stale: false }
      if (task.signal) {
        const onAbort = () => this.cancel(task.tileKey)
        entry.abortListener = onAbort
        if (task.signal.aborted) entry.stale = true
        else task.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.entries.set(task.tileKey, entry)
      this.queue.push(entry)
      this.metricsState.queued++
      this.sortQueue()
      this.pump()
    })
    return promise
  }

  cancel(tileKey: string): void {
    const entry = this.entries.get(tileKey)
    if (!entry || entry.stale) return
    entry.stale = true
    this.metricsState.cancelled++
    if (this.queue.includes(entry)) {
      this.queue.splice(this.queue.indexOf(entry), 1)
      this.metricsState.queued--
      this.entries.delete(tileKey)
      this.removeAbortListener(entry)
      entry.reject(abortError())
    }
  }

  getMetrics(): CanvasSpatialTileSchedulerMetrics {
    return { ...this.metricsState, running: this.running }
  }

  private sortQueue(): void {
    this.queue.sort((a, b) =>
      a.task.priority === b.task.priority ? 0 : a.task.priority === 'visible' ? -1 : 1
    )
  }

  private pump(): void {
    this.sortQueue()
    while (this.running < this.maxConcurrent && this.queue.length) {
      const entry = this.queue.shift()!
      this.metricsState.queued--
      this.running++
      void this.execute(entry)
    }
  }

  private async execute(entry: Entry): Promise<void> {
    const { task } = entry
    if (entry.stale || task.signal?.aborted || task.isGenerationCurrent?.() === false) {
      entry.stale = true
      this.finishStale(entry)
      return
    }
    try {
      const result = await this.executor.generate(task)
      const stale = entry.stale || task.signal?.aborted || task.isGenerationCurrent?.() === false
      if (stale) {
        task.onStaleResult?.(result)
        this.metricsState.staleDisposed++
        entry.reject(abortError())
      } else {
        this.metricsState.completed++
        entry.resolve(result)
      }
    } catch (error) {
      if (entry.stale || task.signal?.aborted || task.isGenerationCurrent?.() === false) {
        entry.reject(abortError())
      } else {
        this.metricsState.failed++
        entry.reject(error)
      }
    } finally {
      this.removeAbortListener(entry)
      this.entries.delete(task.tileKey)
      this.running--
      this.metricsState.running = this.running
      this.pump()
    }
  }

  private finishStale(entry: Entry): void {
    this.metricsState.staleDisposed++
    this.removeAbortListener(entry)
    this.entries.delete(entry.task.tileKey)
    this.running--
    this.metricsState.running = this.running
    entry.reject(abortError())
    this.pump()
  }

  private removeAbortListener(entry: Entry): void {
    if (entry.abortListener && entry.task.signal)
      entry.task.signal.removeEventListener('abort', entry.abortListener)
    entry.abortListener = undefined
  }
}
