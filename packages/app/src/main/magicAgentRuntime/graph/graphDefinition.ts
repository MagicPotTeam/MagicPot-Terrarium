import type {
  MagicAgentGraphChannelDefinition,
  MagicAgentGraphDefinition,
  MagicAgentGraphNodeDefinition,
  MagicAgentGraphNodeKind,
  MagicAgentGraphOutputDefinition
} from '@shared/magicAgent'

export type MagicAgentGraphDefinitionValidationIssue = {
  path: string
  message: string
}

const SUPPORTED_GRAPH_NODE_KINDS = new Set<MagicAgentGraphNodeKind>([
  'agent',
  'tool',
  'input',
  'condition',
  'merge',
  'output'
])
const SUPPORTED_GRAPH_CHANNEL_KINDS = new Set<MagicAgentGraphChannelDefinition['kind']>([
  'handoff',
  'artifact',
  'message',
  'control'
])

const cleanString = (value: unknown): string => String(value || '').trim()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const pushIssue = (
  issues: MagicAgentGraphDefinitionValidationIssue[],
  path: string,
  message: string
): void => {
  issues.push({ path, message })
}

const normalizeStringArray = (
  value: unknown,
  path: string,
  issues: MagicAgentGraphDefinitionValidationIssue[]
): string[] => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    pushIssue(issues, path, `Expected "${path}" to be an array of strings.`)
    return []
  }

  const values: string[] = []
  for (const [index, item] of value.entries()) {
    const normalized = cleanString(item)
    if (!normalized) {
      pushIssue(issues, `${path}.${index}`, 'Expected a non-empty string.')
      continue
    }
    if (!values.includes(normalized)) {
      values.push(normalized)
    }
  }
  return values
}

const normalizeOptionalRecord = (
  value: unknown,
  path: string,
  issues: MagicAgentGraphDefinitionValidationIssue[]
): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    pushIssue(issues, path, `Expected "${path}" to be an object.`)
    return undefined
  }
  return { ...value }
}

const normalizeOptionalCondition = (
  value: unknown,
  path: string,
  issues: MagicAgentGraphDefinitionValidationIssue[]
): MagicAgentGraphNodeDefinition['condition'] | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    pushIssue(issues, path, `Expected "${path}" to be an object.`)
    return undefined
  }
  return { ...value }
}

const normalizeNode = (
  value: unknown,
  index: number,
  issues: MagicAgentGraphDefinitionValidationIssue[]
): MagicAgentGraphNodeDefinition | undefined => {
  const path = `nodes.${index}`
  if (!isRecord(value)) {
    pushIssue(issues, path, 'Expected graph node to be an object.')
    return undefined
  }

  const nodeId = cleanString(value.nodeId)
  const kind = cleanString(value.kind) as MagicAgentGraphNodeKind
  const name = cleanString(value.name)
  const description = cleanString(value.description)
  if (!nodeId) pushIssue(issues, `${path}.nodeId`, 'Expected graph node nodeId to be non-empty.')
  if (!SUPPORTED_GRAPH_NODE_KINDS.has(kind)) {
    pushIssue(issues, `${path}.kind`, `Unsupported MagicAgentGraph node kind: ${value.kind}`)
  }
  if (!name) pushIssue(issues, `${path}.name`, 'Expected graph node name to be non-empty.')
  if (!description) {
    pushIssue(issues, `${path}.description`, 'Expected graph node description to be non-empty.')
  }

  return {
    ...(value as MagicAgentGraphNodeDefinition),
    nodeId,
    kind,
    name,
    description,
    capabilities: value.capabilities
      ? normalizeStringArray(value.capabilities, `${path}.capabilities`, issues)
      : undefined,
    condition: normalizeOptionalCondition(value.condition, `${path}.condition`, issues),
    metadata: normalizeOptionalRecord(value.metadata, `${path}.metadata`, issues)
  }
}

