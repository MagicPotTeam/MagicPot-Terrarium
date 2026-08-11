import type { AgentRouteLike, AgentRunStatus } from '@shared/agent'
import {
  createDriveProgressAction,
  createReplyEmitAction,
  getAgentSessionKey,
  type AgentAction,
  type AgentEvent,
  type ChildStartPayload,
  type DriveProgressPayload,
  type JsonValue,
  isJsonValue,
  type MessagePublishPayload
} from '@shared/agent'
import type { PolicyJsonRecord, RuntimeChannelMessageState } from '../../shared/magicAgentPlatform2'
import { canonicalPolicyJson, sha256PolicyText } from '../../shared/magicAgentPlatform2/policy'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformRunReq,
  MagicAgentPlatformRunResp,
  MagicAgentPlatformToolCallReq,
  MagicAgentPlatformToolCallResp,
  MagicAgentPlatformToolDefinition,
  MagicAgentPlatformToolSource
} from '@shared/api/svcMagicAgentPlatform'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import { normalizeMagicPotToolName } from '@shared/app/types'
import { normalizeAgentRoute } from '@shared/agent'
import { getAssistantRuntime } from '../assistantRuntime/runtime'
import type { AssistantRuntime } from '../assistantRuntime/runtime'
import type { AssistantRoute } from '../assistantRuntime/types'
import { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import { getConfig } from '../config/config'
import { getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { getProductionAgentInstanceLifecycle } from '../magicAgentPlatform2/agents/productionAgentInstanceLifecycleOwner'
import { getAgentKernel, AgentKernel } from '../agentKernel'
import { MagicAgentRegistry } from './agentRegistry'
import { MagicAgentRuntime } from './runtime'
import { MagicAgentToolRegistry } from './toolRegistry'
import type { MagicAgentToolRegistration, MagicAgentToolResult } from './types'
import {
  MagicAgentCreativeToolRegistry,
  createMagicAgentCreativeToolRegistry,
  type MagicAgentCreativeToolContext,
  type MagicAgentCreativeToolDependencies,
  type MagicAgentCreativeToolDefinition,
  type MagicAgentCreativeToolResult
} from './tools'
import { isMagicAgentPlatformDeniedToolName } from './toolPolicy'
import {
  readDriveTrustedDispatchContext,
  type DriveTrustedDispatchContext
} from './driveTrustedDispatchContext'
import {
  readRuntimeChannelTrustedDispatchContext,
  type RuntimeChannelTrustedDispatchContext
} from './runtimeChannelTrustedDispatchContext'
import {
  readTriggerTrustedDispatchContext,
  type TriggerTrustedDispatchContext
} from './triggerTrustedDispatchContext'

import type { CooperativeExecutionGate } from '../magicAgentPlatform2/agents/cooperativeExecutionController'

export type MagicAgentPlatformExecutionOptions = {
  signal?: AbortSignal
  cooperativeExecution?: CooperativeExecutionGate
}

class MagicAgentPlatformTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`MagicAgent platform run timed out after ${timeoutMs}ms.`)
    this.name = 'MagicAgentPlatformTimeoutError'
  }
}

export type MagicAgentPlatformAdapterDeps = {
  chatService?: Pick<LLMProxySvc, 'chat'>
  assistantRuntime?: Pick<AssistantRuntime, 'listTools' | 'callTool' | 'handleMessage'>
  agentRegistry?: MagicAgentRegistry
  toolRegistry?: MagicAgentToolRegistry
  creativeToolRegistry?: MagicAgentCreativeToolRegistry
  creativeToolDependencies?: Partial<MagicAgentCreativeToolDependencies>
  agentKernel?: AgentKernel
  dispatchKernel?: AgentKernel
  reportDriveProgress?: (payload: DriveProgressPayload) => unknown | Promise<unknown>
  publishMessage?: (
    payload: MessagePublishPayload,
    context: { agentInstanceId: string; sourceEvent: AgentEvent }
  ) => unknown | Promise<unknown>
  startChild?: (
    payload: ChildStartPayload,
    context: {
      actor: { kind: 'agent'; id: string }
      agentInstanceId: string
      sourceEvent: AgentEvent
    }
  ) => unknown | Promise<unknown>
  driveProgressSettlementMax?: number
  messagePublishSettlementMax?: number
  childStartSettlementMax?: number
}

const MAGIC_AGENT_KERNEL_PREFIX = 'magicagent.platform'
const MAGIC_AGENT_USER_MESSAGE_EVENT = 'user.message'
const MAGIC_AGENT_CHANNEL_MESSAGE_EVENT = 'channel.message'
const MAGIC_AGENT_DRIVE_ASSIGNED_EVENT = 'drive.assigned'
const MAGIC_AGENT_TRIGGER_FIRED_EVENT = 'trigger.fired'
const MAGIC_AGENT_REPLY_EMIT_ACTION = 'reply.emit'
const MAGIC_AGENT_DRIVE_PROGRESS_ACTION = 'drive.progress'
const MAGIC_AGENT_MESSAGE_PUBLISH_ACTION = 'message.publish'
const MAGIC_AGENT_CHILD_START_ACTION = 'child.start'
const DRIVE_ROUTE = 'magicpot-drive://runtime'
const TRIGGER_CHANNEL = 'magic-agent-trigger'
const TRIGGER_THREAD = 'trigger-runtime'

const cleanString = (value: unknown): string => String(value || '').trim()

const composeSystemPrompt = (
  agentSystemPrompt: string | null | undefined,
  requestSystemPrompt: string | null | undefined
): string | undefined => {
  const agentPrompt = cleanString(agentSystemPrompt)
  const requestPrompt = cleanString(requestSystemPrompt)
  if (!agentPrompt) {
    return requestPrompt || undefined
  }
  if (!requestPrompt || requestPrompt === agentPrompt) {
    return agentPrompt
  }
  return `${agentPrompt}\n\n${requestPrompt}`
}

const cloneRecord = (value?: Record<string, unknown>): Record<string, unknown> | undefined =>
  value ? { ...value } : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const toJsonValue = (value: unknown, label: string): JsonValue => {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error()
    return JSON.parse(serialized) as JsonValue
  } catch {
    throw new TypeError(`${label} must be JSON serializable.`)
  }
}

const parseRunRequestPayload = (payload: JsonValue): MagicAgentPlatformRunReq => {
  if (!isRecord(payload) || !isRecord(payload.request)) {
    throw new TypeError('MagicAgent message payload must contain a request object.')
  }
  const request = payload.request
  if (typeof request.text !== 'string' || !isRecord(request.route)) {
    throw new TypeError('MagicAgent message request requires text and route fields.')
  }
  return request as MagicAgentPlatformRunReq
}

const runtimeChannelEventId = (
  context: RuntimeChannelTrustedDispatchContext,
  agentId: string
): string =>
  `channel-message:${sha256PolicyText(
    canonicalPolicyJson({
      channelId: context.channelId,
      memberId: context.memberId,
      pendingMessageIds: [...context.pendingMessageIds],
      agentInstanceId: context.agentInstanceId,
      agentId
    })
  )}`

const driveEventId = (
  context: DriveTrustedDispatchContext,
  request: MagicAgentPlatformRunReq,
  agentId: string,
  sessionId: string
): string =>
  `drive-assigned:${sha256PolicyText(
    canonicalPolicyJson({
      driveId: context.driveId,
      driveRevision: context.driveRevision,
      targetAgentId: context.targetAgentId,
      targetSessionId: context.targetSessionId ?? sessionId,
      agentId,
      text: request.text,
      profileId: request.profileId ?? null,
      allowedToolNames: request.allowedToolNames ? [...request.allowedToolNames] : null
    })
  )}`

const triggerEventId = (
  context: TriggerTrustedDispatchContext,
  request: MagicAgentPlatformRunReq,
  agentId: string,
  sessionId: string
): string =>
  `trigger-fired:${sha256PolicyText(
    canonicalPolicyJson({
      triggerId: context.triggerId,
      occurrenceId: context.occurrenceId ?? null,
      requestId: context.requestId,
      occurrenceAt: context.occurrenceAt,
      source: context.source ?? null,
      attempt: context.attempt ?? null,
      targetAgentId: context.targetAgentId,
      targetSessionId: context.targetSessionId ?? sessionId,
      agentId,
      text: request.text,
      profileId: request.profileId ?? null,
      allowedToolNames: request.allowedToolNames ? [...request.allowedToolNames] : null
    })
  )}`

