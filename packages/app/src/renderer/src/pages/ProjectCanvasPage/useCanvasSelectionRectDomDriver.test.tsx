import { createRef } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasSelectionRectDomDriver } from './useCanvasSelectionRectDomDriver'

function createSelectionRectDom() {
  const container = document.createElement('div')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  svg.dataset.canvasSelectionRect = 'svg'
  rect.dataset.canvasSelectionRect = 'rect'
  svg.appendChild(rect)
  container.appendChild(svg)
  document.body.appendChild(container)
  return { container, svg, rect }
}

describe('useCanvasSelectionRectDomDriver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafId += 1
      const id = rafId
      setTimeout(() => callback(performance.now()), 16)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
    delete (window as Window & { __canvasSelectionRectDomTrace?: unknown })
      .__canvasSelectionRectDomTrace
  })

  it('applies and clears selection rect styles using registered elements', () => {
    const { container, svg, rect } = createSelectionRectDom()
    const ref = createRef<HTMLElement>()
    ref.current = container
    const { result } = renderHook(() =>
      useCanvasSelectionRectDomDriver({ canvasContainerRef: ref })
    )

    act(() => {
      result.current.handleSelectionRectElementsChange({ svg, rect })
      result.current.handleSelectionRectChange({ x: 10, y: 20, w: 120, h: 80 })
    })

    expect(svg.style.display).toBe('')
    expect(svg.style.left).toBe('10px')
    expect(svg.style.top).toBe('20px')
    expect(svg.getAttribute('width')).toBe('120')
    expect(rect.getAttribute('height')).toBe('80')

    act(() => {
      result.current.handleSelectionRectChange(null)
    })
    expect(svg.style.display).toBe('none')
  })

  it('falls back to querying the canvas container when registered elements are unavailable', () => {
    const { container, svg, rect } = createSelectionRectDom()
    const ref = createRef<HTMLElement>()
    ref.current = container
    const { result } = renderHook(() =>
      useCanvasSelectionRectDomDriver({ canvasContainerRef: ref })
    )

    act(() => {
      result.current.handleSelectionRectChange({ x: 1, y: 2, w: 30, h: 40 })
    })

    expect(svg.style.left).toBe('1px')
    expect(rect.getAttribute('width')).toBe('30')
  })

  it('records debug trace entries and caps them at 80', () => {
    const { container } = createSelectionRectDom()
    const ref = createRef<HTMLElement>()
    ref.current = container
    const { result } = renderHook(() =>
      useCanvasSelectionRectDomDriver({ canvasContainerRef: ref, isDebugEnabled: () => true })
    )

    act(() => {
      for (let index = 0; index < 85; index += 1) {
        result.current.handleSelectionRectChange({ x: index, y: 0, w: 10 + index, h: 20 })
      }
    })

    const trace = (
      window as Window & {
        __canvasSelectionRectDomTrace?: Array<Record<string, unknown>>
      }
    ).__canvasSelectionRectDomTrace
    expect(trace).toHaveLength(80)
    expect(trace?.[0]).toMatchObject({ phase: 'apply', width: 15 })
    expect(trace?.[79]).toMatchObject({ phase: 'apply', width: 94 })
  })

  it('suppresses selection chrome until two animation frames after marquee ends', () => {
    const { container } = createSelectionRectDom()
    const ref = createRef<HTMLElement>()
    ref.current = container
    const { result } = renderHook(() =>
      useCanvasSelectionRectDomDriver({ canvasContainerRef: ref })
    )

    act(() => {
      result.current.handleSelectionMarqueeActiveChange(true)
    })
    expect(container.getAttribute('data-project-canvas-marquee-active')).toBe('true')
    expect(result.current.suppressSelectionChromeAfterMarquee).toBe(false)

    act(() => {
      result.current.handleSelectionMarqueeActiveChange(false)
    })
    expect(container.hasAttribute('data-project-canvas-marquee-active')).toBe(false)
    expect(result.current.suppressSelectionChromeAfterMarquee).toBe(true)

    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(result.current.suppressSelectionChromeAfterMarquee).toBe(true)

    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(result.current.suppressSelectionChromeAfterMarquee).toBe(false)
  })

  it('cancels a pending settle frame when marquee restarts', () => {
    const { container } = createSelectionRectDom()
    const ref = createRef<HTMLElement>()
    ref.current = container
    const { result } = renderHook(() =>
      useCanvasSelectionRectDomDriver({ canvasContainerRef: ref })
    )

    act(() => {
      result.current.handleSelectionMarqueeActiveChange(false)
      result.current.handleSelectionMarqueeActiveChange(true)
    })

    expect(window.cancelAnimationFrame).toHaveBeenCalled()
    expect(result.current.suppressSelectionChromeAfterMarquee).toBe(false)
  })
})
