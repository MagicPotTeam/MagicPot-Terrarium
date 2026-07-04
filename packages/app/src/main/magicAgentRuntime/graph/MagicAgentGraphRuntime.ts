import {
  builtInMagicAgentGraphs,
  type MagicAgentGraphCancelResult,
  type MagicAgentGraphChannelDefinition,
  type MagicAgentGraphConditionDefinition,
  type MagicAgentGraphCreateRequest,
  type MagicAgentGraphDefinition,
  type MagicAgentGraphListItem,
  type MagicAgentGraphNodeDefinition,
  type MagicAgentGraphOutputDefinition,
  type MagicAgentGraphRunChannelRecord,
  type MagicAgentGraphRunEventType,
  type MagicAgentGraphRunNodeRecord,
  type MagicAgentGraphRunOutput,
  type MagicAgentGraphRunRecord,
  type MagicAgentGraphRunRequest,
  type MagicAgentGraphRunResult
} from '@shared/magicAgent'
import { getAgentSessionKey, type AgentRouteLike } from '@shared/agent'
import type {
  MagicAgentPlatformRunReq,
  MagicAgentPlatformRunResp,
  MagicAgentPlatformToolCallReq,
  MagicAgentPlatformToolCallResp
} from '@shared/api/svcMagicAgentPlatform'

export type MagicAgentGraphRuntimePolicy = {
  maxNodes: number
  maxChannels: number
  maxOutputs: number
  maxInputChars: number
  maxNodeOutputChars: number
  maxOutputContentChars: number
  maxEvents: number
  maxRunRecordsPerSession: number
  maxConditionPatternChars: number
}

export type MagicAgentGraphRuntimeDeps = {
  runAgent?: (request: MagicAgentPlatformRunReq) => Promise<MagicAgentPlatformRunResp>
  callTool?: (request: MagicAgentPlatformToolCallReq) => Promise<MagicAgentPlatformToolCallResp>
  policy?: Partial<MagicAgentGraphRuntimePolicy>
}

const DEFAULT_GRAPH_RUNTIME_POLICY: MagicAgentGraphRuntimePolicy = {
  maxNodes: 100,
  maxChannels: 200,
  maxOutputs: 50,
  maxInputChars: 120_000,
  maxNodeOutputChars: 80_000,
  maxOutputContentChars: 120_000,
  maxEvents: 2_000,
  maxRunRecordsPerSession: 200,
  maxConditionPatternChars: 500
}

const normalizePositiveInteger = (value: unknown, fallback: number): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : fallback
}

