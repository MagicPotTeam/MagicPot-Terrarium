import type {
  MagicAgentGraphChannelDefinition,
  MagicAgentGraphConditionDefinition,
  MagicAgentGraphDefinition,
  MagicAgentGraphNodeDefinition
} from '../../../shared/magicAgent/graphTypes'
import {
  getGraphV2NodeDescriptor,
  getGraphV2NodePreflightIssues,
  validateGraphDefinitionV2Draft,
  type GraphDefinitionV2Draft,
  type GraphEdgeV2,
  type GraphJsonValue,
  type GraphNodeV2
} from '../../../shared/magicAgentPlatform2'
import { normalizeMagicAgentGraphDefinition } from './graphDefinition'

export type GraphDefinitionV2RuntimePlan = Readonly<{
  graph: GraphDefinitionV2Draft
  executableGraph: MagicAgentGraphDefinition
  nodeIds: readonly string[]
  edgeIds: readonly string[]
  warnings: readonly string[]
}>

export type GraphDefinitionV2Resolver = (
  graphId: string,
  version: string | undefined
) => Promise<GraphDefinitionV2Draft | undefined>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cloneRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? (structuredClone(value) as Record<string, unknown>) : {}

const runtimeConfig = (node: GraphNodeV2): Record<string, unknown> => {
  const migrated = isRecord(node.config.config) ? cloneRecord(node.config.config) : undefined
  if (migrated) return migrated
  const config = cloneRecord(node.config)
  delete config.legacyV1
  return config
}

const legacyNodeExtensions = (node: GraphNodeV2): Record<string, unknown> => {
  const extensions = isRecord(node.config.legacyV1) ? cloneRecord(node.config.legacyV1) : {}
  for (const key of ['nodeId', 'kind', 'name', 'description', 'config']) delete extensions[key]
  return extensions
}

const compileNode = (node: GraphNodeV2): MagicAgentGraphNodeDefinition => {
  const descriptor = getGraphV2NodeDescriptor(node.kind)
  if (!descriptor)
    throw new Error(
      `Graph V2 node ${node.nodeId} (${node.kind}) has no production runtime operation.`
    )

  const config = runtimeConfig(node)
  if (descriptor.execution.mode === 'tool-runtime') {
    return {
      nodeId: node.nodeId,
      kind: 'tool',
      name: node.name,
      description: node.description,
      config: {
        firstParty: {
          family: descriptor.category.toLowerCase(),
          operation: node.kind,
          config
        }
      },
      ...(node.metadata
        ? { metadata: structuredClone(node.metadata) as Record<string, unknown> }
        : {})
    }
  }
  if (descriptor.execution.mode !== 'legacy-runtime')
    throw new Error(
      `Graph V2 node ${node.nodeId} (${node.kind}) has no production runtime operation.`
    )
  const extensions = legacyNodeExtensions(node)
  const condition = isRecord(config.condition)
    ? (structuredClone(config.condition) as MagicAgentGraphConditionDefinition)
    : (extensions.condition as MagicAgentGraphConditionDefinition | undefined)
  delete config.condition

  const compiled: MagicAgentGraphNodeDefinition = {
    ...extensions,
    nodeId: node.nodeId,
    kind: descriptor.execution.legacyKind,
    name: node.name,
    description: node.description,
    ...(Object.keys(config).length ? { config } : {}),
    ...(condition ? { condition } : {}),
    ...(node.metadata
      ? { metadata: structuredClone(node.metadata) as Record<string, unknown> }
      : {})
  }
  if (compiled.kind === 'tool') {
    const toolName = String(config.toolName ?? extensions.toolName ?? '').trim()
    if (toolName) compiled.toolName = toolName
  }
  for (const key of ['instruction', 'modelName', 'agentId'] as const) {
    const value = config[key]
    if (typeof value === 'string' && value.trim()) compiled[key] = value.trim()
  }
  if (Array.isArray(config.capabilities))
    compiled.capabilities = config.capabilities.filter(
      (value): value is string => typeof value === 'string'
    )
  return compiled
}

const channelKind = (edge: GraphEdgeV2): MagicAgentGraphChannelDefinition['kind'] => {
  if (edge.kind === 'message') return 'message'
  if (edge.kind === 'data') return 'artifact'
  if (edge.kind === 'handoff') return 'handoff'
  if (edge.kind === 'artifact') return 'artifact'
  return 'control'
}

