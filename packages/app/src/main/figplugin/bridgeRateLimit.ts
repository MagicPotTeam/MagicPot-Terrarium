export type FigPluginBridgeRateLimitOptions = {
  windowMs?: number
  maxRequests?: number
  maxKeys?: number
  now?: () => number
}

type Bucket = {
  startedAt: number
  count: number
}

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_REQUESTS = 120
const DEFAULT_MAX_KEYS = 512

const boundedPositiveInteger = (value: number | undefined, fallback: number, maximum: number) =>
  Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : fallback

/**
 * Small fixed-window limiter for the loopback bridge. The key is supplied by
 * the transport after it has validated the request's peer and credentials.
 * Bounded key storage prevents a local process from turning rate limiting into
 * an unbounded memory sink.
 */
export function createFigPluginBridgeRateLimiter(options: FigPluginBridgeRateLimitOptions = {}) {
  const windowMs = boundedPositiveInteger(options.windowMs, DEFAULT_WINDOW_MS, 15 * 60_000)
  const maxRequests = boundedPositiveInteger(options.maxRequests, DEFAULT_MAX_REQUESTS, 10_000)
  const maxKeys = boundedPositiveInteger(options.maxKeys, DEFAULT_MAX_KEYS, 4096)
  const now = options.now ?? Date.now
  const buckets = new Map<string, Bucket>()

  const prune = (timestamp: number): void => {
    for (const [key, bucket] of buckets) {
      if (timestamp - bucket.startedAt >= windowMs) buckets.delete(key)
    }
  }

  const consume = (key: string): boolean => {
    const timestamp = now()
    prune(timestamp)
    const existing = buckets.get(key)
    if (existing && timestamp - existing.startedAt < windowMs) {
      if (existing.count >= maxRequests) return false
      existing.count += 1
      return true
    }
    if (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next().value
      if (typeof oldest === 'string') buckets.delete(oldest)
    }
    buckets.set(key, { startedAt: timestamp, count: 1 })
    return true
  }

  return {
    consume,
    clear: () => buckets.clear()
  }
}
