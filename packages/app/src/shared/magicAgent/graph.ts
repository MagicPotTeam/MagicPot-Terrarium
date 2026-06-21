import {
  createMagicAgentValidationResult,
  isPlainRecord,
  makeMagicAgentIssue,
  normalizeMagicAgentId,
  normalizeMagicAgentOptionalText,
  normalizeMagicAgentRecord,
  normalizeMagicAgentUniqueStringArray,
  validateMagicAgentRecord,
  validateMagicAgentRequiredText,
  type MagicAgentRecord,
  type MagicAgentValidationIssue,
  type MagicAgentValidationResult
} from './common'

export const MAGIC_AGENT_GRAPH_NODE_TYPES = [
  'input',
  'tool',
  'model',
  'condition',
  'branch',
  'merge',
  'output',
  'plugin',
  'subagent'
] as const

export type MagicAgentGraphNodeType = (typeof MAGIC_AGENT_GRAPH_NODE_TYPES)[number]

export type MagicAgentGraphNode = {
  id: string
  type: MagicAgentGraphNodeType
  title: string
  ref?: string
  config?: MagicAgentRecord
  metadata?: MagicAgentRecord
}

export type MagicAgentGraphEdge = {
  id: string
  from: string
  to: string
  condition?: string
  metadata?: MagicAgentRecord
}

export type MagicAgentGraphSpec = {
  nodes: MagicAgentGraphNode[]
  edges: MagicAgentGraphEdge[]
  entryNodeIds: string[]
  outputNodeIds: string[]
  metadata?: MagicAgentRecord
}

const GRAPH_NODE_TYPE_SET = new Set<string>(MAGIC_AGENT_GRAPH_NODE_TYPES)

export const isMagicAgentGraphNodeType = (value: unknown): value is MagicAgentGraphNodeType =>
  GRAPH_NODE_TYPE_SET.has(String(value || ''))

export const normalizeMagicAgentGraphNodeType = (value: unknown): MagicAgentGraphNodeType =>
  isMagicAgentGraphNodeType(value) ? value : 'tool'

export const normalizeMagicAgentGraphNode = (
  node: Partial<MagicAgentGraphNode> & MagicAgentRecord
): MagicAgentGraphNode => {
  const title =
    normalizeMagicAgentOptionalText(node.title) ||
    normalizeMagicAgentOptionalText(node.id) ||
    'Node'
  return {
    id: normalizeMagicAgentId(node.id, 'node'),
    type: normalizeMagicAgentGraphNodeType(node.type),
    title,
    ...(normalizeMagicAgentOptionalText(node.ref)
      ? { ref: normalizeMagicAgentOptionalText(node.ref) }
      : {}),
    ...(normalizeMagicAgentRecord(node.config)
      ? { config: normalizeMagicAgentRecord(node.config) }
      : {}),
    ...(normalizeMagicAgentRecord(node.metadata)
      ? { metadata: normalizeMagicAgentRecord(node.metadata) }
      : {})
  }
}

export const normalizeMagicAgentGraphEdge = (
  edge: Partial<MagicAgentGraphEdge> & MagicAgentRecord
): MagicAgentGraphEdge => {
  const from = normalizeMagicAgentId(edge.from, 'source')
  const to = normalizeMagicAgentId(edge.to, 'target')
  return {
    id: normalizeMagicAgentId(edge.id, `${from}->${to}`),
    from,
    to,
    ...(normalizeMagicAgentOptionalText(edge.condition)
      ? { condition: normalizeMagicAgentOptionalText(edge.condition) }
      : {}),
    ...(normalizeMagicAgentRecord(edge.metadata)
      ? { metadata: normalizeMagicAgentRecord(edge.metadata) }
      : {})
  }
}

export const normalizeMagicAgentGraphSpec = (
  graph: Partial<MagicAgentGraphSpec> & MagicAgentRecord
): MagicAgentGraphSpec => {
  const nodes = Array.isArray(graph.nodes)
    ? graph.nodes
        .filter(isPlainRecord)
        .map((node) =>
          normalizeMagicAgentGraphNode(node as Partial<MagicAgentGraphNode> & MagicAgentRecord)
        )
    : []
  const edges = Array.isArray(graph.edges)
    ? graph.edges
        .filter(isPlainRecord)
        .map((edge) =>
          normalizeMagicAgentGraphEdge(edge as Partial<MagicAgentGraphEdge> & MagicAgentRecord)
        )
    : []

  return {
    nodes,
    edges,
    entryNodeIds: normalizeMagicAgentUniqueStringArray(graph.entryNodeIds),
    outputNodeIds: normalizeMagicAgentUniqueStringArray(graph.outputNodeIds),
    ...(normalizeMagicAgentRecord(graph.metadata)
      ? { metadata: normalizeMagicAgentRecord(graph.metadata) }
      : {})
  }
}

export const validateMagicAgentGraphSpec = (
  value: unknown
): MagicAgentValidationResult<MagicAgentGraphSpec> => {
  const issues: MagicAgentValidationIssue[] = []
  const graph = validateMagicAgentRecord(value, 'graph', issues, 'graph')

  if (!Array.isArray(graph.nodes)) {
    issues.push(makeMagicAgentIssue('graph.nodes', 'graph nodes must be an array.'))
  } else {
    graph.nodes.forEach((node, index) => {
      if (!isPlainRecord(node)) {
        issues.push(makeMagicAgentIssue(`graph.nodes.${index}`, 'graph node must be an object.'))
        return
      }
      validateMagicAgentRequiredText(node.id, `graph.nodes.${index}.id`, issues, 'node id')
      validateMagicAgentRequiredText(node.title, `graph.nodes.${index}.title`, issues, 'node title')
      if (node.type !== undefined && !isMagicAgentGraphNodeType(node.type)) {
        issues.push(
          makeMagicAgentIssue(
            `graph.nodes.${index}.type`,
            `Unsupported graph node type: ${String(node.type)}.`
          )
        )
      }
    })
  }

  if (graph.edges !== undefined && !Array.isArray(graph.edges)) {
    issues.push(makeMagicAgentIssue('graph.edges', 'graph edges must be an array.'))
  }

  if (Array.isArray(graph.edges)) {
    graph.edges.forEach((edge, index) => {
      if (!isPlainRecord(edge)) {
        issues.push(makeMagicAgentIssue(`graph.edges.${index}`, 'graph edge must be an object.'))
        return
      }
      validateMagicAgentRequiredText(edge.from, `graph.edges.${index}.from`, issues, 'edge from')
      validateMagicAgentRequiredText(edge.to, `graph.edges.${index}.to`, issues, 'edge to')
    })
  }

  if (graph.entryNodeIds !== undefined && !Array.isArray(graph.entryNodeIds)) {
    issues.push(makeMagicAgentIssue('graph.entryNodeIds', 'graph entryNodeIds must be an array.'))
  }

  if (graph.outputNodeIds !== undefined && !Array.isArray(graph.outputNodeIds)) {
    issues.push(makeMagicAgentIssue('graph.outputNodeIds', 'graph outputNodeIds must be an array.'))
  }

  return createMagicAgentValidationResult(normalizeMagicAgentGraphSpec(graph), issues)
}