const compileEdge = (
  edge: GraphEdgeV2,
  nodes: ReadonlyMap<string, GraphNodeV2>
): MagicAgentGraphChannelDefinition => {
  const legacy = isRecord(edge.metadata?.legacyV1) ? cloneRecord(edge.metadata?.legacyV1) : {}
  const targetPort = nodes
    .get(edge.target.nodeId)
    ?.inputs.find((port) => port.portId === edge.target.portId)
  const conditionValue = edge.metadata?.condition ?? legacy.condition
  const legacyMetadata = isRecord(legacy.metadata) ? legacy.metadata : undefined
  return {
    channelId: edge.edgeId,
    from: edge.source.nodeId,
    to: edge.target.nodeId,
    kind: channelKind(edge),
    ...(edge.label ? { label: edge.label } : {}),
    required: targetPort?.required !== false,
    ...(isRecord(conditionValue)
      ? { condition: structuredClone(conditionValue) as MagicAgentGraphConditionDefinition }
      : {}),
    ...(legacyMetadata ? { metadata: legacyMetadata } : {})
  }
}

const assertPreflight = (candidate: Partial<GraphDefinitionV2Draft>): void => {
  const issues = Array.isArray(candidate.nodes)
    ? candidate.nodes.flatMap((node) => {
        if (!node || typeof node !== 'object') return []
        if (node.kind === 'subgraph') {
          return node.subgraphRef
            ? []
            : [`Graph V2 node ${node.nodeId} (subgraph): subgraphRef is required.`]
        }
        const config = isRecord(node.config?.config) ? node.config.config : node.config
        if (!isRecord(config)) return []
        return getGraphV2NodePreflightIssues(
          node.kind,
          config as Record<string, GraphJsonValue>
        ).map((issue) => `Graph V2 node ${node.nodeId} (${node.kind}): ${issue}`)
      })
    : []
  if (issues.length) throw new Error(issues.join('; '))
}

export const parseGraphDefinitionV2 = (input: unknown): GraphDefinitionV2Draft => {
  const candidate = input as Partial<GraphDefinitionV2Draft>
  assertPreflight(candidate)
  const validation = validateGraphDefinitionV2Draft(input)
  if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join('; '))
  return input as GraphDefinitionV2Draft
}

export const compileGraphDefinitionV2ForRuntime = (
  input: unknown
): GraphDefinitionV2RuntimePlan => {
  const graph = parseGraphDefinitionV2(input)
  const nodeIds = graph.nodes.map((node) => node.nodeId)
  const nodeIdSet = new Set(nodeIds)
  if (nodeIdSet.size !== nodeIds.length) throw new Error('Graph V2 node ids must be unique.')
  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]))
  for (const edge of graph.edges) {
    if (!nodeIdSet.has(edge.source.nodeId))
      throw new Error(`Graph V2 edge ${edge.edgeId} references missing source node.`)
    if (!nodeIdSet.has(edge.target.nodeId))
      throw new Error(`Graph V2 edge ${edge.edgeId} references missing target node.`)
  }

  const runtimeOutputs =
    graph.outputs.length > 0
      ? graph.outputs.map((output) => {
          const legacy = isRecord(output.metadata?.legacyV1)
            ? cloneRecord(output.metadata.legacyV1)
            : {}
          return {
            ...legacy,
            outputId: output.outputId,
            name: output.name,
            description: output.description,
            sourceNodeId: output.source.nodeId,
            ...(output.metadata && !isRecord(output.metadata.legacyV1)
              ? { metadata: structuredClone(output.metadata) as Record<string, unknown> }
              : {})
          }
        })
      : graph.legacySnapshot.outputs.map((output) => structuredClone(output))
  if (!runtimeOutputs.length)
    throw new Error(
      'Graph V2 must define at least one output or retain a legacy-compatible runtime output policy.'
    )
  for (const output of runtimeOutputs)
    if (!nodeIdSet.has(output.sourceNodeId))
      throw new Error(
        `Graph V2 runtime output ${output.outputId} references missing source node ${output.sourceNodeId}.`
      )

  const executableGraph = normalizeMagicAgentGraphDefinition({
    graphId: graph.graphId,
    name: graph.name,
    description: graph.description,
    version: graph.version,
    tags: [...graph.tags],
    nodes: graph.nodes.map(compileNode),
    channels: graph.edges.map((edge) => compileEdge(edge, nodesById)),
    outputs: runtimeOutputs,
    entryNodeIds: [...graph.entryNodeIds],
    ...(graph.metadata
      ? { metadata: structuredClone(graph.metadata) as Record<string, unknown> }
      : {})
  })
  return {
    graph,
    executableGraph,
    nodeIds,
    edgeIds: graph.edges.map((edge) => edge.edgeId),
    warnings: []
  }
}

