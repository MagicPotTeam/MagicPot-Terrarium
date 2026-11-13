import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useCanvasSelectionUiActions } from './useCanvasSelectionUiActions'
import type { CanvasImageItem } from './types'

vi.mock('../../utils/windowUtils', () => ({
  api: () => window.api ?? {}
}))

const originalGetContext = HTMLCanvasElement.prototype.getContext
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  HTMLCanvasElement.prototype.toDataURL = originalToDataURL
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function createImageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'local-media:///C:/MagicPot/source.jpg',
    fileName: 'source.jpg',
    sizeBytes: 4096,
    sourceWidth: 100,
    sourceHeight: 80,
    x: 24,
    y: 32,
    width: 30,
    height: 40,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function renderSelectionUiActions(
  items: CanvasImageItem[],
  handleSendCanvasItemsToAgent = vi.fn(),
  overrides: Record<string, unknown> = {}
) {
  return renderHook(() =>
    useCanvasSelectionUiActions({
      alpha: (color: string) => color,
      annoTool: 'rect',
      annotationFillOpacity: 0,
      annotationStrokeWidth: 1,
      canvasContainerRef: { current: null },
      canvasId: 'canvas-1',
      contextMenuTarget: null,
      extractPromptTextFromCanvasItems: (targetItems) =>
        targetItems.map((item) => `${item.id}:${item.type}`).join('\n'),
      getCanvasItemsBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 80 }),
      handleCopyCanvasItemsAsImage: vi.fn(),
      handleDownloadCanvasItemsAsImage: vi.fn(),
      handleSendCanvasItemsSnapshotToPhotoshop: vi.fn(),
      handleSendCanvasItemsToAgent,
      isChineseUi: false,
      isFillableAnnotationShape: () => false,
      items,
      labelDialogItemId: null,
      labelDialogText: '',
      nextZIndex: { current: 1 },
      notifyError: vi.fn(),
      notifySuccess: vi.fn(),
      selectedIds: new Set<string>(),
      setAnnotationFillOpacity: vi.fn(),
      setContextMenuTarget: vi.fn(),
      setCroppingImageId: vi.fn(),
      setExtractingImageId: vi.fn(),
      setImageContextMenu: vi.fn(),
      setItems: vi.fn(),
      setItemsWithHistory: vi.fn(),
      setLabelDialogOpen: vi.fn(),
      setPendingTextureModelId: vi.fn(),
      setSelectedIds: vi.fn(),
      setTextureImportDialogOpen: vi.fn(),
      setTool: vi.fn(),
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      t: (key: string) => key,
      theme: {
        palette: {
          mode: 'dark',
          common: { black: '#000000', white: '#ffffff' },
          background: { paper: '#111111' },
          text: { primary: '#ffffff' }
        }
      },
      tool: 'select',
      tryHandleCanvasExternalDropRef: { current: null },
      actionMessageKeyRef: { current: null },
      ...overrides
    })
  )
}

