import { ChatAttachment, ChatMessage, LLMChatResp, LLMProxySvc } from '@shared/api/svcLLMProxy'
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
import { AssistantToolRegistry } from './toolRegistry'
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
  executionMode?: AssistantExecutionMode
  executionHistorySize?: number
  executionTraceLabel?: string
  sessionStore: AssistantSessionStore
  taskState: AssistantTaskState
  workspaceMemoryFile?: string
  workspaceTaskContextFile?: string
  workspaceContextFile?: string
  workspacePinnedContextFile?: string
  workspaceMetaFile?: string
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

  constructor(deps: AssistantExecutionAdapterDeps) {
    this.chatService = deps.chatService
    this.toolRegistry = deps.toolRegistry || new AssistantToolRegistry()
  }

  listTools(allowedToolNames?: string[] | null) {
    syncAssistantToolsWithAgentKernel(this.toolRegistry)
    return filterAssistantToolsByAllowlist(this.toolRegistry.listTools(), allowedToolNames)
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
  ) {
    assertAssistantToolAllowed(name, options?.allowedToolNames)
    return invokeAssistantToolViaKernel({
      toolRegistry: this.toolRegistry,
      toolName: name,
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
  }

  async run(request: AssistantExecutionRequest): Promise<AssistantExecutionResult> {
    const startedAt = Date.now()
    const executionMetadata = buildExecutionMetadata(request)
    const toolInvocation = parseToolInvocation(request.req.text)
    if (toolInvocation) {
      assertAssistantToolAllowed(toolInvocation.toolName, request.req.execution?.allowedToolNames)
      await request.emitEvent?.({
        type: 'progress',
        level: 'info',
        message: `Running tool: ${toolInvocation.toolName}`,
        metadata: {
          ...executionMetadata,
          toolName: toolInvocation.toolName,
          requestKind: 'tool-invocation'
        }
      })
      const toolResult = await invokeAssistantToolViaKernel({
        toolRegistry: this.toolRegistry,
        toolName: toolInvocation.toolName,
        args: toolInvocation.args,
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

      return {
        reply: {
          content: toolResult.content
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
              ...(toolResult.metadata || {}),
              toolName: toolInvocation.toolName,
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
    const reply = await this.chatService.chat(
      {
        messages: request.messages,
        ...(request.profileId ? { profileId: request.profileId } : {}),
        ...(systemPrompt ? { systemPrompt } : {})
      },
      {
        signal: request.signal
      }
    )

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
