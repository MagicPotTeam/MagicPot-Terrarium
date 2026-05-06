import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProjectCanvasImageCropOverlay from './ProjectCanvasImageCropOverlay'
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
