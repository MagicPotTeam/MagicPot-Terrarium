import { describe, expect, it } from 'vitest'
import {
  CANVAS_HISTORY_LIMIT,
  createCanvasHistorySnapshot,
  restoreCanvasHistorySnapshot
} from './canvasHistory'
import type { CanvasImageItem, CanvasModel3DItem, CanvasTextItem } from './types'

function createImageItem(
  id: string,
  src: string,
  image?: HTMLImageElement,
  overrides: Partial<CanvasImageItem> = {}
): CanvasImageItem {
  return {
    id,
    type: 'image',
    src,
    image,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createTextItem(id: string, text: string): CanvasTextItem {
  return {
    id,
    type: 'text',
    text,
    fontSize: 16,
    fontFamily: 'sans-serif',
    fill: '#fff',
    x: 0,
    y: 0,
    width: 120,
    height: 48,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

function createModelItem(
  id: string,
  fileName: string,
  overrides: Partial<CanvasModel3DItem & { deferRender?: boolean }> = {}
): CanvasModel3DItem & { deferRender?: boolean } {
  return {
    id,
    type: 'model3d',
    src: `file:///${fileName}`,
    fileName,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

describe('canvasHistory', () => {
  it('uses the expected bounded history size', () => {
    expect(CANVAS_HISTORY_LIMIT).toBe(50)
  })

  it('strips runtime image references from history snapshots while preserving item data', () => {
    const image = {} as HTMLImageElement
    const sourceFile = new Blob(['history-source'], { type: 'image/png' })
    const imageItem = createImageItem('image-1', 'blob:one', image, { sourceFile })
    const sourceItems = [imageItem, createTextItem('text-1', 'Note')]

    const snapshot = createCanvasHistorySnapshot(sourceItems)

    expect(snapshot).toEqual([
      expect.objectContaining({
        id: 'image-1',
        type: 'image',
        src: 'blob:one'
      }),
      sourceItems[1]
    ])
    expect(snapshot[0]).not.toHaveProperty('image')
    expect(snapshot[0]).not.toHaveProperty('sourceFile')
    expect(imageItem.image).toBe(image)
    expect(imageItem.sourceFile).toBe(sourceFile)
  })

  it('strips runtime 3D render deferral flags from history snapshots', () => {
    const modelItem = createModelItem('model-1', 'split-part.fbx', { deferRender: true })

    const snapshot = createCanvasHistorySnapshot([modelItem])

    expect(snapshot).toEqual([
      expect.objectContaining({
        id: 'model-1',
        type: 'model3d',
        fileName: 'split-part.fbx'
      })
    ])
    expect(snapshot[0]).not.toHaveProperty('deferRender')
    expect(modelItem.deferRender).toBe(true)
  })

  it('restores runtime image references by matching item id first', () => {
    const sharedImage = {} as HTMLImageElement
    const snapshot = [createImageItem('image-1', 'blob:one')]
    const referenceItems = [createImageItem('image-1', 'blob:two', sharedImage)]

    const restored = restoreCanvasHistorySnapshot(snapshot, referenceItems)

    expect(restored[0]).toMatchObject({
      id: 'image-1',
      src: 'blob:one',
      image: sharedImage
    })
  })

  it('falls back to matching by src when restoring runtime image references', () => {
    const sharedImage = {} as HTMLImageElement
    const snapshot = [createImageItem('image-2', 'blob:shared')]
    const referenceItems = [createImageItem('image-1', 'blob:shared', sharedImage)]

    const restored = restoreCanvasHistorySnapshot(snapshot, referenceItems)

    expect(restored[0]).toMatchObject({
      id: 'image-2',
      src: 'blob:shared',
      image: sharedImage
    })
  })
})
