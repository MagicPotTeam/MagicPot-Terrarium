import { describe, expect, it } from 'vitest'

import {
  applyCanvasLayerDragCommit,
  applyMultiDragDeltaToItem,
  resolveCanvasExternalDropPoint
} from './useCanvasLayerRuntime'
import type { CanvasAnnotationItem, CanvasHtmlItem } from './types'

function createArrowAnnotation(
  overrides: Partial<CanvasAnnotationItem> = {}
): CanvasAnnotationItem {
  return {
    id: 'arrow-1',
    type: 'annotation',
    shape: 'arrow',
    stroke: '#fff',
    fillOpacity: 0,
    strokeWidth: 2,
    label: '',
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    endX: 120,
    endY: 60,
    ...overrides
  }
}

function createFreeDrawAnnotation(
  overrides: Partial<CanvasAnnotationItem> = {}
): CanvasAnnotationItem {
  return {
    id: 'freedraw-1',
    type: 'annotation',
    shape: 'freedraw',
    stroke: '#fff',
    fillOpacity: 0,
    strokeWidth: 2,
    label: '',
    x: 5,
    y: 6,
    width: 20,
    height: 30,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    points: [5, 6, 25, 36],
    ...overrides
  }
}

function createHtmlItem(overrides: Partial<CanvasHtmlItem> = {}): CanvasHtmlItem {
  return {
    id: 'html-1',
    type: 'html',
    htmlData: '<p>Hello</p>',
    x: 30,
    y: 40,
    width: 240,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

describe('applyMultiDragDeltaToItem', () => {
  it('moves arrow endpoints along with the item', () => {
    expect(
      applyMultiDragDeltaToItem(createArrowAnnotation(), {
        dx: 15,
        dy: -5
      })
    ).toEqual(
      expect.objectContaining({
        x: 25,
        y: 15,
        endX: 135,
        endY: 55
      })
    )
  })

  it('moves free-draw points along with the item', () => {
    expect(
      applyMultiDragDeltaToItem(createFreeDrawAnnotation(), {
        dx: 12,
        dy: 8
      })
    ).toEqual(
      expect.objectContaining({
        x: 17,
        y: 14,
        points: [17, 14, 37, 44]
      })
    )
  })

  it('moves regular nodes without adding shape-specific fields', () => {
    expect(
      applyMultiDragDeltaToItem(createHtmlItem(), {
        dx: -10,
        dy: 18
      })
    ).toEqual(
      expect.objectContaining({
        x: 20,
        y: 58,
        htmlData: '<p>Hello</p>'
      })
    )
  })
})

describe('applyCanvasLayerDragCommit', () => {
  it('moves every selected item by the dragged delta during a multi-selection drag', () => {
    const primary = createHtmlItem({ id: 'html-1', x: 30, y: 40 })
    const secondary = createArrowAnnotation({ id: 'arrow-1', x: 80, y: 90, endX: 140, endY: 130 })
    const untouched = createHtmlItem({ id: 'html-2', x: 300, y: 200 })

    expect(
      applyCanvasLayerDragCommit({
        previousItems: [primary, secondary, untouched],
        draggedId: primary.id,
        nextX: 54,
        nextY: 58,
        selectedIds: new Set([primary.id, secondary.id])
      })
    ).toEqual([
      expect.objectContaining({ id: 'html-1', x: 54, y: 58 }),
      expect.objectContaining({ id: 'arrow-1', x: 104, y: 108, endX: 164, endY: 148 }),
      expect.objectContaining({ id: 'html-2', x: 300, y: 200 })
    ])
  })

  it('only moves the dragged item when the selection is singular', () => {
    const primary = createHtmlItem({ id: 'html-1', x: 30, y: 40 })
    const secondary = createHtmlItem({ id: 'html-2', x: 300, y: 200 })

    expect(
      applyCanvasLayerDragCommit({
        previousItems: [primary, secondary],
        draggedId: primary.id,
        nextX: 50,
        nextY: 65,
        selectedIds: new Set([primary.id])
      })
    ).toEqual([
      expect.objectContaining({ id: 'html-1', x: 50, y: 65 }),
      expect.objectContaining({ id: 'html-2', x: 300, y: 200 })
    ])
  })
})

describe('resolveCanvasExternalDropPoint', () => {
  it('prefers the event coordinates when drag end still carries them', () => {
    expect(
      resolveCanvasExternalDropPoint({
        canvasRect: null,
        event: {
          clientX: 320,
          clientY: 180
        },
        lastViewportPoint: { x: 700, y: 700 }
      })
    ).toEqual({
      x: 320,
      y: 180
    })
  })

  it('falls back to the last viewport point only when it is outside the canvas', () => {
    expect(
      resolveCanvasExternalDropPoint({
        canvasRect: {
          left: 100,
          top: 100,
          right: 500,
          bottom: 400
        } as DOMRect,
        event: undefined,
        lastViewportPoint: { x: 640, y: 520 }
      })
    ).toEqual({
      x: 640,
      y: 520
    })
  })

  it('returns null when neither event nor out-of-canvas fallback point is available', () => {
    expect(
      resolveCanvasExternalDropPoint({
        canvasRect: {
          left: 100,
          top: 100,
          right: 500,
          bottom: 400
        } as DOMRect,
        event: undefined,
        lastViewportPoint: { x: 240, y: 220 }
      })
    ).toBeNull()
  })
})
