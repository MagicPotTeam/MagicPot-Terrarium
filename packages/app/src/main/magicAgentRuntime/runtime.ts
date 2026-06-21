import { throwIfAborted } from '@shared/agent'
import type { ChatMessage, LLMChatReq, LLMChatResp, LLMProxySvc } from '@shared/api/svcLLMProxy'
import { MagicAgentRegistry } from './agentRegistry'
import { MagicAgentToolRegistry } from './toolRegistry'
import {
  DEFAULT_MAGIC_AGENT_ID,
  type MagicAgentDefinition,
  type MagicAgentEventType,
  type MagicAgentMessage,
  type MagicAgentRunEvent,
  type MagicAgentRunRequest,
  type MagicAgentRunResult,
  type MagicAgentStatus,
  type MagicAgentToolCall,
  type MagicAgentToolContext,
  type MagicAgentToolDefinition,
  type MagicAgentToolRegistration,
  type MagicAgentToolResult
} from './types'

export type MagicAgentChatService = Pick<LLMProxySvc, 'chat'>

export type MagicAgentRuntimeDeps = {
  chatService: MagicAgentChatService
  agentRegistry?: MagicAgentRegistry
  toolRegistry?: MagicAgentToolRegistry
  now?: () => number
  randomUUID?: () => string
}

type ParsedToolCall = MagicAgentToolCall

type ToolCallCandidate = {
  id?: unknown
  name?: unknown
  toolName?: unknown
  function?: unknown
  arguments?: unknown
  args?: unknown
  input?: unknown
}

const DEFAULT_MAX_TOOL_ITERATIONS = 4
const TOOL_RESULT_PREVIEW_LIMIT = 4000

const cleanString = (value?: string | null): string => String(value || '').trim()

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const toRecordArgs = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return {}
  }

  const normalized = cleanString(value)
  if (!normalized) {
    return {}
  }

  try {
    const parsed = JSON.parse(normalized) as unknown
    return isRecord(parsed) ? parsed : { input: parsed }
  } catch {
    return { input: normalized }
  }
}

const asToolCallCandidates = (value: unknown): ToolCallCandidate[] => {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value.filter(isRecord) as ToolCallCandidate[]
  }

  if (isRecord(value)) {
    return [value as ToolCallCandidate]
  }

  return []
}

const extractToolCallFromRecord = (
  candidate: ToolCallCandidate,
  fallbackId: () => string
): ParsedToolCall | null => {
  const functionRecord = isRecord(candidate.function) ? candidate.function : undefined
  const name = cleanString(
    (functionRecord?.name as string | undefined) ||
      (candidate.name as string | undefined) ||
      (candidate.toolName as string | undefined)
  )
  if (!name) {
    return null
  }

  const rawArgs = hasOwn(candidate as Record<string, unknown>, 'args')
    ? candidate.args
    : hasOwn(candidate as Record<string, unknown>, 'arguments')
      ? candidate.arguments
      : hasOwn(candidate as Record<string, unknown>, 'input')
        ? candidate.input
        : functionRecord
          ? functionRecord.arguments
          : undefined

  return {
    id: cleanString(candidate.id as string | undefined) || fallbackId(),
    name,
    args: toRecordArgs(rawArgs)
  }
}

const parseToolCallsFromMetadata = (
  metadata: Record<string, unknown> | undefined,
  fallbackId: () => string
): ParsedToolCall[] => {
  if (!metadata) {
    return []
  }

  const candidates = [
    ...asToolCallCandidates(metadata.toolCalls),
    ...asToolCallCandidates(metadata.tool_calls),
    ...asToolCallCandidates(metadata.toolCall)
  ]

  if (isRecord(metadata.function_call)) {
    candidates.push(metadata.function_call as ToolCallCandidate)
  }

  return candidates
    .map((candidate) => extractToolCallFromRecord(candidate, fallbackId))
    .filter((toolCall): toolCall is ParsedToolCall => Boolean(toolCall))
}

