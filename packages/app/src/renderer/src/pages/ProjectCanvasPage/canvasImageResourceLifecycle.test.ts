import { describe, expect, it, vi } from 'vitest'
import {
  CanvasImageAsyncSharedResourcePool,
  CanvasImageInFlightDeduper,
  CanvasImageSharedResourceByteTracker,
  CanvasImageSharedReservationTracker,
  CanvasImageSharedResourcePool,
  createTokenSafeRelease,
  getCanvasImageDecodedRevisionKey,
  getCanvasImageSharedDecodedAssetKey,
  getCanvasImageStableSourceKey,
  hasCanvasImageStrongSourceIdentity
} from './canvasImageResourceLifecycle'

describe('canvasImageResourceLifecycle', () => {
  it('shares only stable source keys and includes identity revisions', () => {
    expect(getCanvasImageStableSourceKey({ src: 'file:///a.png' })).toBeNull()
    expect(
      getCanvasImageStableSourceKey({ src: 'file:///a.png', sourceIdentity: { cacheKey: 'rev-1' } })
    ).toBe('identity:rev-1')
    expect(getCanvasImageStableSourceKey({ src: 'https://example.test/a.png' })).toContain(
      'https://'
    )
    expect(
      getCanvasImageDecodedRevisionKey({
        source: { src: 'same.png', sourceIdentity: { cacheKey: 'source-rev' } },
        decodedIdentity: 2
      })
    ).not.toBe(
      getCanvasImageDecodedRevisionKey({
        source: { src: 'same.png', sourceIdentity: { cacheKey: 'source-rev' } },
        decodedIdentity: 3
      })
    )
  })

  it('separates weak remote decoded keys by provided revision while retaining strong dedupe', () => {
    expect(hasCanvasImageStrongSourceIdentity({ src: 'data:image/png;base64,abc' })).toBe(true)
    expect(
      hasCanvasImageStrongSourceIdentity({
        src: 'local-media:///a.png',
        sourceIdentity: { cacheKey: 'strong' }
      })
    ).toBe(true)
    expect(hasCanvasImageStrongSourceIdentity({ src: 'https://example.test/a.png' })).toBe(false)
    expect(
      getCanvasImageSharedDecodedAssetKey({
        source: { src: 'https://example.test/a.png', weakRevisionKey: 1 },
        variant: 'source-upgrade'
      })
    ).not.toBe(
      getCanvasImageSharedDecodedAssetKey({
        source: { src: 'https://example.test/a.png', weakRevisionKey: 2 },
        variant: 'source-upgrade'
      })
    )
    expect(
      getCanvasImageSharedDecodedAssetKey({
        source: {
          src: 'local-media:///a.png',
          sourceIdentity: { cacheKey: 'strong' },
          weakRevisionKey: 1
        },
        variant: 'source-upgrade'
      })
    ).toBe(
      getCanvasImageSharedDecodedAssetKey({
        source: {
          src: 'local-media:///a.png',
          sourceIdentity: { cacheKey: 'strong' },
          weakRevisionKey: 2
        },
        variant: 'source-upgrade'
      })
    )
    expect(
      getCanvasImageSharedDecodedAssetKey({
        source: { src: 'data:image/png;base64,abc', weakRevisionKey: 1 },
        variant: 'source-upgrade'
      })
    ).toBe(
      getCanvasImageSharedDecodedAssetKey({
        source: { src: 'data:image/png;base64,abc', weakRevisionKey: 2 },
        variant: 'source-upgrade'
      })
    )
  })

  it('merges duplicate in-flight loads and removes settled entries', async () => {
    const deduper = new CanvasImageInFlightDeduper<object>()
    const load = vi.fn(async () => ({}))
    const first = deduper.run('stable', load)
    const second = deduper.run('stable', load)
    expect(first).toBe(second)
    await first
    await deduper.run('stable', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reference-counts shared resources', () => {
    const pool = new CanvasImageSharedResourcePool<object>()
    const resource = {}
    const destroy = vi.fn()
    expect(pool.acquire('key', () => resource)).toBe(resource)
    expect(pool.acquire('key', () => ({}))).toBe(resource)
    pool.release('key', destroy)
    expect(destroy).not.toHaveBeenCalled()
    pool.release('key', destroy)
    expect(destroy).toHaveBeenCalledWith(resource)
  })

  it('charges shared physical resource bytes once across crops and releases them once', () => {
    const tracker = new CanvasImageSharedResourceByteTracker()

    expect(tracker.acquire('decoded-source', 400)).toBe(400)
    expect(tracker.acquire('decoded-source', 100)).toBe(0)
    expect(tracker.getTotal()).toBe(400)
    expect(tracker.getAdditionalBytes('decoded-source', 400)).toBe(0)
    expect(tracker.getRefCount('decoded-source')).toBe(2)

    expect(tracker.release('decoded-source')).toBe(0)
    expect(tracker.getTotal()).toBe(400)
    expect(tracker.getReleaseBytes('decoded-source')).toBe(400)
    expect(tracker.release('decoded-source')).toBe(400)
    expect(tracker.getTotal()).toBe(0)
  })

  it('keeps separately decoded source revisions in separate budget entries', () => {
    const tracker = new CanvasImageSharedResourceByteTracker()
    tracker.acquire('source-a', 400)
    tracker.acquire('source-b', 200)
    expect(tracker.getTotal()).toBe(600)
    tracker.clear()
    expect(tracker.getTotal()).toBe(0)
  })

  it('reference-counts one reservation per shared physical decode key', () => {
    const tracker = new CanvasImageSharedReservationTracker()
    const reserve = vi.fn(() => true)
    const releaseReservation = vi.fn()

    const first = tracker.acquire('shared-source', reserve, releaseReservation)
    const second = tracker.acquire('shared-source', reserve, releaseReservation)

    expect(reserve).toHaveBeenCalledTimes(1)
    expect(tracker.getRefCount('shared-source')).toBe(2)
    first?.()
    expect(releaseReservation).not.toHaveBeenCalled()
    expect(tracker.getRefCount('shared-source')).toBe(1)
    second?.()
    expect(releaseReservation).toHaveBeenCalledTimes(1)
    expect(tracker.getRefCount('shared-source')).toBe(0)
  })

  it('keeps a producer reservation until an aborted late decode actually settles', async () => {
    const reservations = new CanvasImageSharedReservationTracker()
    const releasePhysicalReservation = vi.fn()
    const reserve = vi.fn(() => true)
    const consumerRelease = reservations.acquire('decode', reserve, releasePhysicalReservation)
    const producerRelease = reservations.acquire('decode', reserve, releasePhysicalReservation)
    let resolveDecode!: () => void
    const lateDecode = new Promise<void>((resolve) => (resolveDecode = resolve)).finally(() =>
      producerRelease?.()
    )

    consumerRelease?.()
    expect(reservations.getRefCount('decode')).toBe(1)
    expect(releasePhysicalReservation).not.toHaveBeenCalled()
    expect(reservations.acquire('other-decode', () => false, vi.fn())).toBeNull()

    resolveDecode()
    await lateDecode

    expect(reservations.getRefCount('decode')).toBe(0)
    expect(releasePhysicalReservation).toHaveBeenCalledTimes(1)
  })

  it('does not retain a reservation when admission is denied', () => {
    const tracker = new CanvasImageSharedReservationTracker()
    const releaseReservation = vi.fn()

    expect(tracker.acquire('blocked', () => false, releaseReservation)).toBeNull()
    expect(tracker.getRefCount('blocked')).toBe(0)
    expect(releaseReservation).not.toHaveBeenCalled()
  })

  it('makes late object URL release token-safe', () => {
    const release = vi.fn()
    const safeRelease = createTokenSafeRelease(release)
    safeRelease()
    safeRelease()
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('leases a deduplicated resource until both consumers release it', async () => {
    const pool = new CanvasImageAsyncSharedResourcePool<object>()
    const resource = {}
    const load = vi.fn(async () => resource)
    const destroy = vi.fn()

    const [first, second] = await Promise.all([
      pool.acquire('shared', load, destroy),
      pool.acquire('shared', load, destroy)
    ])

    expect(load).toHaveBeenCalledTimes(1)
    expect(first.resource).toBe(resource)
    expect(second.resource).toBe(resource)
    expect(pool.getRefCount('shared')).toBe(2)

    first.release()
    first.release()
    expect(destroy).not.toHaveBeenCalled()
    expect(pool.getRefCount('shared')).toBe(1)

    second.release()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledWith(resource)
    expect(pool.getRefCount('shared')).toBe(0)
  })

  it('invokes a later callback consumer synchronously for an already-resolved shared resource', async () => {
    const pool = new CanvasImageAsyncSharedResourcePool<object>()
    const resource = {}
    const destroy = vi.fn()
    const first = await pool.acquire('shared', async () => resource, destroy)
    const secondOnLease = vi.fn()

    const cancelSecond = pool.acquireWithCallback(
      'shared',
      async () => ({}),
      destroy,
      secondOnLease,
      vi.fn()
    )

    expect(secondOnLease).toHaveBeenCalledTimes(1)
    expect(secondOnLease).toHaveBeenCalledWith(
      expect.objectContaining({ resource, release: expect.any(Function) })
    )
    expect(pool.getRefCount('shared')).toBe(2)

    cancelSecond()
    expect(pool.getRefCount('shared')).toBe(1)
    expect(destroy).not.toHaveBeenCalled()

    first.release()
    expect(destroy).toHaveBeenCalledWith(resource)
  })

  it('releases stale or unmounted consumers without prematurely destroying a live lease', async () => {
    const pool = new CanvasImageAsyncSharedResourcePool<object>()
    const resource = {}
    const destroy = vi.fn()
    const stale = await pool.acquire('shared', async () => resource, destroy)
    const mounted = await pool.acquire('shared', async () => resource, destroy)

    stale.release()
    expect(destroy).not.toHaveBeenCalled()
    expect(mounted.resource).toBe(resource)

    mounted.release()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys exactly once when the final listener releases synchronously during resolution', async () => {
    const pool = new CanvasImageAsyncSharedResourcePool<object>()
    const resource = {}
    const destroy = vi.fn()
    let resolve!: (resource: object) => void
    pool.acquireWithCallback(
      'shared',
      () => new Promise<object>((next) => (resolve = next)),
      destroy,
      (lease) => lease.release(),
      vi.fn()
    )

    resolve(resource)
    await Promise.resolve()

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledWith(resource)
    expect(pool.getRefCount('shared')).toBe(0)
  })

  it('destroys a pending resource after every consumer releases before completion', async () => {
    const pool = new CanvasImageAsyncSharedResourcePool<object>()
    const resource = {}
    const destroy = vi.fn()
    let resolve!: (resource: object) => void
    const load = () => new Promise<object>((next) => (resolve = next))
    const firstPending = pool.acquire('shared', load, destroy)
    const secondPending = pool.acquire('shared', load, destroy)

    await Promise.resolve()
    resolve(resource)
    const [first, second] = await Promise.all([firstPending, secondPending])
    first.release()
    expect(destroy).not.toHaveBeenCalled()
    second.release()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys a resolved resource whose only consumer unmounted while loading', async () => {
    const pool = new CanvasImageAsyncSharedResourcePool<object>()
    const resource = {}
    const destroy = vi.fn()
    let resolve!: (resource: object) => void
    const pending = pool.acquire(
      'shared',
      () => new Promise<object>((next) => (resolve = next)),
      destroy
    )

    resolve(resource)
    const lease = await pending
    lease.release()

    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys a cancelled late resource without disturbing a replacement same-key entry', async () => {
    const pool = new CanvasImageAsyncSharedResourcePool<object>()
    const oldResource = { generation: 'old' }
    const newResource = { generation: 'new' }
    const destroy = vi.fn()
    const oldOnLease = vi.fn()
    const newOnLease = vi.fn()
    let resolveOld!: (resource: object) => void
    let resolveNew!: (resource: object) => void

    const cancelOld = pool.acquireWithCallback(
      'shared',
      () => new Promise<object>((resolve) => (resolveOld = resolve)),
      destroy,
      oldOnLease,
      vi.fn()
    )
    cancelOld()

    pool.acquireWithCallback(
      'shared',
      () => new Promise<object>((resolve) => (resolveNew = resolve)),
      destroy,
      newOnLease,
      vi.fn()
    )
    expect(pool.getRefCount('shared')).toBe(1)

    resolveOld(oldResource)
    await Promise.resolve()

    expect(destroy).toHaveBeenCalledWith(oldResource)
    expect(oldOnLease).not.toHaveBeenCalled()
    expect(pool.getRefCount('shared')).toBe(1)

    resolveNew(newResource)
    await Promise.resolve()

    expect(newOnLease).toHaveBeenCalledTimes(1)
    expect(destroy).not.toHaveBeenCalledWith(newResource)
    expect(pool.getRefCount('shared')).toBe(1)
  })

  it('cancels the underlying pending load after the final callback consumer leaves', async () => {
    const pool = new CanvasImageAsyncSharedResourcePool<object>()
    const destroy = vi.fn()
    const onLease = vi.fn()
    const onError = vi.fn()
    let observedSignal: AbortSignal | null = null
    const cancel = pool.acquireWithCallback(
      'shared',
      (signal) => {
        observedSignal = signal
        return new Promise<object>(() => undefined)
      },
      destroy,
      onLease,
      onError
    )

    cancel()
    await Promise.resolve()

    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(pool.getRefCount('shared')).toBe(0)
    expect(onLease).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
  })
})