const parseRunResponsePayload = (payload: JsonValue): MagicAgentPlatformRunResp => {
  if (
    !isRecord(payload) ||
    !isRecord(payload.response) ||
    typeof payload.response.runId !== 'string' ||
    typeof payload.response.agentId !== 'string' ||
    typeof payload.response.status !== 'string' ||
    typeof payload.response.content !== 'string'
  ) {
    throw new TypeError('MagicAgent reply.emit action contains an invalid response payload.')
  }
  return payload.response as MagicAgentPlatformRunResp
}

const parseDriveProgressPayload = (payload: JsonValue): DriveProgressPayload => {
  if (
    !isRecord(payload) ||
    typeof payload.driveId !== 'string' ||
    !payload.driveId.trim() ||
    !Number.isInteger(payload.expectedRevision) ||
    Number(payload.expectedRevision) < 0 ||
    typeof payload.summary !== 'string' ||
    !payload.summary.trim() ||
    !Array.isArray(payload.evidence) ||
    !Number.isFinite(payload.reportedAt) ||
    Number(payload.reportedAt) < 0 ||
    typeof payload.idempotencyKey !== 'string' ||
    !payload.idempotencyKey.trim()
  )
    throw new TypeError('MagicAgent drive.progress action contains an invalid payload.')
  for (const item of payload.evidence) {
    if (
      !isRecord(item) ||
      !['session', 'run', 'artifact', 'url', 'text'].includes(String(item.kind)) ||
      typeof item.ref !== 'string' ||
      !item.ref.trim() ||
      (item.digest !== undefined &&
        (typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(item.digest)))
    )
      throw new TypeError('MagicAgent drive.progress action contains invalid evidence.')
  }
  return payload as DriveProgressPayload
}

const parseMessagePublishPayload = (payload: JsonValue): MessagePublishPayload => {
  const allowedKeys = new Set([
    'channelId',
    'publisherMemberId',
    'messageId',
    'payload',
    'priority',
    'publishedAt',
    'expiresAt',
    'expectedChannelRevision',
    'idempotencyKey'
  ])
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => !allowedKeys.has(key)) ||
    !['channelId', 'publisherMemberId', 'messageId', 'idempotencyKey'].every(
      (key) => typeof payload[key] === 'string' && Boolean(String(payload[key]).trim())
    ) ||
    !Object.prototype.hasOwnProperty.call(payload, 'payload') ||
    !isJsonValue(payload.payload) ||
    !Number.isInteger(payload.priority) ||
    !Number.isFinite(payload.priority) ||
    !Number.isFinite(payload.publishedAt) ||
    Number(payload.publishedAt) < 0 ||
    (payload.expiresAt !== undefined &&
      (!Number.isFinite(payload.expiresAt) ||
        Number(payload.expiresAt) <= Number(payload.publishedAt))) ||
    !Number.isInteger(payload.expectedChannelRevision) ||
    Number(payload.expectedChannelRevision) < 0
  )
    throw new TypeError('MagicAgent message.publish action contains an invalid payload.')
  return payload as MessagePublishPayload
}

const parseChildStartPayload = (payload: JsonValue): ChildStartPayload => {
  if (!isRecord(payload) || !isRecord(payload.child) || !isRecord(payload.child.limits))
    throw new TypeError('MagicAgent child.start action contains an invalid payload.')
  const child = payload.child as Record<string, JsonValue>
  const limits = child.limits as Record<string, JsonValue>
  const nonempty = (value: unknown): boolean => typeof value === 'string' && Boolean(value.trim())
  const nonnegativeInteger = (value: unknown): boolean =>
    Number.isInteger(value) && Number(value) >= 0
  const positiveInteger = (value: unknown): boolean => Number.isInteger(value) && Number(value) > 0
  const validStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.every(nonempty) &&
    new Set(value as string[]).size === value.length
  if (
    !nonempty(payload.parentInstanceId) ||
    !nonnegativeInteger(payload.parentExpectedRevision) ||
    !nonempty(child.id) ||
    !nonempty(child.name) ||
    !nonempty(child.definitionId) ||
    (child.ownerId !== undefined && !nonempty(child.ownerId)) ||
    !nonempty(child.configVersion) ||
    (child.pendingConfigVersion !== undefined && !nonempty(child.pendingConfigVersion)) ||
    (child.previousConfigVersion !== undefined && !nonempty(child.previousConfigVersion)) ||
    (child.configActivatedAt !== undefined && !nonnegativeInteger(child.configActivatedAt)) ||
    !nonnegativeInteger(limits.maxChildren) ||
    !nonnegativeInteger(limits.maxDepth) ||
    !positiveInteger(limits.maxConcurrency) ||
    !positiveInteger(limits.maxRuntimeMs) ||
    !validStringArray(limits.allowedToolNames) ||
    !validStringArray(limits.workspaceRoots) ||
    (child.runtimeTopologyAttribution !== undefined &&
      !isJsonValue(child.runtimeTopologyAttribution)) ||
    !nonnegativeInteger(payload.createdAt) ||
    !nonempty(payload.idempotencyKey)
  )
    throw new TypeError('MagicAgent child.start action contains an invalid payload.')
  return payload as unknown as ChildStartPayload
}

const defaultStartChild = async (
  payload: ChildStartPayload,
  context: {
    actor: { kind: 'agent'; id: string }
    agentInstanceId: string
    sourceEvent: AgentEvent
  }
): Promise<void> => {
  const lifecycle = getProductionAgentInstanceLifecycle()
  if (!lifecycle) throw new Error('Production Agent instance lifecycle is unavailable.')
  // child.start reserves a managed child in created state; it does not run it.
  lifecycle.commands.createChild({
    actor: context.actor,
    parentInstanceId: payload.parentInstanceId,
    parentExpectedRevision: payload.parentExpectedRevision,
    instance: payload.child as unknown as Omit<
      import('../../shared/magicAgentPlatform2').MagicAgentInstanceState,
      'parentInstanceId' | 'depth' | 'status'
    >,
    createdAt: payload.createdAt,
    idempotencyKey: payload.idempotencyKey
  })
}

const defaultReportDriveProgress = async (payload: DriveProgressPayload): Promise<void> => {
  const { getProductionDriveLifecycle } =
    await import('../magicAgentPlatform2/drives/productionDriveLifecycle')
  const lifecycle = getProductionDriveLifecycle()
  if (!lifecycle) throw new Error('Production Drive lifecycle is unavailable.')
  lifecycle.commands.reportProgress(payload)
}

const defaultPublishMessage = async (
  payload: MessagePublishPayload,
  context: { agentInstanceId: string; sourceEvent: AgentEvent }
): Promise<void> => {
  const { getProductionRuntimeChannelLifecycle } =
    await import('../magicAgentPlatform2/channels/productionRuntimeChannelLifecycle')
  const lifecycle = getProductionRuntimeChannelLifecycle()
  if (!lifecycle) throw new Error('Production Runtime Channel lifecycle is unavailable.')
  const message: RuntimeChannelMessageState = {
    id: payload.messageId,
    channelId: payload.channelId,
    publisherMemberId: payload.publisherMemberId,
    payload: payload.payload,
    priority: payload.priority,
    publishedAt: payload.publishedAt,
    ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt })
  }
  lifecycle.commands.publish({
    actor: { kind: 'agent', id: context.agentInstanceId },
    message,
    expectedChannelRevision: payload.expectedChannelRevision,
    idempotencyKey: payload.idempotencyKey
  })
}

const toKernelSafeSegment = (value: unknown): string =>
  cleanString(value).replace(/[^a-zA-Z0-9_.-]+/g, '_') || 'unknown'

const toKernelAgentCapabilityId = (agentId: string): string =>
  `${MAGIC_AGENT_KERNEL_PREFIX}.agent.${toKernelSafeSegment(agentId)}`

const toKernelCreativeCapabilityId = (toolName: string): string =>
  `${MAGIC_AGENT_KERNEL_PREFIX}.tool.creative.${toKernelSafeSegment(toolName)}`

const toKernelCreativeToolName = (toolName: string): string =>
  `magicagent.creative.${toKernelSafeSegment(toolName)}`

const requirePlatformRoute = (
  route: AgentRouteLike | undefined,
  operation: string
): AssistantRoute => {
  if (!route) {
    throw new Error(`MagicAgent platform ${operation} requires an explicit trusted route.`)
  }
  return normalizeAgentRoute(route) as AssistantRoute
}

