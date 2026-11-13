import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_CONFIG, type McpExternalServerConfig } from '@shared/config/config'
import { assertBoundedMcpCatalog, BoundedMcpClient, McpClientManager, mcpServerConfigDigest, MCP_CATALOG_LIMITS } from './clientManager'

const schema = { type: 'object' as const, properties: { message: { type: 'string' } }, required: ['message'] }
const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({ name, description: `Tool ${name}`, inputSchema: schema, ...extra })
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined); vi.useRealTimers(); vi.restoreAllMocks() })
async function wire(pages: (cursor: string | undefined) => unknown | Promise<unknown>, assertCurrent = vi.fn()) {
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = new Server({ name: 'bounded-page-fixture', version: '1' }, { capabilities: { tools: {} } })
  const cursors: Array<string | undefined> = [], calls: string[] = [], validator = vi.fn((_schema: JsonSchemaType) => undefined), validate = vi.fn((_value: unknown) => undefined)
  server.setRequestHandler(ListToolsRequestSchema, async request => { cursors.push(request.params?.cursor); return await pages(request.params?.cursor) as never })
  server.setRequestHandler(CallToolRequestSchema, async request => { calls.push(request.params.name); return { content: [{ type: 'text', text: 'called' }], structuredContent: { message: 'called' } } })
  const client = new BoundedMcpClient({ name: 'bounded-client-test', version: '1' }, { jsonSchemaValidator: { getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> { validator(schema); return value => { validate(value); return { valid: true, data: value as T, errorMessage: undefined } } } } }, assertCurrent)
  await server.connect(serverTransport); await client.connect(transport)
  cleanups.push(() => client.close(), () => server.close())
  return { client, server, cursors, calls, validator, validate, assertCurrent }
}
const configured = (): McpExternalServerConfig => ({ id: 'paged', enabled: true, autoConnect: false, agentThreadAccess: 'discover', agentThreadManage: true, transport: 'stdio', command: process.execPath, args: [path.resolve('scripts/mcp/pagedCatalogServer.cjs')] })

type PageSource = (cursor: string | undefined) => unknown | Promise<unknown>
async function managed(pages: PageSource, startupTimeoutMs = 8000) {
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = new Server({ name: 'manager-page-fixture', version: '1' }, { capabilities: { tools: {} } })
  const cursors: Array<string | undefined> = [], close = vi.spyOn(transport, 'close')
  server.setRequestHandler(ListToolsRequestSchema, async request => { cursors.push(request.params?.cursor); return await pages(request.params?.cursor) as never })
  await server.connect(serverTransport)
  const config = structuredClone(DEFAULT_CONFIG), definition = { ...configured(), startupTimeoutMs }
  config.mcp_config.client.servers = [definition]
  let client: Client
  class TestManager extends McpClientManager {
    protected override createTransport() { return transport as never }
    protected override createClient(assertCurrent?: () => void): Client { return client = super.createClient(assertCurrent) }
  }
  const manager = new TestManager(undefined, () => config), controller = new AbortController(), beforeDispatch = vi.fn()
  const connect = () => manager.controlConnection({ serverId: definition.id, configDigest: mcpServerConfigDigest(definition), expected: manager.connectionIdentity(definition.id), config: () => config, signal: controller.signal, assertLive: vi.fn(), beforeDispatch, action: 'connect' })
  cleanups.push(() => server.close(), () => manager.stop())
  return { manager, server, definition, config, cursors, close, controller, beforeDispatch, connect, client: () => client! }
}