const normalizePolicy = (
  overrides?: Partial<MagicAgentGraphRuntimePolicy>
): MagicAgentGraphRuntimePolicy => {
  const merged = { ...DEFAULT_GRAPH_RUNTIME_POLICY, ...(overrides || {}) }
  return {
    maxNodes: normalizePositiveInteger(merged.maxNodes, DEFAULT_GRAPH_RUNTIME_POLICY.maxNodes),
    maxChannels: normalizePositiveInteger(
      merged.maxChannels,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxChannels
    ),
    maxOutputs: normalizePositiveInteger(
      merged.maxOutputs,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxOutputs
    ),
    maxInputChars: normalizePositiveInteger(
      merged.maxInputChars,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxInputChars
    ),
    maxNodeOutputChars: normalizePositiveInteger(
      merged.maxNodeOutputChars,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxNodeOutputChars
    ),
    maxOutputContentChars: normalizePositiveInteger(
      merged.maxOutputContentChars,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxOutputContentChars
    ),
    maxEvents: normalizePositiveInteger(merged.maxEvents, DEFAULT_GRAPH_RUNTIME_POLICY.maxEvents),
    maxRunRecordsPerSession: normalizePositiveInteger(
      merged.maxRunRecordsPerSession,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxRunRecordsPerSession
    ),
    maxConditionPatternChars: normalizePositiveInteger(
      merged.maxConditionPatternChars,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxConditionPatternChars
    )
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const now = (): number => Date.now()

const cleanString = (value: unknown): string => String(value || '').trim()

const stringifyValue = (value: unknown): string => {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const truncateText = (value: string, maxChars: number): string => {
  if (!Number.isFinite(maxChars) || maxChars < 0 || value.length <= maxChars) {
    return value
  }
  if (maxChars <= 0) {
    return ''
  }
  const marker = '...[truncated]'
  if (maxChars <= marker.length) {
    return marker.slice(0, maxChars)
  }
  return `${value.slice(0, maxChars - marker.length)}${marker}`
}

const GRAPH_ROUTE_SCOPE_TYPES = new Set(['dm', 'group', 'channel', 'thread', 'topic'])
const SUPPORTED_GRAPH_NODE_KINDS = new Set([
  'agent',
  'tool',
  'input',
  'condition',
  'merge',
  'output'
])
const SUPPORTED_GRAPH_CONDITION_OPERATORS = new Set([
  'always',
  'truthy',
  'falsy',
  'equals',
  'contains',
  'matches'
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeCondition = (condition: unknown): MagicAgentGraphConditionDefinition | undefined => {
  if (condition === undefined || condition === null) return undefined
  if (!isRecord(condition)) {
    throw new Error('MagicAgentGraph condition must be an object.')
  }
  const sourceNodeId = cleanString(condition.sourceNodeId)
  const operator = cleanString(condition.operator)
  return {
    ...(sourceNodeId ? { sourceNodeId } : {}),
    ...(operator ? { operator: operator as MagicAgentGraphConditionDefinition['operator'] } : {}),
    ...(Object.prototype.hasOwnProperty.call(condition, 'value') ? { value: condition.value } : {})
  }
}

type GraphExecutionContext = {
  graph: MagicAgentGraphDefinition
  request: MagicAgentGraphRunRequest
  route: AgentRouteLike
  run: MagicAgentGraphRunRecord
  nodeOutputs: Map<string, string>
  deliveredChannelIds: Set<string>
  allowedToolNames: Set<string>
  plannedNodeIds: Set<string>
  plannedChannelIds: Set<string>
}

type GraphObjectivePlan = {
  outputsToBuild: MagicAgentGraphOutputDefinition[]
  plannedNodeIds: Set<string>
  plannedChannelIds: Set<string>
}

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
  private deps: MagicAgentGraphRuntimeDeps
  private policy: MagicAgentGraphRuntimePolicy

  constructor(
    graphs: MagicAgentGraphDefinition[] = builtInMagicAgentGraphs,
    deps: MagicAgentGraphRuntimeDeps = {}
  ) {
    this.deps = deps
    this.policy = normalizePolicy(deps.policy)
    for (const graph of graphs) {
      const normalized = this.normalizeGraph(graph)
      this.graphs.set(normalized.graphId, normalized)
      this.builtInGraphIds.add(normalized.graphId)
    }
  }

  setDeps(deps: MagicAgentGraphRuntimeDeps): void {
    this.deps = { ...this.deps, ...deps }
    if (deps.policy) {
      this.policy = normalizePolicy({ ...this.policy, ...deps.policy })
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

  listRuns(sessionKey: string, graphId?: string, limit?: number): MagicAgentGraphRunRecord[] {
    const normalizedSessionKey = cleanString(sessionKey)
    const normalizedGraphId = cleanString(graphId)
    const normalizedLimit = Number.isInteger(limit) && Number(limit) > 0 ? Number(limit) : undefined
    if (!normalizedSessionKey) {
      return []
    }
    const runs = [...this.runs.values()]
      .filter((run) => !normalizedGraphId || run.graphId === normalizedGraphId)
      .filter((run) => run.sessionKey === normalizedSessionKey)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    return (normalizedLimit === undefined ? runs : runs.slice(0, normalizedLimit)).map((run) =>
      clone(run)
    )
  }

  async run(request: MagicAgentGraphRunRequest): Promise<MagicAgentGraphRunResult> {
    const route = assertGraphRoute(request.route)
    const sessionKey = getAgentSessionKey(route)
    const graph = this.graphs.get(cleanString(request.graphId))
    if (!graph) {
      throw new Error(`MagicAgentGraph "${request.graphId}" does not exist.`)
    }

    const inputLimit = this.limitText(stringifyValue(request.input), this.policy.maxInputChars)
    const effectiveRequest: MagicAgentGraphRunRequest = { ...request, input: inputLimit.text }
    const inputLimitError = inputLimit.truncated
      ? `MagicAgentGraph run input exceeds maximum length of ${this.policy.maxInputChars} characters.`
      : undefined

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
      input: effectiveRequest.input,
      route,
      sessionKey,
      createdAt,
      updatedAt: createdAt,
      nodes: graph.nodes.map((node) => ({
        nodeId: node.nodeId,
        kind: node.kind,
        status: 'pending'
      })),
      channels: [],
      outputs: [],
      events: [],
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

      this.recordRunEvent(
        runRecord,
        'graph.started',
        `MagicAgentGraph run started: ${graph.graphId}`
      )
      if (inputLimitError) {
        throw new Error(inputLimitError)
      }
      await this.executeGraph(graph, effectiveRequest, route, runRecord, controller.signal)
      this.throwIfCancelled(controller.signal)
      this.markRun(runRecord, 'completed', { endedAt: now() })
      this.recordRunEvent(
        runRecord,
        'graph.completed',
        `MagicAgentGraph run completed: ${graph.graphId}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = controller.signal.aborted ? 'cancelled' : 'failed'
      this.markRun(runRecord, status, { endedAt: now(), error: message })
      this.recordRunEvent(
        runRecord,
        status === 'cancelled' ? 'graph.cancelled' : 'graph.failed',
        status === 'cancelled'
          ? `MagicAgentGraph run cancelled: ${message}`
          : `MagicAgentGraph run failed: ${message}`,
        { error: message }
      )
    } finally {
      this.controllers.delete(runId)
      this.runs.set(runId, runRecord)
      this.pruneRunsForSession(sessionKey)
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
    this.recordRunEvent(run, 'graph.cancelled', `MagicAgentGraph run cancelled: ${reason}`, {
      reason
    })
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
        condition: normalizeCondition(node.condition),
        metadata: node.metadata ? { ...node.metadata } : undefined
      })),
      channels: (graph.channels || []).map((channel) => ({
        ...channel,
        channelId: cleanString(channel.channelId),
        from: cleanString(channel.from),
        to: cleanString(channel.to),
        required: channel.required !== false,
        condition: normalizeCondition(channel.condition),
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
    if (graph.nodes.length > this.policy.maxNodes) {
      throw new Error(`MagicAgentGraph exceeds maximum node count of ${this.policy.maxNodes}.`)
    }
    if (graph.channels.length > this.policy.maxChannels) {
      throw new Error(
        `MagicAgentGraph exceeds maximum channel count of ${this.policy.maxChannels}.`
      )
    }
    if (graph.outputs.length > this.policy.maxOutputs) {
      throw new Error(`MagicAgentGraph exceeds maximum output count of ${this.policy.maxOutputs}.`)
    }

    const nodeIds = new Set<string>()
    for (const node of graph.nodes) {
      if (!node.nodeId)
        throw new Error(`MagicAgentGraph "${graph.graphId}" contains a node without nodeId.`)
      if (!SUPPORTED_GRAPH_NODE_KINDS.has(node.kind)) {
        throw new Error(`Unsupported MagicAgentGraph node kind: ${node.kind}`)
      }
      if (nodeIds.has(node.nodeId)) {
        throw new Error(
          `MagicAgentGraph "${graph.graphId}" contains duplicate node "${node.nodeId}".`
        )
      }
      nodeIds.add(node.nodeId)
    }

    for (const node of graph.nodes) {
      this.validateCondition(node.condition, nodeIds, `node "${node.nodeId}"`)
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
      this.validateCondition(channel.condition, nodeIds, `channel "${channel.channelId}"`)
      channelIds.add(channel.channelId)
    }

    const outputIds = new Set<string>()
    for (const output of graph.outputs) {
      if (!output.outputId) {
        throw new Error(`MagicAgentGraph "${graph.graphId}" contains an output without outputId.`)
      }
      if (outputIds.has(output.outputId)) {
        throw new Error(
          `MagicAgentGraph "${graph.graphId}" contains duplicate output "${output.outputId}".`
        )
      }
      if (!nodeIds.has(output.sourceNodeId)) {
        throw new Error(
          `MagicAgentGraph output "${output.outputId}" references missing source node.`
        )
      }
      if (output.channelId && !channelIds.has(output.channelId)) {
        throw new Error(`MagicAgentGraph output "${output.outputId}" references missing channel.`)
      }
      outputIds.add(output.outputId)
    }

    for (const entryNodeId of graph.entryNodeIds) {
      if (!nodeIds.has(entryNodeId)) {
        throw new Error(`MagicAgentGraph entry node "${entryNodeId}" does not exist.`)
      }
    }

    this.sortGraphNodes(graph)
  }

  private validateCondition(
    condition: MagicAgentGraphConditionDefinition | undefined,
    nodeIds: Set<string>,
    owner: string
  ): void {
    if (!condition) return
    const operator = condition.operator || 'truthy'
    if (!SUPPORTED_GRAPH_CONDITION_OPERATORS.has(operator)) {
      throw new Error(`MagicAgentGraph ${owner} contains unsupported condition operator.`)
    }
    if (condition.sourceNodeId && !nodeIds.has(condition.sourceNodeId)) {
      throw new Error(`MagicAgentGraph ${owner} condition references missing source node.`)
    }
    if (operator !== 'matches') {
      return
    }
    const pattern = stringifyValue(condition.value)
    if (pattern.length > this.policy.maxConditionPatternChars) {
      throw new Error(
        `MagicAgentGraph ${owner} condition pattern exceeds maximum length of ${this.policy.maxConditionPatternChars}.`
      )
    }
    try {
      new RegExp(pattern)
    } catch {
      throw new Error(`MagicAgentGraph ${owner} condition contains an invalid pattern.`)
    }
  }

  private async executeGraph(
    graph: MagicAgentGraphDefinition,
    request: MagicAgentGraphRunRequest,
    route: AgentRouteLike,
    runRecord: MagicAgentGraphRunRecord,
    signal: AbortSignal
  ): Promise<void> {
    const objectivePlan = this.buildObjectivePlan(graph, request)
    const incomingByNode = new Map<string, MagicAgentGraphChannelDefinition[]>()
    for (const channel of graph.channels)
      incomingByNode.set(channel.to, [...(incomingByNode.get(channel.to) || []), channel])
    const context: GraphExecutionContext = {
      graph,
      request,
      route,
      run: runRecord,
      nodeOutputs: new Map(),
      deliveredChannelIds: new Set(),
      allowedToolNames: new Set(
        Array.isArray(request.allowedToolNames)
          ? request.allowedToolNames.map(cleanString).filter(Boolean)
          : []
      ),
      plannedNodeIds: objectivePlan.plannedNodeIds,
      plannedChannelIds: objectivePlan.plannedChannelIds
    }
    const entryNodeIds = new Set(graph.entryNodeIds)
    const hasEntries = entryNodeIds.size > 0
    for (const node of this.sortGraphNodes(graph)) {
      this.throwIfCancelled(signal)
      if (!context.plannedNodeIds.has(node.nodeId)) {
        this.skipNode(runRecord, node, 'outside-objective', 'Node is outside requested outputs.')
        continue
      }
      const incoming = (incomingByNode.get(node.nodeId) || []).filter((channel) =>
        context.plannedChannelIds.has(channel.channelId)
      )
      const hasDeliveredInput = incoming.some((channel) =>
        context.deliveredChannelIds.has(channel.channelId)
      )
      const missingRequiredChannels = incoming.filter(
        (channel) =>
          channel.required !== false && !context.deliveredChannelIds.has(channel.channelId)
      )
      if (missingRequiredChannels.length > 0) {
        const missingChannelIds = missingRequiredChannels.map((channel) => channel.channelId)
        const message = `Required MagicAgentGraph channel(s) did not reach node "${node.nodeId}": ${missingChannelIds.join(', ')}`
        this.updateNodeRun(runRecord, node, 'failed', {
          endedAt: now(),
          error: message,
          metadata: { missingChannelIds }
        })
        this.recordRunEvent(
          runRecord,
          'node.failed',
          `MagicAgentGraph node failed: ${node.nodeId}: ${message}`,
          {
            nodeId: node.nodeId,
            kind: node.kind,
            missingChannelIds
          }
        )
        throw new Error(message)
      }
      const shouldRun =
        node.kind === 'input' ||
        entryNodeIds.has(node.nodeId) ||
        hasDeliveredInput ||
        (!hasEntries && incoming.length === 0)
      if (!shouldRun) {
        this.skipNode(
          runRecord,
          node,
          'inactive-inbound',
          'No active inbound channel reached this node.'
        )
        continue
      }
      const input = this.collectNodeInput(node, incoming, context)
      try {
        this.updateNodeRun(runRecord, node, 'running', { startedAt: now(), input })
        this.recordRunEvent(
          runRecord,
          'node.started',
          `MagicAgentGraph node started: ${node.nodeId}`,
          { nodeId: node.nodeId, kind: node.kind }
        )
        const rawOutput = await this.executeNode(node, input, context)
        this.throwIfCancelled(signal)
        const outputLimit = this.limitText(
          stringifyValue(rawOutput),
          this.policy.maxNodeOutputChars
        )
        const outputMetadata = outputLimit.truncated
          ? { outputTruncated: true, maxOutputChars: this.policy.maxNodeOutputChars }
          : undefined
        context.nodeOutputs.set(node.nodeId, outputLimit.text)
        this.updateNodeRun(runRecord, node, 'completed', {
          endedAt: now(),
          output: outputLimit.text,
          ...(outputMetadata ? { metadata: outputMetadata } : {})
        })
        this.recordRunEvent(
          runRecord,
          'node.completed',
          `MagicAgentGraph node completed: ${node.nodeId}`,
          { nodeId: node.nodeId, kind: node.kind, ...(outputMetadata || {}) }
        )
        this.emitOutgoingChannels(node, outputLimit.text, context)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.updateNodeRun(runRecord, node, 'failed', { endedAt: now(), error: message })
        this.recordRunEvent(
          runRecord,
          'node.failed',
          `MagicAgentGraph node failed: ${node.nodeId}: ${message}`,
          { nodeId: node.nodeId, kind: node.kind, error: message }
        )
        throw error
      }
    }
    runRecord.outputs = objectivePlan.outputsToBuild.map((output) =>
      this.buildOutput(graph, output, request.input, runRecord.channels, context.nodeOutputs)
    )
    for (const output of runRecord.outputs)
      this.recordRunEvent(
        runRecord,
        'output.created',
        `MagicAgentGraph output created: ${output.outputId}`,
        { outputId: output.outputId, nodeId: output.sourceNodeId }
      )
  }

  private buildObjectivePlan(
    graph: MagicAgentGraphDefinition,
    request: MagicAgentGraphRunRequest
  ): GraphObjectivePlan {
    const outputFilter = new Set((request.outputIds || []).map(cleanString).filter(Boolean))
    const outputsToBuild = graph.outputs.filter(
      (output) => outputFilter.size === 0 || outputFilter.has(output.outputId)
    )
    if (outputsToBuild.length === 0 && outputFilter.size > 0)
      throw new Error(`No requested outputs exist on MagicAgentGraph "${graph.graphId}".`)

    const incomingByNode = new Map<string, MagicAgentGraphChannelDefinition[]>()
    for (const channel of graph.channels) {
      incomingByNode.set(channel.to, [...(incomingByNode.get(channel.to) || []), channel])
    }

    const plannedNodeIds = new Set<string>()
    const plannedChannelIds = new Set<string>()
    const visitNode = (nodeId: string): void => {
      if (plannedNodeIds.has(nodeId)) {
        return
      }
      plannedNodeIds.add(nodeId)
      for (const channel of incomingByNode.get(nodeId) || []) {
        plannedChannelIds.add(channel.channelId)
        visitNode(channel.from)
      }
    }

    for (const output of outputsToBuild) {
      plannedNodeIds.add(output.sourceNodeId)
      if (output.channelId) {
        const outputChannel = graph.channels.find(
          (channel) => channel.channelId === output.channelId
        )
        if (outputChannel) {
          plannedChannelIds.add(outputChannel.channelId)
          visitNode(outputChannel.from)
          plannedNodeIds.add(outputChannel.to)
        }
      } else {
        visitNode(output.sourceNodeId)
      }
    }

    return { outputsToBuild, plannedNodeIds, plannedChannelIds }
  }

  private sortGraphNodes(graph: MagicAgentGraphDefinition): MagicAgentGraphNodeDefinition[] {
    const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]))
    const indegree = new Map(graph.nodes.map((node) => [node.nodeId, 0]))
    const outgoing = new Map<string, MagicAgentGraphChannelDefinition[]>()
    for (const channel of graph.channels) {
      indegree.set(channel.to, (indegree.get(channel.to) || 0) + 1)
      outgoing.set(channel.from, [...(outgoing.get(channel.from) || []), channel])
    }
    const queue = graph.nodes.filter((node) => (indegree.get(node.nodeId) || 0) === 0)
    const sorted: MagicAgentGraphNodeDefinition[] = []
    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index]
      sorted.push(node)
      for (const channel of outgoing.get(node.nodeId) || []) {
        const nextCount = (indegree.get(channel.to) || 0) - 1
        indegree.set(channel.to, nextCount)
        if (nextCount === 0) {
          const nextNode = nodesById.get(channel.to)
          if (nextNode) queue.push(nextNode)
        }
      }
    }
    if (sorted.length !== graph.nodes.length)
      throw new Error(`MagicAgentGraph "${graph.graphId}" contains a cycle.`)
    return sorted
  }

  private collectNodeInput(
    node: MagicAgentGraphNodeDefinition,
    incoming: MagicAgentGraphChannelDefinition[],
    context: GraphExecutionContext
  ): string {
    const deliveredInputs = incoming
      .filter((channel) => context.deliveredChannelIds.has(channel.channelId))
      .map((channel) => context.nodeOutputs.get(channel.from) || '')
      .filter(Boolean)
    if (deliveredInputs.length > 0) return deliveredInputs.join('\n\n')
    if (node.kind === 'input' || context.graph.entryNodeIds.includes(node.nodeId))
      return context.request.input
    return ''
  }

  private async executeNode(
    node: MagicAgentGraphNodeDefinition,
    input: string,
    context: GraphExecutionContext
  ): Promise<string> {
    switch (node.kind) {
      case 'input':
        return context.request.input
      case 'agent':
        return this.executeAgentNode(node, input || context.request.input, context)
      case 'condition':
        return this.evaluateCondition(node.condition, input, context) ? 'true' : 'false'
      case 'merge':
      case 'output':
        return input || context.request.input
      case 'tool':
        return this.executeToolNode(node, input || context.request.input, context)
      default: {
        const exhaustive: never = node.kind
        throw new Error(`Unsupported MagicAgentGraph node kind: ${exhaustive}`)
      }
    }
  }

  private async executeAgentNode(
    node: MagicAgentGraphNodeDefinition,
    input: string,
    context: GraphExecutionContext
  ): Promise<string> {
    if (!this.deps.runAgent) return formatAgentSection(node, input)
    const result = await this.deps.runAgent({
      agentId: cleanString(node.agentId) || node.nodeId,
      text: input,
      route: context.route,
      ...(node.modelName ? { profileId: node.modelName } : {}),
      ...(node.instruction ? { systemPrompt: node.instruction } : {}),
      ...(context.request.allowedToolNames !== undefined
        ? { allowedToolNames: context.request.allowedToolNames }
        : {}),
      metadata: {
        ...(context.request.metadata || {}),
        graphId: context.graph.graphId,
        graphRunId: context.run.runId,
        nodeId: node.nodeId,
        route: context.route,
        sessionKey: context.run.sessionKey
      }
    })
    if (result.status !== 'completed')
      throw new Error(
        result.error || `MagicAgentGraph agent node ended with status: ${result.status}`
      )
    const lastAssistant = [...result.messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    return result.content || lastAssistant?.content || ''
  }

  private async executeToolNode(
    node: MagicAgentGraphNodeDefinition,
    input: string,
    context: GraphExecutionContext
  ): Promise<string> {
    const config = isRecord(node.config) ? node.config : {}
    const toolName = cleanString(node.toolName) || cleanString(config.toolName)
    if (!toolName)
      throw new Error(`MagicAgentGraph tool node "${node.nodeId}" is missing toolName.`)
    if (!context.allowedToolNames.has(toolName))
      throw new Error(`MagicAgentGraph tool "${toolName}" is not allowed for this graph run.`)
    if (!this.deps.callTool)
      throw new Error(`MagicAgentGraph tool "${toolName}" has no configured executor.`)
    const args = isRecord(config.args)
      ? { ...config.args }
      : Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'toolName'))
    if (!Object.keys(args).length && input) args.input = input
    this.recordRunEvent(context.run, 'tool.invoked', `MagicAgentGraph tool invoked: ${toolName}`, {
      nodeId: node.nodeId,
      toolName
    })
    const result = await this.deps.callTool({
      name: toolName,
      args,
      route: context.route,
      ...(cleanString(node.agentId) ? { agentId: cleanString(node.agentId) } : {}),
      metadata: {
        ...(context.request.metadata || {}),
        graphId: context.graph.graphId,
        graphRunId: context.run.runId,
        nodeId: node.nodeId,
        route: context.route,
        sessionKey: context.run.sessionKey,
        allowedToolNames: [...context.allowedToolNames]
      }
    })
    if (!result.ok)
      throw new Error(
        result.error ||
          result.unavailableReason ||
          result.content ||
          `MagicAgentGraph tool failed: ${toolName}`
      )
    return result.content || stringifyValue(result.data)
  }

  private emitOutgoingChannels(
    node: MagicAgentGraphNodeDefinition,
    nodeOutput: string,
    context: GraphExecutionContext
  ): void {
    const nodes = new Map(context.graph.nodes.map((candidate) => [candidate.nodeId, candidate]))
    for (const channel of context.graph.channels.filter(
      (candidate) =>
        candidate.from === node.nodeId && context.plannedChannelIds.has(candidate.channelId)
    )) {
      if (!this.evaluateCondition(channel.condition, nodeOutput, context)) continue
      const contentLimit = this.limitText(
        formatChannelContent(channel, nodes.get(channel.from), nodes.get(channel.to), nodeOutput),
        this.policy.maxOutputContentChars
      )
      const metadata = {
        ...(channel.metadata || {}),
        ...(contentLimit.truncated
          ? { contentTruncated: true, maxContentChars: this.policy.maxOutputContentChars }
          : {})
      }
      const record: MagicAgentGraphRunChannelRecord = {
        channelId: channel.channelId,
        from: channel.from,
        to: channel.to,
        kind: channel.kind,
        content: contentLimit.text,
        createdAt: now(),
        ...(Object.keys(metadata).length ? { metadata } : {})
      }
      context.run.channels.push(record)
      context.deliveredChannelIds.add(channel.channelId)
      this.recordRunEvent(
        context.run,
        'channel.message',
        `MagicAgentGraph channel emitted: ${channel.channelId}`,
        {
          nodeId: node.nodeId,
          channelId: channel.channelId,
          from: channel.from,
          to: channel.to,
          kind: channel.kind
        }
      )
    }
  }

  private evaluateCondition(
    condition: MagicAgentGraphConditionDefinition | undefined,
    fallbackValue: string,
    context: GraphExecutionContext
  ): boolean {
    if (!condition) return true
    const source = condition.sourceNodeId
      ? context.nodeOutputs.get(condition.sourceNodeId) || ''
      : fallbackValue
    const sourceText = stringifyValue(source)
    const compareText = stringifyValue(condition.value)
    switch (condition.operator || 'truthy') {
      case 'always':
        return true
      case 'truthy':
        return Boolean(sourceText && sourceText !== 'false' && sourceText !== '0')
      case 'falsy':
        return !sourceText || sourceText === 'false' || sourceText === '0'
      case 'equals':
        return sourceText === compareText
      case 'contains':
        return sourceText.includes(compareText)
      case 'matches':
        if (compareText.length > this.policy.maxConditionPatternChars) {
          return false
        }
        try {
          return new RegExp(compareText).test(sourceText)
        } catch {
          return false
        }
      default:
        return false
    }
  }

  private buildOutput(
    graph: MagicAgentGraphDefinition,
    output: MagicAgentGraphOutputDefinition,
    input: string,
    channels: MagicAgentGraphRunChannelRecord[],
    nodeOutputs: Map<string, string>
  ): MagicAgentGraphRunOutput {
    const sourceNode = graph.nodes.find((node) => node.nodeId === output.sourceNodeId)
    const channel = output.channelId
      ? channels.find((candidate) => candidate.channelId === output.channelId)
      : undefined
    const sourceOutput = nodeOutputs.get(output.sourceNodeId)
    const agentSections = graph.nodes
      .filter((node) => node.kind === 'agent')
      .map((node) => {
        const nodeOutput = nodeOutputs.get(node.nodeId)
        return nodeOutput ? `### ${node.name}\n${nodeOutput}` : undefined
      })
      .filter(Boolean)
      .join('\n\n')
    const content = [
      `# ${output.name}`,
      graph.description,
      `## Request\n${input}`,
      sourceOutput ? `## Source Output\n${sourceOutput}` : undefined,
      agentSections,
      channel ? `## Output Wire\n${channel.content}` : undefined,
      sourceNode ? `## Source\n${sourceNode.name}` : undefined
    ]
      .filter(Boolean)
      .join('\n\n')
    const contentLimit = this.limitText(content, this.policy.maxOutputContentChars)
    const metadata = {
      ...(output.metadata || {}),
      ...(contentLimit.truncated
        ? { contentTruncated: true, maxContentChars: this.policy.maxOutputContentChars }
        : {})
    }

    return {
      outputId: output.outputId,
      name: output.name,
      content: contentLimit.text,
      sourceNodeId: output.sourceNodeId,
      ...(output.channelId ? { channelId: output.channelId } : {}),
      ...(output.mimeType ? { mimeType: output.mimeType } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {})
    }
  }

  private skipNode(
    run: MagicAgentGraphRunRecord,
    node: MagicAgentGraphNodeDefinition,
    reason: string,
    message: string
  ): void {
    this.updateNodeRun(run, node, 'skipped', {
      endedAt: now(),
      metadata: { reason: message }
    })
    this.recordRunEvent(run, 'node.skipped', `MagicAgentGraph node skipped: ${node.nodeId}`, {
      nodeId: node.nodeId,
      reason
    })
  }

  private updateNodeRun(
    run: MagicAgentGraphRunRecord,
    node: MagicAgentGraphNodeDefinition,
    status: MagicAgentGraphRunNodeRecord['status'],
    updates?: Partial<MagicAgentGraphRunNodeRecord>
  ): void {
    let record = run.nodes?.find((candidate) => candidate.nodeId === node.nodeId)
    if (!record) {
      record = { nodeId: node.nodeId, kind: node.kind, status: 'pending' }
      run.nodes = [...(run.nodes || []), record]
    }
    Object.assign(record, updates || {})
    record.status = status
    run.updatedAt = now()
    this.runs.set(run.runId, run)
  }

  private recordRunEvent(
    run: MagicAgentGraphRunRecord,
    type: MagicAgentGraphRunEventType,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    const createdAt = now()
    const event = {
      eventId: createId('magic-agent-graph-event'),
      runId: run.runId,
      graphId: run.graphId,
      type,
      message,
      createdAt,
      ...(cleanString(metadata?.nodeId) ? { nodeId: cleanString(metadata?.nodeId) } : {}),
      ...(cleanString(metadata?.channelId) ? { channelId: cleanString(metadata?.channelId) } : {}),
      ...(cleanString(metadata?.outputId) ? { outputId: cleanString(metadata?.outputId) } : {}),
      ...(metadata ? { metadata } : {})
    }
    run.events = [...(run.events || []), event].slice(-this.policy.maxEvents)
    run.updatedAt = createdAt
    this.runs.set(run.runId, run)
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

  private limitText(value: string, maxChars: number): { text: string; truncated: boolean } {
    const text = stringifyValue(value)
    const limited = truncateText(text, maxChars)
    return { text: limited, truncated: limited.length !== text.length }
  }

  private pruneRunsForSession(sessionKey: string): void {
    const maxRunRecords = this.policy.maxRunRecordsPerSession
    const sessionRuns = [...this.runs.values()]
      .filter((run) => run.sessionKey === sessionKey)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    const runsToRemove = sessionRuns.slice(maxRunRecords)
    for (const run of runsToRemove) {
      if (!this.controllers.has(run.runId)) {
        this.runs.delete(run.runId)
      }
    }
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

export const getMagicAgentGraphRuntime = (
  deps?: MagicAgentGraphRuntimeDeps
): MagicAgentGraphRuntime => {
  if (!runtimeSingleton) {
    runtimeSingleton = new MagicAgentGraphRuntime(builtInMagicAgentGraphs, deps)
  } else if (deps) {
    runtimeSingleton.setDeps(deps)
  }
  return runtimeSingleton
}
