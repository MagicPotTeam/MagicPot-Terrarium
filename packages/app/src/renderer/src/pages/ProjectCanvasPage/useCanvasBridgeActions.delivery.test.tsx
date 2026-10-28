import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasBridgeActions } from './useCanvasBridgeActions'
import type { CanvasImageItem } from './types'
import type { ChatAttachment } from '@shared/llm'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  materializeAttachment: vi.fn(),
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
    let send!: Promise<void>
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
    let send!: Promise<void>
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
    let send!: Promise<void>
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
    let send!: Promise<void>
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
