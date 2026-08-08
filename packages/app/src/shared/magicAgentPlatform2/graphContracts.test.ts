import { describe, expect, it } from 'vitest'
import type { MagicAgentGraphDefinition } from '../magicAgent/graphTypes'
import type { GraphDefinitionV2Draft } from './index'
import {
  GRAPH_DEFINITION_V2_DRAFT_KIND,
  GRAPH_RUNTIME_TOPOLOGY_SNAPSHOT_V2_KIND,
  GRAPH_SCHEMA_VERSION,
  MAGIC_AGENT_PLATFORM_2_VERSION_MATRIX,
  RUNTIME_PROTOCOL_VERSION,
  convertGraphDefinitionV1ToV2Draft,
  validateGraphDefinitionV2Draft,
  validateGraphRuntimeTopologySnapshotV2
} from './index'

const createGraph = (): MagicAgentGraphDefinition => ({
  graphId: 'contract.graph-v1',
  name: 'Contract Graph V1',
  description: 'Frozen observable V1 fields',
  version: 'legacy-version',
  tags: ['contract', 'v1'],
  nodes: [
    {
      nodeId: 'input',
      kind: 'input',
      name: 'Input',
      description: 'Input',
      config: { nested: { value: 1 } }
    },
    {
      nodeId: 'output',
      kind: 'output',
      name: 'Output',
      description: 'Output',
      config: { source: 'input' }
    }
  ],
  channels: [
    { channelId: 'message', kind: 'message', from: 'input', to: 'output' },
    { channelId: 'artifact', kind: 'artifact', from: 'input', to: 'output' }
  ],
  outputs: [{ outputId: 'answer', name: 'Answer', description: 'Answer', sourceNodeId: 'output' }],
  entryNodeIds: ['input'],
  metadata: { owner: 'contract-test' }
})

const validDraft = () => convertGraphDefinitionV1ToV2Draft(createGraph())
type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? DeepMutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T
type MutableDraft = DeepMutable<GraphDefinitionV2Draft>
const mutableDraft = (): MutableDraft => structuredClone(validDraft()) as MutableDraft
const codes = (value: unknown): string[] =>
  validateGraphDefinitionV2Draft(value).issues.map((issue) => issue.code)
const setDesignExtension = (value: unknown): MutableDraft => {
  const graph = mutableDraft()
  ;(graph.nodes[0].config as unknown as Record<string, unknown>).extension = value
  return graph
}

describe('Magic Agent Platform 2 version matrix', () => {
  it('keeps five named protocol version dimensions independent', () => {
    const matrix = MAGIC_AGENT_PLATFORM_2_VERSION_MATRIX
    expect(matrix.graphSchema).toBe(GRAPH_SCHEMA_VERSION)
    expect(matrix.runtimeProtocol).toBe(RUNTIME_PROTOCOL_VERSION)
    for (const key of [
      'graphSchema',
      'sessionStorage',
      'packageManifest',
      'runtimeProtocol',
      'sdk'
    ] as const) {
      expect(matrix[key]).toBeDefined()
    }
    expect(matrix.graphSchema).not.toBe(matrix.runtimeProtocol)
  })
})

