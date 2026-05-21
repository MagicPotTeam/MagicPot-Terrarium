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

describe('LLM proxy server legacy compatibility', () => {
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

  it('maps legacy /api/bot/status to the current status endpoint', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/bot/status`, {
      headers: {
        Authorization: 'Bearer proxy-secret'
      }
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      online: true,
      compatibility: {
        endpoint: '/api/status',
        legacyEndpoint: '/api/bot/status',
        chatEndpoint: '/api/chat'
      }
    })
  })

  it('accepts legacy bot secret headers as proxy tokens', async () => {
    for (const headerName of ['X-MagicPot-Bot-Secret', 'X-Bot-Secret']) {
      chatRequestCapture = null
      const response = await fetch(`http://127.0.0.1:${port}/api/bot/message`, {
        method: 'POST',
        headers: {
          [headerName]: 'proxy-secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: `hello through ${headerName}` })
      })
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        content: 'chat ok',
        reply: 'chat ok',
        message: 'chat ok'
      })
      expect(chatRequestCapture).toMatchObject({
        messages: [{ role: 'user', content: `hello through ${headerName}` }]
      })
    }
  })

  it('normalizes legacy bot/message payloads through the current chat flow', async () => {
    const legacyCases = [
      {
        endpoint: '/api/bot/message',
        body: {
          message: 'from message',
          systemPrompt: 'legacy system',
          sessionId: 'legacy-session',
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2',
          senderId: 'user-1',
          senderName: 'Ada'
        },
        expectedRequest: {
          messages: [{ role: 'user', content: 'from message' }],
          systemPrompt: 'legacy system',
          conversationId: 'proxy:canvas-agent-2:legacy-session',
          route: {
            channel: 'canvas',
            scopeType: 'thread',
            scopeId: 'canvas-1',
            threadId: 'agent-2',
            senderId: 'user-1',
            senderName: 'Ada'
          }
        }
      },
      {
        endpoint: '/api/bot/chat',
        body: {
          messages: [{ role: 'user', content: 'from messages' }],
          conversationId: 'legacy-conversation',
          route: {
            channel: 'generic',
            scopeType: 'thread',
            scopeId: 'chat-session-1',
            threadId: 'chat-session-1'
          }
        },
        expectedRequest: {
          messages: [{ role: 'user', content: 'from messages' }],
          conversationId: 'proxy:canvas-agent-2:legacy-conversation',
          route: {
            channel: 'generic',
            scopeType: 'thread',
            scopeId: 'chat-session-1',
            threadId: 'chat-session-1'
          }
        }
      },
      {
        endpoint: '/api/message',
        body: { content: 'from content' },
        expectedRequest: {
          messages: [{ role: 'user', content: 'from content' }]
        }
      },
      {
        endpoint: '/api/message',
        body: { text: 'from text' },
        expectedRequest: {
          messages: [{ role: 'user', content: 'from text' }]
        }
      }
    ]

    for (const legacyCase of legacyCases) {
      chatRequestCapture = null
      const response = await fetch(`http://127.0.0.1:${port}${legacyCase.endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer proxy-secret',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(legacyCase.body)
      })
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        content: 'chat ok',
        reply: 'chat ok',
        message: 'chat ok'
      })
      expect(chatRequestCapture).toMatchObject(legacyCase.expectedRequest)
    }
  })

  it('handles legacy payload edge cases predictably', async () => {
    for (const rawBody of ['', '[]']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/bot/message`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer proxy-secret',
          'Content-Type': 'application/json'
        },
        body: rawBody
      })
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual({ error: 'Missing message content or messages.' })
    }

    chatRequestCapture = null
    const response = await fetch(`http://127.0.0.1:${port}/api/bot/message`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer proxy-secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'fallback should not be used',
        messages: [
          'string message',
          7,
          null,
          '',
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'part one' },
              { text: ' part two' },
              { type: 'image_url', image_url: { url: 'https://example.invalid/reference.png' } }
            ]
          },
          { role: 'system', text: 42 },
          { role: 'unknown', content: '' },
          { not: 'a message' }
        ],
        profileId: 123,
        profileScope: 'qapp'
      })
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.reply).toBe('chat ok')
    expect(chatRequestCapture).toMatchObject({
      messages: [
        { role: 'user', content: 'string message' },
        { role: 'user', content: '7' },
        { role: 'assistant', content: 'part one part two' },
        { role: 'system', content: '42' }
      ],
      profileId: '123',
      profileScope: 'qapp'
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

    const signedMediaResponse = await fetch(body.imageUrl)
    expect(signedMediaResponse.status).toBe(200)
    expect(await signedMediaResponse.text()).toBe('png-bytes')

    const unsignedScopedUrl = new URL(body.imageUrl)
    unsignedScopedUrl.search = ''
    const noTokenResponse = await fetch(String(unsignedScopedUrl))
    expect(noTokenResponse.status).toBe(401)

    const wrongTokenResponse = await fetch(String(unsignedScopedUrl), {
      headers: {
        Authorization: 'Bearer wrong-token'
      }
    })
    expect(wrongTokenResponse.status).toBe(401)

    const wrongScopeUrl = new URL(unsignedScopedUrl)
    wrongScopeUrl.pathname = wrongScopeUrl.pathname.replace('/canvas-agent-2/', '/other-scope/')
    const wrongScopeResponse = await fetch(String(wrongScopeUrl), {
      headers: {
        Authorization: 'Bearer proxy-secret'
      }
    })
    expect(wrongScopeResponse.status).toBe(401)

    expect(chatRequestCapture).toMatchObject({
      route: {
        channel: 'canvas',
        scopeType: 'thread',
        scopeId: 'canvas-1',
        threadId: 'agent-2'
      }
    })
  })

  it('returns ordinary JSON when OpenAI-compatible clients request streaming', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer proxy-secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'profile-1',
        stream: true,
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'hello' }
        ]
      })
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('x-magicpot-stream-fallback')).toBe('non-stream-json')
    expect(response.headers.get('access-control-expose-headers')).toContain(
      'X-MagicPot-Stream-Fallback'
    )
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'profile-1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'chat ok'
          },
          finish_reason: 'stop'
        }
      ]
    })
    expect(chatRequestCapture).toMatchObject({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system prompt',
      profileId: 'profile-1'
    })
  })

  it('returns a canvas sync no-op while keeping /api/chat route forwarding intact', async () => {
    const syncResponse = await fetch(`http://127.0.0.1:${port}/api/canvas/sync`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer proxy-secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        projectId: 'canvas-1',
        paneId: 'agent-2',
        storageDirName: '.Canvas-Project__canvas-1',
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

    expect(syncResponse.status).toBe(200)
    expect(syncBody).toMatchObject({
      ok: true,
      mirrored: false,
      error: expect.stringContaining('Canvas mirroring has been removed.'),
      hint: expect.stringContaining('Attach required files')
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
