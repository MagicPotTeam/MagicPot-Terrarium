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

function createImageItem(id: string, fileName: string): CanvasImageItem {
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
    locked: false
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
})
