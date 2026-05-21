import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleManagedMagicPotMcpHttpBridgeRequest = vi.fn()

vi.mock('../../config/config', () => ({
  getConfig: () => ({})
}))

vi.mock('./managedHttpBridge', () => ({
  handleManagedMagicPotMcpHttpBridgeRequest
}))

describe('readMagicPotMcpPlatformEnv', () => {
  it('parses the opt-in stdio desktop flag', async () => {
    const { readMagicPotMcpPlatformEnv } = await import('./runtime')

    expect(readMagicPotMcpPlatformEnv({ MAGICPOT_MCP_STDIO_SERVER: '1' })).toEqual({
      enableStdioServer: true
    })
    expect(readMagicPotMcpPlatformEnv({ MAGICPOT_MCP_STDIO_SERVER: 'false' })).toEqual({
      enableStdioServer: false
    })
  })
})

describe('syncMagicPotMcpPlatformDesktopTransports', () => {
  beforeEach(async () => {
    vi.resetModules()
    handleManagedMagicPotMcpHttpBridgeRequest.mockReset()
  })

  it('starts the desktop stdio transport only when explicitly enabled', async () => {
    const runtimeModule = await import('./runtime')
    const runtime = runtimeModule.getMagicPotMcpPlatformRuntime()
    const startStdioSpy = vi
      .spyOn(
        (runtime as unknown as { platform: { startStdio: () => Promise<void> } }).platform,
        'startStdio'
      )
      .mockResolvedValue(undefined)

    await runtimeModule.syncMagicPotMcpPlatformDesktopTransports({
      enableStdioServer: false
    })
    expect(startStdioSpy).not.toHaveBeenCalled()

    await runtimeModule.syncMagicPotMcpPlatformDesktopTransports({
      enableStdioServer: true
    })
    expect(startStdioSpy).toHaveBeenCalledTimes(1)

    await runtimeModule.syncMagicPotMcpPlatformDesktopTransports({
      enableStdioServer: true
    })
    expect(startStdioSpy).toHaveBeenCalledTimes(1)
  })
})

describe('negotiateMagicPotMcpSession', () => {
  beforeEach(async () => {
    vi.resetModules()
    handleManagedMagicPotMcpHttpBridgeRequest.mockReset()
  })

  it('stores the normalized shared route for a negotiated MCP session', async () => {
    const runtimeModule = await import('./runtime')

    const negotiated = runtimeModule.negotiateMagicPotMcpSession({
      sessionKey: 'canvas:thread:canvas-1:thread:agent-2',
      route: {
        channel: ' canvas ',
        scopeType: 'invalid' as never,
        scopeId: '   ',
        threadId: ' agent-2 ',
        senderId: ' sender-1 '
      }
    })

    expect(runtimeModule.getMagicPotMcpRouteForSession(negotiated.sessionId)).toEqual({
      channel: 'canvas',
      scopeType: 'dm',
      scopeId: 'default',
      threadId: 'agent-2',
      senderId: 'sender-1'
    })
  })
})

describe('handleStreamableHttpRequest', () => {
  beforeEach(async () => {
    vi.resetModules()
    handleManagedMagicPotMcpHttpBridgeRequest.mockReset().mockResolvedValue(undefined)
  })

  it('delegates each request to a fresh bridge helper while keeping one platform snapshot', async () => {
    const runtimeModule = await import('./runtime')
    const runtime = runtimeModule.getMagicPotMcpPlatformRuntime()

    await runtime.handleStreamableHttpRequest({
      req: { method: 'POST', headers: {} } as never,
      res: {} as never,
      parsedBody: { jsonrpc: '2.0' },
      endpoint: '/api/mcp'
    })
    await runtime.handleStreamableHttpRequest({
      req: { method: 'POST', headers: {} } as never,
      res: {} as never,
      parsedBody: { jsonrpc: '2.0', id: 2 },
      endpoint: '/api/mcp'
    })

    expect(handleManagedMagicPotMcpHttpBridgeRequest).toHaveBeenCalledTimes(2)
    expect(runtimeModule.getMagicPotMcpPlatformStatus().health.transports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'streamable-http',
          status: 'ready',
          endpoint: '/api/mcp'
        })
      ])
    )

    await runtimeModule.stopMagicPotMcpPlatformRuntime()

    expect(runtimeModule.getMagicPotMcpPlatformStatus().health.transports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'streamable-http',
          status: 'stopped',
          endpoint: '/api/mcp'
        })
      ])
    )
  })
})

