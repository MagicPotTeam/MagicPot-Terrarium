import {
  builtInMagicAgentGraphs,
  type MagicAgentGraphCancelResult,
  type MagicAgentGraphChannelDefinition,
  type MagicAgentGraphCreateRequest,
  type MagicAgentGraphDefinition,
  type MagicAgentGraphListItem,
  type MagicAgentGraphNodeDefinition,
  type MagicAgentGraphOutputDefinition,
  type MagicAgentGraphRunChannelRecord,
  type MagicAgentGraphRunOutput,
  type MagicAgentGraphRunRecord,
  type MagicAgentGraphRunRequest,
  type MagicAgentGraphRunResult
} from '@shared/magicAgent'
import { getAgentSessionKey, type AgentRouteLike } from '@shared/agent'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const now = (): number => Date.now()

const cleanString = (value: unknown): string => String(value || '').trim()

const GRAPH_ROUTE_SCOPE_TYPES = new Set(['dm', 'group', 'channel', 'thread', 'topic'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertGraphRoute = (value: unknown): AgentRouteLike => {
  if (!isRecord(value)) {
    throw new Error('MagicAgentGraph route is required.')
  }
  const channel = cleanString(value.channel)
  const scopeType = cleanString(value.scopeType)
  const scopeId = cleanString(value.scopeId)
  if (!channel) throw new Error('MagicAgentGraph route.channel is required.')
  if (!GRAPH_ROUTE_SCOPE_TYPES.has(scopeType)) {
    throw new Error(
      'MagicAgentGraph route.scopeType must be one of dm, group, channel, thread, or topic.'
    )
  }
  if (!scopeId) throw new Error('MagicAgentGraph route.scopeId is required.')
  const threadId = cleanString(value.threadId)
  const senderId = cleanString(value.senderId)
  const senderName = cleanString(value.senderName)
  return {
    channel,
    scopeType,
    scopeId,
    ...(threadId ? { threadId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {})
  }
}

const createId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`

const toListItem = (
  graph: MagicAgentGraphDefinition,
  builtIn: boolean
): MagicAgentGraphListItem => ({
  graphId: graph.graphId,
  name: graph.name,
  description: graph.description,
  version: graph.version,
  tags: [...graph.tags],
  nodeCount: graph.nodes.length,
  channelCount: graph.channels.length,
  outputCount: graph.outputs.length,
  builtIn
})

const formatAgentSection = (node: MagicAgentGraphNodeDefinition, input: string): string => {
  const instruction = cleanString(node.instruction) || node.description
  return `### ${node.name}\n${instruction}\n\nInput:\n${input}`
}

const formatChannelContent = (
  channel: MagicAgentGraphChannelDefinition,
  fromNode: MagicAgentGraphNodeDefinition | undefined,
  toNode: MagicAgentGraphNodeDefinition | undefined,
  input: string
): string =>
  [
    `Channel: ${channel.label || channel.channelId}`,
    `From: ${fromNode?.name || channel.from}`,
    `To: ${toNode?.name || channel.to}`,
    `Kind: ${channel.kind}`,
    `Payload: ${input}`
  ].join('\n')

export class MagicAgentGraphRuntime {
  private readonly graphs = new Map<string, MagicAgentGraphDefinition>()
  private readonly builtInGraphIds = new Set<string>()
  private readonly runs = new Map<string, MagicAgentGraphRunRecord>()
  private readonly controllers = new Map<string, AbortController>()

  constructor(graphs: MagicAgentGraphDefinition[] = builtInMagicAgentGraphs) {
    for (const graph of graphs) {
      const normalized = this.normalizeGraph(graph)
      this.graphs.set(normalized.graphId, normalized)
      this.builtInGraphIds.add(normalized.graphId)
    }
  }

  create(request: MagicAgentGraphCreateRequest): MagicAgentGraphDefinition {
    assertGraphRoute(request.route)
    const graph = this.normalizeGraph(request.graph)
    if (this.builtInGraphIds.has(graph.graphId)) {
      throw new Error(`Cannot replace built-in MagicAgentGraph "${graph.graphId}".`)
    }
    if (!request.replace && this.graphs.has(graph.graphId)) {
      throw new Error(`MagicAgentGraph "${graph.graphId}" already exists.`)
    }

    this.graphs.set(graph.graphId, graph)
    return clone(graph)
  }

  list(): MagicAgentGraphListItem[] {
    return [...this.graphs.values()].map((graph) =>
      toListItem(graph, this.builtInGraphIds.has(graph.graphId))
    )
  }

  inspect(graphId: string): MagicAgentGraphDefinition | undefined {
    const graph = this.graphs.get(cleanString(graphId))
    return graph ? clone(graph) : undefined
  }

  getRun(runId: string, sessionKey: string): MagicAgentGraphRunRecord | undefined {
    const run = this.runs.get(cleanString(runId))
    const normalizedSessionKey = cleanString(sessionKey)
    if (!run || !normalizedSessionKey || run.sessionKey !== normalizedSessionKey) {
      return undefined
    }
    return clone(run)
  }

  listRuns(sessionKey: string, graphId?: string): MagicAgentGraphRunRecord[] {
    const normalizedSessionKey = cleanString(sessionKey)
    if (!normalizedSessionKey) {
      return []
    }
    return [...this.runs.values()]
      .filter((run) => !graphId || run.graphId === graphId)
      .filter((run) => run.sessionKey === normalizedSessionKey)
      .map((run) => clone(run))
  }

  async run(request: MagicAgentGraphRunRequest): Promise<MagicAgentGraphRunResult> {
    const route = assertGraphRoute(request.route)
    const sessionKey = getAgentSessionKey(route)
    const graph = this.graphs.get(cleanString(request.graphId))
    if (!graph) {
      throw new Error(`MagicAgentGraph "${request.graphId}" does not exist.`)
    }

    const runId = cleanString(request.runId) || createId('magic-agent-graph-run')
    if (this.runs.has(runId)) {
      throw new Error(`MagicAgentGraph run "${runId}" already exists.`)
    }

    const controller = new AbortController()
    const createdAt = now()
    const runRecord: MagicAgentGraphRunRecord = {
      runId,
      graphId: graph.graphId,
      status: 'pending',
      input: request.input,
      route,
      sessionKey,
      createdAt,
      updatedAt: createdAt,
      channels: [],
      outputs: [],
      metadata: {
        ...(request.metadata || {}),
        route,
        sessionKey
      }
    }

    this.runs.set(runId, runRecord)
    this.controllers.set(runId, controller)

    try {
      this.markRun(runRecord, 'running', { startedAt: now() })
      await Promise.resolve()
      this.throwIfCancelled(controller.signal)

      const outputFilter = new Set((request.outputIds || []).map(cleanString).filter(Boolean))
      const outputsToBuild = graph.outputs.filter(
        (output) => outputFilter.size === 0 || outputFilter.has(output.outputId)
      )
      if (outputsToBuild.length === 0 && outputFilter.size > 0) {
        throw new Error(`No requested outputs exist on MagicAgentGraph "${graph.graphId}".`)
      }

      runRecord.channels = this.buildChannelRecords(graph, request.input)
      this.throwIfCancelled(controller.signal)
      runRecord.outputs = outputsToBuild.map((output) =>
        this.buildOutput(graph, output, request.input, runRecord.channels)
      )
      this.markRun(runRecord, 'completed', { endedAt: now() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = controller.signal.aborted ? 'cancelled' : 'failed'
      this.markRun(runRecord, status, { endedAt: now(), error: message })
    } finally {
      this.controllers.delete(runId)
      this.runs.set(runId, runRecord)
    }

    return clone(runRecord)
  }

  cancel(
    runId: string,
    sessionKey: string,
    reason = 'MagicAgentGraph run cancelled.'
  ): MagicAgentGraphCancelResult {
    const normalizedRunId = cleanString(runId)
    const normalizedSessionKey = cleanString(sessionKey)
    const run = this.runs.get(normalizedRunId)
    if (!run || !normalizedSessionKey || run.sessionKey !== normalizedSessionKey) {
      return { runId: normalizedRunId, cancelled: false, error: 'Run not found.' }
    }

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return { runId: normalizedRunId, cancelled: false, status: run.status }
    }

    const controller = this.controllers.get(normalizedRunId)
    controller?.abort(reason)
    this.markRun(run, 'cancelled', { endedAt: now(), error: reason })
    return { runId: normalizedRunId, cancelled: true, status: run.status }
  }

  private normalizeGraph(graph: MagicAgentGraphDefinition): MagicAgentGraphDefinition {
    const normalized: MagicAgentGraphDefinition = {
      ...graph,
      graphId: cleanString(graph.graphId),
      name: cleanString(graph.name),
      description: cleanString(graph.description),
      version: cleanString(graph.version) || '0.0.0',
      tags: [...new Set((graph.tags || []).map(cleanString).filter(Boolean))],
      nodes: (graph.nodes || []).map((node) => ({
        ...node,
        nodeId: cleanString(node.nodeId),
        name: cleanString(node.name),
        description: cleanString(node.description),
        capabilities: node.capabilities ? [...node.capabilities] : undefined,
        metadata: node.metadata ? { ...node.metadata } : undefined
      })),
      channels: (graph.channels || []).map((channel) => ({
        ...channel,
        channelId: cleanString(channel.channelId),
        from: cleanString(channel.from),
        to: cleanString(channel.to),
        required: channel.required !== false,
        metadata: channel.metadata ? { ...channel.metadata } : undefined
      })),
      outputs: (graph.outputs || []).map((output) => ({
        ...output,
        outputId: cleanString(output.outputId),
        name: cleanString(output.name),
        description: cleanString(output.description),
        sourceNodeId: cleanString(output.sourceNodeId),
        channelId: output.channelId ? cleanString(output.channelId) : undefined,
        metadata: output.metadata ? { ...output.metadata } : undefined
      })),
      entryNodeIds: [...new Set((graph.entryNodeIds || []).map(cleanString).filter(Boolean))],
      metadata: graph.metadata ? { ...graph.metadata } : undefined
    }

    this.validateGraph(normalized)
    return normalized
  }

  private validateGraph(graph: MagicAgentGraphDefinition): void {
    if (!graph.graphId) throw new Error('MagicAgentGraph graphId is required.')
    if (!graph.name) throw new Error('MagicAgentGraph name is required.')
    if (graph.nodes.length === 0) throw new Error('MagicAgentGraph must contain at least one node.')
    if (graph.outputs.length === 0)
      throw new Error('MagicAgentGraph must contain at least one output.')

    const nodeIds = new Set<string>()
    for (const node of graph.nodes) {
      if (!node.nodeId)
        throw new Error(`MagicAgentGraph "${graph.graphId}" contains a node without nodeId.`)
      if (nodeIds.has(node.nodeId)) {
        throw new Error(
          `MagicAgentGraph "${graph.graphId}" contains duplicate node "${node.nodeId}".`
        )
      }
      nodeIds.add(node.nodeId)
    }

    const channelIds = new Set<string>()
    for (const channel of graph.channels) {
      if (!channel.channelId) {
        throw new Error(`MagicAgentGraph "${graph.graphId}" contains a channel without channelId.`)
      }
      if (channelIds.has(channel.channelId)) {
        throw new Error(
          `MagicAgentGraph "${graph.graphId}" contains duplicate channel "${channel.channelId}".`
        )
      }
      if (!nodeIds.has(channel.from)) {
        throw new Error(
          `MagicAgentGraph channel "${channel.channelId}" references missing from node.`
        )
      }
      if (!nodeIds.has(channel.to)) {
        throw new Error(
          `MagicAgentGraph channel "${channel.channelId}" references missing to node.`
        )
      }
      channelIds.add(channel.channelId)
    }

    for (const output of graph.outputs) {
      if (!output.outputId) {
        throw new Error(`MagicAgentGraph "${graph.graphId}" contains an output without outputId.`)
      }
      if (!nodeIds.has(output.sourceNodeId)) {
        throw new Error(
          `MagicAgentGraph output "${output.outputId}" references missing source node.`
        )
      }
      if (output.channelId && !channelIds.has(output.channelId)) {
        throw new Error(`MagicAgentGraph output "${output.outputId}" references missing channel.`)
      }
    }

    for (const entryNodeId of graph.entryNodeIds) {
      if (!nodeIds.has(entryNodeId)) {
        throw new Error(`MagicAgentGraph entry node "${entryNodeId}" does not exist.`)
      }
    }
  }

  private buildChannelRecords(
    graph: MagicAgentGraphDefinition,
    input: string
  ): MagicAgentGraphRunChannelRecord[] {
    const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]))
    return graph.channels.map((channel) => ({
      channelId: channel.channelId,
      from: channel.from,
      to: channel.to,
      kind: channel.kind,
      content: formatChannelContent(channel, nodes.get(channel.from), nodes.get(channel.to), input),
      createdAt: now(),
      ...(channel.metadata ? { metadata: channel.metadata } : {})
    }))
  }

  private buildOutput(
    graph: MagicAgentGraphDefinition,
    output: MagicAgentGraphOutputDefinition,
    input: string,
    channels: MagicAgentGraphRunChannelRecord[]
  ): MagicAgentGraphRunOutput {
    const sourceNode = graph.nodes.find((node) => node.nodeId === output.sourceNodeId)
    const channel = output.channelId
      ? channels.find((candidate) => candidate.channelId === output.channelId)
      : undefined
    const agentSections = graph.nodes
      .filter((node) => node.kind === 'agent')
      .map((node) => formatAgentSection(node, input))
      .join('\n\n')
    const content = [
      `# ${output.name}`,
      graph.description,
      `## Request\n${input}`,
      agentSections,
      channel ? `## Output Wire\n${channel.content}` : undefined,
      sourceNode ? `## Source\n${sourceNode.name}` : undefined
    ]
      .filter(Boolean)
      .join('\n\n')

    return {
      outputId: output.outputId,
      name: output.name,
      content,
      sourceNodeId: output.sourceNodeId,
      ...(output.channelId ? { channelId: output.channelId } : {}),
      ...(output.mimeType ? { mimeType: output.mimeType } : {}),
      ...(output.metadata ? { metadata: output.metadata } : {})
    }
  }

  private markRun(
    run: MagicAgentGraphRunRecord,
    status: MagicAgentGraphRunRecord['status'],
    updates?: Partial<MagicAgentGraphRunRecord>
  ): void {
    Object.assign(run, updates || {})
    run.status = status
    run.updatedAt = now()
    this.runs.set(run.runId, run)
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (!signal.aborted) return
    const message =
      typeof signal.reason === 'string' ? signal.reason : 'MagicAgentGraph run cancelled.'
    const error = new Error(message)
    error.name = 'AbortError'
    throw error
  }
}

let runtimeSingleton: MagicAgentGraphRuntime | null = null

export const getMagicAgentGraphRuntime = (): MagicAgentGraphRuntime => {
  if (!runtimeSingleton) {
    runtimeSingleton = new MagicAgentGraphRuntime()
  }
  return runtimeSingleton
}
