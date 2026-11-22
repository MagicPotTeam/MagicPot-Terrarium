import { randomUUID } from 'node:crypto'
import Ajv from 'ajv'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import type { Config } from '@shared/config/config'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { mcpServerConfigDigest, type McpClientManager, type McpConnectionIdentity } from '../mcp/clientManager'
import { assertPolicyRequest, createAssistantToolPolicyRequest, type PolicyJsonRecord } from '@shared/magicAgentPlatform2'
const definitions = ['mcp_connect', 'mcp_disconnect'].map((name) => ({
  name,
  description: `${name === 'mcp_connect' ? 'Connect' : 'Disconnect'} one user-configured MCP service by server ID after separate connection-management opt-in and fresh formal approval. No model-supplied command/URL/credentials/config. Uses a shared host connection: disconnect affects other threads and explicit skill aliases. A successful disconnect suppresses auto-reconnect for this host session until a later approved connect or app restart. Unknown closure is quarantined, not proof of process exit/remote rollback. Inspect mcp_list for current service status; discover tools again after connecting.`,
  inputSchema: { type: 'object', additionalProperties: false, properties: { server: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' } }, required: ['server'] }
}))
const validate = new Ajv({ strict: false, ownProperties: true }).compile(definitions[0].inputSchema)
type ApprovalInput = { route: AgentRouteLike; conversationId: string; server: string; configDigest: string; expected: McpConnectionIdentity; tool: 'mcp_connect' | 'mcp_disconnect'; transport: string }
const scopes = new Set<string>()
let active = 0
export function createAgentThreadMcpConnectionTools(options: {
  route: AgentRouteLike; conversationId: string; signal: AbortSignal; config(): Config
  assertInvocation(name: string): void; assertLive(): void
  manager?: Pick<McpClientManager, 'connectionIdentity' | 'controlConnection'>
  approve?: typeof requestThreadMcpConnectionApproval
}): AssistantRunToolProvider {
  const route = Object.freeze(normalizeAgentRoute(options.route)), key = getAgentSessionKey(route)
  const initial = new Map<string, string>()
  const servers = options.config().mcp_config?.client?.servers ?? []
  for (const server of servers.slice(0, 128)) {
    if (server.enabled === true && server.agentThreadManage === true && ['discover', 'call'].includes(server.agentThreadAccess ?? '') && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(server.id) && servers.filter((item) => item.id === server.id).length === 1) initial.set(server.id, mcpServerConfigDigest(server))
  }
  let calls = 0
  return {
    listTools: () => structuredClone(initial.size ? definitions : []),
    async callTool(name, raw, context) {
      const signal = AbortSignal.any([options.signal, ...(context.signal ? [context.signal] : [])])
      const live = () => { signal.throwIfAborted(); options.assertLive(); options.assertInvocation(name) }
      live()
      if (!definitions.some((tool) => tool.name === name) || !initial.size || getAgentSessionKey(context.route) !== key) throw new Error('MCP connection tools are outside this Agent thread.')
      const args = cloneBoundedMcpJson(raw, 1024) as Record<string, unknown>
      if (!validate(args)) throw new Error('Invalid MCP connection arguments. Only a configured server ID is accepted.')
      const serverId = args.server as string
      const current = () => {
        live()
        const config = options.config(), matches = (config.mcp_config?.client?.servers ?? []).filter((server) => server.id === serverId), server = matches[0]
        if (config.use_remote_llm || matches.length !== 1 || server.enabled !== true || server.agentThreadManage !== true || !['discover', 'call'].includes(server.agentThreadAccess ?? '') || !initial.has(serverId) || mcpServerConfigDigest(server) !== initial.get(serverId)) throw new Error('MCP connection management is disabled, changed or not authorized for this request.')
        return server
      }
      const server = current()
      if (++calls > 4) throw new Error('MCP connection request budget exhausted.')
      const scope = JSON.stringify([key, options.conversationId])
      if (active >= 4 || scopes.has(scope)) throw new Error('MCP connection concurrency limit reached.')
      active++; scopes.add(scope)
      try {
        const manager = options.manager ?? (await import('../mcp/runtime')).getMcpClientManager()
        current()
        const expected = manager.connectionIdentity(serverId)
        if (['connecting', 'closing', 'close-unconfirmed'].includes(expected.status)) throw new Error('MCP connection state is unresolved; operation is unavailable.')
        const input: ApprovalInput = { route, conversationId: options.conversationId, server: serverId, configDigest: initial.get(serverId)!, expected, tool: name as ApprovalInput['tool'], transport: server.transport }
        const consume = await (options.approve ?? requestThreadMcpConnectionApproval)(input, signal)
        current()
        let result: McpConnectionIdentity
        try {
          result = await manager.controlConnection({ serverId, configDigest: input.configDigest, expected, action: name === 'mcp_connect' ? 'connect' : 'disconnect', config: options.config, signal, assertLive: () => { current() }, beforeDispatch: () => { current(); consume() } })
        } catch { throw new Error('MCP connection operation failed or was cancelled. Check service status; local process/remote effect outcome may be unknown. Do not blindly retry.') }
        current()
        return { content: JSON.stringify({ server: serverId, status: result.status, suppressed: result.suppressed, connected: result.status === 'connected', connectionId: result.connectionId, sharedHostConnection: true, processTreeTerminationGuaranteed: false, grantsPermission: false }), metadata: { source: 'agent-thread-mcp-connection' } }
      } finally { active--; scopes.delete(scope) }
    }
  }
}
async function requestThreadMcpConnectionApproval(input: ApprovalInput, signal: AbortSignal): Promise<() => void> {
  const { getAssistantTerminalPolicyRuntime } = await import('../magicAgentPlatform2/productionRuntime')
  signal.throwIfAborted()
  const runtime = getAssistantTerminalPolicyRuntime()
  const request = assertPolicyRequest({ ...createAssistantToolPolicyRequest({ requestId: randomUUID(), actor: { kind: 'agent', id: getAgentSessionKey(input.route) }, target: { kind: 'tool', id: input.tool }, route: { ...input.route }, sessionId: input.conversationId,
    toolInput: { server: input.server, configDigest: input.configDigest, expected: input.expected, transport: input.transport, sharedHostConnection: true, startupMayRunLocalCommand: input.transport === 'stdio' } as PolicyJsonRecord }), action: 'mcp.thread.connection' })
  const reference = await runtime.requestTerminalApproval(request, signal)
  let consumed = false
  return () => {
    signal.throwIfAborted()
    if (consumed) throw new Error('MCP connection permit was already used.')
    const authorization = runtime.authorization.authorize({ authorizationId: reference.authorizationId!, request, evaluatedAt: Date.now(), grantId: reference.grantId, expectedGrantUseCount: reference.expectedGrantUseCount, idempotencyKey: `mcp-connection-authorize:${reference.authorizationId}` })
    if (authorization.status !== 'authorized') throw new Error('MCP connection operation is not authorized.')
    runtime.authorization.consumeExecutionPermit({ permit: authorization.permit, request, consumedAt: Date.now(), idempotencyKey: `mcp-connection-consume:${reference.authorizationId}:${randomUUID()}` })
    consumed = true
  }
}
