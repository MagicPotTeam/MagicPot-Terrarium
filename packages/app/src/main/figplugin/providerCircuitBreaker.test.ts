import { describe, expect, it, vi } from 'vitest'
import { ProviderCircuitBreaker } from './providerCircuitBreaker'

describe('ProviderCircuitBreaker', () => {
  it('opens after consecutive failures and allows one probe after cooldown', () => {
    let now = 1_000
    const breaker = new ProviderCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 100,
      now: () => now
    })

    expect(breaker.allow('openai:profile')).toBe(true)
    breaker.complete('openai:profile', 'failure')
    expect(breaker.snapshot('openai:profile')).toMatchObject({
      state: 'closed',
      failureCount: 1
    })
    expect(breaker.allow('openai:profile')).toBe(true)
    breaker.complete('openai:profile', 'failure')
    expect(breaker.snapshot('openai:profile')).toMatchObject({
      state: 'open',
      failureCount: 2,
      retryAt: 1_100
    })
    expect(breaker.allow('openai:profile')).toBe(false)

    now = 1_100
    expect(breaker.allow('openai:profile')).toBe(true)
    expect(breaker.allow('openai:profile')).toBe(false)
    breaker.complete('openai:profile', 'success')
    expect(breaker.snapshot('openai:profile')).toEqual({
      key: 'openai:profile',
      state: 'closed',
      failureCount: 0,
      probeInFlight: false
    })
    expect(breaker.allow('openai:profile')).toBe(true)
  })

  it('reopens after a failed half-open probe and isolates keys', () => {
    let now = 0
    const breaker = new ProviderCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 50,
      now: () => now
    })
    expect(breaker.allow('a')).toBe(true)
    breaker.complete('a', 'failure')
    expect(breaker.allow('b')).toBe(true)
    breaker.complete('b', 'success')
    expect(breaker.allow('a')).toBe(false)

    now = 50
    expect(breaker.allow('a')).toBe(true)
    breaker.complete('a', 'failure')
    expect(breaker.snapshot('a')).toMatchObject({ state: 'open', retryAt: 100 })
    expect(breaker.snapshot('b')).toMatchObject({ state: 'closed', failureCount: 0 })
  })

  it('does not count cancellation as provider failure', () => {
    const now = vi.fn(() => 10)
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 1, now })
    expect(breaker.allow('provider')).toBe(true)
    breaker.complete('provider', 'unknown')
    expect(breaker.snapshot('provider')).toMatchObject({
      state: 'closed',
      failureCount: 0,
      probeInFlight: false
    })
  })

  it('keeps profile state bounded and resettable', () => {
    let now = 0
    const breaker = new ProviderCircuitBreaker({ maxEntries: 2, now: () => ++now })
    expect(breaker.allow('one')).toBe(true)
    expect(breaker.allow('two')).toBe(true)
    expect(breaker.allow('three')).toBe(true)
    expect(breaker.snapshot('one').state).toBe('closed')
    breaker.reset('one')
    expect(breaker.snapshot('one')).toEqual({
      key: 'one',
      state: 'closed',
      failureCount: 0,
      probeInFlight: false
    })
    breaker.reset()
    expect(breaker.snapshot('three')).toEqual({
      key: 'three',
      state: 'closed',
      failureCount: 0,
      probeInFlight: false
    })
  })

  it('keeps safe outcome, latency and correlation diagnostics behind detailed snapshots', () => {
    let now = 100
    const breaker = new ProviderCircuitBreaker({ now: () => now, failureThreshold: 1 })
    const correlationId = 'a'.repeat(32)
    expect(breaker.allow('provider')).toBe(true)
    now = 145
    breaker.complete('provider', 'failure', {
      failureClass: 'upstream',
      correlationId
    })

    // Existing callers receive the stable circuit shape by default.
    expect(breaker.snapshot('provider')).toEqual({
      key: 'provider',
      state: 'open',
      failureCount: 1,
      retryAt: 145 + 30_000,
      probeInFlight: false
    })
    expect(breaker.snapshot('provider', { detailed: true })).toEqual({
      key: 'provider',
      state: 'open',
      failureCount: 1,
      retryAt: 145 + 30_000,
      probeInFlight: false,
      lastOutcome: 'failure',
      lastOutcomeAt: 145,
      lastLatencyMs: 45,
      lastFailureClass: 'upstream',
      lastCorrelationId: correlationId
    })
  })

  it('does not retain malformed correlation identifiers in diagnostics', () => {
    let now = 10
    const breaker = new ProviderCircuitBreaker({ now: () => now })
    expect(breaker.allow('provider')).toBe(true)
    now = 11
    breaker.complete('provider', 'unknown', { correlationId: 'not-a-correlation-id' })
    expect(breaker.snapshot('provider', { detailed: true })).toMatchObject({
      lastOutcome: 'unknown',
      lastOutcomeAt: 11,
      lastLatencyMs: 1
    })
    expect(breaker.snapshot('provider', { detailed: true })).not.toHaveProperty('lastCorrelationId')
  })
})
