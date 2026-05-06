import { describe, expect, it } from 'vitest'

import {
  placeNextExtractedPieceToRight,
  type ExtractedCanvasPiecePlacement
} from './canvasExtractPlacementUtils'

describe('placeNextExtractedPieceToRight', () => {
  it('starts the first extracted piece to the right of the source bounds', () => {
    const { placement, bounds } = placeNextExtractedPieceToRight(
      {
        minX: 100,
        minY: 80,
        maxX: 300,
        maxY: 240
      },
      [],
      {
        id: 'extract-1',
        width: 72,
        height: 48
      }
    )

    expect(placement).toEqual({
      id: 'extract-1',
      width: 72,
      height: 48,
      x: 348,
      y: 80
    })
    expect(bounds).toEqual({
      minX: 348,
      minY: 80,
      maxX: 420,
      maxY: 128
    })
  })

  it('preserves existing extracted placements and pushes the new piece below overlaps', () => {
    const existingPlacements: ExtractedCanvasPiecePlacement[] = [
      {
        id: 'extract-1',
        x: 348,
        y: 80,
        width: 72,
        height: 48
      },
      {
        id: 'extract-2',
        x: 500,
        y: 72,
        width: 68,
        height: 40
      }
    ]

    const { placement, bounds } = placeNextExtractedPieceToRight(
      {
        minX: 100,
        minY: 80,
        maxX: 300,
        maxY: 240
      },
      existingPlacements,
      {
        id: 'extract-3',
        width: 80,
        height: 44
      }
    )

    expect(existingPlacements).toEqual([
      {
        id: 'extract-1',
        x: 348,
        y: 80,
        width: 72,
        height: 48
      },
      {
        id: 'extract-2',
        x: 500,
        y: 72,
        width: 68,
        height: 40
      }
    ])
    expect(placement).toEqual({
      id: 'extract-3',
      width: 80,
      height: 44,
      x: 520,
      y: 128
    })
    expect(bounds).toEqual({
      minX: 520,
      minY: 128,
      maxX: 600,
      maxY: 172
    })
  })
})
