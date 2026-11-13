import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageItem, CanvasItem } from './types'
import type { ChatAttachment } from '@shared/llm'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), materialize: vi.fn() }))
vi.mock('react-redux', () => ({ useDispatch: () => mocks.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))
vi.mock('../../store/slices/layoutSlice', () => ({ openRightPanel: () => ({ type: 'layout/openRightPanel' }) }))
vi.mock('../../utils/droppedImageUtils', () => ({ materializeInternalImageDragAttachment: mocks.materialize }))
vi.mock('../ChatPage/chatVideoAttachmentUtils', () => ({ extractVideoBoundaryFrameDataUrls: vi.fn(async () => ({})) }))
vi.mock('./canvasPageLocalStateUtils', () => ({ resolveActiveAgentScope: (id: string) => `${id}.agent-1` }))

import { useCanvasBridgeActions } from './useCanvasBridgeActions'

const image: CanvasImageItem = { id: 'img', type: 'image', src: 'local-media:///fixture/image.png', fileName: 'fixture.png', x: 0, y: 0, width: 100, height: 100, scaleX: 1, scaleY: 1, rotation: 0, zIndex: 0, locked: false }
const text: CanvasItem = { id: 'text', type: 'text', text: 'fixture text', x: 120, y: 0, width: 180, height: 51, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false, fill: '#fff', fontSize: 18, fontFamily: 'Arial', fontWeight: 'bold' }
const selected: CanvasItem[] = [image, text]
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

function setup(snapshot: () => Promise<string>) {
  const notifyError = vi.fn()
  const renderSnapshot = vi.fn(async (_items: CanvasItem[]) => snapshot())
  const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
  const hook = renderHook(({ canvasId }) => useCanvasBridgeActions({
    canvasId, projectName: 'fixture', items: selected, groups: [], notifySuccess: vi.fn(), notifyError,
    extractPromptTextFromCanvasItems: () => 'fixture text', renderCanvasItemsImageDataUrl: renderSnapshot,
    renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg/>')
  }), { initialProps: { canvasId: 'canvas-a' } })
  const delivered = () => dispatchEvent.mock.calls.map(([event]) => event as CustomEvent).filter(event => event.type === 'send-to-agent' || event.type === 'chat:focus-composer')
  return { ...hook, notifyError, renderSnapshot, delivered }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.dispatch.mockReset()
  mocks.materialize.mockReset().mockImplementation(async (attachment: ChatAttachment) => attachment)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('uncropped agent delivery lifecycle', () => {
  it('preserves two selected items with the same source as separate occurrences', async () => {
    const second = { ...image, id: 'img-2' }
    const targets: CanvasItem[] = [image, second]
    const before = structuredClone(targets)
    const hook = setup(async () => 'data:image/png;base64,c25hcA==')
    await act(async () => {
      await hook.result.current.handleSendCanvasItemsToAgent(targets, 'canvas-a.agent-1')
      await vi.runAllTimersAsync()
    })
    expect(hook.notifyError).not.toHaveBeenCalled()
    const attachments = hook.delivered().filter(event => event.type === 'send-to-agent' && event.detail.attachment)
    expect(attachments.map(event => event.detail.attachment.url)).toEqual([image.src, image.src])
    expect(attachments.map(event => event.detail.attachment.fileName)).toEqual([image.fileName, image.fileName])
    expect(targets).toEqual(before)
  })

  it.each(['same-url', 'same-name-size'] as const)('rejects %s collision before any delivery side effect', async scenario => {
    const first = { ...image, sizeBytes: 123 }
    const second = { ...first, id: 'img-2', src: scenario === 'same-url' ? first.src : 'local-media:///fixture/other.png' }
    const targets: CanvasItem[] = [first, second, text]
    const before = structuredClone(targets)
    const hook = setup(async () => 'data:image/png;base64,c25hcA==')
    const allEvents = vi.spyOn(window, 'dispatchEvent')
    await act(async () => {
      await hook.result.current.handleSendCanvasItemsToAgent(targets, 'canvas-a.agent-1')
      await vi.runAllTimersAsync()
    })
    expect.soft(hook.notifyError).toHaveBeenCalled()
    expect.soft(mocks.materialize).not.toHaveBeenCalled()
    expect.soft(hook.renderSnapshot).not.toHaveBeenCalled()
    expect.soft(mocks.dispatch).not.toHaveBeenCalled()
    expect.soft(allEvents).not.toHaveBeenCalled()
    expect(targets).toEqual(before)
  })

  it('sends two selected images with distinct descriptors in order', async () => {
    const second = { ...image, id: 'img-2', src: 'local-media:///fixture/other.png', fileName: 'other.png' }
    const targets: CanvasItem[] = [image, second]
    const before = structuredClone(targets)
    const hook = setup(async () => 'data:image/png;base64,c25hcA==')
    await act(async () => {
      await hook.result.current.handleSendCanvasItemsToAgent(targets, 'canvas-a.agent-1')
      await vi.runAllTimersAsync()
    })
    expect(hook.notifyError).not.toHaveBeenCalled()
    const events = hook.delivered().filter(event => event.type === 'send-to-agent' && event.detail.attachment)
    expect(events.map(event => event.detail.attachment.url)).toEqual([image.src, second.src])
    expect(targets).toEqual(before)
  })

  it.each(['unmount', 'switch'] as const)('stops after pending overview on %s', async action => {
    const overview = defer<string>()
    const hook = setup(() => overview.promise)
    let send!: Promise<boolean>
    await act(async () => { send = hook.result.current.handleSendCanvasItemsToAgent(selected); await Promise.resolve() })
    expect(hook.renderSnapshot).toHaveBeenCalledOnce()
    expect(hook.renderSnapshot.mock.calls[0][0]).toEqual(selected)
    expect(mocks.materialize).toHaveBeenCalledTimes(1)
    expect(mocks.materialize).toHaveBeenCalledWith(expect.objectContaining({ url: image.src }))
    if (action === 'unmount') hook.unmount(); else hook.rerender({ canvasId: 'canvas-b' })
    await act(async () => { overview.resolve('data:image/png;base64,c25hcA=='); await send; await vi.runAllTimersAsync() })
    // Explicit images now materialize before the overview; after invalidation,
    // neither the derived overview nor any later work may be delivered.
    expect(mocks.materialize).toHaveBeenCalledTimes(1)
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(hook.delivered()).toEqual([])
  })

  it.each(['unmount', 'switch'] as const)('stops after pending attachment preparation on %s', async action => {
    const pending = defer<ChatAttachment | null>()
    mocks.materialize.mockImplementationOnce(() => pending.promise)
    const hook = setup(async () => 'data:image/png;base64,c25hcA==')
    let send!: Promise<boolean>
    await act(async () => { send = hook.result.current.handleSendCanvasItemsToAgent(selected); await Promise.resolve(); await Promise.resolve() })
    expect(hook.renderSnapshot).not.toHaveBeenCalled()
    expect(mocks.materialize).toHaveBeenCalledTimes(1)
    if (action === 'unmount') hook.unmount(); else hook.rerender({ canvasId: 'canvas-b' })
    await act(async () => { pending.resolve({ type: 'image', url: image.src }); await send; await vi.runAllTimersAsync() })
    expect(mocks.materialize).toHaveBeenCalledTimes(1)
    expect(hook.renderSnapshot).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(hook.delivered()).toEqual([])
  })

  it('sends the selected uncropped image and text once on the same canvas', async () => {
    const before = structuredClone(selected)
    const hook = setup(async () => 'data:image/png;base64,c25hcA==')
    await act(async () => { await hook.result.current.handleSendCanvasItemsToAgent(selected, 'canvas-a.agent-1'); await vi.runAllTimersAsync() })
    expect(hook.notifyError).not.toHaveBeenCalled()
    expect(hook.renderSnapshot.mock.calls[0][0]).toEqual(selected)
    const events = hook.delivered().filter(event => event.type === 'send-to-agent')
    expect(events.filter(event => event.detail.attachment?.url === image.src)).toHaveLength(1)
    expect(events.filter(event => event.detail.attachment?.fileName === 'canvas-selection.png')).toHaveLength(1)
    expect(events.filter(event => event.detail.text === 'fixture text')).toHaveLength(1)
    expect(events.every(event => event.detail.targetScope === 'canvas-a.agent-1')).toBe(true)
    expect(selected).toEqual(before)
  })
})