const resolveRunAllowedToolNames = (
  requested: string[] | null | undefined,
  agentToolNames: string[] | null | undefined
): string[] => {
  // Platform v1 is no-tools by default. A renderer-facing run must opt into a
  // concrete allowlist; agent.toolNames can only further narrow that list.
  const requestedNames = Array.isArray(requested)
    ? [
        ...new Set(
          requested
            .map((name) => normalizeMagicPotToolName(name))
            .filter((name) => Boolean(name) && !isMagicAgentPlatformDeniedToolName(name))
        )
      ]
    : []
  if (!requestedNames.length) {
    return []
  }

  if (!Array.isArray(agentToolNames)) {
    return requestedNames
  }

  const agentSet = new Set(
    agentToolNames.map((name) => normalizeMagicPotToolName(name)).filter(Boolean)
  )
  return requestedNames.filter((name) => agentSet.has(name))
}

const mapMagicAgentStatusToKernelStatus = (status: string): AgentRunStatus => {
  if (status === 'completed') {
    return 'completed'
  }
  if (status === 'aborted') {
    return 'cancelled'
  }
  if (status === 'running' || status === 'pending') {
    return status
  }
  return 'failed'
}

const formatJsonContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined) {
    return ''
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const normalizeAgentDefinition = (
  agent: MagicAgentPlatformAgentDefinition
): MagicAgentPlatformAgentDefinition => ({
  id: normalizeMagicPotToolName(agent.id),
  name: cleanString(agent.name) || cleanString(agent.id),
  ...(cleanString(agent.description) ? { description: cleanString(agent.description) } : {}),
  ...(cleanString(agent.systemPrompt) ? { systemPrompt: cleanString(agent.systemPrompt) } : {}),
  ...(agent.toolNames !== undefined
    ? {
        toolNames: Array.isArray(agent.toolNames)
          ? agent.toolNames.map(cleanString).filter(Boolean)
          : null
      }
    : {}),
  ...(Number.isFinite(agent.maxToolIterations)
    ? { maxToolIterations: Math.max(0, Math.trunc(Number(agent.maxToolIterations))) }
    : {}),
  ...(cleanString(agent.profileId) ? { profileId: cleanString(agent.profileId) } : {})
})

const assistantToolToPlatformDefinition = (tool: {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}): MagicAgentPlatformToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  source: 'assistantRuntime',
  status: 'available',
  metadata: {
    source: 'assistantRuntime',
    ...(new Set([
      'files.write',
      'files.edit',
      'files.patch',
      'files.multi-edit',
      'files.json.write',
      'files.snapshot.restore'
    ]).has(tool.name)
      ? { effects: [{ kind: 'filesystem.write', risk: 'high' }] }
      : new Set(['git.branch', 'git.checkout', 'git.add', 'git.commit']).has(tool.name)
        ? {
            effects: [
              { kind: 'filesystem.write', risk: 'high' },
              { kind: 'process.execute', risk: 'high' }
            ]
          }
        : {})
  }
})

const creativeToolToPlatformDefinition = (
  tool: MagicAgentCreativeToolDefinition
): MagicAgentPlatformToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  source: 'creative',
  category: tool.category,
  status: tool.status,
  permissionLevel: tool.permissionLevel,
  requiresConfirmation: tool.requiresConfirmation,
  disabledByDefault: tool.disabledByDefault,
  ...(tool.unavailableReason ? { unavailableReason: tool.unavailableReason } : {}),
  metadata: {
    source: 'magicAgentCreativeToolRegistry',
    category: tool.category,
    permissionLevel: tool.permissionLevel,
    requiresConfirmation: tool.requiresConfirmation,
    disabledByDefault: tool.disabledByDefault
  }
})

const platformToolToRuntimeRegistration = (
  definition: MagicAgentPlatformToolDefinition,
  handler: MagicAgentToolRegistration['handler']
): MagicAgentToolRegistration => ({
  name: definition.name,
  description: definition.description,
  inputSchema: definition.inputSchema,
  metadata: {
    ...(definition.metadata || {}),
    source: definition.source,
    ...(definition.category ? { category: definition.category } : {}),
    ...(definition.status ? { status: definition.status } : {}),
    ...(definition.permissionLevel ? { permissionLevel: definition.permissionLevel } : {}),
    ...(definition.requiresConfirmation !== undefined
      ? { requiresConfirmation: definition.requiresConfirmation }
      : {}),
    ...(definition.disabledByDefault !== undefined
      ? { disabledByDefault: definition.disabledByDefault }
      : {}),
    ...(definition.unavailableReason ? { unavailableReason: definition.unavailableReason } : {})
  },
  handler
})

const creativeResultToRuntimeToolResult = (
  result: MagicAgentCreativeToolResult
): MagicAgentToolResult => ({
  content:
    result.error ||
    result.unavailableReason ||
    formatJsonContent(result.data) ||
    (result.ok ? 'Creative tool completed.' : 'Creative tool unavailable.'),
  metadata: {
    ok: result.ok,
    toolName: result.toolName,
    category: result.category,
    status: result.status,
    ...(result.unavailableReason ? { unavailableReason: result.unavailableReason } : {}),
    ...(result.permissionDenied ? { permissionDenied: result.permissionDenied } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.data !== undefined ? { data: result.data } : {})
  }
})

const creativeResultToPlatformToolResult = (
  result: MagicAgentCreativeToolResult
): MagicAgentPlatformToolCallResp => ({
  ok: result.ok,
  toolName: result.toolName,
  source: 'creative',
  status: result.ok
    ? 'ok'
    : result.permissionDenied
      ? 'permission-denied'
      : result.status === 'unavailable'
        ? 'unavailable'
        : 'failed',
  content:
    result.error ||
    result.unavailableReason ||
    formatJsonContent(result.data) ||
    (result.ok ? 'Creative tool completed.' : 'Creative tool unavailable.'),
  ...(result.data !== undefined ? { data: result.data } : {}),
  ...(result.unavailableReason ? { unavailableReason: result.unavailableReason } : {}),
  ...(result.error ? { error: result.error } : {}),
  metadata: {
    category: result.category,
    creativeStatus: result.status
  }
})

const isMagicAgentCreativeToolResult = (value: unknown): value is MagicAgentCreativeToolResult =>
  isRecord(value) &&
  typeof value.ok === 'boolean' &&
  typeof value.toolName === 'string' &&
  typeof value.category === 'string' &&
  typeof value.status === 'string'

const isPermissionError = (error: unknown): boolean =>
  error instanceof Error && /permission|not allowed|denied/i.test(error.message)

const composeAbortSignals = (
  signals: ReadonlyArray<AbortSignal | undefined>
): { signal: AbortSignal; cleanup: () => void } => {
  const controller = new AbortController()
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  const listeners = new Map<AbortSignal, () => void>()
  for (const signal of activeSignals) {
    const forward = (): void => controller.abort(signal.reason)
    if (signal.aborted) {
      forward()
      break
    }
    listeners.set(signal, forward)
    signal.addEventListener('abort', forward, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
      listeners.clear()
    }
  }
}

type PendingRunContext = {
  options: MagicAgentPlatformExecutionOptions
  callers: number
  handlerActive: boolean
}

type ActionSettlement = {
  fingerprint: string
  execution: Promise<void>
}

export class MagicAgentPlatformAdapter {
  private readonly assistantRuntime: Pick<
    AssistantRuntime,
    'listTools' | 'callTool' | 'handleMessage'
  >
  private readonly creativeToolRegistry: MagicAgentCreativeToolRegistry
  private readonly creativeToolDependencies?: Partial<MagicAgentCreativeToolDependencies>
  private readonly agentKernel: AgentKernel
  private readonly dispatchKernel: AgentKernel
  private readonly runtimeToolRegistry: MagicAgentToolRegistry
  private readonly runtime: MagicAgentRuntime
  private readonly reportDriveProgress: (
    payload: DriveProgressPayload
  ) => unknown | Promise<unknown>
  private readonly publishMessage: (
    payload: MessagePublishPayload,
    context: { agentInstanceId: string; sourceEvent: AgentEvent }
  ) => unknown | Promise<unknown>
  private readonly startChild: NonNullable<MagicAgentPlatformAdapterDeps['startChild']>
  private readonly driveProgressSettlementMax: number
  private readonly messagePublishSettlementMax: number
  private readonly childStartSettlementMax: number
  private readonly driveProgressSettlements = new Map<string, ActionSettlement>()
  private readonly messagePublishSettlements = new Map<string, ActionSettlement>()
  private readonly childStartSettlements = new Map<string, ActionSettlement>()
  private readonly pendingRunOptions = new Map<string, PendingRunContext>()
  private readonly activeInvocationControllers = new Set<AbortController>()
  private readonly unregisterUserMessageHandler: () => void
  private readonly unregisterChannelMessageHandler: () => void
  private readonly unregisterDriveAssignedHandler: () => void
  private readonly unregisterTriggerFiredHandler: () => void
  private readonly ownsDispatchKernel: boolean
  private readonly managedKernelCapabilityIds = new Set<string>()
  private disposed = false
  private kernelSurfaceSignature = ''

