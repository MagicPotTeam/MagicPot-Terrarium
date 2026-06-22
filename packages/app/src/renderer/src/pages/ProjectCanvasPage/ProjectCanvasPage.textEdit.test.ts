import { describe, expect, it, vi } from 'vitest'
import type { CanvasAnnotationItem, CanvasItem, CanvasTextItem } from './types'

vi.mock('react-konva', () => ({
  Stage: () => null,
  Layer: () => null,
  Rect: () => null,
  Image: () => null,
  Transformer: () => null,
  Line: () => null,
  Text: () => null,
  Ellipse: () => null,
  Arrow: () => null,
  Shape: () => null,
  Group: () => null
}))

vi.mock('konva/lib/Stage', () => ({
  Stage: class {}
}))

vi.mock('konva', () => ({
  default: {}
}))

vi.mock('../../components/MaxSizeLayout', () => ({
  default: () => null
}))
vi.mock('./components/Model3DOverlay', () => ({ default: () => null }))
vi.mock('./components/VideoOverlay', () => ({ default: () => null }))
vi.mock('./components/CanvasItemPlaceholder', () => ({ default: () => null }))
vi.mock('./components/HtmlOverlay', () => ({ default: () => null }))
vi.mock('./components/Model3DViewerDialog', () => ({ default: () => null }))
vi.mock('./components/ProjectCanvasImageCropOverlay', () => ({
  default: () => null
}))
vi.mock('./components/CanvasTextNode', () => ({ default: () => null }))
vi.mock('./components/CanvasImageNode', () => ({ default: () => null }))
vi.mock('./components/CanvasFileNode', () => ({ default: () => null }))
vi.mock('./components/CanvasSelectionActionToolbar', () => ({ default: () => null }))
vi.mock('./components/GroupPlaybackOverlay', () => ({ default: () => null }))
vi.mock('./Dialogs/LabelEditorDialog', () => ({ LabelEditorDialog: () => null }))
vi.mock('./Dialogs/ClearConfirmDialog', () => ({ ClearConfirmDialog: () => null }))
vi.mock('./Dialogs/TextureImportDialog', () => ({ TextureImportDialog: () => null }))
vi.mock('./components/CanvasAnnotationNode', () => ({ default: () => null }))
vi.mock('./components/ColorWheelSquarePicker', () => ({
  default: () => null
}))
vi.mock('@renderer/utils/droppedImageUtils', () => ({
  AGENT_IMAGE_DRAG_MIME: 'application/x-ai-image',
  getDroppedImageFile: vi.fn(
    async (dataTransfer: Pick<DataTransfer, 'files'>) =>
      Array.from(dataTransfer.files ?? []).find((file) => (file.type || '').startsWith('image/')) ??
      null
  ),
  parseInternalImageDragPayload: vi.fn(() => null)
}))

import { applySelectedTextSizeChange, resolveDroppedAgentImageDataUrl } from './ProjectCanvasPage'
const emptyFileList = {
  length: 0,
  item: () => null
} as unknown as FileList

