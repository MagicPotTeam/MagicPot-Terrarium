import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProjectCanvasImageInteractionOverlay from './ProjectCanvasImageInteractionOverlay'
import {
  buildCanvasSelectionOutlineStyles,
  PROJECT_CANVAS_SELECTION_OUTLINE_WIDTH
} from './projectCanvasInteractionOverlayStyles'
import type { CanvasImageItem } from '../types'

function createItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    ...createItemBase(),
    ...overrides
  }
}

function createItemBase(): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image' as const,
    src: 'file:///image-1.png',
    x: 100,
    y: 140,
    width: 200,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createLoadedImage(width: number, height: number) {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: width })
  Object.defineProperty(image, 'naturalHeight', { value: height })
  return image
}

function mockCanvas2DContext() {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low'
  }
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = ((contextId: string) =>
    contextId === '2d'
      ? (context as unknown as CanvasRenderingContext2D)
      : null) as typeof HTMLCanvasElement.prototype.getContext

  return {
    context,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
  }
}

function mockCanvasRect(element: HTMLElement) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 10,
      top: 20,
      right: 1010,
      bottom: 620,
      width: 1000,
      height: 600,
      x: 10,
      y: 20,
      toJSON: () => ({})
    })
  })
}

function mockElementRect(
  element: HTMLElement,
  rect: {
    left: number
    top: number
    width: number
    height: number
  }
) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({})
    })
  })
}