  constructor(deps: MagicAgentPlatformAdapterDeps = {}) {
    this.assistantRuntime = deps.assistantRuntime || getAssistantRuntime()
    this.creativeToolRegistry = deps.creativeToolRegistry || createMagicAgentCreativeToolRegistry()
    this.creativeToolDependencies = deps.creativeToolDependencies
    this.agentKernel = deps.agentKernel || getAgentKernel()
    this.ownsDispatchKernel = !deps.dispatchKernel
    this.dispatchKernel = deps.dispatchKernel || new AgentKernel()
    this.reportDriveProgress = deps.reportDriveProgress || defaultReportDriveProgress
    this.publishMessage = deps.publishMessage || defaultPublishMessage
    this.startChild = deps.startChild || defaultStartChild
    this.driveProgressSettlementMax = deps.driveProgressSettlementMax ?? 1_000
    this.messagePublishSettlementMax = deps.messagePublishSettlementMax ?? 1_000
    this.childStartSettlementMax = deps.childStartSettlementMax ?? 1_000
    if (!Number.isInteger(this.driveProgressSettlementMax) || this.driveProgressSettlementMax < 0)
      throw new Error('MagicAgent drive progress settlement max must be a nonnegative integer.')
    if (!Number.isInteger(this.messagePublishSettlementMax) || this.messagePublishSettlementMax < 0)
      throw new Error('MagicAgent message publish settlement max must be a nonnegative integer.')
    if (!Number.isInteger(this.childStartSettlementMax) || this.childStartSettlementMax < 0)
      throw new Error('MagicAgent child start settlement max must be a nonnegative integer.')
    this.unregisterUserMessageHandler = this.dispatchKernel.registerActionHandler(
      MAGIC_AGENT_USER_MESSAGE_EVENT,
      (event, context) => this.handleMessage(event, context.signal)
    )
    try {
      this.unregisterChannelMessageHandler = this.dispatchKernel.registerActionHandler(
        MAGIC_AGENT_CHANNEL_MESSAGE_EVENT,
        (event, context) => this.handleMessage(event, context.signal)
      )
      try {
        this.unregisterDriveAssignedHandler = this.dispatchKernel.registerActionHandler(
          MAGIC_AGENT_DRIVE_ASSIGNED_EVENT,
          (event, context) => this.handleMessage(event, context.signal)
        )
        try {
          this.unregisterTriggerFiredHandler = this.dispatchKernel.registerActionHandler(
            MAGIC_AGENT_TRIGGER_FIRED_EVENT,
            (event, context) => this.handleMessage(event, context.signal)
          )
        } catch (error) {
          this.unregisterDriveAssignedHandler()
          throw error
        }
      } catch (error) {
        this.unregisterChannelMessageHandler()
        throw error
      }
    } catch (error) {
      this.unregisterUserMessageHandler()
      throw error
    }

    this.runtimeToolRegistry = deps.toolRegistry || new MagicAgentToolRegistry()
    this.runtime = new MagicAgentRuntime({
      chatService: deps.chatService || new LLMProxySvcImpl(),
      ...(deps.agentRegistry ? { agentRegistry: deps.agentRegistry } : {}),
      toolRegistry: this.runtimeToolRegistry
    })
    this.refreshRuntimeTools()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unregisterUserMessageHandler()
    this.unregisterChannelMessageHandler()
    this.unregisterDriveAssignedHandler()
    this.unregisterTriggerFiredHandler()
    for (const controller of this.activeInvocationControllers) {
      controller.abort(new Error('MagicAgentPlatformAdapter has been disposed.'))
    }
    this.activeInvocationControllers.clear()
    this.pendingRunOptions.clear()
    this.driveProgressSettlements.clear()
    this.messagePublishSettlements.clear()
    this.childStartSettlements.clear()
    if (this.ownsDispatchKernel) this.dispatchKernel.clear()
  }

  private async executeActionOnce(
    action: AgentAction,
    payload: JsonValue,
    settlements: Map<string, ActionSettlement>,
    settlementMax: number,
    execute: () => unknown | Promise<unknown>,
    label: string
  ): Promise<void> {
    const fingerprint = canonicalPolicyJson(payload as unknown as PolicyJsonRecord)
    const existing = settlements.get(action.actionId)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error(`MagicAgent ${label} action "${action.actionId}" payload conflict.`)
      return existing.execution
    }