function createTextItem(overrides: Partial<CanvasTextItem> = {}): CanvasTextItem {
  return {
    id: 'text-1',
    type: 'text',
    text: 'Hello world',
    fontSize: 18,
    fontFamily: 'system-ui, sans-serif',
    fill: '#e0e0e0',
    x: 24,
    y: 32,
    width: 180,
    height: 48,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createTextAnnotationItem(
  overrides: Partial<CanvasAnnotationItem> = {}
): CanvasAnnotationItem {
  return {
    id: 'anno-1',
    type: 'annotation',
    shape: 'text-anno',
    stroke: '#ffffff',
    fillOpacity: 0,
    strokeWidth: 2,
    label: '',
    text: 'Caption',
    fontSize: 24,
    x: 48,
    y: 64,
    width: 160,
    height: 36,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

function createRectAnnotationItem(
  overrides: Partial<CanvasAnnotationItem> = {}
): CanvasAnnotationItem {
  return {
    id: 'rect-1',
    type: 'annotation',
    shape: 'rect',
    stroke: '#ffffff',
    fillOpacity: 0,
    strokeWidth: 2,
    label: '',
    text: '',
    fontSize: 24,
    x: 12,
    y: 16,
    width: 120,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

describe('applySelectedTextSizeChange', () => {
  it('updates selected text nodes when the text size control changes', () => {
    const items: CanvasItem[] = [createTextItem(), createRectAnnotationItem()]
    const next = applySelectedTextSizeChange(items, new Set(['text-1']), 24, true)

    expect(next[0]).toEqual(
      expect.objectContaining({
        fontSize: 24,
        width: 240,
        height: 64,
        scaleX: 1,
        scaleY: 1
      })
    )
    expect(next[1]).toEqual(createRectAnnotationItem())
  })

  it('updates selected attached text annotations without touching unrelated annotations', () => {
    const items: CanvasItem[] = [createTextAnnotationItem(), createRectAnnotationItem()]
    const next = applySelectedTextSizeChange(items, new Set(['anno-1']), 36, true)

    expect(next[0]).toEqual(
      expect.objectContaining({
        fontSize: 36,
        width: 240,
        height: 54,
        scaleX: 1,
        scaleY: 1
      })
    )
    expect(next[1]).toEqual(createRectAnnotationItem())
  })

  it('keeps regular annotation stroke width behavior outside text mode', () => {
    const items: CanvasItem[] = [createTextItem(), createRectAnnotationItem()]
    const next = applySelectedTextSizeChange(items, new Set(['rect-1']), 6, false)

    expect(next[0]).toEqual(createTextItem())
    expect(next[1]).toEqual(
      expect.objectContaining({
        strokeWidth: 6
      })
    )
  })
})

const createFileList = (file: File): FileList =>
  ({
    0: file,
    length: 1,
    item: (index: number) => (index === 0 ? file : null),
    [Symbol.iterator]: function* () {
      yield file
    }
  }) as unknown as FileList

describe('resolveDroppedAgentImageDataUrl', () => {
  it('uses an object URL for an Agent image file without base64 materialization', async () => {
    const file = new File(['image-bytes'], 'image.png', { type: 'image/png' })
    const dataTransfer = {
      getData: (type: string) =>
        type === 'application/x-ai-image' ? 'local-media:///C:/demo/image.png' : '',
      files: createFileList(file)
    } as unknown as Pick<DataTransfer, 'getData' | 'files'>
    const createObjectURLSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:image-file')

    await expect(resolveDroppedAgentImageDataUrl(dataTransfer)).resolves.toEqual({
      src: 'blob:image-file',
      fileName: 'image.png',
      sizeBytes: 11,
      sourceFile: file
    })
    expect(createObjectURLSpy).toHaveBeenCalledWith(file)
  })

  it('uses the normalized Agent URL when no image file is present', async () => {
    const dataTransfer = {
      getData: (type: string) =>
        type === 'application/x-ai-image' ? 'file:///C:/demo/image.png' : '',
      files: emptyFileList
    } as unknown as Pick<DataTransfer, 'getData' | 'files'>

    await expect(resolveDroppedAgentImageDataUrl(dataTransfer)).resolves.toEqual({
      src: 'local-media:///C:/demo/image.png',
      fileName: 'image.png'
    })
  })

  it('uses an object URL for quick app image file drops without base64 materialization', async () => {
    const file = new File(['qapp-image'], 'result.png', { type: 'image/png' })
    const dataTransfer = {
      getData: (type: string) =>
        type === 'application/x-qapp-image'
          ? JSON.stringify({
              objectUrl: 'blob:qapp-image',
              promptId: 'prompt-9',
              fileItem: {
                filename: 'result.png',
                type: 'output'
              }
            })
          : '',
      files: createFileList(file)
    } as unknown as Pick<DataTransfer, 'getData' | 'files'>
    const createObjectURLSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:qapp-file')

    await expect(resolveDroppedAgentImageDataUrl(dataTransfer)).resolves.toEqual({
      src: 'blob:qapp-file',
      fileName: 'result.png',
      sizeBytes: 10,
      sourceFile: file
    })
    expect(createObjectURLSpy).toHaveBeenCalledWith(file)
  })
})
