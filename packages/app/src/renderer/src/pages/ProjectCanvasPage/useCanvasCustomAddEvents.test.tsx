import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCanvasCustomAddEvents } from './useCanvasCustomAddEvents'
import type { CanvasImageItem } from './types'

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
})
