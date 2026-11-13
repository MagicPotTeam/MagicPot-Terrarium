import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import { randomUUID } from 'node:crypto'
import { webContents } from 'electron'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentSkillScope, AgentSkillScopeReq } from '@shared/api/agentThreadSkillSession'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { authorizeAgentThreadScope } from './agentThreadScope'
import { agentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'
type Binding = { revision: number; token: string; key: string; lease?: AgentThreadInteractionChannel }
const bindings = new Map<number, Binding>()
const identity = (scope: AgentSkillScope | AgentSkillScopeReq) => JSON.stringify([getAgentSessionKey(normalizeAgentRoute(scope.route)), scope.conversationId])
/** Current user surface binding only. Retirements keep a high-water mark, never permissions. */
export function setAgentSkillScope(req: AgentSkillScopeReq, invocation: ServiceInvocationContext | undefined): { documentToken?: string } {
  const sender = authorizeAgentThreadScope(req, invocation, 'setAgentSkillScope')
  if (!Number.isSafeInteger(req.lifecycleRevision) || req.lifecycleRevision < 1 || typeof req.active !== 'boolean') throw new Error('Invalid skill preference scope lifecycle.')
  let binding = bindings.get(sender)
  const key = identity(req)
  if (binding && req.lifecycleRevision < binding.revision) throw new Error('Stale skill preference scope lifecycle.')
  if (!binding) {
    if (bindings.size >= 32) throw new Error('Skill preference scope capacity reached.')
    binding = { revision: 0, token: '', key: '', lease: undefined }; bindings.set(sender, binding)
    const owned = binding
    // IDs cannot be reused within this live WebContents. Retired navigation entries
    // survive until actual destruction so delayed activations cannot resurrect them.
    webContents.fromId(sender)!.once('destroyed', () => { if (bindings.get(sender) === owned) { owned.lease?.dispose(); bindings.delete(sender) } })
  }
  if (!req.active) {
    if (req.lifecycleRevision === binding.revision && binding.key !== key) throw new Error('Skill preference scope lifecycle conflict.')
    binding.lease?.dispose(); binding.lease = undefined; binding.token = ''; binding.key = key; binding.revision = req.lifecycleRevision
    return {}
  }
  if (req.lifecycleRevision === binding.revision) {
    if (binding.key !== key || !binding.token || !binding.lease) throw new Error('Retired skill preference scope lifecycle.')
    binding.lease.assertLive(); return { documentToken: binding.token }
  }
  const lease = agentThreadInteractions.createScoped(req, invocation!)
  if (!lease) throw new Error('Skill preferences require a trusted document.')
  binding.lease?.dispose()
  const token = String(randomUUID())
  Object.assign(binding, { revision: req.lifecycleRevision, token, key, lease })
  const owned = binding
  lease.signal.addEventListener('abort', () => { if (bindings.get(sender) === owned && owned.token === token) { owned.token = ''; owned.lease = undefined } }, { once: true })
  return { documentToken: token }
}
export function agentSkillScopeRevision(req: AgentThreadInteractionScope, invocation: ServiceInvocationContext | undefined): { revision: number } {
  const sender = authorizeAgentThreadScope(req, invocation, 'agentSkillScopeRevision')
  return { revision: bindings.get(sender)?.revision ?? 0 }
}
export function captureAgentSkillScope(req: AgentSkillScope, invocation: ServiceInvocationContext | undefined, method: string): () => void {
  const sender = authorizeAgentThreadScope(req, invocation, method), binding = bindings.get(sender), token = req.documentToken
  if (!binding || !binding.token || token !== binding.token || identity(req) !== binding.key) throw new Error('Skill preference active conversation changed; refresh binding.')
  return () => { authorizeAgentThreadScope(req, invocation, method); if (bindings.get(sender) !== binding || !binding.token || token !== binding.token) throw new Error('Skill preference active conversation changed.'); binding.lease!.assertLive() }
}