describe('Graph V2 design validation', () => {
  it('accepts a valid independently discriminated design graph', () => {
    const graph = validDraft()
    expect(graph).toMatchObject({
      kind: GRAPH_DEFINITION_V2_DRAFT_KIND,
      graphMode: 'design',
      variables: []
    })
    expect(validateGraphDefinitionV2Draft(graph)).toEqual({ valid: true, issues: [] })
  })

  it('validates canonical visual annotations and their graph references', () => {
    const graph = mutableDraft()
    graph.visualAnnotations = {
      groups: [{ groupId: 'main', title: 'Main', nodeIds: ['input', 'output'], color: '#abc' }],
      notes: [{ noteId: 'hint', text: 'Inspect output', position: { x: 10, y: 20 } }],
      reroutes: [{ edgeId: graph.edges[0].edgeId, points: [{ x: 30, y: 40 }] }]
    }
    expect(validateGraphDefinitionV2Draft(graph)).toEqual({ valid: true, issues: [] })

    graph.visualAnnotations.groups[0].nodeIds.push('missing')
    graph.visualAnnotations.reroutes[0].edgeId = 'missing'
    graph.visualAnnotations.notes[0].position.x = Number.NaN
    expect(codes(graph)).toEqual(
      expect.arrayContaining([
        'missing-node-reference',
        'missing-edge-reference',
        'invalid-position'
      ])
    )
  })

  it('remains backward compatible when visualAnnotations is absent', () => {
    const graph = mutableDraft()
    delete graph.visualAnnotations
    expect(validateGraphDefinitionV2Draft(graph)).toEqual({ valid: true, issues: [] })
  })

  it('reports duplicate IDs and missing nodes and ports', () => {
    const graph = mutableDraft()
    graph.nodes.push(structuredClone(graph.nodes[0]))
    graph.edges.push({
      ...structuredClone(graph.edges[0]),
      edgeId: graph.edges[0].edgeId,
      source: { nodeId: 'missing', portId: 'missing' }
    })
    graph.outputs[0].source.portId = 'missing'
    expect(codes(graph)).toEqual(
      expect.arrayContaining([
        'duplicate-node-id',
        'duplicate-edge-id',
        'missing-node-reference',
        'missing-port-reference'
      ])
    )
  })

  it('enforces port direction and conservative exact role compatibility', () => {
    const graph = mutableDraft()
    graph.nodes[0].outputs[0].direction = 'input'
    graph.nodes[1].inputs[0].role = 'data'
    expect(codes(graph)).toEqual(
      expect.arrayContaining(['invalid-port-direction', 'incompatible-port-role'])
    )
  })

  it('enforces input-port multiplicity unless the target explicitly accepts multiple edges', () => {
    const graph = mutableDraft()
    graph.edges.push({
      ...structuredClone(graph.edges[0]),
      edgeId: 'second-edge'
    })
    expect(codes(graph)).toContain('input-port-multiplicity-exceeded')

    graph.nodes[1].inputs[0].multiple = true
    expect(codes(graph)).not.toContain('input-port-multiplicity-exceeded')
  })

  it('enforces value kind, schemaRef, and mediaType compatibility', () => {
    const graph = mutableDraft()
    const source = graph.nodes[0].outputs[0].valueType
    const target = graph.nodes[1].inputs[0].valueType
    source.kind = 'string'
    target.kind = 'number'
    source.schemaRef = 'schema:a'
    target.schemaRef = 'schema:b'
    source.mediaType = 'text/plain'
    target.mediaType = 'application/json'
    expect(codes(graph)).toEqual(
      expect.arrayContaining([
        'incompatible-value-kind',
        'incompatible-schemaRef',
        'incompatible-mediaType'
      ])
    )
  })

  it('allows any as the value-kind wildcard', () => {
    const graph = mutableDraft()
    graph.nodes[0].outputs[0].valueType.kind = 'any'
    graph.nodes[1].inputs[0].valueType.kind = 'future-value-kind'
    expect(validateGraphDefinitionV2Draft(graph).valid).toBe(true)
  })

  it('enforces secret and runtime variable rules', () => {
    const graph = mutableDraft()
    graph.variables = [
      {
        variableId: 'secret',
        name: 'Secret',
        scope: 'secret',
        valueType: { kind: 'string' },
        sensitive: false,
        defaultValue: 'x'
      },
      {
        variableId: 'runtime',
        name: 'Runtime',
        scope: 'runtime',
        valueType: { kind: 'any' },
        defaultValue: null
      }
    ]
    expect(codes(graph)).toEqual(
      expect.arrayContaining([
        'secret-not-sensitive',
        'secret-default-value',
        'runtime-default-value'
      ])
    )
  })

  it('validates subgraph mappings against parent ports and rejects dangerous keys', () => {
    const graph = mutableDraft()
    const dangerous = Object.create(null)
    Object.defineProperty(dangerous, '__proto__', { value: 'child', enumerable: true })
    dangerous.missing = 'child-port'
    graph.nodes[0].subgraphRef = {
      graphId: 'child',
      version: '1',
      inputMappings: dangerous,
      outputMappings: {}
    }
    expect(codes(graph)).toEqual(expect.arrayContaining(['dangerous-key', 'missing-mapping-port']))
  })

  it('never throws for getters or proxies', () => {
    const getter = Object.create(null)
    Object.defineProperty(getter, 'kind', {
      get: () => {
        throw new Error('boom')
      },
      enumerable: true
    })
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('boom')
        }
      }
    )
    expect(() => validateGraphDefinitionV2Draft(getter)).not.toThrow()
    expect(() => validateGraphDefinitionV2Draft(proxy)).not.toThrow()
    expect(validateGraphDefinitionV2Draft(getter).valid).toBe(false)
    expect(validateGraphDefinitionV2Draft(proxy).valid).toBe(false)
  })

  it('validates the basic legacy snapshot shape and graph identity', () => {
    const forged = mutableDraft()
    forged.legacySnapshot = {
      graphId: forged.graphId,
      nodes: {},
      channels: [],
      outputs: [],
      entryNodeIds: []
    } as unknown as DeepMutable<GraphDefinitionV2Draft['legacySnapshot']>
    expect(codes(forged)).toContain('invalid-array')
    const mismatch = mutableDraft()
    mismatch.legacySnapshot.graphId = 'other-graph'
    expect(codes(mismatch)).toContain('legacy-graph-id-mismatch')
  })

  it('rejects unknown deeply nested non-JSON-safe fields without throwing', () => {
    const sparse: unknown[] = []
    sparse.length = 1
    const dangerous = Object.create(null) as Record<string, unknown>
    Object.defineProperty(dangerous, '__proto__', { value: true, enumerable: true })
    const symbolValue = { safe: true }
    Object.defineProperty(symbolValue, Symbol('extra'), { value: true, enumerable: true })
    const hidden = { safe: true }
    Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle

    for (const value of [
      undefined,
      symbolValue,
      hidden,
      sparse,
      dangerous,
      () => 'no',
      Number.NaN,
      new Date(),
      cycle
    ]) {
      const graph = setDesignExtension(value)
      expect(() => validateGraphDefinitionV2Draft(graph)).not.toThrow()
      expect(codes(graph)).toContain('not-json-safe')
    }
  })

  it('accepts JSON-safe unknown extensions stored in null-prototype records', () => {
    const extension = Object.create(null) as Record<string, unknown>
    extension.future = { nested: ['value', 1, true, null] }
    expect(validateGraphDefinitionV2Draft(setDesignExtension(extension))).toEqual({
      valid: true,
      issues: []
    })
  })

  it('rejects arrays in design fields declared as records', () => {
    const cases: Array<[unknown, string]> = []

    const config = mutableDraft()
    ;(config.nodes[0] as unknown as Record<string, unknown>).config = []
    cases.push([config, '$.nodes[0].config'])

    const nodeMetadata = mutableDraft()
    ;(nodeMetadata.nodes[0] as unknown as Record<string, unknown>).metadata = []
    cases.push([nodeMetadata, '$.nodes[0].metadata'])

    const edgeMetadata = mutableDraft()
    ;(edgeMetadata.edges[0] as unknown as Record<string, unknown>).metadata = []
    cases.push([edgeMetadata, '$.edges[0].metadata'])

    const graphMetadata = mutableDraft()
    ;(graphMetadata as unknown as Record<string, unknown>).metadata = []
    cases.push([graphMetadata, '$.metadata'])

    const outputMetadata = mutableDraft()
    ;(outputMetadata.outputs[0] as unknown as Record<string, unknown>).metadata = []
    cases.push([outputMetadata, '$.outputs[0].metadata'])

    for (const [value, path] of cases) {
      expect(validateGraphDefinitionV2Draft(value).issues).toContainEqual(
        expect.objectContaining({ code: 'invalid-record', path })
      )
    }
  })

  it('accepts null-prototype records in design record fields', () => {
    const graph = mutableDraft()
    const config = Object.create(null) as Record<string, unknown>
    config.nested = { value: true }
    ;(graph.nodes[0] as unknown as Record<string, unknown>).config = config
    expect(validateGraphDefinitionV2Draft(graph).valid).toBe(true)
  })

  it('validates forged legacy snapshot fields, IDs, and references', () => {
    const cases: Array<[unknown, string]> = []
    const missingNodeField = structuredClone(validDraft()) as unknown as Record<string, unknown>
    const missingNodeSnapshot = missingNodeField.legacySnapshot as Record<string, unknown>
    const missingNode = (missingNodeSnapshot.nodes as Array<Record<string, unknown>>)[0]
    delete missingNode.kind
    cases.push([missingNodeField, 'invalid-string'])

    const missingChannelField = structuredClone(validDraft()) as unknown as Record<string, unknown>
    const missingChannelSnapshot = missingChannelField.legacySnapshot as Record<string, unknown>
    delete (missingChannelSnapshot.channels as Array<Record<string, unknown>>)[0].from
    cases.push([missingChannelField, 'invalid-string'])

    const missingOutputField = structuredClone(validDraft()) as unknown as Record<string, unknown>
    const missingOutputSnapshot = missingOutputField.legacySnapshot as Record<string, unknown>
    delete (missingOutputSnapshot.outputs as Array<Record<string, unknown>>)[0].sourceNodeId
    cases.push([missingOutputField, 'invalid-string'])

    const duplicateNode = mutableDraft()
    duplicateNode.legacySnapshot.nodes.push(structuredClone(duplicateNode.legacySnapshot.nodes[0]))
    cases.push([duplicateNode, 'duplicate-node-id'])
    const duplicateChannel = mutableDraft()
    duplicateChannel.legacySnapshot.channels.push(
      structuredClone(duplicateChannel.legacySnapshot.channels[0])
    )
    cases.push([duplicateChannel, 'duplicate-channel-id'])
    const duplicateOutput = mutableDraft()
    duplicateOutput.legacySnapshot.outputs.push(
      structuredClone(duplicateOutput.legacySnapshot.outputs[0])
    )
    cases.push([duplicateOutput, 'duplicate-output-id'])
    const danglingNode = mutableDraft()
    danglingNode.legacySnapshot.channels[0].from = 'missing'
    cases.push([danglingNode, 'missing-node-reference'])
    const danglingChannel = mutableDraft()
    danglingChannel.legacySnapshot.outputs[0].channelId = 'missing'
    cases.push([danglingChannel, 'missing-channel-reference'])

    for (const [value, code] of cases) {
      const result = validateGraphDefinitionV2Draft(value)
      expect(result.valid).toBe(false)
      expect(result.issues.map((issue) => issue.code)).toContain(code)
    }
  })

  it('independently validates legacy conditions and output channel/source alignment', () => {
    const forwardReferences = mutableDraft()
    forwardReferences.legacySnapshot.nodes[0].condition = { sourceNodeId: 'output' }
    forwardReferences.legacySnapshot.channels[0].condition = { sourceNodeId: 'output' }
    expect(validateGraphDefinitionV2Draft(forwardReferences).valid).toBe(true)

    const danglingNodeCondition = mutableDraft()
    danglingNodeCondition.legacySnapshot.nodes[0].condition = { sourceNodeId: 'missing' }

    const danglingChannelCondition = mutableDraft()
    danglingChannelCondition.legacySnapshot.channels[0].condition = { sourceNodeId: 'missing' }

    const mismatchedOutputChannel = mutableDraft()
    mismatchedOutputChannel.legacySnapshot.outputs[0].channelId = 'message'
    mismatchedOutputChannel.legacySnapshot.outputs[0].sourceNodeId = 'input'

    for (const [value, code] of [
      [danglingNodeCondition, 'missing-node-reference'],
      [danglingChannelCondition, 'missing-node-reference'],
      [mismatchedOutputChannel, 'output-channel-source-mismatch']
    ] as const) {
      const result = validateGraphDefinitionV2Draft(value)
      expect(result.valid).toBe(false)
      expect(result.issues.map((issue) => issue.code)).toContain(code)
    }
    expect(validateGraphDefinitionV2Draft(mismatchedOutputChannel).issues).toContainEqual(
      expect.objectContaining({
        code: 'output-channel-source-mismatch',
        path: '$.legacySnapshot.outputs[0].channelId'
      })
    )
  })

  it('rejects non-plain JSON-like values and cycles', () => {
    const withDate = setDesignExtension(new Date())
    expect(codes(withDate)).toContain('invalid-record')
    const withCycle = mutableDraft()
    withCycle.nodes[0].config.self = withCycle.nodes[0].config
    expect(codes(withCycle)).toContain('cyclic-value')
  })
})

