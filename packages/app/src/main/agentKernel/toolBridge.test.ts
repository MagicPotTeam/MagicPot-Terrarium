import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantToolRegistry } from '../assistantRuntime/toolRegistry'
import { getAgentKernel } from './agentKernel'
import {
  appendMagicPotMcpAudit,
  authorizeMagicPotMcpToolInvocation,
  refreshMagicPotMcpPlatformRuntime
} from '../mcp/platform/runtime'
import { invokeAssistantToolViaKernel, syncAssistantToolsWithAgentKernel } from './toolBridge'

vi.mock('../mcp/platform/runtime', () => ({
  appendMagicPotMcpAudit: vi.fn(),
  authorizeMagicPotMcpToolInvocation: vi.fn(),
  refreshMagicPotMcpPlatformRuntime: vi.fn()
}))

const route = {
  channel: 'generic',
  scopeType: 'dm' as const,
  scopeId: 'tool-bridge'
}

const context = {
  config: {} as Parameters<typeof invokeAssistantToolViaKernel>[0]['context']['config'],
  route,
  sessionStore: {} as Parameters<typeof invokeAssistantToolViaKernel>[0]['context']['sessionStore'],
  taskState: {
    sessionKey: 'generic:dm:tool-bridge',
    running: false,
    queuedCount: 0,
    updatedAt: 1,
    cancelRequested: false
  }
}

