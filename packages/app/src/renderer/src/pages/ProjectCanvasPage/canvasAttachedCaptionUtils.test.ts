import { describe, expect, it } from 'vitest'
import type { CanvasAnnotationItem, CanvasImageItem, CanvasItem } from './types'
import {
  collectCascadeDeletedCanvasItemIds,
  pruneOrphanAttachedCaptions,
  resolveCanvasItemAttachmentScale,
  removeCanvasItemsWithAttachedCaptions,
  resolveAttachedCaptionDraftLayout,
  resolveAttachedCaptionScaleBasis
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

  it('sizes new attached captions from the current parent bounds', () => {
    const layout = resolveAttachedCaptionDraftLayout({
      x: 100,
      y: 40,
      width: 2048,
      height: 2048
    })

    expect(layout).toEqual({
      x: 100,
      y: 2100,
      width: 2048,
      height: 193,
      fontSize: 113
    })
  })

  it('keeps the previous minimum size for small parent bounds', () => {
    const layout = resolveAttachedCaptionDraftLayout({
      x: 100,
      y: 40,
      width: 80,
      height: 80
    })

    expect(layout).toEqual({
      x: 60,
      y: 132,
      width: 160,
      height: 48,
      fontSize: 28
    })
  })

  it('scales attached caption text from the stored parent scale basis', () => {
    const layout = resolveAttachedCaptionDraftLayout(
      {
        x: 24,
        y: 36,
        width: 960,
        height: 540
      },
      {
        parentScale: 6,
        baseScale: 1,
        baseFontSize: 28,
        baseHeight: 48
      }
    )

    expect(layout).toEqual({
      x: 24,
      y: 588,
      width: 960,
      height: 288,
      fontSize: 168
    })
  })

  it('uses the first observed small scale as the basis for legacy captions', () => {
    const parentScale = resolveCanvasItemAttachmentScale(
      createImageItem({ scaleX: 0.25, scaleY: 0.25 })
    )

    expect(resolveAttachedCaptionScaleBasis(parentScale, { fontSize: 28, height: 48 })).toEqual({
      baseScale: 0.25,
      baseFontSize: 28,
      baseHeight: 48
    })
  })
})
