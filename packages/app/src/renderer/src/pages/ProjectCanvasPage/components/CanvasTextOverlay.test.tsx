import React from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import CanvasTextOverlay from './CanvasTextOverlay'
import type { CanvasTextItem } from '../types'

function createTextItem(): CanvasTextItem {
  return {
    id: 'text-1',
    type: 'text',
    text: 'Preview text',
    x: 100,
    y: 140,
    width: 220,
    height: 96,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    fill: '#ffffff',
    fontSize: 18,
    fontFamily: 'Arial',
    fontWeight: 'normal'
  }
}

describe('CanvasTextOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('applies canvas sync previews and resets back to committed transform', () => {
    const item = createTextItem()
    const { container, rerender } = render(
      <CanvasTextOverlay item={item} isSelected={false} showSelectionOutline={false} />
    )

    const overlay = container.querySelector('[data-canvas-overlay="text"]') as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(overlay).toHaveStyle({
      transform: 'translate3d(100px, 140px, 0) rotate(0deg) scale(1, 1)'
    })

    act(() => {
      window.dispatchEvent(
        new CustomEvent(`canvas-sync-${item.id}`, {
          detail: {
            x: 160,
            y: 210,
            rotation: 12,
            scaleX: 1,
            scaleY: 1
          }
        })
      )
    })

    expect(overlay).toHaveStyle({
      transform: 'translate3d(160px, 210px, 0) rotate(12deg) scale(1, 1)'
    })

    rerender(<CanvasTextOverlay item={item} isSelected={true} showSelectionOutline={true} />)

    expect(overlay).toHaveStyle({
      transform: 'translate3d(160px, 210px, 0) rotate(12deg) scale(1, 1)'
    })

    act(() => {
      window.dispatchEvent(new CustomEvent(`canvas-reset-${item.id}`))
    })

    expect(overlay).toHaveStyle({
      transform: 'translate3d(100px, 140px, 0) rotate(0deg) scale(1, 1)'
    })
  })
})
