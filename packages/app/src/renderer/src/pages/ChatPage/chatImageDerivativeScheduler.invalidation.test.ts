import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureCachedChatImageDerivative,
  getChatImageDerivativeCacheKey,
  invalidateCachedChatImageDerivative,
  resetChatImageDerivativeCacheForTests
} from './chatImageDerivativeScheduler'
import type { EnsureManagedMediaDerivativeResp } from '@shared/api/svcManagedMedia'

const reference = {
  version: 1 as const,
  kind: 'managed' as const,
  relativePath: 'assets/recovery.png',
  sha256: 'a'.repeat(64),
  sizeBytes: 1024,
  mimeType: 'image/png',
  originalFileName: 'recovery.png'
}
const key = getChatImageDerivativeCacheKey(reference, 512)
const brokenUrl = 'local-media:///derivatives/broken.webp'
const recoveredUrl = 'local-media:///derivatives/recovered.webp'
const ready = (url: string): EnsureManagedMediaDerivativeResp => ({
  status: 'ready',
  descriptor: {
    maxEdge: 512,
    relativePath: `derivatives/${url.slice(url.lastIndexOf('/') + 1)}`,
    mimeType: 'image/webp',
    sizeBytes: 128,
    width: 200,
    height: 100,
    sha256: 'b'.repeat(64),
    localMediaUrl: url
  }
})

afterEach(() => resetChatImageDerivativeCacheForTests())

describe('chat image derivative cache invalidation', () => {
  it('invalidates only the requested completed preview and lets the next caller regenerate it', async () => {
    const ensureDerivative = vi
      .fn()
      .mockResolvedValueOnce(ready(brokenUrl))
      .mockResolvedValue(ready(recoveredUrl))
    const service = { ensureDerivative } as never
    await ensureCachedChatImageDerivative(service, reference, 512)

    expect(invalidateCachedChatImageDerivative(key, brokenUrl)).toBe(true)
    expect(invalidateCachedChatImageDerivative(key, brokenUrl)).toBe(false)
    await expect(ensureCachedChatImageDerivative(service, reference, 512)).resolves.toEqual(
      ready(recoveredUrl)
    )
    expect(ensureDerivative).toHaveBeenCalledTimes(2)
  })

  it('ignores an old error after a newer preview has replaced the cache entry', async () => {
    const ensureDerivative = vi
      .fn()
      .mockResolvedValueOnce(ready(brokenUrl))
      .mockResolvedValue(ready(recoveredUrl))
    const service = { ensureDerivative } as never
    await ensureCachedChatImageDerivative(service, reference, 512)
    invalidateCachedChatImageDerivative(key, brokenUrl)
    await ensureCachedChatImageDerivative(service, reference, 512)

    expect(invalidateCachedChatImageDerivative(key, brokenUrl)).toBe(false)
    await expect(ensureCachedChatImageDerivative(service, reference, 512)).resolves.toEqual(
      ready(recoveredUrl)
    )
    expect(ensureDerivative).toHaveBeenCalledTimes(2)
  })

  it('does not cancel or duplicate a pending shared replacement when an older preview errors', async () => {
    let finish!: (value: EnsureManagedMediaDerivativeResp) => void
    const ensureDerivative = vi
      .fn()
      .mockResolvedValueOnce(ready(brokenUrl))
      .mockImplementation(
        () =>
          new Promise<EnsureManagedMediaDerivativeResp>((resolve) => {
            finish = resolve
          })
      )
    const service = { ensureDerivative } as never
    await ensureCachedChatImageDerivative(service, reference, 512)
    invalidateCachedChatImageDerivative(key, brokenUrl)
    const firstController = new AbortController()
    const first = ensureCachedChatImageDerivative(service, reference, 512, {
      signal: firstController.signal
    })
    const observedFirst = first.catch((error: unknown) => error)
    const second = ensureCachedChatImageDerivative(service, reference, 512)
    await Promise.resolve()
    await Promise.resolve()
    expect(ensureDerivative).toHaveBeenCalledTimes(2)

    expect(invalidateCachedChatImageDerivative(key, brokenUrl)).toBe(false)
    const third = ensureCachedChatImageDerivative(service, reference, 512)
    firstController.abort()
    expect(await observedFirst).toMatchObject({ name: 'AbortError' })
    finish(ready(recoveredUrl))

    await expect(second).resolves.toEqual(ready(recoveredUrl))
    await expect(third).resolves.toEqual(ready(recoveredUrl))
    expect(ensureDerivative).toHaveBeenCalledTimes(2)
  })

  it('does not evict an original-image fallback even when its URL matches the failure', async () => {
    const result: EnsureManagedMediaDerivativeResp = {
      status: 'fallbackOriginal',
      reason: 'animated-gif',
      localMediaUrl: 'local-media:///assets/original.gif'
    }
    const ensureDerivative = vi.fn().mockResolvedValue(result)
    const service = { ensureDerivative } as never
    await ensureCachedChatImageDerivative(service, reference, 512)

    expect(invalidateCachedChatImageDerivative(key, result.localMediaUrl)).toBe(false)
    await expect(ensureCachedChatImageDerivative(service, reference, 512)).resolves.toBe(result)
    expect(ensureDerivative).toHaveBeenCalledOnce()
  })

  it('does not evict another size or accept a mismatched failed URL', async () => {
    const ensureDerivative = vi.fn().mockResolvedValue(ready(recoveredUrl))
    const service = { ensureDerivative } as never
    await ensureCachedChatImageDerivative(service, reference, 512)

    expect(
      invalidateCachedChatImageDerivative(
        getChatImageDerivativeCacheKey(reference, 1024),
        recoveredUrl
      )
    ).toBe(false)
    expect(invalidateCachedChatImageDerivative(key, brokenUrl)).toBe(false)
    await ensureCachedChatImageDerivative(service, reference, 512)
    expect(ensureDerivative).toHaveBeenCalledOnce()
  })
})
