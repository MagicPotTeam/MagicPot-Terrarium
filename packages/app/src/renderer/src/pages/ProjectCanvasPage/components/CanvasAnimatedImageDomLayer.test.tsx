import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import CanvasAnimatedImageDomLayer from './CanvasAnimatedImageDomLayer'
import type { CanvasImageItem } from '../types'

function createItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: 200 })
  Object.defineProperty(image, 'naturalHeight', { value: 120 })

  return {
    id: 'animated-image',
    type: 'image',
    src: 'file:///animated-image.gif',
    fileName: 'animated-image.gif',
    x: 100,
    y: 140,
    width: 200,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    image,
    sourceWidth: 200,
    sourceHeight: 120,
    ...overrides
  }
}

describe('CanvasAnimatedImageDomLayer', () => {
  it('renders supplied GIF sources as persistent DOM images', () => {
    const registerViewportLayer = vi.fn()
    const gifItem = createItem()

    render(
      <CanvasAnimatedImageDomLayer
        items={[gifItem]}
        stageScale={1}
        registerViewportLayer={registerViewportLayer}
      />
    )

    const layer = document.querySelector('[data-project-canvas-animated-image-layer="dom"]')
    const gifImage = layer?.querySelector('img[data-canvas-source-image-preview="true"]')
    expect(layer).not.toBeNull()
    expect(gifImage?.getAttribute('src')).toBe('file:///animated-image.gif')
  })

  it('follows live canvas transform sync while an image is dragged or resized', () => {
    const item = createItem()
    render(
      <CanvasAnimatedImageDomLayer
        items={[item]}
        stageScale={1}
        registerViewportLayer={() => undefined}
      />
    )

    const animatedItem = document.querySelector(
      '[data-project-canvas-animated-image-item-id="animated-image"]'
    ) as HTMLElement
    expect(animatedItem.style.transform).toContain('translate3d(100px, 140px, 0)')

    act(() => {
      window.dispatchEvent(
        new CustomEvent(`canvas-sync-${item.id}`, {
          detail: { x: 320, y: 180, rotation: 15, scaleX: 1.5, scaleY: 0.75 }
        })
      )
    })

    expect(animatedItem.style.transform).toBe(
      'translate3d(320px, 180px, 0) rotate(15deg) scale(1.5, 0.75)'
    )
  })
})
