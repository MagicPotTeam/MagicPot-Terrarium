import { randomUUID } from 'node:crypto'
import { webContents } from 'electron'
import type { AgentThreadInteractionScope } from '../../shared/api/agentThreadInteraction'
import type { ManagedFirstRunPaneScope, ManagedFirstRunPaneScopeReq } from '../../shared/api/agentThreadManagedFirstRun'
import type { ServiceInvocationContext } from '../../shared/api/apiUtils/serviceInvocation'
import { getAgentSessionKey } from '../../shared/agent'
import { captureManagedData } from '../magicAgentPlatform2/agents/managedRuntimeSnapshot'
import { authorizeAgentThreadScope } from './agentThreadScope'
import { agentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'

type Binding = { revision: number; update: symbol; key: string; token: string; lease?: AgentThreadInteractionChannel }
// Document DATA bindings, not instance owners. High water survives navigation,
// including same-URL replacement, until this exact WebContents is destroyed.
const bindings = new Map<number, Binding>()
function fail(): never { throw Error('Managed first-run pane is not current or authenticated.') }
const exact = (value: object, keys: readonly string[]): void => { if (Object.keys(value).some(key => !keys.includes(key))) fail() }
function scopeData<T extends AgentThreadInteractionScope>(input: T, keys: readonly string[]): T {
  const value = captureManagedData(input)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  exact(value, keys)
  if (!value.route || typeof value.route !== 'object' || Array.isArray(value.route)) fail()
  exact(value.route, ['channel', 'scopeType', 'scopeId', 'threadId'])
  return value
}
function authenticate(scope: AgentThreadInteractionScope, input: ServiceInvocationContext | undefined, method: string): { sender: number; invocation: ServiceInvocationContext } {
  if (!input) fail()
  const invocation = captureManagedData(input)
  exact(invocation, ['methodName', 'senderId', 'senderUrl', 'frameUrl', 'isMainFrame'])
  return { sender: authorizeAgentThreadScope(scope, invocation, method), invocation }
}
const identity = (scope: AgentThreadInteractionScope): string => JSON.stringify([getAgentSessionKey(scope.route), scope.conversationId])

/** MAIN authentication for the dedicated identity-only IPC endpoints. No execution authority. */
export function managedFirstRunPaneRevision(input: AgentThreadInteractionScope, invocation?: ServiceInvocationContext): { revision: number } {
  const scope = scopeData(input, ['route', 'conversationId'])
  const { sender } = authenticate(scope, invocation, 'managedFirstRunPaneRevision')
  return { revision: bindings.get(sender)?.revision ?? 0 }
}
export function setManagedFirstRunPaneScope(input: ManagedFirstRunPaneScopeReq, invocation?: ServiceInvocationContext): { documentToken?: string } {
  const scope = scopeData(input, ['route', 'conversationId', 'active', 'lifecycleRevision'])
  if (typeof scope.active !== 'boolean' || !Number.isSafeInteger(scope.lifecycleRevision) || scope.lifecycleRevision < 1 || scope.lifecycleRevision >= Number.MAX_SAFE_INTEGER) fail()
  const access = authenticate(scope, invocation, 'setManagedFirstRunPaneScope'), key = identity(scope)
  let binding = bindings.get(access.sender)
  if (binding && scope.lifecycleRevision < binding.revision) fail()
  if (!binding) {
    if (bindings.size >= 32) throw Error('Managed first-run pane capacity reached.')
    binding = { revision: 0, update: Symbol(), key: '', token: '' }
    bindings.set(access.sender, binding)
    const owned = binding
    webContents.fromId(access.sender)!.once('destroyed', () => {
      if (bindings.get(access.sender) !== owned) return
      bindings.delete(access.sender)
      const lease = owned.lease; owned.token = ''; owned.lease = undefined; lease?.dispose()
    })
  }
  if (scope.lifecycleRevision === binding.revision) {
    if (binding.key !== key) fail()
    if (scope.active) {
      if (!binding.token || !binding.lease) fail()
      binding.lease.assertLive()
      return { documentToken: binding.token }
    }
  }
  // Retire original eligibility BEFORE dispose can synchronously re-enter via an
  // abort listener. Such a listener must not erase a newer revision's lease.
  // The private update identity also invalidates an outer activation when an
  // abort listener retires exactly that revision, leaving identical empty data.
  const prior = binding.lease, update = Symbol()
  binding.update = update; binding.revision = scope.lifecycleRevision; binding.key = key; binding.token = ''; binding.lease = undefined
  prior?.dispose()
  const current = () => bindings.get(access.sender) === binding && binding.update === update && binding.revision === scope.lifecycleRevision && binding.key === key && !binding.lease && !binding.token
  if (!current()) fail()
  if (!scope.active) return {}
  const lease = agentThreadInteractions.createScoped(scope, access.invocation)
  if (!lease) fail()
  if (!current()) { lease.dispose(); fail() }
  const token = randomUUID(), owned = binding
  binding.lease = lease; binding.token = token
  lease.signal.addEventListener('abort', () => {
    if (bindings.get(access.sender) === owned && owned.token === token) { owned.token = ''; owned.lease = undefined }
  }, { once: true })
  if (lease.signal.aborted) { binding.token = ''; binding.lease = undefined; fail() }
  return { documentToken: token }
}

export type CapturedManagedFirstRunPane = Readonly<{
  signal: AbortSignal
  document: Readonly<{ senderId: number; conversationId: string; revision: number }>
  actor: Readonly<{ kind: 'user'; id: 'magicpot-desktop-user' }>
  assertLive(): void
}>
/** Token possession alone is not authority: exact current sender/frame/URL and
 * binding are checked now and at each dispatch recheck. No grant is created. */
export function captureManagedFirstRunPane(input: ManagedFirstRunPaneScope, invocation: ServiceInvocationContext | undefined, method: string): CapturedManagedFirstRunPane {
  if (!['startManagedFirstRun', 'stopManagedFirstRun', 'managedFirstRunStatus'].includes(method)) fail()
  const scope = scopeData(input, ['route', 'conversationId', 'documentToken'])
  const access = authenticate(scope, invocation, method), binding = bindings.get(access.sender), key = identity(scope)
  if (!binding?.lease || !binding.token || typeof scope.documentToken !== 'string' || scope.documentToken !== binding.token || binding.key !== key) fail()
  const lease = binding.lease, token = binding.token
  const assertLive = () => {
    authenticate(scope, access.invocation, method)
    if (bindings.get(access.sender) !== binding || binding.lease !== lease || binding.token !== token || binding.key !== key) fail()
    lease.assertLive()
  }
  assertLive()
  return Object.freeze({ signal: lease.signal, document: Object.freeze({ senderId: access.sender, conversationId: scope.conversationId, revision: binding.revision }), actor: Object.freeze({ kind: 'user' as const, id: 'magicpot-desktop-user' as const }), assertLive })
}
