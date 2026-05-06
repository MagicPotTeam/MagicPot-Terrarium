import { describe, expect, it, vi } from 'vitest'

import type { CanvasItem } from './types'
import {
  buildCanvasPlaybackVisibilitySpatialIndex,
  buildTextureObjectUrlMap,
  resolveRenderableHtmlItems,
  resolveRenderedModel3DItems,
  resolveVisibleCanvasItems
} from './canvasViewerPlaybackUtils'

function createCanvasItem(
  overrides: Partial<CanvasItem> & Pick<CanvasItem, 'id' | 'type'>
): CanvasItem {
  const baseItem = {
    id: overrides.id,
    type: overrides.type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  } as CanvasItem

  return Object.assign(baseItem, overrides)
}

describe('resolveVisibleCanvasItems', () => {
  it('keeps selected items visible while filtering far-away items and group playback members', () => {
    const fillerItems = Array.from({ length: 100 }, (_, index) =>
      createCanvasItem({ id: `filler-${index}`, type: 'image', x: 20 + index, y: 20 + index })
    )

    const sortedItems = [
      ...fillerItems,
      createCanvasItem({ id: 'selected-far', type: 'image', x: 9000 }),
      createCanvasItem({ id: 'nearby', type: 'image', x: 20, y: 20 }),
      createCanvasItem({ id: 'hidden-by-playback', type: 'image', x: 10, y: 10 }),
      createCanvasItem({ id: 'far-away', type: 'image', x: 12000, y: 12000 })
    ]

    const visibleItems = resolveVisibleCanvasItems({
      groupPlaybackItemIds: ['hidden-by-playback'],
      selectedIds: new Set(['selected-far']),
      sortedItems,
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 800, height: 600 }
    })

    const visibleIds = new Set(visibleItems.map((item) => item.id))
    expect(visibleIds.has('selected-far')).toBe(true)
    expect(visibleIds.has('nearby')).toBe(true)
    expect(visibleIds.has('hidden-by-playback')).toBe(false)
    expect(visibleIds.has('far-away')).toBe(false)
  })

  it('still culls off-screen items when the canvas has only a few elements', () => {
    const sortedItems = [
      createCanvasItem({ id: 'nearby', type: 'image', x: 20, y: 20 }),
      createCanvasItem({ id: 'far-away', type: 'model3d', x: 12000, y: 12000 }),
      createCanvasItem({ id: 'selected-far', type: 'video', x: 9000, y: 0 })
    ]

    const visibleItems = resolveVisibleCanvasItems({
      groupPlaybackItemIds: [],
      selectedIds: new Set(['selected-far']),
      sortedItems,
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 800, height: 600 }
    })

    expect(visibleItems.map((item) => item.id)).toEqual(['nearby', 'selected-far'])
  })

  it('supports viewport queries through a prebuilt spatial index while preserving item order', () => {
    const sortedItems = [
      createCanvasItem({ id: 'near-1', type: 'image', x: 10, y: 10 }),
      createCanvasItem({ id: 'far', type: 'image', x: 12000, y: 12000 }),
      createCanvasItem({ id: 'near-2', type: 'video', x: 40, y: 20 })
    ]
    const spatialIndex = buildCanvasPlaybackVisibilitySpatialIndex({
      sortedItems
    })

    const visibleItems = resolveVisibleCanvasItems({
      selectedIds: new Set(),
      sortedItems,
      spatialIndex,
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 800, height: 600 }
    })

    expect(visibleItems.map((item) => item.id)).toEqual(['near-1', 'near-2'])
  })

  it('keeps rotated items visible when their transformed bounds still intersect the viewport', () => {
    const rotatedEdgeItem = createCanvasItem({
      id: 'rotated-edge',
      type: 'image',
      x: 1300,
      y: 180,
      width: 200,
      height: 200,
      rotation: 45
    })

    const visibleItems = resolveVisibleCanvasItems({
      selectedIds: new Set(),
      sortedItems: [rotatedEdgeItem],
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 800, height: 600 }
    })

    expect(visibleItems.map((item) => item.id)).toEqual(['rotated-edge'])
  })

  it('keeps large mixed scenes queryable through the spatial index without losing selected offscreen items', () => {
    const visibleGridItems = Array.from({ length: 256 }, (_, index) =>
      createCanvasItem({
        id: `visible-${index}`,
        type: index % 3 === 0 ? 'image' : index % 3 === 1 ? 'video' : 'html',
        x: (index % 16) * 140,
        y: Math.floor(index / 16) * 110,
        zIndex: index
      })
    )
    const offscreenItems = Array.from({ length: 256 }, (_, index) =>
      createCanvasItem({
        id: `offscreen-${index}`,
        type: index % 2 === 0 ? 'image' : 'model3d',
        x: 10000 + index * 120,
        y: 8000 + index * 90,
        zIndex: 500 + index
      })
    )
    const selectedFarItem = createCanvasItem({
      id: 'selected-far-large-scene',
      type: 'video',
      x: 16000,
      y: 12000,
      zIndex: 2000
    })
    const playbackHiddenItem = createCanvasItem({
      id: 'playback-hidden-large-scene',
      type: 'image',
      x: 32,
      y: 48,
      zIndex: 2001
    })
    const sortedItems = [
      ...visibleGridItems,
      ...offscreenItems,
      selectedFarItem,
      playbackHiddenItem
    ]
    const spatialIndex = buildCanvasPlaybackVisibilitySpatialIndex({
      groupPlaybackItemIds: [playbackHiddenItem.id],
      sortedItems
    })

    const visibleItems = resolveVisibleCanvasItems({
      groupPlaybackItemIds: [playbackHiddenItem.id],
      selectedIds: new Set([selectedFarItem.id]),
      sortedItems,
      spatialIndex,
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 1600, height: 1000 }
    })

    const visibleIds = new Set(visibleItems.map((item) => item.id))
    expect(visibleIds.has(selectedFarItem.id)).toBe(true)
    expect(visibleIds.has(playbackHiddenItem.id)).toBe(false)
    expect(visibleItems.length).toBeGreaterThan(100)
    expect(visibleItems.length).toBeLessThan(sortedItems.length)
    expect(visibleItems[0]?.id).toBe('visible-0')
  })
})

