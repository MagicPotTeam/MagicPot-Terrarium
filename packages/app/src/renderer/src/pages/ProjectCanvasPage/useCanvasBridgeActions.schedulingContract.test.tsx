// Synthetic hook tests: scheduled means timer registered, not receiver ACK.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/llm'
import type { CanvasImageItem, CanvasItem, CanvasVideoItem } from './types'

const m = vi.hoisted(() => ({ dispatch: vi.fn(), materialize: vi.fn(), extractFrames: vi.fn() }))
vi.mock('react-redux', () => ({ useDispatch: () => m.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))
vi.mock('../../store/slices/layoutSlice', () => ({ openRightPanel: () => ({ type: 'layout/openRightPanel' }) }))
vi.mock('../../utils/droppedImageUtils', () => ({ materializeInternalImageDragAttachment: m.materialize }))
vi.mock('../ChatPage/chatVideoAttachmentUtils', () => ({ extractVideoBoundaryFrameDataUrls: m.extractFrames }))
vi.mock('./canvasPageLocalStateUtils', () => ({ resolveActiveAgentScope: (id: string) => `${id}.agent-1` }))
import { useCanvasBridgeActions } from './useCanvasBridgeActions'

const image = (n: number): CanvasImageItem => ({ id: `image-${n}`, type: 'image', src: `local-media:///fixture/${n}.png`, fileName: `${n}.png`, sizeBytes: 100 + n, x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, zIndex: n, locked: false })
const video = (): CanvasVideoItem => ({ id: 'video-1', type: 'video', src: 'local-media:///fixture/video.mp4', fileName: 'video.mp4', playing: false, muted: true, volume: 0, x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 3, locked: false })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function setup(items: CanvasItem[]) {
  const notifyError = vi.fn()
  const overview = vi.fn(async () => 'data:image/png;base64,c25hcA==')
  const events = vi.spyOn(window, 'dispatchEvent')
  const hook = renderHook(({ canvasId }) => useCanvasBridgeActions({ canvasId, projectName: 'fixture', items, groups: [], notifySuccess: vi.fn(), notifyError, extractPromptTextFromCanvasItems: () => '', renderCanvasItemsImageDataUrl: overview, renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg/>') }), { initialProps: { canvasId: 'canvas-a' } })
  return { ...hook, notifyError, overview, events }
}
beforeEach(() => { vi.useFakeTimers(); m.dispatch.mockReset(); m.materialize.mockReset().mockImplementation(async (attachment: ChatAttachment) => attachment); m.extractFrames.mockReset().mockResolvedValue({}) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('canvas bridge boolean local scheduling contract', () => {
  it('returns true once scheduled, before any window event or receiver ACK', async () => {
    const items = [image(1)]
    const hook = setup(items)
    let result: boolean | undefined
    await act(async () => { result = await hook.result.current.handleSendCanvasItemsToAgent(items) })
    expect(result).toBe(true)
    expect(m.dispatch).toHaveBeenCalledOnce()
    expect(hook.events).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    hook.unmount()
  })
  it.each(['null', 'throw'] as const)('returns false on materialize %s without panel or events', async mode => {
    m.materialize.mockImplementation(async () => { if (mode === 'throw') throw new Error('synthetic'); return null })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const items = [image(1)]
    const hook = setup(items)
    let result: boolean | undefined
    await act(async () => { result = await hook.result.current.handleSendCanvasItemsToAgent(items); await vi.runAllTimersAsync() })
    expect(result).toBe(false)
    expect(hook.notifyError).toHaveBeenCalled()
    expect(m.dispatch).not.toHaveBeenCalled()
    expect(hook.events).not.toHaveBeenCalled()
  })
  it.each(['switch', 'unmount'] as const)('returns false when %s during preparation', async action => {
    const gate = deferred<ChatAttachment | null>()
    m.materialize.mockReturnValue(gate.promise)
    const items = [image(1)]
    const hook = setup(items)
    let send!: Promise<boolean>
    try {
      await act(async () => { send = hook.result.current.handleSendCanvasItemsToAgent(items); await Promise.resolve() })
      expect(m.materialize).toHaveBeenCalledOnce()
      if (action === 'switch') hook.rerender({ canvasId: 'canvas-b' }); else hook.unmount()
      let result: boolean | undefined
      await act(async () => { gate.resolve({ type: 'image', url: items[0].src }); result = await send; await vi.runAllTimersAsync() })
      expect(result).toBe(false)
      expect(m.dispatch).not.toHaveBeenCalled()
      expect(hook.events).not.toHaveBeenCalled()
      expect(hook.notifyError).not.toHaveBeenCalled()
    } finally { gate.resolve(null); if (send) await act(async () => { await send }) }
  })
  it.each(['url', 'filename-size'] as const)('rejects duplicate %s before any preparation side effect', async collision => {
    const first = image(1)
    const second = collision === 'url' ? { ...image(2), src: first.src } : { ...image(2), fileName: first.fileName, sizeBytes: first.sizeBytes }
    const items = [first, second]
    const hook = setup(items)
    let result: boolean | undefined
    await act(async () => { result = await hook.result.current.handleSendCanvasItemsToAgent(items); await vi.runAllTimersAsync() })
    expect(result).toBe(false)
    expect(hook.notifyError).toHaveBeenCalled()
    expect(m.materialize).not.toHaveBeenCalled()
    expect(hook.overview).not.toHaveBeenCalled()
    expect(m.dispatch).not.toHaveBeenCalled()
    expect(hook.events).not.toHaveBeenCalled()
  })
  it.each(['url', 'filename-size'] as const)('rejects materialized duplicate %s before third item or delivery', async collision => {
    const items = [image(1), image(2), image(3)]
    const before = structuredClone(items)
    m.materialize.mockImplementation(async (attachment: ChatAttachment) => {
      if (attachment.url !== items[1].src) return attachment
      return collision === 'url'
        ? { ...attachment, url: items[0].src }
        : { ...attachment, fileName: items[0].fileName, sizeBytes: items[0].sizeBytes }
    })
    const hook = setup(items)
    let result: boolean | undefined
    await act(async () => { result = await hook.result.current.handleSendCanvasItemsToAgent(items); await vi.runAllTimersAsync() })
    expect.soft(result).toBe(false)
    expect.soft(hook.notifyError).toHaveBeenCalledWith('canvas.agent_send_duplicate_selection')
    expect.soft(m.materialize).toHaveBeenCalledTimes(2)
    expect.soft(m.materialize.mock.calls.map(([attachment]) => attachment.url)).toEqual([items[0].src, items[1].src])
    expect.soft(m.dispatch).not.toHaveBeenCalled()
    expect.soft(hook.events).not.toHaveBeenCalled()
    expect(items).toEqual(before)
  })

  it('accepts one video even when its derived boundary frames have identical pixels', async () => {
    const items = [video()]
    const frame = 'data:image/png;base64,c2FtZQ=='
    m.extractFrames.mockResolvedValue({ firstFrameDataUrl: frame, lastFrameDataUrl: frame })
    const hook = setup(items)
    let result: boolean | undefined
    await act(async () => { result = await hook.result.current.handleSendCanvasItemsToAgent(items); await vi.runAllTimersAsync() })
    expect(result).toBe(true)
    expect(hook.notifyError).not.toHaveBeenCalled()
    const delivered = hook.events.mock.calls.map(([event]) => event as CustomEvent).filter(event => event.type === 'send-to-agent' && event.detail.attachment)
    expect(delivered.filter(event => event.detail.attachment.type === 'video')).toHaveLength(1)
    expect(delivered.filter(event => event.detail.attachment.url === frame)).toHaveLength(2)
    // These events are not an ACK; the real receiver can still coalesce the derived frames.
  })
  it('rejects a materialized explicit collision before overview or later video extraction', async () => {
    const items = [image(1), image(2), video()]
    m.materialize.mockImplementation(async (attachment: ChatAttachment) => attachment.url === items[1].src ? { ...attachment, url: items[0].src } : attachment)
    const hook = setup(items)
    let result: boolean | undefined
    await act(async () => { result = await hook.result.current.handleSendCanvasItemsToAgent(items); await vi.runAllTimersAsync() })
    expect(result).toBe(false)
    expect(hook.notifyError).toHaveBeenCalledWith('canvas.agent_send_duplicate_selection')
    expect(m.materialize).toHaveBeenCalledTimes(2)
    expect(hook.overview).not.toHaveBeenCalled()
    expect(m.extractFrames).not.toHaveBeenCalled()
    expect(m.dispatch).not.toHaveBeenCalled()
    expect(hook.events).not.toHaveBeenCalled()
  })

  it('materializes three distinct images serially and dispatches in order', async () => {
    const items = [image(1), image(2), image(3)]
    const gate = deferred<ChatAttachment | null>()
    m.materialize.mockImplementationOnce(() => gate.promise).mockImplementation(async (item: ChatAttachment) => item)
    const hook = setup(items)
    let send!: Promise<boolean>
    try {
      await act(async () => { send = hook.result.current.handleSendCanvasItemsToAgent(items); await Promise.resolve() })
      expect(m.materialize).toHaveBeenCalledOnce()
      let result: boolean | undefined
      await act(async () => { gate.resolve({ type: 'image', url: items[0].src, fileName: items[0].fileName }); result = await send })
      expect(result).toBe(true)
      expect(m.materialize.mock.calls.map(([item]) => item.url)).toEqual(items.map(item => item.src))
      expect(hook.events).not.toHaveBeenCalled()
      await act(async () => { await vi.runAllTimersAsync() })
      const delivered = hook.events.mock.calls.map(([event]) => event as CustomEvent).filter(event => event.type === 'send-to-agent' && event.detail.attachment)
      expect(delivered.map(event => event.detail.attachment.url)).toEqual(items.map(item => item.src))
    } finally { gate.resolve(null); if (send) await act(async () => { await send }) }
  })
})
