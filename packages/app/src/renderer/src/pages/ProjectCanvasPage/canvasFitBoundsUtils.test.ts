import { describe, expect, it } from 'vitest'

import {
  canvasExportBoundsToFocusBounds,
  getExactSelectedGroupBounds,
  resolveCanvasFitBounds
} from './canvasFitBoundsUtils'
import type { CanvasExportBounds } from './groupPlaybackUtils'
import type { CanvasGroup } from './types'
import type { CanvasImageItem, CanvasItem } from './types'

function createImageItem(
  id: string,
  x: number,
  y: number,
  width = 120,
  height = 80
): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `${id}.png`,
    x,
    y,
    width,
    height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

describe('canvasExportBoundsToFocusBounds', () => {
  it('converts export bounds into focus bounds', () => {
    expect(
      canvasExportBoundsToFocusBounds({
        x: 40,
        y: 60,
        width: 320,
        height: 180
      })
    ).toEqual({
      minX: 40,
      minY: 60,
      maxX: 360,
      maxY: 240
    })
  })
})

describe('resolveCanvasFitBounds', () => {
  const items: CanvasItem[] = [createImageItem('a', 20, 30), createImageItem('b', 240, 180, 90, 70)]

  it('fits the full canvas when nothing is selected', () => {
    expect(
      resolveCanvasFitBounds({
        items,
        selectedIds: new Set(),
        getCanvasItemsVisualBounds: () => null
      })
    ).toEqual({
      minX: 20,
      minY: 30,
      maxX: 330,
      maxY: 250
    })
  })

  it('fits the selected items before falling back to the full canvas', () => {
    expect(
      resolveCanvasFitBounds({
        items,
        selectedIds: new Set(['b']),
        getCanvasItemsVisualBounds: (targetItems) =>
          targetItems[0]?.id === 'b'
            ? {
                x: 230,
                y: 170,
                width: 120,
                height: 90
              }
            : null
      })
    ).toEqual({
      minX: 230,
      minY: 170,
      maxX: 350,
      maxY: 260
    })
  })

  it('prefers the exact selected group bounds when the whole group is selected', () => {
    const exactSelectedGroupBounds: CanvasExportBounds = {
      x: 10,
      y: 15,
      width: 420,
      height: 260
    }

    expect(
      resolveCanvasFitBounds({
        items,
        selectedIds: new Set(['a', 'b']),
        exactSelectedGroupBounds,
        getCanvasItemsVisualBounds: () => {
          throw new Error('should not be called when exactSelectedGroupBounds is provided')
        }
      })
    ).toEqual({
      minX: 10,
      minY: 15,
      maxX: 430,
      maxY: 275
    })
  })

  it('falls back to all items when the selection is stale', () => {
    expect(
      resolveCanvasFitBounds({
        items,
        selectedIds: new Set(['missing']),
        getCanvasItemsVisualBounds: () => null
      })
    ).toEqual({
      minX: 20,
      minY: 30,
      maxX: 330,
      maxY: 250
    })
  })
})

describe('getExactSelectedGroupBounds', () => {
  const items: CanvasItem[] = [createImageItem('a', 20, 30), createImageItem('b', 240, 180, 90, 70)]
  const groups: CanvasGroup[] = [
    {
      id: 'g-1',
      name: 'Group 1',
      itemIds: ['a', 'b'],
      createdAt: '2026-03-29T00:00:00.000Z'
    }
  ]

  it('returns the selected group bounds when the entire group is selected', () => {
    expect(
      getExactSelectedGroupBounds({
        groups,
        items,
        selectedIds: new Set(['a', 'b']),
        getCanvasItemsVisualBounds: () => ({
          x: 10,
          y: 15,
          width: 420,
          height: 260
        })
      })
    ).toEqual({
      x: 10,
      y: 15,
      width: 420,
      height: 260
    })
  })

  it('returns null when the selection only covers part of a group', () => {
    expect(
      getExactSelectedGroupBounds({
        groups,
        items,
        selectedIds: new Set(['a']),
        getCanvasItemsVisualBounds: () => {
          throw new Error('should not be called for partial selections')
        }
      })
    ).toBeNull()
  })
})
