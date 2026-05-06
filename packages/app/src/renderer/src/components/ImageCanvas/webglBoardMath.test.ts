import { describe, expect, it } from 'vitest'
import { fitCameraToBounds, getBounds, screenToWorld, zoomCameraAtPoint } from './webglBoardMath'

describe('webglBoardMath', () => {
  it('computes the combined bounds of multiple items', () => {
    expect(
      getBounds([
        { x: 10, y: 20, width: 100, height: 80 },
        { x: -40, y: 5, width: 20, height: 20 },
        { x: 50, y: 150, width: 60, height: 30 }
      ])
    ).toEqual({
      x: -40,
      y: 5,
      width: 150,
      height: 175
    })
  })

  it('fits camera to bounds with padding', () => {
    expect(
      fitCameraToBounds({ width: 800, height: 600 }, { x: 100, y: 50, width: 200, height: 100 }, 40)
    ).toEqual({
      scale: 3.6,
      x: -320,
      y: -60
    })
  })

  it('preserves the world point under the cursor when zooming', () => {
    const camera = { x: 20, y: 30, scale: 2 }
    const pointer = { x: 320, y: 210 }

    const before = screenToWorld(camera, pointer)
    const afterCamera = zoomCameraAtPoint(camera, pointer, 1.5, 0.25, 8)
    const after = screenToWorld(afterCamera, pointer)

    expect(after).toEqual(before)
  })
})
