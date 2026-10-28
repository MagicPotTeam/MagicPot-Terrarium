import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import CanvasHighResolutionImageDomLayer from './CanvasHighResolutionImageDomLayer'
import type { CanvasImageItem } from '../types'

function createItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: 8000 })
  Object.defineProperty(image, 'naturalHeight', { value: 6000 })

  return {
    id: 'high-res-image',
    type: 'image',
    src: 'file:///high-res-image.png',
    fileName: 'high-res-image.png',
    x: 100,
    y: 140,
    width: 800,
    height: 600,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    image,
    sourceWidth: 8000,
    sourceHeight: 6000,
    ...overrides
  }
}

describe('CanvasHighResolutionImageDomLayer', () => {
  it('follows live canvas transform sync while an image is dragged or resized', () => {
    const item = createItem()
    render(
      <CanvasHighResolutionImageDomLayer
        items={[item]}
        stageScale={1}
        registerViewportLayer={() => undefined}
      />
    )

    const highResItem = document.querySelector(
      '[data-project-canvas-high-res-image-item-id="high-res-image"]'
    ) as HTMLElement
    expect(highResItem.style.transform).toContain('translate3d(100px, 140px, 0)')

    act(() => {
      window.dispatchEvent(
        new CustomEvent(`canvas-sync-${item.id}`, {
          detail: { x: 320, y: 180, rotation: 15, scaleX: 1.5, scaleY: 0.75 }
        })
      )
    })

    expect(highResItem.style.transform).toBe(
      'translate3d(320px, 180px, 0) rotate(15deg) scale(1.5, 0.75)'
    )

    act(() => {
      window.dispatchEvent(new CustomEvent(`canvas-reset-${item.id}`))
    })
    expect(highResItem.style.transform).toBe(
      'translate3d(100px, 140px, 0) rotate(0deg) scale(1, 1)'
    )
  })
})
