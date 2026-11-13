import { assertPolicyRequest, createAssistantToolPolicyRequest, type PolicyJsonRecord } from '@shared/magicAgentPlatform2'
import { getAgentSessionKey, type AgentRouteLike } from '@shared/agent'
import { randomUUID } from 'node:crypto'
import type { MemoryFileWriteApproval } from './agentThreadMemoryFileHost'

/** Exact immutable memory bytes/root/preimage + creation effects, not a generic path grant. */
export async function approveMemoryFileWrite(route: AgentRouteLike, input: MemoryFileWriteApproval, signal: AbortSignal): Promise<() => void> {
  const owner = structuredClone(route), captured = structuredClone(input)
  signal.throwIfAborted()
  const request = assertPolicyRequest({ ...createAssistantToolPolicyRequest({
    requestId: randomUUID(), actor: { kind: 'agent', id: getAgentSessionKey(owner) }, target: { kind: 'tool', id: 'memory_write' }, route: owner,
    sessionId: captured.conversationId, runId: captured.parentRunId, toolInput: captured as unknown as PolicyJsonRecord
  }), action: 'memory.file.write' })
  const { getAssistantTerminalPolicyRuntime } = await import('../magicAgentPlatform2/productionRuntime')
  signal.throwIfAborted()
  const runtime = getAssistantTerminalPolicyRuntime(), reference = await runtime.requestTerminalApproval(request, signal)
  signal.throwIfAborted()
  const authorization = runtime.authorization.authorize({ authorizationId: reference.authorizationId!, request, evaluatedAt: Date.now(), grantId: reference.grantId, expectedGrantUseCount: reference.expectedGrantUseCount, idempotencyKey: `memory-authorize:${reference.authorizationId}` })
  if (authorization.status !== 'authorized') throw new Error('Memory file write was not authorized.')
  let used = false
  return () => {
    signal.throwIfAborted()
    if (used) throw new Error('Memory file execution permit was already consumed.')
    used = true
    runtime.authorization.consumeExecutionPermit({ permit: authorization.permit, request, consumedAt: Date.now(), idempotencyKey: `memory-consume:${reference.authorizationId}` })
  }
}
