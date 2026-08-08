import { describe, expect, it } from 'vitest'
import { convertGraphDefinitionV1ToV2Draft } from '../../../shared/magicAgentPlatform2'
import type { MagicAgentGraphDefinition } from '../../../shared/magicAgent/graphTypes'
import { MagicAgentUserGraphStore } from './userGraphStore'

const uniqueRoute = () => ({
  channel: 'sdk',
  scopeType: 'dm' as const,
  scopeId: `graph-v2-test-${Date.now()}-${Math.random()}`
})

const graph: MagicAgentGraphDefinition = {
  graphId: 'v2-persisted',
  name: 'V2 persisted',
  description: 'V2 persistence fixture',
  version: '1.0.0',
  tags: [],
  entryNodeIds: ['start'],
  nodes: [
    { nodeId: 'start', kind: 'input', name: 'Start', description: 'Input' },
    { nodeId: 'finish', kind: 'output', name: 'Finish', description: 'Output' }
  ],
  channels: [
    { channelId: 'start-finish', from: 'start', to: 'finish', kind: 'control', required: true }
  ],
  outputs: [{ outputId: 'result', name: 'Result', description: 'Result', sourceNodeId: 'finish' }]
}

const route = uniqueRoute()
const testRoot = 'graph-v2-test'

describe('MagicAgentUserGraphStore Graph V2 persistence', () => {
  it('persists V2 authoring state beside the V1-compatible runtime snapshot', async () => {
    const store = new MagicAgentUserGraphStore(testRoot)
    const draft = convertGraphDefinitionV1ToV2Draft(graph)
    const saved = await store.saveV2(draft, { route })
    expect(saved.graphId).toBe(graph.graphId)
    await expect(store.getV2(graph.graphId, route)).resolves.toEqual(draft)
    expect(await store.get(graph.graphId, route)).toMatchObject({ graphId: graph.graphId })
    expect(await store.getV2(graph.graphId, route)).toMatchObject({
      graphId: graph.graphId,
      legacySnapshot: { graphId: graph.graphId }
    })
  })

  it('persists and reopens visual annotations exactly while accepting legacy sidecars without them', async () => {
    const annotatedRoute = uniqueRoute()
    const store = new MagicAgentUserGraphStore(testRoot)
    const draft = {
      ...convertGraphDefinitionV1ToV2Draft(graph),
      visualAnnotations: {
        groups: [{ groupId: 'main', title: 'Main', nodeIds: ['start', 'finish'], color: '#abc' }],
        notes: [{ noteId: 'note', text: 'Keep this', position: { x: 12, y: 34 } }],
        reroutes: [{ edgeId: 'start-finish', points: [{ x: 56, y: 78 }] }]
      }
    }
    await store.saveV2(draft, { route: annotatedRoute })
    const reopened = new MagicAgentUserGraphStore(testRoot)
    await expect(reopened.getV2(graph.graphId, annotatedRoute)).resolves.toEqual(draft)

    const legacyRoute = uniqueRoute()
    const legacyDraft = convertGraphDefinitionV1ToV2Draft({
      ...graph,
      graphId: 'v2-no-annotations'
    })
    await store.saveV2(legacyDraft, { route: legacyRoute })
    await expect(reopened.getV2(legacyDraft.graphId, legacyRoute)).resolves.toEqual(legacyDraft)
    expect(
      (await reopened.getV2(legacyDraft.graphId, legacyRoute))?.visualAnnotations
    ).toBeUndefined()
  })

  it('returns undefined for graphs without a V2 sidecar', async () => {
    const store = new MagicAgentUserGraphStore('graph-v1-test')
    const v1Route = uniqueRoute()
    await store.save({ graph, route: v1Route })
    await expect(store.getV2(graph.graphId, v1Route)).resolves.toBeUndefined()
  })
})
