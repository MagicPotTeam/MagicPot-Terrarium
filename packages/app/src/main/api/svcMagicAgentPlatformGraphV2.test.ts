import { beforeAll, describe, expect, it, vi } from 'vitest'
import { convertGraphDefinitionV1ToV2Draft } from '../../shared/magicAgentPlatform2'
import type { MagicAgentGraphDefinition } from '../../shared/magicAgent/graphTypes'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => process.cwd() } }))

let MagicAgentPlatformSvcImpl: typeof import('./svcMagicAgentPlatformImpl').MagicAgentPlatformSvcImpl
beforeAll(async () => {
  process.env.MAGICPOT_MAGICAGENT_PLATFORM = '1'
  ;({ MagicAgentPlatformSvcImpl } = await import('./svcMagicAgentPlatformImpl'))
})

const graph: MagicAgentGraphDefinition = {
  graphId: 'service-v2',
  name: 'Service V2',
  description: 'Service API fixture',
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

const route = { channel: 'generic', scopeType: 'dm', scopeId: 'service-v2' }

describe('MagicAgentPlatformSvcImpl Graph V2 API', () => {
  it('saves and reads V2 definitions through the production graph store boundary', async () => {
    const draft = convertGraphDefinitionV1ToV2Draft(graph)
    const saveV2 = vi.fn(async () => graph)
    const getV2 = vi.fn(async () => draft)
    const create = vi.fn(() => graph)
    const service = new MagicAgentPlatformSvcImpl({
      userGraphStore: { saveV2, getV2 } as never,
      graphRuntime: { create } as never
    })
    await expect(service.saveGraphV2({ graph: draft, route, replace: true })).resolves.toEqual({
      graph,
      definitionV2: draft
    })
    expect(saveV2).toHaveBeenCalledWith(draft, { route, replace: true })
    expect(create).toHaveBeenCalledWith({ graph, route, replace: true })
    await expect(service.getGraphV2({ graphId: graph.graphId, route })).resolves.toEqual({
      definitionV2: draft
    })
  })

  it('compiles an inline V2 definition before production graph execution', async () => {
    const draft = convertGraphDefinitionV1ToV2Draft(graph)
    const saveV2 = vi.fn(async () => graph)
    const create = vi.fn(() => graph)
    const run = vi.fn(async () => ({
      runId: 'run-v2',
      graphId: graph.graphId,
      status: 'completed'
    }))
    const service = new MagicAgentPlatformSvcImpl({
      userGraphStore: { saveV2 } as never,
      graphRuntime: { create, get: vi.fn(() => graph), run } as never
    })
    await expect(
      service.runGraph({ graphId: graph.graphId, route, input: '', definitionV2: draft })
    ).resolves.toMatchObject({ runId: 'run-v2', status: 'completed' })
    expect(saveV2).toHaveBeenCalledWith(draft, { route, replace: true })
    expect(create).toHaveBeenCalledWith({ graph, route, replace: true })
    expect(run).toHaveBeenCalled()
  })
})
