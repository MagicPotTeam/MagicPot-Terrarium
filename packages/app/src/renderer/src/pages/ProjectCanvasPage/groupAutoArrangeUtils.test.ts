import { describe, expect, it } from 'vitest'
import type {
  CanvasAnnotationItem,
  CanvasImageItem,
  CanvasModel3DItem,
  CanvasTextItem
} from './types'
import {
  compareGroupAutoArrangePositionEntries,
  detectSpatialGridLayout,
  extractCanvasFileNameFromSrc,
  getCanvasItemAutoArrangeSortName,
  resolveAutoArrangeSpatialGridLayout
} from './groupAutoArrangeUtils'

function createImageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'blob:image-1',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createModelItem(overrides: Partial<CanvasModel3DItem> = {}): CanvasModel3DItem {
  return {
    id: 'model-1',
    type: 'model3d',
    src: 'blob:model-1',
    fileName: 'model.glb',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createTextItem(overrides: Partial<CanvasTextItem> = {}): CanvasTextItem {
  return {
    id: 'text-1',
    type: 'text',
    text: 'note',
    fontSize: 16,
    fontFamily: 'sans-serif',
    fill: '#fff',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createAnnotationItem(overrides: Partial<CanvasAnnotationItem> = {}): CanvasAnnotationItem {
  return {
    id: 'annotation-1',
    type: 'annotation',
    shape: 'rect',
    stroke: '#fff',
    fillOpacity: 0,
    strokeWidth: 1,
    label: '',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

describe('groupAutoArrangeUtils', () => {
  it('prefers the explicit fileName when present', () => {
    expect(getCanvasItemAutoArrangeSortName(createImageItem({ fileName: 'b-02.png' }))).toBe(
      'b-02.png'
    )
    expect(getCanvasItemAutoArrangeSortName(createModelItem({ fileName: 'a-01.glb' }))).toBe(
      'a-01.glb'
    )
  })

  it('falls back to file metadata and decoded src file names', () => {
    expect(
      getCanvasItemAutoArrangeSortName(
        createImageItem({
          fileName: '',
          fileItem: { filename: 'cover-12.png' }
        })
      )
    ).toBe('cover-12.png')

    expect(
      getCanvasItemAutoArrangeSortName(
        createImageItem({
          fileName: '',
          src: 'local-media:///Users/demo/scene%2007.png'
        })
      )
    ).toBe('scene 07.png')
  })

  it('falls back to text-like content when there is no file name', () => {
    expect(getCanvasItemAutoArrangeSortName(createTextItem({ text: 'Alpha note' }))).toBe(
      'Alpha note'
    )
    expect(
      getCanvasItemAutoArrangeSortName(createAnnotationItem({ label: 'Callout', text: 'Ignored' }))
    ).toBe('Callout')
  })

  it('supports natural file-name sorting', () => {
    const items = [
      createImageItem({ id: 'image-10', fileName: 'image-10.png' }),
      createImageItem({ id: 'image-2', fileName: 'image-2.png' }),
      createImageItem({ id: 'image-1', fileName: 'image-1.png' })
    ]

    const sortedIds = [...items]
      .sort((a, b) =>
        getCanvasItemAutoArrangeSortName(a).localeCompare(
          getCanvasItemAutoArrangeSortName(b),
          undefined,
          {
            numeric: true,
            sensitivity: 'base'
          }
        )
      )
      .map((item) => item.id)

    expect(sortedIds).toEqual(['image-1', 'image-2', 'image-10'])
  })

  it('extracts file names from local-media and file urls', () => {
    expect(extractCanvasFileNameFromSrc('local-media:///C:/demo/folder/test%201.png')).toBe(
      'test 1.png'
    )
    expect(extractCanvasFileNameFromSrc('file:///Users/demo/model.glb?version=1#preview')).toBe(
      'model.glb'
    )
  })

  it('sorts group items from left to right within a row, then top to bottom', () => {
    const entries = [
      { name: '', minX: 220, minY: 12, order: 0 },
      { name: '', minX: 20, minY: 10, order: 1 },
      { name: '', minX: 210, minY: 182, order: 2 },
      { name: '', minX: 10, minY: 190, order: 3 }
    ]

    const sortedOrders = [...entries]
      .sort(compareGroupAutoArrangePositionEntries)
      .map((entry) => entry.order)

    expect(sortedOrders).toEqual([1, 0, 3, 2])
  })

  it('treats near-aligned items as the same row and falls back to x position', () => {
    const entries = [
      { name: '', minX: 200, minY: 16, order: 0 },
      { name: '', minX: 20, minY: 28, order: 1 }
    ]

    const sortedOrders = [...entries]
      .sort(compareGroupAutoArrangePositionEntries)
      .map((entry) => entry.order)

    expect(sortedOrders).toEqual([1, 0])
  })
})

describe('detectSpatialGridLayout', () => {
  it('detects a 2x2 grid from 4 items in 2 rows and 2 columns', () => {
    const entries = [
      { index: 0, minX: 10, minY: 10, width: 200, height: 200 },
      { index: 1, minX: 300, minY: 20, width: 250, height: 200 },
      { index: 2, minX: 20, minY: 400, width: 200, height: 250 },
      { index: 3, minX: 310, minY: 410, width: 250, height: 250 }
    ]

    const result = detectSpatialGridLayout(entries)

    expect(result.rows).toBe(2)
    expect(result.columns).toBe(2)
    expect(result.assignments).toEqual([
      { index: 0, row: 0, col: 0 },
      { index: 1, row: 0, col: 1 },
      { index: 2, row: 1, col: 0 },
      { index: 3, row: 1, col: 1 }
    ])
  })

  it('detects a single row of items', () => {
    const entries = [
      { index: 0, minX: 500, minY: 10, width: 100, height: 100 },
      { index: 1, minX: 10, minY: 15, width: 100, height: 100 },
      { index: 2, minX: 250, minY: 12, width: 100, height: 100 }
    ]

    const result = detectSpatialGridLayout(entries)

    expect(result.rows).toBe(1)
    expect(result.columns).toBe(3)
    // Should be ordered by X: index 1 (x=10), index 2 (x=250), index 0 (x=500)
    expect(result.assignments).toEqual([
      { index: 1, row: 0, col: 0 },
      { index: 2, row: 0, col: 1 },
      { index: 0, row: 0, col: 2 }
    ])
  })

  it('detects a single column of items', () => {
    const entries = [
      { index: 0, minX: 10, minY: 500, width: 100, height: 100 },
      { index: 1, minX: 15, minY: 10, width: 100, height: 100 },
      { index: 2, minX: 12, minY: 250, width: 100, height: 100 }
    ]

    const result = detectSpatialGridLayout(entries)

    expect(result.rows).toBe(3)
    expect(result.columns).toBe(1)
    // Should be ordered by Y: index 1 (y=10), index 2 (y=250), index 0 (y=500)
    expect(result.assignments).toEqual([
      { index: 1, row: 0, col: 0 },
      { index: 2, row: 1, col: 0 },
      { index: 0, row: 2, col: 0 }
    ])
  })

  it('handles uneven rows (3 items in row 1, 2 in row 2)', () => {
    const entries = [
      { index: 0, minX: 10, minY: 10, width: 100, height: 100 },
      { index: 1, minX: 200, minY: 15, width: 100, height: 100 },
      { index: 2, minX: 400, minY: 12, width: 100, height: 100 },
      { index: 3, minX: 10, minY: 300, width: 100, height: 100 },
      { index: 4, minX: 200, minY: 310, width: 100, height: 100 }
    ]

    const result = detectSpatialGridLayout(entries)

    expect(result.rows).toBe(2)
    expect(result.columns).toBe(3)
    expect(result.assignments).toEqual([
      { index: 0, row: 0, col: 0 },
      { index: 1, row: 0, col: 1 },
      { index: 2, row: 0, col: 2 },
      { index: 3, row: 1, col: 0 },
      { index: 4, row: 1, col: 1 }
    ])
  })

  it('handles a single item', () => {
    const entries = [{ index: 0, minX: 50, minY: 50, width: 100, height: 100 }]

    const result = detectSpatialGridLayout(entries)

    expect(result.rows).toBe(1)
    expect(result.columns).toBe(1)
    expect(result.assignments).toEqual([{ index: 0, row: 0, col: 0 }])
  })

  it('handles empty input', () => {
    const result = detectSpatialGridLayout([])

    expect(result.rows).toBe(0)
    expect(result.columns).toBe(0)
    expect(result.assignments).toEqual([])
  })

  it('keeps small intentional columns intact when resolving auto arrange layout', () => {
    const entries = [
      { index: 0, minX: 10, minY: 500, width: 100, height: 100 },
      { index: 1, minX: 15, minY: 10, width: 100, height: 100 },
      { index: 2, minX: 12, minY: 250, width: 100, height: 100 }
    ]

    const result = resolveAutoArrangeSpatialGridLayout(entries)

    expect(result.rows).toBe(3)
    expect(result.columns).toBe(1)
    expect(result.assignments).toEqual([
      { index: 1, row: 0, col: 0 },
      { index: 2, row: 1, col: 0 },
      { index: 0, row: 2, col: 0 }
    ])
  })

  it('reflows large degenerate columns into a balanced contact sheet', () => {
    const entries = Array.from({ length: 64 }, (_, index) => ({
      index,
      minX: 10 + (index % 2) * 4,
      minY: index * 140,
      width: 120,
      height: 90
    }))

    const result = resolveAutoArrangeSpatialGridLayout(entries)

    expect(result.columns).toBeGreaterThan(1)
    expect(result.rows).toBeLessThan(20)
    expect(result.assignments[0]).toEqual({ index: 0, row: 0, col: 0 })
    expect(result.assignments[1]).toEqual({ index: 1, row: 0, col: 1 })
  })

  it('reflows large physically tall layouts even when detected rows and columns look balanced', () => {
    const entries = Array.from({ length: 120 }, (_, index) => {
      const detectedColumn = index % 10
      const detectedRow = Math.floor(index / 10)

      return {
        index,
        minX: detectedColumn * 132,
        minY: detectedRow * 1200,
        width: 120,
        height: 900
      }
    })

    const detected = detectSpatialGridLayout(entries)
    const result = resolveAutoArrangeSpatialGridLayout(entries)

    expect(detected.rows / detected.columns).toBeLessThan(3)
    expect(result.rows).toBeLessThan(detected.rows)
    expect(result.columns).toBeGreaterThan(detected.columns)
    expect(result.assignments[0]).toEqual({ index: 0, row: 0, col: 0 })
  })
})