describe('bounded whole MCP remote tools/list pagination', () => {
  it('stages all pages before the SDK caches schemas and preserves first/last output and required-task metadata', async () => {
    const t = await wire(cursor => {
      expect(t.validator).not.toHaveBeenCalled()
      if (cursor === undefined) return { tools: [tool('early', { outputSchema: schema }), tool('taskEarly', { execution: { taskSupport: 'required' } })], nextCursor: ' opaque-page-2 ' }
      expect(cursor).toBe(' opaque-page-2 ')
      return { tools: [tool('late', { outputSchema: schema })] }
    })
    const result = await t.client.listTools(undefined, { timeout: 1000 })
    expect(result.tools.map(tool => tool.name)).toEqual(['early', 'taskEarly', 'late'])
    expect(result.nextCursor).toBeUndefined(); expect(t.cursors).toEqual([undefined, ' opaque-page-2 '])
    expect(t.validator).toHaveBeenCalledTimes(2)
    await t.client.callTool({ name: 'early', arguments: { message: 'x' } }); await t.client.callTool({ name: 'late', arguments: { message: 'x' } })
    await expect(t.client.callTool({ name: 'taskEarly', arguments: { message: 'x' } })).rejects.toThrow('requires task')
    expect(t.calls).toEqual(['early', 'late']); expect(t.validate).toHaveBeenCalledTimes(2)
  })
  it('accepts empty intermediate pages without exposing opaque cursors or adding a model-controlled cursor', async () => {
    const t = await wire(cursor => cursor === undefined ? { tools: [], nextCursor: 'next' } : { tools: [tool('last')] })
    expect((await t.client.listTools()).tools.map(tool => tool.name)).toEqual(['last'])
    expect(t.cursors).toEqual([undefined, 'next'])
  })
  it.each(['', 'x'.repeat(1025), '中'.repeat(342), 123, null])('rejects malformed/oversized cursor %j without caching a partial page', async nextCursor => {
    const t = await wire(() => ({ tools: [tool('notPublished', { outputSchema: schema })], nextCursor }))
    await expect(t.client.listTools()).rejects.toThrow()
    expect(t.validator).not.toHaveBeenCalled(); expect(t.cursors).toHaveLength(1)
  })
  it.each(['cycle', 'pages', 'duplicate', 'case-alias', 'over-count', 'aggregate', 'later-error'])('fails the whole catalog for %s before SDK metadata compilation', async mode => {
    const t = await wire(cursor => {
      const page = cursor === undefined ? 0 : Number(cursor)
      if (mode === 'cycle') return { tools: [], nextCursor: page === 0 ? '1' : page === 1 ? '2' : '1' }
      if (mode === 'pages') return { tools: [], nextCursor: String(page + 1) }
      if (mode === 'later-error' && page) throw new Error('untrusted late error')
      if (mode === 'over-count') return { tools: Array.from({ length: page ? 1 : 256 }, (_, i) => tool(`page${page}_${i}`)), ...(page ? {} : { nextCursor: '1' }) }
      if (mode === 'aggregate') return { tools: Array.from({ length: 17 }, (_, i) => tool(`page${page}_${i}`, { description: 'x'.repeat(16000) })), ...(page ? {} : { nextCursor: '1' }) }
      return { tools: [tool(page && mode === 'case-alias' ? 'Dupe' : 'dupe', { outputSchema: schema })], ...(page ? {} : { nextCursor: '1' }) }
    })
    await expect(t.client.listTools(undefined, { timeout: 1000 })).rejects.toThrow()
    expect(t.validator).not.toHaveBeenCalled(); expect(t.cursors.length).toBeLessThanOrEqual(32)
    if (mode === 'cycle') expect(t.cursors).toEqual([undefined, '1', '2'])
  })
  it('retains no partial cache and stops before another page when the catalog admission changes', async () => {
    let current = true
    const guard = vi.fn(() => { if (!current) throw new Error('catalog admission changed') })
    const t = await wire(cursor => { if (cursor) current = false; return { tools: [tool(cursor ? 'late' : 'early', { outputSchema: schema })], nextCursor: cursor ? '3' : '2' } }, guard)
    await expect(t.client.listTools()).rejects.toThrow('admission changed')
    expect(t.cursors).toEqual([undefined, '2']); expect(t.validator).not.toHaveBeenCalled()
  })
  it('checks abort after each page and does not cache or request another cursor', async () => {
    const controller = new AbortController()
    const t = await wire(() => { controller.abort(); return { tools: [tool('private', { outputSchema: schema })], nextCursor: '2' } })
    await expect(t.client.listTools(undefined, { signal: controller.signal })).rejects.toThrow()
    expect(t.cursors).toEqual([undefined]); expect(t.validator).not.toHaveBeenCalled()
  })
  it.each(['x'.repeat(1024), '中'.repeat(341) + 'a'])('preserves exact 1024-byte opaque cursors', async opaque => {
    const t = await wire(cursor => cursor === undefined ? { tools: [], nextCursor: opaque } : { tools: [tool('last')] })
    const params = Object.freeze({ _meta: Object.freeze({ marker: 'caller-metadata' }) })
    const options = Object.freeze({ timeout: 1000, maxTotalTimeout: 900, resetTimeoutOnProgress: true })
    expect((await t.client.listTools(params, options)).tools.map(item => item.name)).toEqual(['last'])
    expect(t.cursors).toEqual([undefined, opaque]); expect(params).toEqual({ _meta: { marker: 'caller-metadata' } })
    expect(options).toEqual({ timeout: 1000, maxTotalTimeout: 900, resetTimeoutOnProgress: true })
  })
  it('accepts a completed page 32 but never issues page 33', async () => {
    const t = await wire(cursor => {
      const index = Number(cursor ?? 0)
      return { tools: [tool(`tool_${index}`)], ...(index < 31 ? { nextCursor: String(index + 1) } : {}) }
    })
    expect((await t.client.listTools()).tools).toHaveLength(32)
    expect(t.cursors).toHaveLength(32); expect(t.cursors.at(-1)).toBe('31')
  })
  it('releases the outer abort listener after every page and on malformed response rejection', async () => {
    const t = await wire(cursor => ({ tools: [], ...(Number(cursor ?? 0) < 31 ? { nextCursor: String(Number(cursor ?? 0) + 1) } : {}) }))
    const controller = new AbortController(), add = vi.spyOn(controller.signal, 'addEventListener'), remove = vi.spyOn(controller.signal, 'removeEventListener')
    await t.client.listTools(undefined, { signal: controller.signal })
    expect(add).toHaveBeenCalledTimes(32); expect(remove).toHaveBeenCalledTimes(32)
    expect(add.mock.calls.every(([name]) => name === 'abort')).toBe(true)
    expect(remove.mock.calls.map(([, handler]) => handler)).toEqual(add.mock.calls.map(([, handler]) => handler))
    add.mockClear(); remove.mockClear()
    const bad = await wire(() => ({ tools: [], nextCursor: 42 }))
    await expect(bad.client.listTools(undefined, { signal: controller.signal })).rejects.toThrow()
    expect(add).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce()
  })
  it('rejects caller-supplied continuation cursors before network discovery', async () => {
    const t = await wire(() => ({ tools: [] }))
    await expect(t.client.listTools({ cursor: 'model-cursor' })).rejects.toThrow('first page')
    expect(t.cursors).toEqual([]); expect(t.validator).not.toHaveBeenCalled()
  })
  it('counts UTF-8 name bytes at the exact aggregate boundary', () => {
    const tools = Array.from({ length: 33 }, (_, i) => ({ name: `工具${i}`, description: 'x'.repeat(15000), inputSchema: { type: 'object' as const } }))
    const used = tools.reduce((total, item) => total + Buffer.byteLength(item.name) + Buffer.byteLength(item.description) + Buffer.byteLength(JSON.stringify(item.inputSchema)), 0)
    let remaining = MCP_CATALOG_LIMITS.bytes - used
    for (const item of tools) { const padding = Math.min(16000 - item.description.length, remaining); item.description += 'y'.repeat(padding); remaining -= padding }
    expect(remaining).toBe(0)
    expect(tools.every(item => item.description.length <= 16000)).toBe(true)
    expect(() => assertBoundedMcpCatalog({ tools })).not.toThrow()
    tools[32].description += 'z'
    expect(() => assertBoundedMcpCatalog({ tools })).toThrow('aggregate')
  })
  it('uses one absolute deadline across pages instead of renewing timeout after progress', async () => {
    let clock = 0
    const t = await wire(cursor => { clock = cursor ? 1001 : 700; return { tools: [tool(cursor ? 'late' : 'early', { outputSchema: schema })], ...(cursor ? {} : { nextCursor: '2' }) } })
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const requests = vi.spyOn(Client.prototype, 'request')
    await expect(t.client.listTools(undefined, { timeout: 1000, maxTotalTimeout: 1000, resetTimeoutOnProgress: true })).rejects.toThrow('timed out')
    expect(t.cursors).toEqual([undefined, '2']); expect(t.validator).not.toHaveBeenCalled()
    const budgets = requests.mock.calls.filter(([req]) => req.method === 'tools/list').map(([, , options]) => options)
    expect(budgets).toMatchObject([{ timeout: 1000, maxTotalTimeout: 1000, resetTimeoutOnProgress: false }, { timeout: 300, maxTotalTimeout: 300, resetTimeoutOnProgress: false }])
    now.mockRestore()
  })
  it('checks its absolute deadline after bounded validation before the SDK can cache metadata', async () => {
    let clock = 0
    const t = await wire(() => ({ tools: [tool('last', { outputSchema: schema })] }))
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const byteLength = Buffer.byteLength.bind(Buffer)
    const bytes = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => { const result = byteLength(value, encoding); if (value === 'last') clock = 1001; return result })
    await expect(t.client.listTools(undefined, { timeout: 1000 })).rejects.toThrow('timed out')
    expect(t.validator).not.toHaveBeenCalled(); bytes.mockRestore(); now.mockRestore()
  })
  it.each([['same', 'same'], ['Name', 'name'], [' name ', 'name']])('rejects ambiguous normalized identities %j', (a, b) => {
    expect(() => assertBoundedMcpCatalog({ tools: [tool(a), tool(b)] })).toThrow('ambiguous')
  })
  it('does not publish any tools while later pages are pending, and a revoked config stops pagination', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const t = await managed(async cursor => {
      if (cursor) { await gate; return { tools: [tool('late')], nextCursor: 'third-not-requested' } }
      return { tools: [tool('early')], nextCursor: 'second' }
    })
    const pending = t.connect().catch(error => error)
    try {
      await vi.waitFor(() => expect(t.cursors).toEqual([undefined, 'second']))
      expect(t.manager.connectionIdentity('paged').status).toBe('connecting'); expect(t.manager.listPinnedTools('paged')).toEqual([])
      t.definition.enabled = false; release()
      expect(await pending).toBeInstanceOf(Error)
      expect(t.manager.listPinnedTools('paged')).toEqual([]); expect(t.cursors).toEqual([undefined, 'second']); expect(t.close).toHaveBeenCalled()
      expect(t.manager.connectionIdentity('paged').status).not.toBe('connected')
    } finally { release(); await pending }
  })
  it('cancels later-page work without publishing partial tools or allowing replacement before cleanup', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const t = await managed(async cursor => cursor ? (await gate, { tools: [tool('late')] }) : { tools: [tool('early')], nextCursor: 'second' })
    const pending = t.connect().catch(error => error)
    try {
      await vi.waitFor(() => expect(t.cursors).toEqual([undefined, 'second']))
      t.controller.abort(); expect(await pending).toBeInstanceOf(Error)
      release(); await t.manager.stop()
      expect(t.manager.listPinnedTools('paged')).toEqual([]); expect(t.close).toHaveBeenCalled()
    } finally { release(); await pending }
  })
  it('shares the startup deadline between initialize and multi-page discovery, including final publication', async () => {
    let clock = 0
    const t = await managed(cursor => { clock = cursor ? 1001 : 900; return { tools: [tool(cursor ? 'late' : 'early')], ...(cursor ? {} : { nextCursor: 'second' }) } }, 1000)
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const rawConnect = Client.prototype.connect
    const startup = vi.spyOn(Client.prototype, 'connect').mockImplementation(async function (this: Client, transport, options?: RequestOptions) { clock = 700; return await rawConnect.call(this, transport, options) })
    const requests = vi.spyOn(Client.prototype, 'request')
    await expect(t.connect()).rejects.toThrow('failed')
    expect(t.cursors).toEqual([undefined, 'second'])
    const budgets = requests.mock.calls.filter(([req]) => req.method === 'tools/list').map(([, , options]) => options?.timeout)
    expect(budgets).toEqual([300, 100]); expect(t.manager.listPinnedTools('paged')).toEqual([]); expect(t.close).toHaveBeenCalled()
    startup.mockRestore(); now.mockRestore()
  })
  it.each(['deadline', 'config', 'transport'])('does not publish SDK-cached tools after final %s invalidation', async reason => {
    let clock = 0
    const t = await managed(cursor => cursor ? { tools: [tool('late', { outputSchema: schema })] } : { tools: [tool('early', { outputSchema: schema })], nextCursor: 'second' }, 1000)
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const rawList = Client.prototype.listTools
    const list = vi.spyOn(Client.prototype, 'listTools').mockImplementation(async function (this: Client, params, options) {
      const result = await rawList.call(this, params, options)
      expect(result.tools.map(tool => tool.name)).toEqual(['early', 'late'])
      if (reason === 'deadline') clock = 1001
      if (reason === 'config') t.definition.enabled = false
      if (reason === 'transport') await t.server.close()
      return result
    })
    await expect(t.connect()).rejects.toThrow(reason === 'config' ? 'configuration' : 'failed')
    expect(list).toHaveBeenCalledOnce(); expect(t.cursors).toEqual([undefined, 'second'])
    expect(t.manager.listPinnedTools('paged')).toEqual([]); expect(t.close).toHaveBeenCalled()
    list.mockRestore(); now.mockRestore()
  })
  it('redacts a remote error containing the opaque cursor from exposed connection state', async () => {
    const secret = 'CURSOR_PRIVATE_DO_NOT_DISCLOSE'
    const t = await managed(cursor => { if (cursor) throw new Error(`remote echo ${secret}`); return { tools: [tool('early')], nextCursor: secret } })
    await expect(t.connect()).rejects.toThrow('failed')
    expect(t.cursors).toEqual([undefined, secret]); expect(t.manager.listPinnedTools('paged')).toEqual([])
    expect(JSON.stringify(t.manager.listConnections())).not.toContain(secret)
    expect(t.close).toHaveBeenCalled()
  })
  it('closes and never publishes a client whose last output schema fails during SDK cache admission', async () => {
    const t = await managed(cursor => cursor ? { tools: [tool('bad', { outputSchema: { type: 'object', patternProperties: { '.*': { type: 'string' } } } })] } : { tools: [tool('early', { outputSchema: schema })], nextCursor: 'second' })
    await expect(t.connect()).rejects.toThrow('failed')
    expect(t.cursors).toEqual([undefined, 'second']); expect(t.manager.listPinnedTools('paged')).toEqual([])
    expect(await t.manager.callToolByAlias('mcp.paged.early', {})).toBeNull(); expect(t.close).toHaveBeenCalled()
    expect(t.manager.connectionIdentity('paged').status).not.toBe('connected')
  })
  it('quarantines failed later-page cleanup and never unlocks on a late close resolution', async () => {
    let finish!: () => void
    const closeGate = new Promise<void>(resolve => { finish = resolve })
    const t = await managed(cursor => { if (cursor) throw new Error('late page failed'); return { tools: [tool('early')], nextCursor: 'second' } })
    const actualClose = t.close.getMockImplementation()!
    t.close.mockImplementation(() => closeGate)
    vi.useFakeTimers()
    try {
      const pending = t.connect().catch(error => error)
      await vi.advanceTimersByTimeAsync(1)
      expect(t.cursors).toEqual([undefined, 'second']); expect(t.close).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(6001)
      expect(await pending).toBeInstanceOf(Error)
      expect(t.manager.connectionIdentity('paged').status).toBe('close-unconfirmed')
      expect(t.manager.listPinnedTools('paged')).toEqual([])
      finish(); await vi.advanceTimersByTimeAsync(1)
      await expect(t.connect()).rejects.toThrow('unresolved')
      expect(t.close).toHaveBeenCalledOnce(); expect(t.cursors).toEqual([undefined, 'second'])
    } finally { finish(); t.close.mockImplementation(actualClose); vi.useRealTimers() }
  })
  it('connects a real local two-page stdio catalog and calls a later-page tool using pinned approval identities', async () => {
    const config = structuredClone(DEFAULT_CONFIG), server = configured()
    config.mcp_config.client.servers = [server]
    const manager = new McpClientManager(undefined, () => config); cleanups.push(() => manager.stop())
    await manager.sync(config); expect(manager.listConnections()).toEqual([])
    const beforeDispatch = vi.fn()
    const input = { serverId: server.id, configDigest: mcpServerConfigDigest(server), expected: manager.connectionIdentity(server.id), config: () => config, signal: new AbortController().signal, assertLive: vi.fn(), beforeDispatch }
    await manager.controlConnection({ ...input, action: 'connect' })
    expect(manager.listPinnedTools(server.id).map(item => item.name)).toEqual(['early', 'later'])
    const pin = manager.listPinnedTools(server.id, { toolName: 'later', includeSchema: true })[0]
    const result = await manager.callPinnedTool({ ...pin, toolName: pin.name, args: { message: 'page-two-ok' }, signal: input.signal, timeoutMs: 2000, beforeDispatch: vi.fn() })
    expect(result.content).toBe('later:page-two-ok'); expect(beforeDispatch).toHaveBeenCalledOnce()
  })
})
