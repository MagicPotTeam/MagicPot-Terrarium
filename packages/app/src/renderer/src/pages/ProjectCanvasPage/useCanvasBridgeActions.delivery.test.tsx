import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasBridgeActions } from './useCanvasBridgeActions'
import type { CanvasImageItem, CanvasItem } from './types'
import type { ChatAttachment } from '@shared/llm'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  materializeAttachment: vi.fn(),
  loadImageFromSrc: vi.fn(),
  resolveActiveAgentScope: vi.fn()
}))

vi.mock('react-redux', () => ({ useDispatch: () => mocks.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))
vi.mock('../../store/slices/layoutSlice', () => ({
  openRightPanel: () => ({ type: 'layout/openRightPanel' })
}))
vi.mock('../../utils/droppedImageUtils', () => ({
  materializeInternalImageDragAttachment: mocks.materializeAttachment
}))
vi.mock('../ChatPage/chatVideoAttachmentUtils', () => ({
  extractVideoBoundaryFrameDataUrls: vi.fn(async () => ({}))
}))
vi.mock('./canvasPageLocalStateUtils', () => ({
  resolveActiveAgentScope: mocks.resolveActiveAgentScope
}))
vi.mock('./canvasAssetIntakeHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./canvasAssetIntakeHelpers')>()),
  loadImageFromSrc: mocks.loadImageFromSrc
}))

const image: CanvasImageItem = {
  id: 'source-image',
  type: 'image',
  src: 'local-media:///C:/MagicPot/source.png',
  fileName: 'source.png',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  zIndex: 0,
  locked: false
}

function renderBridge() {
  const notifyError = vi.fn()
  const hook = renderHook(
    ({ canvasId }) =>
      useCanvasBridgeActions({
        canvasId,
        projectName: 'Test canvas',
        items: [image],
        groups: [],
        notifySuccess: vi.fn(),
        notifyError,
        extractPromptTextFromCanvasItems: () => 'Selected image',
        renderCanvasItemsImageDataUrl: vi.fn(async () => 'data:image/png;base64,snapshot'),
        renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg />')
      }),
    { initialProps: { canvasId: 'canvas-a' } }
  )
  const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')
  const deliveredEvents = () =>
    dispatchEventSpy.mock.calls
      .map(([event]) => event as CustomEvent)
      .filter((event) => ['send-to-agent', 'chat:focus-composer'].includes(event.type))

  return { ...hook, notifyError, deliveredEvents }
}