describe('resolveRenderedModel3DItems', () => {
  it('excludes deferred models and group-playback members from standalone rendering', () => {
    const deferredModel = createCanvasItem({
      id: 'deferred-model',
      type: 'model3d'
    }) as CanvasItem & { deferRender?: boolean }
    deferredModel.deferRender = true

    const visibleItems = [
      createCanvasItem({ id: 'ready-model', type: 'model3d' }),
      deferredModel,
      createCanvasItem({ id: 'playback-model', type: 'model3d' })
    ]

    const renderedItems = resolveRenderedModel3DItems({
      groupPlaybackItemIds: ['playback-model'],
      sortedItems: visibleItems,
      visibleItems
    })

    expect(renderedItems.map((item) => item.id)).toEqual(['ready-model'])
  })
})

describe('resolveRenderableHtmlItems', () => {
  it('uses visible items for html overlays unless export rendering forces full mount', () => {
    const visibleHtml = createCanvasItem({ id: 'html-visible', type: 'html' })
    const offscreenHtml = createCanvasItem({ id: 'html-offscreen', type: 'html', x: 5000, y: 4000 })
    const hiddenByPlayback = createCanvasItem({ id: 'html-playback', type: 'html' })

    expect(
      resolveRenderableHtmlItems({
        groupPlaybackItemIds: ['html-playback'],
        sortedItems: [visibleHtml, offscreenHtml, hiddenByPlayback],
        visibleItems: [visibleHtml, hiddenByPlayback]
      }).map((item) => item.id)
    ).toEqual(['html-visible'])

    expect(
      resolveRenderableHtmlItems({
        forceRenderAllItemsForExport: true,
        groupPlaybackItemIds: ['html-playback'],
        sortedItems: [visibleHtml, offscreenHtml, hiddenByPlayback],
        visibleItems: [visibleHtml, hiddenByPlayback]
      }).map((item) => item.id)
    ).toEqual(['html-visible', 'html-offscreen'])
  })
})

describe('buildTextureObjectUrlMap', () => {
  it('keeps only supported texture files', () => {
    const createObjectUrl = vi.fn((file: File) => `blob:${file.name}`)
    const files = [
      new File(['diffuse'], 'diffuse.png', { type: 'image/png' }),
      new File(['material'], 'material.mtl', { type: 'text/plain' }),
      new File(['notes'], 'notes.txt', { type: 'text/plain' })
    ]

    expect(buildTextureObjectUrlMap(files, createObjectUrl)).toEqual({
      'diffuse.png': 'blob:diffuse.png',
      'material.mtl': 'blob:material.mtl'
    })
    expect(createObjectUrl).toHaveBeenCalledTimes(2)
  })
})
