import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProjectTraceRealtimeAdvice } from './useProjectTraceRealtimeAdvice'
import { PROJECT_TRACE_REALTIME_ADVICE_EVENT } from '@renderer/features/projectTrace/projectTraceRuntime'

function emitAdvice(projectId: string, advice?: string) {
  window.dispatchEvent(
    new CustomEvent(PROJECT_TRACE_REALTIME_ADVICE_EVENT, {
      detail: advice ? { projectId, advice: { advice } } : { projectId }
    })
  )
}

describe('useProjectTraceRealtimeAdvice', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows realtime advice for the active canvas', () => {
    const notifyWarning = vi.fn()
    renderHook(() => useProjectTraceRealtimeAdvice({ canvasId: 'canvas-1', notifyWarning }))

    act(() => {
      emitAdvice('canvas-1', 'Check alignment')
    })

    expect(notifyWarning).toHaveBeenCalledWith('Check alignment', 8000)
  })

  it('ignores advice for other canvases and malformed events', () => {
    const notifyWarning = vi.fn()
    renderHook(() => useProjectTraceRealtimeAdvice({ canvasId: 'canvas-1', notifyWarning }))

    act(() => {
      emitAdvice('other-canvas', 'Wrong canvas')
      emitAdvice('canvas-1')
    })

    expect(notifyWarning).not.toHaveBeenCalled()
  })

  it('removes the realtime advice listener on unmount', () => {
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() =>
      useProjectTraceRealtimeAdvice({ canvasId: 'canvas-1', notifyWarning: vi.fn() })
    )

    unmount()

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      PROJECT_TRACE_REALTIME_ADVICE_EVENT,
      expect.any(Function)
    )
  })
})