describe('authorizeMagicPotMcpToolInvocation', () => {
  beforeEach(async () => {
    vi.resetModules()
    handleManagedMagicPotMcpHttpBridgeRequest.mockReset()
  })

  it('allows approved canvas tools for assistant actors', async () => {
    const runtimeModule = await import('./runtime')

    const decision = runtimeModule.authorizeMagicPotMcpToolInvocation({
      actor: 'assistant:session-1',
      action: 'tool.invoke',
      target: 'chat.tool.session.status',
      metadata: {
        route: {
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2'
        }
      }
    })

    expect(decision).toEqual({
      allowed: true,
      policyId: 'magicpot-assistant-canvas-tool'
    })
  })

  it('allows approved canvas tools for negotiated bot actors', async () => {
    const runtimeModule = await import('./runtime')

    const negotiated = runtimeModule.negotiateMagicPotMcpSession({
      sessionKey: 'canvas:thread:canvas-1:thread:agent-2',
      route: {
        channel: 'canvas',
        scopeType: 'thread',
        scopeId: 'canvas-1',
        threadId: 'agent-2'
      }
    })

    const decision = runtimeModule.authorizeMagicPotMcpToolInvocation({
      actor: `bot:${negotiated.sessionId}`,
      action: 'tool.invoke',
      target: 'chat.tool.session.status',
      sessionId: negotiated.sessionId
    })

    expect(decision).toEqual({
      allowed: true,
      policyId: 'magicpot-assistant-canvas-tool'
    })
  })

  it('denies non-approved canvas tools for assistant actors', async () => {
    const runtimeModule = await import('./runtime')

    const decision = runtimeModule.authorizeMagicPotMcpToolInvocation({
      actor: 'assistant:session-1',
      action: 'tool.invoke',
      target: 'chat.tool.workspace.attach',
      metadata: {
        route: {
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2'
        }
      }
    })

    expect(decision.allowed).toBe(false)
    expect(decision.policyId).toBe('magicpot-chat-tool-deny')
    expect(decision.reason).toContain('outside the current-canvas sandbox')
  })

  it('denies out-of-scope canvas file reads', async () => {
    const runtimeModule = await import('./runtime')

    const decision = runtimeModule.authorizeMagicPotMcpToolInvocation({
      actor: 'assistant:session-1',
      action: 'file.read',
      target: 'C:/tmp/other-project/secret.txt',
      metadata: {
        route: {
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2'
        },
        currentCanvasRootDir: 'C:/tmp/current-canvas/canvas-1',
        filePath: 'C:/tmp/other-project/secret.txt'
      }
    })

    expect(decision.allowed).toBe(false)
    expect(decision.policyId).toBe('magicpot-assistant-file-scope-deny')
  })

  it('denies mirrored canvas file reads for assistant actors', async () => {
    const runtimeModule = await import('./runtime')

    const decision = runtimeModule.authorizeMagicPotMcpToolInvocation({
      actor: 'assistant:session-1',
      action: 'file.read',
      target: 'C:/tmp/remote-canvas-sync/default/.Canvas-Project__canvas-1/project.mpcanvas',
      metadata: {
        route: {
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2'
        },
        mirroredCanvasRootDir: 'C:/tmp/remote-canvas-sync/default/.Canvas-Project__canvas-1',
        filePath: 'C:/tmp/remote-canvas-sync/default/.Canvas-Project__canvas-1/project.mpcanvas'
      }
    })

    expect(decision.allowed).toBe(false)
    expect(decision.policyId).toBe('magicpot-assistant-file-root-deny')
  })

  it('denies server-side mirrored canvas file reads for assistant actors', async () => {
    const runtimeModule = await import('./runtime')

    const decision = runtimeModule.authorizeMagicPotMcpToolInvocation({
      actor: 'assistant:session-1',
      action: 'file.read',
      target: 'C:/tmp/server-canvas/default/.Canvas-Project__canvas-1/project.mpcanvas',
      metadata: {
        route: {
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2'
        },
        serverCanvasRootDir: 'C:/tmp/server-canvas/default/.Canvas-Project__canvas-1',
        filePath: 'C:/tmp/server-canvas/default/.Canvas-Project__canvas-1/project.mpcanvas'
      }
    })

    expect(decision.allowed).toBe(false)
    expect(decision.policyId).toBe('magicpot-assistant-file-root-deny')
  })

  it('allows explicitly scoped current-canvas file reads for assistant actors', async () => {
    const runtimeModule = await import('./runtime')

    const decision = runtimeModule.authorizeMagicPotMcpToolInvocation({
      actor: 'assistant:session-1',
      action: 'file.read',
      target: 'C:/tmp/current-canvas/canvas-1/project.mpcanvas',
      metadata: {
        route: {
          channel: 'canvas',
          scopeType: 'thread',
          scopeId: 'canvas-1',
          threadId: 'agent-2'
        },
        currentCanvasRootDir: 'C:/tmp/current-canvas/canvas-1',
        filePath: 'C:/tmp/current-canvas/canvas-1/project.mpcanvas'
      }
    })

    expect(decision).toEqual({
      allowed: true,
      policyId: 'magicpot-assistant-file-scope'
    })
  })

  it('keeps non-canvas workspace tools available for legacy assistant routes', async () => {
    const runtimeModule = await import('./runtime')

    const decision = runtimeModule.authorizeMagicPotMcpToolInvocation({
      actor: 'assistant:session-1',
      action: 'tool.invoke',
      target: 'chat.tool.workspace.context',
      metadata: {
        route: {
          channel: 'generic',
          scopeType: 'group',
          scopeId: 'room-1',
          threadId: 'thread-99'
        }
      }
    })

    expect(decision).toEqual({
      allowed: true,
      policyId: 'magicpot-assistant-legacy-noncanvas'
    })
  })

  it('keeps non-canvas file actions on the legacy path until they are explicitly sandboxed', async () => {
    const runtimeModule = await import('./runtime')

    const decision = runtimeModule.authorizeMagicPotMcpToolInvocation({
      actor: 'assistant:session-1',
      action: 'file.read',
      target: 'C:/tmp/legacy-assistant/context.txt',
      metadata: {
        route: {
          channel: 'generic',
          scopeType: 'group',
          scopeId: 'room-1',
          threadId: 'thread-99'
        },
        filePath: 'C:/tmp/legacy-assistant/context.txt'
      }
    })

    expect(decision).toEqual({
      allowed: true,
      policyId: 'magicpot-assistant-legacy-noncanvas-file'
    })
  })
})
