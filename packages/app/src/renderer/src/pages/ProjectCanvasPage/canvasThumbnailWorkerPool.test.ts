import { describe, expect, it } from 'vitest'

import { CanvasThumbnailWorkerPool } from './canvasThumbnailWorkerPool'
import type {
  CanvasImageSourceIdentity,
  CanvasThumbnailGenerationRequest,
  CanvasThumbnailLevelSize,
  CanvasThumbnailWorkerGenerateMessage,
  CanvasThumbnailWorkerGeneratedLevel,
  CanvasThumbnailWorkerMessage
} from './canvasThumbnailTypes'

class MockThumbnailWorker {
  static instances: MockThumbnailWorker[] = []

  readonly messages: CanvasThumbnailWorkerGenerateMessage[] = []
  terminated = false
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor() {
    MockThumbnailWorker.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: CanvasThumbnailWorkerGenerateMessage): void {
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(message: CanvasThumbnailWorkerMessage): void {
    const event = {
      data: message,
      currentTarget: this
    } as unknown as MessageEvent<CanvasThumbnailWorkerMessage>
    this.listeners.get('message')?.forEach((listener) => listener(event))
  }

  emitError(): void {
    const event = { currentTarget: this } as unknown as Event
    this.listeners.get('error')?.forEach((listener) => listener(event))
  }
}

class TestScheduler {
  private nextId = 1
  private readonly callbacks = new Map<number, () => void>()
  private readonly delaysById = new Map<number, number>()

  setTimeout = (handler: () => void, timeoutMs = 0): number => {
    const id = this.nextId
    this.nextId += 1
    this.callbacks.set(id, handler)
    this.delaysById.set(id, timeoutMs)
    return id
  }

  /** Delays of the pending callbacks, in the order they were armed. */
  get delays(): number[] {
    return [...this.callbacks.keys()].map((id) => this.delaysById.get(id) ?? 0)
  }

  /** Runs every pending callback armed with this delay (not the ones they arm). */
  runDelay(timeoutMs: number): void {
    const due = [...this.callbacks.keys()].filter((id) => this.delaysById.get(id) === timeoutMs)
    due.forEach((id) => {
      const callback = this.callbacks.get(id)
      this.callbacks.delete(id)
      callback?.()
    })
  }

  clearTimeout = (id: number): void => {
    this.callbacks.delete(id)
  }

  get size(): number {
    return this.callbacks.size
  }