const parseToolCallsFromContent = (content: string, fallbackId: () => string): ParsedToolCall[] => {
  const normalized = cleanString(content)
  if (!normalized) {
    return []
  }

  const parsedCalls: ParsedToolCall[] = []
  const addFromParsed = (parsed: unknown): boolean => {
    const candidates = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.toolCalls)
        ? parsed.toolCalls
        : isRecord(parsed) && Array.isArray(parsed.tool_calls)
          ? parsed.tool_calls
          : isRecord(parsed) && (parsed.name || parsed.toolName || parsed.function)
            ? [parsed]
            : []

    for (const candidate of candidates) {
      if (!isRecord(candidate)) {
        continue
      }
      const toolCall = extractToolCallFromRecord(candidate as ToolCallCandidate, fallbackId)
      if (toolCall) {
        parsedCalls.push(toolCall)
      }
    }
    return parsedCalls.length > 0
  }

  try {
    if (addFromParsed(JSON.parse(normalized) as unknown)) {
      return parsedCalls
    }
  } catch {
    // Not a raw JSON tool-call payload. Continue with fenced JSON and slash syntax.
  }

  const fencedJsonPattern = /```(?:json)?\s*([\s\S]*?)```/gi
  let fenceMatch: RegExpExecArray | null
  while ((fenceMatch = fencedJsonPattern.exec(normalized))) {
    try {
      addFromParsed(JSON.parse(fenceMatch[1]) as unknown)
    } catch {
      // Ignore non-JSON fenced blocks.
    }
  }
  if (parsedCalls.length > 0) {
    return parsedCalls
  }

  const slashPattern = /^\s*\/tool\s+([a-z0-9._-]+)(?:\s+([\s\S]+?))?\s*$/gim
  let slashMatch: RegExpExecArray | null
  while ((slashMatch = slashPattern.exec(normalized))) {
    parsedCalls.push({
      id: fallbackId(),
      name: slashMatch[1],
      args: toRecordArgs(slashMatch[2])
    })
  }

  return parsedCalls
}

const toChatMessages = (messages: MagicAgentMessage[]): ChatMessage[] =>
  messages
    .filter((message) => message.role !== 'tool')
    .map((message) => ({
      role:
        message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
      ...(message.attachments?.length ? { attachments: message.attachments } : {})
    }))

const appendToolResultMessage = (
  messages: MagicAgentMessage[],
  toolCall: MagicAgentToolCall,
  content: string,
  metadata?: Record<string, unknown>
): void => {
  const trimmedContent =
    content.length > TOOL_RESULT_PREVIEW_LIMIT
      ? `${content.slice(0, TOOL_RESULT_PREVIEW_LIMIT - 3)}...`
      : content
  messages.push({
    role: 'user',
    name: toolCall.name,
    toolCallId: toolCall.id,
    content: [`Tool result for ${toolCall.name} (${toolCall.id}):`, trimmedContent].join('\n'),
    metadata: {
      toolResult: true,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      ...(metadata || {})
    }
  })
}

const createAbortError = (reason?: unknown): Error => {
  const message =
    typeof reason === 'string'
      ? reason
      : reason instanceof Error
        ? reason.message
        : 'Operation aborted.'
  const error = new Error(message)
  error.name = 'AbortError'
  ;(error as Error & { cause?: unknown }).cause = reason
  return error
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'AbortError' || /aborted|aborterror|cancelled|canceled/i.test(error.message))

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'TimeoutError' || /timed out|timeout/i.test(error.message))

const createTimeoutError = (timeoutMs: number): Error => {
  const error = new Error(`Magic agent run timed out after ${timeoutMs}ms.`)
  error.name = 'TimeoutError'
  return error
}

export class MagicAgentRuntime {
  private readonly chatService: MagicAgentChatService
  private readonly agentRegistry: MagicAgentRegistry
  private readonly toolRegistry: MagicAgentToolRegistry
  private readonly now: () => number
  private readonly randomUUID: () => string

  constructor(deps: MagicAgentRuntimeDeps) {
    this.chatService = deps.chatService
    this.agentRegistry = deps.agentRegistry || new MagicAgentRegistry()
    this.toolRegistry = deps.toolRegistry || new MagicAgentToolRegistry()
    this.now = deps.now || (() => Date.now())
    this.randomUUID = deps.randomUUID || (() => crypto.randomUUID())
  }

  registerAgent(definition: MagicAgentDefinition): MagicAgentDefinition {
    return this.agentRegistry.register(definition)
  }

  listAgents(): MagicAgentDefinition[] {
    return this.agentRegistry.list()
  }

  registerTool(registration: MagicAgentToolRegistration): MagicAgentToolDefinition {
    return this.toolRegistry.register(registration)
  }

  registerTools(registrations: MagicAgentToolRegistration[]): MagicAgentToolDefinition[] {
    return this.toolRegistry.registerMany(registrations)
  }

