import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasBridgeActions } from './useCanvasBridgeActions'
import type { CanvasGroup, CanvasImageItem, CanvasItem } from './types'

const mockDispatch = vi.fn()

vi.mock('react-redux', () => ({
  useDispatch: () => mockDispatch
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('../../utils/windowUtils', () => ({
  api: () => ({})
}))

vi.mock('../../store/slices/layoutSlice', () => ({
  openRightPanel: () => ({ type: 'layout/openRightPanel' })
}))

vi.mock('../ChatPage/chatVideoAttachmentUtils', () => ({
  extractVideoBoundaryFrameDataUrls: vi.fn(async () => ({
    firstFrameDataUrl: null,
    lastFrameDataUrl: null
  }))
}))

function createImageItem(
  id: string,
  fileName: string,
  overrides: Partial<CanvasImageItem> = {}
): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `local-media:///C:/MagicPot/${fileName}`,
    fileName,
    sizeBytes: 2048,
    sourceWidth: 1024,
    sourceHeight: 1024,
    x: 0,
    y: 0,
    width: 128,
    height: 128,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

describe('useCanvasBridgeActions', () => {
  beforeEach(() => {
    mockDispatch.mockReset()
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('dispatches only the explicit selection to the matching targetScope', async () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')
    const selected = createImageItem('selected-image', 'selected.png')
    const unrelated = createImageItem('unrelated-image', 'unrelated.png')
    const items: CanvasItem[] = [selected, unrelated]
    const groups: CanvasGroup[] = []

    localStorage.setItem('agent.workspace.active.canvas-1', 'agent-2')

    try {
      const { result } = renderHook(() =>
        useCanvasBridgeActions({
          canvasId: 'canvas-1',
          projectName: 'MagicPot Demo',
          items,
          groups,
          notifySuccess: vi.fn(),
          notifyError: vi.fn(),
          extractPromptTextFromCanvasItems: (targetItems) =>
            targetItems.map((item) => `${item.id}:${item.type}`).join('\n'),
          renderCanvasItemsImageDataUrl: vi.fn(
            async (targetItems) =>
              `data:image/png;base64,${targetItems.map((item) => item.id).join('-')}`
          ),
          renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg />')
        })
      )

      await act(async () => {
        await result.current.handleSendCanvasItemsToAgent([selected])
        vi.runAllTimers()
      })

      const sendEvents = dispatchEventSpy.mock.calls
        .map(
          ([event]) =>
            event as CustomEvent<{
              attachment?: { fileName?: string; url?: string }
              text?: string
              hiddenText?: string
              targetScope?: string
            }>
        )
        .filter((event) => event.type === 'send-to-agent')

      expect(sendEvents.length).toBeGreaterThan(0)
      expect(sendEvents.every((event) => event.detail?.targetScope === 'canvas-1.agent-2')).toBe(
        true
      )

      const selectedAssetEvents = sendEvents.filter(
        (event) => event.detail?.attachment?.fileName === 'selected.png'
      )
      expect(selectedAssetEvents).toHaveLength(1)
      expect(selectedAssetEvents[0]?.detail?.attachment).toEqual(
        expect.objectContaining({
          type: 'image',
          url: 'local-media:///C:/MagicPot/selected.png',
          fileName: 'selected.png'
        })
      )

      expect(
        sendEvents.some((event) => event.detail?.attachment?.fileName === 'unrelated.png')
      ).toBe(false)

      const promptEvent = sendEvents.find(
        (event) => typeof event.detail?.text === 'string' && event.detail.text.length > 0
      )
      expect(promptEvent?.detail?.text).toContain('selected-image:image')
      expect(promptEvent?.detail?.text).not.toContain('unrelated-image:image')
      expect(promptEvent?.detail?.hiddenText).toContain('Canvas asset manifest:')
      expect(promptEvent?.detail?.hiddenText).toContain('fileName="selected.png"')
      expect(promptEvent?.detail?.hiddenText).not.toContain('fileName="unrelated.png"')
    } finally {
      dispatchEventSpy.mockRestore()
    }
  })

  it('sends cropped image attachments as exported visible PNGs without changing canvas item semantics', async () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')
    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = 100
    sourceCanvas.height = 80
    const selected = createImageItem('selected-image', 'selected.jpg', {
      image: sourceCanvas,
      sourceWidth: 100,
      sourceHeight: 80,
      width: 30,
      height: 40,
      crop: { x: 10, y: 20, width: 30, height: 40 }
    })
    const drawImage = vi.fn()
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as never)
    const toDataURLSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,cropped-visible')

    try {
      const { result } = renderHook(() =>
        useCanvasBridgeActions({
          canvasId: 'canvas-1',
          projectName: 'MagicPot Demo',
          items: [selected],
          groups: [],
          notifySuccess: vi.fn(),
          notifyError: vi.fn(),
          extractPromptTextFromCanvasItems: (targetItems) =>
            targetItems.map((item) => `${item.id}:${item.type}`).join('\n'),
          renderCanvasItemsImageDataUrl: vi.fn(async () => 'data:image/png;base64,snapshot'),
          renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg />')
        })
      )

      await act(async () => {
        await result.current.handleSendCanvasItemsToAgent([selected], 'canvas-1.agent-2')
        vi.runAllTimers()
      })

      const sendEvents = dispatchEventSpy.mock.calls
        .map(
          ([event]) =>
            event as CustomEvent<{
              attachment?: {
                fileName?: string
                url?: string
                sourceWidth?: number
                sourceHeight?: number
              }
              hiddenText?: string
            }>
        )
        .filter((event) => event.type === 'send-to-agent')
      const imageAttachment = sendEvents.find(
        (event) => event.detail?.attachment?.fileName === 'selected.png'
      )?.detail?.attachment

      expect(imageAttachment).toEqual(
        expect.objectContaining({
          url: 'data:image/png;base64,cropped-visible',
          fileName: 'selected.png',
          sourceWidth: 30,
          sourceHeight: 40
        })
      )
      expect(drawImage).toHaveBeenCalledWith(sourceCanvas, 10, 20, 30, 40, 0, 0, 30, 40)
      expect(toDataURLSpy).toHaveBeenCalledWith('image/png')
      expect(selected.src).toBe('local-media:///C:/MagicPot/selected.jpg')
      expect(selected.crop).toEqual({ x: 10, y: 20, width: 30, height: 40 })
      expect(sendEvents.find((event) => event.detail?.hiddenText)?.detail?.hiddenText).toContain(
        'dimensions=30x40'
      )
    } finally {
      dispatchEventSpy.mockRestore()
      getContextSpy.mockRestore()
      toDataURLSpy.mockRestore()
    }
  })

  it('does not fall back to the full original or a snapshot when cropped image materialization fails', async () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')
    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = 100
    sourceCanvas.height = 80
    const selected = createImageItem('selected-image', 'selected.jpg', {
      image: sourceCanvas,
      sourceWidth: 100,
      sourceHeight: 80,
      width: 30,
      height: 40,
      crop: { x: 10, y: 20, width: 30, height: 40 }
    })
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const renderSnapshot = vi.fn(async () => 'data:image/png;base64,cropped-snapshot')
    const notifyError = vi.fn()

    try {
      const { result } = renderHook(() =>
        useCanvasBridgeActions({
          canvasId: 'canvas-1',
          projectName: 'MagicPot Demo',
          items: [selected],
          groups: [],
          notifySuccess: vi.fn(),
          notifyError,
          extractPromptTextFromCanvasItems: (targetItems) =>
            targetItems.map((item) => `${item.id}:${item.type}`).join('\n'),
          renderCanvasItemsImageDataUrl: renderSnapshot,
          renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg />')
        })
      )

      await act(async () => {
        await result.current.handleSendCanvasItemsToAgent([selected], 'canvas-1.agent-2')
        vi.runAllTimers()
      })

      const sendEvents = dispatchEventSpy.mock.calls
        .map(
          ([event]) =>
            event as CustomEvent<{
              attachment?: {
                fileName?: string
                url?: string
                hiddenFromChatView?: boolean
              }
            }>
        )
        .filter((event) => event.type === 'send-to-agent')
      const attachmentEvents = sendEvents.filter((event) => event.detail?.attachment)

      expect(attachmentEvents).toEqual([])
      expect(renderSnapshot).not.toHaveBeenCalled()
      expect(notifyError).toHaveBeenCalledWith('canvas.agent_send_cropped_image_failed')
    } finally {
      dispatchEventSpy.mockRestore()
      getContextSpy.mockRestore()
    }
  })
})
