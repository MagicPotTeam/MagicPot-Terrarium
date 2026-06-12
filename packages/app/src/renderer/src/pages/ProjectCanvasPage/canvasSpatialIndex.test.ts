import { afterEach, describe, expect, it } from 'vitest'

import {
  CANVAS_SPATIAL_INDEX_MAX_INDEXED_CELLS_PER_ENTRY,
  CANVAS_SPATIAL_INDEX_MAX_QUERY_CELLS,
  buildCanvasSpatialIndex,
  queryCanvasSpatialIndex,
  type CanvasSpatialBounds
} from './canvasSpatialIndex'
import {
  resetCanvasSpatialIndexAcceleratorForTest,
  setCanvasSpatialIndexAcceleratorFactoryForTest,
  type CanvasSpatialIndexAcceleratorOptions
} from './canvasSpatialIndexAccelerator'

type MockAcceleratorEntry = {
  bounds: CanvasSpatialBounds
}

type MockItem = {
  id: string
  bounds: CanvasSpatialBounds
}

function createItem(id: string, bounds: CanvasSpatialBounds): MockItem {
  return { id, bounds }
}

function doMockBoundsIntersect(left: CanvasSpatialBounds, right: CanvasSpatialBounds) {
  return (
    left.minX < right.maxX &&
    left.maxX > right.minX &&
    left.minY < right.maxY &&
    left.maxY > right.minY
  )
}

function parseMockAcceleratorEntries(flattenedBounds: Float64Array): MockAcceleratorEntry[] {
  const entries: MockAcceleratorEntry[] = []
  for (let offset = 0; offset < flattenedBounds.length; offset += 4) {
    entries.push({
      bounds: {
        minX: flattenedBounds[offset],
        minY: flattenedBounds[offset + 1],
        maxX: flattenedBounds[offset + 2],
        maxY: flattenedBounds[offset + 3]
      }
    })
  }
  return entries
}

function installMockSpatialIndexAccelerator() {
  setCanvasSpatialIndexAcceleratorFactoryForTest(
    (flattenedBounds: Float64Array, _options: CanvasSpatialIndexAcceleratorOptions) => {
      const entries = parseMockAcceleratorEntries(flattenedBounds)
      return {
        source: 'test',
        queryIndexes: (queryBounds) =>
          entries.flatMap((entry, entryIndex) =>
            doMockBoundsIntersect(entry.bounds, queryBounds) ? [entryIndex] : []
          )
      }
    }
  )
}

describe('canvasSpatialIndex', () => {
  afterEach(() => {
    resetCanvasSpatialIndexAcceleratorForTest()
  })

  it('returns only intersecting items from populated cells', () => {
    const items = [
      createItem('left', { minX: 0, minY: 0, maxX: 80, maxY: 80 }),
      createItem('right', { minX: 620, minY: 40, maxX: 760, maxY: 200 }),
      createItem('far', { minX: 1600, minY: 1600, maxX: 1700, maxY: 1700 })
    ]
    const index = buildCanvasSpatialIndex(items, (item) => item.bounds, 256)

    const matches = queryCanvasSpatialIndex(index, {
      minX: 560,
      minY: 0,
      maxX: 700,
      maxY: 160
    })

    expect(matches.map((item) => item.id)).toEqual(['right'])
  })

  it('deduplicates items that span multiple cells', () => {
    const spanningItem = createItem('wide', {
      minX: 100,
      minY: 100,
      maxX: 900,
      maxY: 220
    })
    const index = buildCanvasSpatialIndex([spanningItem], (item) => item.bounds, 128)

    const matches = queryCanvasSpatialIndex(index, {
      minX: 300,
      minY: 120,
      maxX: 500,
      maxY: 180
    })

    expect(matches).toHaveLength(1)
    expect(matches[0]?.id).toBe('wide')
  })

  it('keeps oversized entries out of the cell map and still returns them by bounds', () => {
    const hugeItem = createItem('huge', {
      minX: -1_000_000,
      minY: -1_000_000,
      maxX: 1_000_000,
      maxY: 1_000_000
    })
    const smallItem = createItem('small', {
      minX: 20,
      minY: 20,
      maxX: 80,
      maxY: 80
    })
    const index = buildCanvasSpatialIndex([hugeItem, smallItem], (item) => item.bounds, 64)

    expect(index.overflowEntryIndexes).toEqual([0])
    expect(index.cells.size).toBeLessThan(CANVAS_SPATIAL_INDEX_MAX_INDEXED_CELLS_PER_ENTRY)

    const matches = queryCanvasSpatialIndex(index, {
      minX: 40,
      minY: 40,
      maxX: 48,
      maxY: 48
    })

    expect(matches.map((item) => item.id)).toEqual(['huge', 'small'])
  })

  it('uses the optional accelerator without changing query results or ordering', () => {
    const items = [
      createItem('negative', { minX: -300, minY: -200, maxX: -20, maxY: 50 }),
      createItem('wide', { minX: 100, minY: 100, maxX: 900, maxY: 220 }),
      createItem('small', { minX: 180, minY: 160, maxX: 220, maxY: 190 }),
      createItem('far', { minX: 5000, minY: 5000, maxX: 5100, maxY: 5100 })
    ]
    const queryBounds = { minX: -40, minY: -30, maxX: 240, maxY: 210 }

    const jsIndex = buildCanvasSpatialIndex(items, (item) => item.bounds, 128)
    const jsMatches = queryCanvasSpatialIndex(jsIndex, queryBounds).map((item) => item.id)

    installMockSpatialIndexAccelerator()
    const acceleratedIndex = buildCanvasSpatialIndex(items, (item) => item.bounds, 128)
    expect(acceleratedIndex.accelerator?.source).toBe('test')

    const acceleratedMatches = queryCanvasSpatialIndex(acceleratedIndex, queryBounds).map(
      (item) => item.id
    )

    expect(acceleratedMatches).toEqual(jsMatches)
    expect(acceleratedMatches).toEqual(['negative', 'wide', 'small'])
  })

  it('falls back to the JS index when the accelerator returns invalid candidates', () => {
    setCanvasSpatialIndexAcceleratorFactoryForTest(() => ({
      source: 'test',
      queryIndexes: () => [999]
    }))
    const items = [
      createItem('inside', { minX: 10, minY: 10, maxX: 30, maxY: 30 }),
      createItem('outside', { minX: 1000, minY: 1000, maxX: 1100, maxY: 1100 })
    ]
    const index = buildCanvasSpatialIndex(items, (item) => item.bounds, 64)

    const matches = queryCanvasSpatialIndex(index, {
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100
    })

    expect(index.accelerator?.source).toBe('test')
    expect(matches.map((item) => item.id)).toEqual(['inside'])
  })

  it('falls back to a bounded linear scan for oversized viewport queries', () => {
    const items = [
      createItem('inside', { minX: 10, minY: 10, maxX: 30, maxY: 30 }),
      createItem('outside', { minX: 100_000, minY: 100_000, maxX: 100_100, maxY: 100_100 })
    ]
    const index = buildCanvasSpatialIndex(items, (item) => item.bounds, 64)
    const querySide = Math.ceil(Math.sqrt(CANVAS_SPATIAL_INDEX_MAX_QUERY_CELLS + 1) * 64)

    const matches = queryCanvasSpatialIndex(index, {
      minX: -querySide,
      minY: -querySide,
      maxX: querySide,
      maxY: querySide
    })

    expect(matches.map((item) => item.id)).toEqual(['inside'])
  })
})
