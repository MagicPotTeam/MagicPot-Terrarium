import React from 'react'
import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectCanvasImageCropOverlay, { type ProjectCanvasImageCropOverlayHandle } from './ProjectCanvasImageCropOverlay'
import { useCanvasBridgeActions } from '../useCanvasBridgeActions'
import type { CanvasImageItem } from '../types'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), materialize: vi.fn(async (item: unknown) => item) }))
vi.mock('react-redux', () => ({ useDispatch: () => mocks.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../utils/droppedImageUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/droppedImageUtils')>()),
  materializeInternalImageDragAttachment: mocks.materialize
}))
vi.mock('../../../utils/windowUtils', () => ({ api: () => window.api ?? {} }))

// The old direct helper test exposed unverified coordinate materialization (bash_1520e852);
// this tests the actual send boundary, not a claim that equal dimensions establish provenance.
describe('real crop overlay to Agent send boundary (synthetic jsdom)', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.dispatch.mockClear(); mocks.materialize.mockClear() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each([false, true])('rejects the whole selection after overlay crop, source hint present=%s', async (hasHint) => {
    const preview = document.createElement('img')
    Object.defineProperty(preview, 'naturalWidth', { value: hasHint ? 200 : 100 })
    Object.defineProperty(preview, 'naturalHeight', { value: hasHint ? 200 : 100 })
    const item: CanvasImageItem = { id: 'synthetic', type: 'image', src: 'data:image/png;base64,c3ludGhldGlj', image: preview, ...(hasHint ? { sourceWidth: 200, sourceHeight: 200 } : {}), x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false }
    const other = { ...item, id: 'other' }
    const ref = React.createRef<ProjectCanvasImageCropOverlayHandle>()
    const confirm = vi.fn()
    class TestPointerEvent extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0 } }
    vi.stubGlobal('PointerEvent', TestPointerEvent)
    const view = render(<ProjectCanvasImageCropOverlay ref={ref} item={item} stagePos={{ x: 0, y: 0 }} stageScale={1} onConfirm={confirm} onCancel={vi.fn()} />)
    const handle = view.container.querySelector('[data-canvas-crop-handle="bottom-right"]')
    expect(handle).not.toBeNull()
    act(() => {
      fireEvent.pointerDown(handle!, { pointerId: 7, button: 0, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(window, { pointerId: 7, clientX: 50, clientY: 50 })
      fireEvent.pointerUp(window, { pointerId: 7, clientX: 50, clientY: 50 })
      ref.current!.confirm()
    })
    expect(confirm).toHaveBeenCalledOnce()
    const side = hasHint ? 100 : 50
    expect(confirm.mock.calls[0][0].crop).toEqual({ x: 0, y: 0, width: side, height: side })
    const confirmed = { ...item, ...confirm.mock.calls[0][0] }
    const notifyError = vi.fn(), notifySuccess = vi.fn(), raster = vi.fn(async () => ''), svg = vi.fn(async () => '')
    const events = vi.spyOn(window, 'dispatchEvent')
    const hook = renderHook(() => useCanvasBridgeActions({ canvasId: 'synthetic', projectName: 'Synthetic', items: [confirmed, other], groups: [], notifyError, notifySuccess, extractPromptTextFromCanvasItems: () => '', renderCanvasItemsImageDataUrl: raster, renderCanvasItemsSvgMarkup: svg }))
    await act(async () => { await hook.result.current.handleSendCanvasItemsToAgent([other, confirmed]); vi.runAllTimers() })
    expect(notifyError).toHaveBeenCalledOnce()
    expect(notifySuccess).not.toHaveBeenCalled()
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(raster).not.toHaveBeenCalled()
    expect(svg).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(events.mock.calls.some(([event]) => event.type === 'send-to-agent' || event.type === 'chat:focus-composer')).toBe(false)
    hook.unmount(); view.unmount()
  })

  it('sends the uncropped original attachment as a positive control', async () => {
    const item: CanvasImageItem = { id: 'plain', type: 'image', src: 'data:image/png;base64,c3ludGhldGlj', x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false }
    const notifyError = vi.fn()
    const events = vi.spyOn(window, 'dispatchEvent')
    const hook = renderHook(() => useCanvasBridgeActions({ canvasId: 'synthetic', projectName: 'Synthetic', items: [item], groups: [], notifyError, notifySuccess: vi.fn(), extractPromptTextFromCanvasItems: () => '', renderCanvasItemsImageDataUrl: vi.fn(async () => ''), renderCanvasItemsSvgMarkup: vi.fn(async () => '') }))
    await act(async () => { await hook.result.current.handleSendCanvasItemsToAgent([item]); vi.runAllTimers() })
    expect(notifyError).not.toHaveBeenCalled()
    expect(mocks.materialize).toHaveBeenCalledOnce()
    expect(mocks.dispatch).toHaveBeenCalledOnce()
    const attachments = events.mock.calls.map(([event]) => event as CustomEvent<{ attachment?: { url: string } }>).filter((event) => event.type === 'send-to-agent' && event.detail.attachment)
    expect(attachments).toHaveLength(1)
    expect(attachments[0].detail.attachment?.url).toBe(item.src)
    hook.unmount()
  })
})