beforeEach(() => {
  mocks.dispatch.mockReset()
  mocks.materializeAttachment.mockReset()
  mocks.materializeAttachment.mockImplementation(async (attachment: ChatAttachment) => attachment)
  mocks.loadImageFromSrc.mockReset()
  mocks.loadImageFromSrc.mockRejectedValue(new Error('unexpected crop image load'))
  mocks.resolveActiveAgentScope.mockReset()
  mocks.resolveActiveAgentScope.mockImplementation((projectId: string) => `${projectId}.agent-1`)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useCanvasBridgeActions Agent delivery lifecycle', () => {
  it.each(['switch', 'unmount'] as const)('does not continue crop work after %s while source load is pending', async action => {
    const selected = [
      { ...image, id: 'crop-1', src: 'data:image/png;base64,YQ==', crop: { x: 0, y: 0, width: 50, height: 50 } },
      { ...image, id: 'crop-2', src: 'data:image/png;base64,Yg==', crop: { x: 0, y: 0, width: 50, height: 50 } }
    ]
    let finish!: (value: { img: HTMLImageElement; width: number; height: number }) => void
    mocks.loadImageFromSrc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const loaded = document.createElement('img')
    const canvasCreation = vi.spyOn(document, 'createElement')
    const drawImage = vi.fn()
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,Yw==')
    const { result, rerender, unmount, deliveredEvents } = renderBridge()
    let send!: Promise<boolean>
    await act(async () => { send = result.current.handleSendCanvasItemsToAgent(selected); await Promise.resolve() })
    expect(mocks.loadImageFromSrc).toHaveBeenCalledTimes(1)
    if (action === 'switch') rerender({ canvasId: 'canvas-b' })
    else unmount()
    await act(async () => { finish({ img: loaded, width: 100, height: 100 }); await send; await vi.runAllTimersAsync() })
    expect(canvasCreation.mock.calls.filter(([tag]) => String(tag).toLowerCase() === 'canvas')).toHaveLength(0)
    expect(context).not.toHaveBeenCalled()
    expect(encode).not.toHaveBeenCalled()
    expect(mocks.loadImageFromSrc).toHaveBeenCalledTimes(1)
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
  })

  it('loads and exports cropped items normally while the canvas remains current', async () => {
    const selected = [{ ...image, src: 'data:image/png;base64,YQ==', crop: { x: 0, y: 0, width: 50, height: 50 } }]
    const loaded = document.createElement('img')
    mocks.loadImageFromSrc.mockResolvedValue({ img: loaded, width: 100, height: 100 })
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,Yw==')
    const { result, deliveredEvents, notifyError } = renderBridge()
    await act(async () => { await result.current.handleSendCanvasItemsToAgent(selected); await vi.runAllTimersAsync() })
    expect(mocks.loadImageFromSrc).toHaveBeenCalledOnce()
    expect(drawImage).toHaveBeenCalledWith(loaded, 0, 0, 50, 50, 0, 0, 50, 50)
    expect(encode).toHaveBeenCalledWith('image/png')
    expect(notifyError).not.toHaveBeenCalled()
    expect(deliveredEvents().some(event => event.type === 'send-to-agent' && event.detail.attachment?.url === 'data:image/png;base64,Yw==')).toBe(true)
  })
  it('refuses a whole mixed selection when legacy crop coordinates cannot be authenticated', async () => {
    const crop = { x: 20, y: 10, width: 50, height: 50 }
    const selected: CanvasItem[] = [
      { ...image, sourceWidth: 200, sourceHeight: 200, crop },
      { ...image, id: 'other-image', src: 'local-media:///C:/MagicPot/other.png' }
    ]
    const loaded = document.createElement('img')
    mocks.loadImageFromSrc.mockResolvedValue({ img: loaded, width: 200, height: 200 })
    const draw = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,Y3JvcA==')
    const { result, notifyError, deliveredEvents } = renderBridge()
    await act(async () => { await result.current.handleSendCanvasItemsToAgent(selected); await vi.runAllTimersAsync() })
    expect(notifyError).toHaveBeenCalledExactlyOnceWith('canvas.agent_send_cropped_image_failed')
    expect(mocks.materializeAttachment).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
    expect(selected[0]).toMatchObject({ src: image.src, crop })
  })

  it('rejects 51 distinct selected images before crop loading or any attachment delivery', async () => {
    const selected = Array.from({ length: 51 }, (_, index) => ({
      ...image,
      id: `image-${index}`,
      ...(index === 0 ? { crop: { x: 0, y: 0, width: 50, height: 50 } } : {})
    }))
    const { result, notifyError, deliveredEvents } = renderBridge()
    const canvasCreation = vi.spyOn(document, 'createElement')
    await act(async () => {
      await result.current.handleSendCanvasItemsToAgent(selected)
      await vi.runAllTimersAsync()
    })
    expect(notifyError).toHaveBeenCalledExactlyOnceWith('本次图片数量超过限制，请分批发送')
    expect(mocks.loadImageFromSrc).not.toHaveBeenCalled()
    expect(canvasCreation.mock.calls.some(([tag]) => String(tag) === 'canvas')).toBe(false)
    expect(mocks.materializeAttachment).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
    expect(selected).toHaveLength(51)
  })

  it('stops a known oversized crop before image load, canvas allocation or any delivery', async () => {
    const selected = [{ ...image, sourceWidth: 10000, sourceHeight: 10000,
      crop: { x: 0, y: 0, width: 9000, height: 9000 } }]
    const { result, notifyError, deliveredEvents } = renderBridge()
    const canvasCreation = vi.spyOn(document, 'createElement')
    await act(async () => { await result.current.handleSendCanvasItemsToAgent(selected); await vi.runAllTimersAsync() })
    expect(notifyError).toHaveBeenCalledExactlyOnceWith('canvas.send_to_agent_failed')
    expect(mocks.loadImageFromSrc).not.toHaveBeenCalled()
    expect(canvasCreation.mock.calls.some(([tag]) => String(tag) === 'canvas')).toBe(false)
    expect(mocks.materializeAttachment).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
    expect(selected[0].crop).toEqual({ x: 0, y: 0, width: 9000, height: 9000 })
  })

  it('rejects a known oversized identity crop before loading or allocating', async () => {
    const selected = [{ ...image, sourceWidth: 10000, sourceHeight: 10000,
      crop: { x: 0, y: 0, width: 10000, height: 10000 } }]
    const { result, notifyError, deliveredEvents } = renderBridge()
    const canvasCreation = vi.spyOn(document, 'createElement')
    await act(async () => { await result.current.handleSendCanvasItemsToAgent(selected); await vi.runAllTimersAsync() })
    expect(notifyError).toHaveBeenCalledExactlyOnceWith('canvas.send_to_agent_failed')
    expect(mocks.loadImageFromSrc).not.toHaveBeenCalled()
    expect(canvasCreation.mock.calls.some(([tag]) => String(tag) === 'canvas')).toBe(false)
    expect(mocks.materializeAttachment).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
  })

  it('fails rather than silently dropping an oversized later crop when real dimensions appear after loading', async () => {
    const oversized = { ...image, id: 'unknown-size', width: 0, height: 0,
      crop: { x: 0, y: 0, width: 9000, height: 9000 } }
    mocks.loadImageFromSrc.mockResolvedValue({ img: document.createElement('img'), width: 10000, height: 10000 })
    const { result, notifyError, deliveredEvents } = renderBridge()
    const canvasCreation = vi.spyOn(document, 'createElement')
    await act(async () => { await result.current.handleSendCanvasItemsToAgent([image, oversized]); await vi.runAllTimersAsync() })
    expect(mocks.loadImageFromSrc).toHaveBeenCalledOnce()
    expect(canvasCreation.mock.calls.some(([tag]) => String(tag) === 'canvas')).toBe(false)
    expect(notifyError).toHaveBeenCalledExactlyOnceWith('canvas.send_to_agent_failed')
    expect(mocks.materializeAttachment).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
  })

  it('allows 50 distinct images and does not count duplicate selection ids twice', async () => {
    const selected = Array.from({ length: 50 }, (_, index) => ({ ...image, id: `image-${index}` }))
    const { result, notifyError, deliveredEvents } = renderBridge()
    await act(async () => {
      await result.current.handleSendCanvasItemsToAgent([...selected, selected[0]])
      await vi.runAllTimersAsync()
    })
    expect(notifyError).not.toHaveBeenCalled()
    expect(mocks.materializeAttachment).toHaveBeenCalledTimes(50)
    expect(deliveredEvents().filter(event => event.type === 'send-to-agent' && event.detail.attachment)).toHaveLength(50)
  })

  it('canvas-only preflight allows 50 explicit images plus an overview (composer applies its own conservative limit)', async () => {
    const selected = Array.from({ length: 50 }, (_, index) => ({ ...image, id: `image-${index}` }))
    const text: CanvasItem = { id: 'text', type: 'text', text: 'fixture', x: 0, y: 0, width: 10, height: 10,
      rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false, fill: '#fff', fontSize: 12,
      fontFamily: 'Arial', fontWeight: 'bold' }
    const { result, notifyError, deliveredEvents } = renderBridge()
    await act(async () => {
      await result.current.handleSendCanvasItemsToAgent([...selected, text])
      await vi.runAllTimersAsync()
    })
    expect(notifyError).not.toHaveBeenCalled()
    expect(mocks.materializeAttachment).toHaveBeenCalledTimes(51)
    expect(deliveredEvents().filter(event => event.type === 'send-to-agent' && event.detail.attachment)).toHaveLength(51)
  })

  it('materializes three attachments sequentially and delivers in their original order', async () => {
    const items = [image, { ...image, id: 'second', src: 'local-media:///second.png' }, { ...image, id: 'third', src: 'local-media:///third.png' }]
    const resolvers: Array<(value: ChatAttachment | null) => void> = []
    let active = 0, maxActive = 0
    mocks.materializeAttachment.mockImplementation(() => {
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise<ChatAttachment | null>(resolve => resolvers.push(value => { active--; resolve(value) }))
    })
    const { result, deliveredEvents } = renderBridge()
    let send!: Promise<boolean>
    await act(async () => { send = result.current.handleSendCanvasItemsToAgent(items, 'canvas-a.agent-explicit'); await Promise.resolve() })
    for (let index = 0; index < items.length; index++) {
      expect(mocks.materializeAttachment).toHaveBeenCalledTimes(index + 1)
      expect(active).toBe(1)
      await act(async () => { resolvers[index]({ type: 'image', url: items[index].src }); await Promise.resolve() })
    }
    await act(async () => { await send; await vi.runAllTimersAsync() })
    expect(maxActive).toBe(1)
    expect(deliveredEvents().filter(event => event.type === 'send-to-agent' && event.detail.attachment).map(event => event.detail.attachment.url)).toEqual(items.map(item => item.src))
  })

  it('does not start the next attachment after unmount during the second of three', async () => {
    const items = [image, { ...image, id: 'second', src: 'local-media:///second.png' }, { ...image, id: 'third', src: 'local-media:///third.png' }]
    let finish!: (value: ChatAttachment) => void
    mocks.materializeAttachment.mockImplementationOnce(async (attachment: ChatAttachment) => attachment)
      .mockImplementationOnce(() => new Promise<ChatAttachment>(resolve => { finish = resolve }))
    const { result, unmount, deliveredEvents } = renderBridge()
    let send!: Promise<boolean>
    await act(async () => { send = result.current.handleSendCanvasItemsToAgent(items); await Promise.resolve(); await Promise.resolve() })
    expect(mocks.materializeAttachment).toHaveBeenCalledTimes(2)
    unmount()
    finish({ type: 'image', url: items[1].src })
    await send
    await vi.runAllTimersAsync()
    expect(mocks.materializeAttachment).toHaveBeenCalledTimes(2)
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
  })

  it('reports a null materialization and does not deliver any part of three attachments', async () => {
    const items = [image, { ...image, id: 'second', src: 'local-media:///second.png' }, { ...image, id: 'third', src: 'local-media:///third.png' }]
    mocks.materializeAttachment.mockImplementationOnce(async (attachment: ChatAttachment) => attachment).mockResolvedValueOnce(null)
    const { result, notifyError, deliveredEvents } = renderBridge()
    await act(async () => { await result.current.handleSendCanvasItemsToAgent(items); await vi.runAllTimersAsync() })
    expect(mocks.materializeAttachment).toHaveBeenCalledTimes(2)
    expect(notifyError).toHaveBeenCalledExactlyOnceWith('canvas.send_to_agent_failed')
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
  })

  it('cancels an already scheduled delivery when the canvas unmounts', async () => {
    const { result, unmount, deliveredEvents } = renderBridge()
    await act(async () => {
      await result.current.handleSendCanvasItemsToAgent([image], 'canvas-a.agent-explicit')
    })

    unmount()
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(deliveredEvents()).toEqual([])
  })

  it('cancels the old canvas timer while allowing a fresh canvas delivery', async () => {
    const { result, rerender, deliveredEvents } = renderBridge()
    await act(async () => {
      await result.current.handleSendCanvasItemsToAgent([image], 'canvas-a.agent-explicit')
    })

    rerender({ canvasId: 'canvas-b' })
    await act(async () => {
      await result.current.handleSendCanvasItemsToAgent([image], 'canvas-b.agent-explicit')
      await vi.runAllTimersAsync()
    })

    expect(deliveredEvents().length).toBeGreaterThan(0)
    expect(
      deliveredEvents().every(
        (event) => (event.detail.targetScope ?? event.detail.scope) === 'canvas-b.agent-explicit'
      )
    ).toBe(true)
  })

  it('does not open the panel or schedule delivery after pending materialization is cancelled', async () => {
    let resolveAttachment!: (attachment: ChatAttachment) => void
    mocks.materializeAttachment.mockReturnValueOnce(
      new Promise<ChatAttachment>((resolve) => {
        resolveAttachment = resolve
      })
    )
    const { result, unmount, deliveredEvents } = renderBridge()
    let send!: Promise<boolean>
    await act(async () => {
      send = result.current.handleSendCanvasItemsToAgent([image], 'canvas-a.agent-explicit')
      await Promise.resolve()
    })
    expect(mocks.materializeAttachment).toHaveBeenCalledOnce()
    expect(mocks.dispatch).not.toHaveBeenCalled()

    unmount()
    resolveAttachment({ type: 'image', url: image.src })
    await send
    await vi.runAllTimersAsync()

    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
  })

  it('reports a current materialization failure without rejecting the fire-and-forget send', async () => {
    const failure = new Error('Materialization failed')
    mocks.materializeAttachment.mockRejectedValueOnce(failure)
    const { result, notifyError, deliveredEvents } = renderBridge()

    await expect(
      result.current.handleSendCanvasItemsToAgent([image], 'canvas-a.agent-explicit')
    ).resolves.toBeUndefined()
    await vi.runAllTimersAsync()

    expect(notifyError).toHaveBeenCalledExactlyOnceWith('canvas.send_to_agent_failed')
    expect(deliveredEvents()).toEqual([])
  })

  it('silences failures from a cancelled canvas generation', async () => {
    let rejectAttachment!: (error: Error) => void
    mocks.materializeAttachment.mockReturnValueOnce(
      new Promise<ChatAttachment>((_resolve, reject) => {
        rejectAttachment = reject
      })
    )
    const { result, rerender, notifyError, deliveredEvents } = renderBridge()
    let send!: Promise<boolean>
    await act(async () => {
      send = result.current.handleSendCanvasItemsToAgent([image], 'canvas-a.agent-explicit')
      await Promise.resolve()
    })

    rerender({ canvasId: 'canvas-b' })
    rejectAttachment(new Error('Old canvas failed'))
    await expect(send).resolves.toBeUndefined()
    await vi.runAllTimersAsync()

    expect(notifyError).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
  })

  it('does not notify partial attachment failures after the canvas unmounts', async () => {
    let resolveAttachment!: (attachment: ChatAttachment | null) => void
    mocks.materializeAttachment.mockReturnValueOnce(
      new Promise<ChatAttachment | null>((resolve) => {
        resolveAttachment = resolve
      })
    )
    const { result, unmount, notifyError, deliveredEvents } = renderBridge()
    let send!: Promise<boolean>
    await act(async () => {
      send = result.current.handleSendCanvasItemsToAgent([image])
      await Promise.resolve()
    })

    unmount()
    resolveAttachment(null)
    await send
    await vi.runAllTimersAsync()

    expect(notifyError).not.toHaveBeenCalled()
    expect(deliveredEvents()).toEqual([])
  })

  it('keeps the captured destination when the active pane changes while an attachment loads', async () => {
    let resolveAttachment!: (attachment: ChatAttachment) => void
    mocks.materializeAttachment.mockReturnValueOnce(
      new Promise<ChatAttachment>((resolve) => {
        resolveAttachment = resolve
      })
    )
    const { result, rerender, deliveredEvents } = renderBridge()
    let send!: Promise<boolean>
    await act(async () => {
      send = result.current.handleSendCanvasItemsToAgent([image])
      await Promise.resolve()
    })

    mocks.resolveActiveAgentScope.mockReturnValue('canvas-a.agent-other')
    rerender({ canvasId: 'canvas-a' })
    resolveAttachment({ type: 'image', url: image.src })
    await send
    await vi.runAllTimersAsync()

    expect(mocks.resolveActiveAgentScope).toHaveBeenCalledOnce()
    expect(deliveredEvents().length).toBeGreaterThan(0)
    expect(
      deliveredEvents().every(
        (event) => (event.detail.targetScope ?? event.detail.scope) === 'canvas-a.agent-1'
      )
    ).toBe(true)
  })

  it('allows separate same-canvas sends and releases each delivery timer', async () => {
    const { result, deliveredEvents } = renderBridge()
    await act(async () => {
      await Promise.all([
        result.current.handleSendCanvasItemsToAgent([image], 'canvas-a.agent-1'),
        result.current.handleSendCanvasItemsToAgent([image], 'canvas-a.agent-2')
      ])
      await vi.runAllTimersAsync()
    })

    expect(
      deliveredEvents()
        .filter((event) => event.type === 'send-to-agent' && event.detail.attachment)
        .map((event) => event.detail.targetScope)
    ).toEqual(['canvas-a.agent-1', 'canvas-a.agent-2'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
