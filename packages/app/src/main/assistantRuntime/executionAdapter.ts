import { invokeManagedRealChat, isManagedRealChatService } from '../api/svcLLMProxyImpl'
import { withCooperativeOperation } from './cooperativeOperation'
import { invokePreparedManagedTextFirstRun, type PreparedManagedTextFirstRun } from '../llmProxy/managedTextFirstRun'
import { assertManagedTextFirstRunGuard, type ManagedTextFirstRunRuntimeContext } from './managedTextFirstRunRuntime'
import { createProviderRawWorkRetainer } from './providerRawWorkRetention'
import { ManagedRuntimeRecording, type ManagedRuntimeExecution } from '../magicAgentPlatform2/agents/managedRuntimeRecording'
import { captureManagedData } from '../magicAgentPlatform2/agents/managedRuntimeSnapshot'
import { AssistantToolResultError, settleFileEditFailureFeedback } from './toolFailure'
import { ASSISTANT_TOOL_OUTCOME_UNKNOWN, resolveAssistantToolReplayRunId } from './toolRecovery'
import { createHash } from 'node:crypto'
import { ChatAttachment, ChatMessage, LLMChatResp, LLMProxySvc } from '@shared/api/svcLLMProxy'
import {
  createToolInvokeAction,
  createToolResultAction,
  createAbortError,
  isJsonValue,
  JsonObject,
  ToolInvokeAction,
  ToolResultAction
} from '@shared/agent'
import { Config } from '@shared/config/config'
import { AssistantSessionStore } from './sessionStore'
import {
  AssistantArtifactRef,
  AssistantExecutionMode,
  AssistantInboundMessage,
  AssistantRoute,
  AssistantRunEvent,
  AssistantRuntimeResult,
  AssistantTaskState,
  AssistantTaskGroupState,
  getAssistantSessionKey
} from './types'
import {
  AssistantToolCallResult,
  AssistantToolRegistry,
  type AssistantToolCallContext
} from './toolRegistry'
import {
  invokeAssistantToolViaKernel,
  syncAssistantToolsWithAgentKernel
} from '../agentKernel/toolBridge'
import {
  buildAssistantReusableContextPrompt,
  readAssistantReusableContextPackFromFiles
} from './workspace'
import { assertAssistantToolAllowed, filterAssistantToolsByAllowlist } from './toolAccess'

type AssistantExecutionAdapterDeps = {
  chatService: Pick<LLMProxySvc, 'chat'>
  toolRegistry?: AssistantToolRegistry
  onAgentAction?: (action: ToolInvokeAction | ToolResultAction) => void | Promise<void>
  managedRecording?: ManagedRuntimeRecording
  managedRuntime?: object
  /** Constructor policy from the private bounded runtime, not inbound JSON. */
  managedTextFirstRun?: true
}

export type AssistantToolActionDescriptor = {
  runId: string
  toolCallIndex: number
  toolName: string
  args: Record<string, unknown>
  requestedAt: number
  toolCallId?: string
}

type AssistantToolExecutionContext = Omit<
  AssistantExecutionRequest,
  'messages' | 'req' | 'runId' | 'profileId' | 'systemPrompt' | 'cooperativeExecution'
> & {
  cooperativeExecution?: AssistantExecutionRequest['cooperativeExecution']
  runId?: string
  toolCallId?: string
}

export type AssistantExecutionRequest = {
  runId: string
  route: AssistantRoute
  req: AssistantInboundMessage
  config: Config
  messages: Array<{
    role: ChatMessage['role']
    content: string
    attachments?: ChatAttachment[]
    ocrResult?: ChatMessage['ocrResult']
  }>
  profileId?: string
  systemPrompt?: string
  maxOutputTokens?: number
  temperature?: number
  executionMode?: AssistantExecutionMode
  executionHistorySize?: number
  executionTraceLabel?: string
  maxToolCalls?: number
  sessionStore: AssistantSessionStore
  taskState: AssistantTaskState
  workspaceMemoryFile?: string
  workspaceTaskContextFile?: string
  workspaceContextFile?: string
  workspacePinnedContextFile?: string
  workspaceMetaFile?: string
  workspaceRootDir?: string
  readExternalFile?: AssistantToolCallContext['readExternalFile']
  toolProvider?: AssistantInboundMessage['toolProvider']
  resumeRun?: (
    route: AssistantRoute,
    runId: string,
    options?: { async?: boolean }
  ) => Promise<AssistantRuntimeResult>
  resumeWorkflow?: (
    workflowId: string,
    route?: AssistantRoute,
    options?: { async?: boolean }
  ) => Promise<AssistantRuntimeResult>
  startTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      title?: string
      description?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  progressTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      label?: string
      completed?: number
      total?: number
      percent?: number
      title?: string
      description?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  approveTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      approvedBy?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  exportTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      exportTarget?: string
      exportArtifactIds?: string[]
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  cancelTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  resumeTaskGroup?: (
    route: AssistantRoute,
    taskGroupId: string,
    options?: { async?: boolean }
  ) => Promise<AssistantRuntimeResult>
  signal?: AbortSignal
  cooperativeExecution?: AssistantInboundMessage['cooperativeExecution']
  emitEvent?: (
    event: Pick<AssistantRunEvent, 'type' | 'level' | 'message' | 'metadata'>
  ) => Promise<void>
}

