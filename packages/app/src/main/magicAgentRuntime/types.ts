import type { ChatAttachment, LLMChatResp } from '@shared/api/svcLLMProxy'

export const DEFAULT_MAGIC_AGENT_ID = 'magicpot.default.chat'

export type MagicAgentRole = 'system' | 'user' | 'assistant' | 'tool'

export type MagicAgentMessage = {
  role: MagicAgentRole
  content: string
  name?: string
  toolCallId?: string
  attachments?: ChatAttachment[]
  metadata?: Record<string, unknown>
}

export type MagicAgentToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type MagicAgentToolResult = {
  content: string
  metadata?: Record<string, unknown>
}

export type MagicAgentToolContext = {
  runId: string
  agentId: string
  signal?: AbortSignal
  metadata?: Record<string, unknown>
}

export type MagicAgentToolHandler = (
  args: Record<string, unknown>,
  context: MagicAgentToolContext
) => Promise<MagicAgentToolResult> | MagicAgentToolResult

export type MagicAgentToolRegistration = MagicAgentToolDefinition & {
  handler: MagicAgentToolHandler
}

export type MagicAgentToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type MagicAgentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'timeout'
  | 'permission_denied'

export type MagicAgentEventType =
  | 'run.created'
  | 'run.started'
  | 'chat.requested'
  | 'chat.completed'
  | 'tool.requested'
  | 'tool.completed'
  | 'tool.denied'
  | 'run.completed'
  | 'run.failed'
  | 'run.aborted'
  | 'run.timeout'

export type MagicAgentRunEvent = {
  eventId: string
  runId: string
  agentId: string
  type: MagicAgentEventType
  message: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export type MagicAgentRunRequest = {
  agentId?: string
  messages: MagicAgentMessage[]
  systemPrompt?: string
  profileId?: string
  maxToolIterations?: number
  timeoutMs?: number
  allowedToolNames?: string[] | null
  /**
   * Internal/test-only escape hatch. Platform v1 must keep model-driven tool
   * execution disabled by default so route-scoped AssistantRuntime/AgentKernel
   * policy remains the execution boundary.
   */
  enableToolExecution?: boolean
  signal?: AbortSignal
  metadata?: Record<string, unknown>
}

export type MagicAgentRunResult = {
  runId: string
  agentId: string
  status: MagicAgentStatus
  reply: LLMChatResp
  messages: MagicAgentMessage[]
  toolCalls: MagicAgentToolCall[]
  events: MagicAgentRunEvent[]
  startedAt: number
  finishedAt: number
  error?: string
}

export type MagicAgentDefinition = {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  toolNames?: string[] | null
  maxToolIterations?: number
  profileId?: string
}
