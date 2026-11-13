import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { DEFAULT_CONFIG, type McpExternalServerConfig } from '@shared/config/config'
import { McpClientManager, mcpServerConfigDigest } from './clientManager'
const server = (id = 'echo'): McpExternalServerConfig => ({ id, enabled: true, autoConnect: false, agentThreadAccess: 'discover', agentThreadManage: true, transport: 'stdio', command: process.execPath, args: [path.resolve('scripts/mcp/echoServer.cjs')] })
const setup = (manager: McpClientManager = new McpClientManager()) => {
  const config = structuredClone(DEFAULT_CONFIG); config.mcp_config.client.servers = [server()]
  const consume = vi.fn(), controller = new AbortController()
  const input = (action: 'connect' | 'disconnect', id = 'echo') => ({ action, serverId: id, configDigest: mcpServerConfigDigest(config.mcp_config.client.servers.find((s) => s.id === id)!), expected: manager.connectionIdentity(id), config: () => config, signal: controller.signal, beforeDispatch: consume, assertLive: vi.fn() })
  return { manager, config, consume, controller, input }
}
const managers: McpClientManager[] = []
afterEach(async () => { vi.useRealTimers(); for (const manager of managers.splice(0)) await manager.stop().catch(() => undefined); vi.restoreAllMocks() })
describe('approved MCP service connection lifecycle', () => {
  it('does not eagerly start manual services; connects exact real stdio, pins close and keeps explicit stop across sync', async () => {
    const t = setup(); managers.push(t.manager)
    t.config.mcp_config.client.servers.push(server('unrelated'))
    await t.manager.sync(t.config); expect(t.manager.listConnections()).toEqual([])
    const connected = await t.manager.controlConnection(t.input('connect'))
    expect(connected.status).toBe('connected'); expect(t.consume).toHaveBeenCalledOnce()
    expect(t.manager.listConnections().map((s) => s.id)).toEqual(['echo'])
    const pin = t.manager.listPinnedTools('echo')[0]
    const closed = await t.manager.controlConnection(t.input('disconnect'))
    expect(closed).toMatchObject({ status: 'disconnected', suppressed: true })
    t.config.mcp_config.client.servers[0].autoConnect = true
    await t.manager.sync(t.config); expect(t.manager.listPinnedTools('echo')).toEqual([])
    expect(await t.manager.callToolByAlias(pin.alias, {})).toBeNull()
    const reconnected = await t.manager.controlConnection(t.input('connect'))
    expect(reconnected.status).toBe('connected'); expect(reconnected.connectionId).not.toBe(connected.connectionId)
    await expect(t.manager.callPinnedTool({ ...pin, toolName: pin.name, args: {}, signal: t.controller.signal, timeoutMs: 1000, beforeDispatch: vi.fn() })).rejects.toThrow('changed')
  })
  it('rejects stale identities, revoked manage permission and modified config before consuming approval', async () => {
    const t = setup(); managers.push(t.manager)
    const stale = t.input('connect')
    await t.manager.controlConnection(t.input('connect')); t.consume.mockClear()
    await expect(t.manager.controlConnection(stale)).rejects.toThrow('identity changed')
    const changed = t.input('disconnect'); t.config.mcp_config.client.servers[0].command = 'different'
    await expect(t.manager.controlConnection(changed)).rejects.toThrow('configuration changed')
    t.config.mcp_config.client.servers[0].agentThreadManage = false
    await expect(t.manager.controlConnection(t.input('disconnect'))).rejects.toThrow('not authorized')
    expect(t.consume).not.toHaveBeenCalled()
  })
  it('quarantines failed transport close and refuses reconnect without blocking unrelated servers', async () => {
    const close = vi.fn(async () => { throw new Error('unconfirmed') })
    class FailedCloseManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport(config: McpExternalServerConfig) { return { close: config.id === 'echo' ? close : vi.fn(async () => undefined) } as never }
    }
    const t = setup(new FailedCloseManager()); managers.push(t.manager)
    await t.manager.controlConnection(t.input('connect'))
    await expect(t.manager.controlConnection(t.input('disconnect'))).rejects.toThrow('unconfirmed')
    expect(t.manager.connectionIdentity('echo')).toMatchObject({ status: 'close-unconfirmed', suppressed: true })
    await expect(t.manager.controlConnection(t.input('connect'))).rejects.toThrow('unresolved')
    t.config.mcp_config.client.servers.push({ ...server('unrelated'), autoConnect: true })
    await t.manager.sync(t.config)
    expect(t.manager.connectionIdentity('unrelated').status).toBe('connected')
    expect(close).toHaveBeenCalledOnce()
  })
  it('cancels a pending close promptly but does not release the manager lifecycle or allow a replacement', async () => {
    let finishClose!: () => void
    const gate = new Promise<void>((resolve) => { finishClose = resolve })
    let opened = 0
    class PendingCloseManager extends McpClientManager {
      protected override createClient(): Client { opened++; return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport() { return { close: vi.fn(async () => gate) } as never }
    }
    const t = setup(new PendingCloseManager()); managers.push(t.manager)
    await t.manager.controlConnection(t.input('connect'))
    const pending = t.manager.controlConnection(t.input('disconnect')).catch((error) => error)
    await vi.waitFor(() => expect(t.manager.connectionIdentity('echo').status).toBe('closing'))
    t.controller.abort()
    expect(await pending).toBeInstanceOf(Error)
    expect(t.manager.connectionIdentity('echo').status).toBe('closing')
    const queuedSync = t.manager.sync(t.config)
    expect(opened).toBe(1)
    finishClose(); await queuedSync
    expect(t.manager.connectionIdentity('echo')).toMatchObject({ status: 'disconnected', suppressed: true })
    expect(opened).toBe(1)
  })
  it('bounds a stalled close then quarantines it even if the transport later resolves', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    class StalledManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport() { return { close: () => gate } as never }
    }
    const t = setup(new StalledManager()); managers.push(t.manager)
    try {
      await t.manager.controlConnection(t.input('connect'))
      const pending = t.manager.controlConnection(t.input('disconnect')).catch((error) => error)
      await vi.advanceTimersByTimeAsync(6001)
      expect(await pending).toBeInstanceOf(Error)
      expect(t.manager.connectionIdentity('echo').status).toBe('close-unconfirmed')
      finish(); await Promise.resolve()
      await expect(t.manager.controlConnection(t.input('connect'))).rejects.toThrow('unresolved')
    } finally { finish(); vi.useRealTimers() }
  })
  it('does not mistake an old connected config for the newly approved one', async () => {
    const commands: string[] = []
    class ConfigManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport(config: McpExternalServerConfig) { commands.push(config.command!); return { close: vi.fn(async () => undefined) } as never }
    }
    const t = setup(new ConfigManager()); managers.push(t.manager)
    await t.manager.controlConnection(t.input('connect'))
    t.config.mcp_config.client.servers[0].command = 'new-approved-command'
    await t.manager.controlConnection(t.input('connect'))
    expect(commands).toEqual([process.execPath, 'new-approved-command'])
    expect(t.consume).toHaveBeenCalledTimes(2)
  })
  it('invalidates queued automatic sync when newer configuration disables startup', async () => {
    const commands: string[] = []
    class LatestManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport(config: McpExternalServerConfig) { commands.push(config.command!); return { close: vi.fn(async () => undefined) } as never }
    }
    const t = setup(new LatestManager()); managers.push(t.manager)
    t.config.mcp_config.client.servers[0].autoConnect = true
    const stale = t.manager.sync(t.config)
    t.config.mcp_config.client.servers[0].autoConnect = false
    const latest = t.manager.sync(t.config)
    await Promise.all([stale, latest]); expect(commands).toEqual([])
    t.config.mcp_config.client.servers[0].autoConnect = true
    await t.manager.sync(t.config); expect(commands).toEqual([process.execPath])
  })
  it('rechecks authoritative configuration before queued launch even without another sync call', async () => {
    const commands: string[] = [], config = structuredClone(DEFAULT_CONFIG)
    config.mcp_config.client.servers = [{ ...server(), autoConnect: true }]
    class LiveManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport(server: McpExternalServerConfig) { commands.push(server.command!); return { close: vi.fn(async () => undefined) } as never }
    }
    const manager = new LiveManager(undefined, () => config); managers.push(manager)
    const pending = manager.sync(config)
    config.mcp_config.client.servers[0].enabled = false
    await pending; expect(commands).toEqual([])
  })
  it('rejects invalid timeout before creating transport and can recover without false quarantine', async () => {
    const t = setup(); managers.push(t.manager)
    t.config.mcp_config.client.servers[0].startupTimeoutMs = 120001
    await expect(t.manager.controlConnection(t.input('connect'))).rejects.toThrow('failed')
    expect(t.manager.connectionIdentity('echo').status).not.toBe('close-unconfirmed')
    t.config.mcp_config.client.servers[0].startupTimeoutMs = 8000
    expect((await t.manager.controlConnection(t.input('connect'))).status).toBe('connected')
  })
  it('cancels a queued control before it can consume approval or start another service', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const commands: string[] = []
    class QueueManager extends McpClientManager {
      protected override createClient(): Client { return { connect: async () => gate, listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport(config: McpExternalServerConfig) { commands.push(config.id); return { close: vi.fn(async () => undefined) } as never }
    }
    const t = setup(new QueueManager()); managers.push(t.manager)
    t.config.mcp_config.client.servers.push({ ...server('blocking'), autoConnect: true })
    const sync = t.manager.sync(t.config)
    await vi.waitFor(() => expect(commands).toEqual(['blocking']))
    const pending = t.manager.controlConnection(t.input('connect')).catch((error) => error)
    t.controller.abort()
    expect(await pending).toBeInstanceOf(Error)
    release(); await sync; await t.manager.sync(t.config)
    expect(commands).toEqual(['blocking']); expect(t.consume).not.toHaveBeenCalled()
  })
  it('does not publish a late successful startup after its caller cancels', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), close = vi.fn(async () => undefined), connect = vi.fn(async () => gate)
    class StartingManager extends McpClientManager {
      protected override createClient(): Client { return { connect, listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport() { return { close } as never }
    }
    const t = setup(new StartingManager()); managers.push(t.manager)
    const pending = t.manager.controlConnection(t.input('connect')).catch((error) => error)
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    t.controller.abort(); expect(await pending).toBeInstanceOf(Error)
    release(); await t.manager.sync(t.config)
    expect(t.manager.connectionIdentity('echo')).toMatchObject({ status: 'disconnected', suppressed: true })
    expect(close).toHaveBeenCalledOnce()
  })
  it('rechecks settings changed while closing the old connection before starting a replacement', async () => {
    let finish!: () => void
    const closeGate = new Promise<void>((resolve) => { finish = resolve }), commands: string[] = []
    class CloseThenLaunchManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport(server: McpExternalServerConfig) { commands.push(server.command!); return { close: () => closeGate } as never }
    }
    const t = setup(new CloseThenLaunchManager()); managers.push(t.manager)
    await t.manager.controlConnection(t.input('connect'))
    t.config.mcp_config.client.servers[0].command = 'replacement'
    const pending = t.manager.controlConnection(t.input('connect')).catch((error) => error)
    await vi.waitFor(() => expect(t.manager.connectionIdentity('echo').status).toBe('closing'))
    t.config.mcp_config.client.servers[0].agentThreadManage = false; finish()
    expect(await pending).toBeInstanceOf(Error)
    expect(commands).toEqual([process.execPath])
  })
  it('distinguishes a synchronous spawn failure from unknown closure and permits a corrected retry', async () => {
    const t = setup(); managers.push(t.manager)
    t.config.mcp_config.client.servers[0].args = ['bad\u0000arg']
    await expect(t.manager.controlConnection(t.input('connect'))).rejects.toThrow('failed')
    expect(t.manager.connectionIdentity('echo').status).not.toBe('close-unconfirmed')
    t.config.mcp_config.client.servers[0].args = [path.resolve('scripts/mcp/echoServer.cjs')]
    expect((await t.manager.controlConnection(t.input('connect'))).status).toBe('connected')
  })
  it('does not publish a catalog revoked during automatic discovery without another sync call', async () => {
    const config = structuredClone(DEFAULT_CONFIG); config.mcp_config.client.servers = [{ ...server(), autoConnect: true }]
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve }), close = vi.fn(async () => undefined), list = vi.fn(async () => { await gate; return { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } })
    class RevokedManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: list } as unknown as Client }
      protected override createTransport() { return { close } as never }
    }
    const manager = new RevokedManager(undefined, () => config); managers.push(manager)
    const pending = manager.sync(config)
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce())
    config.mcp_config.client.servers[0].enabled = false; release(); await pending
    expect(manager.connectionIdentity('echo').status).not.toBe('connected')
    expect(manager.listPinnedTools('echo')).toEqual([]); expect(close).toHaveBeenCalledOnce()
  })
  it('fails closed when authoritative configuration is unavailable instead of falling back to caller-supplied commands', async () => {
    const created = vi.fn()
    class UninitializedManager extends McpClientManager {
      protected override createTransport() { created(); return { close: async () => undefined } as never }
    }
    const manager = new UninitializedManager(undefined, () => { throw new Error('Config not initialized') }); managers.push(manager)
    const t = setup(manager); t.config.mcp_config.client.servers[0].autoConnect = true
    await expect(manager.sync(t.config)).rejects.toThrow('not initialized')
    expect(created).not.toHaveBeenCalled()
  })
  it('rejects cancellation before a queued lifecycle operation can launch', async () => {
    const t = setup(); managers.push(t.manager)
    t.controller.abort()
    await expect(t.manager.controlConnection(t.input('connect'))).rejects.toThrow()
    expect(t.consume).not.toHaveBeenCalled(); expect(t.manager.listConnections()).toEqual([])
  })
})
