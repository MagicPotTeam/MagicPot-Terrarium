import path from 'node:path'
import { getAgentSessionKey, type AgentRouteLike } from '../../../shared/agent'
import { canonicalPolicyJson, type PolicyRequest } from '../../../shared/magicAgentPlatform2'
import { managedDigest } from '../agents/managedRuntimeSnapshot'

type Data = Record<string, unknown>
const object = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value)
const fields = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Data => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const string = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(value)
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const empty = (value: unknown): boolean => Array.isArray(value) && value.length === 0
const same = (left: unknown, right: unknown): boolean => canonicalPolicyJson(left as never) === canonicalPolicyJson(right as never)
function route(value: unknown, generic = false): value is AgentRouteLike & Data {
  return fields(value, ['channel', 'scopeType', 'scopeId'], ['threadId', 'senderId', 'senderName']) && string(value.channel, 64) && (!generic || value.channel === 'generic') && ['dm', 'thread'].includes(String(value.scopeType)) && string(value.scopeId) && ['threadId', 'senderId', 'senderName'].every(key => value[key] === undefined || string(value[key]))
}
function model(value: unknown): value is Data {
  if (!fields(value, ['protocol', 'profileId', 'route', 'endpoint', 'credentialBinding', 'requestTimeoutMs', 'modelAttempts', 'tools', 'history', 'body', 'transport']) || value.protocol !== 'managed-text-first-run/v1' || !id(value.profileId) || !route(value.route, true) || !string(value.endpoint, 2048) || typeof value.credentialBinding !== 'string' || !/^[a-f0-9]{64}$/u.test(value.credentialBinding) || !integer(value.requestTimeoutMs, 1000, 120000) || value.modelAttempts !== 1 || !empty(value.tools) || value.history !== 'none') return false
  // Only the implemented final-close path is classified here. A whole-job DTO is
  // not an implementation, approval upgrade or fallback for the excluded runtime.
  if (!same(value.transport, { protocol: 'electron-client-request-final-close/v1' })) return false
  const endpoint = new URL(value.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.href !== value.endpoint || !/^\/(?:[A-Za-z0-9_-]+\/)*chat\/completions$/u.test(endpoint.pathname)) return false
  const body = value.body
  if (!fields(body, ['model', 'messages', 'temperature', 'stream', 'max_tokens']) || !string(body.model, 200) || body.stream !== false || !integer(body.max_tokens, 1, 4096) || typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2 || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 2 || Buffer.byteLength(JSON.stringify(body)) > 65536) return false
  const messages = body.messages
  return messages.every((message, index) => fields(message, ['role', 'content']) && message.role === (index === messages.length - 1 ? 'user' : 'system') && typeof message.content === 'string' && message.content.trim().length > 0 && (message.role !== 'user' || !/^\s*\/[a-z]/iu.test(message.content)))
}
function finalInput(value: unknown): value is Data & { model: Data; storage: Data & { route: AgentRouteLike } } {
  if (!fields(value, ['protocol', 'route', 'model', 'storage', 'digest']) || value.protocol !== 'assistant-final-input/v1' || !route(value.route, true) || !model(value.model) || !same(value.route, value.model.route)) return false
  const { digest, ...body } = value
  if (typeof digest !== 'string' || digest !== managedDigest('assistant-final-input/v1', body)) return false
  const storage = value.storage
  if (!fields(storage, ['route', 'workspace', 'history', 'reusableContext', 'eventDelivery']) || storage.history !== 'new-private-session' || storage.reusableContext !== 'none' || storage.eventDelivery !== 'awaited-store-only' || !fields(storage.route, ['channel', 'scopeType', 'scopeId']) || storage.route.channel !== 'generic' || storage.route.scopeType !== 'dm' || typeof storage.route.scopeId !== 'string' || !/^managed-first-run-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(storage.route.scopeId)) return false
  const workspace = storage.workspace
  if (!fields(workspace, ['workspaceId', 'workspaceRootDir', 'workspaceMetaFile', 'rootDir', 'memoryDir', 'memoryFile', 'contextFile', 'taskContextFile', 'pinnedContextFile']) || workspace.workspaceId !== storage.route.scopeId || !Object.values(workspace).every(value => string(value, 4096)) || !path.isAbsolute(String(workspace.rootDir))) return false
  const base = path.dirname(String(workspace.rootDir)), namespace = storage.route.scopeId
  // Pure structural namespace check; these paths/digests are not live authority.
  // Actual runtime consumes its private captured plan, never this request DTO.
  if (path.basename(base) !== 'chat-workspaces' || workspace.rootDir !== path.join(base, `generic_dm_${namespace}`) || workspace.workspaceRootDir !== path.join(base, '_workspaces', namespace) || workspace.workspaceMetaFile !== path.join(String(workspace.workspaceRootDir), 'workspace.json') || workspace.memoryDir !== path.join(String(workspace.rootDir), 'memory') || workspace.contextFile !== path.join(String(workspace.rootDir), 'context.json') || workspace.taskContextFile !== path.join(String(workspace.rootDir), 'task-context.json') || workspace.pinnedContextFile !== path.join(String(workspace.rootDir), 'pinned-context.json') || typeof workspace.memoryFile !== 'string' || !/^\d{4}-\d{2}-\d{2}\.md$/u.test(path.basename(workspace.memoryFile)) || path.dirname(workspace.memoryFile) !== workspace.memoryDir) return false
  return true
}
/** Fixed production data contract, not a pane/owner/plan validator or permit.
 * Called only after the existing policy parser captured safe immutable JSON.
 * Non-managed actions are unaffected. Unknown/new transport material fails closed.
 */
