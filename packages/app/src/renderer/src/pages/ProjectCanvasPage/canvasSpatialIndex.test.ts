import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CANVAS_SPATIAL_INDEX_MAX_INDEXED_CELLS_PER_ENTRY,
  CANVAS_SPATIAL_INDEX_MAX_QUERY_CELLS,
  attachCanvasSpatialIndexAccelerator,
  buildCanvasSpatialIndex,
  disposeCanvasSpatialIndex,
  queryCanvasSpatialIndex,
  queryCanvasSpatialIndexUnordered,
  type CanvasSpatialBounds
} from './canvasSpatialIndex'
import {
  getCanvasSpatialIndexAcceleratorStateForTest,
  resetCanvasSpatialIndexAcceleratorForTest,
  scheduleCanvasSpatialIndexAcceleratorIdleWarmup,
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
    attachCanvasSpatialIndexAccelerator(acceleratedIndex)
    expect(acceleratedIndex.accelerator?.source).toBe('test')

    const acceleratedMatches = queryCanvasSpatialIndex(acceleratedIndex, queryBounds).map(
      (item) => item.id
    )

    expect(acceleratedMatches).toEqual(jsMatches)
    expect(acceleratedMatches).toEqual(['negative', 'wide', 'small'])
  })

  it('falls back to the JS index and discards the accelerator when it returns invalid candidates', () => {
    const dispose = vi.fn()
    setCanvasSpatialIndexAcceleratorFactoryForTest(() => ({
      source: 'test',
      dispose,
      queryIndexes: () => [999]
    }))
    const items = [
      createItem('inside', { minX: 10, minY: 10, maxX: 30, maxY: 30 }),
      createItem('outside', { minX: 1000, minY: 1000, maxX: 1100, maxY: 1100 })
    ]
    const index = buildCanvasSpatialIndex(items, (item) => item.bounds, 64)
    attachCanvasSpatialIndexAccelerator(index)
    expect(index.accelerator?.source).toBe('test')

    const matches = queryCanvasSpatialIndex(index, {
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100
    })

    expect(matches.map((item) => item.id)).toEqual(['inside'])
    expect(index.accelerator).toBeNull()
    expect(dispose).toHaveBeenCalledTimes(1)
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

  it('disposes the optional accelerator exactly once while preserving JS fallback queries', () => {
    const dispose = vi.fn()
    setCanvasSpatialIndexAcceleratorFactoryForTest(
      (flattenedBounds: Float64Array, _options: CanvasSpatialIndexAcceleratorOptions) => {
        const entries = parseMockAcceleratorEntries(flattenedBounds)
        return {
          source: 'test',
          dispose,
          queryIndexes: (queryBounds) =>
            entries.flatMap((entry, entryIndex) =>
              doMockBoundsIntersect(entry.bounds, queryBounds) ? [entryIndex] : []
            )
        }
      }
    )
    const items = [
      createItem('inside', { minX: 10, minY: 10, maxX: 30, maxY: 30 }),
      createItem('outside', { minX: 1000, minY: 1000, maxX: 1100, maxY: 1100 })
    ]
    const index = buildCanvasSpatialIndex(items, (item) => item.bounds, 64)
    attachCanvasSpatialIndexAccelerator(index)

    disposeCanvasSpatialIndex(index)
    disposeCanvasSpatialIndex(index)

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(index.accelerator).toBeNull()
    expect(
      queryCanvasSpatialIndex(index, {
        minX: 0,
        minY: 0,
        maxX: 100,
        maxY: 100
      }).map((item) => item.id)
    ).toEqual(['inside'])
  })

  it('can schedule and cancel idle WASM accelerator warmup without forcing threshold queries', () => {
    const index = buildCanvasSpatialIndex(
      Array.from({ length: 1024 }, (_, index) =>
        createItem(`warmup-item-${index}`, {
          minX: index,
          minY: 0,
          maxX: index + 1,
          maxY: 1
        })
      ),
      (item) => item.bounds,
      64
    )
    const cancelWarmup = scheduleCanvasSpatialIndexAcceleratorIdleWarmup()

    expect(getCanvasSpatialIndexAcceleratorStateForTest()).toEqual(
      expect.objectContaining({
        loadState: 'idle',
        hasScheduledWarmup: true,
        readyVersion: 0
      })
    )

    cancelWarmup()

    expect(getCanvasSpatialIndexAcceleratorStateForTest()).toEqual(
      expect.objectContaining({
        loadState: 'idle',
        hasScheduledWarmup: false,
        readyVersion: 0
      })
    )
    disposeCanvasSpatialIndex(index)
  })

  it('does not schedule WASM warmup for indexes below the accelerator threshold', () => {
    const smallIndex = buildCanvasSpatialIndex(
      [createItem('small', { minX: 0, minY: 0, maxX: 1, maxY: 1 })],
      (item) => item.bounds,
      64
    )

    attachCanvasSpatialIndexAccelerator(smallIndex)
    expect(getCanvasSpatialIndexAcceleratorStateForTest()).toEqual(
      expect.objectContaining({
        loadState: 'idle',
        hasScheduledWarmup: false
      })
    )

    disposeCanvasSpatialIndex(smallIndex)
  })

  it('attaches acceleration lazily after readiness without requiring an index rebuild', () => {
    const dispose = vi.fn()
    const items = [createItem('inside', { minX: 10, minY: 10, maxX: 30, maxY: 30 })]
    const index = buildCanvasSpatialIndex(items, (item) => item.bounds, 64)

    expect(index.accelerator).toBeNull()
    setCanvasSpatialIndexAcceleratorFactoryForTest(
      (flattenedBounds: Float64Array, _options: CanvasSpatialIndexAcceleratorOptions) => {
        const entries = parseMockAcceleratorEntries(flattenedBounds)
        return {
          source: 'test',
          dispose,
          queryIndexes: (queryBounds) =>
            entries.flatMap((entry, entryIndex) =>
              doMockBoundsIntersect(entry.bounds, queryBounds) ? [entryIndex] : []
            )
        }
      }
    )

    const matches = queryCanvasSpatialIndex(index, {
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100
    })

    expect(matches.map((item) => item.id)).toEqual(['inside'])
    expect(index.accelerator?.source).toBe('test')
    disposeCanvasSpatialIndex(index)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('does not retry failed accelerator construction on every hot-path query', () => {
    const createAccelerator = vi.fn(() => null)
    setCanvasSpatialIndexAcceleratorFactoryForTest(createAccelerator)
    const items = [createItem('inside', { minX: 10, minY: 10, maxX: 30, maxY: 30 })]
    const index = buildCanvasSpatialIndex(items, (item) => item.bounds, 64)
    const queryBounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 }

    expect(queryCanvasSpatialIndex(index, queryBounds).map((item) => item.id)).toEqual(['inside'])
    expect(queryCanvasSpatialIndex(index, queryBounds).map((item) => item.id)).toEqual(['inside'])

    expect(createAccelerator).toHaveBeenCalledTimes(1)
    expect(index.accelerator).toBeNull()
  })

  it('can skip stable ordering work for visibility-only unordered queries', () => {
    const items = [
      createItem('left', { minX: 0, minY: 0, maxX: 220, maxY: 220 }),
      createItem('right', { minX: 128, minY: 0, maxX: 300, maxY: 220 }),
      createItem('far', { minX: 800, minY: 800, maxX: 900, maxY: 900 })
    ]
    const index = buildCanvasSpatialIndex(items, (item) => item.bounds, 64)

    const matches = queryCanvasSpatialIndexUnordered(index, {
      minX: 160,
      minY: 40,
      maxX: 180,
      maxY: 80
    })

    expect(new Set(matches.map((item) => item.id))).toEqual(new Set(['left', 'right']))
    expect(matches).toHaveLength(2)
  })
})
