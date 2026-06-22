import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MaxSizeLayout, { MAX_SIZE_LAYOUT_REMEASURE_EVENT } from './MaxSizeLayout'

type MutableSize = {
  width: number
  height: number
}

describe('MaxSizeLayout', () => {
  let currentSize: MutableSize
  let resizeObserverCallback: ResizeObserverCallback | null

  beforeEach(() => {
    currentSize = { width: 800, height: 600 }
    resizeObserverCallback = null

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      }
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: currentSize.width,
          bottom: currentSize.height,
          width: currentSize.width,
          height: currentSize.height,
          toJSON: () => ({})
        }) as DOMRect
    )

    class ResizeObserverMock {
      observe = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback
      }
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('remeasures after rerender when ResizeObserver reports a container size change', async () => {
    const onResize = vi.fn()
    const { rerender } = render(
      <MaxSizeLayout onResize={onResize}>
        <div>first</div>
      </MaxSizeLayout>
    )

    await waitFor(() => {
      expect(onResize).toHaveBeenCalledWith(800, 600)
    })

    onResize.mockClear()
    currentSize = { width: 1280, height: 720 }

    rerender(
      <MaxSizeLayout onResize={onResize}>
        <div>second</div>
      </MaxSizeLayout>
    )
    act(() => {
      resizeObserverCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver)
    })

    await waitFor(() => {
      expect(onResize).toHaveBeenCalledWith(1280, 720)
    })
  })

  it('skips duplicate resize notifications when the measured size did not change', async () => {
    const onResize = vi.fn()
    const { rerender } = render(
      <MaxSizeLayout onResize={onResize}>
        <div>first</div>
      </MaxSizeLayout>
    )

    await waitFor(() => {
      expect(onResize).toHaveBeenCalledTimes(1)
    })

    rerender(
      <MaxSizeLayout onResize={onResize}>
        <div>second</div>
      </MaxSizeLayout>
    )

    await waitFor(() => {
      expect(onResize).toHaveBeenCalledTimes(1)
    })
  })

  it('remeasures when the outer layout emits a workspace resize event', async () => {
    const onResize = vi.fn()
    render(
      <MaxSizeLayout onResize={onResize}>
        <div>content</div>
      </MaxSizeLayout>
    )

    await waitFor(() => {
      expect(onResize).toHaveBeenCalledWith(800, 600)
    })

    onResize.mockClear()
    currentSize = { width: 1220, height: 720 }
    window.dispatchEvent(new Event(MAX_SIZE_LAYOUT_REMEASURE_EVENT))

    await waitFor(() => {
      expect(onResize).toHaveBeenCalledWith(1220, 720)
    })
  })

  it('restores full canvas width after the right agent panel closes', async () => {
    const onResize = vi.fn()
    currentSize = { width: 900, height: 720 }
    render(
      <MaxSizeLayout onResize={onResize}>
        <div>canvas stage</div>
      </MaxSizeLayout>
    )

    await waitFor(() => {
      expect(onResize).toHaveBeenCalledWith(900, 720)
    })

    onResize.mockClear()
    currentSize = { width: 1280, height: 720 }
    window.dispatchEvent(new Event(MAX_SIZE_LAYOUT_REMEASURE_EVENT))

    await waitFor(() => {
      expect(onResize).toHaveBeenCalledWith(1280, 720)
    })
  })
})