  runNext(): void {
    const id = this.callbacks.keys().next().value as number | undefined
    if (id === undefined) return
    const callback = this.callbacks.get(id)
    this.callbacks.delete(id)
    callback?.()
  }
}

function createIdentity(id: string): CanvasImageSourceIdentity {
  return {
    version: 1,
    kind: 'local-file',
    canonicalPath: `C:/images/${id}.png`,
    sizeBytes: 1024 + id.length,
    lastModifiedMs: 1000 + id.length,
    cacheKey: `cache-${id}`
  }
}

function createRequest(
  id: string,
  levels: readonly CanvasThumbnailLevelSize[] = [128]
): CanvasThumbnailGenerationRequest {
  return {
    source: new Blob([`source-${id}`], { type: 'image/png' }),
    identity: createIdentity(id),
    levels,
    preferWebp: true
  }
}

function createLevel(maxSide: CanvasThumbnailLevelSize = 128): CanvasThumbnailWorkerGeneratedLevel {
  return {
    maxSide,
    width: maxSide,
    height: Math.max(1, Math.round(maxSide / 2)),
    mimeType: 'image/webp',
    format: 'webp',
    blob: new Blob([`thumb-${maxSide}`], { type: 'image/webp' })
  }
}

function successMessage(
  worker: MockThumbnailWorker,
  levels: CanvasThumbnailWorkerGeneratedLevel[] = [createLevel()]
): CanvasThumbnailWorkerMessage {
  return {
    type: 'success',
    requestId: worker.messages.at(-1)?.requestId ?? 'missing-request-id',
    levels
  }
}

function createPool({
  maxWorkers = 1,
  maxQueueSize = 4,
  requestTimeoutMs = 1000,
  idleWorkerTtlMs = 1000,
  drainedWorkerTtlMs,
  scheduler = new TestScheduler(),
  createWorker = () => new MockThumbnailWorker() as unknown as Worker
}: {
  maxWorkers?: number
  maxQueueSize?: number
  requestTimeoutMs?: number
  idleWorkerTtlMs?: number
  drainedWorkerTtlMs?: number
  scheduler?: TestScheduler
  createWorker?: () => Worker | null
} = {}) {
  MockThumbnailWorker.instances = []
  const pool = new CanvasThumbnailWorkerPool(
    { maxWorkers, maxQueueSize, requestTimeoutMs, idleWorkerTtlMs, drainedWorkerTtlMs },
    {
      createWorker,
      createRequestId: () => `request-${Math.random().toString(36).slice(2)}`,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout
    }
  )
  return { pool, scheduler }
}

describe('CanvasThumbnailWorkerPool', () => {
  it('deduplicates in-flight requests by source identity and requested levels', async () => {
    const { pool } = createPool()
    const request = createRequest('dedupe')

    const first = pool.generate(request)
    const second = pool.generate(request)

    expect(second).toBe(first)
    expect(MockThumbnailWorker.instances).toHaveLength(1)
    expect(MockThumbnailWorker.instances[0]?.messages).toHaveLength(1)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        activeRequestCount: 1,
        inFlightKeyCount: 1,
        dedupedRequestCount: 1
      })
    )

    MockThumbnailWorker.instances[0]?.emit(successMessage(MockThumbnailWorker.instances[0]))

    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toHaveLength(1)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        activeRequestCount: 0,
        idleWorkerCount: 1,
        inFlightKeyCount: 0,
        completedRequestCount: 1
      })
    )
  })

  it('rejects overflow requests once all workers and queue slots are full', async () => {
    const { pool } = createPool({ maxWorkers: 1, maxQueueSize: 1 })

    const active = pool.generate(createRequest('active'))
    const queued = pool.generate(createRequest('queued'))
    const overflow = pool.generate(createRequest('overflow'))

    await expect(overflow).resolves.toBeNull()
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        activeRequestCount: 1,
        queuedRequestCount: 1,
        inFlightKeyCount: 2,
        rejectedRequestCount: 1
      })
    )

    const firstWorker = MockThumbnailWorker.instances[0]
    firstWorker?.emit(successMessage(firstWorker))
    await expect(active).resolves.toHaveLength(1)

    expect(firstWorker?.messages).toHaveLength(2)
    firstWorker?.emit(successMessage(firstWorker))
    await expect(queued).resolves.toHaveLength(1)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        queuedRequestCount: 0,
        completedRequestCount: 2
      })
    )
  })

  it('replaces failed workers and continues draining queued jobs', async () => {
    const { pool } = createPool({ maxWorkers: 1, maxQueueSize: 2 })
    const active = pool.generate(createRequest('active-error'))
    const activeFailure = expect(active).rejects.toThrow('Thumbnail worker failed.')
    const queued = pool.generate(createRequest('queued-after-error'))

    const failedWorker = MockThumbnailWorker.instances[0]
    failedWorker?.emitError()

    await activeFailure
    expect(failedWorker?.terminated).toBe(true)
    expect(MockThumbnailWorker.instances).toHaveLength(2)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        failedWorkerCount: 1,
        activeRequestCount: 1,
        queuedRequestCount: 0
      })
    )

    const replacementWorker = MockThumbnailWorker.instances[1]
    replacementWorker?.emit(successMessage(replacementWorker))
    await expect(queued).resolves.toHaveLength(1)
    expect(pool.getMetrics()).toEqual(expect.objectContaining({ completedRequestCount: 1 }))
  })

  it('times out active jobs, rejects them, and replaces the stuck worker', async () => {
    const { pool, scheduler } = createPool({ requestTimeoutMs: 10 })
    const active = pool.generate(createRequest('timeout'))
    const activeFailure = expect(active).rejects.toThrow('Thumbnail worker timed out.')
    const worker = MockThumbnailWorker.instances[0]

    scheduler.runNext()

    await activeFailure
    expect(worker?.terminated).toBe(true)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        timedOutRequestCount: 1,
        failedWorkerCount: 1,
        activeRequestCount: 0,
        inFlightKeyCount: 0
      })
    )
  })

  it('expires idle workers after the configured TTL', async () => {
    const { pool, scheduler } = createPool({ idleWorkerTtlMs: 25 })
    const generated = pool.generate(createRequest('idle'))
    const worker = MockThumbnailWorker.instances[0]

    worker?.emit(successMessage(worker))

    await expect(generated).resolves.toHaveLength(1)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        workerCount: 1,
        idleWorkerCount: 1,
        completedRequestCount: 1
      })
    )
    expect(scheduler.size).toBe(1)

    scheduler.runNext()

    expect(worker?.terminated).toBe(true)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        workerCount: 0,
        idleWorkerCount: 0
      })
    )
  })

  it('resets active and queued work, terminates workers, and clears counters', async () => {
    const { pool } = createPool({ maxWorkers: 1, maxQueueSize: 1 })
    const active = pool.generate(createRequest('reset-active'))
    const queued = pool.generate(createRequest('reset-queued'))
    const overflow = pool.generate(createRequest('reset-overflow'))
    const worker = MockThumbnailWorker.instances[0]

    await expect(overflow).resolves.toBeNull()
    expect(pool.getMetrics().rejectedRequestCount).toBe(1)

    pool.reset()

    await expect(active).resolves.toBeNull()
    await expect(queued).resolves.toBeNull()
    expect(worker?.terminated).toBe(true)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        workerCount: 0,
        queuedRequestCount: 0,
        inFlightKeyCount: 0,
        rejectedRequestCount: 0,
        completedRequestCount: 0
      })
    )
  })

  it('resolves with null when no worker can be spawned', async () => {
    const { pool } = createPool({ createWorker: () => null })

    await expect(pool.generate(createRequest('no-worker'))).resolves.toBeNull()
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        workerCount: 0,
        activeRequestCount: 0,
        queuedRequestCount: 0,
        inFlightKeyCount: 0,
        rejectedRequestCount: 0
      })
    )
  })

  it('dispatches concurrent jobs up to maxWorkers before queueing', async () => {
    const { pool } = createPool({ maxWorkers: 2, maxQueueSize: 2 })
    const first = pool.generate(createRequest('parallel-1'))
    const second = pool.generate(createRequest('parallel-2'))
    const queued = pool.generate(createRequest('parallel-3'))

    expect(MockThumbnailWorker.instances).toHaveLength(2)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        workerCount: 2,
        activeRequestCount: 2,
        queuedRequestCount: 1
      })
    )

    const firstWorker = MockThumbnailWorker.instances[0]
    const secondWorker = MockThumbnailWorker.instances[1]
    firstWorker?.emit(successMessage(firstWorker))
    secondWorker?.emit(successMessage(secondWorker))

    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toHaveLength(1)
    expect(pool.getMetrics()).toEqual(
      expect.objectContaining({
        activeRequestCount: 1,
        queuedRequestCount: 0,
        completedRequestCount: 2
      })
    )

    const workerWithQueuedJob = MockThumbnailWorker.instances.find(
      (worker) => worker.messages.length > 1
    )
    workerWithQueuedJob?.emit(successMessage(workerWithQueuedJob))
    await expect(queued).resolves.toHaveLength(1)
    expect(pool.getMetrics().completedRequestCount).toBe(3)
  })
  describe('when the queue drains', () => {
    const IDLE_TTL_MS = 30_000
    const DRAINED_TTL_MS = 1_000
    const createDrainingPool = (options: { maxWorkers?: number; maxQueueSize?: number } = {}) =>
      createPool({
        maxWorkers: options.maxWorkers ?? 2,
        maxQueueSize: options.maxQueueSize ?? 4,
        requestTimeoutMs: 60_000,
        idleWorkerTtlMs: IDLE_TTL_MS,
        drainedWorkerTtlMs: DRAINED_TTL_MS
      })
    const finish = async (worker: MockThumbnailWorker | undefined, job: Promise<unknown>) => {
      worker?.emit(successMessage(worker))
      await expect(job).resolves.toHaveLength(1)
    }

    it('ends every idle worker soon after the last job, and starts new ones for the next import', async () => {
      const { pool, scheduler } = createDrainingPool()
      const first = pool.generate(createRequest('drain-1'))
      const second = pool.generate(createRequest('drain-2'))
      const [firstWorker, secondWorker] = MockThumbnailWorker.instances

      await finish(firstWorker, first)
      // The other job still runs: the idle worker keeps the normal idle TTL.
      expect(scheduler.delays).toEqual([60_000, IDLE_TTL_MS])

      await finish(secondWorker, second)
      // Nothing runs and nothing waits: both idle workers end after the short TTL.
      expect(scheduler.delays).toEqual([DRAINED_TTL_MS, DRAINED_TTL_MS])
      scheduler.runDelay(DRAINED_TTL_MS)
      expect(firstWorker?.terminated).toBe(true)
      expect(secondWorker?.terminated).toBe(true)
      expect(pool.getMetrics()).toEqual(
        expect.objectContaining({ workerCount: 0, idleWorkerCount: 0, activeRequestCount: 0 })
      )
      expect(scheduler.size).toBe(0)

      // The next import starts a worker again.
      const next = pool.generate(createRequest('drain-next'))
      expect(MockThumbnailWorker.instances).toHaveLength(3)
      await finish(MockThumbnailWorker.instances[2], next)
    })

    it('never ends a worker while a job runs or waits in the queue', async () => {
      const { pool, scheduler } = createDrainingPool({ maxWorkers: 1 })
      const first = pool.generate(createRequest('queued-1'))
      const queued = pool.generate(createRequest('queued-2'))
      const worker = MockThumbnailWorker.instances[0]

      await finish(worker, first)
      // The queued job took the worker at once: no idle timer at all, only its request timeout.
      expect(worker?.messages).toHaveLength(2)
      expect(scheduler.delays).toEqual([60_000])
      expect(worker?.terminated).toBe(false)

      await finish(worker, queued)
      expect(scheduler.delays).toEqual([DRAINED_TTL_MS])
      scheduler.runDelay(DRAINED_TTL_MS)
      expect(worker?.terminated).toBe(true)
    })

    it('keeps an idle worker that a new job reached before its short wait ran out', async () => {
      const { pool, scheduler } = createDrainingPool()
      const first = pool.generate(createRequest('race-1'))
      const second = pool.generate(createRequest('race-2'))
      const [firstWorker, secondWorker] = MockThumbnailWorker.instances
      await finish(firstWorker, first)
      await finish(secondWorker, second)
      expect(scheduler.delays).toEqual([DRAINED_TTL_MS, DRAINED_TTL_MS])

      // A second import arrives while both short waits run.
      const next = pool.generate(createRequest('race-next'))
      expect(MockThumbnailWorker.instances).toHaveLength(2)
      const busyWorker = [firstWorker, secondWorker].find((worker) => worker?.messages.length === 2)
      const spareWorker = [firstWorker, secondWorker].find((worker) => worker !== busyWorker)
      // The other worker's short wait runs out while the job runs: it stays as a spare.
      scheduler.runDelay(DRAINED_TTL_MS)
      expect(busyWorker?.terminated).toBe(false)
      expect(spareWorker?.terminated).toBe(false)
      expect(scheduler.delays).toEqual([60_000, IDLE_TTL_MS])

      await finish(busyWorker, next)
      expect(scheduler.delays).toEqual([DRAINED_TTL_MS, DRAINED_TTL_MS])
      scheduler.runDelay(DRAINED_TTL_MS)
      expect(busyWorker?.terminated).toBe(true)
      expect(spareWorker?.terminated).toBe(true)
      expect(pool.getMetrics().workerCount).toBe(0)
    })

    it('ends the idle workers after a failed last job too', async () => {
      const { pool, scheduler } = createDrainingPool()
      const failing = pool.generate(createRequest('fail-last'))
      const failure = expect(failing).rejects.toThrow('boom')
      const worker = MockThumbnailWorker.instances[0]
      worker?.emit({ type: 'error', requestId: worker.messages[0]!.requestId, error: 'boom' })
      await failure

      expect(scheduler.delays).toEqual([DRAINED_TTL_MS])
      scheduler.runDelay(DRAINED_TTL_MS)
      expect(worker?.terminated).toBe(true)
    })
  })
})
