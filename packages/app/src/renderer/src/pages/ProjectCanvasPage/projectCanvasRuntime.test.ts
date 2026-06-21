import { describe, expect, it } from 'vitest'

import {
  canvasToScreenPoint,
  createProjectCanvasRuntime,
  getProjectCanvasRuntimeExportBounds,
  screenToCanvasPoint,
  type CanvasPoint,
  type CanvasViewport,
  type ProjectCanvasRuntimePreviewUpdate
} from './projectCanvasRuntime'
import type { CanvasItem } from './types'

function createCanvasItem(overrides: Partial<CanvasItem> & { id: string }): CanvasItem {
  return {
    type: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    src: 'data:image/png;base64,test',
    ...overrides
  } as CanvasItem
}

describe('projectCanvasRuntime', () => {
  it('hit-tests the top zIndex item first', () => {
    const runtime = createProjectCanvasRuntime()
    runtime.setItems([
      createCanvasItem({ id: 'bottom', zIndex: 1 }),
      createCanvasItem({ id: 'top', zIndex: 4 })
    ])

    expect(runtime.hitTest({ x: 20, y: 20 })?.id).toBe('top')
  })

  it('keeps locked items hittable and skips hidden items by default', () => {
    const runtime = createProjectCanvasRuntime()
    runtime.setItems([
      createCanvasItem({ id: 'locked', locked: true, zIndex: 1 }),
      createCanvasItem({ id: 'hidden-top', zIndex: 5, hidden: true } as Partial<CanvasItem> & {
        id: string
      })
    ])

    expect(runtime.hitTest({ x: 10, y: 10 })?.id).toBe('locked')
    expect(runtime.hitTest({ x: 10, y: 10 }, { includeHidden: true })?.id).toBe('hidden-top')
  })

  it('converts between screen and canvas coordinates through the viewport', () => {
    const viewport: CanvasViewport = { x: 100, y: 40, scale: 2 }
    const canvasPoint: CanvasPoint = { x: 25, y: 30 }
    const screenPoint = canvasToScreenPoint(canvasPoint, viewport)

    expect(screenPoint).toEqual({ x: 150, y: 100 })
    expect(screenToCanvasPoint(screenPoint, viewport)).toEqual(canvasPoint)

    const runtime = createProjectCanvasRuntime()
    runtime.setViewport(viewport)
    runtime.setItems([createCanvasItem({ id: 'target', x: 20, y: 20, width: 40, height: 40 })])

    expect(runtime.hitTest({ x: 150, y: 100 }, { coordinateSpace: 'screen' })?.id).toBe('target')
  })

  it('uses screen hit radius through the current viewport scale', () => {
    const runtime = createProjectCanvasRuntime()
    runtime.setViewport({ x: 0, y: 0, scale: 0.5 })
    runtime.setItems([createCanvasItem({ id: 'tiny', x: 20, y: 20, width: 2, height: 2 })])

    expect(runtime.hitTest({ x: 15, y: 20 }, { screenRadiusPx: 2 })).toBeNull()
    expect(runtime.hitTest({ x: 15, y: 20 }, { screenRadiusPx: 3 })?.id).toBe('tiny')
  })

  it('can use caller-provided item bounds', () => {
    const runtime = createProjectCanvasRuntime({
      getItemBounds: (item) => ({
        minX: item.x - 20,
        minY: item.y - 20,
        maxX: item.x,
        maxY: item.y
      })
    })
    runtime.setItems([createCanvasItem({ id: 'custom-bounds', x: 100, y: 100 })])

    expect(runtime.hitTest({ x: 90, y: 90 })?.id).toBe('custom-bounds')
    expect(runtime.getSelectionBounds(['custom-bounds'])).toEqual({
      minX: 80,
      minY: 80,
      maxX: 100,
      maxY: 100
    })
  })

  it('returns bounds that cover multiple selected items', () => {
    const runtime = createProjectCanvasRuntime()
    runtime.setItems([
      createCanvasItem({ id: 'left', x: -20, y: 10, width: 40, height: 30 }),
      createCanvasItem({ id: 'right', x: 80, y: -10, width: 50, height: 70 }),
      createCanvasItem({ id: 'ignored', x: 500, y: 500, width: 20, height: 20 })
    ])

    expect(runtime.getSelectionBounds(['left', 'right'])).toEqual({
      minX: -20,
      minY: -10,
      maxX: 130,
      maxY: 60
    })
  })

  it('marquee-selects intersecting items in top-first order', () => {
    const runtime = createProjectCanvasRuntime()
    runtime.setItems([
      createCanvasItem({ id: 'one', x: 0, y: 0, width: 40, height: 40, zIndex: 1 }),
      createCanvasItem({ id: 'two', x: 20, y: 20, width: 40, height: 40, zIndex: 3 }),
      createCanvasItem({ id: 'far', x: 200, y: 200, width: 40, height: 40, zIndex: 9 })
    ])

    expect(runtime.marqueeSelect({ minX: 10, minY: 10, maxX: 50, maxY: 50 })).toEqual([
      'two',
      'one'
    ])
  })

  it('updates preview items without mutating original items', () => {
    const runtime = createProjectCanvasRuntime()
    const original = createCanvasItem({ id: 'item', x: 10, y: 20 })
    const update: ProjectCanvasRuntimePreviewUpdate = {
      id: 'item',
      changes: { x: 60, y: 80 }
    }

    runtime.setItems([original])
    runtime.beginPreview([update])

    expect(original.x).toBe(10)
    expect(original.y).toBe(20)
    expect(runtime.getItems()[0]).toBe(original)
    expect(runtime.getPreviewItems()[0]).toMatchObject({ id: 'item', x: 60, y: 80 })
    expect(runtime.hitTest({ x: 65, y: 85 })?.id).toBe('item')
    expect(runtime.hitTest({ x: 15, y: 25 })).toBeNull()

    runtime.endPreview()

    expect(runtime.hitTest({ x: 15, y: 25 })?.id).toBe('item')
  })

  it('reports metrics with item and preview counts', () => {
    const runtime = createProjectCanvasRuntime()
    runtime.setItems([
      createCanvasItem({ id: 'a' }),
      createCanvasItem({ id: 'b', hidden: true } as Partial<CanvasItem> & { id: string })
    ])
    runtime.beginPreview([{ id: 'a', changes: { x: 100 } }])

    expect(runtime.getMetrics()).toMatchObject({
      itemCount: 2,
      visibleItemCount: 1,
      previewItemCount: 1,
      indexedItemCount: 2
    })
  })

  it('returns visible items from the viewport without React or DOM state', () => {
    const runtime = createProjectCanvasRuntime()
    runtime.setViewport({ x: 0, y: 0, scale: 1 })
    runtime.setItems([
      createCanvasItem({ id: 'visible', x: 20, y: 20, width: 20, height: 20 }),
      createCanvasItem({ id: 'overscan', x: 120, y: 20, width: 20, height: 20 }),
      createCanvasItem({ id: 'far', x: 300, y: 20, width: 20, height: 20 })
    ])

    expect(
      runtime.getVisibleItems({ stageSize: { width: 100, height: 100 } }).map((item) => item.id)
    ).toEqual(['visible'])
    expect(
      runtime
        .getVisibleItems({ stageSize: { width: 100, height: 100 }, overscanPx: 40 })
        .map((item) => item.id)
    ).toEqual(['overscan', 'visible'])
  })

  it('keeps 3000-item boards spatially indexed while viewport queries stay local', () => {
    const runtime = createProjectCanvasRuntime()
    const items = Array.from({ length: 3000 }, (_, index) => {
      const col = index % 60
      const row = Math.floor(index / 60)
      return createCanvasItem({
        id: `item-${index}`,
        x: col * 256,
        y: row * 256,
        width: 64,
        height: 64
      })
    })

    runtime.setViewport({ x: 0, y: 0, scale: 1 })
    runtime.setItems(items)

    const visibleIds = runtime
      .getVisibleItems({ stageSize: { width: 512, height: 512 } })
      .map((item) => item.id)

    expect(runtime.getMetrics()).toMatchObject({
      itemCount: 3000,
      visibleItemCount: 3000,
      indexedItemCount: 3000
    })
    expect(visibleIds).toHaveLength(4)
    expect(new Set(visibleIds)).toEqual(new Set(['item-0', 'item-1', 'item-60', 'item-61']))
  })

  it('creates a snapshot with viewport visibility and export bounds', () => {
    const runtime = createProjectCanvasRuntime()
    runtime.setItems([
      createCanvasItem({ id: 'a', x: 10, y: 20, width: 30, height: 40 }),
      createCanvasItem({ id: 'b', x: 80, y: 120, width: 50, height: 60 }),
      createCanvasItem({ id: 'far', x: 500, y: 500, width: 20, height: 20 })
    ])
    runtime.setViewport({ x: 0, y: 0, scale: 1 })

    const snapshot = runtime.createSnapshot({
      selectedIds: ['b'],
      stageSize: { width: 160, height: 180 }
    })

    expect(snapshot.items.find((entry) => entry.id === 'b')).toMatchObject({
      selected: true,
      visibleInViewport: true
    })
    expect(snapshot.items.find((entry) => entry.id === 'far')).toMatchObject({
      visibleInViewport: false
    })
    expect(
      getProjectCanvasRuntimeExportBounds(snapshot, { itemIds: ['a', 'b'], padding: 5 })
    ).toEqual({
      x: 5,
      y: 15,
      width: 130,
      height: 170
    })
  })
})
