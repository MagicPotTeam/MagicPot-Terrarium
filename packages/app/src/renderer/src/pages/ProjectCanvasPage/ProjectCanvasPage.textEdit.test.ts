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
  getDroppedImageFile: vi.fn(),
  parseInternalImageDragPayload: vi.fn(() => null)
}))

import { applySelectedTextSizeChange, resolveDroppedAgentImageDataUrl } from './ProjectCanvasPage'
import { getDroppedImageFile } from '@renderer/utils/droppedImageUtils'

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

describe('resolveDroppedAgentImageDataUrl', () => {
  it('normalizes an Agent image drag into a data URL when a file can be materialized', async () => {
    const dataTransfer = {
      getData: (type: string) =>
        type === 'application/x-ai-image' ? 'local-media:///C:/demo/image.png' : '',
      files: emptyFileList
    } as unknown as Pick<DataTransfer, 'getData' | 'files'>
    const file = new File(['image-bytes'], 'image.png', { type: 'image/png' })
    vi.mocked(getDroppedImageFile).mockResolvedValueOnce(file)

    await expect(
      resolveDroppedAgentImageDataUrl(dataTransfer, async (inputFile) => `data:${inputFile.name}`)
    ).resolves.toEqual({
      src: 'data:image.png',
      fileName: 'image.png',
      sizeBytes: 11
    })
  })

  it('falls back to the normalized Agent URL when file materialization fails', async () => {
    const dataTransfer = {
      getData: (type: string) =>
        type === 'application/x-ai-image' ? 'file:///C:/demo/image.png' : '',
      files: emptyFileList
    } as unknown as Pick<DataTransfer, 'getData' | 'files'>
    vi.mocked(getDroppedImageFile).mockRejectedValueOnce(new Error('boom'))

    await expect(resolveDroppedAgentImageDataUrl(dataTransfer, async () => '')).resolves.toEqual({
      src: 'local-media:///C:/demo/image.png',
      fileName: 'image.png'
    })
  })

  it('also materializes quick app image drags so canvas drops do not race the blue progress bar', async () => {
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
      files: emptyFileList
    } as unknown as Pick<DataTransfer, 'getData' | 'files'>
    const file = new File(['qapp-image'], 'result.png', { type: 'image/png' })
    vi.mocked(getDroppedImageFile).mockResolvedValueOnce(file)

    await expect(
      resolveDroppedAgentImageDataUrl(dataTransfer, async (inputFile) => `data:${inputFile.name}`)
    ).resolves.toEqual({
      src: 'data:result.png',
      fileName: 'result.png',
      sizeBytes: 10
    })
  })
})
