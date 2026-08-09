import { createHash } from 'node:crypto'

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
  type MagicAgentGraphPermissionSnapshot,
  type MagicAgentGraphPendingInputRecord,
  type MagicAgentGraphPendingApprovalRecord,
  type MagicAgentGraphPreflightSnapshot,
  type MagicAgentGraphRunChannelRecord,
  type MagicAgentGraphRunEvent,
  type MagicAgentGraphRunEventType,
  type MagicAgentGraphRunNodeRecord,
  type MagicAgentGraphRunOutput,
  type MagicAgentGraphRunRecord,
  type MagicAgentGraphRunRequest,
  type MagicAgentGraphPauseResult,
  type MagicAgentGraphResumeResult,
  type MagicAgentGraphRunResult,
  type MagicAgentGraphRunStreamEvent
} from '@shared/magicAgent'
import { getAgentSessionKey, type AgentRouteLike } from '@shared/agent'
import type { PolicyActorRef } from '@shared/magicAgentPlatform2'
import { normalizeMagicPotToolName } from '@shared/app/types'
import { isMagicAgentPlatformDeniedToolName } from '../toolPolicy'
import { CooperativeExecutionController } from '../../magicAgentPlatform2/agents/cooperativeExecutionController'
import type { MagicAgentGraphRunStore } from './graphRunStore'
import type { MagicAgentGraphRunEventStore } from './graphRunEventStore'
import { assertSafeMagicAgentGraphId, assertSafeMagicAgentGraphRunId } from './graphIds'
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
  maxSubscribersPerRun: number
  maxSubscribersTotal: number
  /** Maximum wall-clock duration for an entire graph run. Defaults when omitted. */
  maxRunDurationMs?: number
  /** Maximum wall-clock duration for one graph node. Defaults when omitted. */
  maxNodeDurationMs?: number
}

type NormalizedMagicAgentGraphRuntimePolicy = Omit<
  MagicAgentGraphRuntimePolicy,
  'maxRunDurationMs' | 'maxNodeDurationMs'
> & {
  maxRunDurationMs: number
  maxNodeDurationMs: number
}

export type MagicAgentGraphRuntimeExecutionOptions = {
  signal: AbortSignal
}

export type MagicAgentGraphPendingInputMutation = {
  runId: string
  sessionKey: string
  pendingInputId: string
  expectedRevision: number
}

export type MagicAgentGraphInjectPendingInputRequest = MagicAgentGraphPendingInputMutation & {
  value: string
}

export type MagicAgentGraphEditPendingInputRequest = MagicAgentGraphInjectPendingInputRequest & {
  idempotencyKey: string
}

export type MagicAgentGraphPendingInputMutationResult = {
  runId: string
  pendingInputId: string
  revision: number
  status: MagicAgentGraphPendingInputRecord['status']
  replayed?: boolean
}

type PendingInputWaiter = {
  resolve: (value: string) => void
  reject: (error: Error) => void
  submittedValue?: string
  submittedExpectedRevision?: number
  editedValue?: string
  editedValueDigest?: string
  editIdempotencyKey?: string
  editedExpectedRevision?: number
}

export type MagicAgentGraphToolApprovalRequest = Readonly<{
  runId: string
  nodeId: string
  toolName: string
  requestDigest: string
  request: Readonly<MagicAgentPlatformToolCallReq>
  invoke: () => Promise<MagicAgentPlatformToolCallResp>
  signal: AbortSignal
}>

export type MagicAgentGraphToolApproval = Readonly<{
  pending: Readonly<{
    approvalId: string
    revision: number
    createdAt: number
  }>
  decision: Promise<Readonly<{ invoke: () => Promise<MagicAgentPlatformToolCallResp> }>>
}>

export type MagicAgentGraphFirstPartyNodeExecutionRequest = Readonly<{
  family: string
  operation: string
  config: Readonly<Record<string, unknown>>
  input: string
  node: Readonly<MagicAgentGraphNodeDefinition>
  graph: Readonly<MagicAgentGraphDefinition>
  run: Readonly<MagicAgentGraphRunRecord>
  route: Readonly<AgentRouteLike>
  signal: AbortSignal
}>

export type MagicAgentGraphFirstPartyNodeExecutor = (
  request: MagicAgentGraphFirstPartyNodeExecutionRequest
) => Promise<unknown>

export type MagicAgentGraphRuntimeDeps = {
  runAgent?: (
    request: MagicAgentPlatformRunReq,
    options?: MagicAgentGraphRuntimeExecutionOptions
  ) => Promise<MagicAgentPlatformRunResp>
  callTool?: (
    request: MagicAgentPlatformToolCallReq,
    options?: MagicAgentGraphRuntimeExecutionOptions
  ) => Promise<MagicAgentPlatformToolCallResp>
  requestToolApproval?: (
    request: MagicAgentGraphToolApprovalRequest
  ) => MagicAgentGraphToolApproval | undefined
  firstPartyNodeExecutor?: MagicAgentGraphFirstPartyNodeExecutor
  runStore?: MagicAgentGraphRunStore
  runEventStore?: MagicAgentGraphRunEventStore
  policy?: Partial<MagicAgentGraphRuntimePolicy>
}

const DEFAULT_GRAPH_RUNTIME_POLICY: NormalizedMagicAgentGraphRuntimePolicy = {
  maxRunDurationMs: 10 * 60_000,
  maxNodeDurationMs: 2 * 60_000,
  maxNodes: 100,
  maxChannels: 200,
  maxOutputs: 50,
  maxInputChars: 120_000,
  maxNodeOutputChars: 80_000,
  maxOutputContentChars: 120_000,
  maxEvents: 2_000,
  maxRunRecordsPerSession: 200,
  maxConditionPatternChars: 500,
  maxSubscribersPerRun: 20,
  maxSubscribersTotal: 100
}

const normalizePositiveInteger = (value: unknown, fallback: number): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : fallback
}

