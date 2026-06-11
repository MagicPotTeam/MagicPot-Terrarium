import { describe, expect, it } from 'vitest'

import type { CanvasModel3DItem } from '../types'
import {
  areCanvas3DStagePropsEqual,
  areCanvas3DStageRenderKickPropsEqual
} from './canvas3DStageMemo'

const createItem = (id: string): CanvasModel3DItem => ({
  id,
  type: 'model3d',
  src: `file:///${id}.glb`,
  fileName: `${id}.glb`,
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  zIndex: 1,
  locked: false
})

describe('canvas3DStageMemo', () => {
  it('treats identical stage props as equal even when selectedIds is a new set instance', () => {
    const items = [createItem('model-a'), createItem('model-b')]

    expect(
      areCanvas3DStagePropsEqual(
        {
          items,
          selectedIds: new Set(['model-a']),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        },
        {
          items: [...items],
          selectedIds: new Set(['model-a']),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        }
      )
    ).toBe(true)
  })

  it('detects stage prop changes that require rerendering', () => {
    const firstItem = createItem('model-a')
    const secondItem = createItem('model-b')

    expect(
      areCanvas3DStagePropsEqual(
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        },
        {
          items: [secondItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        }
      )
    ).toBe(false)

    expect(
      areCanvas3DStagePropsEqual(
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        },
        {
          items: [firstItem],
          selectedIds: new Set(['model-a']),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        }
      )
    ).toBe(false)

    expect(
      areCanvas3DStagePropsEqual(
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        },
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 32, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 }
        }
      )
    ).toBe(false)

    expect(
      areCanvas3DStagePropsEqual(
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 },
          onViewportSyncReady: () => undefined
        },
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 },
          onViewportSyncReady: () => undefined
        }
      )
    ).toBe(false)

    expect(
      areCanvas3DStagePropsEqual(
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 },
          isViewportInteracting: false
        },
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 },
          isViewportInteracting: true
        }
      )
    ).toBe(false)

    expect(
      areCanvas3DStagePropsEqual(
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 },
          isPerformanceThrottled: false
        },
        {
          items: [firstItem],
          selectedIds: new Set<string>(),
          stagePos: { x: 0, y: 0 },
          stageScale: 1,
          stageSize: { width: 1280, height: 720 },
          isPerformanceThrottled: true
        }
      )
    ).toBe(false)
  })

  it('only restarts the render pump when the load version or pump frames change', () => {
    expect(
      areCanvas3DStageRenderKickPropsEqual(
        {
          loadStateVersion: 4,
          renderPumpFrames: 2
        },
        {
          loadStateVersion: 4,
          renderPumpFrames: 2
        }
      )
    ).toBe(true)

    expect(
      areCanvas3DStageRenderKickPropsEqual(
        {
          loadStateVersion: 4,
          renderPumpFrames: 2
        },
        {
          loadStateVersion: 5,
          renderPumpFrames: 2
        }
      )
    ).toBe(false)

    expect(
      areCanvas3DStageRenderKickPropsEqual(
        {
          loadStateVersion: 4,
          renderPumpFrames: 2
        },
        {
          loadStateVersion: 4,
          renderPumpFrames: 3
        }
      )
    ).toBe(false)
  })
})
