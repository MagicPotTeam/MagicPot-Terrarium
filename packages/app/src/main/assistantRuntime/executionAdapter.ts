import { createHash } from 'node:crypto'
import { ChatAttachment, ChatMessage, LLMChatResp, LLMProxySvc } from '@shared/api/svcLLMProxy'
import {
  createToolInvokeAction,
  createToolResultAction,
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
import { AssistantToolCallResult, AssistantToolRegistry } from './toolRegistry'
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
}

export type AssistantToolActionDescriptor = {
  runId: string
  toolCallIndex: number
  toolName: string
  args: Record<string, unknown>
  requestedAt: number
}

type AssistantToolExecutionContext = Omit<
  AssistantExecutionRequest,
  'messages' | 'req' | 'runId' | 'profileId' | 'systemPrompt' | 'cooperativeExecution'
> & {
  cooperativeExecution?: AssistantExecutionRequest['cooperativeExecution']
}

type AssistantExecutionRequest = {
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
  toolCallIndex: number
  toolName: string
  args: Record<string, unknown>
  requestedAt?: number
}): ToolInvokeAction => {
  const toolName = cleanString(options.toolName)
  if (!toolName) throw new TypeError('Tool name is required.')
  const args = asJsonObject(options.args, 'Tool invocation args')
  const digest = createHash('sha256')
    .update(`${options.runId}\n${options.toolCallIndex}\n${toolName}\n${canonicalJson(args)}`)
    .digest('hex')
  const invocationId = `${options.runId}:tool:${options.toolCallIndex}:${digest.slice(0, 24)}`
  return createToolInvokeAction({
    actionId: invocationId,
    correlationId: options.runId,
    payload: {
      invocationId,
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

export class AssistantExecutionAdapter {
  private readonly chatService: Pick<LLMProxySvc, 'chat'>
  private readonly toolRegistry: AssistantToolRegistry
  private readonly onAgentAction: NonNullable<AssistantExecutionAdapterDeps['onAgentAction']>

  constructor(deps: AssistantExecutionAdapterDeps) {
    this.chatService = deps.chatService
    this.toolRegistry = deps.toolRegistry || new AssistantToolRegistry()
    this.onAgentAction = deps.onAgentAction || (() => undefined)
  }

  listTools(allowedToolNames?: string[] | null) {
    syncAssistantToolsWithAgentKernel(this.toolRegistry)
    return filterAssistantToolsByAllowlist(this.toolRegistry.listTools(), allowedToolNames)
  }

  async executeToolInvokeAction(
    action: ToolInvokeAction,
    descriptor: AssistantToolActionDescriptor,
    request: AssistantToolExecutionContext,
    allowedToolNames?: string[] | null
  ): Promise<{ action: ToolResultAction; result: AssistantToolCallResult }> {
    validateAssistantToolInvokeAction(action, descriptor)
    const toolName = action.payload.toolName
    const args = action.payload.args
    await this.onAgentAction(action)
    const startedAt = Date.now()
    let leaveTool: (() => void) | undefined
    let executionCompleted = false
    try {
      assertAssistantToolAllowed(toolName, allowedToolNames)
      await request.cooperativeExecution?.checkpoint('tool-invocation')
      leaveTool = request.cooperativeExecution?.enter('tool-invocation')
      const result = await invokeAssistantToolViaKernel({
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
          resumeRun: request.resumeRun,
          resumeWorkflow: request.resumeWorkflow,
          startTaskGroup: request.startTaskGroup,
          progressTaskGroup: request.progressTaskGroup,
          approveTaskGroup: request.approveTaskGroup,
          exportTaskGroup: request.exportTaskGroup,
          cancelTaskGroup: request.cancelTaskGroup,
          resumeTaskGroup: request.resumeTaskGroup
        }
      })
      const finishedAt = Date.now()
      const resultAction = createToolResultAction({
        actionId: `${action.actionId}:result`,
        correlationId: action.correlationId,
        payload: {
          invocationId: action.payload.invocationId,
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
      await this.onAgentAction(resultAction)
      return { action: resultAction, result }
    } catch (error) {
      if (executionCompleted) throw error
      const finishedAt = Date.now()
      const resultAction = createToolResultAction({
        actionId: `${action.actionId}:result`,
        correlationId: action.correlationId,
        payload: {
          invocationId: action.payload.invocationId,
          toolName,
          ok: false,
          error: toSafeError(error),
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt)
        }
      })
      try {
        await this.onAgentAction(resultAction)
      } catch {
        // Preserve the original execution or authorization failure.
      }
      throw error
    } finally {
      leaveTool?.()
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
    }
  ): Promise<AssistantToolCallResult> {
    const descriptor: AssistantToolActionDescriptor = {
      runId: `call-tool:${crypto.randomUUID()}`,
      toolCallIndex: 0,
      toolName: name,
      args,
      requestedAt: Date.now()
    }
    const execution = await this.executeToolInvokeAction(
      buildAssistantToolInvokeAction(descriptor),
      descriptor,
      request,
      options?.allowedToolNames
    )
    return execution.result
  }
  async run(request: AssistantExecutionRequest): Promise<AssistantExecutionResult> {
    const startedAt = Date.now()
    const executionMetadata = buildExecutionMetadata(request)
    const toolInvocation = parseToolInvocation(request.req.text)
    if (toolInvocation) {
      if (request.maxToolCalls !== undefined && request.maxToolCalls < 1)
        throw new Error('Assistant tool-call budget exhausted.')
      const toolAction = buildAssistantToolInvokeAction({
        runId: request.runId,
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
          runId: request.runId,
          toolCallIndex: 0,
          toolName: toolInvocation.toolName,
          args: toolInvocation.args,
          requestedAt: startedAt
        },
        request,
        request.req.execution?.allowedToolNames
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
    await request.cooperativeExecution?.checkpoint('llm-inference')
    const leaveLlm = request.cooperativeExecution?.enter('llm-inference')
    let reply
    try {
      reply = await this.chatService.chat(
        {
          messages: request.messages,
          ...(request.profileId ? { profileId: request.profileId } : {}),
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(systemPrompt ? { systemPrompt } : {})
        },
        {
          signal: request.signal
        }
      )
    } finally {
      leaveLlm?.()
    }

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
