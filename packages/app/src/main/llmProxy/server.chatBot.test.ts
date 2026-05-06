import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

let currentConfig: Config = DEFAULT_CONFIG
let testArtifactDir = ''
let chatRequestCapture: unknown = null
let toolCallCapture: unknown = null
let mcpBridgeRequestCapture: unknown = null

type MockChatResponse = {
  content: string
  imageUrl?: string
  attachments?: Array<Record<string, unknown>>
}

const chatMock = vi.fn(
  async (_req?: unknown, _options?: unknown): Promise<MockChatResponse> => ({
    content: 'chat ok'
  })
)

let rawLocalMediaPath = 'file:///tmp/reference.png'

const callToolMock = vi.fn(async (_route?: unknown, _toolName?: unknown, _args?: unknown) => ({
  content: 'tool ok',
  metadata: { ok: true }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name?: string) =>
      name === 'userData' && testArtifactDir ? testArtifactDir : 'C:/tmp'
    )
  },
  session: {
    fromPartition: vi.fn(() => ({
      cookies: {
        get: vi.fn(async () => [])
      }
    }))
  }
}))

vi.mock('../config/config', () => ({
  getConfig: () => currentConfig
}))

vi.mock('../api/svcLLMProxyImpl', () => ({
  LLMProxySvcImpl: class MockLLMProxySvcImpl {
    async chat(req: unknown): Promise<MockChatResponse> {
      chatRequestCapture = req
      return await chatMock(req)
    }

    async listProfiles(): Promise<{ profiles: never[] }> {
      return { profiles: [] }
    }

    async serverStatus(): Promise<{ online: boolean }> {
      return { online: true }
    }
  }
}))

vi.mock('../assistantRuntime/runtime', () => ({
  getAssistantRuntime: vi.fn(() => ({
    callTool: vi.fn((...args: unknown[]) => {
      toolCallCapture = args
      return callToolMock(args[0], args[1], args[2])
    })
  }))
}))

