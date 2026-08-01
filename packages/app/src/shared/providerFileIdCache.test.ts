import { describe, expect, it } from 'vitest'
import { ProviderFileIdCache, type ProviderFileIdCacheKey } from './providerFileIdCache'

const key = (
  provider: string,
  accountIdentity = 'account-a',
  contentIdentity = 'sha256:content-a'
): ProviderFileIdCacheKey => ({ provider, accountIdentity, contentIdentity })

describe('ProviderFileIdCache', () => {
  it('scopes entries by provider, account, and content identity', () => {
    const cache = new ProviderFileIdCache()
    cache.set(key('provider-a'), { fileId: 'file-a' })

    expect(cache.get(key('provider-a'))).toEqual({ fileId: 'file-a' })
    expect(cache.get(key('provider-b'))).toBeUndefined()
    expect(cache.get(key('provider-a', 'account-b'))).toBeUndefined()
    expect(cache.get(key('provider-a', 'account-a', 'sha256:content-b'))).toBeUndefined()
  })

  it('never returns expired entries and removes them from the cache', () => {
    let now = 1_000
    const cache = new ProviderFileIdCache({ now: () => now })
    const cacheKey = key('provider-a')

    cache.set(cacheKey, { fileId: 'file-a', expiresAt: 1_100 })
    expect(cache.get(cacheKey)).toEqual({ fileId: 'file-a', expiresAt: 1_100 })

    now = 1_100
    expect(cache.get(cacheKey)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('does not retain entries that are already expired', () => {
    const cache = new ProviderFileIdCache({ now: () => 1_000 })
    cache.set(key('provider-a'), { fileId: 'file-a', expiresAt: 999 })

    expect(cache.size).toBe(0)
  })

  it('evicts the least recently used entry at the configured bound', () => {
    const cache = new ProviderFileIdCache({ maxEntries: 2 })
    const first = key('provider-a', 'account-a', 'content-1')
    const second = key('provider-a', 'account-a', 'content-2')
    const third = key('provider-a', 'account-a', 'content-3')

    cache.set(first, { fileId: 'file-1' })
    cache.set(second, { fileId: 'file-2' })
    expect(cache.get(first)?.fileId).toBe('file-1')

    cache.set(third, { fileId: 'file-3' })

    expect(cache.get(second)).toBeUndefined()
    expect(cache.get(first)?.fileId).toBe('file-1')
    expect(cache.get(third)?.fileId).toBe('file-3')
    expect(cache.size).toBe(2)
  })

  it('supports explicit invalidation for failed uploads', () => {
    const cache = new ProviderFileIdCache()
    const cacheKey = key('provider-a')
    cache.set(cacheKey, { fileId: 'file-a' })

    expect(cache.invalidate(cacheKey)).toBe(true)
    expect(cache.get(cacheKey)).toBeUndefined()
    expect(cache.invalidate(cacheKey)).toBe(false)
  })

  it('rejects invalid entry bounds', () => {
    expect(() => new ProviderFileIdCache({ maxEntries: 0 })).toThrow(RangeError)
    expect(() => new ProviderFileIdCache({ maxEntries: 1.5 })).toThrow(RangeError)
  })
})
