import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useCanvasLastViewportPoint } from './useCanvasLastViewportPoint'

function dispatchTouchEvent(
  type: 'touchmove' | 'touchend',
  point: { clientX: number; clientY: number }
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: type === 'touchmove' ? [point] : [],
    configurable: true
  })
  Object.defineProperty(event, 'changedTouches', {
    value: [point],
    configurable: true
  })
  window.dispatchEvent(event)
}

describe('useCanvasLastViewportPoint', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts with a null viewport point', () => {
    const { result } = renderHook(() => useCanvasLastViewportPoint())

    expect(result.current.current).toBeNull()
  })

  it('tracks mouse and pointer movement in viewport coordinates', () => {
    const { result } = renderHook(() => useCanvasLastViewportPoint())

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 12, clientY: 34 }))
    expect(result.current.current).toEqual({ x: 12, y: 34 })

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 56, clientY: 78 }))
    expect(result.current.current).toEqual({ x: 56, y: 78 })
  })

  it('tracks touchmove from touches and touchend from changedTouches', () => {
    const { result } = renderHook(() => useCanvasLastViewportPoint())

    dispatchTouchEvent('touchmove', { clientX: 90, clientY: 91 })
    expect(result.current.current).toEqual({ x: 90, y: 91 })

    dispatchTouchEvent('touchend', { clientX: 92, clientY: 93 })
    expect(result.current.current).toEqual({ x: 92, y: 93 })
  })

  it('removes listeners on unmount and stops updating', () => {
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const { result, unmount } = renderHook(() => useCanvasLastViewportPoint())

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 2 }))
    expect(result.current.current).toEqual({ x: 1, y: 2 })

    unmount()
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 3, clientY: 4 }))

    expect(result.current.current).toEqual({ x: 1, y: 2 })
    expect(removeEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function), true)
    expect(removeEventListenerSpy).toHaveBeenCalledWith('pointermove', expect.any(Function), true)
    expect(removeEventListenerSpy).toHaveBeenCalledWith('touchmove', expect.any(Function), true)
    expect(removeEventListenerSpy).toHaveBeenCalledWith('touchend', expect.any(Function), true)
  })
})
