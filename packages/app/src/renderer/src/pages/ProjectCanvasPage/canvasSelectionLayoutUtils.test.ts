import { describe, expect, it } from 'vitest'

import {
  getSelectionActionStackPosition,
  resolveSelectionActionToolbarPosition
} from './canvasSelectionLayoutUtils'

describe('canvasSelectionLayoutUtils', () => {
  it('places the selection toolbar above the bounds when there is enough room', () => {
    const position = getSelectionActionStackPosition(
      { minX: 120, minY: 180, maxX: 220, maxY: 260 },
      { width: 800, height: 600 }
    )

    expect(position.left).toBe(170)
    expect(position.top).toBeLessThan(180)
  })

  it('falls back below the bounds when the selection is too close to the top edge', () => {
    const position = getSelectionActionStackPosition(
      { minX: 40, minY: 20, maxX: 140, maxY: 100 },
      { width: 800, height: 600 }
    )

    expect(position.top).toBeGreaterThanOrEqual(112)
  })

  it('supports preferring the lower placement when requested', () => {
    const position = getSelectionActionStackPosition(
      { minX: 80, minY: 120, maxX: 260, maxY: 192 },
      { width: 800, height: 600 },
      undefined,
      undefined,
      'below'
    )

    expect(position.top).toBeGreaterThanOrEqual(204)
  })

  it('shifts the toolbar horizontally to avoid overlapping protected annotation bounds', () => {
    const position = resolveSelectionActionToolbarPosition(
      { minX: 320, minY: 20, maxX: 540, maxY: 140 },
      { width: 900, height: 600 },
      {
        toolbarWidth: 360,
        toolbarHeight: 44,
        avoidRects: [
          {
            minX: 360,
            minY: 160,
            maxX: 480,
            maxY: 208
          }
        ]
      }
    )

    expect(position.top).toBeGreaterThanOrEqual(152)
    expect(position.left).toBeGreaterThan(600)
  })
})
