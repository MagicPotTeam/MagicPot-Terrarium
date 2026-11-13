import { randomUUID } from 'node:crypto'
import type { AgentHtmlScope, AgentHtmlScopeReq } from '@shared/api/agentThreadHtml'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { agentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'
import { authorizeAgentThreadScope } from './agentThreadScope'

const bindings = new Map<number, { revision: number; token: string; key: string; lease: AgentThreadInteractionChannel }>()
const identity = (scope: AgentHtmlScopeReq | AgentHtmlScope) => JSON.stringify([scope.route.channel, scope.route.scopeType, scope.route.scopeId, scope.route.threadId, scope.conversationId])
/** Lifecycle identity only; it grants no HTML execution, file, or code authority. */
export function setAgentHtmlScope(req: AgentHtmlScopeReq, invocation: ServiceInvocationContext): { documentToken?: string } {
  const sender = authorizeAgentThreadScope(req, invocation, 'setAgentHtmlScope')
  if (!Number.isSafeInteger(req.lifecycleRevision) || req.lifecycleRevision < 1 || typeof req.active !== 'boolean') throw new Error('Invalid HTML scope lifecycle.')
  const old = bindings.get(sender), key = identity(req)
  if (old && req.lifecycleRevision < old.revision) throw new Error('Stale HTML scope lifecycle.')
  if (!req.active) {
    if (old && old.key === key && old.revision === req.lifecycleRevision) old.token = ''
    return {}
  }
  if (old && old.revision === req.lifecycleRevision) {
    if (old.key !== key || !old.token) throw new Error('Retired HTML scope lifecycle.')
    old.lease.assertLive(); return { documentToken: old.token }
  }
  if (!old && bindings.size >= 32) throw new Error('HTML document scope capacity reached.')
  const lease = agentThreadInteractions.createScoped(req, invocation)
  if (!lease) throw new Error('HTML scope requires a trusted document.')
  const binding: { revision: number; token: string; key: string; lease: AgentThreadInteractionChannel } = { revision: req.lifecycleRevision, token: randomUUID(), key, lease }
  old?.lease.dispose(); bindings.set(sender, binding)
  lease.signal.addEventListener('abort', () => { binding.token = ''; if (bindings.get(sender) === binding) bindings.delete(sender) }, { once: true })
  return { documentToken: binding.token }
}
export function captureAgentHtmlScope(scope: AgentHtmlScope, invocation: ServiceInvocationContext, method: string): () => void {
  const sender = authorizeAgentThreadScope(scope, invocation, method), binding = bindings.get(sender)
  if (!binding || !binding.token || scope.documentToken !== binding.token || identity(scope) !== binding.key) throw new Error('HTML active conversation changed; refresh its document binding.')
  return () => {
    authorizeAgentThreadScope(scope, invocation, method)
    if (bindings.get(sender) !== binding || !binding.token || scope.documentToken !== binding.token) throw new Error('HTML active conversation changed.')
    binding.lease.assertLive()
  }
}
