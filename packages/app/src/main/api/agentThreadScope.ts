import { BrowserWindow, webContents } from 'electron'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { authorizeMagicAgentApprovalRenderer } from '../magicAgentRuntime/trustedRouteBinding'

const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)

/** Main-frame IPC identity, project URL and explicit thread/conversation scope. */
export function authorizeAgentThreadScope(scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext | undefined, method: string): number {
  if (!invocation || invocation.methodName !== `svcLLMProxy.${method}` || !Number.isSafeInteger(invocation.senderId) ||
    !scope || !safeId(scope.conversationId) || scope.route?.channel !== 'canvas' || scope.route.scopeType !== 'thread' ||
    !safeId(scope.route.scopeId) || !safeId(scope.route.threadId)) throw new Error('Agent interaction access denied.')
  authorizeMagicAgentApprovalRenderer(invocation)
  const sender = webContents.fromId(invocation.senderId!)
  const parent = sender && BrowserWindow.fromWebContents(sender)
  const url = sender?.getURL()
  if (!sender || sender.isDestroyed() || !parent || parent.isDestroyed() || parent.webContents !== sender || !url || url !== invocation.frameUrl || url !== invocation.senderUrl) throw new Error('Agent interaction access denied.')
  const hash = new URL(url).hash.slice(1)
  const separator = hash.indexOf('?')
  const ids = new URLSearchParams(hash.slice(separator + 1)).getAll('id')
  if (separator < 0 || hash.includes('#') || !['/canvas', '/project-webgl'].includes(hash.slice(0, separator)) || ids.length !== 1 || ids[0] !== scope.route.scopeId)
    throw new Error('Agent interaction access denied.')
  return sender.id
}
