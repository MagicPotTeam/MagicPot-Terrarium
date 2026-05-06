import { describe, expect, it } from 'vitest'

import type { CanvasModel3DItem } from '../types'
import {
  areCanvas3DStageIdSetsEqual,
  getCanvas3DStageItemDisplayMetrics,
  resolveCanvas3DStageActivatedIds,
  resolveCanvas3DStageActivationBatchPolicy,
  resolveCanvas3DStageImmediateLoadLimit,
  resolveCanvas3DStageLoadQueue,
  resolveCanvas3DStageNextActivationBatch,
  getCanvas3DStageModelLoadComplexity
} from './canvas3DStageLoadQueue'

function createModelItem(
  id: string,
  overrides: Partial<CanvasModel3DItem> = {}
): CanvasModel3DItem {
  return {
    id,
    type: 'model3d',
    src: `file:///${id}.glb`,
    fileName: `${id}.glb`,
    x: 0,
    y: 0,
    width: 200,
    height: 160,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

describe('canvas3DStageLoadQueue', () => {
  it('computes on-screen display size from canvas geometry and stage scale', () => {
    expect(
      getCanvas3DStageItemDisplayMetrics(
        createModelItem('model-1', { width: 240, height: 120, scaleX: 1.5, scaleY: 0.5 }),
        0.5
      )
    ).toMatchObject({
      canvasWidth: 360,
      canvasHeight: 60,
      displayWidth: 180,
      displayHeight: 30,
      displayArea: 5400
    })
  })

  it('keeps tiny visible models on the preview/load path instead of forcing placeholders', () => {
    const { prioritizedLoadIds, placeholderOnlyIds, immediateLoadLimit } =
      resolveCanvas3DStageLoadQueue({
        items: [
          createModelItem('tiny', { width: 40, height: 40 }),
          createModelItem('large', { width: 600, height: 400, zIndex: 2 }),
          createModelItem('selected-medium', { width: 220, height: 180 })
        ],
        selectedIds: new Set(['selected-medium']),
        stageScale: 1
      })

    expect(prioritizedLoadIds).toEqual(['selected-medium', 'large', 'tiny'])
    expect([...placeholderOnlyIds]).toEqual([])
    expect(immediateLoadLimit).toBe(3)
  })

  it('keeps models loadable at low zoom so their visuals match normal zoom', () => {
    const { prioritizedLoadIds, placeholderOnlyIds } = resolveCanvas3DStageLoadQueue({
      items: [createModelItem('low-zoom-model', { width: 200, height: 160 })],
      selectedIds: new Set(),
      stageScale: 0.09
    })

    expect(prioritizedLoadIds).toEqual(['low-zoom-model'])
    expect([...placeholderOnlyIds]).toEqual([])
  })

  it('prioritizes lighter model formats ahead of heavier ones within the same selection tier', () => {
    const { prioritizedLoadIds } = resolveCanvas3DStageLoadQueue({
      items: [
        createModelItem('heavy-fbx', { fileName: 'heavy-fbx.fbx', width: 640, height: 480 }),
        createModelItem('medium-obj', { fileName: 'medium-obj.obj', width: 320, height: 240 }),
        createModelItem('light-glb', { fileName: 'light-glb.glb', width: 280, height: 220 })
      ],
      selectedIds: new Set(),
      stageScale: 1
    })

    expect(prioritizedLoadIds).toEqual(['light-glb', 'medium-obj', 'heavy-fbx'])
  })

  it('preserves already activated visible ids while seeding the immediate load limit', () => {
    const activatedIds = resolveCanvas3DStageActivatedIds({
      prioritizedLoadIds: ['selected', 'large', 'medium', 'small', 'tail'],
      previousActivatedIds: new Set(['medium', 'stale-id']),
      immediateLoadLimit: 2
    })

    expect([...activatedIds].sort()).toEqual(['large', 'medium', 'selected'])
  })

  it('returns the next activation batch in priority order', () => {
    expect(
      resolveCanvas3DStageNextActivationBatch({
        prioritizedLoadIds: ['a', 'b', 'c', 'd'],
        activatedIds: new Set(['a', 'c']),
        batchSize: 2
      })
    ).toEqual(['b', 'd'])
  })

  it('reduces the immediate activation limit for heavier leading models', () => {
    expect(
      resolveCanvas3DStageImmediateLoadLimit({
        prioritizedItems: [
          { loadComplexity: 6 },
          { loadComplexity: 5 },
          { loadComplexity: 5 },
          { loadComplexity: 4 }
        ]
      })
    ).toBe(1)

    expect(
      resolveCanvas3DStageImmediateLoadLimit({
        prioritizedItems: [{ loadComplexity: 2 }, { loadComplexity: 2 }, { loadComplexity: 1 }]
      })
    ).toBe(3)
  })

  it('uses smaller, slower activation batches for heavier pending models', () => {
    expect(
      resolveCanvas3DStageActivationBatchPolicy({
        prioritizedItems: [
          { id: 'heavy-fbx', loadComplexity: 5 },
          { id: 'heavy-obj', loadComplexity: 4 }
        ],
        activatedIds: new Set()
      })
    ).toEqual({
      batchSize: 1,
      delayMs: 140
    })

    expect(
      resolveCanvas3DStageActivationBatchPolicy({
        prioritizedItems: [
          { id: 'a', loadComplexity: 1 },
          { id: 'b', loadComplexity: 2 },
          { id: 'c', loadComplexity: 1 }
        ],
        activatedIds: new Set(['a'])
      })
    ).toEqual({
      batchSize: 2,
      delayMs: 60
    })
  })

  it('adds texture count onto base model load complexity', () => {
    expect(
      getCanvas3DStageModelLoadComplexity(
        createModelItem('textured-gltf', {
          fileName: 'textured-gltf.gltf',
          textures: {
            baseColor: 'blob:a',
            normal: 'blob:b'
          }
        })
      )
    ).toBe(4)
  })

  it('compares id sets without order sensitivity', () => {
    expect(areCanvas3DStageIdSetsEqual(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(areCanvas3DStageIdSetsEqual(new Set(['a']), new Set(['a', 'b']))).toBe(false)
  })
})
