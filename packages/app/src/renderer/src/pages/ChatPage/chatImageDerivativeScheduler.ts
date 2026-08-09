import type {
  EnsureManagedMediaDerivativeResp,
  ManagedMediaDerivativeMaxEdge,
  ManagedMediaSvc
} from '@shared/api/svcManagedMedia'
import type { MediaReference } from '@shared/mediaReference'

const CACHE_MAX_RESOLVED_ENTRIES = 256
const CACHE_MAX_PENDING_ENTRIES = 64
const RESOLVED_TTL_MS = 30 * 60 * 1000
const PENDING_TIMEOUT_MS = 30 * 1000

const abortError = (): DOMException => new DOMException('The operation was aborted', 'AbortError')

type QueueEntry<T> = {
  priority: number
  order: number
  signal?: AbortSignal
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  removeAbortListener?: () => void
}

export class CancellablePriorityScheduler {
  private readonly queue: QueueEntry<unknown>[] = []
  private activeCount = 0
  private nextOrder = 0
  private pumpScheduled = false

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Scheduler concurrency must be a positive integer')
    }
  }

  schedule<T>(
    task: () => Promise<T>,
    options: { priority: number; signal?: AbortSignal }
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortError())

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        priority: Number.isFinite(options.priority) ? options.priority : 0,
        order: this.nextOrder++,
        signal: options.signal,
        task,
        resolve,
        reject
      }
      const onAbort = () => {
        const index = this.queue.indexOf(entry as QueueEntry<unknown>)
        if (index < 0) return
        this.queue.splice(index, 1)
        entry.removeAbortListener?.()
        reject(abortError())
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      entry.removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
      this.queue.push(entry as QueueEntry<unknown>)
      this.requestPump()
    })
  }

  private requestPump(): void {
    if (this.pumpScheduled) return
    this.pumpScheduled = true
    queueMicrotask(() => {
      this.pumpScheduled = false
      this.pump()
    })
  }

  private pump(): void {
    this.queue.sort((left, right) => left.priority - right.priority || left.order - right.order)
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!
      entry.removeAbortListener?.()
      if (entry.signal?.aborted) {
        entry.reject(abortError())
        continue
      }
      this.activeCount += 1
      void Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.activeCount -= 1
          this.pump()
        })
    }
  }
}

type PendingCacheEntry = {
  state: 'pending'
  promise: Promise<EnsureManagedMediaDerivativeResp>
  token: object
  expiresAt: number
  reject: (error: unknown) => void
  timeoutId: ReturnType<typeof setTimeout>
  controller: AbortController
  callers: number
  started: boolean
}

type CacheEntry =
  | PendingCacheEntry
  | { state: 'resolved'; result: EnsureManagedMediaDerivativeResp; expiresAt: number }

const cache = new Map<string, CacheEntry>()
let scheduler = new CancellablePriorityScheduler(3)

export const getChatImageDerivativeCacheKey = (
  reference: MediaReference & { kind: 'managed'; sha256: string },
  maxEdge: ManagedMediaDerivativeMaxEdge
): string => `${reference.sha256}:${reference.relativePath}:${maxEdge}`

const rejectPendingEntry = (entry: PendingCacheEntry, error: Error): void => {
  clearTimeout(entry.timeoutId)
  entry.controller.abort()
  entry.reject(error)
}

const pruneCache = (now: number): void => {
  for (const [key, entry] of cache) {
    if (entry.expiresAt > now) continue
    cache.delete(key)
    if (entry.state === 'pending')
      rejectPendingEntry(entry, new Error('Managed media derivative request expired'))
  }

  const pending = [...cache].filter(([, entry]) => entry.state === 'pending')
  for (const [key, entry] of pending.slice(
    0,
    Math.max(0, pending.length - CACHE_MAX_PENDING_ENTRIES)
  )) {
    cache.delete(key)
    rejectPendingEntry(
      entry as PendingCacheEntry,
      new Error('Managed media derivative request evicted')
    )
  }

  const resolved = [...cache].filter(([, entry]) => entry.state === 'resolved')
  for (const [key] of resolved.slice(
    0,
    Math.max(0, resolved.length - CACHE_MAX_RESOLVED_ENTRIES)
  )) {
    cache.delete(key)
  }
}

const awaitWithAbort = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

const subscribe = (
  entry: PendingCacheEntry,
  signal: AbortSignal | undefined
): Promise<EnsureManagedMediaDerivativeResp> => {
  if (signal?.aborted) return Promise.reject(abortError())
  entry.callers += 1
  return awaitWithAbort(entry.promise, signal).finally(() => {
    entry.callers -= 1
    if (entry.callers === 0) entry.controller.abort()
  })
}

export const ensureCachedChatImageDerivative = (
  service: ManagedMediaSvc,
  reference: MediaReference & { kind: 'managed'; sha256: string },
  maxEdge: ManagedMediaDerivativeMaxEdge,
  options: { priority?: number; signal?: AbortSignal } = {}
): Promise<EnsureManagedMediaDerivativeResp> => {
  if (options.signal?.aborted) return Promise.reject(abortError())
  const key = getChatImageDerivativeCacheKey(reference, maxEdge)
  const now = Date.now()
  pruneCache(now)
  const cached = cache.get(key)
  if (cached?.state === 'resolved') {
    cache.delete(key)
    cache.set(key, { ...cached, expiresAt: now + RESOLVED_TTL_MS })
    return awaitWithAbort(Promise.resolve(cached.result), options.signal)
  }
  if (cached?.state === 'pending' && !cached.controller.signal.aborted) {
    return subscribe(cached, options.signal)
  }
  if (cached?.state === 'pending') cache.delete(key)

  const token = {}
  const controller = new AbortController()
  let rejectPending!: (error: unknown) => void
  const entry = {} as PendingCacheEntry
  const scheduled = scheduler.schedule(
    () => {
      entry.started = true
      return service.ensureDerivative({ reference, maxEdge })
    },
    { priority: options.priority ?? 0, signal: controller.signal }
  )
  const promise = new Promise<EnsureManagedMediaDerivativeResp>((resolve, reject) => {
    rejectPending = reject
    scheduled.then(resolve, reject)
  })
  const timeoutId = setTimeout(() => {
    if (cache.get(key) !== entry) return
    cache.delete(key)
    rejectPending(new Error('Managed media derivative request timed out'))
  }, PENDING_TIMEOUT_MS)
  Object.assign(entry, {
    state: 'pending',
    promise,
    token,
    expiresAt: now + PENDING_TIMEOUT_MS,
    reject: rejectPending,
    timeoutId,
    controller,
    callers: 0,
    started: false
  } satisfies PendingCacheEntry)
  cache.set(key, entry)
  void promise.then(
    (result) => {
      if (cache.get(key) !== entry) return
      clearTimeout(timeoutId)
      cache.delete(key)
      cache.set(key, { state: 'resolved', result, expiresAt: Date.now() + RESOLVED_TTL_MS })
      pruneCache(Date.now())
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key)
      clearTimeout(timeoutId)
    }
  )
  pruneCache(now)
  return subscribe(entry, options.signal)
}

export const resetChatImageDerivativeCacheForTests = (): void => {
  for (const entry of cache.values()) {
    if (entry.state === 'pending') {
      clearTimeout(entry.timeoutId)
      entry.controller.abort()
      void entry.promise.catch(() => undefined)
      entry.reject(new Error('Managed media derivative cache reset'))
    }
  }
  cache.clear()
  scheduler = new CancellablePriorityScheduler(3)
}

export const getChatImageDerivativeCacheSizeForTests = (): number => cache.size