describe('Graph runtime topology validation', () => {
  const runtime = () => ({
    kind: GRAPH_RUNTIME_TOPOLOGY_SNAPSHOT_V2_KIND,
    graphMode: 'runtime',
    definitionGraphId: 'graph',
    definitionVersion: '1',
    runId: 'run',
    revision: 0,
    nodes: [{ nodeId: 'a' }, { nodeId: 'b' }],
    edges: [{ edgeId: 'edge', sourceNodeId: 'a', targetNodeId: 'b' }]
  })

  it('keeps runtime and design discriminators separate', () => {
    expect(validateGraphRuntimeTopologySnapshotV2(runtime()).valid).toBe(true)
    expect(validateGraphDefinitionV2Draft(runtime()).valid).toBe(false)
    expect(validateGraphRuntimeTopologySnapshotV2(validDraft()).valid).toBe(false)
  })

  it('rejects unknown deeply nested unsafe fields and throwing proxies', () => {
    const withFunction = runtime() as unknown as Record<string, unknown>
    ;((withFunction.nodes as Array<Record<string, unknown>>)[0] as Record<string, unknown>).extra =
      {
        nested: () => 'no'
      }
    const functionResult = validateGraphRuntimeTopologySnapshotV2(withFunction)
    expect(functionResult.valid).toBe(false)
    expect(functionResult.issues.map((issue) => issue.code)).toContain('not-json-safe')

    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom')
        }
      }
    )
    const withProxy = runtime() as unknown as Record<string, unknown>
    ;(withProxy.edges as Array<Record<string, unknown>>)[0].extra = proxy
    expect(() => validateGraphRuntimeTopologySnapshotV2(withProxy)).not.toThrow()
    expect(validateGraphRuntimeTopologySnapshotV2(withProxy).valid).toBe(false)
  })

  it('rejects arrays in runtime node and edge metadata records', () => {
    for (const [collection, path] of [
      ['nodes', '$.nodes[0].metadata'],
      ['edges', '$.edges[0].metadata']
    ] as const) {
      const value = runtime() as unknown as Record<string, unknown>
      const items = value[collection] as Array<Record<string, unknown>>
      items[0].metadata = []
      expect(validateGraphRuntimeTopologySnapshotV2(value).issues).toContainEqual(
        expect.objectContaining({ code: 'invalid-record', path })
      )
    }
  })

  it('checks revision, unique IDs, and references', () => {
    const value = runtime()
    value.revision = -1
    value.nodes.push({ nodeId: 'a' })
    value.edges.push({ edgeId: 'edge', sourceNodeId: 'missing', targetNodeId: 'b' })
    const result = validateGraphRuntimeTopologySnapshotV2(value)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'invalid-revision',
        'duplicate-node-id',
        'duplicate-edge-id',
        'missing-node-reference'
      ])
    )
  })
})

