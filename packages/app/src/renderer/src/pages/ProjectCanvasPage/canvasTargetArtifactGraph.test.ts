import { describe, expect, it } from 'vitest'

import {
  createCanvasTargetArtifactGraph,
  findCanvasTargetArtifact,
  linkCanvasTargetArtifactToCanvasItem,
  listCanvasTargetArtifacts,
  registerCanvasTargetArtifact,
  resolveCanvasTargetArtifactCanvasItemId,
  type CanvasTargetArtifact
} from './canvasTargetArtifactGraph'

function artifact(overrides: Partial<CanvasTargetArtifact> = {}): CanvasTargetArtifact {
  return {
    id: 'artifact-1',
    type: 'model_output',
    source: 'model',
    stageId: 'stage-1',
    createdAt: '2026-05-04T01:00:00.000Z',
    ...overrides
  }
}

describe('canvasTargetArtifactGraph', () => {
  it('registers and finds artifacts by stable id', () => {
    const graph = registerCanvasTargetArtifact(
      createCanvasTargetArtifactGraph(),
      artifact({
        id: 'output-1',
        type: 'image',
        source: 'model',
        stageId: 'stage-image',
        metadata: { mimeType: 'image/png' }
      })
    )

    expect(findCanvasTargetArtifact(graph, 'output-1')).toEqual({
      id: 'output-1',
      type: 'image',
      source: 'model',
      stageId: 'stage-image',
      createdAt: '2026-05-04T01:00:00.000Z',
      metadata: { mimeType: 'image/png' }
    })
  })

  it('lists artifacts in stable createdAt order with registration order as the tie breaker', () => {
    const graph = createCanvasTargetArtifactGraph([
      artifact({ id: 'third', createdAt: '2026-05-04T03:00:00.000Z' }),
      artifact({ id: 'first', createdAt: '2026-05-04T01:00:00.000Z' }),
      artifact({ id: 'tie-a', createdAt: '2026-05-04T02:00:00.000Z' }),
      artifact({ id: 'tie-b', createdAt: '2026-05-04T02:00:00.000Z' })
    ])

    expect(listCanvasTargetArtifacts(graph).map((item) => item.id)).toEqual([
      'first',
      'tie-a',
      'tie-b',
      'third'
    ])
  })

  it('links artifacts to canvas item ids and resolves the linked item id', () => {
    const graph = registerCanvasTargetArtifact(
      createCanvasTargetArtifactGraph(),
      artifact({ id: 'canvas-artifact', type: 'canvas_item' })
    )

    const linkedGraph = linkCanvasTargetArtifactToCanvasItem(
      graph,
      'canvas-artifact',
      'canvas-item-1'
    )

    expect(resolveCanvasTargetArtifactCanvasItemId(linkedGraph, 'canvas-artifact')).toBe(
      'canvas-item-1'
    )
    expect(findCanvasTargetArtifact(graph, 'canvas-artifact')?.canvasItemId).toBeUndefined()
  })

  it('filters artifacts by source, stage and type without inferring semantic type', () => {
    const graph = createCanvasTargetArtifactGraph([
      artifact({ id: 'input-text', type: 'user_input', source: 'user', stageId: 'stage-1' }),
      artifact({ id: 'model-json', type: 'json', source: 'model', stageId: 'stage-1' }),
      artifact({ id: 'model-image', type: 'image', source: 'model', stageId: 'stage-2' }),
      artifact({
        id: 'quickapp-table',
        type: 'table',
        source: 'quickapp',
        stageId: 'stage-2'
      })
    ])

    expect(listCanvasTargetArtifacts(graph, { source: 'model' }).map((item) => item.id)).toEqual([
      'model-json',
      'model-image'
    ])
    expect(listCanvasTargetArtifacts(graph, { stageId: 'stage-2' }).map((item) => item.id)).toEqual(
      ['model-image', 'quickapp-table']
    )
    expect(listCanvasTargetArtifacts(graph, { type: 'image' }).map((item) => item.id)).toEqual([
      'model-image'
    ])
    expect(
      listCanvasTargetArtifacts(graph, {
        source: 'model',
        stageId: 'stage-1',
        type: 'json'
      }).map((item) => item.id)
    ).toEqual(['model-json'])
  })

  it('updates and deduplicates repeated artifact ids', () => {
    const graph = createCanvasTargetArtifactGraph([
      artifact({
        id: 'same-id',
        type: 'text',
        source: 'model',
        stageId: 'stage-1',
        metadata: { revision: 1 }
      }),
      artifact({
        id: 'same-id',
        type: 'image',
        source: 'model',
        stageId: 'stage-2',
        canvasItemId: 'canvas-item-2',
        metadata: { revision: 2 }
      })
    ])

    expect(listCanvasTargetArtifacts(graph)).toEqual([
      {
        id: 'same-id',
        type: 'image',
        source: 'model',
        stageId: 'stage-2',
        createdAt: '2026-05-04T01:00:00.000Z',
        canvasItemId: 'canvas-item-2',
        metadata: { revision: 2 }
      }
    ])
    expect(graph.artifactOrder).toEqual(['same-id'])
  })

  it('returns undefined for missing artifact lookups', () => {
    const graph = createCanvasTargetArtifactGraph()

    expect(findCanvasTargetArtifact(graph, 'missing')).toBeUndefined()
    expect(resolveCanvasTargetArtifactCanvasItemId(graph, 'missing')).toBeUndefined()
  })
})
