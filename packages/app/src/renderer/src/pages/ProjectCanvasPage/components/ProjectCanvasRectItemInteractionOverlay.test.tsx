import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProjectCanvasRectItemInteractionOverlay from './ProjectCanvasRectItemInteractionOverlay'
import { PROJECT_CANVAS_SELECTION_OUTLINE_WIDTH } from './projectCanvasInteractionOverlayStyles'

function createItem() {
  return {
    id: 'rect-1',
    x: 100,
    y: 140,
    width: 200,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1
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

describe('ProjectCanvasRectItemInteractionOverlay', () => {
  it('renders a thicker selection outline for selected items', () => {
    expect(PROJECT_CANVAS_SELECTION_OUTLINE_WIDTH).toBe(3)
  })

  it('registers window pointer listeners only during active rect interactions', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    try {
      render(
        <div data-testid="canvas-root" ref={canvasContainerRef}>
          <ProjectCanvasRectItemInteractionOverlay
            canvasContainerRef={canvasContainerRef}
            item={{ ...createItem(), id: 'rect-1', x: 100 }}
            isSelected
            showTransformer={false}
            isDraggable
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            overlayRole="test"
            onSelect={vi.fn()}
            onDragEnd={vi.fn()}
            onTransformEnd={vi.fn()}
          />
          <ProjectCanvasRectItemInteractionOverlay
            canvasContainerRef={canvasContainerRef}
            item={{ ...createItem(), id: 'rect-2', x: 360 }}
            isSelected={false}
            showTransformer={false}
            isDraggable
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            overlayRole="test"
            onSelect={vi.fn()}
            onDragEnd={vi.fn()}
            onTransformEnd={vi.fn()}
          />
        </div>
      )

      const root = screen.getByTestId('canvas-root')
      mockCanvasRect(root)
      const overlays = document.querySelectorAll('[data-canvas-overlay="rect-interaction"]')
      expect(overlays).toHaveLength(2)
      expect(
        addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointermove')
      ).toHaveLength(0)

      fireEvent.pointerDown(overlays[0], { pointerId: 42, button: 0, clientX: 140, clientY: 170 })

      expect(
        addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointermove')
      ).toHaveLength(1)
      expect(addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointerup')).toHaveLength(
        1
      )
      expect(
        addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointercancel')
      ).toHaveLength(1)

      fireEvent.pointerUp(window, { pointerId: 42, clientX: 140, clientY: 170 })

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
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const hotspots = Array.from(
      document.querySelectorAll('[data-canvas-rect-rotate-hotspot="top-left"]')
    ) as HTMLElement[]
    const handle = document.querySelector(
      '[data-canvas-rect-handle="top-left"]'
    ) as HTMLElement | null

    expect(hotspots).toHaveLength(3)
    expect(handle).not.toBeNull()
    expect(
      hotspots.some(
        (hotspot) => hotspot.getAttribute('data-canvas-rect-rotate-hotspot-part') === 'circle'
      )
    ).toBe(true)
    expect(
      hotspots.some(
        (hotspot) => hotspot.getAttribute('data-canvas-rect-rotate-hotspot-part') === 'horizontal'
      )
    ).toBe(true)
    expect(
      hotspots.some(
        (hotspot) => hotspot.getAttribute('data-canvas-rect-rotate-hotspot-part') === 'vertical'
      )
    ).toBe(true)
    expect(hotspots[0]).toHaveStyle({ zIndex: '1' })
    expect(
      hotspots.find(
        (hotspot) => hotspot.getAttribute('data-canvas-rect-rotate-hotspot-part') === 'circle'
      )
    ).toHaveStyle({ width: '48px', height: '48px' })
    expect(
      hotspots.find(
        (hotspot) => hotspot.getAttribute('data-canvas-rect-rotate-hotspot-part') === 'circle'
      )
    ).toHaveStyle({ left: 'calc(0% - 40px)', top: 'calc(0% - 40px)' })
    expect(
      hotspots.find(
        (hotspot) => hotspot.getAttribute('data-canvas-rect-rotate-hotspot-part') === 'horizontal'
      )
    ).toHaveStyle({ width: '54px', height: '16px' })
    expect(handle).toHaveStyle({ width: '28px', height: '28px' })
    expect(handle).toHaveStyle({ zIndex: '2' })
  })

  it('keeps floating rect-item toolbars anchored to the selected item and flips vertically to avoid text overlays', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = {
      ...createItem(),
      x: 120,
      y: 20,
      width: 220,
      height: 150
    }

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <div data-canvas-item-id="text-1" data-canvas-overlay="text" />
        <div
          className="blob-item-action-toolbar"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="auto"
          data-selection-toolbar-width-estimate="392"
        />
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test-selected"
          floatingToolbarSelector=".blob-item-action-toolbar"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const textOverlay = root.querySelector('[data-canvas-overlay="text"]') as HTMLElement | null
    const toolbar = root.querySelector('.blob-item-action-toolbar') as HTMLElement | null
    const overlay = root.querySelector(
      '[data-canvas-overlay-role="test-selected"]'
    ) as HTMLElement | null

    expect(textOverlay).not.toBeNull()
    expect(toolbar).not.toBeNull()
    expect(overlay).not.toBeNull()

    mockElementRect(textOverlay!, {
      left: 50,
      top: 206,
      width: 260,
      height: 48
    })
    mockElementRect(toolbar!, {
      left: 0,
      top: 0,
      width: 392,
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

    expect(parseFloat(toolbar!.style.left)).toBeCloseTo(230, 0)
    expect(parseFloat(toolbar!.style.top)).toBeLessThan(40)
  })

  it('retries rect toolbar positioning on the next frame when the toolbar mounts after selection', () => {
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
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="file-interaction"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = root.querySelector(
      '[data-canvas-overlay-role="file-interaction"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()
    mockElementRect(overlay!, {
      left: 130,
      top: 160,
      width: 200,
      height: 120
    })

    const toolbar = document.createElement('div')
    toolbar.className = 'file-item-action-toolbar'
    toolbar.dataset.selectionToolbarHeightEstimate = '44'
    toolbar.dataset.selectionToolbarPreferredPlacement = 'below'
    toolbar.dataset.selectionToolbarWidthEstimate = '220'
    root.appendChild(toolbar)
    mockElementRect(toolbar, {
      left: 0,
      top: 0,
      width: 220,
      height: 44
    })

    expect(rafCallbacks.length).toBeGreaterThan(0)
    rafCallbacks.forEach((callback) => callback(0))

    expect(toolbar.style.left).not.toBe('')
    expect(toolbar.style.top).not.toBe('')

    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })

  it('repositions the floating file toolbar after stage zoom with stable stage refs', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const stagePosRef = { current: { x: 0, y: 0 } }
    const stageScaleRef = { current: 1 }
    const item = createItem()
    const handleSelect = vi.fn()
    const handleDragEnd = vi.fn()
    const handleTransformEnd = vi.fn()

    const { rerender } = render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <div
          className="file-item-action-toolbar"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="below"
          data-selection-toolbar-width-estimate="220"
        />
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stagePosRef={stagePosRef}
          stageScaleRef={stageScaleRef}
          overlayRole="file-interaction"
          onSelect={handleSelect}
          onDragEnd={handleDragEnd}
          onTransformEnd={handleTransformEnd}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const toolbar = root.querySelector('.file-item-action-toolbar') as HTMLElement | null
    const overlay = root.querySelector(
      '[data-canvas-overlay-role="file-interaction"]'
    ) as HTMLElement | null

    expect(toolbar).not.toBeNull()
    expect(overlay).not.toBeNull()

    toolbar!.style.left = '999px'
    toolbar!.style.top = '999px'

    mockElementRect(toolbar!, {
      left: 0,
      top: 0,
      width: 220,
      height: 44
    })
    mockElementRect(overlay!, {
      left: 230,
      top: 180,
      width: 120,
      height: 90
    })

    stageScaleRef.current = 0.5
    rerender(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <div
          className="file-item-action-toolbar"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="below"
          data-selection-toolbar-width-estimate="220"
        />
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.5}
          stagePosRef={stagePosRef}
          stageScaleRef={stageScaleRef}
          overlayRole="file-interaction"
          onSelect={handleSelect}
          onDragEnd={handleDragEnd}
          onTransformEnd={handleTransformEnd}
        />
      </div>
    )

    expect(toolbar!.style.left).toBe('280px')
    expect(toolbar!.style.top).toBe('262px')
  })

  it('repositions the rect-item toolbar that matches the selected owner id', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <div
          className="file-item-action-toolbar"
          data-selection-toolbar-owner-id="rect-2"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="below"
          data-selection-toolbar-width-estimate="220"
        />
        <div
          className="file-item-action-toolbar"
          data-selection-toolbar-owner-id="rect-1"
          data-selection-toolbar-height-estimate="44"
          data-selection-toolbar-preferred-placement="below"
          data-selection-toolbar-width-estimate="220"
        />
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="file-interaction"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const toolbars = root.querySelectorAll('.file-item-action-toolbar')
    const firstToolbar = toolbars[0] as HTMLElement | undefined
    const secondToolbar = toolbars[1] as HTMLElement | undefined
    const overlay = root.querySelector(
      '[data-canvas-overlay-role="file-interaction"]'
    ) as HTMLElement | null

    expect(firstToolbar).toBeTruthy()
    expect(secondToolbar).toBeTruthy()
    expect(overlay).not.toBeNull()

    firstToolbar!.style.left = '30px'
    firstToolbar!.style.top = '40px'
    secondToolbar!.style.left = '999px'
    secondToolbar!.style.top = '999px'

    mockElementRect(firstToolbar!, {
      left: 0,
      top: 0,
      width: 220,
      height: 44
    })
    mockElementRect(secondToolbar!, {
      left: 0,
      top: 0,
      width: 220,
      height: 44
    })
    mockElementRect(overlay!, {
      left: 230,
      top: 180,
      width: 120,
      height: 90
    })

    fireEvent.pointerDown(overlay!, {
      pointerId: 15,
      button: 0,
      clientX: 250,
      clientY: 200
    })
    fireEvent.pointerMove(window, {
      pointerId: 15,
      clientX: 251,
      clientY: 201
    })
    fireEvent.pointerUp(window, {
      pointerId: 15,
      clientX: 251,
      clientY: 201
    })

    expect(firstToolbar!.style.left).toBe('30px')
    expect(firstToolbar!.style.top).toBe('40px')
    expect(secondToolbar!.style.left).toBe('280px')
    expect(secondToolbar!.style.top).toBe('262px')
  })

  it('keeps corner resize locked to aspect ratio when requested', () => {
    const onTransformEnd = vi.fn()
    const onPreviewChange = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          lockCornerAspectRatio
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
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
      '[data-canvas-rect-handle="bottom-right"]'
    ) as HTMLElement | null
    expect(handle).not.toBeNull()

    fireEvent.pointerDown(handle!, { pointerId: 1, clientX: 310, clientY: 280 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 410, clientY: 310 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 410, clientY: 310 })

    const expectedScale = (300 * 200 + 150 * 120) / (200 * 200 + 120 * 120)
    expect(onTransformEnd).toHaveBeenCalledWith(
      'rect-1',
      {
        x: 100,
        y: 140,
        scaleX: expectedScale,
        scaleY: expectedScale,
        rotation: 0
      },
      'bottom-right'
    )
    expect(onPreviewChange).toHaveBeenLastCalledWith(
      'rect-1',
      {
        x: 100,
        y: 140,
        scaleX: expectedScale,
        scaleY: expectedScale,
        rotation: 0
      },
      'bottom-right'
    )
  })

  it('commits bottom-right resize transforms', () => {
    const onTransformEnd = vi.fn()
    const onPreviewChange = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
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
      '[data-canvas-rect-handle="bottom-right"]'
    ) as HTMLElement | null
    expect(handle).not.toBeNull()

    fireEvent.pointerDown(handle!, { pointerId: 1, clientX: 310, clientY: 280 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 410, clientY: 340 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 410, clientY: 340 })

    expect(onTransformEnd).toHaveBeenCalledWith(
      'rect-1',
      {
        x: 100,
        y: 140,
        scaleX: 1.5,
        scaleY: 1.5,
        rotation: 0
      },
      'bottom-right'
    )
    expect(onPreviewChange).toHaveBeenLastCalledWith(
      'rect-1',
      {
        x: 100,
        y: 140,
        scaleX: 1.5,
        scaleY: 1.5,
        rotation: 0
      },
      'bottom-right'
    )
  })

  it('becomes pointer-transparent when hand panning should own the drag gesture', () => {
    const onSelect = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          allowPointerPassthrough
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={onSelect}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const overlay = document.querySelector(
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(overlay).toHaveStyle({ pointerEvents: 'none' })
    const handle = document.querySelector(
      '[data-canvas-rect-handle="top-left"]'
    ) as HTMLElement | null
    const hotspot = document.querySelector(
      '[data-canvas-rect-rotate-hotspot="top-left"]'
    ) as HTMLElement | null
    expect(handle).toHaveStyle({ pointerEvents: 'none' })
    expect(hotspot).toHaveStyle({ pointerEvents: 'none' })

    fireEvent.pointerDown(overlay!, {
      pointerId: 8,
      button: 0,
      clientX: 110,
      clientY: 160
    })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps the content area pointer-transparent while preserving edge drag handles', () => {
    const onDragEnd = vi.fn()
    const onSelect = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          contentPointerPassthrough
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={onSelect}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = document.querySelector(
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    const dragEdge = document.querySelector(
      '[data-canvas-rect-drag-edge="top"]'
    ) as HTMLElement | null
    const handle = document.querySelector(
      '[data-canvas-rect-handle="top-left"]'
    ) as HTMLElement | null

    expect(overlay).not.toBeNull()
    expect(overlay).toHaveStyle({ pointerEvents: 'none' })
    expect(overlay).toHaveAttribute('data-canvas-overlay-content-pointer-passthrough', 'true')
    expect(dragEdge).not.toBeNull()
    expect(dragEdge).toHaveStyle({ pointerEvents: 'auto' })
    expect(handle).not.toBeNull()
    expect(handle).toHaveStyle({ pointerEvents: 'auto' })

    fireEvent.pointerDown(dragEdge!, { pointerId: 6, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 6, clientX: 150, clientY: 190 })
    fireEvent.pointerUp(window, { pointerId: 6, clientX: 150, clientY: 190 })

    expect(onSelect).not.toHaveBeenCalled()
    expect(onDragEnd).toHaveBeenCalledWith('rect-1', 140, 170, expect.any(Object))
  })

  it('can limit content drag handles to a safe edge for embedded media controls', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          contentPointerPassthrough
          contentDragEdges={['top']}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    expect(document.querySelector('[data-canvas-rect-drag-edge="top"]')).not.toBeNull()
    expect(document.querySelector('[data-canvas-rect-drag-edge="right"]')).toBeNull()
    expect(document.querySelector('[data-canvas-rect-drag-edge="bottom"]')).toBeNull()
    expect(document.querySelector('[data-canvas-rect-drag-edge="left"]')).toBeNull()
  })

  it('can keep a bottom control strip pointer-transparent while dragging from the main body', () => {
    const onDragEnd = vi.fn()
    const onSelect = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          contentPointerPassthrough
          contentDragEdges={[]}
          contentDragSurfaceInset={{ bottom: 40 }}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={onSelect}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const dragSurface = document.querySelector(
      '[data-canvas-rect-drag-surface="body"]'
    ) as HTMLElement | null

    expect(dragSurface).not.toBeNull()
    expect(dragSurface).toHaveStyle({ left: '0px', right: '0px', top: '0px', bottom: '40px' })
    expect(document.querySelector('[data-canvas-rect-drag-edge="top"]')).toBeNull()

    fireEvent.pointerDown(dragSurface!, { pointerId: 9, button: 0, clientX: 180, clientY: 190 })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 220, clientY: 220 })
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 220, clientY: 220 })

    expect(onSelect).not.toHaveBeenCalled()
    expect(onDragEnd).toHaveBeenCalledWith('rect-1', 140, 170, expect.any(Object))
  })

  it('commits drag updates from the body box', () => {
    const onDragEnd = vi.fn()
    const onDragStart = vi.fn()
    const onSelect = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onDragStart={onDragStart}
          onSelect={onSelect}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = document.querySelector(
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 2, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 150, clientY: 190 })
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 150, clientY: 190 })

    expect(onDragStart).toHaveBeenCalledWith('rect-1')
    expect(onSelect).not.toHaveBeenCalled()
    expect(onDragEnd).toHaveBeenCalledWith('rect-1', 140, 170, expect.any(Object))
  })

  it('starts dragging before promoting an unselected box into the selection', () => {
    const eventOrder: string[] = []
    const onDragEnd = vi.fn()
    const onDragStart = vi.fn(() => {
      eventOrder.push('drag-start')
    })
    const onSelect = vi.fn(() => {
      eventOrder.push('select')
    })
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onDragStart={onDragStart}
          onSelect={onSelect}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = document.querySelector(
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 12, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 12, clientX: 150, clientY: 190 })
    fireEvent.pointerUp(window, { pointerId: 12, clientX: 150, clientY: 190 })

    expect(eventOrder).toEqual(['drag-start', 'select'])
    expect(onDragEnd).toHaveBeenCalledWith('rect-1', 140, 170, expect.any(Object))
  })

  it('keeps an active drag alive when another overlay for the same item mounts', () => {
    const onDragEnd = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem()
    const { rerender } = render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="drag-source"
          onSelect={vi.fn()}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const dragSource = document.querySelector(
      '[data-canvas-overlay-role="drag-source"]'
    ) as HTMLElement | null
    expect(dragSource).not.toBeNull()

    fireEvent.pointerDown(dragSource!, { pointerId: 13, button: 0, clientX: 110, clientY: 160 })

    rerender(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="drag-source"
          onSelect={vi.fn()}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="selection-promoted"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    fireEvent.pointerMove(window, { pointerId: 13, clientX: 150, clientY: 190 })
    fireEvent.pointerUp(window, { pointerId: 13, clientX: 150, clientY: 190 })

    expect(onDragEnd).toHaveBeenCalledWith('rect-1', 140, 170, expect.any(Object))
  })

  it('starts dragging before promoting an unselected box into the selection', () => {
    const eventOrder: string[] = []
    const onDragEnd = vi.fn()
    const onDragStart = vi.fn(() => {
      eventOrder.push('drag-start')
    })
    const onSelect = vi.fn(() => {
      eventOrder.push('select')
    })
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onDragStart={onDragStart}
          onSelect={onSelect}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = document.querySelector(
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 12, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 12, clientX: 150, clientY: 190 })
    fireEvent.pointerUp(window, { pointerId: 12, clientX: 150, clientY: 190 })

    expect(eventOrder).toEqual(['drag-start', 'select'])
    expect(onDragEnd).toHaveBeenCalledWith('rect-1', 140, 170, expect.any(Object))
  })

  it('keeps the dragged rect transform when a parent rerender lands before pointerup', () => {
    const onPreviewChange = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem()
    const { rerender } = render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test-rerender"
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
      '[data-canvas-overlay-role="test-rerender"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 14, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 14, clientX: 150, clientY: 190 })

    expect((overlay as HTMLElement).style.transform).toContain('translate3d(140px, 170px, 0)')

    rerender(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test-rerender"
          onPreviewChange={onPreviewChange}
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    expect((overlay as HTMLElement).style.transform).toContain('translate3d(140px, 170px, 0)')
  })

  it('resets a stale resize draft when the committed width and height arrive', () => {
    const onTransformEnd = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem()
    const { rerender } = render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test-resize-reset"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = document.querySelector(
      '[data-canvas-overlay-role="test-resize-reset"]'
    ) as HTMLElement | null
    const handle = document.querySelector(
      '[data-canvas-rect-handle="middle-right"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(handle).not.toBeNull()

    fireEvent.pointerDown(handle!, { pointerId: 15, button: 0, clientX: 310, clientY: 200 })
    fireEvent.pointerMove(window, { pointerId: 15, clientX: 370, clientY: 200 })
    fireEvent.pointerUp(window, { pointerId: 15, clientX: 370, clientY: 200 })

    expect((overlay as HTMLElement).style.transform).toContain('scale(1.3, 1)')

    rerender(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={{ ...item, width: 260 }}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test-resize-reset"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    expect((overlay as HTMLElement).style.transform).toContain(
      'translate3d(100px, 140px, 0) rotate(0deg) scale(1, 1)'
    )
  })

  it('promotes an unselected box into the selection on first drag movement', () => {
    const onSelect = vi.fn()
    const onDragEnd = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={onSelect}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const overlay = document.querySelector(
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 14, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 14, clientX: 150, clientY: 190 })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(false)
    expect(onDragEnd).not.toHaveBeenCalled()

    fireEvent.pointerUp(window, { pointerId: 14, clientX: 150, clientY: 190 })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onDragEnd).toHaveBeenCalledWith('rect-1', 140, 170, expect.any(Object))
  })

  it('keeps an active drag alive when another overlay for the same item mounts', () => {
    const onDragEnd = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem()
    const { rerender } = render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="drag-source"
          onSelect={vi.fn()}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRect(root)

    const dragSource = document.querySelector(
      '[data-canvas-overlay-role="drag-source"]'
    ) as HTMLElement | null
    expect(dragSource).not.toBeNull()

    fireEvent.pointerDown(dragSource!, { pointerId: 13, button: 0, clientX: 110, clientY: 160 })

    rerender(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="drag-source"
          onSelect={vi.fn()}
          onDragEnd={onDragEnd}
          onTransformEnd={vi.fn()}
        />
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="selection-promoted"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    fireEvent.pointerMove(window, { pointerId: 13, clientX: 150, clientY: 190 })
    fireEvent.pointerUp(window, { pointerId: 13, clientX: 150, clientY: 190 })

    expect(onDragEnd).toHaveBeenCalledWith('rect-1', 140, 170, expect.any(Object))
  })

  it('batches drag previews into a single animation frame and flushes the latest transform on pointerup', () => {
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
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
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
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 5, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 150, clientY: 190 })
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 180, clientY: 210 })

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1)
    expect(rafCallbacks.size).toBe(1)
    expect(onPreviewChange).not.toHaveBeenCalled()

    fireEvent.pointerUp(window, { pointerId: 5, clientX: 180, clientY: 210 })

    expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(1)
    expect(rafCallbacks.size).toBe(0)
    expect(onPreviewChange).toHaveBeenLastCalledWith(
      'rect-1',
      {
        x: 170,
        y: 190,
        scaleX: 1,
        scaleY: 1,
        rotation: 0
      },
      'drag'
    )
    expect(onDragEnd).toHaveBeenCalledWith('rect-1', 170, 190, expect.any(Object))

    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })

  it('reuses the measured canvas viewport rect throughout a drag session and refreshes it for the next drag', () => {
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    let currentRect = {
      left: 10,
      top: 20,
      right: 1010,
      bottom: 620,
      width: 1000,
      height: 600,
      x: 10,
      y: 20,
      toJSON: () => ({})
    }
    const getBoundingClientRect = vi.fn(() => currentRect)
    Object.defineProperty(root, 'getBoundingClientRect', {
      configurable: true,
      value: getBoundingClientRect
    })

    const overlay = document.querySelector(
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 7, button: 0, clientX: 110, clientY: 160 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 150, clientY: 190 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 180, clientY: 210 })

    expect(getBoundingClientRect).toHaveBeenCalledTimes(1)

    fireEvent.pointerUp(window, { pointerId: 7, clientX: 180, clientY: 210 })

    currentRect = {
      left: 40,
      top: 60,
      right: 1040,
      bottom: 660,
      width: 1000,
      height: 600,
      x: 40,
      y: 60,
      toJSON: () => ({})
    }

    fireEvent.pointerDown(overlay!, { pointerId: 8, button: 0, clientX: 140, clientY: 200 })

    expect(getBoundingClientRect).toHaveBeenCalledTimes(2)
  })

  it('clears runtime previews when committed item props change', () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem()
    const { rerender } = render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    dispatchEventSpy.mockClear()

    rerender(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={{ ...item, x: 140, y: 170 }}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    expect(dispatchEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'canvas-reset-rect-1' })
    )
    dispatchEventSpy.mockRestore()
  })

  it('treats ctrl-click as additive selection', () => {
    const onSelect = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={onSelect}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const overlay = document.querySelector(
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, {
      pointerId: 4,
      button: 0,
      clientX: 110,
      clientY: 160,
      ctrlKey: true
    })

    expect(onSelect).toHaveBeenCalledWith(true)
  })

  it('preserves double-click editing after the interaction layer remounts for the same item', () => {
    const onDoubleClick = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const item = createItem()
    const { rerender } = render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected={false}
          showTransformer={false}
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
          onDoubleClick={onDoubleClick}
        />
      </div>
    )

    const firstOverlay = document.querySelector(
      '[data-canvas-overlay-role="test"]'
    ) as HTMLElement | null
    expect(firstOverlay).not.toBeNull()

    fireEvent.pointerDown(firstOverlay!, {
      pointerId: 1,
      button: 0,
      clientX: 110,
      clientY: 160,
      timeStamp: 100
    })

    rerender(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={item}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test-selected"
          onSelect={vi.fn()}
          onDragEnd={vi.fn()}
          onTransformEnd={vi.fn()}
          onDoubleClick={onDoubleClick}
        />
      </div>
    )

    const secondOverlay = document.querySelector(
      '[data-canvas-overlay-role="test-selected"]'
    ) as HTMLElement | null
    expect(secondOverlay).not.toBeNull()

    fireEvent.pointerDown(secondOverlay!, {
      pointerId: 2,
      button: 0,
      clientX: 112,
      clientY: 162,
      timeStamp: 260
    })

    expect(onDoubleClick).toHaveBeenCalledTimes(1)
  })

  it('commits rotate transforms from a corner hotspot', () => {
    const onTransformEnd = vi.fn()
    const onPreviewChange = vi.fn()
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasRectItemInteractionOverlay
          canvasContainerRef={canvasContainerRef}
          item={createItem()}
          isSelected
          showTransformer
          isDraggable
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          overlayRole="test"
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
      '[data-canvas-rect-rotate-hotspot="top-left"]'
    ) as HTMLElement | null
    expect(handle).not.toBeNull()

    fireEvent.pointerDown(handle!, { pointerId: 3, clientX: 210, clientY: 120 })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 310, clientY: 220 })
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 310, clientY: 220 })

    expect(onTransformEnd).toHaveBeenCalledWith(
      'rect-1',
      {
        x: 260,
        y: 100,
        scaleX: 1,
        scaleY: 1,
        rotation: 90
      },
      'rotate'
    )
    expect(onPreviewChange).toHaveBeenLastCalledWith(
      'rect-1',
      {
        x: 260,
        y: 100,
        scaleX: 1,
        scaleY: 1,
        rotation: 90
      },
      'rotate'
    )
  })
})
