import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/llm'
import type { CanvasImageItem } from './types'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), materialize: vi.fn() }))
vi.mock('react-redux', () => ({ useDispatch: () => mocks.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))
vi.mock('../../store/slices/layoutSlice', () => ({ openRightPanel: () => ({ type: 'layout/openRightPanel' }) }))
vi.mock('../../utils/droppedImageUtils', () => ({ materializeInternalImageDragAttachment: mocks.materialize }))
vi.mock('../ChatPage/chatVideoAttachmentUtils', () => ({ extractVideoBoundaryFrameDataUrls: vi.fn(async () => ({})) }))
vi.mock('./canvasPageLocalStateUtils', () => ({ resolveActiveAgentScope: () => 'unused-scope' }))
import { useCanvasBridgeActions } from './useCanvasBridgeActions'

const image = (id: string): CanvasImageItem => ({ id, type: 'image', src: `local-media:///fixture/${id}.png`, fileName: `${id}.png`, x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false })

beforeEach(() => {
  vi.useFakeTimers()
  mocks.dispatch.mockReset()
  mocks.materialize.mockReset().mockImplementation(async (attachment: ChatAttachment) => attachment)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('canvas bridge multi-event scheduling', () => {
  it.each(['text', 'hidden'] as const)('dispatches two attachments, %s and focus in order without a receiver ACK', async mode => {
    const items = [image('a'), image('b')]
    const scope = 'fixture-target-scope'
    const notifyError = vi.fn()
    const received: Event[] = []
    // This listener records events only: it neither accepts nor acknowledges them.
    const listener = (event: Event) => { received.push(event) }
    window.addEventListener('send-to-agent', listener)
    window.addEventListener('chat:focus-composer', listener)
    const hook = renderHook(() => useCanvasBridgeActions({
      canvasId: 'fixture-canvas', projectName: 'fixture', items, groups: [],
      notifySuccess: vi.fn(), notifyError,
      extractPromptTextFromCanvasItems: () => mode === 'text' ? 'fixture prompt' : '',
      renderCanvasItemsImageDataUrl: vi.fn(async () => ''),
      renderCanvasItemsSvgMarkup: vi.fn(async () => '')
    }))
    try {
      let scheduled: boolean | undefined
      await act(async () => { scheduled = await hook.result.current.handleSendCanvasItemsToAgent(items, { targetScope: scope, promptPrefix: 'fixture hidden' }) })
      expect(mocks.materialize.mock.calls.map(([item]) => item.url)).toEqual(items.map(item => item.src))
      expect(scheduled).toBe(true)
      expect(mocks.dispatch).toHaveBeenCalledOnce()
      expect(received).toEqual([])
      await act(async () => { await vi.advanceTimersByTimeAsync(199) })
      expect(received).toEqual([])
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(received.map(event => event.type)).toEqual(['send-to-agent', 'send-to-agent', 'send-to-agent', 'chat:focus-composer'])
      const details = received.map(event => (event as CustomEvent).detail)
      expect(details.slice(0, 2).map(detail => detail.attachment.url)).toEqual(items.map(item => item.src))
      expect(details.slice(0, 2).map(detail => detail.text)).toEqual(['', ''])
      expect(details[2].hiddenText).toContain('fixture hidden')
      if (mode === 'text') expect(details[2].text).toBe('fixture prompt')
      else expect(details[2].text).toBeUndefined()
      expect(details.slice(0, 3).map(detail => detail.targetScope)).toEqual([scope, scope, scope])
      expect(details[3].scope).toBe(scope)
      expect(notifyError).not.toHaveBeenCalled()
    } finally {
      hook.unmount()
      window.removeEventListener('send-to-agent', listener)
      window.removeEventListener('chat:focus-composer', listener)
    }
  })
})