export type AssistantExecutionResult = {
  reply: {
    content: string
    imageUrl?: string
    sessionUrl?: string
    attachments?: ChatAttachment[]
    ocrResult?: LLMChatResp['ocrResult']
  }
  artifacts: AssistantArtifactRef[]
  events: AssistantRunEvent[]
  toolCalls: Array<{
    toolName: string
    args?: Record<string, unknown>
  }>
  executionMode?: AssistantExecutionMode
  executionHistorySize?: number
  executionTraceLabel?: string
}

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

type ToolInvocationState = {
  started: boolean
  settled: boolean
  outcomeUnknown: boolean
}

// Keep the caller responsive, but do not confuse this race with the independently
// retained invocation promise. Only this race's exact cancellation error can mark
// an invocation unknown; an aborted signal alone must not relabel another error.
const withToolAbort = async <T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  invocation: ToolInvocationState
): Promise<T> => {
  if (!signal || invocation.settled) return promise
  if (signal.aborted) {
    promise.catch(() => undefined)
    invocation.outcomeUnknown = invocation.started && !invocation.settled
    throw createAbortError(signal.reason)
  }

  let onAbort: (() => void) | undefined
  let cancellation: { error: Error; invocationPending: boolean } | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      if (cancellation) return
      cancellation = {
        error: createAbortError(signal.reason),
        invocationPending: invocation.started && !invocation.settled
      }
      reject(cancellation.error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([promise, aborted])
  } catch (error) {
    if (cancellation && cancellation.error === error && cancellation.invocationPending) {
      invocation.outcomeUnknown = true
    }
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort!)
    promise.catch(() => undefined)
  }
}

type RetainToolInvocation = (startOwner: () => Promise<void>) => void

const guessMimeTypeFromUrl = (url: string, fallback = 'application/octet-stream'): string => {
  const normalized = url.toLowerCase()
  if (normalized.includes('.png')) return 'image/png'
  if (normalized.includes('.jpg') || normalized.includes('.jpeg')) return 'image/jpeg'
  if (normalized.includes('.gif')) return 'image/gif'
  if (normalized.includes('.webp')) return 'image/webp'
  if (normalized.includes('.mp4')) return 'video/mp4'
  if (normalized.includes('.webm')) return 'video/webm'
  if (normalized.includes('.pdf')) return 'application/pdf'
  if (normalized.includes('.csv')) return 'text/csv'
  if (normalized.includes('.json')) return 'application/json'
  return fallback
}

const getFileNameFromUrl = (url: string, fallback: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || fallback)
  } catch {
    return fallback
  }
}

