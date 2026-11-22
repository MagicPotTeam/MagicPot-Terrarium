import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type McpExternalServerConfig } from '@shared/config/config'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { McpClientManager, BoundedMcpClient, mcpServerConfigDigest } from './clientManager'

const createConfig = (servers: McpExternalServerConfig[]): Config => ({
  ...DEFAULT_CONFIG,
  mcp_config: {
    ...DEFAULT_CONFIG.mcp_config,
    client: {
      servers
    }
  }
})

const buildStdioServerConfig = (): McpExternalServerConfig => ({
  id: 'echo',
  enabled: true,
  transport: 'stdio',
  command: process.execPath,
  args: [path.resolve(process.cwd(), 'scripts/mcp/echoServer.cjs')],
  toolPrefix: 'mcp.echo',
  startupTimeoutMs: 8000,
  requestTimeoutMs: 8000
})

describe('McpClientManager', () => {
  const managers: McpClientManager[] = []

  afterEach(async () => {
    vi.useRealTimers()
    while (managers.length > 0) {
      const manager = managers.pop()
      await manager?.stop()
    }
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('rejects count and combined output-schema bytes BEFORE SDK validator-cache preparation', async () => {
    const getValidator = vi.fn(() => { throw new Error('must not compile/cache') })
    const client = new BoundedMcpClient({ name: 'bounded-test', version: '1' }, { jsonSchemaValidator: { getValidator } })
    const request = vi.spyOn(Protocol.prototype, 'request')
    request.mockResolvedValueOnce({ tools: Array.from({ length: 257 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } })) } as never)
    await expect(client.listTools()).rejects.toThrow('256-tool')
    expect(getValidator).not.toHaveBeenCalled()
    request.mockResolvedValueOnce({ tools: Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' }, outputSchema: { type: 'object', description: 'x'.repeat(22000) } })) } as never)
    await expect(client.listTools()).rejects.toThrow('aggregate')
    expect(getValidator).not.toHaveBeenCalled()
  })

  it('cancels an in-flight pinned SDK request and observes a remote late rejection', async () => {
    let rejectRemote!: (error: Error) => void
    const response = new Promise<never>((_, reject) => { rejectRemote = reject })
    const called = vi.fn(async (_request: unknown, _schema: unknown, _options: unknown) => response)
    class WaitingManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })), callTool: called } as unknown as Client }
      protected override createTransport() { return { close: vi.fn(async () => undefined) } as never }
    }
    const manager = new WaitingManager(); managers.push(manager)
    await manager.sync(createConfig([buildStdioServerConfig()]))
    const pin = manager.listPinnedTools('echo')[0], controller = new AbortController()
    const pending = manager.callPinnedTool({ ...pin, toolName: pin.name, args: {}, signal: controller.signal, timeoutMs: 1000, beforeDispatch: vi.fn() }).catch((error) => error)
    expect(called).toHaveBeenCalledOnce(); controller.abort()
    expect((called.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted).toBe(true)
    expect(await pending).toMatchObject({ name: 'AbortError' })
    rejectRemote(new Error('late remote failure')); await Promise.resolve()
    expect(manager.listConnections()[0].status).toBe('connected')
  })

  it('prevents SDK output-schema precompilation from evaluating unsupported regex or external references', async () => {
    class ExposedManager extends McpClientManager { clientForTest() { return this.createClient() } }
    const manager = new ExposedManager(); managers.push(manager)
    const client = manager.clientForTest()
    vi.spyOn(client, 'request').mockResolvedValue({ tools: [{ name: 'malicious-output', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { x: { type: 'string', pattern: '(a+)+$' } } } }] } as never)
    await expect(client.listTools()).rejects.toThrow('unsupported')
    vi.mocked(client.request).mockResolvedValueOnce({ tools: [{ name: 'remote-schema', inputSchema: { type: 'object' }, outputSchema: { type: 'object', $ref: 'https://not-requested.invalid/schema' } }] } as never)
    await expect(client.listTools()).rejects.toThrow('unsupported')
  })

  it.each(['tool-count', 'schema-bytes', 'catalog-bytes'])('rejects oversized discovered %s at admission before exposing any tool', async (kind) => {
    const tool = { name: 'echo', inputSchema: { type: 'object', description: 'x'.repeat(kind === 'schema-bytes' ? 65537 : kind === 'catalog-bytes' ? 40000 : 0) } }
    const count = kind === 'tool-count' ? 257 : kind === 'catalog-bytes' ? 20 : 1
    class OversizeManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: Array.from({ length: count }, (_, n) => ({ ...tool, name: `tool${n}` })) })) } as unknown as Client }
      protected override createTransport() { return { close: vi.fn(async () => undefined) } as never }
    }
    const manager = new OversizeManager(); managers.push(manager)
    await manager.sync(createConfig([buildStdioServerConfig()]))
    expect(manager.listConnections()[0].status).toBe('error')
    expect(manager.listPinnedTools('echo')).toEqual([])
  })

  it('pins exact server/tool identity, detaches discovery and never picks an ambiguous alias', async () => {
    const called = vi.fn(async ({ name }: { name: string }) => ({ content: [{ type: 'text', text: name }] }))
    class PinnedManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] })), callTool: called } as unknown as Client }
      protected override createTransport() { return { close: vi.fn(async () => undefined) } as never }
    }
    const manager = new PinnedManager(); managers.push(manager)
    const a = { ...buildStdioServerConfig(), id: 'one', toolPrefix: 'same', env: { SECRET: 'do-not-disclose' } }, b = { ...a, id: 'two' }
    await manager.sync(createConfig([a, b]))
    expect(JSON.stringify(manager.listPinnedTools('one'))).not.toContain('do-not-disclose')
    expect(manager.listPinnedTools('two', { includeSchema: false, offset: 0, limit: 1 })[0].inputSchema).toEqual({})
    expect(manager.listPinnedTools('two', { toolName: 'not-present' })).toEqual([])
    const [pin] = manager.listPinnedTools('two')
    const invoke = () => manager.callPinnedTool({ ...pin, toolName: pin.name, args: {}, signal: new AbortController().signal, timeoutMs: 1000, beforeDispatch: vi.fn() })
    expect(pin.configDigest).toBe(mcpServerConfigDigest(b))
    pin.inputSchema.properties = { forged: { type: 'string' } }
    expect(manager.listPinnedTools('two')[0].inputSchema.properties).toEqual({})
    await expect(manager.callToolByAlias('same.echo', {})).rejects.toThrow('Ambiguous')
    expect(called).not.toHaveBeenCalled()
    expect(await invoke()).toMatchObject({ content: 'echo', metadata: { serverId: 'two' } })
    await manager.sync(createConfig([a, { ...b, args: ['changed'] }]))
    await expect(invoke()).rejects.toThrow('connection identity changed')
    expect(called).toHaveBeenCalledOnce()
  })

  it('serializes overlapping sync/stop operations and snapshots mutable config before awaiting', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const commands: string[] = [], close = vi.fn(async () => undefined), connect = vi.fn(async () => { await gate })
    class SerializedManager extends McpClientManager {
      protected override createClient(): Client { return { connect, listTools: vi.fn(async () => ({ tools: [] })) } as unknown as Client }
      protected override createTransport(config: McpExternalServerConfig) { commands.push(config.command!); return { close } as never }
    }
    const manager = new SerializedManager(); managers.push(manager)
    const config = createConfig([{ ...buildStdioServerConfig(), command: 'approved-command' }])
    const first = manager.sync(config), second = manager.sync(config), stopped = manager.stop()
    config.mcp_config.client.servers[0].command = 'changed-by-caller'
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    release(); await Promise.all([first, second, stopped])
    expect(commands).toEqual(['approved-command'])
    expect(close).toHaveBeenCalledOnce()
    expect(manager.listConnections()).toEqual([])
  })

  it('rejects duplicate configured server IDs before connection side effects', async () => {
    const manager = new McpClientManager(); managers.push(manager)
    const server = buildStdioServerConfig()
    await expect(manager.sync(createConfig([server, { ...server, command: 'other' }]))).rejects.toThrow('Duplicate')
    expect(manager.listConnections()).toEqual([])
  })

  it('rechecks approval immediately before SDK dispatch and does not mark preflight denial a transport failure', async () => {
    const called = vi.fn(async () => ({ content: [] }))
    class TestManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })), callTool: called } as unknown as Client }
      protected override createTransport() { return { close: vi.fn(async () => undefined) } as never }
    }
    const manager = new TestManager(); managers.push(manager)
    await manager.sync(createConfig([buildStdioServerConfig()]))
    const pin = manager.listPinnedTools('echo')[0], controller = new AbortController()
    const input = { ...pin, toolName: pin.name, args: {}, signal: controller.signal, timeoutMs: 1000, beforeDispatch: () => { throw new Error('settings revoked') } }
    await expect(manager.callPinnedTool(input)).rejects.toThrow('settings revoked')
    expect(called).not.toHaveBeenCalled()
    expect(manager.listConnections()[0].status).toBe('connected')
    await expect(manager.callPinnedTool({ ...input, beforeDispatch: () => controller.abort(new Error('cancelled before dispatch')) })).rejects.toThrow()
    expect(called).not.toHaveBeenCalled()
  })

  it('pinned calls pass bounded timeout/abort to SDK and cap only passive text results', async () => {
    const called = vi.fn(async (_request: unknown, _schema: unknown, _options: unknown) => ({ content: [{ type: 'text', text: 'x'.repeat(40000) }, { type: 'image', data: 'private-binary' }, { type: 'resource_link', uri: 'file:///secret' }], isError: true, structuredContent: { secret: 'private structured' } }))
    class TestManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })), callTool: called } as unknown as Client }
      protected override createTransport() { return { close: vi.fn(async () => undefined) } as never }
    }
    const manager = new TestManager(); managers.push(manager)
    await manager.sync(createConfig([buildStdioServerConfig()]))
    const pin = manager.listPinnedTools('echo')[0], controller = new AbortController(), beforeDispatch = vi.fn()
    const result = await manager.callPinnedTool({ ...pin, toolName: pin.name, args: { message: 'ok' }, signal: controller.signal, timeoutMs: 1000, beforeDispatch })
    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(result.content).toHaveLength(32000)
    expect(result.metadata).toMatchObject({ isError: true, truncated: true, omittedResources: 2, structuredContentOmitted: true })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(called.mock.calls[0][2]).toMatchObject({ timeout: 1000, maxTotalTimeout: 1000, resetTimeoutOnProgress: false, signal: expect.any(AbortSignal) })
    controller.abort()
    expect((called.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted).toBe(true)
  })

  it.each([
    ['only JSON', [], { rows: [{ name: '点心', count: 2 }], complete: true, next: null }],
    ['JSON with text', [{ type: 'text', text: 'bounded summary' }], { answer: 42 }],
    ['empty JSON', [], {}],
    ['exact JSON byte limit', [], { value: 'x'.repeat(16372) }],
    ['missing JSON', [], undefined],
    ['byte overflow', [], { value: 'x'.repeat(16373) }],
    ['UTF8 overflow', [], { value: '中'.repeat(6000) }],
    ['deep JSON', [], Array.from({ length: 18 }).reduce<unknown>(value => ({ child: value }), {})],
    ['large array', [], { rows: Array.from({ length: 257 }, () => 0) }],
    ['node overflow', [], { rows: Array.from({ length: 32 }, () => Array.from({ length: 64 }, () => 0)) }],
    ['reserved property', [], JSON.parse('{"__proto__":{"unsafe":true}}')],
    ['non-object JSON', [], [1, 2]],
    ['null JSON', [], null],
    ['non-finite number', [], { value: Infinity }],
    ['class object', [], new Date(0)]
  ] as const)('bounds pinned structured results: %s', async (label, content, data) => {
    const called = vi.fn(async () => ({ content, structuredContent: data }))
    class TestManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })), callTool: called } as unknown as Client }
      protected override createTransport() { return { close: vi.fn(async () => undefined) } as never }
    }
    const manager = new TestManager(); managers.push(manager)
    await manager.sync(createConfig([buildStdioServerConfig()]))
    const pin = manager.listPinnedTools('echo')[0], beforeDispatch = vi.fn()
    const result = await manager.callPinnedTool({ ...pin, toolName: pin.name, args: {}, signal: new AbortController().signal, timeoutMs: 1000, beforeDispatch })
    const kept = ['only JSON', 'JSON with text', 'empty JSON', 'exact JSON byte limit'].includes(label)
    expect(result.content).toBe(label === 'JSON with text' ? 'bounded summary' : '')
    expect(result.metadata).toMatchObject({ isError: false, structuredContentOmitted: data !== undefined && !kept })
    if (kept) {
      expect(result.metadata?.structuredContent).toEqual(data)
      expect(result.metadata?.structuredContent).not.toBe(data)
      expect(Buffer.byteLength(JSON.stringify(result.metadata?.structuredContent), 'utf8')).toBeLessThanOrEqual(16384)
    } else expect(result.metadata).not.toHaveProperty('structuredContent')
    expect(manager.listConnections()[0].status).toBe('connected')
    expect(called).toHaveBeenCalledOnce(); expect(beforeDispatch).toHaveBeenCalledOnce()
  })
  it('omits executable structured members without calling getters or toJSON', async () => {
    const getter = vi.fn(() => 'MUST_NOT_RUN'), toJSON = vi.fn(() => ({ executable: 'MUST_NOT_RUN' }))
    const candidates = [Object.defineProperty({}, 'value', { get: getter, enumerable: true }), { toJSON }, { [Symbol('unsafe')]: 'symbol' }]
    const called = vi.fn(async () => ({ content: [], structuredContent: candidates.shift() }))
    class TestManager extends McpClientManager {
      protected override createClient(): Client { return { connect: vi.fn(async () => undefined), listTools: vi.fn(async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })), callTool: called } as unknown as Client }
      protected override createTransport() { return { close: vi.fn(async () => undefined) } as never }
    }
    const manager = new TestManager(); managers.push(manager)
    await manager.sync(createConfig([buildStdioServerConfig()]))
    const pin = manager.listPinnedTools('echo')[0]
    for (let index = 0; index < 3; index++) {
      const result = await manager.callPinnedTool({ ...pin, toolName: pin.name, args: {}, signal: new AbortController().signal, timeoutMs: 1000, beforeDispatch: vi.fn() })
      expect(result.metadata?.structuredContentOmitted).toBe(true)
      expect(result.metadata).not.toHaveProperty('structuredContent')
    }
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled()
  })
  it('real stdio pinned call works and reconnect invalidates an old discovery identity', async () => {
    const manager = new McpClientManager(); managers.push(manager)
    const config = createConfig([buildStdioServerConfig()])
    await manager.sync(config)
    const pin = manager.listPinnedTools('echo').find((tool) => tool.name === 'echo')!
    const input = { ...pin, toolName: pin.name, args: { message: 'pinned' }, signal: new AbortController().signal, timeoutMs: 8000, beforeDispatch: vi.fn() }
    expect(await manager.callPinnedTool(input)).toMatchObject({ content: 'echo:pinned', metadata: { isError: false } })
    await manager.stop(); await manager.sync(config)
    await expect(manager.callPinnedTool(input)).rejects.toThrow('identity changed')
    expect(input.beforeDispatch).toHaveBeenCalledOnce()
  })

  it('discovers external MCP tools and calls them through alias names', async () => {
    const manager = new McpClientManager()
    managers.push(manager)

    await manager.sync(createConfig([buildStdioServerConfig()]))

    expect(manager.listToolsSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'mcp.echo.echo',
          description: 'Echo a short message for MCP client smoke tests.'
        }),
        expect.objectContaining({
          name: 'mcp.echo.fail'
        })
      ])
    )
    expect(manager.listConnections()).toEqual([
      expect.objectContaining({
        id: 'echo',
        aliasPrefix: 'mcp.echo',
        status: 'connected',
        toolCount: 2
      })
    ])

    const echoResult = await manager.callToolByAlias('mcp.echo.echo', {
      message: 'hello'
    })
    const failResult = await manager.callToolByAlias('mcp.echo.fail', {
      reason: 'bad-input'
    })

    expect(echoResult).toMatchObject({
      content: 'echo:hello',
      metadata: {
        serverId: 'echo',
        toolName: 'echo',
        alias: 'mcp.echo.echo',
        isError: false,
        structuredContent: {
          echoed: 'echo:hello'
        }
      }
    })
    expect(failResult).toMatchObject({
      content: 'fail:bad-input',
      metadata: {
        serverId: 'echo',
        toolName: 'fail',
        alias: 'mcp.echo.fail',
        isError: true,
        structuredContent: {
          ok: false,
          reason: 'bad-input'
        }
      }
    })
  })

  it('records startup errors without breaking healthy MCP servers', async () => {
    const manager = new McpClientManager()
    managers.push(manager)

    await manager.sync(
      createConfig([
        {
          id: 'broken',
          enabled: true,
          transport: 'stdio',
          command: path.resolve(process.cwd(), 'scripts/mcp/not-found.exe')
        },
        buildStdioServerConfig()
      ])
    )

    const snapshots = manager
      .listConnections()
      .sort((left, right) => left.id.localeCompare(right.id))
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toMatchObject({
      id: 'broken',
      status: 'error',
      toolCount: 0
    })
    expect(snapshots[0]?.lastError).toBeTruthy()
    expect(snapshots[1]).toMatchObject({
      id: 'echo',
      status: 'connected',
      toolCount: 2
    })
  })

  it('ignores invalid discovered schemas instead of crashing sync', async () => {
    class InvalidSchemaManager extends McpClientManager {
      protected override createClient(): Client {
        return {
          connect: vi.fn(async () => undefined),
          listTools: vi.fn(async () => ({
            tools: [
              {
                name: 'bad-tool',
                description: 'Invalid schema tool',
                inputSchema: {
                  type: 'string'
                }
              }
            ]
          }))
        } as unknown as Client
      }

      protected override createTransport(_config: McpExternalServerConfig) {
        return {
          close: vi.fn(async () => undefined)
        } as never
      }
    }

    const manager = new InvalidSchemaManager()
    managers.push(manager)

    await manager.sync(
      createConfig([
        {
          id: 'invalid-schema',
          enabled: true,
          transport: 'stdio',
          command: process.execPath
        }
      ])
    )

    expect(manager.listToolsSnapshot()).toEqual([])
    expect(manager.listConnections()).toEqual([
      expect.objectContaining({
        id: 'invalid-schema',
        status: 'connected',
        toolCount: 0
      })
    ])
  })

  it('matches MCP aliases case-insensitively after assistant normalization', async () => {
    class CaseVariantManager extends McpClientManager {
      protected override createClient(): Client {
        return {
          connect: vi.fn(async () => undefined),
          listTools: vi.fn(async () => ({
            tools: [
              {
                name: 'EchoUpper',
                description: 'Echo with a mixed-case MCP name.',
                inputSchema: {
                  type: 'object',
                  properties: {}
                }
              }
            ]
          })),
          callTool: vi.fn(async ({ name }: { name: string }) => ({
            content: [{ type: 'text', text: name }],
            isError: false
          }))
        } as unknown as Client
      }

      protected override createTransport(_config: McpExternalServerConfig) {
        return {
          close: vi.fn(async () => undefined)
        } as never
      }
    }

    const manager = new CaseVariantManager()
    managers.push(manager)

    await manager.sync(
      createConfig([
        {
          id: 'case-variant',
          enabled: true,
          transport: 'stdio',
          command: process.execPath,
          toolPrefix: 'mcp.case-variant'
        }
      ])
    )

    await expect(manager.callToolByAlias('MCP.CASE-VARIANT.ECHOUPPER', {})).resolves.toMatchObject({
      content: 'EchoUpper'
    })
  })

  it('treats aborted tool calls as cancellation instead of server failure', async () => {
    let rejectCall: (reason?: unknown) => void = () => undefined
    const pendingCall = new Promise<never>((_, reject) => {
      rejectCall = reject
    })

    class AbortAwareManager extends McpClientManager {
      protected override createClient(): Client {
        return {
          connect: vi.fn(async () => undefined),
          listTools: vi.fn(async () => ({
            tools: [
              {
                name: 'wait',
                description: 'Wait forever until the caller aborts.',
                inputSchema: {
                  type: 'object',
                  properties: {}
                }
              }
            ]
          })),
          callTool: vi.fn(async () => pendingCall)
        } as unknown as Client
      }

      protected override createTransport(_config: McpExternalServerConfig) {
        return {
          close: vi.fn(async () => undefined)
        } as never
      }
    }

    const manager = new AbortAwareManager()
    managers.push(manager)

    await manager.sync(
      createConfig([
        {
          id: 'abort-aware',
          enabled: true,
          transport: 'stdio',
          command: process.execPath
        }
      ])
    )

    const controller = new AbortController()
    const resultPromise = manager.callToolByAlias('mcp.abort-aware.wait', {}, controller.signal)
    controller.abort('stop waiting')

    await expect(resultPromise).rejects.toMatchObject({
      name: 'AbortError'
    })

    // A transport can reject after the caller has already cancelled. The
    // manager must observe that rejection without turning it into an
    // unhandled rejection or changing the connection health state.
    rejectCall(new Error('late transport failure'))
    await Promise.resolve()
    expect(manager.listConnections()).toEqual([
      expect.objectContaining({
        id: 'abort-aware',
        status: 'connected',
        toolCount: 1
      })
    ])
  })

  it('observes late transport failures after a request timeout', async () => {
    let rejectCall: (reason?: unknown) => void = () => undefined
    const pendingCall = new Promise<never>((_, reject) => {
      rejectCall = reject
    })

    class TimeoutAwareManager extends McpClientManager {
      protected override createClient(): Client {
        return {
          connect: vi.fn(async () => undefined),
          listTools: vi.fn(async () => ({
            tools: [
              {
                name: 'wait',
                description: 'Wait until the request timeout fires.',
                inputSchema: {
                  type: 'object',
                  properties: {}
                }
              }
            ]
          })),
          callTool: vi.fn(async () => pendingCall)
        } as unknown as Client
      }

      protected override createTransport(_config: McpExternalServerConfig) {
        return {
          close: vi.fn(async () => undefined)
        } as never
      }
    }

    const manager = new TimeoutAwareManager()
    managers.push(manager)

    await manager.sync(
      createConfig([
        {
          id: 'timeout-aware',
          enabled: true,
          transport: 'stdio',
          command: process.execPath,
          requestTimeoutMs: 1000
        }
      ])
    )

    vi.useFakeTimers()
    const resultPromise = manager.callToolByAlias('mcp.timeout-aware.wait', {})
    const rejection = expect(resultPromise).rejects.toThrow('timed out after 1000ms')
    await vi.advanceTimersByTimeAsync(1000)
    await rejection
    expect(manager.listConnections()).toEqual([
      expect.objectContaining({
        id: 'timeout-aware',
        status: 'error',
        toolCount: 1
      })
    ])

    // Rejecting the underlying MCP call after the timeout must be harmless.
    rejectCall(new Error('late transport failure'))
    await Promise.resolve()
    expect(manager.listConnections()).toEqual([
      expect.objectContaining({
        id: 'timeout-aware',
        status: 'error',
        toolCount: 1
      })
    ])
  })
})
