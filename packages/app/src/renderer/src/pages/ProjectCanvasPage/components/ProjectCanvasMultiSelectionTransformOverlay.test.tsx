import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProjectCanvasMultiSelectionTransformOverlay from './ProjectCanvasMultiSelectionTransformOverlay'
import * as canvasSync from './canvasSync'
import type { CanvasImageItem, CanvasTextItem } from '../types'

function createImageItem(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number
): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `file:///${id}.png`,
    x,
    y,
    width,
    height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createTextItem(id: string, x: number, y: number): CanvasTextItem {
  return {
    id,
    type: 'text',
    text: 'Prompt text',
    x,
    y,
    width: 180,
    height: 72,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    fontSize: 18,
    fontFamily: 'system-ui, sans-serif',
    fill: '#ffffff',
    fontWeight: 'normal'
  }
}

function mockCanvasRootRect(root: HTMLElement) {
  Object.defineProperty(root, 'getBoundingClientRect', {
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

describe('ProjectCanvasMultiSelectionTransformOverlay', () => {
  it('registers window pointer listeners only during active multi-selection interactions', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const firstItem = createImageItem('image-1', 100, 140, 200, 120)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    try {
      render(
        <div data-testid="canvas-root" ref={canvasContainerRef}>
          <ProjectCanvasMultiSelectionTransformOverlay
            canvasContainerRef={canvasContainerRef}
            items={[firstItem, secondItem]}
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            onTransformEnd={vi.fn()}
          />
        </div>
      )

      mockCanvasRootRect(screen.getByTestId('canvas-root'))

      expect(
        addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointermove')
      ).toHaveLength(0)

      const dragSurface = document.querySelector(
        '[data-canvas-multi-select-drag-surface="true"]'
      ) as HTMLElement | null
      expect(dragSurface).not.toBeNull()

      fireEvent.pointerDown(dragSurface!, {
        pointerId: 42,
        clientX: 260,
        clientY: 200,
        button: 0
      })

      expect(
        addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointermove')
      ).toHaveLength(1)
      expect(addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointerup')).toHaveLength(
        1
      )
      expect(
        addEventListenerSpy.mock.calls.filter(([type]) => type === 'pointercancel')
      ).toHaveLength(1)

      fireEvent.pointerUp(window, { pointerId: 42, clientX: 260, clientY: 200 })

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

  it('does not register per-image canvas sync listeners for image-only selections', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const firstItem = createImageItem('image-1', 100, 140, 200, 120)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    try {
      render(
        <div data-testid="canvas-root" ref={canvasContainerRef}>
          <ProjectCanvasMultiSelectionTransformOverlay
            canvasContainerRef={canvasContainerRef}
            items={[firstItem, secondItem]}
            livePreviewSyncItemIds={new Set()}
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            onTransformEnd={vi.fn()}
          />
        </div>
      )

      const canvasSyncListeners = addEventListenerSpy.mock.calls.filter(([type]) =>
        String(type).startsWith('canvas-sync-')
      )
      const canvasResetListeners = addEventListenerSpy.mock.calls.filter(([type]) =>
        String(type).startsWith('canvas-reset-')
      )

      expect(canvasSyncListeners).toHaveLength(0)
      expect(canvasResetListeners).toHaveLength(0)
    } finally {
      addEventListenerSpy.mockRestore()
    }
  })

  it('updates drag preview imperatively without React commits during pointer moves', async () => {
    const onRender = vi.fn()
    const onTransformEnd = vi.fn()
    const firstItem = createImageItem('image-1', 100, 140, 200, 120)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <React.Profiler id="multi-selection-overlay" onRender={onRender}>
        <div data-testid="canvas-root" ref={canvasContainerRef}>
          <ProjectCanvasMultiSelectionTransformOverlay
            canvasContainerRef={canvasContainerRef}
            items={[firstItem, secondItem]}
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            onTransformEnd={onTransformEnd}
          />
        </div>
      </React.Profiler>
    )

    mockCanvasRootRect(screen.getByTestId('canvas-root'))
    const commitCountAfterMount = onRender.mock.calls.length
    const overlay = screen.getByTestId('project-canvas-multi-selection-transform-overlay')
    const dragSurface = document.querySelector(
      '[data-canvas-multi-select-drag-surface="true"]'
    ) as HTMLElement | null
    expect(dragSurface).not.toBeNull()

    fireEvent.pointerDown(dragSurface!, { pointerId: 43, clientX: 260, clientY: 200, button: 0 })
    fireEvent.pointerMove(window, { pointerId: 43, clientX: 308, clientY: 236 })

    expect(overlay).toHaveStyle({
      left: '148px',
      top: '176px',
      width: '360px',
      height: '120px'
    })
    expect(onRender).toHaveBeenCalledTimes(commitCountAfterMount)

    fireEvent.pointerMove(window, { pointerId: 43, clientX: 330, clientY: 250 })

    expect(overlay).toHaveStyle({
      left: '170px',
      top: '190px',
      width: '360px',
      height: '120px'
    })
    expect(onRender).toHaveBeenCalledTimes(commitCountAfterMount)

    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })

    expect(onRender).toHaveBeenCalledTimes(commitCountAfterMount)

    fireEvent.pointerUp(window, { pointerId: 43, clientX: 330, clientY: 250 })

    expect(onTransformEnd).toHaveBeenCalledTimes(1)
    expect(onRender).toHaveBeenCalledTimes(commitCountAfterMount)
  })

  it('batches live bounds callbacks for parent state while dragging', async () => {
    const onPreviewBoundsChange = vi.fn()
    const onTransformEnd = vi.fn()
    const firstItem = createImageItem('image-1', 100, 140, 200, 120)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasMultiSelectionTransformOverlay
          canvasContainerRef={canvasContainerRef}
          items={[firstItem, secondItem]}
          onPreviewBoundsChange={onPreviewBoundsChange}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    mockCanvasRootRect(screen.getByTestId('canvas-root'))
    const dragSurface = document.querySelector(
      '[data-canvas-multi-select-drag-surface="true"]'
    ) as HTMLElement | null
    expect(dragSurface).not.toBeNull()

    fireEvent.pointerDown(dragSurface!, { pointerId: 44, clientX: 260, clientY: 200, button: 0 })
    expect(onPreviewBoundsChange).toHaveBeenCalledTimes(1)
    expect(onPreviewBoundsChange).toHaveBeenLastCalledWith({
      x: 100,
      y: 140,
      width: 360,
      height: 120
    })

    fireEvent.pointerMove(window, { pointerId: 44, clientX: 308, clientY: 236 })
    fireEvent.pointerMove(window, { pointerId: 44, clientX: 330, clientY: 250 })

    expect(onPreviewBoundsChange).toHaveBeenCalledTimes(1)

    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })

    expect(onPreviewBoundsChange).toHaveBeenCalledTimes(2)
    expect(onPreviewBoundsChange).toHaveBeenLastCalledWith({
      x: 170,
      y: 190,
      width: 360,
      height: 120
    })

    fireEvent.pointerUp(window, { pointerId: 44, clientX: 330, clientY: 250 })

    expect(onTransformEnd).toHaveBeenCalledTimes(1)
    expect(onPreviewBoundsChange).toHaveBeenLastCalledWith(null)
  })

  it('scales selected items from the bottom-right handle', () => {
    const onTransformEnd = vi.fn()
    const firstItem = createImageItem('image-1', 100, 140, 200, 120)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasMultiSelectionTransformOverlay
          canvasContainerRef={canvasContainerRef}
          items={[firstItem, secondItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRootRect(root)

    const handle = document.querySelector(
      '[data-canvas-multi-select-handle="bottom-right"]'
    ) as HTMLElement | null
    expect(handle).not.toBeNull()

    fireEvent.pointerDown(handle!, { pointerId: 1, clientX: 470, clientY: 280 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 650, clientY: 340 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 650, clientY: 340 })

    expect(onTransformEnd).toHaveBeenCalledTimes(1)
    expect(onTransformEnd).toHaveBeenCalledWith([
      {
        id: firstItem.id,
        attrs: {
          x: 100,
          y: 140,
          scaleX: 1.5,
          scaleY: 1.5
        }
      },
      {
        id: secondItem.id,
        attrs: {
          x: 490,
          y: 200,
          scaleX: 1.5,
          scaleY: 1.5
        }
      }
    ])
  })

  it('follows live preview sync while a selected item is being dragged and resets afterwards', () => {
    const onTransformEnd = vi.fn()
    const firstItem = createImageItem('image-1', 100, 140, 200, 120)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasMultiSelectionTransformOverlay
          canvasContainerRef={canvasContainerRef}
          items={[firstItem, secondItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    const overlay = screen.getByTestId('project-canvas-multi-selection-transform-overlay')
    expect(overlay).toHaveStyle({
      left: '100px',
      top: '140px',
      width: '360px',
      height: '120px'
    })

    fireEvent(
      window,
      new CustomEvent(`canvas-sync-${firstItem.id}`, {
        detail: { x: 148, y: 176, rotation: 0, scaleX: 1, scaleY: 1 }
      })
    )

    expect(overlay).toHaveStyle({
      left: '148px',
      top: '176px',
      width: '360px',
      height: '120px'
    })

    fireEvent(window, new CustomEvent(`canvas-reset-${firstItem.id}`))

    expect(overlay).toHaveStyle({
      left: '100px',
      top: '140px',
      width: '360px',
      height: '120px'
    })
  })

  it('moves the whole selection when dragging the overlay body', () => {
    const onTransformEnd = vi.fn()
    const onPreviewBoundsChange = vi.fn()
    const firstItem = createImageItem('image-1', 100, 140, 200, 120)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasMultiSelectionTransformOverlay
          canvasContainerRef={canvasContainerRef}
          items={[firstItem, secondItem]}
          onPreviewBoundsChange={onPreviewBoundsChange}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    const root = screen.getByTestId('canvas-root')
    mockCanvasRootRect(root)

    const dragSurface = document.querySelector(
      '[data-canvas-multi-select-drag-surface="true"]'
    ) as HTMLElement | null
    expect(dragSurface).not.toBeNull()

    fireEvent.pointerDown(dragSurface!, { pointerId: 7, clientX: 260, clientY: 200, button: 0 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 308, clientY: 236 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 308, clientY: 236 })

    expect(onPreviewBoundsChange).toHaveBeenCalledWith({
      x: 100,
      y: 140,
      width: 360,
      height: 120
    })
    expect(onPreviewBoundsChange).toHaveBeenCalledWith({
      x: 148,
      y: 176,
      width: 360,
      height: 120
    })
    expect(onTransformEnd).toHaveBeenCalledTimes(1)
    expect(onTransformEnd).toHaveBeenCalledWith([
      {
        id: firstItem.id,
        attrs: {
          x: 148,
          y: 176
        }
      },
      {
        id: secondItem.id,
        attrs: {
          x: 408,
          y: 216
        }
      }
    ])
  })

  it('keeps multi-selection drag hit areas limited to selected item bounds', () => {
    const firstItem = createImageItem('image-top-left', 100, 100, 80, 80)
    const secondItem = createImageItem('image-bottom-right', 300, 300, 80, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasMultiSelectionTransformOverlay
          canvasContainerRef={canvasContainerRef}
          items={[firstItem, secondItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onTransformEnd={vi.fn()}
        />
      </div>
    )

    const overlay = screen.getByTestId('project-canvas-multi-selection-transform-overlay')
    expect(overlay).toHaveStyle({
      left: '100px',
      top: '100px',
      width: '280px',
      height: '280px'
    })

    const dragSurfaces = Array.from(
      document.querySelectorAll<HTMLElement>('[data-canvas-multi-select-drag-surface="true"]')
    )
    expect(dragSurfaces).toHaveLength(2)

    const topLeftSurface = dragSurfaces.find(
      (surface) => surface.dataset.canvasMultiSelectDragSurfaceItemId === firstItem.id
    )
    const bottomRightSurface = dragSurfaces.find(
      (surface) => surface.dataset.canvasMultiSelectDragSurfaceItemId === secondItem.id
    )

    expect(topLeftSurface).toHaveStyle({
      left: '0px',
      top: '0px',
      width: '80px',
      height: '80px'
    })
    expect(bottomRightSurface).toHaveStyle({
      left: '200px',
      top: '200px',
      width: '80px',
      height: '80px'
    })
  })

  it('commits a text selection drag even when pointermove and pointerup are batched', () => {
    const onTransformEnd = vi.fn()
    const firstItem = createTextItem('text-1', 100, 140)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasMultiSelectionTransformOverlay
          canvasContainerRef={canvasContainerRef}
          items={[firstItem, secondItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    mockCanvasRootRect(screen.getByTestId('canvas-root'))

    const dragSurface = document.querySelector(
      '[data-canvas-multi-select-drag-surface="true"]'
    ) as HTMLElement | null
    expect(dragSurface).not.toBeNull()

    fireEvent.pointerDown(dragSurface!, { pointerId: 8, clientX: 260, clientY: 200, button: 0 })
    act(() => {
      fireEvent.pointerMove(window, { pointerId: 8, clientX: 308, clientY: 236 })
      fireEvent.pointerUp(window, { pointerId: 8, clientX: 308, clientY: 236 })
    })

    expect(onTransformEnd).toHaveBeenCalledTimes(1)
    expect(onTransformEnd).toHaveBeenCalledWith([
      {
        id: firstItem.id,
        attrs: {
          x: 148,
          y: 176
        }
      },
      {
        id: secondItem.id,
        attrs: {
          x: 408,
          y: 216
        }
      }
    ])
  })

  it('emits canvas sync previews for text items while dragging a multi-selection', async () => {
    const onTransformEnd = vi.fn()
    const firstItem = createTextItem('text-preview', 100, 140)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const syncEvents: Array<{
      x: number
      y: number
      rotation: number
      scaleX: number
      scaleY: number
    }> = []
    const handleSync = (event: Event) => {
      syncEvents.push((event as CustomEvent).detail)
    }
    window.addEventListener(`canvas-sync-${firstItem.id}`, handleSync)

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasMultiSelectionTransformOverlay
          canvasContainerRef={canvasContainerRef}
          items={[firstItem, secondItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    mockCanvasRootRect(screen.getByTestId('canvas-root'))

    const dragSurface = document.querySelector(
      '[data-canvas-multi-select-drag-surface="true"]'
    ) as HTMLElement | null
    expect(dragSurface).not.toBeNull()

    fireEvent.pointerDown(dragSurface!, { pointerId: 9, clientX: 260, clientY: 200, button: 0 })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 308, clientY: 236 })

    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })

    expect(syncEvents.at(-1)).toEqual({
      x: 148,
      y: 176,
      rotation: 0,
      scaleX: 1,
      scaleY: 1
    })

    window.removeEventListener(`canvas-sync-${firstItem.id}`, handleSync)
  })

  it('does not broadcast canvas sync previews for image-only multi-selection drags', async () => {
    const onTransformEnd = vi.fn()
    const scheduleCanvasSyncSpy = vi.spyOn(canvasSync, 'scheduleCanvasSync')
    const firstItem = createImageItem('image-1', 100, 140, 200, 120)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const syncEvents: Event[] = []
    const handleSync = (event: Event) => {
      syncEvents.push(event)
    }
    window.addEventListener(`canvas-sync-${firstItem.id}`, handleSync)
    window.addEventListener(`canvas-sync-${secondItem.id}`, handleSync)

    try {
      render(
        <div data-testid="canvas-root" ref={canvasContainerRef}>
          <ProjectCanvasMultiSelectionTransformOverlay
            canvasContainerRef={canvasContainerRef}
            items={[firstItem, secondItem]}
            stagePos={{ x: 0, y: 0 }}
            stageScale={1}
            onTransformEnd={onTransformEnd}
          />
        </div>
      )

      mockCanvasRootRect(screen.getByTestId('canvas-root'))

      const dragSurface = document.querySelector(
        '[data-canvas-multi-select-drag-surface="true"]'
      ) as HTMLElement | null
      expect(dragSurface).not.toBeNull()

      fireEvent.pointerDown(dragSurface!, { pointerId: 9, clientX: 260, clientY: 200, button: 0 })
      fireEvent.pointerMove(window, { pointerId: 9, clientX: 308, clientY: 236 })

      await act(async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      })

      expect(syncEvents).toHaveLength(0)
      expect(scheduleCanvasSyncSpy).not.toHaveBeenCalled()
    } finally {
      scheduleCanvasSyncSpy.mockRestore()
      window.removeEventListener(`canvas-sync-${firstItem.id}`, handleSync)
      window.removeEventListener(`canvas-sync-${secondItem.id}`, handleSync)
    }
  })

  it('keeps the overlay box in sync with live viewport callbacks', () => {
    let viewportCallback: ((pos: { x: number; y: number }, scale: number) => void) | null = null
    const registerViewportCallback = vi.fn(
      (callback: (pos: { x: number; y: number }, scale: number) => void) => {
        viewportCallback = callback
        return vi.fn()
      }
    )
    const onTransformEnd = vi.fn()
    const firstItem = createImageItem('image-1', 100, 140, 200, 120)
    const secondItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()
    const stagePosRef = { current: { x: 0, y: 0 } }
    const stageScaleRef = { current: 1 }

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasMultiSelectionTransformOverlay
          canvasContainerRef={canvasContainerRef}
          items={[firstItem, secondItem]}
          registerViewportCallback={registerViewportCallback}
          stagePos={stagePosRef.current}
          stagePosRef={stagePosRef}
          stageScale={stageScaleRef.current}
          stageScaleRef={stageScaleRef}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    const overlay = screen.getByTestId('project-canvas-multi-selection-transform-overlay')
    expect(overlay).toHaveStyle({
      left: '100px',
      top: '140px',
      width: '360px',
      height: '120px'
    })

    stagePosRef.current = { x: 50, y: 60 }
    stageScaleRef.current = 0.5

    act(() => {
      viewportCallback?.(stagePosRef.current, stageScaleRef.current)
    })

    expect(registerViewportCallback).toHaveBeenCalledTimes(1)
    expect(overlay).toHaveStyle({
      left: '100px',
      top: '130px',
      width: '180px',
      height: '60px'
    })
  })

  it('disables resize handles when the multi-selection includes rotation', () => {
    const onTransformEnd = vi.fn()
    const rotatedItem = { ...createImageItem('image-1', 100, 140, 200, 120), rotation: 18 }
    const siblingItem = createImageItem('image-2', 360, 180, 100, 80)
    const canvasContainerRef = React.createRef<HTMLDivElement>()

    render(
      <div data-testid="canvas-root" ref={canvasContainerRef}>
        <ProjectCanvasMultiSelectionTransformOverlay
          canvasContainerRef={canvasContainerRef}
          items={[rotatedItem, siblingItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onTransformEnd={onTransformEnd}
        />
      </div>
    )

    expect(screen.getByTestId('project-canvas-multi-selection-transform-overlay')).toHaveAttribute(
      'data-resize-enabled',
      'false'
    )
    expect(document.querySelector('[data-canvas-multi-select-handle]')).toBeNull()
  })
})
