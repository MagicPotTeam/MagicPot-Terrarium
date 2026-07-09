import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useCanvasImageBatchImportProgress } from './useCanvasImageBatchImportProgress'
import type { CanvasImageBatchImportProgress } from './useCanvasAssetIntake'

function progress(
  phase: CanvasImageBatchImportProgress['phase'],
  overrides: Partial<CanvasImageBatchImportProgress> = {}
): CanvasImageBatchImportProgress {
  return {
    phase,
    total: 3,
    processed: 1,
    imported: 1,
    failed: 0,
    ...overrides
  }
}

describe('useCanvasImageBatchImportProgress', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks active non-complete progress', () => {
    const { result } = renderHook(() => useCanvasImageBatchImportProgress())

    act(() => {
      result.current.handleImageBatchImportProgress(progress('loading'))
    })

    expect(result.current.imageBatchImportProgress).toMatchObject({ phase: 'loading' })
    expect(result.current.isImageBatchImportActive).toBe(true)
  })

  it('clears complete progress after 1200ms', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCanvasImageBatchImportProgress())

    act(() => {
      result.current.handleImageBatchImportProgress(
        progress('complete', { processed: 3, imported: 3 })
      )
    })

    expect(result.current.imageBatchImportProgress).toMatchObject({ phase: 'complete' })
    expect(result.current.isImageBatchImportActive).toBe(false)

    act(() => {
      vi.advanceTimersByTime(1199)
    })
    expect(result.current.imageBatchImportProgress).toMatchObject({ phase: 'complete' })

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.imageBatchImportProgress).toBeNull()
  })

  it('cancels a pending complete-clear timer when new progress arrives', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCanvasImageBatchImportProgress())

    act(() => {
      result.current.handleImageBatchImportProgress(
        progress('complete', { processed: 3, imported: 3 })
      )
    })
    act(() => {
      vi.advanceTimersByTime(600)
      result.current.handleImageBatchImportProgress(progress('loading', { processed: 2 }))
    })
    act(() => {
      vi.advanceTimersByTime(1200)
    })

    expect(result.current.imageBatchImportProgress).toMatchObject({
      phase: 'loading',
      processed: 2
    })
    expect(result.current.isImageBatchImportActive).toBe(true)
  })

  it('clears progress immediately when null is reported', () => {
    const { result } = renderHook(() => useCanvasImageBatchImportProgress())

    act(() => {
      result.current.handleImageBatchImportProgress(progress('preparing'))
    })
    act(() => {
      result.current.handleImageBatchImportProgress(null)
    })

    expect(result.current.imageBatchImportProgress).toBeNull()
    expect(result.current.isImageBatchImportActive).toBe(false)
  })

  it('cleans up the pending complete-clear timer on unmount', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useCanvasImageBatchImportProgress())
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    act(() => {
      result.current.handleImageBatchImportProgress(
        progress('complete', { processed: 3, imported: 3 })
      )
    })
    unmount()

    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearTimeoutSpy.mockRestore()
  })
})