describe('Graph V1 to V2 draft conversion', () => {
  it('is deterministic, input-preserving, and retains a complete detached snapshot', () => {
    const graph = createGraph()
    const before = structuredClone(graph)
    const converted = convertGraphDefinitionV1ToV2Draft(graph)
    expect(converted).toEqual(convertGraphDefinitionV1ToV2Draft(graph))
    expect(graph).toEqual(before)
    expect(converted.legacySnapshot).toEqual(graph)
    expect(converted.legacySnapshot).not.toBe(graph)
    expect(converted.nodes[0].config).not.toBe(graph.nodes[0].config)
    expect(validateGraphDefinitionV2Draft(converted).valid).toBe(true)
  })

  it('projects every channel through independent ports with mapped semantics', () => {
    const converted = convertGraphDefinitionV1ToV2Draft(createGraph())
    expect(new Set(converted.edges.map((edge) => edge.source.portId)).size).toBe(2)
    expect(new Set(converted.edges.map((edge) => edge.target.portId)).size).toBe(2)
    expect(
      converted.nodes[0].outputs.slice(0, 2).map((port) => [port.role, port.valueType.kind])
    ).toEqual([
      ['message', 'message'],
      ['data', 'artifact']
    ])
    expect(converted.outputs[0].source.portId).toContain('graph-output-answer')
  })

  it('derives entries and produces finite deterministic positions', () => {
    const graph = createGraph()
    graph.entryNodeIds = []
    const converted = convertGraphDefinitionV1ToV2Draft(graph)
    expect(converted.entryNodeIds).toEqual(['input'])
    expect(converted.nodes.map((node) => node.position)).toEqual(
      convertGraphDefinitionV1ToV2Draft(graph).nodes.map((node) => node.position)
    )
    expect(
      converted.nodes.every(
        (node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
      )
    ).toBe(true)
  })

  it('deep-clones shared plain objects but still rejects real cycles', () => {
    const shared = { nested: { value: 1 } }
    const graph = createGraph()
    graph.metadata = { shared }
    graph.nodes[0].config = { shared }
    const converted = convertGraphDefinitionV1ToV2Draft(graph)
    const convertedMetadata = converted.metadata?.legacyV1 as Record<string, unknown>
    const convertedConfig = converted.nodes[0].config.config as Record<string, unknown>
    const metadataShared = convertedMetadata.shared
    const configShared = convertedConfig.shared
    expect(metadataShared).toEqual(shared)
    expect(configShared).toEqual(shared)
    expect(metadataShared).not.toBe(shared)
    expect(configShared).not.toBe(shared)
    expect(metadataShared).not.toBe(configShared)

    const snapshotShared = converted.legacySnapshot.metadata?.shared
    const snapshotConfigShared = converted.legacySnapshot.nodes[0].config?.shared
    expect(snapshotShared).not.toBe(shared)
    expect(snapshotConfigShared).not.toBe(shared)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    graph.metadata = cyclic
    expect(() => convertGraphDefinitionV1ToV2Draft(graph)).toThrow(
      'V1 graph is not persistable JSON.'
    )
  })

  it('normalizes getter and proxy failures to the stable persistence error', () => {
    const getterGraph = createGraph()
    const getter = Object.create(null) as Record<string, unknown>
    Object.defineProperty(getter, 'boom', {
      get: () => {
        throw new Error('boom')
      },
      enumerable: true
    })
    getterGraph.metadata = getter

    const proxyGraph = createGraph()
    proxyGraph.metadata = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom')
        }
      }
    )
    for (const graph of [getterGraph, proxyGraph]) {
      try {
        convertGraphDefinitionV1ToV2Draft(graph)
        throw new Error('expected conversion to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('V1 graph is not persistable JSON.')
        expect((error as Error).message).not.toContain('boom')
      }
    }
  })

  it('preserves node, channel, output, and graph legacy fields', () => {
    const graph = createGraph()
    Object.assign(graph.nodes[0], {
      instruction: 'Do work',
      modelName: 'model',
      agentId: 'assistant',
      capabilities: ['vision'],
      toolName: 'tool',
      input: 'input-value',
      condition: { operator: 'truthy' }
    })
    Object.assign(graph.channels[0], {
      required: true,
      condition: { operator: 'equals', value: 1 },
      metadata: { trace: true }
    })
    Object.assign(graph.outputs[0], {
      channelId: 'message',
      mimeType: 'text/plain',
      metadata: { format: 'plain' }
    })
    graph.channels.push({ channelId: 'control', kind: 'control', from: 'input', to: 'output' })
    const converted = convertGraphDefinitionV1ToV2Draft(graph)
    expect(converted.nodes[0].config).toMatchObject({
      legacyV1: {
        instruction: 'Do work',
        modelName: 'model',
        agentId: 'assistant',
        capabilities: ['vision'],
        toolName: 'tool',
        input: 'input-value',
        condition: { operator: 'truthy' }
      },
      config: { nested: { value: 1 } }
    })
    expect(converted.edges[0].metadata?.legacyV1).toMatchObject({
      channelId: 'message',
      required: true,
      condition: { operator: 'equals', value: 1 },
      metadata: { trace: true }
    })
    expect(converted.edges[2].kind).toBe('control')
    expect(converted.nodes[0].outputs[2]).toMatchObject({
      role: 'control',
      valueType: { kind: 'control' }
    })
    expect(converted.outputs[0]).toMatchObject({
      source: { nodeId: 'output' },
      metadata: { legacyV1: { channelId: 'message', mimeType: 'text/plain' } }
    })
    expect(converted.metadata).toEqual({ legacyV1: graph.metadata })
  })

  it('rejects non-persistable JSON values with a stable error', () => {
    for (const invalid of [new Date(), new Map(), undefined, Number.NaN, () => 'no']) {
      const graph = createGraph()
      graph.metadata = { invalid }
      expect(() => convertGraphDefinitionV1ToV2Draft(graph)).toThrow(
        'V1 graph is not persistable JSON.'
      )
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const cyclicGraph = createGraph()
    cyclicGraph.metadata = cyclic
    expect(() => convertGraphDefinitionV1ToV2Draft(cyclicGraph)).toThrow(
      'V1 graph is not persistable JSON.'
    )
    const dangerousGraph = createGraph()
    const dangerous = Object.create(null)
    Object.defineProperty(dangerous, '__proto__', { value: 'bad', enumerable: true })
    dangerousGraph.metadata = dangerous
    expect(() => convertGraphDefinitionV1ToV2Draft(dangerousGraph)).toThrow(
      'V1 graph is not persistable JSON.'
    )
  })

  it('rejects dangling V1 condition source nodes and preserves valid conditions', () => {
    const valid = createGraph()
    valid.nodes[0].condition = { sourceNodeId: 'input', operator: 'truthy' }
    valid.channels[0].condition = { sourceNodeId: 'output', operator: 'equals', value: true }
    const converted = convertGraphDefinitionV1ToV2Draft(valid)
    expect(converted.nodes[0].config.legacyV1).toMatchObject({
      condition: valid.nodes[0].condition
    })
    expect(converted.edges[0].metadata?.legacyV1).toMatchObject({
      condition: valid.channels[0].condition
    })

    const danglingNodeCondition = createGraph()
    danglingNodeCondition.nodes[0].condition = { sourceNodeId: 'missing' }
    expect(() => convertGraphDefinitionV1ToV2Draft(danglingNodeCondition)).toThrow(
      'Graph V1 migration validation error: node input condition has dangling sourceNodeId: missing.'
    )

    const danglingChannelCondition = createGraph()
    danglingChannelCondition.channels[0].condition = { sourceNodeId: 'missing' }
    expect(() => convertGraphDefinitionV1ToV2Draft(danglingChannelCondition)).toThrow(
      'Graph V1 migration validation error: channel message condition has dangling sourceNodeId: missing.'
    )
  })

  it('requires V1 output channel targets to match output source nodes', () => {
    const valid = createGraph()
    valid.outputs[0].channelId = 'message'
    expect(() => convertGraphDefinitionV1ToV2Draft(valid)).not.toThrow()

    const mismatch = createGraph()
    mismatch.outputs[0].channelId = 'message'
    mismatch.outputs[0].sourceNodeId = 'input'
    expect(() => convertGraphDefinitionV1ToV2Draft(mismatch)).toThrow(
      'Graph V1 migration validation error: output answer sourceNodeId input does not match channel message target: output.'
    )
  })

  it('rejects duplicate IDs and dangling V1 references before projection', () => {
    const cases: Array<[MagicAgentGraphDefinition, string]> = []
    const duplicateNode = createGraph()
    duplicateNode.nodes.push(structuredClone(duplicateNode.nodes[0]))
    cases.push([duplicateNode, 'duplicate node ID'])
    const duplicateChannel = createGraph()
    duplicateChannel.channels.push(structuredClone(duplicateChannel.channels[0]))
    cases.push([duplicateChannel, 'duplicate channel ID'])
    const duplicateOutput = createGraph()
    duplicateOutput.outputs.push(structuredClone(duplicateOutput.outputs[0]))
    cases.push([duplicateOutput, 'duplicate output ID'])
    const danglingFrom = createGraph()
    danglingFrom.channels[0].from = 'missing'
    cases.push([danglingFrom, 'dangling from node'])
    const danglingTo = createGraph()
    danglingTo.channels[0].to = 'missing'
    cases.push([danglingTo, 'dangling to node'])
    const danglingOutput = createGraph()
    danglingOutput.outputs[0].sourceNodeId = 'missing'
    cases.push([danglingOutput, 'dangling sourceNodeId'])
    const danglingOutputChannel = createGraph()
    danglingOutputChannel.outputs[0].channelId = 'missing'
    cases.push([danglingOutputChannel, 'dangling channelId'])
    const danglingEntry = createGraph()
    danglingEntry.entryNodeIds = ['missing']
    cases.push([danglingEntry, 'dangling entryNodeId'])
    for (const [graph, message] of cases) {
      expect(() => convertGraphDefinitionV1ToV2Draft(graph)).toThrow(
        'Graph V1 migration validation error:'
      )
      expect(() => convertGraphDefinitionV1ToV2Draft(graph)).toThrow(message)
    }
  })
})
