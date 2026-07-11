import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CanvasSpatialIndex } from './canvasSpatialIndex'

const spatialIndexMocks = vi.hoisted(() => ({
  attachCanvasSpatialIndexAccelerator: vi.fn(),
  disposeCanvasSpatialIndex: vi.fn(),
  scheduleCanvasSpatialIndexAcceleratorIdleWarmup: vi.fn(),
  shouldScheduleCanvasSpatialIndexAcceleratorWarmup: vi.fn()
}))

vi.mock('./canvasSpatialIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canvasSpatialIndex')>()
  return {
    ...actual,
    attachCanvasSpatialIndexAccelerator: spatialIndexMocks.attachCanvasSpatialIndexAccelerator,
    disposeCanvasSpatialIndex: spatialIndexMocks.disposeCanvasSpatialIndex
  }
})

vi.mock('./canvasSpatialIndexAccelerator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canvasSpatialIndexAccelerator')>()
  return {
    ...actual,
    scheduleCanvasSpatialIndexAcceleratorIdleWarmup:
      spatialIndexMocks.scheduleCanvasSpatialIndexAcceleratorIdleWarmup,
    shouldScheduleCanvasSpatialIndexAcceleratorWarmup:
      spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup
  }
})

import { useCanvasSpatialIndexLifecycle } from './useCanvasSpatialIndexLifecycle'

type TestEntry = { id: string }

function createIndex(id: string, entryCount = 1): CanvasSpatialIndex<TestEntry> {
  return {
    cellSize: 512,
    entries: Array.from({ length: entryCount }, (_, index) => ({
      item: { id: `${id}-${index}` },
      bounds: { minX: index, minY: index, maxX: index + 1, maxY: index + 1 }
    })),
    cells: new Map(),
    overflowEntryIndexes: [],
    accelerator: null
  }
}

describe('useCanvasSpatialIndexLifecycle', () => {
  beforeEach(() => {
    spatialIndexMocks.attachCanvasSpatialIndexAccelerator.mockReset()
    spatialIndexMocks.disposeCanvasSpatialIndex.mockReset()
    spatialIndexMocks.scheduleCanvasSpatialIndexAcceleratorIdleWarmup.mockReset()
    spatialIndexMocks.scheduleCanvasSpatialIndexAcceleratorIdleWarmup.mockReturnValue(
      () => undefined
    )
    spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup.mockReset()
    spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup.mockReturnValue(false)
  })

  it('attaches the accelerator on mount and disposes the owned index on unmount', () => {
    const index = createIndex('owned')

    const { unmount } = renderHook(() => useCanvasSpatialIndexLifecycle(index))

    expect(spatialIndexMocks.attachCanvasSpatialIndexAccelerator).toHaveBeenCalledTimes(1)
    expect(spatialIndexMocks.attachCanvasSpatialIndexAccelerator).toHaveBeenCalledWith(index)
    expect(spatialIndexMocks.disposeCanvasSpatialIndex).not.toHaveBeenCalled()

    unmount()

    expect(spatialIndexMocks.disposeCanvasSpatialIndex).toHaveBeenCalledTimes(1)
    expect(spatialIndexMocks.disposeCanvasSpatialIndex).toHaveBeenCalledWith(index)
  })

  it('disposes the previous index before attaching a replacement index', () => {
    const first = createIndex('first')
    const second = createIndex('second')

    const { rerender, unmount } = renderHook(({ index }) => useCanvasSpatialIndexLifecycle(index), {
      initialProps: { index: first }
    })

    rerender({ index: second })

    expect(spatialIndexMocks.attachCanvasSpatialIndexAccelerator).toHaveBeenNthCalledWith(1, first)
    expect(spatialIndexMocks.disposeCanvasSpatialIndex).toHaveBeenNthCalledWith(1, first)
    expect(spatialIndexMocks.attachCanvasSpatialIndexAccelerator).toHaveBeenNthCalledWith(2, second)

    unmount()

    expect(spatialIndexMocks.disposeCanvasSpatialIndex).toHaveBeenNthCalledWith(2, second)
  })

  it('does not schedule WASM warmup when warmup is false', () => {
    spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup.mockReturnValue(true)
    const index = createIndex('cold', 2048)

    const { unmount } = renderHook(() => useCanvasSpatialIndexLifecycle(index, { warmup: false }))

    expect(
      spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup
    ).not.toHaveBeenCalled()
    expect(spatialIndexMocks.scheduleCanvasSpatialIndexAcceleratorIdleWarmup).not.toHaveBeenCalled()

    unmount()
  })

  it('schedules and cancels idle warmup when enabled for a large index', () => {
    const cancelWarmup = vi.fn()
    spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup.mockReturnValue(true)
    spatialIndexMocks.scheduleCanvasSpatialIndexAcceleratorIdleWarmup.mockReturnValue(cancelWarmup)
    const index = createIndex('warm', 2048)

    const { unmount } = renderHook(() => useCanvasSpatialIndexLifecycle(index, { warmup: true }))

    expect(
      spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup
    ).toHaveBeenCalledWith(2048)
    expect(spatialIndexMocks.scheduleCanvasSpatialIndexAcceleratorIdleWarmup).toHaveBeenCalledTimes(
      1
    )
    expect(cancelWarmup).not.toHaveBeenCalled()

    unmount()

    expect(cancelWarmup).toHaveBeenCalledTimes(1)
  })

  it('cancels the previous warmup subscription when the index changes', () => {
    const firstCancel = vi.fn()
    const secondCancel = vi.fn()
    spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup.mockReturnValue(true)
    spatialIndexMocks.scheduleCanvasSpatialIndexAcceleratorIdleWarmup
      .mockReturnValueOnce(firstCancel)
      .mockReturnValueOnce(secondCancel)
    const first = createIndex('first-warm', 2048)
    const second = createIndex('second-warm', 4096)

    const { rerender, unmount } = renderHook(
      ({ index }) => useCanvasSpatialIndexLifecycle(index, { warmup: true }),
      { initialProps: { index: first } }
    )

    rerender({ index: second })

    expect(firstCancel).toHaveBeenCalledTimes(1)
    expect(secondCancel).not.toHaveBeenCalled()
    expect(spatialIndexMocks.scheduleCanvasSpatialIndexAcceleratorIdleWarmup).toHaveBeenCalledTimes(
      2
    )

    unmount()

    expect(secondCancel).toHaveBeenCalledTimes(1)
  })

  it('skips warmup scheduling when the index is below the accelerator threshold', () => {
    spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup.mockReturnValue(false)
    const index = createIndex('small', 8)

    const { unmount } = renderHook(() => useCanvasSpatialIndexLifecycle(index, { warmup: true }))

    expect(
      spatialIndexMocks.shouldScheduleCanvasSpatialIndexAcceleratorWarmup
    ).toHaveBeenCalledWith(8)
    expect(spatialIndexMocks.scheduleCanvasSpatialIndexAcceleratorIdleWarmup).not.toHaveBeenCalled()

    unmount()
  })
})
