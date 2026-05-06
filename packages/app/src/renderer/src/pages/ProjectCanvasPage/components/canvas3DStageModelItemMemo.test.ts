import { describe, expect, it } from 'vitest'

import type { CanvasModel3DItem } from '../types'
import { getCanvas3DStageItemDisplayMetrics } from './canvas3DStageLoadQueue'
import {
  areCanvas3DStageModelItemRenderStatesEqual,
  resolveCanvas3DStagePreviewItem
} from './canvas3DStageModelItemMemo'

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

describe('resolveCanvas3DStagePreviewItem', () => {
  it('keeps the original item when there is no live preview', () => {
    const item = createItem('model-preview')

    expect(resolveCanvas3DStagePreviewItem(item, null)).toBe(item)
  })

  it('applies live preview transforms to the rendered 3d item footprint', () => {
    const item = createItem('model-preview')
    const renderItem = resolveCanvas3DStagePreviewItem(item, {
      x: 24,
      y: 36,
      rotation: 28,
      scaleX: 1.5,
      scaleY: 0.5
    })

    expect(renderItem).toEqual({
      ...item,
      x: 24,
      y: 36,
      rotation: 28,
      scaleX: 1.5,
      scaleY: 0.5
    })
    expect(getCanvas3DStageItemDisplayMetrics(renderItem, 1)).toMatchObject({
      canvasWidth: 300,
      canvasHeight: 100,
      displayWidth: 300,
      displayHeight: 100
    })
  })
})

describe('canvas3DStageModelItemMemo', () => {
  it('treats identical render state as equal', () => {
    const item = createItem('model-a')

    expect(
      areCanvas3DStageModelItemRenderStatesEqual(
        {
          item,
          preview: null,
          isSelected: false,
          stageScale: 1,
          isFullModelActivated: true,
          shouldMountFullModel: true
        },
        {
          item,
          preview: null,
          isSelected: false,
          stageScale: 1,
          isFullModelActivated: true,
          shouldMountFullModel: true
        }
      )
    ).toBe(true)
  })

  it('detects changes that require rerendering', () => {
    const item = createItem('model-a')
    const nextItem = createItem('model-b')

    expect(
      areCanvas3DStageModelItemRenderStatesEqual(
        {
          item,
          preview: null,
          isSelected: false,
          stageScale: 1,
          isFullModelActivated: true,
          shouldMountFullModel: true
        },
        {
          item: nextItem,
          preview: null,
          isSelected: false,
          stageScale: 1,
          isFullModelActivated: true,
          shouldMountFullModel: true
        }
      )
    ).toBe(false)

    expect(
      areCanvas3DStageModelItemRenderStatesEqual(
        {
          item,
          preview: null,
          isSelected: false,
          stageScale: 1,
          isFullModelActivated: true,
          shouldMountFullModel: true
        },
        {
          item,
          preview: null,
          isSelected: true,
          stageScale: 1,
          isFullModelActivated: true,
          shouldMountFullModel: true
        }
      )
    ).toBe(false)

    expect(
      areCanvas3DStageModelItemRenderStatesEqual(
        {
          item,
          preview: null,
          isSelected: false,
          stageScale: 1,
          isFullModelActivated: true,
          shouldMountFullModel: true
        },
        {
          item,
          preview: null,
          isSelected: false,
          stageScale: 0.75,
          isFullModelActivated: true,
          shouldMountFullModel: true
        }
      )
    ).toBe(false)

    expect(
      areCanvas3DStageModelItemRenderStatesEqual(
        {
          item,
          preview: null,
          isSelected: false,
          stageScale: 1,
          isFullModelActivated: true,
          shouldMountFullModel: true
        },
        {
          item,
          preview: {
            x: 24,
            y: 36,
            rotation: 0,
            scaleX: 1,
            scaleY: 1
          },
          isSelected: false,
          stageScale: 1,
          isFullModelActivated: true,
          shouldMountFullModel: true
        }
      )
    ).toBe(false)
  })
})