const normalizeChannel = (
  value: unknown,
  index: number,
  issues: MagicAgentGraphDefinitionValidationIssue[]
): MagicAgentGraphChannelDefinition | undefined => {
  const path = `channels.${index}`
  if (!isRecord(value)) {
    pushIssue(issues, path, 'Expected graph channel to be an object.')
    return undefined
  }

  const channelId = cleanString(value.channelId)
  const from = cleanString(value.from)
  const to = cleanString(value.to)
  const kind = cleanString(value.kind) as MagicAgentGraphChannelDefinition['kind']
  if (!channelId) {
    pushIssue(issues, `${path}.channelId`, 'Expected graph channel channelId to be non-empty.')
  }
  if (!from) pushIssue(issues, `${path}.from`, 'Expected graph channel from to be non-empty.')
  if (!to) pushIssue(issues, `${path}.to`, 'Expected graph channel to to be non-empty.')
  if (!SUPPORTED_GRAPH_CHANNEL_KINDS.has(kind)) {
    pushIssue(issues, `${path}.kind`, `Unsupported MagicAgentGraph channel kind: ${value.kind}`)
  }

  return {
    ...(value as MagicAgentGraphChannelDefinition),
    channelId,
    from,
    to,
    kind,
    required: value.required !== false,
    condition: normalizeOptionalCondition(value.condition, `${path}.condition`, issues),
    metadata: normalizeOptionalRecord(value.metadata, `${path}.metadata`, issues)
  }
}

const normalizeOutput = (
  value: unknown,
  index: number,
  issues: MagicAgentGraphDefinitionValidationIssue[]
): MagicAgentGraphOutputDefinition | undefined => {
  const path = `outputs.${index}`
  if (!isRecord(value)) {
    pushIssue(issues, path, 'Expected graph output to be an object.')
    return undefined
  }

  const outputId = cleanString(value.outputId)
  const name = cleanString(value.name)
  const description = cleanString(value.description)
  const sourceNodeId = cleanString(value.sourceNodeId)
  const channelId = value.channelId ? cleanString(value.channelId) : undefined
  if (!outputId)
    pushIssue(issues, `${path}.outputId`, 'Expected graph output outputId to be non-empty.')
  if (!name) pushIssue(issues, `${path}.name`, 'Expected graph output name to be non-empty.')
  if (!description) {
    pushIssue(issues, `${path}.description`, 'Expected graph output description to be non-empty.')
  }
  if (!sourceNodeId) {
    pushIssue(issues, `${path}.sourceNodeId`, 'Expected graph output sourceNodeId to be non-empty.')
  }

  return {
    ...(value as MagicAgentGraphOutputDefinition),
    outputId,
    name,
    description,
    sourceNodeId,
    channelId,
    metadata: normalizeOptionalRecord(value.metadata, `${path}.metadata`, issues)
  }
}

export type MagicAgentGraphDefinitionValidationResult =
  | {
      ok: true
      graph: MagicAgentGraphDefinition
      warnings: MagicAgentGraphDefinitionValidationIssue[]
    }
  | {
      ok: false
      errors: MagicAgentGraphDefinitionValidationIssue[]
      warnings: MagicAgentGraphDefinitionValidationIssue[]
    }

