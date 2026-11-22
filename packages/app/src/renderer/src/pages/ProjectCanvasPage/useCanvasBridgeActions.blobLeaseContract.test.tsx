import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageItem } from './types'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }))
vi.mock('react-redux', () => ({ useDispatch: () => mocks.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))
vi.mock('../../store/slices/layoutSlice', () => ({ openRightPanel: () => ({ type: 'layout/openRightPanel' }) }))
vi.mock('../ChatPage/chatVideoAttachmentUtils', () => ({ extractVideoBoundaryFrameDataUrls: vi.fn(async () => ({})) }))
vi.mock('./canvasPageLocalStateUtils', () => ({ resolveActiveAgentScope: () => 'fixture-scope' }))
import { CanvasImageObjectUrlRegistry } from './canvasImageObjectUrlRegistry'
import { useCanvasBridgeActions } from './useCanvasBridgeActions'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('canvas bridge borrowed blob lease', () => {
  it('materializes a borrowed image without revoking it; the resulting data survives owner release', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const blob = new Blob([bytes], { type: 'image/png' })
    const allocated = new Map<string, Blob>()
    const create = vi.fn((value: Blob) => { allocated.set('blob:synthetic-owner', value); return 'blob:synthetic-owner' })
    const revoke = vi.fn((url: string) => { allocated.delete(url) })
    const OriginalURL = URL
    class FixtureURL extends OriginalURL {}
    Object.defineProperties(FixtureURL, { createObjectURL: { value: create }, revokeObjectURL: { value: revoke } })
    vi.stubGlobal('URL', FixtureURL)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const value = allocated.get(String(input))
      if (!value) throw new Error('Unexpected or released synthetic URL')
      return { ok: true, blob: async () => value }
    })
    vi.stubGlobal('fetch', fetchMock)
    const registry = new CanvasImageObjectUrlRegistry()
    const owner = registry.create('owner', blob)
    expect(owner).not.toBeNull()
    if (!owner) throw new Error('Failed to create fixture owner')
    const item: CanvasImageItem = { id: 'image', type: 'image', src: owner.url, fileName: 'synthetic.png', x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false }
    const events: CustomEvent[] = []
    const listener = (event: Event) => { events.push(event as CustomEvent) }
    window.addEventListener('send-to-agent', listener)
    const notifyError = vi.fn()
    const hook = renderHook(() => useCanvasBridgeActions({ canvasId: 'fixture', projectName: 'fixture', items: [item], groups: [], notifySuccess: vi.fn(), notifyError, extractPromptTextFromCanvasItems: () => '', renderCanvasItemsImageDataUrl: vi.fn(async () => ''), renderCanvasItemsSvgMarkup: vi.fn(async () => '') }))
    try {
      let scheduled: boolean | undefined
      await act(async () => { scheduled = await hook.result.current.handleSendCanvasItemsToAgent([item]) })
      expect(scheduled).toBe(true)
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(fetchMock.mock.calls[0][0]).toBe(owner.url)
      expect(revoke).not.toHaveBeenCalled()
      expect(registry.getMetrics().activeCount).toBe(1)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
      const attachment = events.find(event => event.detail.attachment)?.detail.attachment
      expect(attachment?.url).toBe('data:image/png;base64,AQIDBA==')
      expect(revoke).not.toHaveBeenCalled()
      owner.revoke()
      expect(revoke).toHaveBeenCalledExactlyOnceWith(owner.url)
      expect(registry.getMetrics().activeCount).toBe(0)
      expect(allocated.has(owner.url)).toBe(false)
      expect(Array.from(atob(attachment.url.split(',')[1]), char => char.charCodeAt(0))).toEqual(Array.from(bytes))
      expect(notifyError).not.toHaveBeenCalled()
    } finally {
      hook.unmount()
      window.removeEventListener('send-to-agent', listener)
      owner.revoke()
    }
  })
})
