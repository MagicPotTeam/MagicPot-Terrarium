import { describe, expect, it } from 'vitest'
import type { CanvasAnnotationItem, CanvasImageItem, CanvasItem } from './types'
import {
  collectCascadeDeletedCanvasItemIds,
  pruneOrphanAttachedCaptions,
  removeCanvasItemsWithAttachedCaptions
} from './canvasAttachedCaptionUtils'

function createImageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'blob:image-1',
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

function createAnnotationItem(
  overrides: Partial<CanvasAnnotationItem> & {
    attachedToId?: string
    attachmentPlacement?: 'bottom-center'
  } = {}
): CanvasAnnotationItem {
  return {
    id: 'annotation-1',
    type: 'annotation',
    shape: 'text-anno',
    stroke: '#ffffff',
    fillOpacity: 0,
    strokeWidth: 1,
    label: '',
    text: '标注',
    fontSize: 24,
    x: 0,
    y: 0,
    width: 120,
    height: 32,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  } as CanvasAnnotationItem
}

describe('canvasAttachedCaptionUtils', () => {
  it('cascades parent deletion to attached captions', () => {
    const items: CanvasItem[] = [
      createImageItem({ id: 'image-1' }),
      createAnnotationItem({
        id: 'caption-1',
        attachedToId: 'image-1',
        attachmentPlacement: 'bottom-center'
      }),
      createAnnotationItem({ id: 'caption-2', attachedToId: 'other-image' })
    ]

    const deletedIds = collectCascadeDeletedCanvasItemIds(items, ['image-1'])

    expect([...deletedIds]).toEqual(['image-1', 'caption-1'])
  })

  it('removes attached captions alongside the deleted parent item', () => {
    const items: CanvasItem[] = [
      createImageItem({ id: 'image-1' }),
      createAnnotationItem({
        id: 'caption-1',
        attachedToId: 'image-1',
        attachmentPlacement: 'bottom-center'
      }),
      createAnnotationItem({ id: 'loose-anno', shape: 'rect' })
    ]

    const { nextItems } = removeCanvasItemsWithAttachedCaptions(items, ['image-1'])

    expect(nextItems.map((item) => item.id)).toEqual(['loose-anno'])
  })

  it('prunes orphan attached captions but keeps normal annotations', () => {
    const items: CanvasItem[] = [
      createImageItem({ id: 'image-1' }),
      createAnnotationItem({
        id: 'caption-1',
        attachedToId: 'image-1',
        attachmentPlacement: 'bottom-center'
      }),
      createAnnotationItem({
        id: 'caption-2',
        attachedToId: 'missing-image',
        attachmentPlacement: 'bottom-center'
      }),
      createAnnotationItem({ id: 'free-anno', shape: 'rect' })
    ]

    const nextItems = pruneOrphanAttachedCaptions(items)

    expect(nextItems.map((item) => item.id)).toEqual(['image-1', 'caption-1', 'free-anno'])
  })
})