export function validateMagicAgentGraphDefinition(
  value: unknown
): MagicAgentGraphDefinitionValidationResult {
  const errors: MagicAgentGraphDefinitionValidationIssue[] = []
  const warnings: MagicAgentGraphDefinitionValidationIssue[] = []

  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'Expected MagicAgentGraph definition to be a JSON object.' }],
      warnings
    }
  }

  const graphId = cleanString(value.graphId)
  const name = cleanString(value.name)
  const description = cleanString(value.description)
  const version = cleanString(value.version) || '0.0.0'
  if (!graphId) pushIssue(errors, 'graphId', 'MagicAgentGraph graphId is required.')
  if (!name) pushIssue(errors, 'name', 'MagicAgentGraph name is required.')

  const tags = normalizeStringArray(value.tags, 'tags', errors)
  const entryNodeIds = normalizeStringArray(value.entryNodeIds, 'entryNodeIds', errors)

  if (!Array.isArray(value.nodes)) {
    pushIssue(errors, 'nodes', 'Expected "nodes" to be an array.')
  }
  if (!Array.isArray(value.channels)) {
    pushIssue(errors, 'channels', 'Expected "channels" to be an array.')
  }
  if (!Array.isArray(value.outputs)) {
    pushIssue(errors, 'outputs', 'Expected "outputs" to be an array.')
  }

  const nodes = Array.isArray(value.nodes)
    ? value.nodes
        .map((node, index) => normalizeNode(node, index, errors))
        .filter((node): node is MagicAgentGraphNodeDefinition => Boolean(node))
    : []
  const channels = Array.isArray(value.channels)
    ? value.channels
        .map((channel, index) => normalizeChannel(channel, index, errors))
        .filter((channel): channel is MagicAgentGraphChannelDefinition => Boolean(channel))
    : []
  const outputs = Array.isArray(value.outputs)
    ? value.outputs
        .map((output, index) => normalizeOutput(output, index, errors))
        .filter((output): output is MagicAgentGraphOutputDefinition => Boolean(output))
    : []

  if (nodes.length === 0)
    pushIssue(errors, 'nodes', 'MagicAgentGraph must contain at least one node.')
  if (outputs.length === 0) {
    pushIssue(errors, 'outputs', 'MagicAgentGraph must contain at least one output.')
  }

  const nodeIds = new Set<string>()
  for (const [index, node] of nodes.entries()) {
    if (nodeIds.has(node.nodeId)) {
      pushIssue(
        errors,
        `nodes.${index}.nodeId`,
        `MagicAgentGraph "${graphId}" contains duplicate node "${node.nodeId}".`
      )
    }
    nodeIds.add(node.nodeId)
  }

  const channelIds = new Set<string>()
  for (const [index, channel] of channels.entries()) {
    if (channelIds.has(channel.channelId)) {
      pushIssue(
        errors,
        `channels.${index}.channelId`,
        `MagicAgentGraph "${graphId}" contains duplicate channel "${channel.channelId}".`
      )
    }
    if (!nodeIds.has(channel.from)) {
      pushIssue(
        errors,
        `channels.${index}.from`,
        `MagicAgentGraph channel "${channel.channelId}" references missing from node.`
      )
    }
    if (!nodeIds.has(channel.to)) {
      pushIssue(
        errors,
        `channels.${index}.to`,
        `MagicAgentGraph channel "${channel.channelId}" references missing to node.`
      )
    }
    channelIds.add(channel.channelId)
  }

  for (const [index, output] of outputs.entries()) {
    if (!nodeIds.has(output.sourceNodeId)) {
      pushIssue(
        errors,
        `outputs.${index}.sourceNodeId`,
        `MagicAgentGraph output "${output.outputId}" references missing source node.`
      )
    }
    if (output.channelId && !channelIds.has(output.channelId)) {
      pushIssue(
        errors,
        `outputs.${index}.channelId`,
        `MagicAgentGraph output "${output.outputId}" references missing channel.`
      )
    }
  }

  for (const [index, entryNodeId] of entryNodeIds.entries()) {
    if (!nodeIds.has(entryNodeId)) {
      pushIssue(
        errors,
        `entryNodeIds.${index}`,
        `MagicAgentGraph entry node "${entryNodeId}" does not exist.`
      )
    }
  }

  const metadata = normalizeOptionalRecord(value.metadata, 'metadata', errors)

  if (errors.length > 0) {
    return { ok: false, errors, warnings }
  }

  return {
    ok: true,
    graph: {
      ...(value as MagicAgentGraphDefinition),
      graphId,
      name,
      description,
      version,
      tags,
      nodes,
      channels,
      outputs,
      entryNodeIds,
      metadata
    },
    warnings
  }
}

export function normalizeMagicAgentGraphDefinition(value: unknown): MagicAgentGraphDefinition {
  const validation = validateMagicAgentGraphDefinition(value)
  if (!validation.ok) {
    throw new Error(validation.errors.map((issue) => issue.message).join('; '))
  }
  return validation.graph
}
