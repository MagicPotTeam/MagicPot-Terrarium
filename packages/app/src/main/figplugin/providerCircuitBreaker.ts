export type ProviderCircuitState = 'closed' | 'open' | 'half-open'

export type ProviderCircuitOutcome = 'success' | 'failure' | 'unknown'

/** Bounded, non-sensitive categories used by health diagnostics. */
export type ProviderCircuitFailureClass =
  'upstream' | 'timeout' | 'cancelled' | 'configuration' | 'unknown'

/** Internal sentinel used to preserve a stable public bridge error. */
export class ProviderCircuitOpenError extends Error {
  readonly code = 'PROVIDER_CIRCUIT_OPEN'

  constructor() {
    super('Provider circuit is open')
    this.name = 'ProviderCircuitOpenError'
  }
}

export type ProviderCircuitSnapshot = {
  key: string
  state: ProviderCircuitState
  failureCount: number
  retryAt?: number
  probeInFlight: boolean
}

export type ProviderCircuitSnapshotDetails = {
  lastOutcome?: ProviderCircuitOutcome
  lastOutcomeAt?: number
  lastLatencyMs?: number
  lastFailureClass?: ProviderCircuitFailureClass
  /** Correlation only; never request payloads, credentials or provider text. */
  lastCorrelationId?: string
}

export type ProviderCircuitDetailedSnapshot = ProviderCircuitSnapshot &
  ProviderCircuitSnapshotDetails

export type ProviderCircuitCompletion = {
  failureClass?: ProviderCircuitFailureClass
  correlationId?: string
}

const isCorrelationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)

type Entry = {
  state: ProviderCircuitState
  failureCount: number
  retryAt?: number
  probeInFlight: boolean
  touchedAt: number
  attemptStartedAt?: number
  lastOutcome?: ProviderCircuitOutcome
  lastOutcomeAt?: number
  lastLatencyMs?: number
  lastFailureClass?: ProviderCircuitFailureClass
  lastCorrelationId?: string
}

export type ProviderCircuitBreakerOptions = {
  /** Consecutive provider failures required before requests are blocked. */
  failureThreshold?: number
  /** Delay before one half-open probe is allowed after the circuit opens. */
  cooldownMs?: number
  /** Keep the map bounded when profiles are changed repeatedly in one process. */
  maxEntries?: number
  now?: () => number
}

/**
 * Small in-memory provider circuit breaker. It deliberately tracks only provider
 * outcomes, never request payloads, credentials, or error text.
 */
export class ProviderCircuitBreaker {
  private readonly entries = new Map<string, Entry>()
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: ProviderCircuitBreakerOptions = {}) {
    this.failureThreshold = Number.isSafeInteger(options.failureThreshold)
      ? Math.max(1, options.failureThreshold!)
      : 3
    this.cooldownMs = Number.isSafeInteger(options.cooldownMs)
      ? Math.max(1, options.cooldownMs!)
      : 30_000
    this.maxEntries = Number.isSafeInteger(options.maxEntries)
      ? Math.max(1, options.maxEntries!)
      : 128
    this.now = options.now ?? Date.now
  }

  /** Return whether a provider attempt may start. Half-open allows one probe. */
  allow(key: string): boolean {
    if (!key) return false
    const now = this.now()
    const entry = this.entries.get(key)
    if (!entry) {
      this.entries.set(key, {
        state: 'closed',
        failureCount: 0,
        probeInFlight: false,
        touchedAt: now,
        attemptStartedAt: now
      })
      this.prune()
      return true
    }
    entry.touchedAt = now
    if (entry.state === 'closed') {
      // Closed circuits may admit concurrent calls; retain only the newest start
      // marker so diagnostics never claim an unbounded request duration.
      entry.attemptStartedAt = now
      return true
    }
    if (entry.state === 'open') {
      if (entry.retryAt === undefined || now < entry.retryAt) return false
      entry.state = 'half-open'
    }
    if (entry.probeInFlight) return false
    entry.probeInFlight = true
    entry.attemptStartedAt = now
    return true
  }

  /** Complete an allowed attempt and update the provider state. */
  complete(
    key: string,
    outcome: ProviderCircuitOutcome,
    completion: ProviderCircuitCompletion = {}
  ): void {
    const entry = this.entries.get(key)
    if (!entry) return
    const now = this.now()
    entry.touchedAt = now
    entry.lastOutcome = outcome
    entry.lastOutcomeAt = now
    if (entry.attemptStartedAt !== undefined) {
      entry.lastLatencyMs = Math.max(0, now - entry.attemptStartedAt)
      entry.attemptStartedAt = undefined
    }
    entry.lastFailureClass = completion.failureClass
    entry.lastCorrelationId = isCorrelationId(completion.correlationId)
      ? completion.correlationId
      : undefined
    if (outcome === 'success') {
      entry.state = 'closed'
      entry.failureCount = 0
      entry.retryAt = undefined
      entry.probeInFlight = false
      return
    }
    if (outcome === 'unknown') {
      // A cancelled request is not evidence of provider failure. Keep the
      // circuit open when releasing a half-open probe, so it cannot stampede.
      entry.probeInFlight = false
      if (entry.state === 'half-open') {
        entry.state = 'open'
        entry.retryAt = now + this.cooldownMs
      }
      return
    }
    entry.probeInFlight = false
    if (entry.state === 'half-open') {
      entry.state = 'open'
      entry.retryAt = now + this.cooldownMs
      return
    }
    entry.failureCount += 1
    if (entry.failureCount >= this.failureThreshold) {
      entry.state = 'open'
      entry.retryAt = now + this.cooldownMs
    }
  }

  snapshot(key: string): ProviderCircuitSnapshot
  snapshot(key: string, options: { detailed: true }): ProviderCircuitDetailedSnapshot
  snapshot(key: string, options: { detailed?: boolean } = {}): ProviderCircuitSnapshot {
    const entry = this.entries.get(key)
    if (!entry) {
      return { key, state: 'closed', failureCount: 0, probeInFlight: false }
    }
    const snapshot: ProviderCircuitSnapshot = {
      key,
      state: entry.state,
      failureCount: entry.failureCount,
      ...(entry.retryAt === undefined ? {} : { retryAt: entry.retryAt }),
      probeInFlight: entry.probeInFlight
    }
    if (!options.detailed) return snapshot
    return {
      ...snapshot,
      ...(entry.lastOutcome === undefined ? {} : { lastOutcome: entry.lastOutcome }),
      ...(entry.lastOutcomeAt === undefined ? {} : { lastOutcomeAt: entry.lastOutcomeAt }),
      ...(entry.lastLatencyMs === undefined ? {} : { lastLatencyMs: entry.lastLatencyMs }),
      ...(entry.lastFailureClass === undefined ? {} : { lastFailureClass: entry.lastFailureClass }),
      ...(entry.lastCorrelationId === undefined
        ? {}
        : { lastCorrelationId: entry.lastCorrelationId })
    }
  }

  reset(key?: string): void {
    if (key === undefined) this.entries.clear()
    else this.entries.delete(key)
  }

  private prune(): void {
    if (this.entries.size <= this.maxEntries) return
    const removable = [...this.entries.entries()]
      .filter(([, entry]) => !entry.probeInFlight)
      .sort(([, left], [, right]) => left.touchedAt - right.touchedAt)
    while (this.entries.size > this.maxEntries && removable.length) {
      const [key] = removable.shift()!
      this.entries.delete(key)
    }
  }
}
