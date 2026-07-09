import { afterEach, describe, expect, it, vi } from 'vitest'

import { dispatchCanvasTargetMediaAttachmentToCanvas } from './canvasTargetMediaDispatch'

function getCustomEventDetail(event: Event): Record<string, unknown> {
  return (event as CustomEvent<Record<string, unknown>>).detail
}

describe('canvasTargetMediaDispatch', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports image dispatch success only after the canvas acknowledges a placed item', async () => {
    const receivedDetails: Record<string, unknown>[] = []
    const listener = (event: Event) => {
      const detail = getCustomEventDetail(event)
      receivedDetails.push(detail)
      expect(typeof detail.onAdded).toBe('function')
      ;(detail.onAdded as (item: unknown) => void)({ id: 'placed-image', type: 'image' })
    }
    window.addEventListener('canvas:add-image', listener)

    try {
      const result = await dispatchCanvasTargetMediaAttachmentToCanvas(
        {
          type: 'image',
          url: 'blob:generated-image',
          fileName: 'generated.png',
          sourceWidth: 640,
          sourceHeight: 480
        },
        'project-1',
        'session-1'
      )

      expect(result).toEqual({
        dispatched: true,
        placedCanvasItems: [{ id: 'placed-image', type: 'image' }]
      })
      expect(receivedDetails).toHaveLength(1)
      expect(receivedDetails[0]).toMatchObject({
        src: 'blob:generated-image',
        fileName: 'generated.png',
        projectId: 'project-1',
        generationSessionId: 'session-1',
        select: false,
        sourceWidth: 640,
        sourceHeight: 480
      })
    } finally {
      window.removeEventListener('canvas:add-image', listener)
    }
  })

  it('does not report success when the canvas add-media event never acknowledges placement', async () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    window.addEventListener('canvas:add-image', listener)

    try {
      const resultPromise = dispatchCanvasTargetMediaAttachmentToCanvas(
        {
          type: 'image',
          url: 'blob:generated-image',
          fileName: 'generated.png'
        },
        'project-1'
      )

      await vi.advanceTimersByTimeAsync(5000)
      await expect(resultPromise).resolves.toEqual({
        dispatched: false,
        placedCanvasItems: []
      })
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('canvas:add-image', listener)
    }
  })

  it('ignores invalid placement callback payloads', async () => {
    vi.useFakeTimers()
    const listener = (event: Event) => {
      const detail = getCustomEventDetail(event)
      ;(detail.onAdded as (item: unknown) => void)({ type: 'image' })
    }
    window.addEventListener('canvas:add-image', listener)

    try {
      const resultPromise = dispatchCanvasTargetMediaAttachmentToCanvas(
        {
          type: 'image',
          url: 'blob:generated-image',
          fileName: 'generated.png'
        },
        'project-1'
      )

      await vi.advanceTimersByTimeAsync(5000)
      await expect(resultPromise).resolves.toEqual({
        dispatched: false,
        placedCanvasItems: []
      })
    } finally {
      window.removeEventListener('canvas:add-image', listener)
    }
  })
})