const normalizePolicy = (
  overrides?: Partial<MagicAgentGraphRuntimePolicy>
): NormalizedMagicAgentGraphRuntimePolicy => {
  const merged = { ...DEFAULT_GRAPH_RUNTIME_POLICY, ...(overrides || {}) }
  return {
    maxRunDurationMs: normalizePositiveInteger(
      merged.maxRunDurationMs,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxRunDurationMs
    ),
    maxNodeDurationMs: normalizePositiveInteger(
      merged.maxNodeDurationMs,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxNodeDurationMs
    ),
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
    ),
    maxSubscribersPerRun: normalizePositiveInteger(
      merged.maxSubscribersPerRun,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxSubscribersPerRun
    ),
    maxSubscribersTotal: normalizePositiveInteger(
      merged.maxSubscribersTotal,
      DEFAULT_GRAPH_RUNTIME_POLICY.maxSubscribersTotal
    )
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const now = (): number => Date.now()

const cleanString = (value: unknown): string => String(value || '').trim()
const digestPendingInput = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

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

const TERMINAL_GRAPH_RUN_STATUSES = new Set<MagicAgentGraphRunRecord['status']>([
  'completed',
  'failed',
  'cancelled'
])

class MagicAgentGraphTimeoutError extends Error {
  constructor(
    message: string,
    readonly scope: 'run' | 'node'
  ) {
    super(message)
    this.name = 'MagicAgentGraphTimeoutError'
  }
}

type MagicAgentGraphRunSubscriber = {
  sessionKey: string
  handler: (event: MagicAgentGraphRunStreamEvent) => void
}

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
  signal: AbortSignal
  runDeadlineAt: number
  nodeDeadlineAt?: number
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
  private readonly cooperativeControllers = new Map<string, CooperativeExecutionController>()
  private readonly runSubscribers = new Map<string, Map<number, MagicAgentGraphRunSubscriber>>()
  private readonly runStreamSequences = new Map<string, number>()
  private readonly runPersistenceQueues = new Map<string, Promise<void>>()
  private readonly pendingInputWaiters = new Map<string, PendingInputWaiter>()
  private nextRunSubscriberId = 1
  private runStore?: MagicAgentGraphRunStore
  private runEventStore?: MagicAgentGraphRunEventStore
  private deps: MagicAgentGraphRuntimeDeps
  private policy: NormalizedMagicAgentGraphRuntimePolicy

  constructor(
    graphs: MagicAgentGraphDefinition[] = builtInMagicAgentGraphs,
    deps: MagicAgentGraphRuntimeDeps = {}
  ) {
    this.deps = deps
    this.runStore = deps.runStore
    this.runEventStore = deps.runEventStore
    this.policy = normalizePolicy(deps.policy)
    for (const graph of graphs) {
      const normalized = this.normalizeGraph(graph)
      this.graphs.set(normalized.graphId, normalized)
      this.builtInGraphIds.add(normalized.graphId)
    }
  }

  setDeps(deps: MagicAgentGraphRuntimeDeps): void {
    this.deps = { ...this.deps, ...deps }
    if (deps.runStore) {
      this.runStore = deps.runStore
    }
    if (deps.runEventStore) this.runEventStore = deps.runEventStore
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

  async getRunByRoute(
    runId: string,
    route: AgentRouteLike
  ): Promise<MagicAgentGraphRunRecord | undefined> {
    const normalizedRunId = assertSafeMagicAgentGraphRunId(runId)
    const normalizedRoute = assertGraphRoute(route)
    const sessionKey = getAgentSessionKey(normalizedRoute)
    const activeRun = this.getRun(normalizedRunId, sessionKey)
    if (activeRun) return activeRun
    return this.runStore?.get(normalizedRunId, normalizedRoute)
  }

  async listRunsForRoute(
    route: AgentRouteLike,
    graphId?: string,
    limit?: number
  ): Promise<MagicAgentGraphRunRecord[]> {
    const normalizedRoute = assertGraphRoute(route)
    const sessionKey = getAgentSessionKey(normalizedRoute)
    const normalizedGraphId = cleanString(graphId)
    const normalizedLimit = Number.isInteger(limit) && Number(limit) > 0 ? Number(limit) : undefined
    const runStore = this.runStore
    if (!runStore) {
      return this.listRuns(sessionKey, normalizedGraphId, normalizedLimit)
    }

    await this.flushRunPersistenceQueues()
    const persistedRuns = await runStore.list({
      route: normalizedRoute,
      ...(normalizedGraphId ? { graphId: normalizedGraphId } : {}),
      ...(normalizedLimit ? { limit: normalizedLimit } : {})
    })
    const mergedRuns = new Map<string, MagicAgentGraphRunRecord>()
    for (const run of persistedRuns) mergedRuns.set(run.runId, run)
    for (const run of this.listRuns(sessionKey, normalizedGraphId)) mergedRuns.set(run.runId, run)
    const sortedRuns = [...mergedRuns.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
    )
    return (normalizedLimit === undefined ? sortedRuns : sortedRuns.slice(0, normalizedLimit)).map(
      clone
    )
  }

  async run(request: MagicAgentGraphRunRequest): Promise<MagicAgentGraphRunResult> {
    const route = assertGraphRoute(request.route)
    const sessionKey = getAgentSessionKey(route)
    const graphId = assertSafeMagicAgentGraphId(request.graphId)
    const graph = this.graphs.get(graphId)
    if (!graph) {
      throw new Error(`MagicAgentGraph "${request.graphId}" does not exist.`)
    }
    if (
      request.nodeExecution &&
      !graph.nodes.some((node) => node.nodeId === request.nodeExecution!.nodeId)
    )
      throw new Error(`MagicAgentGraph node "${request.nodeExecution.nodeId}" does not exist.`)

    const inputLimit = this.limitText(stringifyValue(request.input), this.policy.maxInputChars)
    const effectiveRequest: MagicAgentGraphRunRequest = { ...request, input: inputLimit.text }
    const inputLimitError = inputLimit.truncated
      ? `MagicAgentGraph run input exceeds maximum length of ${this.policy.maxInputChars} characters.`
      : undefined

    const runId = assertSafeMagicAgentGraphRunId(
      cleanString(request.runId) || createId('magic-agent-graph-run')
    )
    const persistedRun = this.runStore ? await this.runStore.get(runId, route) : undefined
    if (this.runs.has(runId) || persistedRun) {
      throw new Error(`MagicAgentGraph run "${runId}" already exists.`)
    }

    const controller = new AbortController()
    const cooperativeController = new CooperativeExecutionController()
    const createdAt = now()
    const runDeadlineAt = createdAt + this.policy.maxRunDurationMs
    const runtimeBudget = {
      maxRunDurationMs: this.policy.maxRunDurationMs,
      maxNodeDurationMs: this.policy.maxNodeDurationMs,
      runDeadlineAt
    }
    const requestMetadata = request.metadata || {}
    const seededNodeOutputs = new Map<string, string>()
    if (request.nodeExecution?.mode === 'run-from-node') {
      const explicitInputs = request.nodeExecution.inputs || {}
      for (const [key, value] of Object.entries(explicitInputs))
        seededNodeOutputs.set(key, stringifyValue(value))
      if (request.nodeExecution.priorRunId) {
        const priorRun = this.runStore
          ? await this.runStore.get(request.nodeExecution.priorRunId, route)
          : this.runs.get(request.nodeExecution.priorRunId)
        if (!priorRun || priorRun.graphId !== graphId)
          throw new Error('Prior durable graph run is unavailable or belongs to another graph.')
        for (const node of priorRun.nodes || [])
          if (
            node.status === 'completed' &&
            node.output !== undefined &&
            !seededNodeOutputs.has(node.nodeId)
          )
            seededNodeOutputs.set(node.nodeId, node.output)
      }
    }
    const permissionSnapshot = requestMetadata.permissionSnapshot as
      | MagicAgentGraphPermissionSnapshot
      | undefined
    const preflightSnapshot = requestMetadata.preflightSnapshot as
      | MagicAgentGraphPreflightSnapshot
      | undefined
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
      graphSnapshot: clone(graph),
      runtimeTopology: {
        graphId: graph.graphId,
        runId,
        route,
        sessionKey,
        revision: createdAt,
        resources: graph.nodes.map((node) => ({
          resourceId: `graph-node:${runId}:${node.nodeId}`,
          kind: 'node' as const,
          nodeKind: node.kind,
          status: 'pending' as const,
          sourceNodeId: node.nodeId,
          createdAt,
          metadata: { executionKind: `graph-${node.kind}-node` }
        }))
      },
      ...(permissionSnapshot ? { permissionSnapshot: clone(permissionSnapshot) } : {}),
      ...(preflightSnapshot ? { preflightSnapshot: clone(preflightSnapshot) } : {}),
      metadata: { ...requestMetadata, route, sessionKey, runtimeBudget }
    }

    this.runs.set(runId, runRecord)
    void this.queueRunPersistence(runRecord)
    this.controllers.set(runId, controller)
    this.cooperativeControllers.set(runId, cooperativeController)

    try {
      this.markRun(runRecord, 'running', { startedAt: now() })
      await Promise.resolve()
      this.throwIfCancelled(controller.signal)

      this.recordRunEvent(
        runRecord,
        'graph.started',
        `MagicAgentGraph run started: ${graph.graphId}`,
        { runtimeBudget }
      )
      if (inputLimitError) {
        throw new Error(inputLimitError)
      }
      const runTimeoutError = new MagicAgentGraphTimeoutError(
        `MagicAgentGraph run timed out after ${this.policy.maxRunDurationMs}ms.`,
        'run'
      )
      await this.awaitBounded(
        this.executeGraph(
          graph,
          effectiveRequest,
          route,
          runRecord,
          controller.signal,
          runDeadlineAt,
          cooperativeController,
          seededNodeOutputs
        ),
        controller.signal,
        Math.max(1, runDeadlineAt - now()),
        runTimeoutError,
        () => controller.abort(runTimeoutError)
      )
      this.throwIfCancelled(controller.signal)
      this.markRun(runRecord, 'completed', { endedAt: now() })
      this.recordRunEvent(
        runRecord,
        'graph.completed',
        `MagicAgentGraph run completed: ${graph.graphId}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const timedOut = error instanceof MagicAgentGraphTimeoutError
      const status = timedOut ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed'
      const failureMetadata = timedOut
        ? { error: message, timedOut: true, timeoutScope: error.scope, runtimeBudget }
        : { error: message }
      const alreadyCancelled =
        status === 'cancelled' &&
        runRecord.status === 'cancelled' &&
        (runRecord.events || []).some((event) => event.type === 'graph.cancelled')
      this.skipPendingNodesAfterTermination(runRecord, status, message, failureMetadata)
      if (alreadyCancelled) {
        runRecord.error = runRecord.error || message
        runRecord.endedAt = runRecord.endedAt || now()
        this.runs.set(runId, runRecord)
        void this.queueRunPersistence(runRecord)
      } else {
        this.markRun(runRecord, status, { endedAt: now(), error: message })
        this.recordRunEvent(
          runRecord,
          status === 'cancelled' ? 'graph.cancelled' : 'graph.failed',
          status === 'cancelled'
            ? `MagicAgentGraph run cancelled: ${message}`
            : `MagicAgentGraph run failed: ${message}`,
          failureMetadata
        )
      }
    } finally {
      this.controllers.delete(runId)
      this.cooperativeControllers.delete(runId)
      this.pendingInputWaiters.delete(runId)
      this.runs.set(runId, runRecord)
      const persisted = this.queueRunPersistence(runRecord)
      this.notifyRunClosed(runRecord)
      await persisted
      await this.pruneRunsForSession(sessionKey)
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
    if (controller?.signal.aborted) {
      if (controller.signal.reason instanceof MagicAgentGraphTimeoutError) {
        return {
          runId: normalizedRunId,
          cancelled: false,
          status: 'failed',
          error: controller.signal.reason.message
        }
      }
      return { runId: normalizedRunId, cancelled: false, status: 'cancelled' }
    }
    controller?.abort(reason)
    this.cooperativeControllers.get(normalizedRunId)?.resume()
    this.markRun(run, 'cancelled', { endedAt: now(), error: reason })
    this.recordRunEvent(run, 'graph.cancelled', `MagicAgentGraph run cancelled: ${reason}`, {
      reason
    })
    return { runId: normalizedRunId, cancelled: true, status: run.status }
  }

  async injectPendingInput(
    request: MagicAgentGraphInjectPendingInputRequest
  ): Promise<MagicAgentGraphPendingInputMutationResult> {
    const run = this.requirePendingInputRun(request)
    const pending = run.pendingInput!
    const waiter = this.pendingInputWaiters.get(run.runId)
    if (pending.revision !== request.expectedRevision || pending.status !== 'awaiting') {
      if (
        waiter?.submittedExpectedRevision === request.expectedRevision &&
        waiter.submittedValue === request.value &&
        (pending.status === 'submitted' || pending.status === 'consumed')
      )
        return {
          runId: run.runId,
          pendingInputId: pending.pendingInputId,
          revision: pending.revision,
          status: pending.status,
          replayed: true
        }
      throw new Error('Pending input revision conflict.')
    }
    if (!waiter) throw new Error('Pending input is not active in this process.')
    const submittedValue = waiter.editedValue ?? request.value
    pending.status = 'submitted'
    pending.revision += 1
    pending.updatedAt = now()
    waiter.submittedExpectedRevision = request.expectedRevision
    waiter.submittedValue = submittedValue
    this.recordRunEvent(
      run,
      'input.injected',
      `Managed input injected for node ${pending.nodeId}.`,
      {
        nodeId: pending.nodeId,
        pendingInputId: pending.pendingInputId,
        revision: pending.revision,
        status: pending.status
      }
    )
    await this.queueRunPersistence(run)
    waiter.resolve(submittedValue)
    return {
      runId: run.runId,
      pendingInputId: pending.pendingInputId,
      revision: pending.revision,
      status: pending.status
    }
  }

  async editPendingInput(
    request: MagicAgentGraphEditPendingInputRequest
  ): Promise<MagicAgentGraphPendingInputMutationResult> {
    const run = this.requirePendingInputRun(request)
    const pending = run.pendingInput!
    const waiter = this.pendingInputWaiters.get(run.runId)
    if (!waiter) throw new Error('Pending input is not active in this process.')
    const idempotencyKey = cleanString(request.idempotencyKey)
    if (!idempotencyKey) throw new Error('Pending input edit idempotency key is required.')
    const valueDigest = digestPendingInput(request.value)
    if (pending.revision !== request.expectedRevision || pending.status !== 'awaiting') {
      if (
        pending.status === 'awaiting' &&
        waiter.editIdempotencyKey === idempotencyKey &&
        waiter.editedExpectedRevision === request.expectedRevision &&
        waiter.editedValueDigest === valueDigest &&
        pending.revision === request.expectedRevision + 1
      )
        return {
          runId: run.runId,
          pendingInputId: pending.pendingInputId,
          revision: pending.revision,
          status: pending.status,
          replayed: true
        }
      throw new Error('Pending input revision conflict.')
    }
    waiter.editedValue = request.value
    waiter.editedValueDigest = valueDigest
    waiter.editIdempotencyKey = idempotencyKey
    waiter.editedExpectedRevision = request.expectedRevision
    pending.revision += 1
    pending.updatedAt = now()
    this.recordRunEvent(run, 'input.edited', `Managed input edited for node ${pending.nodeId}.`, {
      nodeId: pending.nodeId,
      pendingInputId: pending.pendingInputId,
      revision: pending.revision,
      status: pending.status,
      valueDigest
    })
    await this.queueRunPersistence(run)
    return {
      runId: run.runId,
      pendingInputId: pending.pendingInputId,
      revision: pending.revision,
      status: pending.status
    }
  }

  async cancelPendingInput(
    request: MagicAgentGraphPendingInputMutation
  ): Promise<MagicAgentGraphPendingInputMutationResult> {
    const run = this.requirePendingInputRun(request)
    const pending = run.pendingInput!
    if (pending.revision !== request.expectedRevision || pending.status !== 'awaiting') {
      if (pending.status === 'cancelled' && pending.revision === request.expectedRevision + 1)
        return {
          runId: run.runId,
          pendingInputId: pending.pendingInputId,
          revision: pending.revision,
          status: pending.status,
          replayed: true
        }
      throw new Error('Pending input revision conflict.')
    }
    pending.status = 'cancelled'
    pending.revision += 1
    pending.updatedAt = now()
    this.recordRunEvent(
      run,
      'input.cancelled',
      `Managed input cancelled for node ${pending.nodeId}.`,
      {
        nodeId: pending.nodeId,
        pendingInputId: pending.pendingInputId,
        revision: pending.revision,
        status: pending.status
      }
    )
    await this.queueRunPersistence(run)
    this.controllers.get(run.runId)?.abort('Managed input cancelled.')
    return {
      runId: run.runId,
      pendingInputId: pending.pendingInputId,
      revision: pending.revision,
      status: pending.status
    }
  }

  async pause(
    runId: string,
    sessionKey: string,
    _actor?: PolicyActorRef
  ): Promise<MagicAgentGraphPauseResult> {
    const normalizedRunId = cleanString(runId)
    const run = this.runs.get(normalizedRunId)
    if (!run || run.sessionKey !== cleanString(sessionKey))
      return { runId: normalizedRunId, paused: false, error: 'Run not found.' }
    if (run.status === 'paused') return { runId: normalizedRunId, paused: true, status: 'paused' }
    if (run.status !== 'pending' && run.status !== 'running' && run.status !== 'pausing')
      return { runId: normalizedRunId, paused: false, status: run.status }
    const cooperative = this.cooperativeControllers.get(normalizedRunId)
    if (!cooperative)
      return {
        runId: normalizedRunId,
        paused: false,
        status: run.status,
        error: 'Run is not active in this process.'
      }
    if (run.status !== 'pausing') {
      this.markRun(run, 'pausing')
      this.recordRunEvent(
        run,
        'graph.pause.requested',
        `MagicAgentGraph pause requested: ${normalizedRunId}`
      )
    }
    await cooperative.requestPause()
    if (this.controllers.get(normalizedRunId)?.signal.aborted)
      return { runId: normalizedRunId, paused: false, status: run.status }
    this.markRun(run, 'paused')
    this.recordRunEvent(run, 'graph.paused', `MagicAgentGraph run paused: ${normalizedRunId}`)
    return { runId: normalizedRunId, paused: true, status: run.status }
  }

  resume(runId: string, sessionKey: string, _actor?: PolicyActorRef): MagicAgentGraphResumeResult {
    const normalizedRunId = cleanString(runId)
    const run = this.runs.get(normalizedRunId)
    if (!run || run.sessionKey !== cleanString(sessionKey))
      return { runId: normalizedRunId, resumed: false, error: 'Run not found.' }
    if (run.status !== 'paused' && run.status !== 'pausing')
      return { runId: normalizedRunId, resumed: false, status: run.status }
    const cooperative = this.cooperativeControllers.get(normalizedRunId)
    if (!cooperative)
      return {
        runId: normalizedRunId,
        resumed: false,
        status: run.status,
        error: 'Run is not active in this process.'
      }
    this.markRun(run, 'running')
    this.recordRunEvent(run, 'graph.resumed', `MagicAgentGraph run resumed: ${normalizedRunId}`)
    cooperative.resume()
    return { runId: normalizedRunId, resumed: true, status: run.status }
  }

  subscribeToRun(
    runId: string,
    sessionKey: string,
    handler: (event: MagicAgentGraphRunStreamEvent) => void
  ): (() => void) | undefined {
    const normalizedRunId = cleanString(runId)
    const normalizedSessionKey = cleanString(sessionKey)
    if (!normalizedRunId || !normalizedSessionKey) {
      return undefined
    }

    const run = this.runs.get(normalizedRunId)
    if (!run || run.sessionKey !== normalizedSessionKey) {
      return undefined
    }

    let subscribers = this.runSubscribers.get(normalizedRunId)
    if (!subscribers) {
      subscribers = new Map<number, MagicAgentGraphRunSubscriber>()
      this.runSubscribers.set(normalizedRunId, subscribers)
    }
    if (subscribers.size >= this.policy.maxSubscribersPerRun) {
      throw new Error(
        `MagicAgentGraph run "${normalizedRunId}" exceeded watcher limit of ${this.policy.maxSubscribersPerRun}.`
      )
    }
    if (this.countRunSubscribers() >= this.policy.maxSubscribersTotal) {
      throw new Error(
        `MagicAgentGraph exceeded total watcher limit of ${this.policy.maxSubscribersTotal}.`
      )
    }

    const subscriberId = this.nextRunSubscriberId++
    const subscriber: MagicAgentGraphRunSubscriber = { sessionKey: normalizedSessionKey, handler }
    subscribers.set(subscriberId, subscriber)
    let active = true
    const unsubscribe = (): void => {
      if (!active) return
      active = false
      const currentSubscribers = this.runSubscribers.get(normalizedRunId)
      currentSubscribers?.delete(subscriberId)
      if (currentSubscribers?.size === 0) {
        this.runSubscribers.delete(normalizedRunId)
      }
    }

    this.sendRunSubscriberEvent(subscriber, this.buildSnapshotStreamEvent(run), unsubscribe)
    if (active && TERMINAL_GRAPH_RUN_STATUSES.has(run.status)) {
      this.sendRunSubscriberEvent(subscriber, this.buildClosedStreamEvent(run), unsubscribe)
      unsubscribe()
    }

    return unsubscribe
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
      const inputMode = node.config?.inputMode
      if (node.kind === 'input') {
        if (inputMode !== undefined && inputMode !== 'run' && inputMode !== 'managed')
          throw new Error(`MagicAgentGraph input node "${node.nodeId}" has invalid inputMode.`)
      } else if (inputMode !== undefined)
        throw new Error(`MagicAgentGraph inputMode is only valid on input nodes.`)
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
    signal: AbortSignal,
    runDeadlineAt: number,
    cooperativeController: CooperativeExecutionController,
    seededNodeOutputs: Map<string, string>
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
      signal,
      runDeadlineAt,
      nodeOutputs: new Map(seededNodeOutputs),
      deliveredChannelIds: new Set(
        graph.channels
          .filter((channel) => seededNodeOutputs.has(channel.from))
          .map((channel) => channel.channelId)
      ),
      allowedToolNames: new Set(
        Array.isArray(request.allowedToolNames)
          ? request.allowedToolNames
              .map((name) => normalizeMagicPotToolName(name))
              .filter((name) => Boolean(name) && !isMagicAgentPlatformDeniedToolName(name))
          : []
      ),
      plannedNodeIds: objectivePlan.plannedNodeIds,
      plannedChannelIds: objectivePlan.plannedChannelIds
    }
    const entryNodeIds = new Set(graph.entryNodeIds)
    const hasEntries = entryNodeIds.size > 0
    for (const node of this.sortGraphNodes(graph)) {
      await cooperativeController.checkpoint('graph-node', signal)
      this.throwIfCancelled(signal)
      if (!context.plannedNodeIds.has(node.nodeId)) {
        await this.skipNode(
          runRecord,
          node,
          'outside-objective',
          request.nodeExecution
            ? 'Node is outside requested execution scope.'
            : 'Node is outside requested outputs.'
        )
        continue
      }
      if (seededNodeOutputs.has(node.nodeId) && node.nodeId !== request.nodeExecution?.nodeId) {
        await this.skipNode(
          runRecord,
          node,
          'durable-upstream-value',
          'Using prior durable node output.'
        )
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
        await this.updateNodeRun(runRecord, node, 'failed', {
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
        node.nodeId === request.nodeExecution?.nodeId ||
        hasDeliveredInput ||
        (!hasEntries && incoming.length === 0)
      if (!shouldRun) {
        await this.skipNode(
          runRecord,
          node,
          'inactive-inbound',
          'No active inbound channel reached this node.'
        )
        continue
      }
      const input = this.collectNodeInput(node, incoming, context)
      const nodeController = new AbortController()
      const forwardRunAbort = (): void => nodeController.abort(signal.reason)
      signal.addEventListener('abort', forwardRunAbort, { once: true })
      if (signal.aborted) forwardRunAbort()
      try {
        const nodeStartedAt = now()
        const nodeBudgetMs = Math.max(
          1,
          Math.min(this.policy.maxNodeDurationMs, runDeadlineAt - nodeStartedAt)
        )
        const nodeDeadlineAt = nodeStartedAt + nodeBudgetMs
        const nodeBudget = {
          maxNodeDurationMs: this.policy.maxNodeDurationMs,
          effectiveNodeDurationMs: nodeBudgetMs,
          nodeDeadlineAt,
          runDeadlineAt
        }
        await this.updateNodeRun(runRecord, node, 'running', {
          startedAt: nodeStartedAt,
          input,
          metadata: { runtimeBudget: nodeBudget }
        })
        this.recordRunEvent(
          runRecord,
          'node.started',
          `MagicAgentGraph node started: ${node.nodeId}`,
          { nodeId: node.nodeId, kind: node.kind, runtimeBudget: nodeBudget }
        )
        await this.recordRuntimeNode(node, context, 'running')
        const timeoutError = new MagicAgentGraphTimeoutError(
          nodeBudgetMs < this.policy.maxNodeDurationMs
            ? `MagicAgentGraph run timed out after ${this.policy.maxRunDurationMs}ms while executing node "${node.nodeId}".`
            : `MagicAgentGraph node "${node.nodeId}" timed out after ${nodeBudgetMs}ms.`,
          nodeBudgetMs < this.policy.maxNodeDurationMs ? 'run' : 'node'
        )
        context.nodeDeadlineAt = nodeDeadlineAt
        context.signal = nodeController.signal
        const leaveNode = cooperativeController.enter('graph-node')
        let rawOutput: string
        try {
          rawOutput = await this.awaitBounded(
            this.executeNode(node, input, context),
            nodeController.signal,
            nodeBudgetMs,
            timeoutError,
            () => nodeController.abort(timeoutError)
          )
        } finally {
          leaveNode()
        }
        context.nodeDeadlineAt = undefined
        context.signal = signal
        this.throwIfCancelled(signal)
        const outputLimit = this.limitText(
          stringifyValue(rawOutput),
          this.policy.maxNodeOutputChars
        )
        const outputMetadata = outputLimit.truncated
          ? { outputTruncated: true, maxOutputChars: this.policy.maxNodeOutputChars }
          : undefined
        context.nodeOutputs.set(node.nodeId, outputLimit.text)
        await this.updateNodeRun(runRecord, node, 'completed', {
          endedAt: now(),
          output: outputLimit.text,
          ...(outputMetadata ? { metadata: outputMetadata } : {})
        })
        await this.recordRuntimeNode(node, context, 'completed')
        this.recordRunEvent(
          runRecord,
          'node.completed',
          `MagicAgentGraph node completed: ${node.nodeId}`,
          { nodeId: node.nodeId, kind: node.kind, ...(outputMetadata || {}) }
        )
        await this.emitOutgoingChannels(node, outputLimit.text, context)
      } catch (error) {
        context.nodeDeadlineAt = undefined
        context.signal = signal
        if (error instanceof MagicAgentGraphTimeoutError && !signal.aborted) {
          this.controllers.get(runRecord.runId)?.abort(error)
        }
        const message = error instanceof Error ? error.message : String(error)
        const timeoutMetadata =
          error instanceof MagicAgentGraphTimeoutError
            ? { timedOut: true, timeoutScope: error.scope }
            : {}
        if (signal.aborted && !(error instanceof MagicAgentGraphTimeoutError)) {
          await this.updateNodeRun(runRecord, node, 'skipped', {
            endedAt: now(),
            error: message,
            metadata: {
              ...(runRecord.nodes?.find((candidate) => candidate.nodeId === node.nodeId)
                ?.metadata || {}),
              reason: 'Run cancelled while node was executing.',
              cancelled: true
            }
          })
          await this.recordRuntimeNode(node, context, 'skipped')
          this.recordRunEvent(
            runRecord,
            'node.skipped',
            `MagicAgentGraph node cancelled: ${node.nodeId}`,
            { nodeId: node.nodeId, kind: node.kind, reason: 'run-cancelled', cancelled: true }
          )
        } else {
          await this.updateNodeRun(runRecord, node, 'failed', {
            endedAt: now(),
            error: message,
            metadata: {
              ...(runRecord.nodes?.find((candidate) => candidate.nodeId === node.nodeId)
                ?.metadata || {}),
              ...timeoutMetadata
            }
          })
          await this.recordRuntimeNode(node, context, 'failed')
          this.recordRunEvent(
            runRecord,
            'node.failed',
            `MagicAgentGraph node failed: ${node.nodeId}: ${message}`,
            { nodeId: node.nodeId, kind: node.kind, error: message, ...timeoutMetadata }
          )
        }
        throw error
      } finally {
        signal.removeEventListener('abort', forwardRunAbort)
      }
    }
    await cooperativeController.checkpoint('graph-node', signal)
    runRecord.outputs = objectivePlan.outputsToBuild.map((output) =>
      this.buildOutput(graph, output, request.input, runRecord.channels, context.nodeOutputs)
    )
    for (const output of runRecord.outputs)
      this.recordRunEvent(
        runRecord,
        'output.created',
        `MagicAgentGraph output created: ${output.outputId}`,
        {
          outputId: output.outputId,
          nodeId: output.sourceNodeId,
          ...(output.channelId
            ? {
                channelId: output.channelId,
                channelKind: graph.channels.find(
                  (channel) => channel.channelId === output.channelId
                )?.kind,
                channelCount: runRecord.channels.filter(
                  (channel) => channel.channelId === output.channelId
                ).length
              }
            : {})
        }
      )
  }

  private buildObjectivePlan(
    graph: MagicAgentGraphDefinition,
    request: MagicAgentGraphRunRequest
  ): GraphObjectivePlan {
    const targetNodeId = request.nodeExecution?.nodeId
    if (request.nodeExecution?.mode === 'single-node')
      return {
        outputsToBuild: [],
        plannedNodeIds: new Set([targetNodeId!]),
        plannedChannelIds: new Set()
      }
    if (request.nodeExecution?.mode === 'run-from-node') {
      const plannedNodeIds = new Set<string>()
      const plannedChannelIds = new Set<string>()
      const outgoingByNode = new Map<string, MagicAgentGraphChannelDefinition[]>()
      for (const channel of graph.channels)
        outgoingByNode.set(channel.from, [...(outgoingByNode.get(channel.from) || []), channel])
      const visit = (nodeId: string): void => {
        if (plannedNodeIds.has(nodeId)) return
        plannedNodeIds.add(nodeId)
        for (const channel of outgoingByNode.get(nodeId) || []) {
          plannedChannelIds.add(channel.channelId)
          visit(channel.to)
        }
      }
      visit(targetNodeId!)
      return {
        outputsToBuild: graph.outputs.filter((output) => plannedNodeIds.has(output.sourceNodeId)),
        plannedNodeIds,
        plannedChannelIds
      }
    }
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

  private async recordRuntimeNode(
    node: MagicAgentGraphNodeDefinition,
    context: GraphExecutionContext,
    status: MagicAgentGraphRunNodeRecord['status']
  ): Promise<void> {
    this.updateRuntimeNodeTopology(node, context.run, status)
    await this.queueRunPersistence(context.run)
  }

  private updateRuntimeNodeTopology(
    node: MagicAgentGraphNodeDefinition,
    run: MagicAgentGraphRunRecord,
    status: MagicAgentGraphRunNodeRecord['status']
  ): void {
    const topology = run.runtimeTopology
    if (!topology) return
    const resourceId = `graph-node:${run.runId}:${node.nodeId}`
    const createdAt = now()
    const existingIndex = topology.resources.findIndex(
      (resource) => resource.resourceId === resourceId
    )
    const previous = existingIndex >= 0 ? topology.resources[existingIndex] : undefined
    const resource = {
      ...(previous ?? {
        resourceId,
        kind: 'node' as const,
        nodeKind: node.kind,
        sourceNodeId: node.nodeId,
        createdAt,
        metadata: { executionKind: `graph-${node.kind}-node` }
      }),
      status
    }
    topology.resources =
      existingIndex >= 0
        ? topology.resources.map((candidate, index) =>
            index === existingIndex ? resource : candidate
          )
        : [...topology.resources, resource]
    if (node.kind === 'agent' && status !== 'pending' && status !== 'running') {
      topology.resources = topology.resources.map((candidate) =>
        candidate.kind === 'agent-invocation' && candidate.sourceNodeId === node.nodeId
          ? { ...candidate, status }
          : candidate
      )
    }
    topology.revision = Math.max(topology.revision + 1, createdAt)
  }

  private async executeNode(
    node: MagicAgentGraphNodeDefinition,
    input: string,
    context: GraphExecutionContext
  ): Promise<string> {
    switch (node.kind) {
      case 'input':
        return node.config?.inputMode === 'managed'
          ? this.awaitManagedInput(node, context)
          : context.request.input
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

  private requirePendingInputRun(
    request: MagicAgentGraphPendingInputMutation
  ): MagicAgentGraphRunRecord {
    const run = this.runs.get(cleanString(request.runId))
    if (!run || run.sessionKey !== cleanString(request.sessionKey))
      throw new Error('Run not found.')
    if (
      !run.pendingInput ||
      run.pendingInput.pendingInputId !== cleanString(request.pendingInputId)
    )
      throw new Error('Pending input not found.')
    return run
  }

  private async awaitManagedInput(
    node: MagicAgentGraphNodeDefinition,
    context: GraphExecutionContext
  ): Promise<string> {
    const createdAt = now()
    const pending: MagicAgentGraphPendingInputRecord = {
      pendingInputId: createId('magic-agent-pending-input'),
      nodeId: node.nodeId,
      revision: 1,
      status: 'awaiting',
      createdAt,
      updatedAt: createdAt,
      ...(typeof node.config?.prompt === 'string' ? { prompt: node.config.prompt } : {}),
      ...(typeof node.config?.sensitive === 'boolean' ? { sensitive: node.config.sensitive } : {})
    }
    context.run.pendingInput = pending
    await this.queueRunPersistence(context.run)
    this.recordRunEvent(
      context.run,
      'input.pending',
      `Managed input pending for node ${node.nodeId}.`,
      {
        nodeId: node.nodeId,
        pendingInputId: pending.pendingInputId,
        revision: pending.revision,
        status: pending.status
      }
    )
    await this.queueRunPersistence(context.run)
    const value = await new Promise<string>((resolve, reject) => {
      const onAbort = (): void =>
        reject(new Error(String(context.signal.reason || 'Run cancelled.')))
      context.signal.addEventListener('abort', onAbort, { once: true })
      this.pendingInputWaiters.set(context.run.runId, {
        resolve: (submitted) => {
          context.signal.removeEventListener('abort', onAbort)
          resolve(submitted)
        },
        reject
      })
      if (context.signal.aborted) onAbort()
    })
    pending.status = 'consumed'
    pending.revision += 1
    pending.updatedAt = now()
    this.recordRunEvent(
      context.run,
      'input.consumed',
      `Managed input consumed by node ${node.nodeId}.`,
      {
        nodeId: node.nodeId,
        pendingInputId: pending.pendingInputId,
        revision: pending.revision,
        status: pending.status
      }
    )
    await this.queueRunPersistence(context.run)
    return value
  }

  private async executeAgentNode(
    node: MagicAgentGraphNodeDefinition,
    input: string,
    context: GraphExecutionContext
  ): Promise<string> {
    const topology = context.run.runtimeTopology
    if (
      topology &&
      !topology.resources.some(
        (resource) => resource.kind === 'agent-invocation' && resource.sourceNodeId === node.nodeId
      )
    ) {
      topology.resources.push({
        resourceId: `graph-agent-invocation:${context.run.runId}:${node.nodeId}`,
        kind: 'agent-invocation',
        nodeKind: 'agent',
        status: 'running',
        sourceNodeId: node.nodeId,
        createdAt: now(),
        metadata: {
          executionKind: 'graph-agent-invocation',
          agentDefinitionId: cleanString(node.agentId) || node.nodeId
        }
      })
      topology.revision = now()
      await this.queueRunPersistence(context.run)
    }
    if (!this.deps.runAgent) return formatAgentSection(node, input)
    const timeoutMs = Math.max(
      1,
      Math.min(context.nodeDeadlineAt || context.runDeadlineAt, context.runDeadlineAt) - now()
    )
    const result = await this.deps.runAgent(
      {
        agentId: cleanString(node.agentId) || node.nodeId,
        text: input,
        route: context.route,
        timeoutMs,
        ...(node.modelName ? { profileId: node.modelName } : {}),
        ...(node.instruction ? { systemPrompt: node.instruction } : {}),
        ...(context.request.allowedToolNames !== undefined
          ? { allowedToolNames: [...context.allowedToolNames] }
          : {}),
        metadata: {
          ...(context.request.metadata || {}),
          graphId: context.graph.graphId,
          graphRunId: context.run.runId,
          nodeId: node.nodeId,
          route: context.route,
          sessionKey: context.run.sessionKey,
          runtimeBudget: {
            timeoutMs,
            runDeadlineAt: context.runDeadlineAt,
            ...(context.nodeDeadlineAt ? { nodeDeadlineAt: context.nodeDeadlineAt } : {})
          }
        }
      },
      { signal: context.signal }
    )
    if (result.status === 'timeout') {
      const remainingRunMs = context.runDeadlineAt - now()
      const runLimitedNode =
        context.nodeDeadlineAt !== undefined && context.nodeDeadlineAt >= context.runDeadlineAt
      throw new MagicAgentGraphTimeoutError(
        result.error || `MagicAgentGraph agent node "${node.nodeId}" timed out.`,
        runLimitedNode || remainingRunMs <= 0 ? 'run' : 'node'
      )
    }
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
    const firstParty = isRecord(config.firstParty) ? config.firstParty : undefined
    if (firstParty) {
      const family = cleanString(firstParty.family)
      const operation = cleanString(firstParty.operation)
      const familyConfig = isRecord(firstParty.config) ? firstParty.config : {}
      if (!family || !operation)
        throw new Error(
          `MagicAgentGraph first-party node "${node.nodeId}" has invalid family config.`
        )
      if (!this.deps.firstPartyNodeExecutor)
        throw new Error(
          `MagicAgentGraph first-party node "${node.nodeId}" is unconfigured in this environment.`
        )
      const result = await this.deps.firstPartyNodeExecutor({
        family,
        operation,
        config: Object.freeze({ ...familyConfig }),
        input,
        node,
        graph: context.graph,
        run: context.run,
        route: context.route,
        signal: context.signal
      })
      return stringifyValue(result)
    }
    const toolName =
      normalizeMagicPotToolName(node.toolName) ||
      normalizeMagicPotToolName(config.toolName as string | undefined)
    if (!toolName)
      throw new Error(`MagicAgentGraph tool node "${node.nodeId}" is missing toolName.`)
    if (isMagicAgentPlatformDeniedToolName(toolName) || !context.allowedToolNames.has(toolName))
      throw new Error(`MagicAgentGraph tool "${toolName}" is not allowed for this graph run.`)
    if (!this.deps.callTool)
      throw new Error(`MagicAgentGraph tool "${toolName}" has no configured executor.`)
    const args = isRecord(config.args)
      ? { ...config.args }
      : Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'toolName'))
    const graphInputField = cleanString(args.__graphInputField)
    delete args.__graphInputField
    if (input) {
      const parsedInput = (() => {
        try {
          return JSON.parse(input) as unknown
        } catch {
          return input
        }
      })()
      if (graphInputField) args[graphInputField] = parsedInput
      else if (!Object.keys(args).length) args.input = parsedInput
    }
    const timeoutMs = Math.max(
      1,
      Math.min(context.nodeDeadlineAt || context.runDeadlineAt, context.runDeadlineAt) - now()
    )
    const toolRequest: MagicAgentPlatformToolCallReq = Object.freeze({
      name: toolName,
      args: Object.freeze({ ...args }),
      route: context.route,
      ...(cleanString(node.agentId) ? { agentId: cleanString(node.agentId) } : {}),
      metadata: Object.freeze({
        ...(context.request.metadata || {}),
        graphId: context.graph.graphId,
        graphRunId: context.run.runId,
        nodeId: node.nodeId,
        route: context.route,
        sessionKey: context.run.sessionKey,
        allowedToolNames: [...context.allowedToolNames],
        runtimeBudget: {
          timeoutMs,
          runDeadlineAt: context.runDeadlineAt,
          ...(context.nodeDeadlineAt ? { nodeDeadlineAt: context.nodeDeadlineAt } : {})
        }
      })
    })
    const requestDigest = createHash('sha256').update(JSON.stringify(toolRequest)).digest('hex')
    const approval = this.deps.requestToolApproval?.({
      runId: context.run.runId,
      nodeId: node.nodeId,
      toolName,
      requestDigest,
      request: toolRequest,
      invoke: () => this.deps.callTool!(toolRequest, { signal: context.signal }),
      signal: context.signal
    })
    let result: MagicAgentPlatformToolCallResp
    if (approval) {
      const createdAt = approval.pending.createdAt
      const pendingApproval: MagicAgentGraphPendingApprovalRecord = {
        approvalId: approval.pending.approvalId,
        nodeId: node.nodeId,
        toolName,
        requestDigest,
        revision: approval.pending.revision,
        status: 'awaiting',
        createdAt,
        updatedAt: createdAt
      }
      context.run.pendingApproval = pendingApproval
      this.recordRunEvent(
        context.run,
        'approval.pending',
        `MagicAgentGraph tool approval pending: ${toolName}`,
        { nodeId: node.nodeId, toolName, approvalId: pendingApproval.approvalId, requestDigest }
      )
      await this.queueRunPersistence(context.run)
      let authorized: Awaited<typeof approval.decision>
      try {
        authorized = await Promise.race([
          approval.decision,
          new Promise<never>((_, reject) => {
            if (context.signal.aborted) reject(new Error('Graph tool approval was cancelled.'))
            else
              context.signal.addEventListener(
                'abort',
                () => reject(new Error('Graph tool approval was cancelled.')),
                { once: true }
              )
          })
        ])
      } catch (error) {
        pendingApproval.status = 'denied'
        pendingApproval.revision += 1
        pendingApproval.updatedAt = now()
        this.recordRunEvent(
          context.run,
          'approval.denied',
          `MagicAgentGraph tool approval denied: ${toolName}`,
          { nodeId: node.nodeId, toolName, approvalId: pendingApproval.approvalId, requestDigest }
        )
        await this.queueRunPersistence(context.run)
        throw error
      }
      pendingApproval.status = 'approved'
      pendingApproval.revision += 1
      pendingApproval.updatedAt = now()
      this.recordRunEvent(
        context.run,
        'approval.approved',
        `MagicAgentGraph tool approval granted: ${toolName}`,
        { nodeId: node.nodeId, toolName, approvalId: pendingApproval.approvalId, requestDigest }
      )
      await this.queueRunPersistence(context.run)
      this.recordRunEvent(
        context.run,
        'tool.invoked',
        `MagicAgentGraph tool invoked: ${toolName}`,
        {
          nodeId: node.nodeId,
          toolName,
          status: 'invoked'
        }
      )
      result = await authorized.invoke()
    } else {
      this.recordRunEvent(
        context.run,
        'tool.invoked',
        `MagicAgentGraph tool invoked: ${toolName}`,
        {
          nodeId: node.nodeId,
          toolName,
          status: 'invoked'
        }
      )
      result = await this.deps.callTool(toolRequest, { signal: context.signal })
    }
    if (!result.ok)
      throw new Error(
        result.error ||
          result.unavailableReason ||
          result.content ||
          `MagicAgentGraph tool failed: ${toolName}`
      )
    return result.content || stringifyValue(result.data)
  }

  private async emitOutgoingChannels(
    node: MagicAgentGraphNodeDefinition,
    nodeOutput: string,
    context: GraphExecutionContext
  ): Promise<void> {
    const nodes = new Map(context.graph.nodes.map((candidate) => [candidate.nodeId, candidate]))
    const topology = context.run.runtimeTopology
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
      if (topology) {
        const sourceResourceId = `graph-node:${context.run.runId}:${channel.from}`
        const targetResourceId = `graph-node:${context.run.runId}:${channel.to}`
        const channelResourceId = `graph-channel:${context.run.runId}:${channel.channelId}`
        if (
          !topology.resources.some(
            (resource) =>
              resource.kind === 'channel' && resource.sourceChannelId === channel.channelId
          )
        ) {
          topology.resources.push({
            resourceId: channelResourceId,
            kind: 'channel',
            sourceNodeId: channel.from,
            targetNodeId: channel.to,
            sourceChannelId: channel.channelId,
            sourceResourceId,
            targetResourceId,
            status: 'delivered',
            createdAt: record.createdAt,
            metadata: {
              executionKind: 'graph-channel-delivery',
              channelKind: channel.kind,
              status: 'delivered'
            }
          })
        }
        if (
          !topology.resources.some(
            (resource) => resource.kind === 'wire' && resource.sourceChannelId === channel.channelId
          )
        ) {
          topology.resources.push({
            resourceId: `graph-wire:${context.run.runId}:${channel.channelId}`,
            kind: 'wire',
            sourceNodeId: channel.from,
            targetNodeId: channel.to,
            sourceChannelId: channel.channelId,
            sourceResourceId: channelResourceId,
            targetResourceId,
            status: 'delivered',
            createdAt: record.createdAt,
            metadata: {
              executionKind: 'graph-channel-wire-delivery',
              channelResourceId,
              channelKind: channel.kind,
              status: 'delivered'
            }
          })
        }
        topology.revision = record.createdAt
        await this.queueRunPersistence(context.run)
      }
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
          kind: channel.kind,
          status: 'delivered',
          messageCount: 1
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

  private skipPendingNodesAfterTermination(
    run: MagicAgentGraphRunRecord,
    runStatus: MagicAgentGraphRunRecord['status'],
    message: string,
    metadata: Record<string, unknown>
  ): void {
    const reason =
      runStatus === 'cancelled'
        ? 'Graph run was cancelled before this node executed.'
        : metadata.timedOut
          ? 'Graph run timed out before this node executed.'
          : 'Graph run failed before this node executed.'
    for (const record of run.nodes || []) {
      if (record.status !== 'pending') continue
      record.status = 'skipped'
      record.endedAt = now()
      const node = run.graphSnapshot?.nodes.find((candidate) => candidate.nodeId === record.nodeId)
      if (node) this.updateRuntimeNodeTopology(node, run, 'skipped')
      record.metadata = {
        ...(record.metadata || {}),
        reason,
        terminationStatus: runStatus,
        terminationError: message,
        ...metadata
      }
    }
    run.updatedAt = now()
  }

  private async skipNode(
    run: MagicAgentGraphRunRecord,
    node: MagicAgentGraphNodeDefinition,
    reason: string,
    message: string
  ): Promise<void> {
    this.updateRuntimeNodeTopology(node, run, 'skipped')
    await this.updateNodeRun(run, node, 'skipped', {
      endedAt: now(),
      metadata: { reason: message }
    })
    this.recordRunEvent(run, 'node.skipped', `MagicAgentGraph node skipped: ${node.nodeId}`, {
      nodeId: node.nodeId,
      reason
    })
  }

  private async updateNodeRun(
    run: MagicAgentGraphRunRecord,
    node: MagicAgentGraphNodeDefinition,
    status: MagicAgentGraphRunNodeRecord['status'],
    updates?: Partial<MagicAgentGraphRunNodeRecord>
  ): Promise<void> {
    let record = run.nodes?.find((candidate) => candidate.nodeId === node.nodeId)
    if (!record) {
      record = { nodeId: node.nodeId, kind: node.kind, status: 'pending' }
      run.nodes = [...(run.nodes || []), record]
    }
    Object.assign(record, updates || {})
    record.status = status
    run.updatedAt = now()
    this.runs.set(run.runId, run)
    await this.queueRunPersistence(run)
  }

  private recordRunEvent(
    run: MagicAgentGraphRunRecord,
    type: MagicAgentGraphRunEventType,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    const createdAt = now()
    const event: MagicAgentGraphRunEvent = {
      eventId: createId('magic-agent-graph-event'),
      runId: run.runId,
      graphId: run.graphId,
      type,
      message,
      createdAt,
      sequence: this.nextRunStreamSequence(run.runId),
      ...(cleanString(metadata?.nodeId) ? { nodeId: cleanString(metadata?.nodeId) } : {}),
      ...(cleanString(metadata?.channelId) ? { channelId: cleanString(metadata?.channelId) } : {}),
      ...(cleanString(metadata?.outputId) ? { outputId: cleanString(metadata?.outputId) } : {}),
      ...(metadata ? { metadata } : {})
    }
    run.events = [...(run.events || []), event].slice(-this.policy.maxEvents)
    this.runEventStore?.append(event)
    run.updatedAt = createdAt
    this.runs.set(run.runId, run)
    void this.queueRunPersistence(run)
    this.notifyRunEvent(run, event)
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
    void this.queueRunPersistence(run)
  }

  private limitText(value: string, maxChars: number): { text: string; truncated: boolean } {
    const text = stringifyValue(value)
    const limited = truncateText(text, maxChars)
    return { text: limited, truncated: limited.length !== text.length }
  }

  private countRunSubscribers(): number {
    return [...this.runSubscribers.values()].reduce(
      (total, subscribers) => total + subscribers.size,
      0
    )
  }

  private nextRunStreamSequence(runId: string): number {
    const nextSequence = (this.runStreamSequences.get(runId) || 0) + 1
    this.runStreamSequences.set(runId, nextSequence)
    return nextSequence
  }

  private getLastRunStreamSequence(run: MagicAgentGraphRunRecord): number {
    const events = run.events || []
    return this.runStreamSequences.get(run.runId) || events[events.length - 1]?.sequence || 0
  }

  private buildSnapshotStreamEvent(run: MagicAgentGraphRunRecord): MagicAgentGraphRunStreamEvent {
    return {
      type: 'snapshot',
      sequence: 0,
      runId: run.runId,
      graphId: run.graphId,
      status: run.status,
      createdAt: now(),
      run: clone(run)
    }
  }

  private buildEventStreamEvent(
    run: MagicAgentGraphRunRecord,
    event: MagicAgentGraphRunEvent
  ): MagicAgentGraphRunStreamEvent {
    return {
      type: 'event',
      sequence: event.sequence ?? this.nextRunStreamSequence(run.runId),
      runId: run.runId,
      graphId: run.graphId,
      status: run.status,
      createdAt: event.createdAt,
      event: clone(event),
      run: clone(run)
    }
  }

  private buildClosedStreamEvent(run: MagicAgentGraphRunRecord): MagicAgentGraphRunStreamEvent {
    return {
      type: 'closed',
      sequence: this.getLastRunStreamSequence(run) + 1,
      runId: run.runId,
      graphId: run.graphId,
      status: run.status,
      createdAt: now(),
      run: clone(run),
      ...(run.error ? { error: run.error } : {})
    }
  }

  private sendRunSubscriberEvent(
    subscriber: MagicAgentGraphRunSubscriber,
    event: MagicAgentGraphRunStreamEvent,
    unsubscribe: () => void
  ): void {
    try {
      subscriber.handler(event)
    } catch {
      unsubscribe()
    }
  }

  private notifyRunEvent(run: MagicAgentGraphRunRecord, event: MagicAgentGraphRunEvent): void {
    const subscribers = this.runSubscribers.get(run.runId)
    if (!subscribers?.size) return
    const streamEvent = this.buildEventStreamEvent(run, event)
    for (const [subscriberId, subscriber] of [...subscribers.entries()]) {
      if (subscriber.sessionKey !== run.sessionKey) continue
      this.sendRunSubscriberEvent(subscriber, streamEvent, () => {
        subscribers.delete(subscriberId)
        if (subscribers.size === 0) this.runSubscribers.delete(run.runId)
      })
    }
  }

  private notifyRunClosed(run: MagicAgentGraphRunRecord): void {
    const subscribers = this.runSubscribers.get(run.runId)
    if (!subscribers?.size) return
    const streamEvent = this.buildClosedStreamEvent(run)
    for (const subscriber of [...subscribers.values()]) {
      if (subscriber.sessionKey !== run.sessionKey) continue
      try {
        subscriber.handler(streamEvent)
      } catch {
        // Ignore subscriber failures while closing the run stream.
      }
    }
    this.runSubscribers.delete(run.runId)
  }

  private queueRunPersistence(run: MagicAgentGraphRunRecord): Promise<void> {
    const runStore = this.runStore
    if (!runStore) return Promise.resolve()
    const runId = run.runId
    const snapshot = clone(run)
    const previous = this.runPersistenceQueues.get(runId) || Promise.resolve()
    const savePromise = previous
      .catch(() => undefined)
      .then(async () => {
        await runStore.save(snapshot)
      })
    const trackedPromise = savePromise
      .catch(() => undefined)
      .finally(() => {
        if (this.runPersistenceQueues.get(runId) === trackedPromise) {
          this.runPersistenceQueues.delete(runId)
        }
      })
    this.runPersistenceQueues.set(runId, trackedPromise)
    return savePromise
  }

  private async flushRunPersistenceQueues(): Promise<void> {
    await Promise.all([...this.runPersistenceQueues.values()])
  }

  private async pruneRunsForSession(sessionKey: string): Promise<void> {
    const maxRunRecords = this.policy.maxRunRecordsPerSession
    const sessionRuns = [...this.runs.values()]
      .filter((run) => run.sessionKey === sessionKey)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    const runsToRemove = sessionRuns.slice(maxRunRecords)
    for (const run of runsToRemove) {
      if (!this.controllers.has(run.runId)) {
        this.runs.delete(run.runId)
        this.runStreamSequences.delete(run.runId)
        this.runSubscribers.delete(run.runId)
      }
    }
    await this.runStore?.pruneSession(
      sessionKey,
      maxRunRecords,
      new Set([...this.controllers.keys()])
    )
  }

  private async awaitBounded<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    timeoutMs: number,
    timeoutError: MagicAgentGraphTimeoutError,
    onTimeout?: () => void
  ): Promise<T> {
    if (signal.aborted) {
      this.throwIfCancelled(signal)
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', handleAbort)
        callback()
      }
      const handleAbort = (): void => {
        finish(() => {
          if (signal.reason instanceof MagicAgentGraphTimeoutError) {
            reject(signal.reason)
          } else {
            try {
              this.throwIfCancelled(signal)
            } catch (error) {
              reject(error)
            }
          }
        })
      }
      const timer = setTimeout(
        () => {
          finish(() => {
            onTimeout?.()
            reject(timeoutError)
          })
        },
        Math.max(1, Math.floor(timeoutMs))
      )

      signal.addEventListener('abort', handleAbort, { once: true })
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      )
    })
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (!signal.aborted) return
    if (signal.reason instanceof MagicAgentGraphTimeoutError) {
      throw signal.reason
    }
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
