import { describe, expect, it, vi } from 'vitest'

import { createProjectCanvasWebGLSpatialTileStateMachine } from './projectCanvasWebGLImageLayerRuntime'

import {
  areProjectCanvasWebGLItemReconcileSnapshotsEqual,
  buildProjectCanvasWebGLItemReconcileSnapshot,
  createProjectCanvasWebGLResidentTextureByteTracker,
  buildProjectCanvasWebGLItemLookup,
  getProjectCanvasWebGLRenderResolution,
  shouldSampleProjectCanvasWebGLError,
  insertProjectCanvasWebGLPriorityQueueEntry,
  refreshProjectCanvasWebGLPriorityQueuePriorities,
  reprioritizeProjectCanvasWebGLPriorityQueueEntry,
  type ProjectCanvasWebGLPriorityQueueEntry
} from './projectCanvasWebGLImageLayerRuntime'

const queueIds = (queue: readonly ProjectCanvasWebGLPriorityQueueEntry[]) =>
  queue.map((entry) => entry.itemId)

describe('projectCanvasWebGLImageLayerRuntime', () => {
  it('caps normal and low-power render resolution while allowing explicit overrides', () => {
    expect(getProjectCanvasWebGLRenderResolution({ devicePixelRatio: 3 })).toBe(1.5)
    expect(getProjectCanvasWebGLRenderResolution({ devicePixelRatio: 1.25 })).toBe(1.25)
    expect(getProjectCanvasWebGLRenderResolution({ devicePixelRatio: 3, lowPower: true })).toBe(1)
    expect(
      getProjectCanvasWebGLRenderResolution({
        devicePixelRatio: 3,
        lowPower: true,
        resolutionOverride: 2
      })
    ).toBe(2)
  })

  it('samples WebGL errors on the first render and then at the configured interval', () => {
    expect(
      [1, 2, 3, 4, 5, 6].filter((count) => shouldSampleProjectCanvasWebGLError(count, 3))
    ).toEqual([1, 3, 6])
  })

  it('falls back to the default WebGL error sampling interval for non-finite values', () => {
    expect(shouldSampleProjectCanvasWebGLError(2, Number.NaN)).toBe(false)
    expect(shouldSampleProjectCanvasWebGLError(120, Number.POSITIVE_INFINITY)).toBe(true)
  })

  it('builds item lookup maps and id sets in one pass', () => {
    const first = { id: 'first', value: 1 }
    const second = { id: 'second', value: 2 }
    const lookup = buildProjectCanvasWebGLItemLookup([first, second])

    expect(lookup.itemById.get('first')).toBe(first)
    expect(lookup.itemById.get('second')).toBe(second)
    expect([...lookup.itemIds]).toEqual(['first', 'second'])
  })

  it('keeps priority queues in descending priority order as entries are inserted', () => {
    const queue: ProjectCanvasWebGLPriorityQueueEntry[] = []

    insertProjectCanvasWebGLPriorityQueueEntry(queue, {
      itemId: 'low',
      src: 'low.png',
      priority: 1
    })
    insertProjectCanvasWebGLPriorityQueueEntry(queue, {
      itemId: 'high',
      src: 'high.png',
      priority: 10
    })
    insertProjectCanvasWebGLPriorityQueueEntry(queue, {
      itemId: 'mid',
      src: 'mid.png',
      priority: 5
    })
    insertProjectCanvasWebGLPriorityQueueEntry(queue, {
      itemId: 'same-priority-tail',
      src: 'same-priority-tail.png',
      priority: 5
    })

    expect(queueIds(queue)).toEqual(['high', 'mid', 'same-priority-tail', 'low'])
  })

  it('raises queued entry priority without resorting the full queue on every pump', () => {
    const queue: ProjectCanvasWebGLPriorityQueueEntry[] = [
      { itemId: 'first', src: 'first.png', priority: 9 },
      { itemId: 'target', src: 'target.png', priority: 2 },
      { itemId: 'tail', src: 'tail.png', priority: 1 }
    ]

    expect(
      reprioritizeProjectCanvasWebGLPriorityQueueEntry(queue, 'target', 'target.png', 12)
    ).toBe(true)
    expect(queueIds(queue)).toEqual(['target', 'first', 'tail'])
    expect(queue[0].priority).toBe(12)

    expect(reprioritizeProjectCanvasWebGLPriorityQueueEntry(queue, 'tail', 'tail.png', 0)).toBe(
      true
    )
    expect(queueIds(queue)).toEqual(['target', 'first', 'tail'])
    expect(queue[2].priority).toBe(1)

    expect(
      reprioritizeProjectCanvasWebGLPriorityQueueEntry(queue, 'missing', 'missing.png', 99)
    ).toBe(false)
  })

  it('refreshes dynamic source-upgrade priorities with stable tie ordering', () => {
    const queue: ProjectCanvasWebGLPriorityQueueEntry[] = [
      { itemId: 'a', src: 'a.png', priority: 1 },
      { itemId: 'b', src: 'b.png', priority: 2 },
      { itemId: 'c', src: 'c.png', priority: 3 },
      { itemId: 'd', src: 'd.png', priority: 4 }
    ]

    refreshProjectCanvasWebGLPriorityQueuePriorities(queue, (entry) => {
      if (entry.itemId === 'a') return 5
      if (entry.itemId === 'b') return 5
      if (entry.itemId === 'c') return -1
      return undefined
    })

    expect(queue).toEqual([
      { itemId: 'a', src: 'a.png', priority: 5 },
      { itemId: 'b', src: 'b.png', priority: 5 },
      { itemId: 'd', src: 'd.png', priority: 4 },
      { itemId: 'c', src: 'c.png', priority: -1 }
    ])
  })

  it('tracks resident texture bytes incrementally across set, replace, delete, and reset', () => {
    const tracker = createProjectCanvasWebGLResidentTextureByteTracker([
      ['existing-a', { textureByteSize: 128 }],
      ['ignored-zero', { textureByteSize: 0 }],
      ['ignored-negative', { textureByteSize: -32 }]
    ])

    expect(tracker.getTotal()).toBe(128)

    expect(tracker.set('existing-a', 512)).toBe(512)
    expect(tracker.set('existing-b', 256)).toBe(768)
    expect(tracker.set('ignored-nan', Number.NaN)).toBe(768)
    expect(tracker.delete('existing-a')).toBe(256)
    expect(tracker.delete('missing')).toBe(256)

    expect(
      tracker.reset([
        ['reset-a', { textureByteSize: 64 }],
        ['reset-b', { textureByteSize: 96 }]
      ])
    ).toBe(160)

    tracker.clear()
    expect(tracker.getTotal()).toBe(0)
  })

  it('builds stable per-item reconcile snapshots and detects render-affecting changes', () => {
    const sourceIdentity = {
      kind: 'local-file',
      canonicalPath: 'C:/images/source.png',
      sizeBytes: 4096,
      lastModifiedMs: 123456,
      cacheKey: 'source-cache-key'
    }
    const thumbnailSet = {
      version: 1,
      cacheKey: 'thumbnail-cache-key',
      updatedAt: '2026-06-01T00:00:00.000Z',
      sourceIdentity,
      levels: [
        {
          maxSide: 128,
          src: 'local-media:///thumb/128.webp',
          width: 128,
          height: 64,
          sizeBytes: 512
        }
      ]
    }
    const baseItem = {
      id: 'image-1',
      src: 'file:///image-1.png',
      x: 10,
      y: 20,
      width: 200,
      height: 100,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      zIndex: 2,
      crop: { x: 4, y: 8, width: 64, height: 32 },
      imageIdentityKey: 'preview-image',
      image: { naturalWidth: 256, naturalHeight: 128 },
      sourceWidth: 1024,
      sourceHeight: 512,
      sourceIdentity,
      thumbnailSet,
      extraKeys: ['cache-src', 1024, false]
    }
    const baseOptions = {
      selected: false,
      stageScale: 1,
      deviceScale: 2,
      sourceUpgradeBlocked: false,
      performanceThrottled: false,
      viewportInteracting: false
    }

    const snapshot = buildProjectCanvasWebGLItemReconcileSnapshot(baseItem, baseOptions)

    expect(
      areProjectCanvasWebGLItemReconcileSnapshotsEqual(
        snapshot,
        buildProjectCanvasWebGLItemReconcileSnapshot({ ...baseItem }, { ...baseOptions })
      )
    ).toBe(true)
    expect(
      areProjectCanvasWebGLItemReconcileSnapshotsEqual(
        snapshot,
        buildProjectCanvasWebGLItemReconcileSnapshot({ ...baseItem, x: 11 }, baseOptions)
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLItemReconcileSnapshotsEqual(
        snapshot,
        buildProjectCanvasWebGLItemReconcileSnapshot(
          { ...baseItem, imageIdentityKey: 'source-image' },
          baseOptions
        )
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLItemReconcileSnapshotsEqual(
        snapshot,
        buildProjectCanvasWebGLItemReconcileSnapshot(
          {
            ...baseItem,
            thumbnailSet: {
              ...thumbnailSet,
              updatedAt: '2026-06-02T00:00:00.000Z'
            }
          },
          baseOptions
        )
      )
    ).toBe(false)
    expect(
      areProjectCanvasWebGLItemReconcileSnapshotsEqual(
        snapshot,
        buildProjectCanvasWebGLItemReconcileSnapshot(baseItem, {
          ...baseOptions,
          selected: true
        })
      )
    ).toBe(false)
    expect(areProjectCanvasWebGLItemReconcileSnapshotsEqual(undefined, snapshot)).toBe(false)
  })
})

describe('spatial tile presentation/resource state machine', () => {
  it('reuses the committed asset across presentation changes and atomically commits visible readiness', () => {
    const disposed: string[] = []
    const machine = createProjectCanvasWebGLSpatialTileStateMachine({
      initialResourceKey: { source: 'a', level: 0, config: 'x' },
      initialAsset: 'old',
      dispose: (asset, reason) => disposed.push(`${asset}:${reason}`)
    })
    machine.beginResource({ source: 'a', level: 0, config: 'x' })
    const { token, reusedAsset } = machine.beginPresentation(
      { crop: 'a', transform: 'a', viewport: 'a' },
      { requiredVisibleKeys: ['tile'] }
    )
    expect(reusedAsset).toBe('old')
    expect(machine.commitVisibleReady(token)).toBe(false)
    expect(machine.setCandidateAsset(token, 'new')).toBe(true)
    expect(machine.markTileReady(token, 'overscan')).toBe(true)
    expect(machine.commitVisibleReady(token)).toBe(false)
    expect(machine.markTileReady(token, 'tile')).toBe(true)
    expect(machine.commitVisibleReady(token)).toBe(true)
    expect(machine.getState().asset).toBe('new')
    expect(disposed).toEqual(['old:replaced'])
  })

  it('rejects an initial asset without a resource key', () => {
    expect(() =>
      createProjectCanvasWebGLSpatialTileStateMachine({
        initialAsset: 'orphan'
      })
    ).toThrow('requires an initial resource key')
  })

  it('reuses the committed asset when presentation begins again under the same resource key', () => {
    const dispose = vi.fn()
    const machine = createProjectCanvasWebGLSpatialTileStateMachine({ dispose })
    machine.beginResource({ source: 'source', level: 1, config: 'config' })
    const first = machine.beginPresentation({ crop: 'a', transform: 'a', viewport: 'a' })
    machine.setCandidateAsset(first.token, 'asset')
    machine.commitVisibleReady(first.token)

    const second = machine.beginPresentation({ crop: 'b', transform: 'a', viewport: 'a' })
    expect(second.reusedAsset).toBe('asset')
    expect(second.token.resourceGeneration).toBe(first.token.resourceGeneration)
    expect(second.token.presentationGeneration).toBeGreaterThan(first.token.presentationGeneration)
    expect(machine.getState().asset).toBe('asset')
    expect(dispose).not.toHaveBeenCalled()
  })
  it('cancels presentation candidates and stale-disposes resource changes', () => {
    const disposed: string[] = []
    const machine = createProjectCanvasWebGLSpatialTileStateMachine({
      dispose: (asset, reason) => disposed.push(`${asset}:${reason}`)
    })
    machine.beginResource({ source: 'a', level: 0, config: 'x' })
    const { token } = machine.beginPresentation({ crop: 'a', transform: 'a', viewport: 'a' })
    machine.setCandidateAsset(token, 'candidate')
    machine.leavePolicy(token)
    expect(disposed).toEqual(['candidate:cancelled'])
    const next = machine.beginPresentation({ crop: 'b', transform: 'a', viewport: 'a' })
    machine.setCandidateAsset(next.token, 'committed')
    machine.commitVisibleReady(next.token)
    machine.leavePolicy(next.token)
    expect(disposed).toContain('committed:cancelled')
    expect(machine.getState()).toMatchObject({ mode: 'fallback', asset: null })

    const stale = machine.beginPresentation({ crop: 'c', transform: 'a', viewport: 'a' })
    machine.setCandidateAsset(stale.token, 'stale')
    machine.beginResource({ source: 'b', level: 0, config: 'x' })
    expect(disposed).toContain('stale:stale')
    expect(machine.isCurrent(stale.token)).toBe(false)
  })
})