describe('toolBridge', () => {
  beforeEach(() => {
    getAgentKernel().clear()
    vi.mocked(appendMagicPotMcpAudit).mockReset()
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReset()
    vi.mocked(refreshMagicPotMcpPlatformRuntime).mockReset()
  })

  it('syncs assistant tools into the kernel and removes stale tool capabilities', () => {
    const registry = createToolRegistry(['first.tool', 'second.tool'])

    syncAssistantToolsWithAgentKernel(registry)

    expect(
      getAgentKernel()
        .listCapabilities()
        .map((capability) => capability.capabilityId)
    ).toEqual(['chat.tool.first.tool', 'chat.tool.second.tool'])

    registry.listTools = () => [
      {
        name: 'second.tool',
        description: 'second.tool description',
        inputSchema: { type: 'object' }
      }
    ]
    syncAssistantToolsWithAgentKernel(registry)

    expect(
      getAgentKernel()
        .listCapabilities()
        .map((capability) => capability.capabilityId)
    ).toEqual(['chat.tool.second.tool'])
    expect(refreshMagicPotMcpPlatformRuntime).toHaveBeenCalled()
  })

  it('keeps sync usable when MCP refresh is not initialized', () => {
    vi.mocked(refreshMagicPotMcpPlatformRuntime).mockImplementationOnce(() => {
      throw new Error('not ready')
    })

    expect(() => syncAssistantToolsWithAgentKernel(createToolRegistry(['safe.tool']))).not.toThrow()
    expect(getAgentKernel().getTool('safe.tool')).toBeDefined()
  })

  it('invokes assistant tools through kernel permission and audit flow', async () => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({
      allowed: true,
      policyId: 'policy-allow'
    })
    const registry = createToolRegistry(['safe.tool'])

    await expect(
      invokeAssistantToolViaKernel({
        toolRegistry: registry,
        toolName: 'safe.tool',
        args: { value: 'demo' },
        context
      })
    ).resolves.toEqual({
      content: 'called:safe.tool',
      metadata: { args: { value: 'demo' } }
    })

    expect(appendMagicPotMcpAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'allow',
        target: 'chat.tool.safe.tool',
        metadata: expect.objectContaining({ policyId: 'policy-allow' })
      })
    )
  })

  it('denies tool invocation when policy rejects the kernel call', async () => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({
      allowed: false,
      reason: 'not allowed',
      policyId: 'policy-deny'
    })

    await expect(
      invokeAssistantToolViaKernel({
        toolRegistry: createToolRegistry(['blocked.tool']),
        toolName: 'blocked.tool',
        args: {},
        context
      })
    ).rejects.toThrow('not allowed')

    expect(appendMagicPotMcpAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'deny',
        reason: 'not allowed',
        metadata: expect.objectContaining({ policyId: 'policy-deny' })
      })
    )
  })

  it('uses the default denial message when policy omits a reason', async () => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({
      allowed: false,
      policyId: 'policy-deny'
    })

    await expect(
      invokeAssistantToolViaKernel({
        toolRegistry: createToolRegistry(['blocked.tool']),
        toolName: 'blocked.tool',
        args: {},
        context
      })
    ).rejects.toThrow('Tool "blocked.tool" is not allowed.')
  })

  it('handles kernel results that report failure or empty success content', async () => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({
      allowed: true,
      policyId: 'policy-allow'
    })
    const kernel = getAgentKernel()
    const invokeSpy = vi
      .spyOn(kernel, 'invokeTool')
      .mockResolvedValueOnce({
        invocationId: 'invoke-1',
        toolName: 'empty.tool',
        sessionKey: 'generic:dm:tool-bridge',
        ok: true,
        startedAt: 1,
        finishedAt: 1,
        durationMs: 0
      })
      .mockResolvedValueOnce({
        invocationId: 'invoke-2',
        toolName: 'failed.tool',
        sessionKey: 'generic:dm:tool-bridge',
        ok: false,
        error: { message: 'kernel failed' },
        startedAt: 1,
        finishedAt: 1,
        durationMs: 0
      })
      .mockResolvedValueOnce({
        invocationId: 'invoke-3',
        toolName: 'fallback-failed.tool',
        sessionKey: 'generic:dm:tool-bridge',
        ok: false,
        startedAt: 1,
        finishedAt: 1,
        durationMs: 0
      })

    await expect(
      invokeAssistantToolViaKernel({
        toolRegistry: createToolRegistry(['empty.tool']),
        toolName: 'empty.tool',
        args: {},
        context
      })
    ).resolves.toEqual({ content: '', metadata: undefined })

    await expect(
      invokeAssistantToolViaKernel({
        toolRegistry: createToolRegistry(['failed.tool']),
        toolName: 'failed.tool',
        args: {},
        context
      })
    ).rejects.toThrow('kernel failed')

    await expect(
      invokeAssistantToolViaKernel({
        toolRegistry: createToolRegistry(['fallback-failed.tool']),
        toolName: 'fallback-failed.tool',
        args: {},
        context
      })
    ).rejects.toThrow('Tool "fallback-failed.tool" failed.')

    invokeSpy.mockRestore()
  })

  it('stringifies non-error kernel invocation failures in observe audits', async () => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({
      allowed: true,
      policyId: 'policy-observe'
    })
    const kernel = getAgentKernel()
    const invokeSpy = vi.spyOn(kernel, 'invokeTool').mockRejectedValueOnce('string failure')

    await expect(
      invokeAssistantToolViaKernel({
        toolRegistry: createToolRegistry(['string.failure']),
        toolName: 'string.failure',
        args: {},
        context
      })
    ).rejects.toBe('string failure')

    expect(appendMagicPotMcpAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'observe',
        reason: 'string failure'
      })
    )

    invokeSpy.mockRestore()
  })

  it('records observe audits when assistant tool execution fails', async () => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({
      allowed: true,
      policyId: 'policy-observe'
    })
    const registry = createToolRegistry(['failing.tool'])
    registry.callTool = vi.fn(async () => {
      throw new Error('tool failed')
    })

    await expect(
      invokeAssistantToolViaKernel({
        toolRegistry: registry,
        toolName: 'failing.tool',
        args: {},
        context
      })
    ).rejects.toThrow('tool failed')

    expect(appendMagicPotMcpAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'observe',
        reason: 'tool failed',
        metadata: expect.objectContaining({ policyId: 'policy-observe' })
      })
    )
  })

  it('rejects synced tool invokers that are called without tool context metadata', async () => {
    const registry = createToolRegistry(['missing.context'])
    syncAssistantToolsWithAgentKernel(registry)
    const tool = getAgentKernel().getTool('missing.context')
    const session = getAgentKernel().registerSession(route)

    await expect(
      tool?.invoker?.({
        toolName: 'missing.context',
        args: {},
        session,
        source: 'assistant'
      })
    ).rejects.toThrow('Missing kernel tool context')
  })
})

function createToolRegistry(toolNames: string[]): AssistantToolRegistry {
  return {
    listTools: () =>
      toolNames.map((name) => ({
        name,
        description: `${name} description`,
        inputSchema: { type: 'object' }
      })),
    callTool: vi.fn(async (toolName, args) => ({
      content: `called:${toolName}`,
      metadata: { args }
    }))
  } as unknown as AssistantToolRegistry
}
