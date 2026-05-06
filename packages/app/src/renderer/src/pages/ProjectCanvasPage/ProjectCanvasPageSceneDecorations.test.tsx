import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  ProjectCanvasPageSceneGrid,
  ProjectCanvasPageSceneOverlay
} from './ProjectCanvasPageSceneDecorations'

describe('ProjectCanvasPageSceneGrid', () => {
  it('renders the grid as a transform-driven plane instead of viewport-sized background offsets', () => {
    const { container } = render(
      <ProjectCanvasPageSceneGrid
        showGrid
        stagePos={{ x: 24, y: 36 }}
        stageScale={1.5}
        stageSize={{ width: 1280, height: 720 }}
        gridColor="#333333"
      />
    )

    const plane = container.querySelector(
      '[data-project-canvas-scene-grid="dom"] > div'
    ) as HTMLDivElement | null

    expect(plane).not.toBeNull()
    expect(plane?.style.backgroundSize).toBe('100px 100px')
    expect(plane?.style.transform).toContain('translate3d(')
    expect(plane?.style.transform).toContain('scale(1.5)')
    expect(plane?.style.backgroundPosition).toBe('')
  })

  it('updates the grid plane transform through the viewport callback', async () => {
    const unregister = vi.fn()
    const registerViewportCallback = vi.fn(
      (_fn: (pos: { x: number; y: number }, scale: number) => void) => unregister
    )

    const { container } = render(
      <ProjectCanvasPageSceneGrid
        showGrid
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        registerViewportCallback={registerViewportCallback}
      />
    )

    await waitFor(() => {
      expect(registerViewportCallback).toHaveBeenCalled()
    })

    const plane = container.querySelector(
      '[data-project-canvas-scene-grid="dom"] > div'
    ) as HTMLDivElement | null

    expect(plane).not.toBeNull()

    const viewportCallback = registerViewportCallback.mock.calls[0]?.[0] as
      | ((pos: { x: number; y: number }, scale: number) => void)
      | undefined

    if (!viewportCallback) {
      throw new Error('viewport callback was not registered')
    }

    viewportCallback({ x: 96, y: 72 }, 1.25)

    expect(plane?.style.transform).toContain('scale(1.25)')
    expect(plane?.style.width).not.toBe('')
    expect(plane?.style.height).not.toBe('')
    expect(plane?.style.backgroundPosition).toBe('')
  })

  it('hides the grid plane at overview zoom levels where the grid would repaint as dense noise', async () => {
    const unregister = vi.fn()
    const registerViewportCallback = vi.fn(
      (_fn: (pos: { x: number; y: number }, scale: number) => void) => unregister
    )

    const { container } = render(
      <ProjectCanvasPageSceneGrid
        showGrid
        stagePos={{ x: 0, y: 0 }}
        stageScale={0.01}
        stageSize={{ width: 1280, height: 720 }}
        registerViewportCallback={registerViewportCallback}
      />
    )

    const plane = container.querySelector(
      '[data-project-canvas-scene-grid="dom"] > div'
    ) as HTMLDivElement | null

    expect(plane).not.toBeNull()
    expect(plane?.style.display).toBe('none')

    await waitFor(() => {
      expect(registerViewportCallback).toHaveBeenCalled()
    })

    const viewportCallback = registerViewportCallback.mock.calls[0]?.[0] as
      | ((pos: { x: number; y: number }, scale: number) => void)
      | undefined

    if (!viewportCallback) {
      throw new Error('viewport callback was not registered')
    }

    viewportCallback({ x: 0, y: 0 }, 0.1)

    expect(plane?.style.display).toBe('block')
    expect(plane?.style.transform).toContain('scale(0.1)')
  })
})

describe('ProjectCanvasPageSceneOverlay', () => {
  it('re-publishes the mounted selection rect elements after the overlay remounts', () => {
    const onSelectionRectElementsChange = vi.fn()

    const { rerender } = render(
      <ProjectCanvasPageSceneOverlay
        annotationColor="#6366f1"
        annotationFillOpacity={0}
        drawingState={null}
        exactSelectedGroup={null}
        isFillableShape={() => false}
        onSelectionRectElementsChange={onSelectionRectElementsChange}
        selectionOverlayGroups={[]}
        selectionRect={null}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        tool="select"
      />
    )

    const firstPublish = onSelectionRectElementsChange.mock.calls.find(
      ([value]) => value?.svg instanceof SVGSVGElement && value?.rect?.tagName === 'rect'
    )?.[0] as { svg: SVGSVGElement; rect: SVGRectElement } | undefined

    expect(firstPublish).toBeDefined()

    rerender(<div data-testid="overlay-unmounted" />)
    rerender(
      <ProjectCanvasPageSceneOverlay
        annotationColor="#6366f1"
        annotationFillOpacity={0}
        drawingState={null}
        exactSelectedGroup={null}
        isFillableShape={() => false}
        onSelectionRectElementsChange={onSelectionRectElementsChange}
        selectionOverlayGroups={[]}
        selectionRect={null}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        tool="select"
      />
    )

    const publishedElementCalls = onSelectionRectElementsChange.mock.calls
      .map(([value]) => value)
      .filter(
        (value): value is { svg: SVGSVGElement; rect: SVGRectElement } =>
          value?.svg instanceof SVGSVGElement && value?.rect?.tagName === 'rect'
      )

    expect(publishedElementCalls).toHaveLength(2)
    expect(publishedElementCalls[1]).not.toBe(firstPublish)
    expect(publishedElementCalls[1].svg).not.toBe(firstPublish?.svg)
    expect(publishedElementCalls[1].rect).not.toBe(firstPublish?.rect)
  })
})
