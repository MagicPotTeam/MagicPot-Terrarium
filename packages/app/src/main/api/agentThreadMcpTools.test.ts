import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
import { DEFAULT_CONFIG, type McpExternalServerConfig } from '@shared/config/config'
import { McpClientManager, mcpServerConfigDigest, type McpPinnedTool } from '../mcp/clientManager'
import { createAgentThreadMcpTools } from './agentThreadMcpTools'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const server = (access: McpExternalServerConfig['agentThreadAccess'] = 'call'): McpExternalServerConfig => ({ id: 'echo', enabled: true, transport: 'stdio', command: process.execPath, args: [path.resolve('scripts/mcp/echoServer.cjs')], agentThreadAccess: access })
function setup(access: McpExternalServerConfig['agentThreadAccess'] = 'call') {
  const config = structuredClone(DEFAULT_CONFIG); config.mcp_config.client.servers = [server(access)]
  let pin: McpPinnedTool = { serverId: 'echo', name: 'echo', alias: 'mcp.echo.echo', description: 'Untrusted description', connectionId: 'connection-a', configDigest: mcpServerConfigDigest(config.mcp_config.client.servers[0]), toolDigest: 'a'.repeat(64), inputSchema: { type: 'object', properties: { message: { type: 'string', maxLength: 100 } }, required: ['message'], additionalProperties: false } }
  const controller = new AbortController(), consume = vi.fn()
  const approve = vi.fn(async () => consume)
  const manager = { listPinnedTools: vi.fn((id: string) => id === 'echo' ? [structuredClone(pin)] : []), listConnections: vi.fn(() => [{ id: 'echo', status: 'connected' as const, aliasPrefix: 'mcp.echo', toolAliases: [], transport: 'stdio' as const, toolCount: 1 }]), callPinnedTool: vi.fn(async (input: Parameters<McpClientManager['callPinnedTool']>[0]): Promise<Awaited<ReturnType<McpClientManager['callPinnedTool']>>> => { input.beforeDispatch(); return { content: 'echo result', metadata: { isError: false } } }) }
  const options = { route, conversationId: 'chat', signal: controller.signal, config: () => config, assertInvocation: vi.fn(), assertLive: vi.fn(), manager, approve }
  const provider = createAgentThreadMcpTools(options)
  const call = (name: string, args: Record<string, unknown>) => provider.callTool(name, args, { route, runId: 'r' })
  const discover = async () => JSON.parse((await call('mcp_list', { server: 'echo', tool: 'echo' })).content) as { token: string }
  return { config, controller, consume, approve, manager, options, provider, call, discover, changePin: (change: Partial<McpPinnedTool>) => { pin = { ...pin, ...change } } }
}
afterEach(() => { closeAssistantTerminalPolicyRuntime(); vi.restoreAllMocks() })
describe('request-owned per-service MCP tools', () => {
  it('default off, discover-only not callable, and a later setting cannot widen the same request', async () => {
    const off = setup('off'); expect(off.provider.listTools()).toEqual([])
    off.config.mcp_config.client.servers[0].agentThreadAccess = 'call'
    await expect(off.call('mcp_list', {})).rejects.toThrow('outside')
    const t = setup('discover'); expect(t.provider.listTools().map((tool) => tool.name)).toEqual(['mcp_list'])
    const token = (await t.discover()).token
    t.config.mcp_config.client.servers[0].agentThreadAccess = 'call'
    await expect(t.call('mcp_call', { token, arguments: { message: 'x' } })).rejects.toThrow()
    expect(t.approve).not.toHaveBeenCalled()
  })
  it('discloses only opted-in service IDs and passive schema, never connection secrets or foreign tools', async () => {
    const t = setup(); t.config.mcp_config.client.servers.push({ ...server('off'), id: 'private', env: { SECRET: 'secret' } })
    expect(JSON.parse((await t.call('mcp_list', {})).content)).toMatchObject({ services: [{ id: 'echo' }], connects: false })
    await expect(t.call('mcp_list', { server: 'private' })).rejects.toThrow('not authorized')
    const listing = await t.call('mcp_list', { server: 'echo' })
    expect(listing.content).toContain('Untrusted description')
    expect(listing.content).not.toContain(process.execPath)
    expect(listing.content).not.toContain('secret')
    await t.discover(); expect(t.manager.callPinnedTool).not.toHaveBeenCalled()
  })
  it.each([1, 32, 33, 64, 65])('pages all %s permitted service IDs without connection or approval side effects', async count => {
    const t = setup('discover')
    const ids = Array.from({ length: count }, (_, index) => `service-${index}`)
    t.config.mcp_config.client.servers = ids.map(id => ({ ...server('discover'), id, env: { SECRET: 'SERVICE_CONFIG_SECRET' } }))
    const provider = createAgentThreadMcpTools(t.options)
    const pages: string[] = []
    let offset: number | null = 0
    do {
      const result = await provider.callTool('mcp_list', { offset }, { route, runId: 'pages' })
      const page = JSON.parse(result.content)
      expect(page).toMatchObject({ connects: false, grantsPermission: false, truncated: ids.length > offset + 32, nextOffset: ids.length > offset + 32 ? offset + 32 : null })
      expect(page.services.map((item: { id: string }) => item.id)).toEqual(ids.slice(offset, offset + 32))
      expect(page.services.length).toBeLessThanOrEqual(32)
      expect(result.content).not.toContain('SERVICE_CONFIG_SECRET'); expect(result.content).not.toContain(process.execPath)
      pages.push(...page.services.map((item: { id: string }) => item.id)); offset = page.nextOffset
    } while (offset !== null)
    expect(pages).toEqual(ids)
    const empty = JSON.parse((await provider.callTool('mcp_list', { offset: 10000 }, { route, runId: 'pages' })).content)
    expect(empty).toMatchObject({ services: [], nextOffset: null, truncated: false })
    expect(t.approve).not.toHaveBeenCalled(); expect(t.manager.callPinnedTool).not.toHaveBeenCalled(); expect(t.manager.listPinnedTools).not.toHaveBeenCalled()
  })
  it('keeps service offsets pinned to original authorized IDs while omitting revoked and private services', async () => {
    const t = setup('discover'), ids = Array.from({ length: 65 }, (_, index) => `service-${index}`)
    t.config.mcp_config.client.servers = [...ids.map(id => ({ ...server('discover'), id })), { ...server('off'), id: 'private-before' }, { ...server('discover'), id: 'duplicate' }, { ...server('call'), id: 'duplicate' }]
    const provider = createAgentThreadMcpTools(t.options), call = (offset = 0) => provider.callTool('mcp_list', { offset }, { route, runId: 'stable-page' })
    expect(JSON.parse((await call()).content).nextOffset).toBe(32)
    for (const item of t.config.mcp_config.client.servers.slice(0, 32)) item.agentThreadAccess = 'off'
    t.config.mcp_config.client.servers.find(item => item.id === 'service-32')!.command = 'changed-after-request'
    t.config.mcp_config.client.servers.find(item => item.id === 'private-before')!.agentThreadAccess = 'call'
    t.config.mcp_config.client.servers.reverse()
    t.config.mcp_config.client.servers.unshift({ ...server('call'), id: 'new-after-request' })
    expect(JSON.parse((await call()).content)).toMatchObject({ services: [], nextOffset: 32, truncated: true })
    const second = JSON.parse((await call(32)).content)
    expect(second.services.map((item: { id: string }) => item.id)).toEqual(ids.slice(33, 64))
    expect(second.nextOffset).toBe(64)
    expect(JSON.parse((await call(64)).content)).toMatchObject({ services: [{ id: 'service-64' }], nextOffset: null })
    expect(JSON.stringify(second)).not.toMatch(/private-before|new-after-request|duplicate|changed-after-request/)
    expect(provider.listTools().map(tool => tool.name)).toEqual(['mcp_list'])
    expect(t.approve).not.toHaveBeenCalled(); expect(t.manager.callPinnedTool).not.toHaveBeenCalled()
  })
  it('rejects invalid service-page queries before reading connection snapshots and keeps existing discovery budget', async () => {
    const t = setup('discover')
    for (const offset of [-1, 0.5, 10001, '32']) await expect(t.call('mcp_list', { offset })).rejects.toThrow('arguments')
    await expect(t.call('mcp_list', { tool: 'echo', offset: 0 })).rejects.toThrow(/server/)
    expect(t.manager.listConnections).not.toHaveBeenCalled()
    for (let index = 0; index < 15; index++) await t.call('mcp_list', { offset: 0 })
    await expect(t.call('mcp_list', { offset: 32 })).rejects.toThrow('budget')
    expect(t.approve).not.toHaveBeenCalled()
  })
  it('applies existing cross-route and document-cancellation checks to service continuations', async () => {
    const t = setup('discover')
    await expect(t.provider.callTool('mcp_list', { offset: 32 }, { route: { ...route, threadId: 'foreign' }, runId: 'foreign' })).rejects.toThrow('outside')
    t.controller.abort(Error('document revoked'))
    await expect(t.call('mcp_list', { offset: 32 })).rejects.toThrow('document revoked')
    expect(t.manager.listConnections).not.toHaveBeenCalled(); expect(t.approve).not.toHaveBeenCalled()
  })
  it('does not spend lifecycle identities on service pages and still reports an absent suppressed service', async () => {
    const t = setup('discover'), manager = new McpClientManager()
    const ids = Array.from({ length: 65 }, (_, index) => `service-${index}`)
    t.config.mcp_config.client.servers = ids.map(id => ({ ...server('discover'), id, agentThreadManage: true, autoConnect: false }))
    const suppressed = t.config.mcp_config.client.servers[64]
    const expected = manager.connectionIdentity(suppressed.id)
    await manager.controlConnection({ action: 'disconnect', serverId: suppressed.id, configDigest: mcpServerConfigDigest(suppressed), expected, config: t.options.config, signal: t.controller.signal, assertLive: vi.fn(), beforeDispatch: vi.fn() })
    for (let index = 0; index < 126; index++) manager.connectionIdentity(`retired-${index}`)
    const allocate = vi.spyOn(manager, 'connectionIdentity')
    const provider = createAgentThreadMcpTools({ ...t.options, manager }), found: string[] = []
    for (const offset of [0, 32, 64]) {
      const page = JSON.parse((await provider.callTool('mcp_list', { offset }, { route, runId: 'passive-overview' })).content)
      found.push(...page.services.map((item: { id: string }) => item.id))
      if (offset === 64) expect(page.services).toEqual([expect.objectContaining({ id: suppressed.id, status: 'absent', suppressed: true })])
    }
    expect(found).toEqual(ids)
    expect(allocate).not.toHaveBeenCalled()
    expect(manager.connectionIdentity('service-0').status).toBe('absent')
    expect(() => manager.connectionIdentity('capacity-check')).toThrow('capacity')
    expect(manager.listConnections()).toEqual([]); expect(t.approve).not.toHaveBeenCalled()
    await manager.stop()
  })
  it('invokes exact discovered identity after approval and refuses token reuse or foreign request tokens', async () => {
    const t = setup(), token = (await t.discover()).token
    expect(JSON.parse((await t.call('mcp_call', { token, arguments: { message: 'hello' } })).content)).toMatchObject({ text: 'echo result', untrustedData: true })
    expect(t.approve).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'chat', pin: expect.objectContaining({ connectionId: 'connection-a' }), args: { message: 'hello' }, timeoutMs: 30000 }), expect.any(AbortSignal))
    expect(t.consume).toHaveBeenCalledOnce(); expect(t.manager.callPinnedTool).toHaveBeenCalledOnce()
    await expect(t.call('mcp_call', { token, arguments: { message: 'again' } })).rejects.toThrow('token')
    await expect(setup().call('mcp_call', { token, arguments: { message: 'x' } })).rejects.toThrow('token')
  })
  it.each(['config', 'connection', 'schema', 'disabled', 'cancel'])('revalidates %s changed during approval before any dispatch', async (kind) => {
    const t = setup(), token = (await t.discover()).token
    t.approve.mockImplementationOnce(async () => {
      if (kind === 'config') t.config.mcp_config.client.servers[0].command = 'different'
      else if (kind === 'connection') t.changePin({ connectionId: 'new' })
      else if (kind === 'schema') t.changePin({ toolDigest: 'b'.repeat(64) })
      else if (kind === 'disabled') t.config.mcp_config.client.servers[0].agentThreadAccess = 'off'
      else t.controller.abort()
      return t.consume
    })
    await expect(t.call('mcp_call', { token, arguments: { message: 'x' } })).rejects.toThrow()
    expect(t.manager.callPinnedTool).not.toHaveBeenCalled(); expect(t.consume).not.toHaveBeenCalled()
  })
  it('does not send an expired discovery token even after a later approval', async () => {
    const t = setup(), token = (await t.discover()).token
    const now = Date.now()
    t.approve.mockImplementationOnce(async () => { vi.spyOn(Date, 'now').mockReturnValue(now + 300001); return t.consume })
    await expect(t.call('mcp_call', { token, arguments: { message: 'x' } })).rejects.toThrow('expired')
    expect(t.manager.callPinnedTool).not.toHaveBeenCalled(); expect(t.consume).not.toHaveBeenCalled()
  })
  it('unsupported schema is explicitly unavailable, unknown fields/invalid values never request approval', async () => {
    const t = setup(); t.changePin({ inputSchema: { type: 'object', patternProperties: { '.*': {} } } })
    expect(JSON.parse((await t.call('mcp_list', { server: 'echo', tool: 'echo' })).content)).toMatchObject({ callable: false })
    t.changePin({ inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } })
    const token = (await t.discover()).token
    await expect(t.call('mcp_call', { token, arguments: { message: 123 } })).rejects.toThrow('schema')
    await expect(t.call('mcp_call', { token, arguments: { message: 'x' }, url: 'https://forged' })).rejects.toThrow('arguments')
    expect(t.approve).not.toHaveBeenCalled()
  })
  it('forwards bounded structured result data as untrusted JSON only after the existing exact approval', async () => {
    const t = setup(), token = (await t.discover()).token
    const data = { answer: 42, rows: [{ message: 'JSON_ONLY_RESULT' }] }
    t.manager.callPinnedTool.mockImplementationOnce(async input => { input.beforeDispatch(); return { content: '', metadata: { isError: false, structuredContent: data, structuredContentOmitted: false } } })
    const output = JSON.parse((await t.call('mcp_call', { token, arguments: { message: 'json please' } })).content)
    expect(output).toMatchObject({ text: '', structuredContent: data, structuredContentOmitted: false, untrustedData: true })
    expect(t.approve).toHaveBeenCalledOnce(); expect(t.consume).toHaveBeenCalledOnce()
    await expect(t.call('mcp_call', { token, arguments: {} })).rejects.toThrow('token')
    expect(t.manager.callPinnedTool).toHaveBeenCalledOnce()
  })
  it('does not forward structured results after the request is revoked or when the server reports an error', async () => {
    const t = setup()
    t.manager.callPinnedTool.mockImplementationOnce(async input => { input.beforeDispatch(); t.controller.abort(Error('document gone')); return { content: '', metadata: { isError: false, structuredContent: { message: 'REVOKED_JSON' } } } })
    await expect(t.call('mcp_call', { token: (await t.discover()).token, arguments: { message: 'ok' } })).rejects.toThrow('document gone')
    const error = setup()
    error.manager.callPinnedTool.mockImplementationOnce(async input => { input.beforeDispatch(); return { content: '', metadata: { isError: true, structuredContent: { message: 'ERROR_JSON' } } } })
    await expect(error.call('mcp_call', { token: (await error.discover()).token, arguments: { message: 'ok' } })).rejects.toThrow('not successful')
  })
  it('does not report server isError or transport uncertainty as successful effects', async () => {
    const t = setup()
    t.manager.callPinnedTool.mockResolvedValueOnce({ content: 'private error body', metadata: { isError: true } })
    await expect(t.call('mcp_call', { token: (await t.discover()).token, arguments: { message: 'x' } })).rejects.toThrow('not successful')
    t.manager.callPinnedTool.mockRejectedValueOnce(new Error('Authorization: Bearer secret'))
    await expect(t.call('mcp_call', { token: (await t.discover()).token, arguments: { message: 'x' } })).rejects.toThrow('outcome may be unknown')
  })
  it('bounds calls and discoveries, rejects cross-route access and never dispatches after document revocation', async () => {
    const t = setup()
    await expect(t.provider.callTool('mcp_list', {}, { route: { ...route, threadId: 'other' }, runId: 'r' })).rejects.toThrow('outside')
    for (let i = 0; i < 4; i++) await t.call('mcp_call', { token: (await t.discover()).token, arguments: { message: 'x' } })
    await expect(t.call('mcp_call', { token: (await t.discover()).token, arguments: { message: 'x' } })).rejects.toThrow('budget')
    expect(t.manager.callPinnedTool).toHaveBeenCalledTimes(4)
    const reader = setup('discover')
    for (let i = 0; i < 16; i++) await reader.call('mcp_list', {})
    await expect(reader.call('mcp_list', {})).rejects.toThrow('budget')
    t.controller.abort(new Error('document navigated'))
    await expect(t.call('mcp_list', {})).rejects.toThrow('document navigated')
  })
  it('holds one conversation call through approval, snapshots args and does not accidentally approve concurrent dispatch', async () => {
    const t = setup(), token = (await t.discover()).token
    let approve!: () => void
    const gate = new Promise<void>((resolve) => { approve = resolve })
    t.approve.mockImplementationOnce(async () => { await gate; return t.consume })
    const args = { token, arguments: { message: 'approved-original' } }
    const pending = t.call('mcp_call', args)
    await vi.waitFor(() => expect(t.approve).toHaveBeenCalledOnce())
    args.arguments.message = 'mutated-later'
    await expect(t.call('mcp_call', { token, arguments: { message: 'second' } })).rejects.toThrow('concurrency')
    approve(); await pending
    expect(t.manager.callPinnedTool.mock.calls[0][0].args).toEqual({ message: 'approved-original' })
    expect(t.approve).toHaveBeenCalledOnce()
  })
  it.each(['deny', 'cancel'])('does not dispatch on a real pending approval %s', async (outcome) => {
    const t = setup(), provider = createAgentThreadMcpTools({ ...t.options, approve: undefined })
    const context = { route, runId: 'policy' }
    const token = JSON.parse((await provider.callTool('mcp_list', { server: 'echo', tool: 'echo' }, context)).content).token
    const pending = provider.callTool('mcp_call', { token, arguments: { message: 'x' } }, context).catch((error) => error)
    const policy = getAssistantTerminalPolicyRuntime()
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    if (outcome === 'cancel') t.controller.abort()
    else { const approval = policy.listPendingTerminalApprovals()[0]; policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: false }) }
    expect(await pending).toBeInstanceOf(Error)
    expect(t.manager.callPinnedTool).not.toHaveBeenCalled()
    expect(policy.listPendingTerminalApprovals()).toEqual([])
  })
  it('keeps the four-call global admission bounded across provider instances and releases after denial', async () => {
    let resume!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const held = Array.from({ length: 4 }, (_, i) => {
      const t = setup(); t.options.conversationId = `pending-${i}`
      t.approve.mockImplementationOnce(async () => { await gate; throw new Error('denied') })
      return { t, provider: createAgentThreadMcpTools(t.options) }
    })
    const pendings: Promise<unknown>[] = []
    try {
      for (const { provider } of held) {
        const token = JSON.parse((await provider.callTool('mcp_list', { server: 'echo', tool: 'echo' }, { route, runId: 'x' })).content).token
        pendings.push(provider.callTool('mcp_call', { token, arguments: { message: 'x' } }, { route, runId: 'x' }).catch((error) => error))
      }
      await vi.waitFor(() => held.forEach(({ t }) => expect(t.approve).toHaveBeenCalledOnce()))
      const fifth = setup(), token = (await fifth.discover()).token
      await expect(fifth.call('mcp_call', { token, arguments: { message: 'x' } })).rejects.toThrow('concurrency')
      expect(fifth.approve).not.toHaveBeenCalled()
      resume(); await Promise.all(pendings)
      await expect(fifth.call('mcp_call', { token, arguments: { message: 'x' } })).resolves.toMatchObject({ content: expect.any(String) })
    } finally { resume(); await Promise.all(pendings) }
  })
  it('waits for real production approval then calls a real local stdio MCP fixture', async () => {
    const t = setup(), manager = new McpClientManager()
    await manager.sync(t.config)
    const provider = createAgentThreadMcpTools({ ...t.options, manager, approve: undefined })
    try {
      const token = JSON.parse((await provider.callTool('mcp_list', { server: 'echo', tool: 'echo' }, { route, runId: 'real' })).content).token
      const pending = provider.callTool('mcp_call', { token, arguments: { message: 'real pinned approved' } }, { route, runId: 'real' }).catch((error) => error)
      const policy = getAssistantTerminalPolicyRuntime()
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.input).toMatchObject({ server: 'echo', tool: 'echo', arguments: { message: 'real pinned approved' }, configDigest: expect.any(String) })
      expect(JSON.stringify(approval)).not.toContain(process.execPath)
      policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
      expect(JSON.parse((await pending).content)).toMatchObject({ text: 'echo:real pinned approved', untrustedData: true })
    } finally { t.controller.abort(); await manager.stop() }
  })
})
