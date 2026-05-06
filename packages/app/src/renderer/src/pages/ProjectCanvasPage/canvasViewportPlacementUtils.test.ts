import { describe, expect, it } from 'vitest'
import {
  getCanvasViewportBounds,
  getCenteredViewportBatchPlacements,
  getCenteredViewportPosition,
  getViewportBatchGridLayout
} from './canvasViewportPlacementUtils'

describe('canvasViewportPlacementUtils', () => {
  it('computes the current viewport bounds from stage transform', () => {
    expect(getCanvasViewportBounds({ x: -200, y: -100 }, { width: 800, height: 600 }, 2)).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 300
    })
  })

  it('keeps tiny overview scales mapped to canvas coordinates instead of falling back to 1x', () => {
    expect(getCanvasViewportBounds({ x: -2, y: -1 }, { width: 800, height: 600 }, 0.00005)).toEqual(
      {
        x: 20000,
        y: 10000,
        width: 8000000,
        height: 6000000
      }
    )
  })

  it('centers a single item inside the current viewport', () => {
    expect(
      getCenteredViewportPosition(
        { x: 100, y: 50, width: 400, height: 300 },
        { width: 200, height: 120 }
      )
    ).toEqual({
      x: 200,
      y: 140
    })
  })

  it('lays out a batch as a centered grid instead of stacking items', () => {
    const placements = getCenteredViewportBatchPlacements(
      { x: 0, y: 0, width: 1200, height: 900 },
      [
        { width: 300, height: 300 },
        { width: 300, height: 300 },
        { width: 300, height: 300 },
        { width: 300, height: 300 }
      ]
    )

    expect(placements).toEqual([
      { x: 284, y: 134 },
      { x: 616, y: 134 },
      { x: 284, y: 466 },
      { x: 616, y: 466 }
    ])
  })

  it('builds a dense contact sheet for many dropped images', () => {
    const layout = getViewportBatchGridLayout(
      { x: 0, y: 0, width: 1200, height: 900 },
      Array.from({ length: 66 }, () => ({ width: 32, height: 32 })),
      { gap: 16, allowUpscale: true }
    )

    const uniqueColumns = new Set(layout.map((entry) => entry.x)).size
    const minX = Math.min(...layout.map((entry) => entry.x))
    const maxRight = Math.max(...layout.map((entry) => entry.x + entry.width))
    const minY = Math.min(...layout.map((entry) => entry.y))
    const maxBottom = Math.max(...layout.map((entry) => entry.y + entry.height))

    expect(layout).toHaveLength(66)
    expect(uniqueColumns).toBeGreaterThan(4)
    expect(layout[0]?.width).toBeGreaterThan(32)
    expect(maxRight - minX).toBeGreaterThan(900)
    expect(maxBottom - minY).toBeGreaterThan(600)
  })
})