describe('ProjectCanvasImageInteractionOverlay', () => {
  it('renders a thicker selection outline for selected images', () => {
    expect(PROJECT_CANVAS_SELECTION_OUTLINE_WIDTH).toBe(3)
    expect(buildCanvasSelectionOutlineStyles(true)).toEqual({
      outline: '3px solid rgba(99,102,241,0.92)',
      boxShadow: '0 0 0 3px rgba(99,102,241,0.36)'
    })
    expect(buildCanvasSelectionOutlineStyles(true, { scaleCompensation: 4 })).toEqual({
      outline: '12px solid rgba(99,102,241,0.92)',
      boxShadow: '0 0 0 12px rgba(99,102,241,0.36)'
    })
  })

  it('registers window pointer listeners only during active image interactions', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    try {
      render(
        <div data-testid="canvas-root" ref={canvasContainerRef}>
          <ProjectCanvasImageInteractionOverlay
            canvasContainerRef={canvasContainerRef}
            item={createItem({ id: 'image-1', x: 100 })}
            isSelected
            showTransformer={false}
            isDraggable
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            onSelect={vi.fn()}
            onDragEnd={vi.fn()}
            onTransformEnd={vi.fn()}
          />
          <ProjectCanvasImageInteractionOverlay
            canvasContainerRef={canvasContainerRef}
            item={createItem({ id: 'image-2', x: 340 })}
            isSelected={false}
            showTransformer={false}
            isDraggable
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            onSelect={vi.fn()}
            onDragEnd={vi.fn()}
            onTransformEnd={vi.fn()}
          />
        </div>
      )

      const root = screen.getByTestId('canvas-root')
      mockCanvasRect(root)
      const overlays = document.querySelectorAll('[data-canvas-overlay="image-interaction"]')
      expect(overlays).toHaveLength(2)
      expect(
        addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointermove')
      ).toHaveLength(0)

      fireEvent.pointerDown(overlays[0], { pointerId: 41, button: 0, clientX: 140, clientY: 170 })

      expect(
        addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointermove')
      ).toHaveLength(1)
      expect(addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointerup')).toHaveLength(
        1
      )
      expect(
        addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointercancel')
      ).toHaveLength(1)

      fireEvent.pointerUp(window, { pointerId: 41, clientX: 140, clientY: 170 })

      expect(
        removeEventListenerSpy.mock.calls.filter(([type]) => type === 'pointermove')
      ).toHaveLength(1)
      expect(
        removeEventListenerSpy.mock.calls.filter(([type]) => type === 'pointerup')
      ).toHaveLength(1)
      expect(
        removeEventListenerSpy.mock.calls.filter(([type]) => type === 'pointercancel')
      ).toHaveLength(1)
    } finally {
      addEventListenerSpy.mockRestore()
      removeEventListenerSpy.mockRestore()
    }
  })

  it('keeps the rotate hotspot outside the corner resize area like #239', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const hotspots = Array.from(
      document.querySelectorAll('[data-canvas-image-rotate-hotspot="top-left"]')
    ) as HTMLElement[]
    const handle = document.querySelector(
      '[data-canvas-image-handle="top-left"]'
    ) as HTMLElement | null

    expect(hotspots).toHaveLength(3)
    expect(handle).not.toBeNull()
    expect(
      hotspots.some(
        (hotspot) => hotspot.getAttribute('data-canvas-image-rotate-hotspot-part') === 'circle'
      )
    ).toBe(true)
    expect(
      hotspots.some(
        (hotspot) => hotspot.getAttribute('data-canvas-image-rotate-hotspot-part') === 'horizontal'
      )
    ).toBe(true)
    expect(
      hotspots.some(
        (hotspot) => hotspot.getAttribute('data-canvas-image-rotate-hotspot-part') === 'vertical'
      )
    ).toBe(true)
    expect(hotspots[0]).toHaveStyle({ zIndex: '1' })
    expect(
      hotspots.find(
        (hotspot) => hotspot.getAttribute('data-canvas-image-rotate-hotspot-part') === 'circle'
      )
    ).toHaveStyle({ width: '48px', height: '48px' })
    expect(
      hotspots.find(
        (hotspot) => hotspot.getAttribute('data-canvas-image-rotate-hotspot-part') === 'circle'
      )
    ).toHaveStyle({ left: 'calc(0% - 40px)', top: 'calc(0% - 40px)' })
    expect(
      hotspots.find(
        (hotspot) => hotspot.getAttribute('data-canvas-image-rotate-hotspot-part') === 'horizontal'
      )
    ).toHaveStyle({ width: '54px', height: '16px' })
    expect(handle).toHaveStyle({ width: '28px', height: '28px' })
    expect(handle).toHaveStyle({ zIndex: '2' })
  })

  it('keeps the floating image toolbar anchored to the selected image during drag and flips vertically to avoid annotations', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem({ x: 120, y: 20, width: 220, height: 150 })

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <div data-canvas-item-id="annotation-1" data-canvas-overlay="annotation" />
        <div
          className="image-action-toolbar"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="below"
          data-selection-toolbar-width-estimate="356"
        />
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const annotationOverlay = root.querySelector(
      '[data-canvas-overlay="annotation"]'
    ) as HTMLElement | null
    const toolbar = root.querySelector('.image-action-toolbar') as HTMLElement | null
    const overlay = root.querySelector(
      '[data-canvas-overlay="image-interaction"]'
    ) as HTMLElement | null

    expect(annotationOverlay).not.toBeNull()
    expect(toolbar).not.toBeNull()
    expect(overlay).not.toBeNull()

    mockElementRect(annotationOverlay!, {
      left: 50,
      top: 206,
      width: 260,
      height: 48
    })
    mockElementRect(toolbar!, {
      left: 0,
      top: 0,
      width: 356,
      height: 44
    })
    mockElementRect(overlay!, {
      left: 130,
      top: 40,
      width: 220,
      height: 150
    })

    fireEvent.pointerDown(overlay!, {
      pointerId: 1,
      button: 0,
      clientX: 150,
      clientY: 80
    })
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 151,
      clientY: 81
    })

    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 151,
      clientY: 81
    })

    expect(parseFloat(toolbar!.style.left)).toBeGreaterThan(200)
    expect(parseFloat(toolbar!.style.left)).toBeLessThan(260)
    expect(parseFloat(toolbar!.style.top)).toBeLessThan(40)
  })

  it('retries image toolbar positioning on the next frame when the toolbar mounts after selection', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const rafCallbacks: FrameRequestCallback[] = []
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = root.querySelector(
      '[data-canvas-overlay="image-interaction"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()
    mockElementRect(overlay!, {
      left: 130,
      top: 160,
      width: 200,
      height: 120
    })

    const toolbar = document.createElement('div')
    toolbar.className = 'image-action-toolbar'
    toolbar.dataset.selectionToolbarHeightEstimate = '44'
    toolbar.dataset.selectionToolbarPreferredPlacement = 'below'
    toolbar.dataset.selectionToolbarWidthEstimate = '356'
    root.appendChild(toolbar)
    mockElementRect(toolbar, {
      left: 0,
      top: 0,
      width: 356,
      height: 44
    })

    expect(rafCallbacks.length).toBeGreaterThan(0)
    rafCallbacks.forEach((callback) => callback(0))

    expect(toolbar.style.left).not.toBe('')
    expect(toolbar.style.top).not.toBe('')

    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })

  it('repositions the floating image toolbar after stage zoom with stable stage refs', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const stagePosRef = { current: { x: 0, y: 0 } }
    const stageScaleRef = { current: 1 }
    const item = createItem({ x: 120, y: 120, width: 220, height: 150 })
    const handleSelect = vi.fn()
    const handleDragEnd = vi.fn()
    const handleTransformEnd = vi.fn()

    const { rerender } = render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <div
          className="image-action-toolbar"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="below"
          data-selection-toolbar-width-estimate="356"
        />
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stagePosRef={stagePosRef}
          stageScaleRef={stageScaleRef}
          onSelect={handleSelect}
          onDragEnd={handleDragEnd}
          onTransformEnd={handleTransformEnd}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const toolbar = root.querySelector('.image-action-toolbar') as HTMLElement | null
    const overlay = root.querySelector(
      '[data-canvas-overlay="image-interaction"]'
    ) as HTMLElement | null

    expect(toolbar).not.toBeNull()
    expect(overlay).not.toBeNull()

    toolbar!.style.left = '999px'
    toolbar!.style.top = '999px'

    mockElementRect(toolbar!, {
      left: 0,
      top: 0,
      width: 356,
      height: 44
    })
    mockElementRect(overlay!, {
      left: 120,
      top: 140,
      width: 110,
      height: 75
    })

    stageScaleRef.current = 0.5
    rerender(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <div
          className="image-action-toolbar"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="below"
          data-selection-toolbar-width-estimate="356"
        />
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.5}
          stagePosRef={stagePosRef}
          stageScaleRef={stageScaleRef}
          onSelect={handleSelect}
          onDragEnd={handleDragEnd}
          onTransformEnd={handleTransformEnd}
        />
      </div>
    )

    expect(toolbar!.style.left).toBe('194px')
    expect(toolbar!.style.top).toBe('147px')
  })

  it('repositions the image toolbar that belongs to the selected item when multiple toolbars exist', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem({ id: 'image-2', x: 120, y: 120, width: 220, height: 150 })

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <div
          className="image-action-toolbar"
          data-selection-toolbar-owner-id="image-1"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="auto"
          data-selection-toolbar-width-estimate="356"
        />
        <div
          className="image-action-toolbar"
          data-selection-toolbar-owner-id="image-2"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="auto"
          data-selection-toolbar-width-estimate="356"
        />
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const toolbars = root.querySelectorAll('.image-action-toolbar')
    const firstToolbar = toolbars[0] as HTMLElement | undefined
    const secondToolbar = toolbars[1] as HTMLElement | undefined
    const overlay = root.querySelector(
      '[data-canvas-overlay="image-interaction"]'
    ) as HTMLElement | null

    expect(firstToolbar).toBeTruthy()
    expect(secondToolbar).toBeTruthy()
    expect(overlay).not.toBeNull()

    firstToolbar!.style.left = '40px'
    firstToolbar!.style.top = '50px'
    secondToolbar!.style.left = '999px'
    secondToolbar!.style.top = '999px'

    mockElementRect(firstToolbar!, {
      left: 0,
      top: 0,
      width: 356,
      height: 44
    })
    mockElementRect(secondToolbar!, {
      left: 0,
      top: 0,
      width: 356,
      height: 44
    })
    mockElementRect(overlay!, {
      left: 120,
      top: 140,
      width: 110,
      height: 75
    })

    fireEvent.pointerDown(overlay!, {
      pointerId: 11,
      button: 0,
      clientX: 150,
      clientY: 170
    })
    fireEvent.pointerMove(window, {
      pointerId: 11,
      clientX: 151,
      clientY: 171
    })
    fireEvent.pointerUp(window, {
      pointerId: 11,
      clientX: 151,
      clientY: 171
    })

    expect(firstToolbar!.style.left).toBe('40px')
    expect(firstToolbar!.style.top).toBe('50px')
    expect(Number.parseFloat(secondToolbar!.style.left)).toBeGreaterThanOrEqual(230)
    expect(Number.parseFloat(secondToolbar!.style.left)).toBeLessThanOrEqual(231)
    expect(Number.parseFloat(secondToolbar!.style.top)).toBeGreaterThanOrEqual(64)
    expect(Number.parseFloat(secondToolbar!.style.top)).toBeLessThanOrEqual(65)
  })

  it('keeps the image aspect ratio when resizing from a corner', () => {
    const onTransformEnd = vi.fn()
    const onPreviewChange = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onPreviewChange={onPreviewChange}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const handle = document.querySelector(
      '[data-canvas-image-handle="bottom-right"]'
    ) as HTMLElement | null
    expect(handle).not.toBeNull()

    fireEvent.pointerDown(handle!, { pointerId: 1, clientX: 310, clientY: 280 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 410, clientY: 310 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 410, clientY: 310 })

    const expectedScale = (300 * 200 + 150 * 120) / (200 * 200 + 120 * 120)
    expect(onTransformEnd).toHaveBeenCalledWith('image-1', {
      x: 100,
      y: 140,
      rotation: 0,
      scaleX: expectedScale,
      scaleY: expectedScale
    })
    expect(onPreviewChange).toHaveBeenLastCalledWith('image-1', {
      x: 100,
      y: 140,
      width: 200,
      height: 120,
      rotation: 0,
      scaleX: expectedScale,
      scaleY: expectedScale
    })
  })

  it('treats ctrl-click as additive selection', () => {
    const onSelect = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={onSelect}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const overlay = document.querySelector(
      '[data-canvas-overlay="image-interaction"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, {
      pointerId: 5,
      button: 0,
      clientX: 110,
      clientY: 160,
      ctrlKey: true
    })

    expect(onSelect).toHaveBeenCalledWith(true)
  })

  it('lets an unselected image enter drag on the first pointer gesture', () => {
    const onDragEnd = vi.fn()
    const onSelect = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={onSelect}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = document.querySelector(
      '[data-canvas-overlay="image-interaction"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 6, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 6, clientX: 150, clientY: 190 })
    fireEvent.pointerUp(window, { pointerId: 6, clientX: 150, clientY: 190 })

    expect(onSelect).toHaveBeenCalledWith(false)
    expect(onDragEnd).toHaveBeenCalledWith('image-1', 140, 170, expect.any(Object))
  })

  it('emits drag previews immediately so the WebGL image body follows the frame', () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        rafId += 1
        rafCallbacks.set(rafId, callback)
        return rafId
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id: number) => {
        rafCallbacks.delete(id)
      })

    const onDragEnd = vi.fn()
    const onPreviewChange = vi.fn()
    const syncListener = vi.fn()
    window.addEventListener('canvas-sync-image-1', syncListener)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    try {
      render(
        <div data-testid="canvas-root" ref={canvasContainerRef}>
          <div
            className="image-action-toolbar"
            data-selection-toolbar-height-estimate="44"
            data-selection-toolbar-preferred-placement="below"
            data-selection-toolbar-width-estimate="356"
          />
          <ProjectCanvasImageInteractionOverlay
            canvasContainerRef={canvasContainerRef}
            item={createItem()}
            isSelected
            showTransformer={false}
            isDraggable
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            onPreviewChange={onPreviewChange}
            onSelect={vi.fn()}
            onDragEnd={onDragEnd}
            onTransformEnd={vi.fn()}
          />
        </div>
      )

      const root = screen.getByTestId('canvas-root')
      mockCanvasRect(root)

      const overlay = document.querySelector(
        '[data-canvas-overlay="image-interaction"]'
      ) as HTMLElement | null
      expect(overlay).not.toBeNull()
      const baselineRafCallCount = requestAnimationFrameSpy.mock.calls.length
      const baselineCancelRafCallCount = cancelAnimationFrameSpy.mock.calls.length
      rafCallbacks.clear()

      fireEvent.pointerDown(overlay!, { pointerId: 15, button: 0, clientX: 110, clientY: 160 })
      fireEvent.pointerMove(window, { pointerId: 15, clientX: 150, clientY: 190 })
      fireEvent.pointerMove(window, { pointerId: 15, clientX: 180, clientY: 210 })

      expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(baselineRafCallCount)
      expect(rafCallbacks.size).toBe(0)
      expect(onPreviewChange).toHaveBeenCalledTimes(2)
      expect(onPreviewChange).toHaveBeenLastCalledWith('image-1', {
        x: 170,
        y: 190,
        width: 200,
        height: 120,
        scaleX: 1,
        scaleY: 1,
        rotation: 0
      })

      fireEvent.pointerUp(window, { pointerId: 15, clientX: 180, clientY: 210 })

      expect(cancelAnimationFrameSpy.mock.calls.length).toBeGreaterThanOrEqual(
        baselineCancelRafCallCount
      )
      expect(rafCallbacks.size).toBe(0)
      expect(onPreviewChange).toHaveBeenCalledTimes(2)
      expect(onPreviewChange).toHaveBeenLastCalledWith('image-1', {
        x: 170,
        y: 190,
        width: 200,
        height: 120,
        scaleX: 1,
        scaleY: 1,
        rotation: 0
      })
      expect(onDragEnd).toHaveBeenCalledWith('image-1', 170, 190, expect.any(Object))
      expect(syncListener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('canvas-sync-image-1', syncListener)
      requestAnimationFrameSpy.mockRestore()
      cancelAnimationFrameSpy.mockRestore()
    }
  })

  it('broadcasts DOM preview sync only when requested for attached overlays', () => {
    const onPreviewChange = vi.fn()
    const syncListener = vi.fn()
    window.addEventListener('canvas-sync-image-1', syncListener)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    try {
      render(
        <div data-testid="canvas-root" ref={canvasContainerRef}>
          <ProjectCanvasImageInteractionOverlay
            canvasContainerRef={canvasContainerRef}
            item={createItem()}
            isSelected
            showTransformer={false}
            isDraggable
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            onPreviewChange={onPreviewChange}
            broadcastDomPreviewSync
            onSelect={vi.fn()}
            onDragEnd={vi.fn()}
            onTransformEnd={vi.fn()}
          />
        </div>
      )

      const root = screen.getByTestId('canvas-root')
      mockCanvasRect(root)

      const overlay = document.querySelector(
        '[data-canvas-overlay="image-interaction"]'
      ) as HTMLElement | null
      expect(overlay).not.toBeNull()

      fireEvent.pointerDown(overlay!, { pointerId: 16, button: 0, clientX: 110, clientY: 160 })
      fireEvent.pointerMove(window, { pointerId: 16, clientX: 150, clientY: 190 })
      fireEvent.pointerUp(window, { pointerId: 16, clientX: 150, clientY: 190 })

      expect(syncListener).toHaveBeenCalledTimes(1)
      expect((syncListener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
        x: 140,
        y: 170,
        width: 200,
        height: 120,
        scaleX: 1,
        scaleY: 1,
        rotation: 0
      })
    } finally {
      window.removeEventListener('canvas-sync-image-1', syncListener)
    }
  })

  it('keeps the dragged transform when a parent rerender lands before pointerup', () => {
    const onPreviewChange = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem()
    const { rerender } = render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onPreviewChange={onPreviewChange}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = document.querySelector(
      '[data-canvas-overlay="image-interaction"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 9, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 150, clientY: 190 })

    expect((overlay as HTMLElement).style.transform).toContain('translate3d(140px, 170px, 0)')

    rerender(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onPreviewChange={onPreviewChange}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    expect((overlay as HTMLElement).style.transform).toContain('translate3d(140px, 170px, 0)')
  })

  it('becomes pointer-transparent when hand panning should own the drag gesture', () => {
    const onSelect = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected={false}
          showTransformer={false}
          allowPointerPassthrough
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={onSelect}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const overlay = document.querySelector(
      '[data-canvas-overlay="image-interaction"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(overlay).toHaveStyle({ pointerEvents: 'none' })

    fireEvent.pointerDown(overlay!, {
      pointerId: 7,
      button: 0,
      clientX: 110,
      clientY: 160
    })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not render a redundant DOM image preview for selected primary-path images', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const preview = document.querySelector(
      '[data-canvas-overlay="image-interaction"] img[src="file:///image-1.png"]'
    ) as HTMLImageElement | null
    const fallbackPlaceholder = document.querySelector(
      '[data-canvas-image-fallback-placeholder]'
    ) as HTMLElement | null

    expect(preview).toBeNull()
    expect(fallbackPlaceholder).toBeNull()
  })

  it('renders a DOM image preview for primary-path images when explicitly preferred', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem({ image: createLoadedImage(100, 60) })}
          isSelected
          renderMode="webgl-primary"
          preferDomImagePreview
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const primaryPreview = document.querySelector(
      '[data-canvas-image-dom-preview="webgl-primary"]'
    ) as HTMLElement | null
    const previewContent = document.querySelector(
      '[data-canvas-image-dom-preview="webgl-primary"] canvas, [data-canvas-image-dom-preview="webgl-primary"] img[src="file:///image-1.png"]'
    ) as HTMLElement | null

    expect(primaryPreview).not.toBeNull()
    expect(previewContent).not.toBeNull()
  })

  it('suppresses the DOM image preview when WebGL already owns the visual layer', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          suppressImagePreview
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const preview = document.querySelector(
      '[data-canvas-overlay="image-interaction"] img[src="file:///image-1.png"]'
    ) as HTMLImageElement | null

    expect(preview).toBeNull()
  })

  it('does not render unloaded fallback images before a decoded asset is ready', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected={false}
          renderMode="fallback-image-proxy"
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const preview = document.querySelector(
      '[data-canvas-overlay="image-interaction"] img[src="file:///image-1.png"]'
    ) as HTMLImageElement | null
    const fallbackPreview = document.querySelector(
      '[data-canvas-image-dom-preview="fallback-image-proxy"]'
    ) as HTMLElement | null

    expect(preview).toBeNull()
    expect(fallbackPreview).not.toBeNull()
  })

  it('draws fallback DOM previews from the loaded canvas image asset', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const image = createLoadedImage(100, 60)
    const { context, restore } = mockCanvas2DContext()

    try {
      render(
        <div data-testid="canvas-root" ref={canvasContainerRef}>
          <ProjectCanvasImageInteractionOverlay
            canvasContainerRef={canvasContainerRef}
            item={createItem({
              image,
              crop: { x: 10, y: 5, width: 40, height: 20 },
              sourceWidth: 100,
              sourceHeight: 60
            })}
            isSelected={false}
            renderMode="fallback-image-proxy"
            showTransformer={false}
            isDraggable
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            onSelect={vi.fn()}
            onDragEnd={vi.fn()}
            onTransformEnd={vi.fn()}
          />
        </div>
      )

      const canvasPreview = document.querySelector(
        '[data-canvas-image-dom-preview="fallback-image-proxy"] canvas'
      ) as HTMLCanvasElement | null
      const imagePreview = document.querySelector(
        '[data-canvas-image-dom-preview="fallback-image-proxy"] img'
      ) as HTMLImageElement | null

      expect(canvasPreview).not.toBeNull()
      expect(canvasPreview?.width).toBe(200)
      expect(canvasPreview?.height).toBe(120)
      expect(imagePreview).toBeNull()
      expect(context.drawImage).toHaveBeenCalledWith(image, 10, 5, 40, 20, 0, 0, 200, 120)
    } finally {
      restore()
    }
  })

  it('commits rotate transforms from a corner hotspot', () => {
    const onTransformEnd = vi.fn()
    const onPreviewChange = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onPreviewChange={onPreviewChange}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const handle = document.querySelector(
      '[data-canvas-image-rotate-hotspot="top-left"]'
    ) as HTMLElement | null
    expect(handle).not.toBeNull()

    fireEvent.pointerDown(handle!, { pointerId: 1, clientX: 210, clientY: 120 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 310, clientY: 220 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 310, clientY: 220 })

    expect(onTransformEnd).toHaveBeenCalledWith('image-1', {
      x: 260,
      y: 100,
      rotation: 90,
      scaleX: 1,
      scaleY: 1
    })
    expect(onPreviewChange).toHaveBeenLastCalledWith('image-1', {
      x: 260,
      y: 100,
      width: 200,
      height: 120,
      rotation: 90,
      scaleX: 1,
      scaleY: 1
    })
  })

  it('preserves signed scales when resizing a flipped loaded image', () => {
    const onTransformEnd = vi.fn()
    const onPreviewChange = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasImageInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem({ x: 100, y: 140, scaleX: -1.25, scaleY: -0.5 })}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onPreviewChange={onPreviewChange}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const handle = document.querySelector(
      '[data-canvas-image-handle="bottom-right"]'
    ) as HTMLElement | null
    expect(handle).not.toBeNull()

    fireEvent.pointerDown(handle!, { pointerId: 1, clientX: -140, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: -190, clientY: 88 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: -190, clientY: 88 })

    expect(onTransformEnd).toHaveBeenCalledWith('image-1', {
      x: 100,
      y: 140,
      rotation: 0,
      scaleX: -1.5,
      scaleY: -0.6
    })
    expect(onPreviewChange).toHaveBeenLastCalledWith('image-1', {
      x: 100,
      y: 140,
      width: 200,
      height: 120,
      rotation: 0,
      scaleX: -1.5,
      scaleY: -0.6
    })
  })
})
