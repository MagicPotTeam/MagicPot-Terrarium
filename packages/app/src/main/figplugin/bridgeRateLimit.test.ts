import { describe, expect, it } from 'vitest'
import { createFigPluginBridgeRateLimiter } from './bridgeRateLimit'

describe('FIGPLUGIN bridge rate limiter', () => {
  it('limits a credential or anonymous peer within a bounded window', () => {
    let timestamp = 1_000
    const limiter = createFigPluginBridgeRateLimiter({
      windowMs: 100,
      maxRequests: 2,
      now: () => timestamp
    })

    expect(limiter.consume('session:a')).toBe(true)
    expect(limiter.consume('session:a')).toBe(true)
    expect(limiter.consume('session:a')).toBe(false)
    expect(limiter.consume('session:b')).toBe(true)
    timestamp += 100
    expect(limiter.consume('session:a')).toBe(true)
  })

  it('bounds key storage by evicting the oldest active key', () => {
    const limiter = createFigPluginBridgeRateLimiter({ maxKeys: 2, maxRequests: 1 })
    expect(limiter.consume('a')).toBe(true)
    expect(limiter.consume('b')).toBe(true)
    expect(limiter.consume('c')).toBe(true)
    expect(limiter.consume('a')).toBe(true)
  })

  it('clears state for transport shutdown', () => {
    const limiter = createFigPluginBridgeRateLimiter({ maxRequests: 1 })
    expect(limiter.consume('session:a')).toBe(true)
    expect(limiter.consume('session:a')).toBe(false)
    limiter.clear()
    expect(limiter.consume('session:a')).toBe(true)
  })
})
