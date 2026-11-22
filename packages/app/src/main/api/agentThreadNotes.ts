import { randomUUID } from 'node:crypto'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { MutateAgentThreadNoteReq } from '@shared/api/agentThreadMemory'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { assertPolicyRequest, createAssistantToolPolicyRequest, type PolicyJsonRecord } from '@shared/magicAgentPlatform2'
import { getAgentSessionKey } from '@shared/agent'
import { agentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'
import { authorizeAgentThreadScope } from './agentThreadScope'
import { getAgentThreadNotesStore, validateAgentNoteMutation, type AgentThreadNotesStore } from './agentThreadNotesStore'

export async function approveAgentNoteMutation(req: MutateAgentThreadNoteReq, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const request = assertPolicyRequest({
    ...createAssistantToolPolicyRequest({ requestId: randomUUID(), actor: { kind: 'agent', id: getAgentSessionKey(req.route) }, target: { kind: 'tool', id: 'scratchpad' }, route: { ...req.route }, sessionId: req.conversationId,
      toolInput: { conversationId: req.conversationId, action: req.action, ...(req.action === 'clear' ? { clearScope: 'current-conversation-notes-only' } : { key: req.key }), expectedRevision: req.expectedRevision, ...(req.value !== undefined ? { value: req.value } : {}) } as PolicyJsonRecord }),
    action: 'memory.note.write'
  })
  const { getAssistantTerminalPolicyRuntime } = await import('../magicAgentPlatform2/productionRuntime')
  const runtime = getAssistantTerminalPolicyRuntime()
  const reference = await runtime.requestTerminalApproval(request, signal)
  signal?.throwIfAborted()
  const authorization = runtime.authorization.authorize({ authorizationId: reference.authorizationId!, request, evaluatedAt: Date.now(), grantId: reference.grantId, expectedGrantUseCount: reference.expectedGrantUseCount, idempotencyKey: `note-authorize:${reference.authorizationId}` })
  if (authorization.status !== 'authorized') throw new Error('Agent note mutation was not authorized.')
  runtime.authorization.consumeExecutionPermit({ permit: authorization.permit, request, consumedAt: Date.now(), idempotencyKey: `note-consume:${reference.authorizationId}` })
}

export async function readAgentNotes(scope: AgentThreadInteractionScope, invocation?: ServiceInvocationContext) {
  const input = structuredClone(scope)
  authorizeAgentThreadScope(input, invocation, 'getAgentNotes')
  const lease = agentThreadInteractions.create({ route: input.route, conversationId: input.conversationId, messages: [] }, { ...invocation!, methodName: 'svcLLMProxy.chat' })
  if (!lease) throw new Error('Agent notes require a live document.')
  try {
    const store = await getAgentThreadNotesStore()
    lease.assertLive()
    authorizeAgentThreadScope(input, invocation, 'getAgentNotes')
    return store.get(input)
  } finally { lease.dispose() }
}

/** Shared by model tools and the explicit UI editor; a reply/card never grants this approval. */
export async function mutateAgentNote(req: MutateAgentThreadNoteReq, invocation: ServiceInvocationContext | undefined, options: {
  lease?: AgentThreadInteractionChannel
  signal?: AbortSignal
  assertLive?(): void
  store?: AgentThreadNotesStore
  approve?: typeof approveAgentNoteMutation
} = {}) {
  authorizeAgentThreadScope(req, invocation, options.lease ? invocation!.methodName.split('.').at(-1)! : 'mutateAgentNote')
  const input = structuredClone(req)
  validateAgentNoteMutation(input)
  const ownedLease = options.lease ? undefined : agentThreadInteractions.create({ route: input.route, conversationId: input.conversationId, messages: [] }, { ...invocation!, methodName: 'svcLLMProxy.chat' })
  const lease = options.lease ?? ownedLease
  if (!lease) throw new Error('Agent note mutation requires a live document.')
  const signal = AbortSignal.any([lease.signal, ...(options.signal ? [options.signal] : [])])
  try {
    signal.throwIfAborted(); lease.assertLive(); options.assertLive?.()
    const store = options.store ?? await getAgentThreadNotesStore()
    signal.throwIfAborted(); lease.assertLive()
    const replay = store.replay(input)
    if (replay) return replay
    // Validate before approval without writing, and CAS again after it.
    if (store.get(input).revision !== input.expectedRevision) throw new Error('Agent notes revision conflict; read again before saving.')
    await (options.approve ?? approveAgentNoteMutation)(input, signal)
    signal.throwIfAborted(); lease.assertLive(); options.assertLive?.()
    return store.mutate(input)
  } finally { ownedLease?.dispose() }
}
