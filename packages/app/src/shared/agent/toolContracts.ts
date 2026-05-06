import type { AgentCapabilityDescriptor } from './capabilityRegistry'
import type { AgentSessionIdentity } from './sessionIdentity'

export type AgentToolSource = 'kernel' | 'assistant' | 'mcp' | 'bot'

export type AgentToolInvocationRequest = {
  invocationId?: string
  toolName: string
  args: Record<string, unknown>
  session: AgentSessionIdentity
  signal?: AbortSignal
  source?: AgentToolSource
  capabilityId?: string
  requestedBy?: string
  traceLabel?: string
  metadata?: Record<string, unknown>
}

export type AgentToolInvocationError = {
  message: string
  code?: string
  details?: unknown
}

export type AgentToolInvocationResult = {
  invocationId: string
  toolName: string
  capabilityId?: string
  sessionKey: string
  ok: boolean
  startedAt: number
  finishedAt: number
  durationMs: number
  content?: string
  metadata?: Record<string, unknown>
  error?: AgentToolInvocationError
}

export type AgentToolInvoker = (
  request: AgentToolInvocationRequest
) => Promise<
  Omit<
    AgentToolInvocationResult,
    'invocationId' | 'toolName' | 'sessionKey' | 'startedAt' | 'finishedAt' | 'durationMs'
  >
>

export type AgentToolDefinition = AgentCapabilityDescriptor & {
  toolName?: string
}

export type AgentToolRegistration = {
  tool: AgentToolDefinition
  invoker?: AgentToolInvoker
}

export const createAbortError = (reason?: unknown): Error => {
  const message =
    typeof reason === 'string'
      ? reason
      : reason instanceof Error
        ? reason.message
        : 'Operation aborted.'
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'AbortError' || /aborted|cancelled/i.test(error.message))

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) {
    return
  }
  throw createAbortError(signal.reason)
}

export const createAgentToolInvocationResult = (
  request: AgentToolInvocationRequest,
  result: Omit<
    AgentToolInvocationResult,
    'invocationId' | 'toolName' | 'sessionKey' | 'startedAt' | 'finishedAt' | 'durationMs'
  >
): AgentToolInvocationResult => {
  const startedAt = Date.now()
  const finishedAt = startedAt
  return {
    invocationId: request.invocationId || crypto.randomUUID(),
    toolName: request.toolName,
    capabilityId: request.capabilityId,
    sessionKey: request.session.sessionKey,
    ok: result.ok,
    startedAt,
    finishedAt,
    durationMs: 0,
    ...(result.content ? { content: result.content } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
    ...(result.error ? { error: result.error } : {})
  }
}
