import { describe, expect, it } from 'vitest'

import { resolveCanvas3DStageFreezeFrameTransform } from './Canvas3DStage'

describe('resolveCanvas3DStageFreezeFrameTransform', () => {
  it('maps the frozen stage frame through the current pan and zoom delta', () => {
    expect(
      resolveCanvas3DStageFreezeFrameTransform({
        snapshotViewport: {
          stagePos: { x: 240, y: 180 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        },
        currentViewport: {
          stagePos: { x: 300, y: 260 },
          stageScale: 1.5,
          stageSize: { width: 1280, height: 720 }
        }
      })
    ).toEqual({
      scale: 1.5,
      translateX: -60,
      translateY: -10,
      transform: 'matrix(1.5, 0, 0, 1.5, -60, -10)'
    })
  })

  it('disables freeze-frame transforms when the stage viewport size changes', () => {
    expect(
      resolveCanvas3DStageFreezeFrameTransform({
        snapshotViewport: {
          stagePos: { x: 240, y: 180 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        },
        currentViewport: {
          stagePos: { x: 260, y: 200 },
          stageScale: 1.1,
          stageSize: { width: 1366, height: 768 }
        }
      })
    ).toBeNull()
  })
})
