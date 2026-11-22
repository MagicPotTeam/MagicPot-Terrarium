import type { JsonDict } from '@shared/utils/utilTypes'
import type { ToolHistoryEntry } from '@shared/llm/types'
import { cloneBoundedMcpJson } from './agentThreadMcp'

/** Display/checkpoint data only. Never execution, retry, adoption or rollback authority. */
export type AgentToolFailurePayload = JsonDict & { kind: 'agent-tool-failure/v1' } & (
  | { receiptOmitted: true }
  | { toolResult: { content: string; metadata?: Record<string, unknown> }; toolHistory: ToolHistoryEntry[] }
)
export const AGENT_TOOL_FAILURE_MAX_BYTES = 64 * 1024
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key))
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512

/** Passive JSON: <=64KiB UTF-8, depth16/nodes2048/256 members per container.
 * args/metadata are original untrusted tool data, not recursively redacted secrets.
 * Reject the WHOLE receipt on malformed/unsafe/oversized data; no partial success.
 */
export function readAgentToolFailurePayload(value: unknown): AgentToolFailurePayload | undefined {
  try {
    const data = cloneBoundedMcpJson(value, AGENT_TOOL_FAILURE_MAX_BYTES)
    if (!record(data) || data.kind !== 'agent-tool-failure/v1') return undefined
    if (keys(data, ['kind', 'receiptOmitted']) && data.receiptOmitted === true) return data as AgentToolFailurePayload
    if (!keys(data, ['kind', 'toolResult', 'toolHistory']) || !record(data.toolResult) || !keys(data.toolResult, ['content'], ['metadata']) || typeof data.toolResult.content !== 'string' || (data.toolResult.metadata !== undefined && !record(data.toolResult.metadata)) || !Array.isArray(data.toolHistory)) return undefined
    for (const entry of data.toolHistory) {
      if (!record(entry) || !keys(entry, ['runId', 'toolCallId', 'toolName', 'args', 'status'], ['content', 'error', 'metadata']) || ![entry.runId, entry.toolCallId, entry.toolName].every(identity) || !record(entry.args) || typeof entry.status !== 'string' || !['running', 'completed', 'failed', 'cancelled'].includes(entry.status) || (entry.content !== undefined && typeof entry.content !== 'string') || (entry.error !== undefined && typeof entry.error !== 'string') || (entry.metadata !== undefined && !record(entry.metadata))) return undefined
    }
    return data as AgentToolFailurePayload
  } catch { return undefined }
}
export const omittedAgentToolFailure = (): AgentToolFailurePayload & JsonDict => ({ kind: 'agent-tool-failure/v1', receiptOmitted: true })
