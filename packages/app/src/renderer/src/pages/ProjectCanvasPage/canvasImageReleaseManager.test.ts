import { describe, expect, it, vi } from 'vitest'

import {
  CANVAS_IMAGE_RELEASE_REASONS,
  CanvasImageReleaseManager,
  createCanvasImageReleaseManager
} from './canvasImageReleaseManager'

describe('canvasImageReleaseManager', () => {
  it('tracks and releases object URLs, image bitmaps, leases, metrics, and reasons', () => {
    const revokeObjectUrl = vi.fn()
    const close = vi.fn()
    const dispose = vi.fn()
    const manager = createCanvasImageReleaseManager({ revokeObjectUrl })

    const objectUrl = manager.trackObjectUrl('url', 'blob:test-url')
    manager.trackImageBitmap('bitmap', { close })
    manager.trackLease('lease', dispose)

    expect(manager.getMetricsSnapshot()).toMatchObject({
      activeObjectUrlCount: 1,
      activeImageBitmapCount: 1,
      activeLeaseCount: 1,
      activeResourceCount: 3,
      revokedObjectUrlCount: 0,
      closedImageBitmapCount: 0,
      disposedLeaseCount: 0
    })

    expect(objectUrl.release('removed')).toMatchObject({
      id: 'url',
      kind: 'objectUrl',
      reason: 'removed',
      released: true,
      errors: []
    })
    expect(manager.release('bitmap', 'budget-pressure')).toMatchObject({
      id: 'bitmap',
      kind: 'imageBitmap',
      reason: 'budget-pressure',
      released: true,
      errors: []
    })
    expect(manager.release('lease', 'component-unmount')).toMatchObject({
      id: 'lease',
      kind: 'lease',
      reason: 'component-unmount',
      released: true,
      errors: []
    })

    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-url')
    expect(close).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(manager.getMetricsSnapshot()).toMatchObject({
      activeObjectUrlCount: 0,
      activeImageBitmapCount: 0,
      activeLeaseCount: 0,
      activeResourceCount: 0,
      revokedObjectUrlCount: 1,
      closedImageBitmapCount: 1,
      disposedLeaseCount: 1,
      releaseErrors: [],
      releaseReasons: expect.objectContaining({
        removed: 1,
        'budget-pressure': 1,
        'component-unmount': 1,
        manual: 0
      })
    })
  })

  it('makes duplicate release idempotent and ignores stale replacement handles', () => {
    const revokeObjectUrl = vi.fn()
    const manager = new CanvasImageReleaseManager({ revokeObjectUrl })

    const staleHandle = manager.trackObjectUrl('same-id', 'blob:old')
    const currentHandle = manager.trackObjectUrl('same-id', 'blob:new')

    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
    expect(revokeObjectUrl).toHaveBeenLastCalledWith('blob:old')
    expect(staleHandle.release('manual')).toMatchObject({
      id: 'same-id',
      kind: null,
      reason: 'manual',
      released: false,
      errors: []
    })
    expect(currentHandle.release('removed')).toMatchObject({ released: true })
    expect(currentHandle.release('removed')).toMatchObject({
      id: 'same-id',
      kind: null,
      reason: 'removed',
      released: false,
      errors: []
    })

    expect(revokeObjectUrl).toHaveBeenCalledTimes(2)
    expect(revokeObjectUrl).toHaveBeenLastCalledWith('blob:new')
    expect(manager.getMetricsSnapshot()).toMatchObject({
      activeObjectUrlCount: 0,
      activeResourceCount: 0,
      revokedObjectUrlCount: 2,
      releaseReasons: expect.objectContaining({
        replaced: 1,
        removed: 1,
        manual: 0
      })
    })
  })

  it('releaseAll releases each active resource once with a shared reason', () => {
    const revokeObjectUrl = vi.fn()
    const close = vi.fn()
    const dispose = vi.fn()
    const manager = new CanvasImageReleaseManager({ revokeObjectUrl })

    manager.trackObjectUrl('url-a', 'blob:a')
    manager.trackObjectUrl('url-b', 'blob:b')
    manager.trackImageBitmap('bitmap', { close })
    manager.trackLease('lease', dispose)

    const results = manager.releaseAll('canvas-reset')
    const secondResults = manager.releaseAll('canvas-reset')

    expect(results).toHaveLength(4)
    expect(results.every((result) => result.released)).toBe(true)
    expect(secondResults).toEqual([])
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(manager.getMetricsSnapshot()).toMatchObject({
      activeObjectUrlCount: 0,
      activeImageBitmapCount: 0,
      activeLeaseCount: 0,
      activeResourceCount: 0,
      revokedObjectUrlCount: 2,
      closedImageBitmapCount: 1,
      disposedLeaseCount: 1,
      releaseReasons: expect.objectContaining({
        'canvas-reset': 4
      })
    })
  })

  it('isolates release errors and continues releaseAll cleanup', () => {
    const revokeObjectUrl = vi.fn(() => {
      throw new Error('revoke failed')
    })
    const close = vi.fn()
    const dispose = vi.fn(() => {
      throw new TypeError('dispose failed')
    })
    const manager = new CanvasImageReleaseManager({ revokeObjectUrl, maxReleaseErrors: 5 })

    manager.trackObjectUrl('url', 'blob:error')
    manager.trackImageBitmap('bitmap', { close })
    manager.trackLease('lease', dispose)

    const results = manager.releaseAll('error-cleanup')

    expect(results).toHaveLength(3)
    expect(results.map((result) => result.released)).toEqual([true, true, true])
    expect(results[0].errors).toMatchObject([
      { id: 'url', kind: 'objectUrl', reason: 'error-cleanup', message: 'revoke failed' }
    ])
    expect(results[1].errors).toEqual([])
    expect(results[2].errors).toMatchObject([
      { id: 'lease', kind: 'lease', reason: 'error-cleanup', name: 'TypeError' }
    ])
    expect(close).toHaveBeenCalledTimes(1)
    expect(manager.getMetricsSnapshot()).toMatchObject({
      activeResourceCount: 0,
      revokedObjectUrlCount: 0,
      closedImageBitmapCount: 1,
      disposedLeaseCount: 0,
      releaseErrors: [
        { id: 'url', kind: 'objectUrl', reason: 'error-cleanup', message: 'revoke failed' },
        { id: 'lease', kind: 'lease', reason: 'error-cleanup', message: 'dispose failed' }
      ],
      releaseReasons: expect.objectContaining({
        'error-cleanup': 3
      })
    })
  })

  it('bounds retained release errors and keeps counters bounded by real releases', () => {
    const manager = new CanvasImageReleaseManager({
      maxReleaseErrors: 2,
      revokeObjectUrl: () => {
        throw new Error('revoke failed')
      }
    })

    CANVAS_IMAGE_RELEASE_REASONS.forEach((reason, index) => {
      manager.trackObjectUrl(`url-${index}`, `blob:${index}`)
      manager.release(`url-${index}`, reason)
    })

    manager.release('missing-id', 'manual')
    manager.release('missing-id', 'manual')

    const metrics = manager.getMetricsSnapshot()
    expect(metrics.activeObjectUrlCount).toBe(0)
    expect(metrics.revokedObjectUrlCount).toBe(0)
    expect(metrics.releaseErrors).toHaveLength(2)
    expect(metrics.releaseErrors.map((error) => error.id)).toEqual(['url-6', 'url-7'])
    expect(Object.values(metrics.releaseReasons).reduce((total, count) => total + count, 0)).toBe(
      CANVAS_IMAGE_RELEASE_REASONS.length
    )
    expect(metrics.releaseReasons.manual).toBe(1)
  })

  it('returns defensive metric snapshots', () => {
    const manager = new CanvasImageReleaseManager({
      maxReleaseErrors: 1,
      revokeObjectUrl: () => {
        throw new Error('first failure')
      }
    })

    manager.trackObjectUrl('url', 'blob:url')
    manager.release('url', 'manual')

    const metrics = manager.getMetricsSnapshot()
    metrics.releaseErrors[0].message = 'mutated'
    metrics.releaseReasons.manual = 100

    expect(manager.getMetricsSnapshot().releaseErrors[0].message).toBe('first failure')
    expect(manager.getMetricsSnapshot().releaseReasons.manual).toBe(1)
  })
})