    const settlement: ActionSettlement = { fingerprint, execution: Promise.resolve() }
    settlement.execution = Promise.resolve(execute()).then(
      () => {
        if (settlements.get(action.actionId) !== settlement) return
        if (settlementMax === 0) {
          settlements.delete(action.actionId)
          return
        }
        settlements.delete(action.actionId)
        settlements.set(action.actionId, settlement)
        while (settlements.size > settlementMax) {
          const oldest = settlements.keys().next().value
          if (oldest === undefined) break
          settlements.delete(oldest)
        }
      },
      (error) => {
        if (settlements.get(action.actionId) === settlement) settlements.delete(action.actionId)
        throw error
      }
    )
    settlements.set(action.actionId, settlement)
    return settlement.execution
  }

  private executeDriveProgressOnce(
    action: AgentAction,
    payload: DriveProgressPayload
  ): Promise<void> {
    return this.executeActionOnce(
      action,
      payload as unknown as JsonValue,
      this.driveProgressSettlements,
      this.driveProgressSettlementMax,
      () => this.reportDriveProgress(payload),
      MAGIC_AGENT_DRIVE_PROGRESS_ACTION
    )
  }

  private executeMessagePublishOnce(
    action: AgentAction,
    payload: MessagePublishPayload,
    context: { agentInstanceId: string; sourceEvent: AgentEvent }
  ): Promise<void> {
    return this.executeActionOnce(
      action,
      payload as unknown as JsonValue,
      this.messagePublishSettlements,
      this.messagePublishSettlementMax,
      () => this.publishMessage(payload, context),
      MAGIC_AGENT_MESSAGE_PUBLISH_ACTION
    )
  }

  private executeChildStartOnce(
    action: AgentAction,
    payload: ChildStartPayload,
    context: {
      actor: { kind: 'agent'; id: string }
      agentInstanceId: string
      sourceEvent: AgentEvent
    }
  ): Promise<void> {
    return this.executeActionOnce(
      action,
      payload as unknown as JsonValue,
      this.childStartSettlements,
      this.childStartSettlementMax,
      () => this.startChild(payload, context),
      MAGIC_AGENT_CHILD_START_ACTION
    )
  }

  refreshRuntimeTools(): void {
    const registrations: MagicAgentToolRegistration[] = [
      ...this.assistantRuntime
        .listTools()
        .filter((tool) => !isMagicAgentPlatformDeniedToolName(tool.name))
        .map((tool) =>
          platformToolToRuntimeRegistration(
            assistantToolToPlatformDefinition(tool),
            async (args, context) => {
              const result = await this.assistantRuntime.callTool(
                requirePlatformRoute(
                  context.metadata?.route as AgentRouteLike | undefined,
                  'runtime tool dispatch'
                ),
                normalizeMagicPotToolName(tool.name),
                args,
                {
                  allowedToolNames: context.metadata?.allowedToolNames as
                    string[] | null | undefined
                }
              )
              return {
                content: String(result?.content || ''),
                ...(result?.metadata ? { metadata: result.metadata } : {})
              }
            }
          )
        ),
      ...this.listPlatformCreativeTools().map((tool) =>
        platformToolToRuntimeRegistration(
          creativeToolToPlatformDefinition(tool),
          async (args, context) =>
            creativeResultToRuntimeToolResult(
              await this.invokeCreativeToolViaKernel(
                tool.name,
                args,
                context.signal,
                context.metadata?.route as AgentRouteLike | undefined,
                {
                  runId: context.runId,
                  agentId: context.agentId,
                  allowedToolNames: context.metadata?.allowedToolNames
                }
              )
            )
        )
      )
    ]

    this.runtimeToolRegistry.clear()
    this.runtime.registerTools(registrations)
    this.syncKernelPlatformSurface()
  }

  listAgents(): MagicAgentPlatformAgentDefinition[] {
    return this.runtime.listAgents().map(normalizeAgentDefinition)
  }

  registerAgent(agent: MagicAgentPlatformAgentDefinition): MagicAgentPlatformAgentDefinition {
    const normalized = normalizeAgentDefinition(agent)
    if (!normalized.id) {
      throw new Error('MagicAgent platform agent id is required.')
    }
    const registered = normalizeAgentDefinition(this.runtime.registerAgent(normalized))
    this.syncKernelPlatformSurface(true)
    return registered
  }

  listTools(
    options: { agentId?: string; source?: MagicAgentPlatformToolSource } = {}
  ): MagicAgentPlatformToolDefinition[] {
    const source = options.source
    const tools: MagicAgentPlatformToolDefinition[] = []

    if (!source || source === 'assistantRuntime') {
      tools.push(
        ...this.assistantRuntime
          .listTools()
          .filter((tool) => !isMagicAgentPlatformDeniedToolName(tool.name))
          .map(assistantToolToPlatformDefinition)
      )
    }

    if (!source || source === 'creative') {
      tools.push(...this.listPlatformCreativeTools().map(creativeToolToPlatformDefinition))
    }

    // v1 deliberately does not expose MagicAgentRuntime's internal registry as a
    // callable/listable platform source. Tool execution must stay behind the
    // route-aware AssistantRuntime or the fail-closed creative Kernel path.
    return tools
  }

  async callTool(
    req: MagicAgentPlatformToolCallReq,
    options: MagicAgentPlatformExecutionOptions = {}
  ): Promise<MagicAgentPlatformToolCallResp> {
    const name = normalizeMagicPotToolName(req.name)
    if (!name) {
      return {
        ok: false,
        toolName: '',
        source: req.source || 'magicAgentRuntime',
        status: 'unavailable',
        content: 'Tool name is required.',
        unavailableReason: 'Tool name is required.'
      }
    }

    const source = req.source || this.resolveToolSource(name)
    const args = req.args || {}

    if (isMagicAgentPlatformDeniedToolName(name)) {
      return {
        ok: false,
        toolName: name,
        source,
        status: 'permission-denied',
        content: `Tool "${name}" is not allowed through the MagicAgent platform boundary.`,
        error: `Tool "${name}" is not allowed through the MagicAgent platform boundary.`
      }
    }

    try {
      if (source === 'assistantRuntime') {
        return {
          ok: false,
          toolName: name,
          source,
          status: 'permission-denied',
          content:
            'AssistantRuntime tools are not directly callable through the MagicAgent platform service. Use route-scoped runAgent with an explicit allowedToolNames list.',
          error: 'Direct AssistantRuntime tool IPC is disabled at the platform boundary.'
        }
      }

      if (source === 'creative') {
        const route = requirePlatformRoute(req.route, 'creative tool call')
        return creativeResultToPlatformToolResult(
          await this.invokeCreativeToolViaKernel(name, args, options.signal, route, req.metadata)
        )
      }

      return {
        ok: false,
        toolName: name,
        source,
        status: 'permission-denied',
        content:
          'MagicAgentRuntime tools are not directly callable through the platform service. Use AssistantRuntime-routed execution.',
        error: 'MagicAgentRuntime direct tool execution is disabled at the platform boundary.'
      }
    } catch (error) {
      return this.errorToolResult(name, source, error)
    }
  }

  async runAgent(
    req: MagicAgentPlatformRunReq,
    options: MagicAgentPlatformExecutionOptions = {}
  ): Promise<MagicAgentPlatformRunResp> {
    if (this.disposed) throw new Error('MagicAgentPlatformAdapter has been disposed.')
    const invocationController = new AbortController()
    this.activeInvocationControllers.add(invocationController)
    const invocationSignals = composeAbortSignals([options.signal, invocationController.signal])
    let pendingEventId: string | undefined
    try {
      const rawRoute = req.route
      const route = requirePlatformRoute(rawRoute, 'agent run')
      const agentId = normalizeMagicPotToolName(req.agentId) || 'magicpot.default.chat'
      const channelContext = readRuntimeChannelTrustedDispatchContext(req)
      const driveContext = readDriveTrustedDispatchContext(req)
      const triggerContext = readTriggerTrustedDispatchContext(req)
      if ([channelContext, driveContext, triggerContext].filter(Boolean).length > 1) {
        throw new Error(
          'MagicAgent run cannot contain conflicting Channel, Drive, or Trigger trusted contexts.'
        )
      }
      if (
        channelContext &&
        (route.channel !== 'runtime-channel' ||
          route.scopeType !== 'dm' ||
          route.scopeId !== channelContext.channelId)
      ) {
        throw new Error(
          'Runtime Channel trusted context must match a runtime-channel dm route scoped to its channelId.'
        )
      }
      const sessionId = cleanString(req.sessionId) || getAgentSessionKey(route)
      if (driveContext) {
        if (
          route.channel !== DRIVE_ROUTE ||
          route.scopeType !== 'channel' ||
          route.scopeId !== driveContext.driveId
        ) {
          throw new Error(
            'Drive trusted context must match the Drive runtime channel route scoped to its driveId.'
          )
        }
        if (agentId !== driveContext.targetAgentId) {
          throw new Error('Drive trusted context targetAgentId must match the normalized agentId.')
        }
        if (
          req.metadata?.driveId !== driveContext.driveId ||
          req.metadata?.driveRevision !== driveContext.driveRevision
        ) {
          throw new Error('Drive request metadata must exactly match its trusted Drive context.')
        }
        if (driveContext.targetSessionId && driveContext.targetSessionId !== sessionId) {
          throw new Error(
            'Drive trusted context targetSessionId must match the resolved sessionId.'
          )
        }
      }
      if (triggerContext) {
        if (
          rawRoute.channel !== TRIGGER_CHANNEL ||
          String(rawRoute.scopeType) !== 'agent' ||
          rawRoute.scopeId !== triggerContext.targetAgentId ||
          rawRoute.threadId !== TRIGGER_THREAD
        ) {
          throw new Error('Trigger trusted context must match the trigger runtime agent route.')
        }
        if (agentId !== triggerContext.targetAgentId) {
          throw new Error(
            'Trigger trusted context targetAgentId must match the normalized agentId.'
          )
        }
        if (triggerContext.targetSessionId && triggerContext.targetSessionId !== sessionId) {
          throw new Error(
            'Trigger trusted context targetSessionId must match the resolved sessionId.'
          )
        }
      }
      const eventId = channelContext
        ? runtimeChannelEventId(channelContext, agentId)
        : driveContext
          ? driveEventId(driveContext, req, agentId, sessionId)
          : triggerContext
            ? triggerEventId(triggerContext, req, agentId, sessionId)
            : crypto.randomUUID()
      const correlationId =
        channelContext || driveContext || triggerContext
          ? eventId
          : cleanString(req.metadata?.correlationId) || eventId
      const event: AgentEvent = channelContext
        ? {
            eventId,
            type: MAGIC_AGENT_CHANNEL_MESSAGE_EVENT,
            payload: toJsonValue(
              {
                request: { ...req, route },
                channelId: channelContext.channelId,
                memberId: channelContext.memberId,
                pendingMessageIds: [...channelContext.pendingMessageIds],
                agentInstanceId: channelContext.agentInstanceId
              },
              'MagicAgent channel.message payload'
            ),
            createdAt: 0,
            correlationId,
            sessionId,
            agentId,
            provenance: {
              source: 'runtimeChannel',
              requestedBy: `runtime-channel-member:${channelContext.memberId}`,
              channel: channelContext.channelId,
              traceId: correlationId
            }
          }
        : driveContext
          ? {
              eventId,
              type: MAGIC_AGENT_DRIVE_ASSIGNED_EVENT,
              payload: toJsonValue(
                {
                  request: { ...req, route },
                  driveId: driveContext.driveId,
                  driveRevision: driveContext.driveRevision,
                  status: driveContext.status,
                  ...(driveContext.ownerId ? { ownerId: driveContext.ownerId } : {}),
                  ...(driveContext.assigneeId ? { assigneeId: driveContext.assigneeId } : {}),
                  targetAgentId: driveContext.targetAgentId,
                  ...(driveContext.targetSessionId
                    ? { targetSessionId: driveContext.targetSessionId }
                    : {})
                },
                'MagicAgent drive.assigned payload'
              ),
              createdAt: 0,
              correlationId,
              sessionId,
              agentId,
              provenance: {
                source: 'drive',
                requestedBy: driveContext.ownerId
                  ? `drive-owner:${driveContext.ownerId}`
                  : `drive:${driveContext.driveId}`,
                channel: driveContext.driveId,
                traceId: eventId
              }
            }
          : triggerContext
            ? {
                eventId,
                type: MAGIC_AGENT_TRIGGER_FIRED_EVENT,
                payload: toJsonValue(
                  {
                    request: { ...req, route },
                    triggerId: triggerContext.triggerId,
                    occurrenceId: triggerContext.occurrenceId,
                    requestId: triggerContext.requestId,
                    occurrenceAt: triggerContext.occurrenceAt,
                    triggerType: triggerContext.triggerType,
                    triggerTitle: triggerContext.triggerTitle,
                    source: triggerContext.source,
                    attempt: triggerContext.attempt,
                    targetAgentId: triggerContext.targetAgentId,
                    targetSessionId: triggerContext.targetSessionId
                  },
                  'MagicAgent trigger.fired payload'
                ),
                createdAt: triggerContext.occurrenceAt,
                correlationId,
                sessionId,
                agentId,
                provenance: {
                  source: 'trigger',
                  requestedBy: `trigger:${triggerContext.triggerId}`,
                  channel: TRIGGER_CHANNEL,
                  traceId: eventId
                }
              }
            : {
                eventId,
                type: MAGIC_AGENT_USER_MESSAGE_EVENT,
                payload: toJsonValue(
                  { request: { ...req, route } },
                  'MagicAgent user.message payload'
                ),
                createdAt: Date.now(),
                correlationId,
                sessionId,
                agentId,
                provenance: {
                  source: 'magicAgentPlatform',
                  requestedBy: cleanString(req.metadata?.requestedBy) || 'svcMagicAgentPlatform',
                  channel: route.channel,
                  traceId: cleanString(req.metadata?.traceLabel) || correlationId
                }
              }

      pendingEventId = eventId
      const pending = this.pendingRunOptions.get(eventId)
      if (pending) {
        if (pending.options.cooperativeExecution !== options.cooperativeExecution) {
          throw new Error(
            `MagicAgent event "${eventId}" has conflicting concurrent execution options.`
          )
        }
        pending.callers += 1
      } else {
        this.pendingRunOptions.set(eventId, {
          options:
            channelContext || driveContext || triggerContext
              ? { cooperativeExecution: options.cooperativeExecution }
              : { ...options, signal: invocationSignals.signal },
          callers: 1,
          handlerActive: false
        })
      }
      let response: MagicAgentPlatformRunResp | undefined
      const dispatchSignal =
        channelContext || driveContext || triggerContext
          ? invocationSignals.signal
          : invocationController.signal
      for await (const action of this.dispatchKernel.dispatch(event, dispatchSignal)) {
        if (response)
          throw new Error(
            `MagicAgent unary run expected exactly one ${MAGIC_AGENT_REPLY_EMIT_ACTION}; received an action after terminal.`
          )
        if (action.type === MAGIC_AGENT_REPLY_EMIT_ACTION) {
          response = parseRunResponsePayload(action.payload)
          continue
        }
        if (action.type === MAGIC_AGENT_MESSAGE_PUBLISH_ACTION) {
          if (!channelContext || event.type !== MAGIC_AGENT_CHANNEL_MESSAGE_EVENT)
            throw new Error(
              'MagicAgent message.publish is only valid for a trusted channel.message event.'
            )
          const published = parseMessagePublishPayload(action.payload)
          if (
            published.channelId !== channelContext.channelId ||
            published.publisherMemberId !== channelContext.memberId
          )
            throw new Error('MagicAgent message.publish does not match trusted Channel context.')
          await this.executeMessagePublishOnce(action, published, {
            agentInstanceId: channelContext.agentInstanceId,
            sourceEvent: event
          })
          continue
        }
        if (action.type === MAGIC_AGENT_CHILD_START_ACTION) {
          if (!channelContext || event.type !== MAGIC_AGENT_CHANNEL_MESSAGE_EVENT)
            throw new Error(
              'MagicAgent child.start is only valid for a trusted channel.message event.'
            )
          const childStart = parseChildStartPayload(action.payload)
          if (childStart.parentInstanceId !== channelContext.agentInstanceId)
            throw new Error('MagicAgent child.start does not match trusted Channel context.')
          await this.executeChildStartOnce(action, childStart, {
            actor: { kind: 'agent', id: channelContext.agentInstanceId },
            agentInstanceId: channelContext.agentInstanceId,
            sourceEvent: event
          })
          continue
        }
        if (action.type === MAGIC_AGENT_DRIVE_PROGRESS_ACTION) {
          if (!driveContext || event.type !== MAGIC_AGENT_DRIVE_ASSIGNED_EVENT)
            throw new Error(
              'MagicAgent drive.progress is only valid for a trusted drive.assigned event.'
            )
          const progress = parseDriveProgressPayload(action.payload)
          if (
            progress.driveId !== driveContext.driveId ||
            progress.expectedRevision !== driveContext.driveRevision
          )
            throw new Error('MagicAgent drive.progress does not match trusted Drive context.')
          await this.executeDriveProgressOnce(action, progress)
          continue
        }
        throw new Error(`MagicAgent unary run received unsupported action "${action.type}".`)
      }
      if (!response)
        throw new Error(
          `MagicAgent unary run expected exactly one ${MAGIC_AGENT_REPLY_EMIT_ACTION}.`
        )
      return response
    } finally {
      if (pendingEventId) {
        const pending = this.pendingRunOptions.get(pendingEventId)
        if (pending) {
          pending.callers -= 1
          if (pending.callers === 0 && !pending.handlerActive) {
            this.pendingRunOptions.delete(pendingEventId)
          }
        }
      }
      invocationSignals.cleanup()
      this.activeInvocationControllers.delete(invocationController)
    }
  }

  private handleMessage(event: AgentEvent, signal: AbortSignal): AsyncIterable<AgentAction> {
    const pending = this.pendingRunOptions.get(event.eventId)
    if (!pending) {
      throw new Error(
        `MagicAgent ${event.type} event was not created by an authorized adapter invocation.`
      )
    }
    pending.handlerActive = true
    const options = pending.options
    const request = parseRunRequestPayload(event.payload)
    const runAgentAuthorized = this.runAgentAuthorized.bind(this)
    const releaseHandler = (): void => {
      pending.handlerActive = false
      if (pending.callers === 0) this.pendingRunOptions.delete(event.eventId)
    }
    return {
      async *[Symbol.asyncIterator]() {
        try {
          const combined = composeAbortSignals([options.signal, signal])
          try {
            const response = await runAgentAuthorized(request, {
              ...options,
              signal: combined.signal
            })
            if (event.type === MAGIC_AGENT_DRIVE_ASSIGNED_EVENT) {
              if (!isRecord(event.payload))
                throw new TypeError('MagicAgent drive.assigned payload is invalid.')
              const driveId = event.payload.driveId
              const expectedRevision = event.payload.driveRevision
              if (typeof driveId !== 'string' || !Number.isInteger(expectedRevision))
                throw new TypeError('MagicAgent drive.assigned payload is invalid.')
              yield createDriveProgressAction({
                actionId: `${event.eventId}:drive-progress`,
                payload: {
                  driveId,
                  expectedRevision: expectedRevision as number,
                  summary: cleanString(response.content) || 'Drive run completed.',
                  evidence: [
                    { kind: 'run', ref: response.runId },
                    ...(event.sessionId ? [{ kind: 'session' as const, ref: event.sessionId }] : [])
                  ],
                  reportedAt: event.createdAt,
                  idempotencyKey: `${event.eventId}:drive-progress`
                },
                correlationId: event.correlationId,
                sessionId: event.sessionId,
                agentId: event.agentId,
                provenance: event.provenance
              })
            }
            yield createReplyEmitAction({
              actionId: `${event.eventId}:reply`,
              payload: { response: toJsonValue(response, 'MagicAgent reply.emit response') },
              correlationId: event.correlationId,
              sessionId: event.sessionId,
              agentId: event.agentId,
              provenance: event.provenance
            })
          } finally {
            combined.cleanup()
          }
        } finally {
          releaseHandler()
        }
      }
    }
  }

  private async runAgentAuthorized(
    req: MagicAgentPlatformRunReq,
    options: MagicAgentPlatformExecutionOptions = {}
  ): Promise<MagicAgentPlatformRunResp> {
    this.refreshRuntimeTools()
    const route = requirePlatformRoute(req.route, 'agent run')
    const agentId = normalizeMagicPotToolName(req.agentId) || 'magicpot.default.chat'
    const agentDefinition = this.listAgents().find((agent) => agent.id === agentId)
    const systemPrompt = composeSystemPrompt(agentDefinition?.systemPrompt, req.systemPrompt)
    const effectiveAllowedToolNames = resolveRunAllowedToolNames(
      req.allowedToolNames,
      agentDefinition?.toolNames
    )
    const startedAt = Date.now()
    const requestedTimeoutMs = Number(req.timeoutMs)
    const timeoutMs =
      Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
        ? Math.max(1, Math.floor(requestedTimeoutMs))
        : undefined
    const executionController = new AbortController()
    const forwardExternalAbort = (): void => executionController.abort(options.signal?.reason)
    if (options.signal?.aborted) {
      forwardExternalAbort()
    } else {
      options.signal?.addEventListener('abort', forwardExternalAbort, { once: true })
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs) {
      timeoutHandle = setTimeout(
        () => executionController.abort(new MagicAgentPlatformTimeoutError(timeoutMs)),
        timeoutMs
      )
    }
    const session = this.agentKernel.registerSession(route, { source: 'kernel' })
    const kernelRun = this.agentKernel.createMasterRun({
      session,
      goal: cleanString(req.text) || `Run MagicAgent ${agentId}`,
      label: `MagicAgent ${agentId}`,
      parallelism: 1,
      requestedBy: cleanString(req.metadata?.requestedBy) || 'svcMagicAgentPlatform',
      metadata: {
        ...(req.metadata || {}),
        source: 'magicAgentPlatform',
        executionBoundary: 'assistantRuntime',
        agentId
      }
    })
    this.agentKernel.updateRun(kernelRun.runId, {
      status: 'running',
      startedAt
    })

    try {
      const assistantPromise = this.assistantRuntime.handleMessage({
        route,
        text: req.text,
        ...(req.attachments?.length ? { attachments: req.attachments } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(req.profileId ? { profileId: req.profileId } : {}),
        signal: executionController.signal,
        cooperativeExecution: options.cooperativeExecution,
        execution: {
          mode: req.memory?.allowHistory === false ? 'no-history' : 'inherit',
          ...(req.memory
            ? {
                allowHistory: req.memory.allowHistory,
                contextMessageLimit: req.memory.contextMessageLimit
              }
            : {}),
          allowedToolNames: effectiveAllowedToolNames,
          ...(req.maxToolIterations === undefined ? {} : { maxToolCalls: req.maxToolIterations }),
          ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          traceLabel:
            cleanString(req.metadata?.traceLabel) ||
            cleanString(req.metadata?.requestedBy) ||
            `magicagent:${agentId}`
        }
      })
      const assistantResult = timeoutMs
        ? await Promise.race([
            assistantPromise,
            new Promise<never>((_resolve, reject) => {
              const rejectOnAbort = (): void => {
                if (executionController.signal.reason instanceof MagicAgentPlatformTimeoutError) {
                  reject(executionController.signal.reason)
                }
              }
              if (executionController.signal.aborted) {
                rejectOnAbort()
              } else {
                executionController.signal.addEventListener('abort', rejectOnAbort, { once: true })
              }
            })
          ])
        : await assistantPromise
      const finishedAt = Date.now()
      const timedOut = executionController.signal.reason instanceof MagicAgentPlatformTimeoutError
      const status = timedOut
        ? 'timeout'
        : assistantResult.status === 'failed'
          ? 'failed'
          : assistantResult.status === 'cancelled'
            ? 'aborted'
            : 'completed'
      const kernelStatus = mapMagicAgentStatusToKernelStatus(status)
      this.agentKernel.updateRun(kernelRun.runId, {
        status: kernelStatus,
        endedAt: finishedAt,
        metadata: {
          ...(kernelRun.metadata || {}),
          assistantRunId: assistantResult.runId,
          assistantSessionKey: assistantResult.sessionKey,
          magicAgentStatus: status,
          executionBoundary: 'assistantRuntime'
        }
      })
      this.agentKernel.recordEvent({
        runId: kernelRun.runId,
        sessionKey: session.sessionKey,
        type: kernelStatus === 'completed' ? 'run.completed' : 'run.failed',
        message:
          kernelStatus === 'completed'
            ? `MagicAgent run completed through AssistantRuntime: ${agentId}`
            : `MagicAgent run ended through AssistantRuntime: ${status}`,
        metadata: {
          assistantRunId: assistantResult.runId,
          assistantSessionKey: assistantResult.sessionKey,
          magicAgentStatus: status,
          executionBoundary: 'assistantRuntime'
        }
      })

      return {
        runId: assistantResult.runId || kernelRun.runId,
        agentId,
        status,
        content: String(assistantResult.reply?.content || ''),
        messages: [
          {
            role: 'user',
            content: req.text,
            ...(req.attachments?.length ? { attachments: req.attachments } : {})
          },
          {
            role: 'assistant',
            content: String(assistantResult.reply?.content || ''),
            ...(assistantResult.reply?.attachments?.length
              ? { attachments: assistantResult.reply.attachments }
              : {}),
            metadata: {
              source: 'assistantRuntime',
              sessionKey: assistantResult.sessionKey,
              ...(assistantResult.runId ? { assistantRunId: assistantResult.runId } : {})
            }
          }
        ],
        toolCalls: [],
        events: (assistantResult.events || []).map((event) => ({
          eventId: event.eventId,
          runId: event.runId,
          agentId,
          type: `assistantRuntime.${event.type}`,
          message: event.message,
          createdAt: event.createdAt,
          metadata: {
            ...(event.metadata || {}),
            sessionKey: event.sessionKey
          }
        })),
        startedAt,
        finishedAt,
        ...(timedOut ? { error: executionController.signal.reason.message } : {})
      }
    } catch (error) {
      if (executionController.signal.reason instanceof MagicAgentPlatformTimeoutError) {
        const timeoutError = executionController.signal.reason
        const finishedAt = Date.now()
        this.agentKernel.updateRun(kernelRun.runId, {
          status: 'failed',
          endedAt: finishedAt,
          metadata: {
            ...(kernelRun.metadata || {}),
            error: timeoutError.message,
            magicAgentStatus: 'timeout',
            executionBoundary: 'assistantRuntime'
          }
        })
        this.agentKernel.recordEvent({
          runId: kernelRun.runId,
          sessionKey: session.sessionKey,
          type: 'run.failed',
          message: timeoutError.message,
          metadata: {
            source: 'magicAgentPlatform',
            executionBoundary: 'assistantRuntime',
            agentId,
            magicAgentStatus: 'timeout',
            timeoutMs
          }
        })
        return {
          runId: kernelRun.runId,
          agentId,
          status: 'timeout',
          content: '',
          messages: [{ role: 'user', content: req.text }],
          toolCalls: [],
          events: [],
          startedAt,
          finishedAt,
          error: timeoutError.message
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      this.agentKernel.updateRun(kernelRun.runId, {
        status: 'failed',
        endedAt: Date.now(),
        metadata: {
          ...(kernelRun.metadata || {}),
          error: message,
          executionBoundary: 'assistantRuntime'
        }
      })
      this.agentKernel.recordEvent({
        runId: kernelRun.runId,
        sessionKey: session.sessionKey,
        type: 'run.failed',
        message,
        metadata: {
          source: 'magicAgentPlatform',
          executionBoundary: 'assistantRuntime',
          agentId
        }
      })
      throw error
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      options.signal?.removeEventListener('abort', forwardExternalAbort)
    }
  }

  private resolveToolSource(name: string): MagicAgentPlatformToolSource {
    if (
      this.assistantRuntime
        .listTools()
        .some((tool) => normalizeMagicPotToolName(tool.name) === name)
    ) {
      return 'assistantRuntime'
    }
    if (
      this.listPlatformCreativeTools().some((tool) => normalizeMagicPotToolName(tool.name) === name)
    ) {
      return 'creative'
    }
    return 'magicAgentRuntime'
  }

  private syncKernelPlatformSurface(force = false): void {
    const agents = this.runtime.listAgents().map(normalizeAgentDefinition)
    const creativeTools = this.listPlatformCreativeTools()
    const activeCapabilityIds = new Set([
      ...agents.map((agent) => toKernelAgentCapabilityId(agent.id)),
      ...creativeTools.map((tool) => toKernelCreativeCapabilityId(tool.name))
    ])
    const signature = JSON.stringify({
      agents: agents
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          toolNames: agent.toolNames,
          maxToolIterations: agent.maxToolIterations,
          profileId: agent.profileId
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      creativeTools: creativeTools
        .map((tool) => ({
          name: tool.name,
          category: tool.category,
          status: tool.status,
          permissionLevel: tool.permissionLevel,
          requiresConfirmation: tool.requiresConfirmation,
          disabledByDefault: tool.disabledByDefault,
          unavailableReason: tool.unavailableReason
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    })
    const existingCapabilityIds = new Set(
      this.agentKernel.listCapabilities().map((capability) => capability.capabilityId)
    )
    const missingManagedCapability = [...this.managedKernelCapabilityIds].some(
      (capabilityId) => !existingCapabilityIds.has(capabilityId)
    )
    if (!force && signature === this.kernelSurfaceSignature && !missingManagedCapability) {
      return
    }

    for (const capabilityId of [...this.managedKernelCapabilityIds]) {
      if (!activeCapabilityIds.has(capabilityId)) {
        this.agentKernel.removeCapability(capabilityId)
        this.managedKernelCapabilityIds.delete(capabilityId)
      }
    }

    for (const agent of agents) {
      const capabilityId = toKernelAgentCapabilityId(agent.id)
      this.agentKernel.registerCapability({
        capabilityId,
        name: agent.name,
        kind: 'orchestrator',
        description: agent.description || 'MagicAgent platform agent.',
        version: '1.0.0',
        scope: 'global',
        transport: ['internal'],
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            attachments: { type: 'array' }
          },
          required: ['text']
        },
        metadata: {
          source: 'magicAgentPlatform',
          agentId: agent.id,
          toolNames: agent.toolNames,
          maxToolIterations: agent.maxToolIterations,
          profileId: agent.profileId
        }
      })
      this.managedKernelCapabilityIds.add(capabilityId)
    }

    for (const tool of creativeTools) {
      const capabilityId = toKernelCreativeCapabilityId(tool.name)
      this.agentKernel.registerTool({
        tool: {
          capabilityId,
          name: tool.name,
          toolName: toKernelCreativeToolName(tool.name),
          kind: 'tool',
          description: tool.description,
          version: '1.0.0',
          scope: 'session',
          transport: ['internal'],
          inputSchema: tool.inputSchema,
          metadata: {
            source: 'magicAgentPlatform',
            platformSource: 'creative',
            originalToolName: tool.name,
            category: tool.category,
            status: tool.status,
            permissionLevel: tool.permissionLevel,
            requiresConfirmation: tool.requiresConfirmation,
            disabledByDefault: tool.disabledByDefault,
            ...(tool.unavailableReason ? { unavailableReason: tool.unavailableReason } : {})
          }
        },
        invoker: async (request) => {
          const result = await this.creativeToolRegistry.dispatch(
            tool.name,
            request.args,
            this.createCreativeContext(request.signal)
          )
          return {
            ok: result.ok,
            content: creativeResultToRuntimeToolResult(result).content,
            metadata: {
              creativeResult: result,
              source: 'magicAgentPlatform',
              platformSource: 'creative',
              originalToolName: tool.name
            },
            ...(result.ok
              ? {}
              : {
                  error: {
                    message:
                      result.error ||
                      result.unavailableReason ||
                      `MagicAgent creative tool failed: ${tool.name}`
                  }
                })
          }
        }
      })
      this.managedKernelCapabilityIds.add(capabilityId)
    }

    this.kernelSurfaceSignature = signature
  }

  private listPlatformCreativeTools(): MagicAgentCreativeToolDefinition[] {
    return this.creativeToolRegistry
      .listTools()
      .filter(
        (tool) =>
          !isMagicAgentPlatformDeniedToolName(tool.name) &&
          !isMagicAgentPlatformDeniedToolName(toKernelCreativeToolName(tool.name)) &&
          !isMagicAgentPlatformDeniedToolName(toKernelCreativeCapabilityId(tool.name))
      )
  }

  private async invokeCreativeToolViaKernel(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    route?: AgentRouteLike,
    metadata?: Record<string, unknown>
  ): Promise<MagicAgentCreativeToolResult> {
    this.syncKernelPlatformSurface()
    if (isMagicAgentPlatformDeniedToolName(name)) {
      return {
        ok: false,
        toolName: name,
        category: 'terminal',
        status: 'unavailable',
        permissionDenied: true,
        error: `Tool "${name}" is not allowed through the MagicAgent platform boundary.`
      }
    }
    const definition = this.listPlatformCreativeTools().find(
      (tool) => normalizeMagicPotToolName(tool.name) === name
    )
    if (!definition) {
      return {
        ok: false,
        toolName: name,
        category: 'asset',
        status: 'unavailable',
        unavailableReason: `Unknown MagicAgent creative tool: ${name}`
      }
    }
    const platformRoute = requirePlatformRoute(route, 'creative tool invocation')
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: platformRoute,
      sessionId: getAgentSessionKey(platformRoute),
      toolName: `creative.${name}`,
      toolInput: args as PolicyJsonRecord
    })
    const session = this.agentKernel.registerSession(platformRoute, { source: 'kernel' })
    const result = await this.agentKernel.invokeAuthorizedTool({
      toolName: toKernelCreativeToolName(name),
      args,
      session,
      signal,
      source: 'kernel',
      capabilityId: toKernelCreativeCapabilityId(name),
      traceLabel:
        cleanString(metadata?.runId) || cleanString(metadata?.traceLabel) || `magicagent:${name}`,
      metadata: {
        ...(metadata || {}),
        source: 'magicAgentPlatform',
        platformSource: 'creative',
        originalToolName: name
      }
    })
    const creativeResult = result.metadata?.creativeResult
    if (isMagicAgentCreativeToolResult(creativeResult)) {
      return creativeResult
    }

    return {
      ok: result.ok,
      toolName: name,
      category: definition?.category || 'asset',
      status: definition?.status || (result.ok ? 'available' : 'unavailable'),
      ...(result.content ? { data: { content: result.content } } : {}),
      ...(result.error?.message ? { error: result.error.message } : {})
    }
  }

  private createCreativeContext(signal?: AbortSignal): MagicAgentCreativeToolContext {
    let config: ReturnType<typeof getConfig> | undefined
    try {
      config = getConfig()
    } catch {
      // Creative v1 adapters treat config as optional. Keep discovery and structured
      // unavailable responses working even when config has not been initialized yet.
    }

    return {
      ...(config ? { config } : {}),
      ...(signal ? { signal } : {}),
      ...(this.creativeToolDependencies ? { dependencies: this.creativeToolDependencies } : {})
    }
  }

  private errorToolResult(
    name: string,
    source: MagicAgentPlatformToolSource,
    error: unknown
  ): MagicAgentPlatformToolCallResp {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      toolName: name,
      source,
      status: isPermissionError(error)
        ? 'permission-denied'
        : /unknown tool|not registered/i.test(message)
          ? 'unavailable'
          : 'failed',
      content: message,
      ...(/unknown tool|not registered/i.test(message) ? { unavailableReason: message } : {}),
      error: message
    }
  }
}

let platformAdapterSingleton: MagicAgentPlatformAdapter | null = null

export const getMagicAgentPlatformAdapter = (): MagicAgentPlatformAdapter => {
  if (!platformAdapterSingleton) {
    platformAdapterSingleton = new MagicAgentPlatformAdapter()
  }
  return platformAdapterSingleton
}
