import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProjectCanvasPageSceneOverlay } from './ProjectCanvasPageSceneDecorations'

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