describe('useCanvasSelectionUiActions drag payload', () => {
  it.each([false, true])('rejects a partial crop from an unverified equal-sized canvas, mixed=%s', (mixed) => {
    // Canvas pixels and src are distinct synthetic assets; drawing/encoding is stubbed, not decoded.
    const image = document.createElement('canvas')
    image.width = 100
    image.height = 80
    const selected = createImageItem({ image, src: 'data:image/png;base64,c3ludGhldGljLXNvdXJjZQ==', crop: { x: 10, y: 20, width: 30, height: 40 } })
    const items = mixed ? [createImageItem({ id: 'other' }), selected] : [selected]
    const drawImage = vi.fn()
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,c3ludGhldGljLWNyb3A=')
    const notifyError = vi.fn()
    const { result } = renderSelectionUiActions(items, vi.fn(), { notifyError })
    const setData = vi.fn()
    const transfer = { setData, effectAllowed: 'none' } as unknown as DataTransfer
    const dispatch = vi.fn()
    let payload: ReturnType<typeof result.current.buildCanvasDragPayload> | undefined
    let thrown: unknown
    try {
      payload = result.current.buildCanvasDragPayload(items, { objectUrl: selected.src, previewImageUrl: selected.src })
      result.current.setCanvasDragPayload(transfer, payload)
      dispatch(payload)
    } catch (error) { thrown = error }
    expect(payload).toBeUndefined()
    expect(setData).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledOnce()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('CANVAS_CROP_EXPORT_UNAVAILABLE')
  })
  it.each([true, false])('handles synthetic external drop with unknown crop=%s', (unknownCrop) => {
    const item = createImageItem({
      src: 'data:image/png;base64,c3ludGhldGlj',
      ...(unknownCrop ? { sourceWidth: undefined, sourceHeight: undefined, image: undefined, width: 100, height: 100, crop: { x: 0, y: 0, width: 100, height: 100 } } : {})
    })
    const target = document.createElement('div')
    const dragover = vi.fn((event: Event) => event.preventDefault())
    const drop = vi.fn((event: Event) => event.preventDefault())
    target.addEventListener('dragover', dragover)
    target.addEventListener('drop', drop)
    const previous = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target })
    vi.stubGlobal('DataTransfer', class { effectAllowed = ''; setData = vi.fn() })
    vi.stubGlobal('DragEvent', class extends MouseEvent {
      dataTransfer: DataTransfer | null
      constructor(type: string, init: DragEventInit) { super(type, init); this.dataTransfer = init.dataTransfer ?? null }
    })
    const notifyError = vi.fn()
    try {
      const { result } = renderSelectionUiActions([item], vi.fn(), { notifyError })
      expect(result.current.tryHandleCanvasExternalDrop(item.id, 150, 50)).toBe(true)
      if (unknownCrop) {
        expect(dragover).not.toHaveBeenCalled()
        expect(drop).not.toHaveBeenCalled()
        expect(notifyError).toHaveBeenCalledOnce()
      } else {
        expect(dragover).toHaveBeenCalledOnce()
        expect(drop).toHaveBeenCalledOnce()
        expect(notifyError).not.toHaveBeenCalled()
      }
    } finally {
      if (previous) Object.defineProperty(document, 'elementFromPoint', previous)
      else Reflect.deleteProperty(document, 'elementFromPoint')
    }
  })
  it.each([false, true])('rejects an unverified crop before any drag payload, mixed=%s', (mixed) => {
    // Synthetic source denotes a 200x200 PNG; no Image is loaded in this synchronous path.
    const original = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAACaUlEQVR42u3TMQ0AAAjAsPk3DTYI6TEHa9XoTqNTZUpABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABIkAAESCACBBABAggAgQQYwIiQAARIIAIEEAECCACRIAAIkAAESCACBBABIgAAUSAACJAABEggAgQmRIQAQKIAAFEgAAiQAARIAIEEAECiAABRIAAIkAECCACBBABAogAAUSACBBABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABIkAAESCACBBABAggAkSAACJAABEggAgQQAQIIAJEgAAiQAARIIAIEEAEiAABRIAAIkAAESCACBABAogAAUSAACJAABEggJgSEAECiAABRIAAIkAAESACBBABAogAAUSAACJABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAABxJiACBBABAggAgQQAQKIABEggAgQQAQIIAIEEAEiQAARIIAIEEAECCACRKYERIAAIkAAESCACBBABIgAAUSAACJAABEggAgQAQKIAAFEgAAiQAARIAIEEAECiAABRIAAIkAAESACBBABAogAAUSAACJABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABAogAESCACBBABAggAgQQASJAABEggAgQQAQIIAJEgAAiQAARIIAIEEAECCCmBESAACJAABEggAgQQASIAAFEgAAiQAARIIAIEAECiAABRIAAIkAAESACBBABAogAAUSAACJAADEmIAIEEAECiAABRIAAIkAECCACBBAB8rEFA6mDSMjZmAIAAAAASUVORK5CYII='
    const cropped = createImageItem({ src: original, sourceWidth: undefined, sourceHeight: undefined, image: undefined, width: 100, height: 100, crop: { x: 0, y: 0, width: 100, height: 100 } })
    const items = mixed ? [cropped, createImageItem({ id: 'other', src: 'data:image/png;base64,c2FmZQ==' })] : [cropped]
    const { result } = renderSelectionUiActions(items)
    const setData = vi.fn()
    const transfer = { setData, effectAllowed: 'none' } as unknown as DataTransfer
    expect(() => {
      const payload = result.current.buildCanvasDragPayload(items, { objectUrl: original, previewImageUrl: original })
      result.current.setCanvasDragPayload(transfer, payload)
    }).toThrow('CANVAS_CROP_EXPORT_UNAVAILABLE')
    expect(setData).not.toHaveBeenCalled()
  })

  it.each([false, true])('fails closed before allocating an oversized synchronous crop, mixed=%s', (mixed) => {
    // Plain synthetic asset and fake output canvas: never allocate real image pixels.
    // The crop starts at x=1 so it is a real crop, not the full-source fast path;
    // normalization clips its requested 9000x9000 to 8999x9000.
    const image = { width: 9000, height: 9000 } as unknown as CanvasImageItem['image']
    const selected = createImageItem({ image, sourceWidth: 9000, sourceHeight: 9000, crop: { x: 1, y: 0, width: 9000, height: 9000 } })
    const items = mixed ? [createImageItem({ id: 'other' }), selected] : [selected]
    const notifyError = vi.fn()
    const { result } = renderSelectionUiActions(items, vi.fn(), { notifyError })
    const getContext = vi.fn(() => ({ drawImage: vi.fn() }))
    const toDataURL = vi.fn(() => 'data:image/png;base64,c3ludGhldGlj')
    const fakeCanvas = { width: 0, height: 0, getContext, toDataURL }
    const originalCreateElement = document.createElement.bind(document)
    const createElement = vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) =>
      tag.toLowerCase() === 'canvas' ? fakeCanvas : originalCreateElement(tag, options)) as typeof document.createElement)
    const setData = vi.fn()
    const transfer = { setData, effectAllowed: 'none' } as unknown as DataTransfer
    let thrown: unknown
    try {
      const payload = result.current.buildCanvasDragPayload(items, { objectUrl: selected.src, previewImageUrl: selected.src })
      result.current.setCanvasDragPayload(transfer, payload)
    } catch (error) { thrown = error }
    expect(createElement).not.toHaveBeenCalledWith('canvas')
    expect(getContext).not.toHaveBeenCalled()
    expect(toDataURL).not.toHaveBeenCalled()
    expect(setData).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledOnce()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('CANVAS_CROP_EXPORT_UNAVAILABLE')
  })

  it('rejects a stale thumbnail-sized full crop before exposing the original in a drag payload', () => {
    // The original is synthetic 200x200; image is a different 100x100 thumbnail.
    const original = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAACaUlEQVR42u3TMQ0AAAjAsPk3DTYI6TEHa9XoTqNTZUpABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABIkAAESCACBBABAggAgQQYwIiQAARIIAIEEAECCACRIAAIkAAESCACBBABIgAAUSAACJAABEggAgQmRIQAQKIAAFEgAAiQAARIAIEEAECiAABRIAAIkAECCACBBABAogAAUSACBBABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABIkAAESCACBBABAggAkSAACJAABEggAgQQAQIIAJEgAAiQAARIIAIEEAEiAABRIAAIkAAESCACBABAogAAUSAACJAABEggJgSEAECiAABRIAAIkAAESACBBABAogAAUSAACJABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAABxJiACBBABAggAgQQAQKIABEggAgQQAQIIAIEEAEiQAARIIAIEEAECCACRKYERIAAIkAAESCACBBABIgAAUSAACJAABEggAgQAQKIAAFEgAAiQAARIAIEEAECiAABRIAAIkAAESACBBABAogAAUSAACJABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABAogAESCACBBABAggAgQQASJAABEggAgQQAQIIAJEgAAiQAARIIAIEEAECCCmBESAACJAABEggAgQQASIAAFEgAAiQAARIAIEAECiAABRIAAIkAAESACBBABAogAAUSAACJAADEmIAIEEAECiAABRIAAIkAECCACBBAB8rEFA6mDSMjZmAIAAAAASUVORK5CYII='
    const image = { width: 100, height: 100 } as unknown as CanvasImageItem['image']
    const selected = createImageItem({ src: original, image, sourceWidth: 100, sourceHeight: 100, crop: { x: 0, y: 0, width: 100, height: 100 } })
    const notifyError = vi.fn(), setData = vi.fn()
    const { result } = renderSelectionUiActions([selected], vi.fn(), { notifyError })
    const transfer = { setData, effectAllowed: 'none' } as unknown as DataTransfer
    vi.stubGlobal('Image', class { naturalWidth = 200; naturalHeight = 200; onload: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()) } })
    expect(() => {
      const payload = result.current.buildCanvasDragPayload([selected], { objectUrl: original, previewImageUrl: original })
      result.current.setCanvasDragPayload(transfer, payload)
    }).toThrow('CANVAS_CROP_EXPORT_UNAVAILABLE')
    expect(setData).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledOnce()
  })

  it('keeps an uncropped image in the drag payload', () => {
    const item = createImageItem()
    const { result } = renderSelectionUiActions([item])
    const payload = result.current.buildCanvasDragPayload([item])
    expect(payload.objectUrl).toBe(item.src)
    expect(payload.previewImageUrl).toBe(item.src)
    expect(payload.attachments?.[0]?.url).toBe(item.src)
  })
  it('keeps ordinary coded chat errors readable and restores the canvas rather than reporting success', async () => {
    const items = [createImageItem(), createImageItem({ id: 'image-2' })], notifyError = vi.fn(), notifySuccess = vi.fn(), setItems = vi.fn()
    const chat = vi.fn(async () => { throw { message: 'ordinary provider failure', code: 'E_ORDINARY' } })
    vi.stubGlobal('api', { svcLLMProxy: { chat, listProfiles: vi.fn(async () => ({ profiles: [{ id: 'profile' }] })) } })
    const { result } = renderSelectionUiActions(items, vi.fn(), { notifyError, notifySuccess, setItems })
    await result.current.handleSmartCleanup()
    expect(notifyError).toHaveBeenCalledWith('AI cleanup failed: ordinary provider failure')
    expect(setItems).toHaveBeenCalledWith(items)
    expect(notifySuccess).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledOnce()
  })

  it('uses a materialized cropped image for objectUrl when the original image is available', () => {
    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = 100
    sourceCanvas.height = 80
    const selected = createImageItem({
      image: sourceCanvas,
      crop: { x: 10, y: 20, width: 30, height: 40 }
    })
    const drawImage = vi.fn()
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        drawImage
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    const toDataURL = vi.fn(() => 'data:image/png;base64,Y3JvcHBlZC12aXNpYmxl')
    HTMLCanvasElement.prototype.toDataURL = toDataURL

    const { result } = renderSelectionUiActions([selected])
    const payload = result.current.buildCanvasDragPayload([selected], {
      objectUrl: selected.src,
      previewImageUrl: selected.src,
      promptId: 'prompt-1'
    })

    expect(payload.objectUrl).toBe('data:image/png;base64,Y3JvcHBlZC12aXNpYmxl')
    expect(payload.previewImageUrl).toBe('data:image/png;base64,Y3JvcHBlZC12aXNpYmxl')
    expect(payload.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        url: 'data:image/png;base64,Y3JvcHBlZC12aXNpYmxl',
        mimeType: 'image/png',
        fileName: 'source.png',
        sourceWidth: 30,
        sourceHeight: 40
      })
    ])
    expect(payload.hiddenTextContent).toContain('dimensions=30x40')
    expect(drawImage).toHaveBeenCalledWith(sourceCanvas, 10, 20, 30, 40, 0, 0, 30, 40)
    expect(toDataURL).toHaveBeenCalledWith('image/png')
    expect(JSON.stringify(payload)).not.toContain('magicpotCanvasCropSource')
    expect(selected.src).toBe('local-media:///C:/MagicPot/source.jpg')
    expect(selected.fileName).toBe('source.jpg')
    expect(selected.crop).toEqual({ x: 10, y: 20, width: 30, height: 40 })
  })

  it('does not serialize a downscaled in-memory crop as a data URL', () => {
    const displayCanvas = document.createElement('canvas')
    displayCanvas.width = 50
    displayCanvas.height = 40
    const selected = createImageItem({
      image: displayCanvas,
      sourceWidth: 100,
      sourceHeight: 80,
      crop: { x: 10, y: 20, width: 30, height: 40 }
    })
    const drawImage = vi.fn()
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        drawImage
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    const toDataURL = vi.fn(() => 'data:image/png;base64,Y3JvcHBlZC10aHVtYm5haWw=')
    HTMLCanvasElement.prototype.toDataURL = toDataURL

    const { result } = renderSelectionUiActions([selected])
    const payload = result.current.buildCanvasDragPayload([selected], {
      objectUrl: selected.src,
      previewImageUrl: selected.src
    })

    expect(payload.objectUrl).toBe('local-media:///C:/MagicPot/source.jpg')
    expect(payload.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        url: 'local-media:///C:/MagicPot/source.jpg',
        fileName: 'source.png',
        sourceWidth: 30,
        sourceHeight: 40,
        metadata: {
          magicpotCanvasCropSource: {
            url: 'local-media:///C:/MagicPot/source.jpg',
            fileName: 'source.png',
            sourceWidth: 100,
            sourceHeight: 80,
            crop: { x: 10, y: 20, width: 30, height: 40 }
          }
        }
      })
    ])
    expect(payload.hiddenTextContent).toContain('dimensions=30x40')
    expect(drawImage).not.toHaveBeenCalled()
    expect(toDataURL).not.toHaveBeenCalled()
  })

  it('writes a lightweight payload into DataTransfer synchronously', () => {
    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = 50
    sourceCanvas.height = 40
    const selected = createImageItem({
      image: sourceCanvas,
      sourceWidth: 100,
      sourceHeight: 80,
      crop: { x: 10, y: 20, width: 30, height: 40 }
    })
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        drawImage: vi.fn()
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toDataURL = vi.fn(
      () => 'data:image/png;base64,Y3JvcHBlZC12aXNpYmxl'
    )

    const { result } = renderSelectionUiActions([selected])
    const payload = result.current.buildCanvasDragPayload([selected], {
      objectUrl: selected.src,
      previewImageUrl: selected.src
    })
    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn((type: string, value: string) => {
        data.set(type, value)
      })
    } as unknown as DataTransfer

    result.current.setCanvasDragPayload(dataTransfer, payload)

    const rawPayload = data.get('application/x-qapp-image')
    expect(rawPayload).toBeTruthy()
    expect(rawPayload).not.toContain('data:image')
    expect(rawPayload?.length).toBeLessThan(2000)
    const parsedPayload = JSON.parse(rawPayload || '{}') as {
      objectUrl?: string
      attachments?: Array<{ url?: string; sourceWidth?: number; sourceHeight?: number }>
    }
    expect(parsedPayload.objectUrl).toBe('local-media:///C:/MagicPot/source.jpg')
    expect(parsedPayload.attachments?.[0]).toEqual(
      expect.objectContaining({
        url: 'local-media:///C:/MagicPot/source.jpg',
        sourceWidth: 30,
        sourceHeight: 40
      })
    )
    expect(data.get('text/plain')).toBe('image-1:image')
    expect(data.get('text/plain')).not.toContain('MAGICPOT_DRAG::')
    expect(data.get('text/plain')).not.toContain('data:image')
    expect(dataTransfer.effectAllowed).toBe('copy')
  })

  it('uses short safe text/plain when an image drag has no prompt text', () => {
    const selected = createImageItem({
      crop: { x: 10, y: 20, width: 30, height: 40 }
    })
    const { result } = renderHook(() =>
      useCanvasSelectionUiActions({
        alpha: (color: string) => color,
        annoTool: 'rect',
        annotationFillOpacity: 0,
        annotationStrokeWidth: 1,
        canvasContainerRef: { current: null },
        canvasId: 'canvas-1',
        contextMenuTarget: null,
        extractPromptTextFromCanvasItems: () => '',
        getCanvasItemsBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 80 }),
        handleCopyCanvasItemsAsImage: vi.fn(),
        handleDownloadCanvasItemsAsImage: vi.fn(),
        handleSendCanvasItemsSnapshotToPhotoshop: vi.fn(),
        handleSendCanvasItemsToAgent: vi.fn(),
        isChineseUi: false,
        isFillableAnnotationShape: () => false,
        items: [selected],
        labelDialogItemId: null,
        labelDialogText: '',
        nextZIndex: { current: 1 },
        notifyError: vi.fn(),
        notifySuccess: vi.fn(),
        selectedIds: new Set<string>(),
        setAnnotationFillOpacity: vi.fn(),
        setContextMenuTarget: vi.fn(),
        setCroppingImageId: vi.fn(),
        setExtractingImageId: vi.fn(),
        setImageContextMenu: vi.fn(),
        setItems: vi.fn(),
        setItemsWithHistory: vi.fn(),
        setLabelDialogOpen: vi.fn(),
        setPendingTextureModelId: vi.fn(),
        setSelectedIds: vi.fn(),
        setTextureImportDialogOpen: vi.fn(),
        setTool: vi.fn(),
        stagePos: { x: 0, y: 0 },
        stageScale: 1,
        t: (key: string) => key,
        theme: {
          palette: {
            mode: 'dark',
            common: { black: '#000000', white: '#ffffff' },
            background: { paper: '#111111' },
            text: { primary: '#ffffff' }
          }
        },
        tool: 'select',
        tryHandleCanvasExternalDropRef: { current: null },
        actionMessageKeyRef: { current: null }
      })
    )
    const payload = result.current.buildCanvasDragPayload([selected], {
      objectUrl: selected.src,
      previewImageUrl: selected.src
    })
    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn((type: string, value: string) => {
        data.set(type, value)
      })
    } as unknown as DataTransfer

    result.current.setCanvasDragPayload(dataTransfer, payload)

    expect(data.get('text/plain')).toBe('MagicPot canvas asset')
    expect(data.get('text/plain')?.length).toBeLessThan(100)
    expect(data.get('application/x-qapp-image')).toContain('magicpotCanvasCropSource')
  })

  it('keeps non-cropped image drag payload behavior', () => {
    const selected = createImageItem()

    const { result } = renderSelectionUiActions([selected])
    const payload = result.current.buildCanvasDragPayload([selected], {
      objectUrl: selected.src,
      previewImageUrl: selected.src,
      promptId: 'prompt-1'
    })

    expect(payload.objectUrl).toBe('local-media:///C:/MagicPot/source.jpg')
    expect(payload.previewImageUrl).toBe('local-media:///C:/MagicPot/source.jpg')
    expect(payload.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        url: 'local-media:///C:/MagicPot/source.jpg',
        mimeType: 'image/jpeg',
        fileName: 'source.jpg',
        sizeBytes: 4096,
        sourceWidth: 100,
        sourceHeight: 80
      })
    ])
    expect(JSON.stringify(payload)).not.toContain('magicpotCanvasCropSource')
  })

  it('keeps single-image drags independent from a requested preview image', () => {
    const selected = createImageItem({
      scaleX: 2,
      scaleY: 1.5
    })

    const { result } = renderSelectionUiActions([selected])
    const payload = result.current.buildCanvasDragPayload([selected], {
      objectUrl: 'blob:visible-image',
      previewImageUrl: 'blob:visible-image'
    })

    expect(payload.objectUrl).toBe('local-media:///C:/MagicPot/source.jpg')
    expect(payload.previewImageUrl).toBe('local-media:///C:/MagicPot/source.jpg')
    expect(payload.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        url: 'local-media:///C:/MagicPot/source.jpg',
        mimeType: 'image/jpeg',
        fileName: 'source.jpg',
        sizeBytes: 4096,
        sourceWidth: 100,
        sourceHeight: 80
      })
    ])
    expect(payload.hiddenTextContent).toContain('dimensions=100x80')
    expect(JSON.stringify(payload)).not.toContain('magicpotCanvasCropSource')
  })

  it('wires Agent drops to the explicit dragged item even with no selected IDs', () => {
    const dragged = createImageItem({ id: 'dragged-image' })
    const sendItems = vi.fn()
    const workspace = document.createElement('div')
    workspace.dataset.agentWorkspaceRoot = 'canvas-drag-target'
    const previousElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => workspace
    })

    try {
      const { result } = renderSelectionUiActions([dragged], sendItems)

      expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(true)
      expect(sendItems).toHaveBeenCalledExactlyOnceWith([dragged], 'canvas-drag-target.agent-1')
    } finally {
      if (previousElementFromPoint) {
        Object.defineProperty(document, 'elementFromPoint', previousElementFromPoint)
      } else {
        Reflect.deleteProperty(document, 'elementFromPoint')
      }
    }
  })
})
