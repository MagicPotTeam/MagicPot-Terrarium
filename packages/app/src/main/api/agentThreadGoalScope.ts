import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { AgentGoalScope, AgentGoalScopeReq } from '@shared/api/agentThreadGoal'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { randomUUID } from 'node:crypto'
import { webContents } from 'electron'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import { authorizeAgentThreadScope } from './agentThreadScope'
import { agentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'
type Binding = { revision: number; token: string; key: string; lease?: AgentThreadInteractionChannel }
const bindings = new Map<number, Binding>()
const identity = (scope: AgentThreadInteractionScope) => JSON.stringify([getAgentSessionKey(normalizeAgentRoute(scope.route)), scope.conversationId])
/** User-record surface identity, not a wake ticket or execution permission. */
export function setAgentGoalScope(req: AgentGoalScopeReq, invocation?: ServiceInvocationContext): { documentToken?: string } {
  const sender = authorizeAgentThreadScope(req, invocation, 'setAgentGoalScope')
  if (!Number.isSafeInteger(req.lifecycleRevision) || req.lifecycleRevision < 1 || req.lifecycleRevision >= Number.MAX_SAFE_INTEGER || typeof req.active !== 'boolean' || Object.keys(req).some(key => !['route', 'conversationId', 'active', 'lifecycleRevision'].includes(key))) throw new Error('Invalid goal scope lifecycle.')
  let binding = bindings.get(sender)
  const key = identity(req)
  if (binding && req.lifecycleRevision < binding.revision) throw new Error('Stale goal scope lifecycle.')
  if (!binding) {
    if (bindings.size >= 32) throw new Error('Goal scope capacity reached.')
    binding = { revision: 0, token: '', key: '' }; bindings.set(sender, binding)
    const owned = binding
    webContents.fromId(sender)!.once('destroyed', () => { if (bindings.get(sender) === owned) { owned.lease?.dispose(); bindings.delete(sender) } })
  }
  if (!req.active) {
    if (req.lifecycleRevision === binding.revision && binding.key !== key) throw new Error('Goal scope lifecycle conflict.')
    binding.lease?.dispose(); binding.lease = undefined; binding.token = ''; binding.key = key; binding.revision = req.lifecycleRevision
    return {}
  }
  if (req.lifecycleRevision === binding.revision) {
    if (binding.key !== key || !binding.token || !binding.lease) throw new Error('Retired goal scope lifecycle.')
    binding.lease.assertLive(); return { documentToken: binding.token }
  }
  const lease = agentThreadInteractions.createScoped(req, invocation!)
  if (!lease) throw new Error('Goal records require a live trusted document.')
  binding.lease?.dispose()
  const token = String(randomUUID()); Object.assign(binding, { revision: req.lifecycleRevision, token, key, lease })
  const owned = binding
  lease.signal.addEventListener('abort', () => { if (bindings.get(sender) === owned && owned.token === token) { owned.token = ''; owned.lease = undefined } }, { once: true })
  return { documentToken: token }
}
export function agentGoalScopeRevision(req: AgentThreadInteractionScope, invocation?: ServiceInvocationContext): { revision: number } {
  const sender = authorizeAgentThreadScope(req, invocation, 'agentGoalScopeRevision')
  return { revision: bindings.get(sender)?.revision ?? 0 }
}
export function captureAgentGoalScope(req: AgentGoalScope, invocation: ServiceInvocationContext | undefined, method: string): (() => void) & { readonly signal: AbortSignal } {
  const sender = authorizeAgentThreadScope(req, invocation, method), binding = bindings.get(sender), token = req.documentToken
  if (!binding || !binding.token || token !== binding.token || identity(req) !== binding.key) throw new Error('Goal active conversation changed; refresh binding.')
  const assertLive = () => { authorizeAgentThreadScope(req, invocation, method); if (bindings.get(sender) !== binding || !binding.token || token !== binding.token) throw new Error('Goal active conversation changed.'); binding.lease!.assertLive() }
  return Object.assign(assertLive, { signal: binding.lease!.signal })
}