  listTools(agentId = DEFAULT_MAGIC_AGENT_ID): MagicAgentToolDefinition[] {
    const agent = this.agentRegistry.get(agentId) || this.agentRegistry.get(DEFAULT_MAGIC_AGENT_ID)
    return this.filterToolsForAgent(this.toolRegistry.list(), agent)
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    context: Partial<MagicAgentToolContext> = {}
  ): Promise<MagicAgentToolResult> {
    return this.toolRegistry.call(name, args, {
      runId: context.runId || this.randomUUID(),
      agentId: context.agentId || DEFAULT_MAGIC_AGENT_ID,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.metadata ? { metadata: context.metadata } : {})
    })
  }

  async run(request: MagicAgentRunRequest): Promise<MagicAgentRunResult> {
    const runId = this.randomUUID()
    const agentId = cleanString(request.agentId) || DEFAULT_MAGIC_AGENT_ID
    const agent = this.agentRegistry.get(agentId)
    if (!agent) {
      throw new Error(`Unknown magic agent: ${agentId}`)
    }

    const startedAt = this.now()
    const messages = [...request.messages]
    const toolCalls: MagicAgentToolCall[] = []
    const events: MagicAgentRunEvent[] = []
    const controller = new AbortController()
    const timeout = this.createRunTimeout(request.timeoutMs, controller)
    const abortForwarder = () => controller.abort(request.signal?.reason)
    if (request.signal?.aborted) {
      controller.abort(request.signal.reason)
    } else {
      request.signal?.addEventListener('abort', abortForwarder, { once: true })
    }

    const emit = (
      type: MagicAgentEventType,
      message: string,
      metadata?: Record<string, unknown>
    ): void => {
      events.push({
        eventId: this.randomUUID(),
        runId,
        agentId,
        type,
        message,
        createdAt: this.now(),
        ...(metadata ? { metadata } : {})
      })
    }

    emit('run.created', `Run created for ${agentId}.`)

    try {
      throwIfAborted(controller.signal)
      emit('run.started', `Run started for ${agentId}.`)
      const reply = await this.runLoop({
        request,
        agent,
        runId,
        agentId,
        messages,
        toolCalls,
        signal: controller.signal,
        emit
      })
      const finishedAt = this.now()
      emit('run.completed', `Run completed for ${agentId}.`, {
        toolCallCount: toolCalls.length
      })
      return {
        runId,
        agentId,
        status: 'completed',
        reply,
        messages,
        toolCalls,
        events,
        startedAt,
        finishedAt
      }
    } catch (error) {
      const finishedAt = this.now()
      const status = this.statusForError(error)
      const message = error instanceof Error ? error.message : String(error)
      const eventType: MagicAgentEventType =
        status === 'timeout' ? 'run.timeout' : status === 'aborted' ? 'run.aborted' : 'run.failed'
      emit(eventType, message, { status })
      return {
        runId,
        agentId,
        status,
        reply: {
          content: ''
        },
        messages,
        toolCalls,
        events,
        startedAt,
        finishedAt,
        error: message
      }
    } finally {
      timeout.dispose()
      request.signal?.removeEventListener('abort', abortForwarder)
    }
  }

  private async runLoop(options: {
    request: MagicAgentRunRequest
    agent: MagicAgentDefinition
    runId: string
    agentId: string
    messages: MagicAgentMessage[]
    toolCalls: MagicAgentToolCall[]
    signal: AbortSignal
    emit: (type: MagicAgentEventType, message: string, metadata?: Record<string, unknown>) => void
  }): Promise<LLMChatResp> {
    const maxToolIterations = this.resolveMaxToolIterations(options.request, options.agent)
    let lastReply: LLMChatResp = { content: '' }

    for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
      throwIfAborted(options.signal)
      options.emit('chat.requested', 'Requesting chat completion.', { iteration })
      lastReply = await this.withAbort(
        this.chatService.chat(this.buildChatRequest(options), {
          signal: options.signal
        }),
        options.signal
      )
      throwIfAborted(options.signal)
      options.emit('chat.completed', 'Chat completion received.', {
        iteration,
        finishReason: lastReply.finishReason
      })

      const parsedToolCalls = options.request.enableToolExecution
        ? this.parseToolCalls(lastReply)
        : []
      if (!parsedToolCalls.length) {
        options.messages.push({
          role: 'assistant',
          content: lastReply.content,
          ...(lastReply.attachments?.length ? { attachments: lastReply.attachments } : {}),
          ...(lastReply.metadata ? { metadata: lastReply.metadata } : {})
        })
        return lastReply
      }

      if (iteration >= maxToolIterations) {
        throw new Error(`Tool-call iteration limit exceeded (${maxToolIterations}).`)
      }

      options.messages.push({
        role: 'assistant',
        content: lastReply.content,
        ...(lastReply.metadata ? { metadata: lastReply.metadata } : {})
      })

      for (const toolCall of parsedToolCalls) {
        throwIfAborted(options.signal)
        this.assertToolAllowed(toolCall.name, options.request, options.agent)
        options.toolCalls.push(toolCall)
        options.emit('tool.requested', `Tool requested: ${toolCall.name}`, {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.args
        })
        const result = await this.withAbort(
          this.toolRegistry.call(toolCall.name, toolCall.args, {
            runId: options.runId,
            agentId: options.agentId,
            signal: options.signal,
            metadata: options.request.metadata
          }),
          options.signal
        )
        options.emit('tool.completed', `Tool completed: ${toolCall.name}`, {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          metadata: result.metadata
        })
        appendToolResultMessage(options.messages, toolCall, result.content, result.metadata)
      }
    }

    return lastReply
  }

  private buildChatRequest(options: {
    request: MagicAgentRunRequest
    agent: MagicAgentDefinition
    messages: MagicAgentMessage[]
  }): LLMChatReq {
    const tools = options.request.enableToolExecution
      ? this.filterToolsForAgent(this.toolRegistry.list(), options.agent)
      : []
    const systemPrompt = [options.agent.systemPrompt, options.request.systemPrompt]
      .filter(Boolean)
      .join('\n\n')
    return {
      messages: toChatMessages(options.messages),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(options.request.profileId || options.agent.profileId
        ? { profileId: options.request.profileId || options.agent.profileId }
        : {}),
      metadata: undefined,
      skillRuntime: tools.length
        ? {
            skillId: options.agent.id,
            instructions: systemPrompt ? { systemPrompt } : undefined,
            bindings: [
              {
                appId: options.agent.id,
                appName: options.agent.name,
                source: 'magicAgentRuntime',
                toolNames: tools.map((tool) => tool.name)
              }
            ]
          }
        : undefined
    } as LLMChatReq
  }

  private parseToolCalls(reply: LLMChatResp): ParsedToolCall[] {
    return [
      ...parseToolCallsFromMetadata(reply.metadata, this.randomUUID),
      ...parseToolCallsFromContent(reply.content, this.randomUUID)
    ]
  }

  private filterToolsForAgent(
    tools: MagicAgentToolDefinition[],
    agent?: MagicAgentDefinition
  ): MagicAgentToolDefinition[] {
    if (!agent?.toolNames) {
      return tools
    }
    const allowed = new Set(agent.toolNames.map(cleanString).filter(Boolean))
    return tools.filter((tool) => allowed.has(tool.name))
  }

  private assertToolAllowed(
    toolName: string,
    request: MagicAgentRunRequest,
    agent: MagicAgentDefinition
  ): void {
    const requestAllowlist = Array.isArray(request.allowedToolNames)
      ? request.allowedToolNames.map(cleanString).filter(Boolean)
      : null
    const agentAllowlist = Array.isArray(agent.toolNames)
      ? agent.toolNames.map(cleanString).filter(Boolean)
      : null
    const effectiveAllowlist = requestAllowlist || agentAllowlist
    if (!effectiveAllowlist) {
      return
    }

    if (!effectiveAllowlist.includes(toolName)) {
      const error = new Error(`Tool "${toolName}" is not allowed for agent "${agent.id}".`)
      error.name = 'PermissionDeniedError'
      throw error
    }
  }

  private resolveMaxToolIterations(
    request: MagicAgentRunRequest,
    agent: MagicAgentDefinition
  ): number {
    const requested = Number(request.maxToolIterations)
    if (Number.isFinite(requested)) {
      return Math.max(0, Math.trunc(requested))
    }
    const configured = Number(agent.maxToolIterations)
    if (Number.isFinite(configured)) {
      return Math.max(0, Math.trunc(configured))
    }
    return DEFAULT_MAX_TOOL_ITERATIONS
  }

  private async withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw createAbortError(signal.reason)
    }
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        const abort = () => reject(createAbortError(signal.reason))
        signal.addEventListener('abort', abort, { once: true })
        promise.finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
      })
    ])
  }

  private createRunTimeout(
    timeoutMs: number | undefined,
    controller: AbortController
  ): { dispose: () => void } {
    if (!Number.isFinite(timeoutMs) || Number(timeoutMs) <= 0) {
      return { dispose: () => {} }
    }

    const normalizedTimeoutMs = Math.max(1, Math.trunc(Number(timeoutMs)))
    const timer = setTimeout(() => {
      controller.abort(createTimeoutError(normalizedTimeoutMs))
    }, normalizedTimeoutMs)
    return {
      dispose: () => clearTimeout(timer)
    }
  }

  private statusForError(error: unknown): MagicAgentStatus {
    if (isTimeoutError(error) || (error instanceof Error && isTimeoutError(error.cause))) {
      return 'timeout'
    }
    if (isAbortError(error)) {
      if (error instanceof Error && isTimeoutError(error.cause)) {
        return 'timeout'
      }
      return 'aborted'
    }
    if (error instanceof Error && error.name === 'PermissionDeniedError') {
      return 'permission_denied'
    }
    return 'failed'
  }
}