const buildExecutionMetadata = (
  request: Pick<
    AssistantExecutionRequest,
    'executionMode' | 'executionHistorySize' | 'executionTraceLabel'
  >
): Record<string, unknown> => ({
  ...(request.executionMode ? { executionMode: request.executionMode } : {}),
  ...(Number.isFinite(request.executionHistorySize)
    ? { executionHistorySize: request.executionHistorySize }
    : {}),
  ...(request.executionTraceLabel ? { executionTraceLabel: request.executionTraceLabel } : {})
})

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const asJsonObject = (value: unknown, label: string): JsonObject => {
  if (!isJsonValue(value) || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`)
  }
  return value as JsonObject
}

export const buildAssistantToolInvokeAction = (options: {
  runId: string
  toolCallId?: string
  toolCallIndex: number
  toolName: string
  args: Record<string, unknown>
  requestedAt?: number
}): ToolInvokeAction => {
  const toolName = cleanString(options.toolName)
  if (!toolName) throw new TypeError('Tool name is required.')
  const args = asJsonObject(options.args, 'Tool invocation args')
  const digest = createHash('sha256')
    .update(
      `${options.runId}\n${options.toolCallId || options.toolCallIndex}\n${toolName}\n${canonicalJson(args)}`
    )
    .digest('hex')
  const invocationId = `${options.runId}:tool:${options.toolCallIndex}:${digest.slice(0, 24)}`
  const toolCallId = cleanString(options.toolCallId)?.slice(0, 200)
  return createToolInvokeAction({
    actionId: invocationId,
    correlationId: options.runId,
    payload: {
      invocationId,
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      args,
      requestedAt: options.requestedAt ?? Date.now(),
      idempotencyKey: invocationId
    }
  })
}

export const validateAssistantToolInvokeAction = (
  action: ToolInvokeAction,
  descriptor: AssistantToolActionDescriptor
): void => {
  const expected = buildAssistantToolInvokeAction(descriptor)
  if (canonicalJson(action) !== canonicalJson(expected)) {
    throw new TypeError('Tool invocation action does not match its trusted descriptor.')
  }
}

const toSafeError = (error: unknown): { message: string; code?: string } => ({
  message: error instanceof Error ? error.message : 'Tool invocation failed.',
  ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? { code: error.code }
    : {})
})

const toJsonMetadata = (metadata: Record<string, unknown> | undefined): JsonObject | undefined => {
  if (metadata === undefined) return undefined
  try {
    const serialized = JSON.stringify(metadata)
    if (serialized === undefined) return undefined
    const parsed: unknown = JSON.parse(serialized)
    return isJsonValue(parsed) && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined
  } catch {
    return undefined
  }
}

const parseToolInvocation = (
  text?: string
): { toolName: string; args: Record<string, unknown> } | null => {
  const normalized = cleanString(text)
  if (!normalized) return null

  const match = normalized.match(/^\/tool\s+([a-z0-9._-]+)(?:\s+(.+))?$/i)
  if (!match) return null

  const toolName = cleanString(match[1])
  const argsPayload = cleanString(match[2])

  if (!toolName) return null

  if (!argsPayload) {
    return { toolName, args: {} }
  }

  try {
    return {
      toolName,
      args: JSON.parse(argsPayload) as Record<string, unknown>
    }
  } catch {
    return {
      toolName,
      args: { input: argsPayload }
    }
  }
}

const toArtifactRef = (
  runId: string,
  attachment: ChatAttachment,
  createdAt: number,
  executionMetadata?: Pick<AssistantExecutionRequest, 'executionMode' | 'executionTraceLabel'>
): AssistantArtifactRef => ({
  artifactId: crypto.randomUUID(),
  runId,
  kind: attachment.type,
  url: attachment.url,
  mimeType: attachment.mimeType || guessMimeTypeFromUrl(attachment.url),
  fileName:
    attachment.fileName ||
    getFileNameFromUrl(attachment.url, attachment.type === 'image' ? 'image.png' : 'attachment'),
  sizeBytes: attachment.sizeBytes,
  createdAt,
  source: 'reply',
  traceId: runId,
  ...(executionMetadata?.executionMode ? { executionMode: executionMetadata.executionMode } : {}),
  originatingRunId: runId,
  ...(executionMetadata?.executionTraceLabel
    ? { executionTraceLabel: executionMetadata.executionTraceLabel }
    : {})
})

// Shared across adapters in this process; the journal remains authoritative after restart.
const inFlightToolIdentities = new WeakMap<AssistantSessionStore, Set<string>>()
const replayConflict = () =>
  Object.assign(
    new Error('The recorded tool identity does not match this request; review it before retrying.'),
    { code: 'TOOL_REPLAY_CONFLICT' }
  )

export class AssistantExecutionAdapter {
  private readonly chatService: Pick<LLMProxySvc, 'chat'>
  private readonly toolRegistry: AssistantToolRegistry
  private readonly onAgentAction: NonNullable<AssistantExecutionAdapterDeps['onAgentAction']>
  readonly #managedRecording?: ManagedRuntimeRecording
  readonly #managedRuntime?: object
  readonly #managedTextFirstRun: boolean

  #assertManaged(managed?: ManagedRuntimeExecution): void {
    if (this.#managedTextFirstRun) throw Error('Managed text first run requires its prepared executor; ordinary dispatch is unavailable.')
    if (!managed && !this.#managedRecording) return
    if (!managed || managed.coordinator !== this.#managedRecording || managed.runtime !== this.#managedRuntime)
      throw new Error('Managed adapter requires its exact private runtime lease.')
    managed.coordinator.assertBound(managed.runtime, managed.lease)
  }

  constructor(deps: AssistantExecutionAdapterDeps) {
    if (isManagedRealChatService(deps.chatService) && !deps.managedRecording && !deps.managedTextFirstRun) throw Error('Managed real-chat adapter requires concrete recording.')
    if (deps.managedTextFirstRun && (!isManagedRealChatService(deps.chatService) || deps.managedRecording || deps.toolRegistry || deps.onAgentAction)) throw Error('Managed text first-run adapter requires its exact bounded service, no tools or callbacks.')
    this.#managedTextFirstRun = deps.managedTextFirstRun === true
    this.chatService = deps.chatService
    this.toolRegistry = this.#managedTextFirstRun ? AssistantToolRegistry.createManagedTextFirstRunRegistry() : deps.toolRegistry || new AssistantToolRegistry()
    this.onAgentAction = deps.onAgentAction || (() => undefined)
    this.#managedRecording = deps.managedRecording
    this.#managedRuntime = deps.managedRuntime
  }

  /** Exact prepared one-envelope service path. It never enters ordinary run(),
   * context preparation, catalogs, tool callbacks or helper parsing. */
  async runPreparedManagedTextFirstRun(
    model: PreparedManagedTextFirstRun,
    context: ManagedTextFirstRunRuntimeContext,
    parent: AssistantExecutionRequest['cooperativeExecution'],
    signal: AbortSignal
  ): Promise<LLMChatResp> {
    if (!this.#managedTextFirstRun) throw Error('Adapter is not a prepared managed text executor.')
    const check = () => { assertManagedTextFirstRunGuard(context.assertDispatchCurrent); signal.throwIfAborted() }
    check()
    return withCooperativeOperation(parent, 'llm-inference', signal, async children => {
      check()
      return invokePreparedManagedTextFirstRun(this.chatService, model.plan, { signal, runId: context.runId }, {
        assertCurrent: check,
        retainRawWork: createProviderRawWorkRetainer(children, signal, check)
      })
    })
  }

  listTools(
    allowedToolNames?: string[] | null,
    toolProvider?: AssistantInboundMessage['toolProvider']
  ) {
    if (this.#managedTextFirstRun) throw Error('Managed text first run does not expose an ordinary tool catalog.')
    syncAssistantToolsWithAgentKernel(this.toolRegistry)
    const seen = new Set<string>()
    const tools = [...this.toolRegistry.listTools(), ...(toolProvider?.listTools() || [])].filter(
      (tool) => {
        const name = tool.name.trim().toLowerCase()
        if (seen.has(name)) return false
        seen.add(name)
        return true
      }
    )
    return filterAssistantToolsByAllowlist(tools, allowedToolNames)
  }

  /** Persist intent before executing and outcome before reporting completion. */
  private async recordToolAction(
    request: AssistantToolExecutionContext,
    action: ToolInvokeAction | ToolResultAction
  ): Promise<void> {
    if (typeof request.sessionStore?.appendEvents !== 'function') return
    await request.sessionStore.appendEvents(request.route, [
      {
        eventId: action.actionId,
        runId: action.correlationId || request.runId || action.actionId,
        sessionKey: getAssistantSessionKey(request.route),
        route: request.route,
        type: 'tool',
        level: action.type === 'tool.result' && !action.payload.ok ? 'error' : 'info',
        message:
          action.type === 'tool.invoke'
            ? `Tool requested: ${action.payload.toolName}`
            : `Tool finished: ${action.payload.toolName}`,
        createdAt: Date.now(),
        metadata: { agentAction: action }
      }
    ])
  }

  private async readSettledToolAction(
    request: AssistantToolExecutionContext,
    requestedAction: ToolInvokeAction,
    descriptor: AssistantToolActionDescriptor,
    allowedToolNames?: string[] | null
  ): Promise<ToolResultAction | undefined> {
    if (typeof request.sessionStore?.getSession === 'function') {
      const stored = await request.sessionStore.getSession(request.route)
      const actions = (stored?.eventLog || [])
        .map((event) => event.metadata?.agentAction)
        .filter(
          (value): value is ToolInvokeAction | ToolResultAction =>
            value !== null &&
            typeof value === 'object' &&
            'type' in value &&
            (value.type === 'tool.invoke' || value.type === 'tool.result') &&
            'payload' in value &&
            Boolean(value.payload) &&
            typeof value.payload === 'object'
        )
      const sameIdentity = actions.filter(
        (action) =>
          action.correlationId === requestedAction.correlationId &&
          (requestedAction.payload.toolCallId
            ? action.payload.toolCallId === requestedAction.payload.toolCallId
            : typeof action.payload.invocationId === 'string' &&
              action.payload.invocationId.startsWith(
                `${descriptor.runId}:tool:${descriptor.toolCallIndex}:`
              ))
      )
      // Changed arguments on resume are a conflict, not a new authorization to write.
      if (
        sameIdentity.some(
          (action) =>
            action.payload.invocationId !== requestedAction.payload.invocationId ||
            action.payload.toolName !== requestedAction.payload.toolName ||
            (action.type === 'tool.invoke' &&
              canonicalJson(action.payload.args) !== canonicalJson(requestedAction.payload.args))
        )
      )
        throw replayConflict()
      const previousResult = actions.find(
        (action) =>
          action.type === 'tool.result' &&
          action.payload.invocationId === requestedAction.payload.invocationId
      ) as ToolResultAction | undefined
      if (previousResult) {
        if (
          previousResult.correlationId !== requestedAction.correlationId ||
          previousResult.payload.toolName !== requestedAction.payload.toolName ||
          previousResult.payload.toolCallId !== requestedAction.payload.toolCallId ||
          typeof previousResult.payload.ok !== 'boolean' ||
          !sameIdentity.some((action) => action.type === 'tool.invoke')
        )
          throw replayConflict()
        assertAssistantToolAllowed(requestedAction.payload.toolName, allowedToolNames)
        if (previousResult.payload.error?.code === ASSISTANT_TOOL_OUTCOME_UNKNOWN) {
          throw Object.assign(
            new Error('The interrupted tool outcome is unknown; review its effects before retrying.'),
            { code: 'TOOL_REPLAY_REQUIRES_REVIEW' }
          )
        }
        if (!previousResult.payload.ok) {
          const failure = { message: previousResult.payload.error?.message || 'The previous tool execution failed.', code: 'TOOL_EXECUTION_ALREADY_SETTLED' }
          if (previousResult.payload.content !== undefined || previousResult.payload.metadata !== undefined)
            throw new AssistantToolResultError(failure, { content: previousResult.payload.content ?? '', metadata: previousResult.payload.metadata })
          throw Object.assign(new Error(failure.message), { code: failure.code })
        }
        return previousResult
      }
      if (
        actions.some(
          (action) =>
            action.type === 'tool.invoke' &&
            action.payload.invocationId === requestedAction.payload.invocationId
        )
      ) {
        throw Object.assign(
          new Error(
            'Tool execution outcome is unknown after interruption; review it before retrying.'
          ),
          { code: 'TOOL_REPLAY_REQUIRES_REVIEW' }
        )
      }
    }
    return undefined
  }

  async executeToolInvokeAction(
    action: ToolInvokeAction,
    descriptor: AssistantToolActionDescriptor,
    request: AssistantToolExecutionContext,
    allowedToolNames?: string[] | null,
    managed?: ManagedRuntimeExecution
  ): Promise<{ action: ToolResultAction; result: AssistantToolCallResult }> {
    this.#assertManaged(managed)
    if (managed) { action = captureManagedData(action); descriptor = captureManagedData(descriptor) }
    return withCooperativeOperation(
      request.cooperativeExecution,
      'tool-invocation',
      request.signal,
      async children => {
        // Omit is compile-time only: a full execution request may carry req and
        // its parent gate at runtime. Do not retain it in the tool-only context.
        const context: AssistantToolExecutionContext & { req?: unknown } = {
          ...request,
          cooperativeExecution: children
        }
        delete context.req
        return this.executeAdmittedToolInvokeAction(
          action, descriptor, Object.freeze(context), allowedToolNames, managed
        )
      }
    )
  }

  private async executeAdmittedToolInvokeAction(
    action: ToolInvokeAction,
    descriptor: AssistantToolActionDescriptor,
    request: AssistantToolExecutionContext,
    allowedToolNames?: string[] | null,
    managed?: ManagedRuntimeExecution
  ): Promise<{ action: ToolResultAction; result: AssistantToolCallResult }> {
    validateAssistantToolInvokeAction(action, descriptor)
    const identity = JSON.stringify([
      getAssistantSessionKey(request.route),
      descriptor.runId,
      action.payload.toolCallId ?? descriptor.toolCallIndex
    ])
    let active = inFlightToolIdentities.get(request.sessionStore)
    if (!active) {
      active = new Set<string>()
      inFlightToolIdentities.set(request.sessionStore, active)
    }
    if (active.has(identity))
      throw Object.assign(
        new Error('This tool invocation is already in progress; it was not started again.'),
        { code: 'TOOL_INVOCATION_IN_PROGRESS' }
      )
    active.add(identity)
    const claimed = active
    let callerSettled = false
    let invocationOwners = 0
    const releaseIfDrained = (): void => {
      if (!callerSettled || invocationOwners !== 0) return
      claimed.delete(identity)
      if (!claimed.size && inFlightToolIdentities.get(request.sessionStore) === claimed) {
        inFlightToolIdentities.delete(request.sessionStore)
      }
    }
    const retainInvocation: RetainToolInvocation = startOwner => {
      // Publish the retained owner before a provider/gate can synchronously abort
      // or re-enter. Its completion is separate from caller/journal completion.
      invocationOwners++
      const settled = (): void => { invocationOwners--; releaseIfDrained() }
      let owner: Promise<void>
      try { owner = startOwner() } catch (error) { settled(); throw error }
      void owner.then(settled, settled)
    }
    try {
      return await this.executeClaimedToolInvokeAction(
        action,
        descriptor,
        request,
        retainInvocation,
        allowedToolNames,
        managed
      )
    } finally {
      callerSettled = true
      releaseIfDrained()
    }
  }

  private async executeClaimedToolInvokeAction(
    action: ToolInvokeAction,
    descriptor: AssistantToolActionDescriptor,
    request: AssistantToolExecutionContext,
    retainInvocation: RetainToolInvocation,
    allowedToolNames?: string[] | null,
    managed?: ManagedRuntimeExecution
  ): Promise<{ action: ToolResultAction; result: AssistantToolCallResult }> {
    // Mandatory ledger intent normally returns before the optional session journal,
    // observer, provider catalog or any dispatch. Managed replay never short-cuts
    // this through bounded session history.
    const managedTool = managed?.coordinator.prepareTool(managed.runtime, managed.lease, {
      invocationId: action.payload.invocationId, runtimeRunId: descriptor.runId,
      toolName: action.payload.toolName, args: action.payload.args, route: request.route,
      ...(descriptor.toolCallId === undefined ? {} : { toolCallId: descriptor.toolCallId })
    })
    const settledAction = managed ? undefined : await this.readSettledToolAction(
      request,
      action,
      descriptor,
      allowedToolNames
    )
    if (settledAction) {
      return {
        action: settledAction,
        result: {
          content: settledAction.payload.content || '',
          metadata: settledAction.payload.metadata
        }
      }
    }
    const toolName = action.payload.toolName
    const args = action.payload.args
    // Keep ordinary observer ordering and its dispatch-start timestamp unchanged.
    if (!managed) { await this.recordToolAction(request, action); await this.onAgentAction(action) }
    const startedAt = Date.now()
    const invocation: ToolInvocationState = { started: false, settled: false, outcomeUnknown: false }
    let executionCompleted = false
    let outcomeAttempted = false
    let builtInFileEdit = false
    const publishManagedOutcome = (receipt: Parameters<ManagedRuntimeRecording['completeTool']>[3]): 'reported-result' | 'unknown' => {
      outcomeAttempted = true
      return managed!.coordinator.completeTool(managed!.runtime, managed!.lease, managedTool!, receipt)
    }
    try {
      if (managed) { await this.recordToolAction(request, action); await this.onAgentAction(action); this.#assertManaged(managed) }
      assertAssistantToolAllowed(toolName, allowedToolNames)
      request.signal?.throwIfAborted()
      const provider = request.toolProvider
      const usesProvider =
        provider?.listTools().some((tool) => tool.name === toolName) &&
        !this.toolRegistry.listTools().some((tool) => tool.name === toolName)
      builtInFileEdit = !managed && !usesProvider && toolName === 'files.edit'
      let resolveInvocation!: (result: AssistantToolCallResult) => void
      let rejectInvocation!: (error: unknown) => void
      const invocationResult = new Promise<AssistantToolCallResult>((resolve, reject) => {
        resolveInvocation = resolve
        rejectInvocation = reject
      })
      retainInvocation(() => {
        // This exact child is registered before dispatch, while the outer tool
        // callback is live. It can outlast the cancelled caller, but never starts
        // from a stale scope or inherits an unrelated root. No gate reaches tool
        // arguments/provider context. Only the promise returned HERE is retained:
        // nested SDK/host timeout wrappers still require their own drainage proof.
        const owner = withCooperativeOperation(
          request.cooperativeExecution,
          'tool-invocation',
          request.signal,
          async () => {
            try {
              request.signal?.throwIfAborted()
              if (managed) managed.coordinator.startTool(managed.runtime, managed.lease, managedTool!)
              invocation.started = true
              const value = await (usesProvider
                ? provider!.callTool(toolName, args, {
                    route: request.route,
                    runId: descriptor.runId,
                    toolCallId: descriptor.toolCallId,
                    signal: request.signal,
                    workspaceRootDir: request.workspaceRootDir
                  })
                : invokeAssistantToolViaKernel({
                    toolRegistry: this.toolRegistry,
                    toolName,
                    args,
                    signal: request.signal,
                    context: {
                      config: request.config,
                      route: request.route,
                      sessionStore: request.sessionStore,
                      taskState: request.taskState,
                      workspaceMemoryFile: request.workspaceMemoryFile,
                      workspaceTaskContextFile: request.workspaceTaskContextFile,
                      workspaceContextFile: request.workspaceContextFile,
                      workspacePinnedContextFile: request.workspacePinnedContextFile,
                      workspaceMetaFile: request.workspaceMetaFile,
                      workspaceRootDir: request.workspaceRootDir,
                      readExternalFile: request.readExternalFile,
                      resumeRun: request.resumeRun,
                      resumeWorkflow: request.resumeWorkflow,
                      startTaskGroup: request.startTaskGroup,
                      progressTaskGroup: request.progressTaskGroup,
                      approveTaskGroup: request.approveTaskGroup,
                      exportTaskGroup: request.exportTaskGroup,
                      cancelTaskGroup: request.cancelTaskGroup,
                      resumeTaskGroup: request.resumeTaskGroup
                    }
                  }))
              invocation.settled = true
              resolveInvocation(value)
            } catch (error) {
              invocation.settled = true
              rejectInvocation(error)
            }
          }
        )
        // Admission may itself reject without invoking the callback. Both this
        // path and a late invocation rejection remain observed after cancellation.
        void owner.catch(rejectInvocation)
        return owner
      })
      const rawResult = await withToolAbort(invocationResult, request.signal, invocation)
      const result = managed ? captureManagedData(rawResult) : rawResult
      if (managed && publishManagedOutcome({ started: invocation.started, failed: false, value: result }) === 'unknown')
        throw Object.assign(new Error('Managed tool execution outcome unknown; review required.'), { code: ASSISTANT_TOOL_OUTCOME_UNKNOWN })
      const finishedAt = Date.now()
      const resultAction = createToolResultAction({
        actionId: `${action.actionId}:result`,
        correlationId: action.correlationId,
        payload: {
          invocationId: action.payload.invocationId,
          ...(action.payload.toolCallId ? { toolCallId: action.payload.toolCallId } : {}),
          toolName,
          ok: true,
          content: result.content,
          metadata: toJsonMetadata(result.metadata),
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt)
        }
      })
      executionCompleted = true
      // Terminal observer failure is surfaced, but tool execution is never retried.
      await this.recordToolAction(request, resultAction)
      await this.onAgentAction(resultAction)
      return { action: resultAction, result }
    } catch (error) {
      // A durable publication exception (including after COMMIT) is not another
      // tool error. Never swallow it, retry or publish a second outcome.
      if (executionCompleted || outcomeAttempted) throw error
      const failureResult = error instanceof AssistantToolResultError ? error.toolResult : undefined
      const managedOutcome = managed
        ? publishManagedOutcome({ started: invocation.started, failed: true, error: toSafeError(error) })
        : undefined
      const finishedAt = Date.now()
      const resultAction = createToolResultAction({
        actionId: `${action.actionId}:result`,
        correlationId: action.correlationId,
        payload: {
          invocationId: action.payload.invocationId,
          ...(action.payload.toolCallId ? { toolCallId: action.payload.toolCallId } : {}),
          toolName,
          ok: false,
          ...(failureResult ? { content: failureResult.content, metadata: toJsonMetadata(failureResult.metadata) } : {}),
          // The durable managed classification must also block journal-based
          // recovery. Ordinary callers keep their exact cancellation semantics.
          error: invocation.outcomeUnknown || managedOutcome === 'unknown'
            ? { ...toSafeError(error), code: ASSISTANT_TOOL_OUTCOME_UNKNOWN }
            : toSafeError(error),
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt)
        }
      })
      try {
        await this.recordToolAction(request, resultAction)
        await this.onAgentAction(resultAction)
        if (builtInFileEdit && invocation.settled && !invocation.outcomeUnknown && !request.signal?.aborted &&
            typeof request.sessionStore?.appendEvents === 'function' && action.payload.toolCallId)
          settleFileEditFailureFeedback(error, { routeKey: getAssistantSessionKey(request.route), runId: descriptor.runId, toolCallId: action.payload.toolCallId })
      } catch {
        // Preserve the original execution or authorization failure.
      }
      throw error
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    request: Omit<
      AssistantExecutionRequest,
      'messages' | 'req' | 'runId' | 'profileId' | 'systemPrompt'
    >,
    options?: {
      allowedToolNames?: string[] | null
      signal?: AbortSignal
      runId?: string
      toolCallId?: string
    },
    managed?: ManagedRuntimeExecution
  ): Promise<AssistantToolCallResult> {
    this.#assertManaged(managed)
    if (managed) args = captureManagedData(args)
    const descriptor: AssistantToolActionDescriptor = {
      runId: cleanString(options?.runId) || `call-tool:${crypto.randomUUID()}`,
      ...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
      toolCallIndex: 0,
      toolName: name,
      args,
      requestedAt: Date.now()
    }
    const invokeAction = buildAssistantToolInvokeAction(descriptor)
    const execution = await this.executeToolInvokeAction(
      invokeAction,
      descriptor,
      { ...request, signal: options?.signal ?? request.signal },
      options?.allowedToolNames,
      managed
    )
    return execution.result
  }
  async run(request: AssistantExecutionRequest, managed?: ManagedRuntimeExecution): Promise<AssistantExecutionResult> {
    this.#assertManaged(managed)
    const executionRunId = request.req.resumeFromRunId
      ? await resolveAssistantToolReplayRunId(request.req.resumeFromRunId, request.route, (id) =>
          request.sessionStore.getRun(id)
        )
      : request.runId
    const startedAt = Date.now()
    const executionMetadata = buildExecutionMetadata(request)
    const toolInvocation = parseToolInvocation(request.req.text)
    if (toolInvocation) {
      if (request.maxToolCalls !== undefined && request.maxToolCalls < 1)
        throw new Error('Assistant tool-call budget exhausted.')
      const toolAction = buildAssistantToolInvokeAction({
        runId: executionRunId,
        toolCallId: `${executionRunId}:tool:0`,
        toolCallIndex: 0,
        toolName: toolInvocation.toolName,
        args: toolInvocation.args,
        requestedAt: startedAt
      })
      await request.emitEvent?.({
        type: 'progress',
        level: 'info',
        message: `Running tool: ${toolInvocation.toolName}`,
        metadata: {
          ...executionMetadata,
          toolName: toolInvocation.toolName,
          actionId: toolAction.actionId,
          invocationId: toolAction.payload.invocationId,
          requestKind: 'tool-invocation'
        }
      })
      const toolExecution = await this.executeToolInvokeAction(
        toolAction,
        {
          runId: executionRunId,
          toolCallId: `${executionRunId}:tool:0`,
          toolCallIndex: 0,
          toolName: toolInvocation.toolName,
          args: toolInvocation.args,
          requestedAt: startedAt
        },
        request,
        request.req.execution?.allowedToolNames,
        managed
      )
      const toolResult = toolExecution.action

      return {
        reply: {
          content: toolResult.payload.content || ''
        },
        artifacts: [],
        toolCalls: [
          {
            toolName: toolInvocation.toolName,
            args: toolInvocation.args
          }
        ],
        events: [
          {
            eventId: crypto.randomUUID(),
            runId: request.runId,
            sessionKey: getAssistantSessionKey(request.route),
            route: request.route,
            type: 'tool',
            level: 'info',
            message: `Tool executed: ${toolInvocation.toolName}`,
            createdAt: startedAt,
            metadata: {
              ...executionMetadata,
              ...(toolResult.payload.metadata || {}),
              toolName: toolInvocation.toolName,
              actionId: toolAction.actionId,
              invocationId: toolAction.payload.invocationId,
              toolResultOk: toolResult.payload.ok,
              requestKind: 'tool-invocation'
            }
          }
        ],
        ...(request.executionMode ? { executionMode: request.executionMode } : {}),
        ...(Number.isFinite(request.executionHistorySize)
          ? { executionHistorySize: request.executionHistorySize }
          : {}),
        ...(request.executionTraceLabel ? { executionTraceLabel: request.executionTraceLabel } : {})
      }
    }

    await request.emitEvent?.({
      type: 'progress',
      level: 'info',
      message: 'Waiting for LLM response.',
      metadata: {
        ...executionMetadata,
        requestKind: 'llm-response'
      }
    })
    const reusableContextPack = await readAssistantReusableContextPackFromFiles({
      contextFile: request.workspaceContextFile,
      taskContextFile: request.workspaceTaskContextFile,
      pinnedContextFile: request.workspacePinnedContextFile,
      memoryFile: request.workspaceMemoryFile,
      workspaceMetaFile: request.workspaceMetaFile
    })
    const reusableContextPrompt = buildAssistantReusableContextPrompt(reusableContextPack)
    const systemPrompt = [request.systemPrompt, reusableContextPrompt].filter(Boolean).join('\n\n')
    const executionPolicy = request.req.execution ?? {}
    // Every route-scoped assistant turn gets the two read-only web tools by
    // default. An explicit allowlist (including []) remains authoritative and
    // is never widened, so existing restricted agents keep their exact policy.
    const defaultWebToolNames = ['web_search', 'web_fetch']
    const requestedAllowedToolNames = executionPolicy?.allowedToolNames
    // Keep the model-visible catalog and execution boundary identical. If no
    // policy is supplied, passing `undefined` to callTool would otherwise
    // permit every registered tool despite exposing only web tools above.
    const effectiveAllowedToolNames =
      requestedAllowedToolNames === undefined
        ? defaultWebToolNames
        : requestedAllowedToolNames === null
          ? []
          : requestedAllowedToolNames
    const skillRuntime =
      requestedAllowedToolNames === undefined
        ? {
            execution: {
              ...(executionPolicy?.mode
                ? {
                    mode:
                      executionPolicy.mode === 'no-history'
                        ? ('isolated' as const)
                        : ('inherit' as const)
                  }
                : {}),
              ...(executionPolicy?.allowHistory === undefined
                ? {}
                : { allowHistory: executionPolicy.allowHistory }),
              ...(executionPolicy?.contextMessageLimit === undefined
                ? {}
                : { contextMessageLimit: executionPolicy.contextMessageLimit })
            },
            bindings: [
              {
                appId: 'assistant-runtime',
                source: 'assistant-runtime',
                toolNames: defaultWebToolNames
              }
            ]
          }
        : {
            execution: {
              ...(executionPolicy?.mode
                ? {
                    mode:
                      executionPolicy.mode === 'no-history'
                        ? ('isolated' as const)
                        : ('inherit' as const)
                  }
                : {}),
              ...(executionPolicy?.allowHistory === undefined
                ? {}
                : { allowHistory: executionPolicy.allowHistory }),
              ...(executionPolicy?.contextMessageLimit === undefined
                ? {}
                : { contextMessageLimit: executionPolicy.contextMessageLimit })
            },
            bindings: [
              {
                appId: 'assistant-runtime',
                source: 'assistant-runtime',
                toolNames: this.listTools(effectiveAllowedToolNames, request.toolProvider).map(
                  (tool) => tool.name
                )
              }
            ]
          }

    const reply = await withCooperativeOperation(
      request.cooperativeExecution,
      'llm-inference',
      request.signal,
      async children => {
        this.#assertManaged(managed)
        // One immutable gate binding per chat invocation. A captured executeTool
        // must never recover the live turn/root through either request path.
        const childRequest = Object.freeze({
          ...request,
          req: Object.freeze({ ...request.req, cooperativeExecution: children }),
          cooperativeExecution: children
        })
        const managedRealChat = isManagedRealChatService(this.chatService)
        const chatOptions = {
          ...(request.toolProvider || managedRealChat
            ? {
                additionalToolDefinitions: this.listTools(
                  effectiveAllowedToolNames,
                  request.toolProvider
                )
              }
            : {}),
          signal: request.signal,
          runId: executionRunId,
          executeTool: (invocation: {
            toolName: string
            args: Record<string, unknown>
            runId: string
            toolCallId: string
            signal?: AbortSignal
          }) => {
            // This callback belongs to this exact chat, so its local signal may
            // narrow but must not replace the chat's cancellation after dispatch.
            // Standalone callTool keeps its existing explicit override semantics.
            const signal = childRequest.signal && invocation.signal &&
              childRequest.signal !== invocation.signal
              ? AbortSignal.any([childRequest.signal, invocation.signal])
              : invocation.signal ?? childRequest.signal
            return this.callTool(invocation.toolName, invocation.args, childRequest, {
              allowedToolNames: effectiveAllowedToolNames,
              signal,
              runId: invocation.runId,
              toolCallId: invocation.toolCallId
            }, managed)
          }
        }
        // Catalog callbacks may revoke the owner/epoch. Check again immediately
        // before the actual scripted chat dispatch, not only before catalog reads.
        this.#assertManaged(managed)
        if (managedRealChat) {
          if (!managed) throw Error('Managed real-chat requires exact executor binding.')
          return invokeManagedRealChat(this.chatService, {
            messages: request.messages,
            route: request.route,
            skillRuntime: { bindings: skillRuntime.bindings },
            ...(request.profileId ? { profileId: request.profileId } : {}),
            ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(systemPrompt ? { systemPrompt } : {})
          }, chatOptions, {
            config: request.config,
            assertCurrent: () => this.#assertManaged(managed),
            retainRawWork: createProviderRawWorkRetainer(children, request.signal, () => this.#assertManaged(managed))
          })
        }
        return this.chatService.chat(
          {
            messages: request.messages,
            imageHistoryPolicy: 'all',
            route: request.route,
            ...(skillRuntime ? { skillRuntime } : {}),
            ...(request.profileId ? { profileId: request.profileId } : {}),
            ...(request.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: request.maxOutputTokens }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(systemPrompt ? { systemPrompt } : {})
          },
          chatOptions
        )
      }
    )
    // A scripted chat may catch executeTool failures. It cannot turn a locally
    // blocked/unknown recording lease into a successful runtime result.
    managed?.coordinator.assertReturned(managed.runtime, managed.lease)

    const createdAt = Date.now()
    const attachments = [...(reply.attachments || [])]
    if (reply.imageUrl && !attachments.some((attachment) => attachment.url === reply.imageUrl)) {
      attachments.unshift({
        type: 'image',
        url: reply.imageUrl,
        mimeType: guessMimeTypeFromUrl(reply.imageUrl, 'image/png'),
        fileName: getFileNameFromUrl(reply.imageUrl, 'image.png')
      })
    }

    return {
      reply: {
        ...reply,
        ...(attachments.length > 0 ? { attachments } : {})
      },
      artifacts: attachments.map((attachment) =>
        toArtifactRef(request.runId, attachment, createdAt, {
          executionMode: request.executionMode,
          executionTraceLabel: request.executionTraceLabel
        })
      ),
      toolCalls: [],
      events: [
        {
          eventId: crypto.randomUUID(),
          runId: request.runId,
          sessionKey: getAssistantSessionKey(request.route),
          route: request.route,
          type: 'progress',
          level: 'info',
          message: 'LLM execution completed.',
          createdAt
        }
      ],
      ...(request.executionMode ? { executionMode: request.executionMode } : {}),
      ...(Number.isFinite(request.executionHistorySize)
        ? { executionHistorySize: request.executionHistorySize }
        : {}),
      ...(request.executionTraceLabel ? { executionTraceLabel: request.executionTraceLabel } : {})
    }
  }
}
