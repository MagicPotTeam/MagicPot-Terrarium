import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useCanvasSelectionUiActions } from './useCanvasSelectionUiActions'
import type { CanvasImageItem } from './types'

vi.mock('../../utils/windowUtils', () => ({
  api: () => ({})
}))

const originalGetContext = HTMLCanvasElement.prototype.getContext
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  HTMLCanvasElement.prototype.toDataURL = originalToDataURL
  vi.restoreAllMocks()
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

function renderSelectionUiActions(items: CanvasImageItem[]) {
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
      handleSendSelectionToAgent: vi.fn(),
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
      actionMessageKeyRef: { current: null }
    })
  )
}

describe('useCanvasSelectionUiActions drag payload', () => {
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
        handleSendSelectionToAgent: vi.fn(),
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
})