const MAX_SUBGRAPH_DEPTH = 8
const MAX_EXPANDED_NODES = 500

export const compileGraphDefinitionV2WithSubgraphs = async (
  input: unknown,
  resolver: GraphDefinitionV2Resolver
): Promise<GraphDefinitionV2RuntimePlan> => {
  const root = parseGraphDefinitionV2(input)
  const expand = async (
    graph: GraphDefinitionV2Draft,
    ancestors: readonly string[],
    depth: number
  ): Promise<GraphDefinitionV2Draft> => {
    if (depth > MAX_SUBGRAPH_DEPTH)
      throw new Error(`Graph V2 subgraph depth exceeds ${MAX_SUBGRAPH_DEPTH}.`)
    if (graph.nodes.length > MAX_EXPANDED_NODES)
      throw new Error(`Graph V2 expanded node count exceeds ${MAX_EXPANDED_NODES}.`)
    const subgraphs = graph.nodes.filter((node) => node.kind === 'subgraph')
    if (!subgraphs.length) {
      compileGraphDefinitionV2ForRuntime(graph)
      return graph
    }

    const marker = `${graph.graphId}@${graph.version}`
    if (ancestors.includes(marker))
      throw new Error(`Graph V2 subgraph cycle detected: ${[...ancestors, marker].join(' -> ')}.`)

    let working = graph
    for (const node of subgraphs) {
      const ref = node.subgraphRef
      if (!ref) throw new Error(`Graph V2 subgraph node ${node.nodeId} is missing subgraphRef.`)
      const child = await resolver(ref.graphId, ref.version || undefined)
      if (!child)
        throw new Error(
          `Graph V2 subgraph node ${node.nodeId} references missing graph ${ref.graphId}${ref.version ? `@${ref.version}` : ''}.`
        )
      if (child.graphId !== ref.graphId || child.version !== ref.version)
        throw new Error(
          `Graph V2 subgraph node ${node.nodeId} resolved ${child.graphId}@${child.version}, expected ${ref.graphId}@${ref.version}.`
        )
      const childMarker = `${child.graphId}@${child.version}`
      if ([...ancestors, marker].includes(childMarker))
        throw new Error(
          `Graph V2 subgraph cycle detected: ${[...ancestors, marker, childMarker].join(' -> ')}.`
        )
      const expandedChild = await expand(child, [...ancestors, marker], depth + 1)
      working = inlineSubgraph(
        working,
        node,
        child,
        expandedChild,
        ref.inputMappings,
        ref.outputMappings
      )
      if (working.nodes.length > MAX_EXPANDED_NODES)
        throw new Error(`Graph V2 expanded node count exceeds ${MAX_EXPANDED_NODES}.`)
    }
    compileGraphDefinitionV2ForRuntime(working)
    return working
  }

  const expandedGraph = await expand(root, [], 0)
  const executableGraph = compileGraphDefinitionV2ForRuntime(expandedGraph).executableGraph
  return {
    graph: root,
    executableGraph,
    nodeIds: root.nodes.map((node) => node.nodeId),
    edgeIds: root.edges.map((edge) => edge.edgeId),
    warnings: []
  }
}

