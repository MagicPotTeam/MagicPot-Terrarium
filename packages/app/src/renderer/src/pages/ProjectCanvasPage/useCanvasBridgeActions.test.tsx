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

function installCropImageFixture(expectedSrc: string) {
  const loaded: HTMLImageElement[] = []
  class FakeImage {
    naturalWidth = 100
    naturalHeight = 80
    onload: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    crossOrigin: string | null = null
    set src(value: string) {
      Promise.resolve().then(() => {
        if (value === expectedSrc) this.onload?.(new Event('load'))
        else this.onerror?.(new Event('error'))
      })
    }
    constructor() { loaded.push(this as unknown as HTMLImageElement) }
  }
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('electronFile', { resolveAuthorizedLocalMediaPath: vi.fn(async (path: string) => path) })
  return loaded
}

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

  it('passes overview limits in the fourth argument while leaving clip bounds unset', async () => {
    const first = createImageItem('first', 'first.png')
    const second: CanvasItem = { id: 'second', type: 'text', text: 'hello', x: 0, y: 0, width: 180, height: 51, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 2, locked: false, fill: '#ffffff', fontSize: 18, fontFamily: 'Arial', fontWeight: 'bold' }
    const renderSnapshot = vi.fn(async () => 'data:image/png;base64,snapshot')
    const { result } = renderHook(() => useCanvasBridgeActions({
      canvasId: 'canvas-1', projectName: 'Demo', items: [first, second], groups: [],
      notifySuccess: vi.fn(), notifyError: vi.fn(), extractPromptTextFromCanvasItems: () => 'text',
      renderCanvasItemsImageDataUrl: renderSnapshot, renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg/>')
    }))
    await act(async () => { await result.current.handleSendCanvasItemsToAgent([first, second]); vi.runAllTimers() })
    expect(renderSnapshot).toHaveBeenCalledOnce()
    expect(renderSnapshot).toHaveBeenCalledWith([first, second], false, undefined, { maxSide: 2000, maxArea: 4000000 })
  })

  it('uses the same cropped snapshot for mixed-selection overview without changing canvas geometry', async () => {
    const loaded = installCropImageFixture('local-media:///C:/MagicPot/selected.jpg')
    const selected = createImageItem('selected-image', 'selected.jpg', {
      sourceWidth: 100, sourceHeight: 80, x: 91, y: 27, width: 210, height: 70,
      rotation: 23, scaleX: -1, scaleY: 2, zIndex: 3,
      crop: { x: 10, y: 20, width: 30, height: 40 }
    })
    const text: CanvasItem = { id: 'selected-text', type: 'text', text: 'note', x: 40, y: 50,
      width: 100, height: 30, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 5, locked: false,
      fill: '#fff', fontSize: 14, fontFamily: 'Arial' }
    const before = structuredClone(selected)
    const drawImage = vi.fn()
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cropped-visible')
    const renderSnapshot = vi.fn(async () => 'data:image/png;base64,overview')
    const events = vi.spyOn(window, 'dispatchEvent')
    const notifyError = vi.fn()
    try {
      const { result } = renderHook(() => useCanvasBridgeActions({
        canvasId: 'canvas-1', projectName: 'Demo', items: [selected, text], groups: [],
        notifySuccess: vi.fn(), notifyError, extractPromptTextFromCanvasItems: () => 'note',
        renderCanvasItemsImageDataUrl: renderSnapshot, renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg/>')
      }))
      await act(async () => { await result.current.handleSendCanvasItemsToAgent([selected, text]); vi.runAllTimers() })
      expect(loaded).toHaveLength(1)
      expect(drawImage).toHaveBeenCalledWith(loaded[0], 10, 20, 30, 40, 0, 0, 30, 40)
      expect(renderSnapshot).toHaveBeenCalledOnce()
      const [overviewItems] = renderSnapshot.mock.calls[0] as unknown as [CanvasItem[]]
      expect(overviewItems[0]).toMatchObject({
        id: selected.id, src: 'data:image/png;base64,cropped-visible', x: 91, y: 27,
        width: 210, height: 70, rotation: 23, scaleX: -1, scaleY: 2, zIndex: 3
      })
      expect(overviewItems[0]).not.toHaveProperty('crop')
      expect(overviewItems[1]).toEqual(text)
      expect(selected).toEqual(before)
      expect(notifyError).not.toHaveBeenCalled()
      const sentAttachments = events.mock.calls.flatMap(([event]) => {
        if (event.type !== 'send-to-agent') return []
        const detail = (event as CustomEvent<{ attachment?: { url?: string } }>).detail
        return detail?.attachment?.url ? [detail.attachment.url] : []
      })
      expect(sentAttachments).toContain('data:image/png;base64,cropped-visible')
      expect(sentAttachments).toContain('data:image/png;base64,overview')
      expect(sentAttachments).not.toContain(selected.src)
    } finally {
      events.mockRestore(); toDataURL.mockRestore(); getContext.mockRestore(); vi.unstubAllGlobals()
    }
  })

  it('never rereads a mutable full-crop source for a mixed overview or its attachment', async () => {
    const loaded = installCropImageFixture('local-media:///C:/MagicPot/selected.jpg')
    const selected = createImageItem('selected-image', 'selected.jpg', {
      sourceWidth: 100, sourceHeight: 80, x: 91, y: 27, width: 210, height: 70,
      rotation: 23, scaleX: -1, scaleY: 2, zIndex: 3,
      crop: { x: 0, y: 0, width: 100, height: 80 }
    })
    const text: CanvasItem = { id: 'selected-text', type: 'text', text: 'note', x: 40, y: 50,
      width: 100, height: 30, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 5, locked: false,
      fill: '#fff', fontSize: 14, fontFamily: 'Arial' }
    const before = structuredClone(selected)
    const drawImage = vi.fn()
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,full-snapshot')
    const renderSnapshot = vi.fn(async () => 'data:image/png;base64,overview')
    const events = vi.spyOn(window, 'dispatchEvent')
    const notifyError = vi.fn()
    try {
      const { result } = renderHook(() => useCanvasBridgeActions({
        canvasId: 'canvas-1', projectName: 'Demo', items: [selected, text], groups: [],
        notifySuccess: vi.fn(), notifyError, extractPromptTextFromCanvasItems: () => 'note',
        renderCanvasItemsImageDataUrl: renderSnapshot, renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg/>')
      }))
      await act(async () => { await result.current.handleSendCanvasItemsToAgent([selected, text]); vi.runAllTimers() })
      expect(loaded).toHaveLength(1)
      expect(drawImage).toHaveBeenCalledWith(loaded[0], 0, 0, 100, 80, 0, 0, 100, 80)
      const [overviewItems] = renderSnapshot.mock.calls[0] as unknown as [CanvasItem[]]
      expect(overviewItems[0]).toMatchObject({ src: 'data:image/png;base64,full-snapshot',
        x: 91, y: 27, width: 210, height: 70, rotation: 23, scaleX: -1, scaleY: 2, zIndex: 3 })
      expect(overviewItems[0]).not.toHaveProperty('crop')
      expect(selected).toEqual(before)
      expect(notifyError).not.toHaveBeenCalled()
      const urls = events.mock.calls.flatMap(([event]) => {
        if (event.type !== 'send-to-agent') return []
        const detail = (event as CustomEvent<{ attachment?: { url?: string } }>).detail
        return detail?.attachment?.url ? [detail.attachment.url] : []
      })
      expect(urls).toContain('data:image/png;base64,full-snapshot')
      expect(urls).toContain('data:image/png;base64,overview')
      expect(urls).not.toContain(selected.src)
    } finally {
      events.mockRestore(); toDataURL.mockRestore(); getContext.mockRestore(); vi.unstubAllGlobals()
    }
  })

  it.each(['empty', 'null', 'throws'] as const)('does not deliver any partial selection when overview %s', async (mode) => {
    const first = createImageItem('first', 'first.png')
    const second: CanvasItem = { id: 'second', type: 'text', text: 'hello', x: 0, y: 0, width: 180, height: 51, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 2, locked: false, fill: '#ffffff', fontSize: 18, fontFamily: 'Arial', fontWeight: 'bold' }
    const notifyError = vi.fn(), notifySuccess = vi.fn()
    const events = vi.spyOn(window, 'dispatchEvent')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const renderSnapshot = vi.fn(async (): Promise<string> => {
      if (mode === 'throws') throw new RangeError('overview exceeds raster limits')
      return mode === 'null' ? null as unknown as string : ''
    })
    try {
      const { result } = renderHook(() => useCanvasBridgeActions({
        canvasId: 'canvas-1', projectName: 'Demo', items: [first, second], groups: [],
        notifySuccess, notifyError, extractPromptTextFromCanvasItems: () => 'text',
        renderCanvasItemsImageDataUrl: renderSnapshot, renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg/>')
      }))
      await act(async () => { await result.current.handleSendCanvasItemsToAgent([first, second]); vi.runAllTimers() })
      expect(notifyError).toHaveBeenCalledExactlyOnceWith('canvas.agent_send_overview_failed')
      expect(notifySuccess).not.toHaveBeenCalled()
      expect(mockDispatch).not.toHaveBeenCalled()
      expect(events.mock.calls.filter(([event]) => event.type === 'send-to-agent' || event.type === 'chat:focus-composer')).toHaveLength(0)
    } finally { events.mockRestore(); warning.mockRestore() }
  })

  it('sends cropped image attachments as exported visible PNGs without changing canvas item semantics', async () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')
    const loaded = installCropImageFixture('local-media:///C:/MagicPot/selected.jpg')
    const selected = createImageItem('selected-image', 'selected.jpg', {
      sourceWidth: 100,
      sourceHeight: 80,
      width: 30,
      height: 40,
      crop: { x: 10, y: 20, width: 30, height: 40 }
    })
    const original = structuredClone(selected)
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
      expect(drawImage).toHaveBeenCalledWith(loaded[0], 10, 20, 30, 40, 0, 0, 30, 40)
      expect(loaded).toHaveLength(1)
      expect(sendEvents.some(event => event.detail?.attachment?.url === selected.src)).toBe(false)
      expect(toDataURLSpy).toHaveBeenCalledWith('image/png')
      expect(selected).toEqual(original)
      expect(selected.src).toBe('local-media:///C:/MagicPot/selected.jpg')
      expect(selected.crop).toEqual({ x: 10, y: 20, width: 30, height: 40 })
      expect(sendEvents.find((event) => event.detail?.hiddenText)?.detail?.hiddenText).toContain(
        'dimensions=30x40'
      )
    } finally {
      dispatchEventSpy.mockRestore()
      getContextSpy.mockRestore()
      toDataURLSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('does not send a mixed selection when one cropped image fails', async () => {
    const events = vi.spyOn(window, 'dispatchEvent')
    const loaded = installCropImageFixture('local-media:///C:/MagicPot/cropped.jpg')
    const cropped = createImageItem('cropped', 'cropped.jpg', { sourceWidth: 100, sourceHeight: 80, crop: {x: 10, y: 20, width: 30, height: 40} })
    const other = createImageItem('other', 'other.png')
    const text: CanvasItem = { id: 'text', type: 'text', text: 'keep me', x: 0, y: 0, width: 180, height: 51, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 2, locked: false, fill: '#ffffff', fontSize: 18, fontFamily: 'Arial', fontWeight: 'bold' }
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const notifyError = vi.fn(), notifySuccess = vi.fn(), renderSnapshot = vi.fn(async () => 'data:image/png;base64,snapshot')
    try {
      const {result} = renderHook(() => useCanvasBridgeActions({
        canvasId:'canvas-1', projectName:'Demo', items:[cropped, other, text], groups:[], notifyError, notifySuccess,
        extractPromptTextFromCanvasItems: () => 'keep me', renderCanvasItemsImageDataUrl:renderSnapshot,
        renderCanvasItemsSvgMarkup:vi.fn(async () => '<svg/>')
      }))
      await act(async () => { await result.current.handleSendCanvasItemsToAgent([cropped, other, text]); vi.runAllTimers() })
      expect(loaded).toHaveLength(1)
      expect(context).toHaveBeenCalled()
      expect(notifyError).toHaveBeenCalledExactlyOnceWith('canvas.agent_send_cropped_image_failed')
      expect(notifySuccess).not.toHaveBeenCalled()
      expect(renderSnapshot).not.toHaveBeenCalled()
      expect(mockDispatch).not.toHaveBeenCalled()
      expect(events.mock.calls.filter(([event]) => event.type === 'send-to-agent' || event.type === 'chat:focus-composer')).toHaveLength(0)
    } finally { context.mockRestore(); events.mockRestore(); vi.unstubAllGlobals() }
  })

  it('does not fall back to the full original or a snapshot when cropped image materialization fails', async () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')
    installCropImageFixture('local-media:///C:/MagicPot/selected.jpg')
    const selected = createImageItem('selected-image', 'selected.jpg', {
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
      vi.unstubAllGlobals()
    }
  })

  describe('async cropped sends without source dimensions', () => {
    const source = 'data:image/png;base64,c3ludGhldGlj'
    const croppedUrl = 'data:image/png;base64,Y3JvcHBlZA=='

    function makeSelection(crop: CanvasImageItem['crop'] = { x: 0, y: 0, width: 100, height: 100 }) {
      return createImageItem('async-crop', 'async.png', {
        src: source, image: undefined, sourceWidth: undefined, sourceHeight: undefined,
        width: 100, height: 100, crop
      })
    }

    function mockLoadedImage() {
      const loaded: HTMLImageElement[] = []
      class LoadedImage {
        naturalWidth = 200
        naturalHeight = 200
        width = 200
        height = 200
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        crossOrigin = ''
        set src(_value: string) { Promise.resolve().then(() => this.onload?.()) }
        constructor() { loaded.push(this as unknown as HTMLImageElement) }
      }
      vi.stubGlobal('Image', LoadedImage)
      return loaded
    }

    function setup(items: CanvasItem[]) {
      const notifyError = vi.fn(), notifySuccess = vi.fn()
      const snapshot = vi.fn(async () => 'data:image/png;base64,c25hcHNob3Q=')
      const events = vi.spyOn(window, 'dispatchEvent')
      const { result } = renderHook(() => useCanvasBridgeActions({
        canvasId: 'canvas-1', projectName: 'Demo', items, groups: [], notifyError, notifySuccess,
        extractPromptTextFromCanvasItems: () => 'fixture', renderCanvasItemsImageDataUrl: snapshot,
        renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg/>')
      }))
      const send = async () => { await act(async () => { await result.current.handleSendCanvasItemsToAgent(items, 'canvas-1.agent-2'); vi.runAllTimers() }) }
      const sendEvents = () => events.mock.calls.map(([event]) => event as CustomEvent<{ attachment?: { url?: string } }>).filter(event => event.type === 'send-to-agent')
      return { notifyError, notifySuccess, snapshot, events, send, sendEvents }
    }

    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it.each(['null', 'throw'] as const)('fails closed for single and mixed selections when context is %s', async mode => {
      mockLoadedImage()
      const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      if (mode === 'null') context.mockReturnValue(null)
      else context.mockImplementation(() => { throw new Error('fixture context failure') })
      for (const mixed of [false, true]) {
        mockDispatch.mockClear()
        const cropped = makeSelection()
        const before = { ...cropped, crop: { ...cropped.crop! } }
        const other = createImageItem('other', 'other.png', { src: source, sourceWidth: undefined, sourceHeight: undefined })
        const state = setup(mixed ? [other, cropped] : [cropped])
        await state.send()
        expect(state.notifyError).toHaveBeenCalledExactlyOnceWith('canvas.agent_send_cropped_image_failed')
        expect(state.notifySuccess).not.toHaveBeenCalled()
        expect(state.snapshot).not.toHaveBeenCalled()
        expect(mockDispatch).not.toHaveBeenCalled()
        expect(state.sendEvents()).toHaveLength(0)
        expect(cropped).toEqual(before)
        state.events.mockRestore()
      }
    })

    it('sends the loaded source crop, not its original URL', async () => {
      const loaded = mockLoadedImage()
      const drawImage = vi.fn()
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
      const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(croppedUrl)
      const cropped = makeSelection()
      const before = { ...cropped, crop: { ...cropped.crop! } }
      const state = setup([cropped])
      await state.send()
      expect(state.notifyError).not.toHaveBeenCalled()
      expect(loaded.length).toBeGreaterThan(0)
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 100, 0, 0, 100, 100)
      expect(loaded).toContain(drawImage.mock.calls[0][0])
      expect(toDataURL).toHaveBeenCalledWith('image/png')
      expect(state.sendEvents().some(event => event.detail?.attachment?.url === croppedUrl)).toBe(true)
      expect(state.sendEvents().some(event => event.detail?.attachment?.url === source)).toBe(false)
      expect(cropped).toEqual(before)
    })

    it('retains the original source for an uncropped image', async () => {
      mockLoadedImage()
      const item = makeSelection(undefined)
      delete item.crop
      const before = { ...item }
      const state = setup([item])
      await state.send()
      expect(state.notifyError).not.toHaveBeenCalled()
      expect(state.sendEvents().some(event => event.detail?.attachment?.url === source)).toBe(true)
      expect(item).toEqual(before)
    })

    it.each(['null', 'empty data URL'] as const)('rejects the whole send if a full-crop snapshot fails: %s', async (failure) => {
      mockLoadedImage()
      const item = makeSelection({ x: 0, y: 0, width: 200, height: 200 })
      const before = { ...item, crop: { ...item.crop! } }
      const drawImage = vi.fn()
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        failure === 'null' ? null : { drawImage } as never
      )
      const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:,')
      const state = setup([item])
      await state.send()
      if (failure === 'empty data URL') {
        expect(drawImage).toHaveBeenCalledOnce()
        expect(encode).toHaveBeenCalledOnce()
      }
      expect(state.notifyError).toHaveBeenCalledExactlyOnceWith('canvas.agent_send_cropped_image_failed')
      expect(state.sendEvents()).toHaveLength(0)
      expect(state.snapshot).not.toHaveBeenCalled()
      expect(item).toEqual(before)
    })
  })
})
