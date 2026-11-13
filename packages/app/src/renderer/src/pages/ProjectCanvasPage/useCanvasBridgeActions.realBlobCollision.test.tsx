// Real hook and real blob materializer; fake fetch only, not OS delivery.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageItem } from './types'

const m = vi.hoisted(() => ({ dispatch: vi.fn() }))
vi.mock('react-redux', () => ({ useDispatch: () => m.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))
vi.mock('../../store/slices/layoutSlice', () => ({ openRightPanel: () => ({ type: 'layout/openRightPanel' }) }))
vi.mock('../ChatPage/chatVideoAttachmentUtils', () => ({ extractVideoBoundaryFrameDataUrls: vi.fn(async () => ({})) }))
vi.mock('./canvasPageLocalStateUtils', () => ({ resolveActiveAgentScope: (id: string) => `${id}.agent-1` }))
import { useCanvasBridgeActions } from './useCanvasBridgeActions'

const image = (n: number): CanvasImageItem => ({ id: `image-${n}`, type: 'image', src: `blob:fixture-${n}`, fileName: `${n}.png`, sizeBytes: n, x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, zIndex: n, locked: false })
function setup() {
  const items = [image(1), image(2)]
  const notifyError = vi.fn()
  const overview = vi.fn(async () => 'data:image/png;base64,c25hcA==')
  const events = vi.spyOn(window, 'dispatchEvent')
  const hook = renderHook(() => useCanvasBridgeActions({ canvasId: 'canvas-a', projectName: 'fixture', items, groups: [], notifySuccess: vi.fn(), notifyError, extractPromptTextFromCanvasItems: () => '', renderCanvasItemsImageDataUrl: overview, renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg/>') }))
  return { ...hook, items, notifyError, events, overview }
}
beforeEach(() => { m.dispatch.mockReset() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('canvas bridge real blob materialization collision', () => {
  it.each([true, false])('detects same bytes=%s after materialization', async same => {
    const blobs = new Map([
      ['blob:fixture-1', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })],
      ['blob:fixture-2', new Blob([new Uint8Array(same ? [1, 2, 3] : [4, 5, 6])], { type: 'image/png' })]
    ])
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const blob = blobs.get(String(input))
      if (!blob) throw new Error('unexpected synthetic fetch')
      return { ok: true, blob: async () => blob }
    })
    vi.stubGlobal('fetch', fetchMock)
    const hook = setup()
    const before = structuredClone(hook.items)
    let result: boolean | undefined
    await act(async () => { result = await hook.result.current.handleSendCanvasItemsToAgent(hook.items) })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['blob:fixture-1', 'blob:fixture-2'])
    expect(hook.items).toEqual(before)
    if (same) {
      expect(result).toBe(false)
      expect(hook.notifyError).toHaveBeenCalledWith('canvas.agent_send_duplicate_selection')
      expect(m.dispatch).not.toHaveBeenCalled()
      expect(hook.events).not.toHaveBeenCalled()
    } else {
      expect(result).toBe(true)
      expect(hook.notifyError).not.toHaveBeenCalled()
      expect(m.dispatch).toHaveBeenCalledOnce()
      expect(hook.events).not.toHaveBeenCalled()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
      const delivered = hook.events.mock.calls.map(([event]) => event as CustomEvent).filter(event => event.type === 'send-to-agent' && event.detail.attachment)
      expect(delivered.map(event => event.detail.attachment.url)).toEqual(['data:image/png;base64,AQID', 'data:image/png;base64,BAUG'])
      expect(delivered.map(event => event.detail.attachment.fileName)).toEqual(['1.png', '2.png'])
    }
    hook.unmount()
  })
})