vi.mock('../mcp/platform/httpBridge', () => ({
  getConfiguredMcpLegacySseMessagePath: vi.fn(() => '/api/mcp/sse/message'),
  getConfiguredMcpLegacySsePath: vi.fn(() => '/api/mcp/sse'),
  handleMagicPotMcpHttpBridgeRequest: vi.fn(
    async ({
      req,
      res,
      parsedBody
    }: {
      req: { method?: string; headers: Record<string, string | string[] | undefined> }
      res: {
        writeHead: (statusCode: number, headers?: Record<string, string>) => void
        end: (chunk?: string) => void
      }
      parsedBody?: unknown
    }) => {
      mcpBridgeRequestCapture = {
        method: req.method,
        accept: Array.isArray(req.headers.accept) ? req.headers.accept[0] : req.headers.accept,
        parsedBody
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }
  ),
  handleMagicPotMcpLegacySseMessageRequest: vi.fn(
    async ({
      res
    }: {
      res: {
        writeHead: (statusCode: number, headers?: Record<string, string>) => void
        end: (chunk?: string) => void
      }
    }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }
  ),
  handleMagicPotMcpLegacySseOpenRequest: vi.fn(
    async ({
      res
    }: {
      res: {
        writeHead: (statusCode: number, headers?: Record<string, string>) => void
        end: (chunk?: string) => void
      }
    }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end()
    }
  )
}))

import { getLLMProxyServerStatus, startLLMProxyServer, stopLLMProxyServer } from './server'

const waitForServer = async (port: number): Promise<void> => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: {
          Authorization: 'Bearer proxy-secret'
        }
      })
      if (response.ok) {
        return
      }
    } catch {
      // retry until the server is up
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for test server on port ${port}`)
}

const waitForListeningPort = async (): Promise<number> => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const status = getLLMProxyServerStatus()
    if (status.running && typeof status.port === 'number' && status.port > 0) {
      return status.port
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for test server to bind a port')
}

describe('LLM proxy server legacy bot removal', () => {
  let port = 0

  beforeEach(async () => {
    port = 0
    testArtifactDir = await createNodeTestArtifactDir('llm-proxy-server')
    currentConfig = {
      ...DEFAULT_CONFIG,
      download_dir: testArtifactDir,
      chat_config: {
        ...DEFAULT_CONFIG.chat_config,
        webhook_secret: 'mcp-secret'
      },
      local_llm_server_config: {
        ...DEFAULT_CONFIG.local_llm_server_config,
        enable_server: true,
        port,
        access_tokens: [
          {
            id: 'canvas-agent-2',
            label: 'Canvas Agent 2',
            token: 'proxy-secret',
            resource_scope: 'canvas-agent-2'
          }
        ],
        access_token: ''
      },
      mcp_config: {
        ...DEFAULT_CONFIG.mcp_config,
        server: {
          ...DEFAULT_CONFIG.mcp_config.server,
          enabled: true,
          path: '/api/mcp',
          auth_token: ''
        }
      }
    }
    chatRequestCapture = null
    toolCallCapture = null
    mcpBridgeRequestCapture = null
    chatMock.mockClear()
    callToolMock.mockClear()
    startLLMProxyServer()
    port = await waitForListeningPort()
    await waitForServer(port)
  })

  afterEach(async () => {
    stopLLMProxyServer()
    await fs.rm(testArtifactDir, { recursive: true, force: true })
    testArtifactDir = ''
  })

  it('falls through retired /api/bot endpoints to the default 404 handler', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/bot/status`, {
      headers: {
        Authorization: 'Bearer proxy-secret'
      }
    })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({
      error: 'Not Found',
      path: '/api/bot/status'
    })
  })

  it('keeps explicit tool execution available through /api/tools/call', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tools/call`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer proxy-secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: 'generic',
        scopeType: 'thread',
        scopeId: 'chat-session-1',
        threadId: 'chat-session-1',
        toolName: 'session.status',
        args: { verbose: true },
        allowedToolNames: ['session.status']
      })
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      result: {
        content: 'tool ok',
        metadata: { ok: true }
      }
    })
    expect(toolCallCapture).toMatchObject([
      {
        channel: 'generic',
        scopeType: 'thread',
        scopeId: 'chat-session-1',
        threadId: 'chat-session-1'
      },
      'session.status',
      { verbose: true },
      {
        allowedToolNames: ['session.status']
      }
    ])
  })

  it('keeps MCP auth working through the local secret helper', async () => {
    const unauthorizedResponse = await fetch(`http://127.0.0.1:${port}/api/mcp`)
    const unauthorizedBody = await unauthorizedResponse.json()

    expect(unauthorizedResponse.status).toBe(401)
    expect(unauthorizedBody).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message: 'Unauthorized MCP request.'
      }
    })

    const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      headers: {
        Authorization: 'Bearer mcp-secret'
      }
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(mcpBridgeRequestCapture).toMatchObject({
      method: 'GET',
      accept: 'application/json, text/event-stream',
      parsedBody: undefined
    })
  })

  it('rewrites raw local-media attachments in the final /api/chat response to scoped proxy URLs', async () => {
    const scopedAssetPath = path.join(testArtifactDir, 'source-assets', 'reference.png')
    await fs.mkdir(path.dirname(scopedAssetPath), { recursive: true })
    await fs.writeFile(scopedAssetPath, 'png-bytes', 'utf8')
    rawLocalMediaPath = `file:///${scopedAssetPath.replace(/\\/g, '/')}`

    chatMock.mockResolvedValueOnce({
      content: `Inspect ${rawLocalMediaPath}`,
      imageUrl: rawLocalMediaPath,
      attachments: [
        {
          type: 'image',
          url: rawLocalMediaPath,
          mimeType: 'image/png',
          fileName: 'reference.png'
        }
      ]
    })

    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer proxy-secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'inspect scoped asset' }],
        route: {
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2'
        }
      })
    })
    const responseText = await response.text()
    const body = JSON.parse(responseText)

    expect(response.status).toBe(200)
    expect(responseText).not.toContain(rawLocalMediaPath)
    expect(responseText).toContain('/api/images/canvas-agent-2/')
    expect(body).toMatchObject({
      attachments: [
        expect.objectContaining({
          url: expect.stringContaining('/api/images/canvas-agent-2/')
        })
      ],
      imageUrl: expect.stringContaining('/api/images/canvas-agent-2/')
    })
    expect(body.content).toContain('/api/images/canvas-agent-2/')
    expect(body.content).not.toContain(rawLocalMediaPath)
    expect(chatRequestCapture).toMatchObject({
      route: {
        channel: 'canvas',
        scopeType: 'thread',
        scopeId: 'canvas-1',
        threadId: 'agent-2'
      }
    })
  })

  it('hard-disables canvas sync while keeping /api/chat route forwarding intact', async () => {
    const syncResponse = await fetch(`http://127.0.0.1:${port}/api/canvas/sync`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer proxy-secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        projectId: 'canvas-1',
        paneId: 'agent-2',
        storageDirName: 'Canvas-Project__canvas-1',
        route: {
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2'
        },
        files: [
          {
            relativePath: 'project.mpcanvas',
            dataBase64: Buffer.from('{"version":1}', 'utf8').toString('base64')
          },
          {
            relativePath: 'assets/images/sprite.png',
            dataBase64: Buffer.from('sprite-bytes').toString('base64')
          }
        ]
      })
    })
    const syncBody = await syncResponse.json()

    expect(syncResponse.status).toBe(410)
    expect(syncBody).toEqual({
      error:
        'Canvas mirroring has been removed. Remote agents can only access content explicitly attached to the current request.'
    })
    await expect(fs.stat(path.join(testArtifactDir, 'remote-canvas-sync'))).rejects.toThrow()

    const chatResponse = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer proxy-secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'inspect canvas mirror' }],
        route: {
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2'
        }
      })
    })

    expect(chatResponse.status).toBe(200)
    expect(chatRequestCapture).toMatchObject({
      route: {
        channel: 'canvas',
        scopeType: 'thread',
        scopeId: 'canvas-1',
        threadId: 'agent-2'
      }
    })
  })
})
