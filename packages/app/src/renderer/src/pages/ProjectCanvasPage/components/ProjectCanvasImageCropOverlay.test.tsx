import React from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProjectCanvasImageCropOverlay, {
  type ProjectCanvasImageCropOverlayHandle
} from './ProjectCanvasImageCropOverlay'
import { resolveResizedCropBox } from './projectCanvasImageCropUtils'
import type { CanvasImageItem } from '../types'

function createImage(width: number, height: number) {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: width })
  Object.defineProperty(image, 'naturalHeight', { value: height })
  return image
}

function createItem(): CanvasImageItem {
  return {
    id: 'crop-image',
    type: 'image',
    src: 'file:///crop-image.png',
    fileName: 'crop-image.png',
    x: 120,
    y: 160,
    width: 240,
    height: 160,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    image: createImage(240, 160)
  }
}

describe('ProjectCanvasImageCropOverlay', () => {
  it('keeps the box steady when a resize starts from inside the enlarged bottom-center hit area', () => {
    const startBox = { x: 20, y: 16, width: 48, height: 24 }
    const startPoint = { x: 44, y: 46 }

    const nextBox = resolveResizedCropBox({
      handle: 'bottom-center',
      pointer: startPoint,
      startPoint,
      startBox,
      boundsWidth: 240,
      boundsHeight: 160
    })

    expect(nextBox).toEqual(startBox)
  })

  it('resizes the bottom-center handle by pointer delta instead of snapping to the pointer position', () => {
    const startBox = { x: 20, y: 16, width: 48, height: 24 }
    const startPoint = { x: 44, y: 46 }

    const nextBox = resolveResizedCropBox({
      handle: 'bottom-center',
      pointer: { x: 44, y: 58 },
      startPoint,
      startBox,
      boundsWidth: 240,
      boundsHeight: 160
    })

    expect(nextBox).toEqual({
      x: 20,
      y: 16,
      width: 48,
      height: 36
    })
  })

  it('registers its stage viewport host with the viewport driver when provided', () => {
    const registerViewportLayer = vi.fn()

    const { container } = render(
      <ProjectCanvasImageCropOverlay
        item={createItem()}
        stagePos={{ x: 24, y: 36 }}
        stageScale={1.5}
        registerViewportLayer={registerViewportLayer}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(container.querySelector('[data-project-canvas-crop-overlay="dom"]')).not.toBeNull()
    expect(registerViewportLayer.mock.calls.some(([arg]) => arg instanceof HTMLElement)).toBe(true)
  })

  it('falls back to inline stage transforms when no viewport driver is provided', () => {
    const { container } = render(
      <ProjectCanvasImageCropOverlay
        item={createItem()}
        stagePos={{ x: 24, y: 36 }}
        stageScale={1.5}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    const stageLayer = container.querySelector(
      '[data-project-canvas-crop-overlay="dom"] > div'
    ) as HTMLDivElement | null

    expect(stageLayer).not.toBeNull()
    expect(stageLayer?.style.left).toBe('24px')
    expect(stageLayer?.style.top).toBe('36px')
    expect(stageLayer?.style.transform).toBe('scale(1.5)')
  })
})

// Crop confirm on the page stores the overlay's updates as they are (it keeps the
// original picture and records the crop), so the overlay alone decides the frame of
// a cropped image. These drive the real overlay with pointer events and pin that
// contract: the frame (width / height) is the crop size in source pixels, and the
// scale and position compensate so the kept pixels stay where they were drawn.
describe('ProjectCanvasImageCropOverlay confirmed frame', () => {
  class TestPointerEvent extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function confirmAfterHandleDrag(
    item: CanvasImageItem,
    handleName: string,
    from: { x: number; y: number },
    to: { x: number; y: number }
  ) {
    vi.stubGlobal('PointerEvent', TestPointerEvent)
    const ref = React.createRef<ProjectCanvasImageCropOverlayHandle>()
    const onConfirm = vi.fn()
    const view = render(
      <ProjectCanvasImageCropOverlay
        ref={ref}
        item={item}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )
    const handle = view.container.querySelector(`[data-canvas-crop-handle="${handleName}"]`)
    expect(handle).not.toBeNull()
    act(() => {
      fireEvent.pointerDown(handle!, { pointerId: 3, button: 0, clientX: from.x, clientY: from.y })
      fireEvent.pointerMove(window, { pointerId: 3, clientX: to.x, clientY: to.y })
      fireEvent.pointerUp(window, { pointerId: 3, clientX: to.x, clientY: to.y })
      ref.current!.confirm()
    })
    expect(onConfirm).toHaveBeenCalledOnce()
    view.unmount()
    return onConfirm.mock.calls[0][0] as Required<
      Pick<CanvasImageItem, 'x' | 'y' | 'width' | 'height' | 'scaleX' | 'scaleY' | 'crop'>
    >
  }

  it('reports a frame equal to the crop size, drawn at the size of the crop box', () => {
    // A 200 x 200 picture drawn at 100 x 100 (frame 100 x 100, scale 1).
    const item: CanvasImageItem = {
      id: 'first-crop',
      type: 'image',
      src: 'file:///first-crop.png',
      image: createImage(200, 200),
      sourceWidth: 200,
      sourceHeight: 200,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 0,
      locked: false
    }

    // Bottom-right corner from (100,100) to (50,75) on screen: keep the left half
    // and the top three quarters.
    const updates = confirmAfterHandleDrag(
      item,
      'bottom-right',
      { x: 100, y: 100 },
      { x: 50, y: 75 }
    )

    expect(updates.crop).toEqual({ x: 0, y: 0, width: 100, height: 150 })
    expect(updates.width).toBe(updates.crop.width)
    expect(updates.height).toBe(updates.crop.height)
    // Not the old frame stretched over the smaller region: drawn 50 x 75.
    expect(updates.width * updates.scaleX).toBeCloseTo(50, 6)
    expect(updates.height * updates.scaleY).toBeCloseTo(75, 6)
    expect(updates.x).toBeCloseTo(0, 6)
    expect(updates.y).toBeCloseTo(0, 6)
  })

  it('keeps the frame on the crop and the kept pixels in place when an existing crop is cropped again', () => {
    // A 400 x 200 picture already cropped to its middle 200 x 100, drawn at half
    // size: 100 x 50 on screen with its top-left corner at (40,60).
    const item: CanvasImageItem = {
      id: 'second-crop',
      type: 'image',
      src: 'file:///second-crop.png',
      image: createImage(400, 200),
      sourceWidth: 400,
      sourceHeight: 200,
      crop: { x: 100, y: 50, width: 200, height: 100 },
      x: 40,
      y: 60,
      width: 200,
      height: 100,
      rotation: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      zIndex: 0,
      locked: false
    }

    // Top-left corner from (40,60) to (60,70) on screen: 40 x 20 source pixels in.
    const updates = confirmAfterHandleDrag(item, 'top-left', { x: 40, y: 60 }, { x: 60, y: 70 })

    expect(updates.crop).toEqual({ x: 140, y: 70, width: 160, height: 80 })
    expect(updates.width).toBe(updates.crop.width)
    expect(updates.height).toBe(updates.crop.height)
    expect(updates.scaleX).toBeCloseTo(0.5, 6)
    expect(updates.scaleY).toBeCloseTo(0.5, 6)
    // The item moves with the corner, so the untouched bottom-right corner stays
    // at (140,110) on screen.
    expect(updates.x).toBeCloseTo(60, 6)
    expect(updates.y).toBeCloseTo(70, 6)
    expect(updates.x + updates.width * updates.scaleX).toBeCloseTo(140, 6)
    expect(updates.y + updates.height * updates.scaleY).toBeCloseTo(110, 6)
  })
})
