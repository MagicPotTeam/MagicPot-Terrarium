import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type McpExternalServerConfig } from '@shared/config/config'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpClientManager } from './clientManager'

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
    while (managers.length > 0) {
      const manager = managers.pop()
      await manager?.stop()
    }
    vi.clearAllMocks()
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

  it('treats aborted tool calls as cancellation instead of server failure', async () => {
    const pendingCall = new Promise<never>(() => undefined)

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
    expect(manager.listConnections()).toEqual([
      expect.objectContaining({
        id: 'abort-aware',
        status: 'connected',
        toolCount: 1
      })
    ])
  })
})
