import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getAgentSessionKey, type AgentRouteLike } from '@shared/agent'
import {
  assertPolicyRequest,
  canonicalPolicyJson,
  createAssistantToolPolicyRequest,
  type PolicyJsonRecord,
  type PolicyRequest
} from '@shared/magicAgentPlatform2'
import { getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import type { TerminalApprovalReference } from '../magicAgentPlatform2/terminalApprovalCoordinator'

type ApprovedGraphInvocation = {
  toolName: string
  args: string
  sessionKey: string
  route: string
  active: boolean
  consumed: boolean
}

// This state never crosses IPC or becomes model-visible metadata. It only exists
// while the main process invokes an already-consumed Graph execution permit.
const graphApproval = new AsyncLocalStorage<ApprovedGraphInvocation>()

export async function invokeApprovedGraphTool<T>(input: {
  request: PolicyRequest
  reference: TerminalApprovalReference
  signal?: AbortSignal
  invoke: () => Promise<T>
}): Promise<T> {
  input.signal?.throwIfAborted()
  const runtime = getAssistantTerminalPolicyRuntime()
  const authorized = runtime.authorization.authorize({
    authorizationId: input.reference.authorizationId!,
    request: input.request,
    evaluatedAt: Date.now(),
    grantId: input.reference.grantId,
    expectedGrantUseCount: input.reference.expectedGrantUseCount,
    idempotencyKey: `graph-tool-authorize:${input.reference.authorizationId}`
  })
  if (authorized.status !== 'authorized')
    throw new Error(`Graph tool approval was not authorized: ${authorized.status}`)
  runtime.authorization.consumeExecutionPermit({
    permit: authorized.permit,
    request: input.request,
    consumedAt: Date.now(),
    // Each execution attempt must claim the permit anew. Reusing a consume key
    // would return its old receipt and could accidentally execute the effect twice.
    idempotencyKey: `graph-tool-consume:${input.reference.authorizationId}:${randomUUID()}`
  })
  const scope: ApprovedGraphInvocation = {
    toolName: input.request.target.id,
    args: canonicalPolicyJson(input.request.input),
    sessionKey: getAgentSessionKey(input.request.route as AgentRouteLike),
    route: canonicalPolicyJson(input.request.route as PolicyJsonRecord),
    active: true,
    consumed: false
  }
  try {
    return await graphApproval.run(scope, input.invoke)
  } finally {
    scope.active = false
  }
}

export async function requestCreativeToolApproval(input: {
  toolName: string
  args: Record<string, unknown>
  route: AgentRouteLike
  signal?: AbortSignal
}): Promise<void> {
  input.signal?.throwIfAborted()
  const existing = graphApproval.getStore()
  const sessionKey = getAgentSessionKey(input.route)
  if (
    existing?.active &&
    !existing.consumed &&
    existing.toolName === input.toolName &&
    existing.sessionKey === sessionKey &&
    existing.route === canonicalPolicyJson(input.route as PolicyJsonRecord) &&
    existing.args === canonicalPolicyJson(input.args as PolicyJsonRecord)
  ) {
    existing.consumed = true
    return
  }
  const request = assertPolicyRequest({
    ...createAssistantToolPolicyRequest({
      requestId: randomUUID(),
      actor: { kind: 'agent', id: input.route.senderId || sessionKey },
      target: { kind: 'tool', id: input.toolName },
      route: { ...input.route },
      sessionId: sessionKey,
      toolInput: input.args as PolicyJsonRecord
    }),
    action: 'creative.invoke'
  })
  const runtime = getAssistantTerminalPolicyRuntime()
  const reference = await runtime.requestTerminalApproval(request, input.signal)
  input.signal?.throwIfAborted()
  const authorized = runtime.authorization.authorize({
    authorizationId: reference.authorizationId!,
    request,
    evaluatedAt: Date.now(),
    grantId: reference.grantId,
    expectedGrantUseCount: reference.expectedGrantUseCount,
    idempotencyKey: `creative-tool-authorize:${reference.authorizationId}`
  })
  if (authorized.status !== 'authorized')
    throw new Error(`Creative tool approval was not authorized: ${authorized.status}`)
  runtime.authorization.consumeExecutionPermit({
    permit: authorized.permit,
    request,
    consumedAt: Date.now(),
    idempotencyKey: `creative-tool-consume:${reference.authorizationId}`
  })
}
