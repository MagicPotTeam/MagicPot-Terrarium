import { describe, expect, it } from 'vitest'
import {
  GRAPH_V2_FIRST_PARTY_NODE_REGISTRY,
  convertGraphDefinitionV1ToV2Draft
} from '../../../shared/magicAgentPlatform2'
import type { MagicAgentGraphDefinition } from '../../../shared/magicAgent/graphTypes'
import { MagicAgentGraphRuntime } from './MagicAgentGraphRuntime'
import {
  compileGraphDefinitionV2ForRuntime,
  compileGraphDefinitionV2WithSubgraphs
} from './graphDefinitionV2Runtime'

const legacyGraph: MagicAgentGraphDefinition = {
  graphId: 'graph-v2-runtime',
  name: 'Graph V2 runtime',
  description: 'Runtime compatibility fixture',
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

describe('GraphDefinition V2 runtime compiler', () => {
  it('validates V2 authoring state and emits the executable compatibility snapshot', () => {
    const draft = convertGraphDefinitionV1ToV2Draft(legacyGraph)
    const plan = compileGraphDefinitionV2ForRuntime(draft)
    expect(plan.executableGraph).toEqual(legacyGraph)
    expect(plan.nodeIds).toEqual(['start', 'finish'])
    expect(plan.edgeIds).toEqual(['start-finish'])
    expect(plan.warnings).toEqual([])
  })

  it('rejects invalid V2 endpoint references before runtime execution', () => {
    const draft = convertGraphDefinitionV1ToV2Draft(legacyGraph)
    expect(() =>
      compileGraphDefinitionV2ForRuntime({
        ...draft,
        edges: [
          {
            ...draft.edges[0],
            target: { nodeId: 'missing', portId: draft.edges[0].target.portId }
          }
        ]
      })
    ).toThrow(/missing target node|must reference an existing node|referenced node does not exist/i)
  })
  it.each([
    ['input', 'input'],
    ['condition', 'condition'],
    ['merge', 'merge'],
    ['output', 'output'],
    ['agent', 'agent'],
    ['tool', 'tool']
  ] as const)('compiles supported %s nodes to the existing V1 %s operation', (kind, legacyKind) => {
    const base = convertGraphDefinitionV1ToV2Draft(legacyGraph)
    const descriptor = GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.find((item) => item.kind === kind)!
    const node = {
      nodeId: `node-${kind}`,
      kind,
      name: kind,
      description: kind,
      position: { x: 0, y: 0 },
      inputs: descriptor.defaultInputs,
      outputs: descriptor.defaultOutputs,
      config: kind === 'tool' ? { toolName: 'production.tool' } : descriptor.defaultConfig
    }
    const plan = compileGraphDefinitionV2ForRuntime({
      ...base,
      nodes: [node],
      edges: [],
      entryNodeIds: [node.nodeId],
      outputs: [],
      legacySnapshot: {
        ...legacyGraph,
        entryNodeIds: [node.nodeId],
        nodes: [
          {
            nodeId: node.nodeId,
            kind: legacyKind,
            name: node.name,
            description: node.description
          }
        ],
        channels: [],
        outputs: [
          {
            outputId: 'result',
            name: 'Result',
            description: 'Result',
            sourceNodeId: node.nodeId
          }
        ]
      }
    })
    expect(plan.executableGraph.nodes).toEqual([expect.objectContaining({ kind: legacyKind })])
  })

  it('fails unsupported and unconfigured nodes during preflight with precise reasons', () => {
    const base = convertGraphDefinitionV1ToV2Draft(legacyGraph)
    const tool = GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.find((item) => item.kind === 'tool')!
    expect(() =>
      compileGraphDefinitionV2ForRuntime({
        ...base,
        nodes: [
          {
            ...base.nodes[0],
            kind: 'tool',
            inputs: tool.defaultInputs,
            outputs: tool.defaultOutputs,
            config: tool.defaultConfig
          }
        ]
      })
    ).toThrow('Graph V2 node start (tool): Required tool config field is unconfigured: toolName.')

    const llm = GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.find((item) => item.kind === 'llm')!
    expect(() =>
      compileGraphDefinitionV2ForRuntime({
        ...base,
        nodes: [
          {
            ...base.nodes[0],
            kind: 'llm',
            inputs: llm.defaultInputs,
            outputs: llm.defaultOutputs,
            config: { model: 'configured', systemPrompt: '' }
          }
        ]
      })
    ).toThrow(
      `Graph V2 node start (llm): ${llm.execution.mode === 'unsupported' ? llm.execution.reason : ''}`
    )
  })

  it('inlines declared child ports and executes a nontrivial reusable subgraph', async () => {
    const child = convertGraphDefinitionV1ToV2Draft({
      graphId: 'child',
      name: 'Child',
      description: 'Reusable child',
      version: '1.0.0',
      tags: [],
      entryNodeIds: ['worker'],
      nodes: [
        { nodeId: 'worker', kind: 'agent', name: 'Worker', description: 'Transforms input' },
        { nodeId: 'publish', kind: 'output', name: 'Publish', description: 'Publishes output' }
      ],
      channels: [
        {
          channelId: 'worker-publish',
          from: 'worker',
          to: 'publish',
          kind: 'control',
          required: true
        }
      ],
      outputs: [
        {
          outputId: 'child-result',
          name: 'Child result',
          description: 'Result',
          sourceNodeId: 'publish'
        }
      ]
    })
    const parentDraft = convertGraphDefinitionV1ToV2Draft({
      graphId: 'parent',
      name: 'Parent',
      description: 'Parent graph',
      version: '1.0.0',
      tags: [],
      entryNodeIds: ['start'],
      nodes: [
        { nodeId: 'start', kind: 'input', name: 'Start', description: 'Input' },
        { nodeId: 'reusable', kind: 'agent', name: 'Reusable', description: 'Child placeholder' },
        { nodeId: 'finish', kind: 'output', name: 'Finish', description: 'Output' }
      ],
      channels: [
        {
          channelId: 'start-reusable',
          from: 'start',
          to: 'reusable',
          kind: 'control',
          required: true
        },
        {
          channelId: 'reusable-finish',
          from: 'reusable',
          to: 'finish',
          kind: 'control',
          required: true
        }
      ],
      outputs: [
        { outputId: 'result', name: 'Result', description: 'Result', sourceNodeId: 'finish' }
      ]
    })
    const placeholder = parentDraft.nodes.find((node) => node.nodeId === 'reusable')!
    const childWithBoundary = {
      ...child,
      nodes: child.nodes.map((node) => {
        if (node.nodeId === 'worker') return { ...node, inputs: placeholder.inputs }
        if (node.nodeId === 'publish')
          return {
            ...node,
            outputs: node.outputs.map((port) => ({
              ...port,
              role: placeholder.outputs[0].role,
              valueType: placeholder.outputs[0].valueType
            }))
          }
        return node
      })
    }
    const graph = {
      ...parentDraft,
      nodes: parentDraft.nodes.map((node) =>
        node.nodeId === 'reusable'
          ? {
              ...node,
              kind: 'subgraph' as const,
              config: { graphId: child.graphId, version: child.version },
              subgraphRef: {
                graphId: child.graphId,
                version: child.version,
                inputMappings: { [placeholder.inputs[0].portId]: 'worker' },
                outputMappings: { [placeholder.outputs[0].portId]: 'child-result' }
              }
            }
          : node
      )
    }

    const plan = await compileGraphDefinitionV2WithSubgraphs(graph, async () => childWithBoundary)
    expect(plan.executableGraph.nodes.map((node) => node.nodeId)).toEqual([
      'start',
      'finish',
      'reusable::worker',
      'reusable::publish'
    ])
    expect(plan.executableGraph.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'start', to: 'reusable::worker' }),
        expect.objectContaining({ from: 'reusable::worker', to: 'reusable::publish' }),
        expect.objectContaining({ from: 'reusable::publish', to: 'finish' })
      ])
    )
    expect(placeholder.inputs[0].portId).not.toBe('subgraph-input')

    const runtime = new MagicAgentGraphRuntime([])
    runtime.create({
      graph: plan.executableGraph,
      route: { channel: 'test', scopeType: 'dm', scopeId: 'subgraph' }
    })
    const result = await runtime.run({
      graphId: 'parent',
      input: 'execute reusable child',
      route: { channel: 'test', scopeType: 'dm', scopeId: 'subgraph' }
    })
    expect(result.status).toBe('completed')
    expect(result.outputs[0]?.content).toContain('execute reusable child')
  })

  it('rejects missing subgraph versions and mappings without weakening contracts', async () => {
    const base = convertGraphDefinitionV1ToV2Draft(legacyGraph)
    const descriptor = GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.find((item) => item.kind === 'subgraph')!
    const subgraph = {
      ...base.nodes[0],
      kind: 'subgraph' as const,
      inputs: descriptor.defaultInputs,
      outputs: descriptor.defaultOutputs,
      config: { graphId: 'child', version: '' },
      subgraphRef: { graphId: 'child', version: '', inputMappings: {}, outputMappings: {} }
    }
    await expect(
      compileGraphDefinitionV2WithSubgraphs(
        { ...base, nodes: [subgraph], edges: [], entryNodeIds: ['start'] },
        async () => undefined
      )
    ).rejects.toThrow(/trim-non-empty|required/i)
  })

  it('does not mutate legacy V1 or V2 snapshots while compiling', () => {
    const draft = convertGraphDefinitionV1ToV2Draft(legacyGraph)
    const v1Snapshot = structuredClone(legacyGraph)
    const v2Snapshot = structuredClone(draft)
    compileGraphDefinitionV2ForRuntime(draft)
    expect(legacyGraph).toEqual(v1Snapshot)
    expect(draft).toEqual(v2Snapshot)
  })
})