export function matchesProductionManagedFirstRunContract(request: PolicyRequest): boolean {
  if (!request.action.startsWith('agent.instance.managed.')) return true
  try {
    const action = request.action.slice('agent.instance.managed.'.length), input = request.input, target = request.target.id
    if (!['birth', 'start', 'stop'].includes(action) || !fields(request, ['discriminator', 'version', 'requestId', 'actor', 'origin', 'action', 'target', 'input', 'effects', 'allowedToolNames', 'runId'], action === 'stop' ? [] : ['budget']) || !same(request.actor, { kind: 'user', id: 'magicpot-desktop-user' }) || request.origin !== 'internal' || !same(request.target, { kind: 'agent-instance', id: target }) || !id(target) || !id(request.runId) || !empty(request.allowedToolNames)) return false
    const lifecycle = { kind: 'agent.lifecycle', target, risk: 'high' }
    if (action === 'stop') {
      return fields(input, ['instanceId', 'runId', 'revision', 'ownerEpoch']) && input.instanceId === target && input.runId === request.runId && integer(input.revision, 0) && string(input.ownerEpoch, 200) && same(request.effects, [{ ...lifecycle, metadata: { action: 'stop', runId: request.runId } }])
    }
    if (!fields(input, ['protocol', 'runId', 'document', 'configVersion', 'finalInput', ...(action === 'birth' ? ['instance'] : ['generation', 'instanceRevision', 'coverageRevision', 'sessionKey', 'acceptance'])]) || input.protocol !== 'managed-first-run-policy/v2' || input.runId !== request.runId || request.requestId !== `managed-first-run:${request.runId}:${action}` || !string(input.configVersion, 256) || !fields(input.document, ['senderId', 'conversationId', 'revision'], ['paneRoute']) || !integer(input.document.senderId, 1) || !string(input.document.conversationId) || !integer(input.document.revision, 1) || input.document.paneRoute !== undefined && !route(input.document.paneRoute) || !finalInput(input.finalInput)) return false
    const material = input.finalInput, body = material.model.body as Data
    if (!same(request.budget, { modelRequests: 1, toolCalls: 0, maxOutputTokens: body.max_tokens })) return false
    if (action === 'start') {
      return string(input.generation, 200) && input.instanceRevision === 0 && input.coverageRevision === 0 && input.sessionKey === getAgentSessionKey(material.storage.route) && same(input.acceptance, { protocol: 'assistant-final-input/v1', runId: request.runId, finalInputDigest: material.digest }) && same(request.effects, [lifecycle, { kind: 'network.write', target: material.model.endpoint, risk: 'high' }])
    }
    const instance = input.instance
    return fields(instance, ['id', 'name', 'ownerId', 'definitionId', 'configVersion', 'depth', 'status', 'limits']) && instance.id === target && typeof instance.name === 'string' && instance.name.trim().length > 0 && instance.name.length <= 200 && instance.ownerId === request.actor.id && instance.definitionId === `managed-first-run:${target}` && instance.configVersion === input.configVersion && instance.depth === 0 && instance.status === 'created' && same(instance.limits, { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: material.model.requestTimeoutMs, allowedToolNames: [], workspaceRoots: [] }) && same(request.effects, [lifecycle])
  } catch { return false }
}
