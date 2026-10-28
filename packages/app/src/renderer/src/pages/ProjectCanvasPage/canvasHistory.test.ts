import { describe, expect, it } from 'vitest'
import {
  CANVAS_HISTORY_LIMIT,
  createCanvasHistorySnapshot,
  restoreCanvasHistorySnapshot
} from './canvasHistory'
import { buildCanvasSessionSourceIdentity } from './canvasThumbnailCache'
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

  it('prefers the same item runtime image only when its source also matches', () => {
    const sharedImage = {} as HTMLImageElement
    const snapshot = [createImageItem('image-1', 'blob:one')]
    const referenceItems = [
      createImageItem('image-2', 'blob:one', {} as HTMLImageElement),
      createImageItem('image-1', 'blob:one', sharedImage)
    ]

    const restored = restoreCanvasHistorySnapshot(snapshot, referenceItems)

    expect(restored[0]).toMatchObject({
      id: 'image-1',
      src: 'blob:one',
      image: sharedImage
    })
    expect((restored[0] as CanvasImageItem).image).toBe(sharedImage)
  })

  it('does not attach decoded pixels from a different source with the same item id', () => {
    const blueImage = Object.assign(document.createElement('img'), {
      src: 'blob:blue',
      rgba: new Uint8ClampedArray([0, 0, 255, 255])
    })
    const snapshot = [createImageItem('image-1', 'blob:red')]
    const referenceItems = [createImageItem('image-1', 'blob:blue', blueImage)]

    const restored = restoreCanvasHistorySnapshot(snapshot, referenceItems)

    expect(restored[0]).toBe(snapshot[0])
    expect((restored[0] as CanvasImageItem).image).toBeUndefined()
    expect(blueImage.rgba).toEqual(new Uint8ClampedArray([0, 0, 255, 255]))
  })

  it('uses another matching source instead of an unrelated image with the same item id', () => {
    const redImage = Object.assign(document.createElement('img'), {
      src: 'blob:red',
      rgba: new Uint8ClampedArray([255, 0, 0, 255])
    })
    const blueImage = Object.assign(document.createElement('img'), {
      src: 'blob:blue',
      rgba: new Uint8ClampedArray([0, 0, 255, 255])
    })
    const restored = restoreCanvasHistorySnapshot(
      [createImageItem('image-1', 'blob:red')],
      [
        createImageItem('image-1', 'blob:blue', blueImage),
        createImageItem('image-2', 'blob:red', redImage)
      ]
    )

    const image = (restored[0] as CanvasImageItem).image as typeof redImage
    expect(image).toBe(redImage)
    expect(image.rgba).toEqual(new Uint8ClampedArray([255, 0, 0, 255]))
  })

  it.each(['image-1', 'different-item'])('does not reuse an old source revision from %s', (id) => {
    const previousIdentity = buildCanvasSessionSourceIdentity({ sourceKey: 'before', sizeBytes: 4 })
    const nextIdentity = buildCanvasSessionSourceIdentity({ sourceKey: 'after', sizeBytes: 4 })
    const snapshot = [
      createImageItem('image-1', 'blob:shared', undefined, { sourceIdentity: previousIdentity })
    ]
    const referenceItems = [
      createImageItem(id, 'blob:shared', {} as HTMLImageElement, { sourceIdentity: nextIdentity })
    ]

    const restored = restoreCanvasHistorySnapshot(snapshot, referenceItems)

    expect(restored[0]).toBe(snapshot[0])
    expect((restored[0] as CanvasImageItem).image).toBeUndefined()
  })

  it.each([true, false])(
    'does not mix known and missing source identities: %s',
    (snapshotHasIdentity) => {
      const sourceIdentity = buildCanvasSessionSourceIdentity({ sourceKey: 'known', sizeBytes: 4 })
      const snapshot = [
        createImageItem('image-1', 'blob:shared', undefined, {
          sourceIdentity: snapshotHasIdentity ? sourceIdentity : undefined
        })
      ]
      const referenceItems = [
        createImageItem('image-1', 'blob:shared', {} as HTMLImageElement, {
          sourceIdentity: snapshotHasIdentity ? undefined : sourceIdentity
        })
      ]

      const restored = restoreCanvasHistorySnapshot(snapshot, referenceItems)

      expect((restored[0] as CanvasImageItem).image).toBeUndefined()
    }
  )

  it('reuses equivalent source identities across different item ids without mutating snapshots', () => {
    const sourceIdentity = buildCanvasSessionSourceIdentity({ sourceKey: 'known', sizeBytes: 4 })
    const sharedImage = document.createElement('img')
    const snapshot = [
      createImageItem('image-2', 'blob:shared', undefined, {
        sourceIdentity: { ...sourceIdentity }
      })
    ]
    const referenceItems = [
      createImageItem('image-1', 'blob:shared', sharedImage, { sourceIdentity })
    ]

    const restored = restoreCanvasHistorySnapshot(snapshot, referenceItems)

    expect((restored[0] as CanvasImageItem).image).toBe(sharedImage)
    expect(snapshot[0].image).toBeUndefined()
  })

  it('keeps separate matching revisions when two reference images have the same source URL', () => {
    const firstIdentity = buildCanvasSessionSourceIdentity({ sourceKey: 'first', sizeBytes: 4 })
    const secondIdentity = buildCanvasSessionSourceIdentity({ sourceKey: 'second', sizeBytes: 4 })
    const secondImage = document.createElement('img')
    const restored = restoreCanvasHistorySnapshot(
      [createImageItem('restored', 'blob:shared', undefined, { sourceIdentity: secondIdentity })],
      [
        createImageItem('first', 'blob:shared', document.createElement('img'), {
          sourceIdentity: firstIdentity
        }),
        createImageItem('second', 'blob:shared', secondImage, { sourceIdentity: secondIdentity })
      ]
    )

    expect((restored[0] as CanvasImageItem).image).toBe(secondImage)
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
