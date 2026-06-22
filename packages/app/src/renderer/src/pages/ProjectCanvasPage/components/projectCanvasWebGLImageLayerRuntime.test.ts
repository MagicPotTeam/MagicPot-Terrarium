import { describe, expect, it } from 'vitest'

import {
  createProjectCanvasWebGLResidentTextureByteTracker,
  insertProjectCanvasWebGLPriorityQueueEntry,
  refreshProjectCanvasWebGLPriorityQueuePriorities,
  reprioritizeProjectCanvasWebGLPriorityQueueEntry,
  type ProjectCanvasWebGLPriorityQueueEntry
} from './projectCanvasWebGLImageLayerRuntime'

const queueIds = (queue: readonly ProjectCanvasWebGLPriorityQueueEntry[]) =>
  queue.map((entry) => entry.itemId)

describe('projectCanvasWebGLImageLayerRuntime', () => {
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
})
