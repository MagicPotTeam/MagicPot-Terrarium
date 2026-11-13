import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { McpClientManager, type McpConnectionControl, type McpConnectionIdentity } from '../mcp/clientManager'
import { createAgentThreadMcpConnectionTools } from './agentThreadMcpConnections'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const
const setup = (manage = true) => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.mcp_config.client.servers = [{ id: 'echo', enabled: true, autoConnect: false, agentThreadAccess: 'discover', agentThreadManage: manage, transport: 'stdio', command: process.execPath, args: [path.resolve('scripts/mcp/echoServer.cjs')], env: { SECRET: 'DO_NOT_DISCLOSE' } }]
  const controller = new AbortController(), consume = vi.fn(), approve = vi.fn(async () => consume)
  const expected: McpConnectionIdentity = { serverId: 'echo', revision: 'r1', connectionId: null, configDigest: null, status: 'absent', suppressed: false }
  const manager = { connectionIdentity: vi.fn(() => structuredClone(expected)), controlConnection: vi.fn(async (input: McpConnectionControl): Promise<McpConnectionIdentity> => { input.assertLive(); input.beforeDispatch(); return { ...expected, revision: 'r2', connectionId: 'instance', status: input.action === 'connect' ? 'connected' : 'disconnected', suppressed: input.action === 'disconnect' } }) }
  const options = { route, conversationId: 'chat', signal: controller.signal, config: () => config, assertInvocation: vi.fn(), assertLive: vi.fn(), manager, approve }
  const provider = createAgentThreadMcpConnectionTools(options)
  const call = (name = 'mcp_connect', args: Record<string, unknown> = { server: 'echo' }) => provider.callTool(name, args, { route, runId: 'r' })
  return { config, controller, consume, approve, expected, manager, options, provider, call }
}
afterEach(() => { closeAssistantTerminalPolicyRuntime(); vi.restoreAllMocks() })
describe('thread approved MCP connection controls', () => {
  it('defaults off and never gains management merely from call access or a later setting', async () => {
    const t = setup(false); t.config.mcp_config.client.servers[0].agentThreadAccess = 'call'
    expect(t.provider.listTools()).toEqual([])
    t.config.mcp_config.client.servers[0].agentThreadManage = true
    await expect(t.call()).rejects.toThrow('outside')
    expect(t.approve).not.toHaveBeenCalled()
  })
  it('requires exact service approval and returns identity/status, never credentials or process-tree promises', async () => {
    const t = setup(); expect(JSON.parse((await t.call()).content)).toMatchObject({ connected: true, sharedHostConnection: true, processTreeTerminationGuaranteed: false })
    expect(t.approve).toHaveBeenCalledWith(expect.objectContaining({ server: 'echo', expected: t.expected, tool: 'mcp_connect' }), expect.any(AbortSignal))
    expect(JSON.stringify(t.approve.mock.calls)).not.toContain('DO_NOT_DISCLOSE')
    expect(t.consume).toHaveBeenCalledOnce()
    expect(JSON.parse((await t.call('mcp_disconnect')).content)).toMatchObject({ suppressed: true, status: 'disconnected' })
  })
  it.each(['config', 'manage', 'access', 'cancel', 'remote'])('rechecks %s changed during approval before dispatch', async (kind) => {
    const t = setup()
    t.approve.mockImplementationOnce(async () => {
      if (kind === 'config') t.config.mcp_config.client.servers[0].command = 'different'
      else if (kind === 'manage') t.config.mcp_config.client.servers[0].agentThreadManage = false
      else if (kind === 'access') t.config.mcp_config.client.servers[0].agentThreadAccess = 'off'
      else if (kind === 'remote') t.config.use_remote_llm = true
      else t.controller.abort()
      return t.consume
    })
    await expect(t.call()).rejects.toThrow()
    expect(t.manager.controlConnection).not.toHaveBeenCalled(); expect(t.consume).not.toHaveBeenCalled()
  })
  it('rejects cross-route, arbitrary connection parameters, unknown/foreign servers and rechecks dispatch liveness', async () => {
    const t = setup()
    await expect(t.provider.callTool('mcp_connect', { server: 'echo' }, { route: { ...route, scopeId: 'other' }, runId: 'r' })).rejects.toThrow('outside')
    await expect(t.call('mcp_connect', { server: 'echo', command: 'evil' })).rejects.toThrow('Only a configured')
    await expect(t.call('mcp_connect', { server: 'private' })).rejects.toThrow('not authorized')
    expect(t.approve).not.toHaveBeenCalled()
    t.manager.controlConnection.mockImplementationOnce(async (input) => { t.controller.abort(); input.beforeDispatch(); return t.expected })
    await expect(t.call()).rejects.toThrow('outcome may be unknown')
    expect(t.consume).not.toHaveBeenCalled()
  })
  it('caps request attempts and does not expose raw remote failures', async () => {
    const t = setup()
    t.manager.controlConnection.mockRejectedValueOnce(new Error('Authorization: SECRET_PATH'))
    await expect(t.call()).rejects.toThrow('outcome may be unknown')
    for (let i = 0; i < 3; i++) await t.call()
    await expect(t.call()).rejects.toThrow('budget')
    expect(t.manager.controlConnection).toHaveBeenCalledTimes(4)
  })
  it('holds one management operation per conversation and four globally, then releases after denial', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const held = Array.from({ length: 4 }, (_, i) => {
      const t = setup(); t.options.conversationId = `held-${i}`
      t.approve.mockImplementation(async () => { await gate; throw new Error('denied') })
      return { t, provider: createAgentThreadMcpConnectionTools(t.options) }
    })
    const pending = held.map(({ provider }) => provider.callTool('mcp_connect', { server: 'echo' }, { route, runId: 'r' }).catch((e) => e))
    try {
      await vi.waitFor(() => held.forEach(({ t }) => expect(t.approve).toHaveBeenCalledOnce()))
      await expect(held[0].provider.callTool('mcp_connect', { server: 'echo' }, { route, runId: 'r2' })).rejects.toThrow('concurrency')
      const fifth = setup(); await expect(fifth.call()).rejects.toThrow('concurrency')
      release(); await Promise.all(pending)
      await expect(fifth.call()).resolves.toMatchObject({ content: expect.any(String) })
      held.forEach(({ t }) => expect(t.manager.controlConnection).not.toHaveBeenCalled())
    } finally { release(); await Promise.all(pending) }
  })
  it('snapshots service arguments before an approval wait and rejects active properties', async () => {
    const t = setup(), args = { server: 'echo' }
    t.approve.mockImplementationOnce(async () => { args.server = 'foreign'; return t.consume })
    await t.call('mcp_connect', args)
    expect(t.manager.controlConnection).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'echo' }))
    const getter = vi.fn(() => 'echo')
    await expect(t.call('mcp_connect', Object.defineProperty({}, 'server', { enumerable: true, get: getter }))).rejects.toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
  it.each(['approve', 'deny', 'cancel'])('uses real production connection approval (%s) before real local stdio launch', async (outcome) => {
    const t = setup(), manager = new McpClientManager()
    const provider = createAgentThreadMcpConnectionTools({ ...t.options, manager, approve: undefined })
    const policy = getAssistantTerminalPolicyRuntime()
    try {
      await manager.sync(t.config); expect(manager.listConnections()).toEqual([])
      const pending = provider.callTool('mcp_connect', { server: 'echo' }, { route, runId: 'real' }).catch((error) => error)
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
      expect(manager.listConnections()).toEqual([])
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.input).toMatchObject({ server: 'echo', transport: 'stdio', sharedHostConnection: true })
      expect(JSON.stringify(approval)).not.toContain('DO_NOT_DISCLOSE')
      if (outcome === 'cancel') t.controller.abort()
      else policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: outcome === 'approve' })
      const result = await pending
      if (outcome === 'approve') {
        expect(JSON.parse(result.content)).toMatchObject({ connected: true })
        expect(manager.listPinnedTools('echo').map((tool) => tool.name)).toEqual(['echo', 'fail'])
      } else { expect(result).toBeInstanceOf(Error); expect(manager.listConnections()).toEqual([]) }
      expect(policy.listPendingTerminalApprovals()).toEqual([])
    } finally { t.controller.abort(); await manager.stop() }
  })
})
