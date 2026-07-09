import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useComfyExecutionActivity } from './useComfyExecutionActivity'
import {
  COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT,
  resetComfyExecutionActivity,
  type ComfyExecutionActivitySnapshot
} from '../../utils/comfyExecutionActivity'

function snapshot(
  patch: Partial<ComfyExecutionActivitySnapshot> = {}
): ComfyExecutionActivitySnapshot {
  return {
    active: false,
    activePromptIds: [],
    updatedAt: 100,
    reason: 'reset',
    ...patch
  }
}

describe('useComfyExecutionActivity', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    resetComfyExecutionActivity()
  })

  it('tracks activity change events and reports local canvas throttling', () => {
    const { result } = renderHook(() => useComfyExecutionActivity({ useRemoteComfyui: false }))

    act(() => {
      window.dispatchEvent(
        new CustomEvent(COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT, {
          detail: snapshot({
            active: true,
            activePromptIds: ['prompt-1'],
            reason: 'execution_start'
          })
        })
      )
    })

    expect(result.current.comfyExecutionActivity).toMatchObject({
      active: true,
      activePromptIds: ['prompt-1'],
      reason: 'execution_start'
    })
    expect(result.current.isCanvasPerformanceThrottled).toBe(true)
  })

  it('does not throttle the canvas when remote ComfyUI is enabled', () => {
    const { result } = renderHook(() => useComfyExecutionActivity({ useRemoteComfyui: true }))

    act(() => {
      window.dispatchEvent(
        new CustomEvent(COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT, {
          detail: snapshot({ active: true, activePromptIds: ['prompt-remote'] })
        })
      )
    })

    expect(result.current.comfyExecutionActivity.active).toBe(true)
    expect(result.current.isCanvasPerformanceThrottled).toBe(false)
  })

  it('falls back to the current snapshot when an event has no detail', () => {
    resetComfyExecutionActivity()
    const { result } = renderHook(() => useComfyExecutionActivity())

    act(() => {
      window.dispatchEvent(new CustomEvent(COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT))
    })

    expect(result.current.comfyExecutionActivity).toMatchObject({
      active: false,
      activePromptIds: [],
      reason: 'reset'
    })
  })

  it('removes the activity listener on unmount', () => {
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useComfyExecutionActivity())

    unmount()

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT,
      expect.any(Function)
    )
  })
})
