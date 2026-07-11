import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createCanvasDomOverlayLookupCache,
  findCanvasItemOverlayElement,
  findCanvasSelectionToolbar
} from './canvasDomOverlayLookup'

function createElement(attributes: Record<string, string>) {
  const element = document.createElement('div')
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value)
  }
  return element
}

describe('canvasDomOverlayLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('caches preferred overlay selector lookups while preserving duplicate id preference', () => {
    const container = document.createElement('div')
    const staleElement = createElement({ 'data-canvas-item-id': 'image-1' })
    const preferredImageOverlay = createElement({
      'data-canvas-item-id': 'image-1',
      'data-canvas-overlay': 'image-interaction'
    })
    container.append(staleElement, preferredImageOverlay)
    document.body.appendChild(container)

    const querySelectorAll = vi.spyOn(container, 'querySelectorAll')
    const cache = createCanvasDomOverlayLookupCache()

    expect(findCanvasItemOverlayElement(container, { id: 'image-1', type: 'image' }, cache)).toBe(
      preferredImageOverlay
    )
    expect(findCanvasItemOverlayElement(container, { id: 'image-1', type: 'image' }, cache)).toBe(
      preferredImageOverlay
    )

    expect(
      querySelectorAll.mock.calls.filter(
        ([selector]) => selector === '[data-canvas-overlay="image-interaction"]'
      )
    ).toHaveLength(1)
    expect(
      querySelectorAll.mock.calls.some(([selector]) => selector === '[data-canvas-item-id]')
    ).toBe(false)
  })

  it('caches generic fallback item lookups when no preferred overlay exists', () => {
    const container = document.createElement('div')
    const genericElement = createElement({ 'data-canvas-item-id': 'model-1' })
    container.appendChild(genericElement)
    document.body.appendChild(container)

    const querySelectorAll = vi.spyOn(container, 'querySelectorAll')
    const cache = createCanvasDomOverlayLookupCache()

    expect(findCanvasItemOverlayElement(container, { id: 'model-1', type: 'model3d' }, cache)).toBe(
      genericElement
    )
    expect(findCanvasItemOverlayElement(container, { id: 'model-1', type: 'model3d' }, cache)).toBe(
      genericElement
    )

    expect(
      querySelectorAll.mock.calls.filter(
        ([selector]) => selector === '[data-canvas-overlay="model3d"]'
      )
    ).toHaveLength(1)
    expect(
      querySelectorAll.mock.calls.filter(([selector]) => selector === '[data-canvas-item-id]')
    ).toHaveLength(1)
  })

  it('caches toolbar candidates while preserving owner preference', () => {
    const container = document.createElement('div')
    const fallbackToolbar = createElement({ class: 'selection-toolbar' })
    const ownedToolbar = createElement({
      class: 'selection-toolbar',
      'data-selection-toolbar-owner-id': 'item-2'
    })
    container.append(fallbackToolbar, ownedToolbar)
    document.body.appendChild(container)

    const querySelectorAll = vi.spyOn(container, 'querySelectorAll')
    const cache = createCanvasDomOverlayLookupCache()

    expect(findCanvasSelectionToolbar(container, '.selection-toolbar', 'item-2', cache)).toBe(
      ownedToolbar
    )
    expect(findCanvasSelectionToolbar(container, '.selection-toolbar', 'item-2', cache)).toBe(
      ownedToolbar
    )
    expect(findCanvasSelectionToolbar(container, '.selection-toolbar', 'missing', cache)).toBe(
      fallbackToolbar
    )

    expect(
      querySelectorAll.mock.calls.filter(([selector]) => selector === '.selection-toolbar')
    ).toHaveLength(1)
  })
})
