import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useCanvasViewportPlacement } from './useCanvasViewportPlacement'

describe('useCanvasViewportPlacement', () => {
  it('uses the live stage transform refs when resolving drop points at tiny zoom', () => {
    const canvasContainer = document.createElement('div')
    canvasContainer.getBoundingClientRect = () =>
      ({
        left: 40,
        top: 80,
        right: 840,
        bottom: 680,
        width: 800,
        height: 600,
        x: 40,
        y: 80,
        toJSON: () => ({})
      }) as DOMRect

    const { result } = renderHook(() =>
      useCanvasViewportPlacement({
        stagePos: { x: 0, y: 0 },
        stagePosRef: { current: { x: -2, y: -1 } },
        stageSize: { width: 800, height: 600 },
        stageScale: 1,
        stageScaleRef: { current: 0.0005 },
        stageRef: { current: null },
        canvasContainerRef: { current: canvasContainer }
      })
    )

    expect(result.current.getCanvasPointFromClient(140, 180)).toEqual({
      x: 204000,
      y: 202000
    })
    expect(result.current.getViewportBounds()).toEqual({
      x: 4000,
      y: 2000,
      width: 1600000,
      height: 1200000
    })
  })
})
