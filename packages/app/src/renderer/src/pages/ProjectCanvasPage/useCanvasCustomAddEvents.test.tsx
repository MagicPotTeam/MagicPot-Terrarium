import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCanvasCustomAddEvents } from './useCanvasCustomAddEvents'
import type { CanvasImageItem } from './types'
import { CANVAS_NEW_RESULT_HINT_EVENT, type CanvasNewResultHintDetail } from './canvasNewResultHint'

describe('useCanvasCustomAddEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards custom image source dimensions to canvas intake', async () => {
    const addedImage = {
      id: 'image-1',
      src: 'blob:image-1',
      fileName: 'image-1.png'
    } as CanvasImageItem
    const addImageToCanvas = vi.fn(async () => addedImage)
    const handleAppendGenerationTraceCandidate = vi.fn()
    const sourceFile = new Blob(['image-bytes'], { type: 'image/png' })

    renderHook(() =>
      useCanvasCustomAddEvents({
        canvasId: 'canvas-1',
        addImageToCanvas,
        addImagesToCanvas: vi.fn(async () => undefined),
        addVideoToCanvas: vi.fn(),
        addModel3DUrlToCanvas: vi.fn(() => null),
        addTextToCanvas: vi.fn(),
        handleAppendGenerationTraceCandidate
      })
    )

    act(() => {
      window.dispatchEvent(
        new CustomEvent('canvas:add-image', {
          detail: {
            src: 'blob:image-1',
            fileName: 'image-1.png',
            projectId: 'canvas-1',
            generationSessionId: 'session-1',
            promptId: 'prompt-1',
            sourceFile,
            sourceWidth: 3136,
            sourceHeight: 2624
          }
        })
      )
    })

    await waitFor(() => {
      expect(addImageToCanvas).toHaveBeenCalledTimes(1)
    })
    expect(addImageToCanvas).toHaveBeenCalledWith('blob:image-1', {
      fileName: 'image-1.png',
      promptId: 'prompt-1',
      fileItem: undefined,
      sourceFile,
      sourceWidthHint: 3136,
      sourceHeightHint: 2624,
      select: undefined
    })
    expect(handleAppendGenerationTraceCandidate).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      sessionId: 'session-1',
      candidate: {
        id: 'image-1',
        canvasItemId: 'image-1',
        fileName: 'image-1.png',
        src: 'blob:image-1',
        thumbnailSrc: 'blob:image-1'
      }
    })
  })

  it('calls the custom image onAdded callback with the created canvas item', async () => {
    const addedImage = {
      id: 'image-1',
      src: 'blob:image-1',
      fileName: 'image-1.png'
    } as CanvasImageItem
    const addImageToCanvas = vi.fn(async () => addedImage)
    const onAdded = vi.fn()

    renderHook(() =>
      useCanvasCustomAddEvents({
        canvasId: 'canvas-1',
        addImageToCanvas,
        addImagesToCanvas: vi.fn(async () => undefined),
        addVideoToCanvas: vi.fn(),
        addModel3DUrlToCanvas: vi.fn(() => null),
        addTextToCanvas: vi.fn(),
        handleAppendGenerationTraceCandidate: vi.fn()
      })
    )

    act(() => {
      window.dispatchEvent(
        new CustomEvent('canvas:add-image', {
          detail: {
            src: 'blob:image-1',
            projectId: 'canvas-1',
            onAdded
          }
        })
      )
    })

    await waitFor(() => {
      expect(onAdded).toHaveBeenCalledWith(addedImage)
    })
  })

  it('emits a new-result hint event for quick app images after the canvas item is created', async () => {
    const addedImage = {
      id: 'image-1',
      src: 'blob:image-1',
      fileName: 'image-1.png'
    } as CanvasImageItem
    const addImageToCanvas = vi.fn(async () => addedImage)
    const hintDetails: CanvasNewResultHintDetail[] = []
    const onHint = (event: Event) => {
      hintDetails.push((event as CustomEvent<CanvasNewResultHintDetail>).detail)
    }

    window.addEventListener(CANVAS_NEW_RESULT_HINT_EVENT, onHint)

    try {
      renderHook(() =>
        useCanvasCustomAddEvents({
          canvasId: 'canvas-1',
          addImageToCanvas,
          addImagesToCanvas: vi.fn(async () => undefined),
          addVideoToCanvas: vi.fn(),
          addModel3DUrlToCanvas: vi.fn(() => null),
          addTextToCanvas: vi.fn(),
          handleAppendGenerationTraceCandidate: vi.fn()
        })
      )

      act(() => {
        window.dispatchEvent(
          new CustomEvent('canvas:add-image', {
            detail: {
              src: 'blob:image-1',
              projectId: 'canvas-1',
              generationSessionId: 'session-1',
              newResultHint: 'quickapp'
            }
          })
        )
      })

      await waitFor(() => {
        expect(hintDetails).toEqual([
          {
            itemId: 'image-1',
            canvasId: 'canvas-1',
            generationSessionId: 'session-1',
            source: 'quickapp'
          }
        ])
      })
    } finally {
      window.removeEventListener(CANVAS_NEW_RESULT_HINT_EVENT, onHint)
    }
  })
})
