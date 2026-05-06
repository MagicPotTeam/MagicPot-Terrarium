import { describe, expect, it, vi } from 'vitest'

import { cancelCanvasSync, scheduleCanvasSync, type CanvasSyncDetail } from './canvasSync'

const makeDetail = (x: number): CanvasSyncDetail => ({
  x,
  y: x + 1,
  rotation: 0,
  scaleX: 1,
  scaleY: 1
})

describe('canvasSync', () => {
  it('coalesces multiple item syncs into one animation frame', () => {
    const callbacks: FrameRequestCallback[] = []
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callbacks.push(callback)
        return callbacks.length
      })
    const received: Array<{ id: string; detail: CanvasSyncDetail }> = []
    const handleFirstSync = (event: Event) => {
      received.push({ id: 'first', detail: (event as CustomEvent<CanvasSyncDetail>).detail })
    }
    const handleSecondSync = (event: Event) => {
      received.push({ id: 'second', detail: (event as CustomEvent<CanvasSyncDetail>).detail })
    }
    window.addEventListener('canvas-sync-first', handleFirstSync)
    window.addEventListener('canvas-sync-second', handleSecondSync)

    try {
      scheduleCanvasSync('first', makeDetail(10))
      scheduleCanvasSync('second', makeDetail(20))
      scheduleCanvasSync('first', makeDetail(30))

      expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1)

      callbacks[0]?.(performance.now())

      expect(received).toEqual([
        { id: 'first', detail: makeDetail(30) },
        { id: 'second', detail: makeDetail(20) }
      ])
    } finally {
      window.removeEventListener('canvas-sync-first', handleFirstSync)
      window.removeEventListener('canvas-sync-second', handleSecondSync)
      vi.restoreAllMocks()
    }
  })

  it('cancels one pending item without dropping the shared frame for remaining items', () => {
    const callbacks: FrameRequestCallback[] = []
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callbacks.push(callback)
        return callbacks.length
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})
    const received: CanvasSyncDetail[] = []
    const handleSync = (event: Event) => {
      received.push((event as CustomEvent<CanvasSyncDetail>).detail)
    }
    window.addEventListener('canvas-sync-remaining', handleSync)

    try {
      scheduleCanvasSync('cancelled', makeDetail(10))
      scheduleCanvasSync('remaining', makeDetail(20))
      cancelCanvasSync('cancelled')

      expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1)
      expect(cancelAnimationFrameSpy).not.toHaveBeenCalled()

      callbacks[0]?.(performance.now())

      expect(received).toEqual([makeDetail(20)])
    } finally {
      window.removeEventListener('canvas-sync-remaining', handleSync)
      cancelCanvasSync('cancelled')
      cancelCanvasSync('remaining')
      vi.restoreAllMocks()
    }
  })
})