const inlineSubgraph = (
  parent: GraphDefinitionV2Draft,
  node: GraphNodeV2,
  child: GraphDefinitionV2Draft,
  expandedChild: GraphDefinitionV2Draft,
  inputMappings: Readonly<Record<string, string>>,
  outputMappings: Readonly<Record<string, string>>
): GraphDefinitionV2Draft => {
  const prefix = `${node.nodeId}::`
  const parentInputIds = new Set(node.inputs.map((port) => port.portId))
  const parentOutputIds = new Set(node.outputs.map((port) => port.portId))
  const childEntryIds = new Set(child.entryNodeIds)
  const childOutputIds = new Set(child.outputs.map((output) => output.outputId))
  for (const [parentPort, childEntry] of Object.entries(inputMappings)) {
    if (!parentInputIds.has(parentPort) || !childEntryIds.has(childEntry))
      throw new Error(
        `Graph V2 subgraph node ${node.nodeId} has invalid input mapping ${parentPort} -> ${childEntry}.`
      )
  }
  for (const [parentPort, childOutput] of Object.entries(outputMappings)) {
    if (!parentOutputIds.has(parentPort) || !childOutputIds.has(childOutput))
      throw new Error(
        `Graph V2 subgraph node ${node.nodeId} has invalid output mapping ${parentPort} -> ${childOutput}.`
      )
  }
  for (const port of node.inputs.filter((item) => item.required !== false))
    if (!inputMappings[port.portId])
      throw new Error(
        `Graph V2 subgraph node ${node.nodeId} is missing required input mapping for ${port.portId}.`
      )
  for (const port of node.outputs)
    if (!outputMappings[port.portId])
      throw new Error(
        `Graph V2 subgraph node ${node.nodeId} is missing output mapping for ${port.portId}.`
      )

  const childNodes = new Map(expandedChild.nodes.map((item) => [item.nodeId, item]))
  const childOutputs = new Map(expandedChild.outputs.map((output) => [output.outputId, output]))
  const childInputEndpoints = new Map<string, { nodeId: string; portId: string }>()
  for (const childEntry of child.entryNodeIds) {
    const actualEntryId = expandedChild.entryNodeIds.find(
      (entryId) => entryId === childEntry || entryId.startsWith(`${childEntry}::`)
    )
    const entryNode = actualEntryId ? childNodes.get(actualEntryId) : undefined
    const input = entryNode?.inputs[0]
    if (!input)
      throw new Error(
        `Graph V2 subgraph node ${node.nodeId} maps to child entry ${childEntry}, which has no declared input port.`
      )
    childInputEndpoints.set(childEntry, { nodeId: actualEntryId!, portId: input.portId })
  }
  const replacementEdges = parent.edges.flatMap((edge) => {
    if (edge.target.nodeId === node.nodeId) {
      const childEntry = inputMappings[edge.target.portId]
      const target = childEntry && childInputEndpoints.get(childEntry)
      if (!target)
        throw new Error(
          `Graph V2 subgraph node ${node.nodeId} has no mapping for input ${edge.target.portId}.`
        )
      return [{ ...edge, target: { nodeId: `${prefix}${target.nodeId}`, portId: target.portId } }]
    }
    if (edge.source.nodeId === node.nodeId) {
      const outputId = outputMappings[edge.source.portId]
      const source = outputId && childOutputs.get(outputId)?.source
      if (!source)
        throw new Error(
          `Graph V2 subgraph node ${node.nodeId} has no mapping for output ${edge.source.portId}.`
        )
      return [{ ...edge, source: { nodeId: `${prefix}${source.nodeId}`, portId: source.portId } }]
    }
    return [edge]
  })
  const clonedNodes = expandedChild.nodes.map((item, index) => ({
    ...structuredClone(item),
    nodeId: `${prefix}${item.nodeId}`,
    position: { x: node.position.x + index * 20, y: node.position.y + index * 20 }
  }))
  const childEdges = expandedChild.edges.map((edge) => ({
    ...structuredClone(edge),
    edgeId: `${prefix}${edge.edgeId}`,
    source: { ...edge.source, nodeId: `${prefix}${edge.source.nodeId}` },
    target: { ...edge.target, nodeId: `${prefix}${edge.target.nodeId}` }
  }))
  const entryNodeIds = parent.entryNodeIds.flatMap((id) =>
    id === node.nodeId ? expandedChild.entryNodeIds.map((childId) => `${prefix}${childId}`) : [id]
  )
  const outputs = parent.outputs.map((output) => {
    if (output.source.nodeId !== node.nodeId) return output
    const outputId = outputMappings[output.source.portId]
    const source = outputId && childOutputs.get(outputId)?.source
    if (!source)
      throw new Error(
        `Graph V2 subgraph node ${node.nodeId} has no mapping for graph output ${output.outputId}.`
      )
    return { ...output, source: { nodeId: `${prefix}${source.nodeId}`, portId: source.portId } }
  })
  return {
    ...parent,
    nodes: [...parent.nodes.filter((item) => item.nodeId !== node.nodeId), ...clonedNodes],
    edges: [...replacementEdges, ...childEdges],
    outputs,
    entryNodeIds
  } as GraphDefinitionV2Draft
}
