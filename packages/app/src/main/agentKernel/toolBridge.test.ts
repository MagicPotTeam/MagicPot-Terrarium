import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantToolResultError } from '../assistantRuntime/toolFailure'
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

  it('exposes file mutation tools with high-risk filesystem effect metadata', () => {
    const names = [
      'files.write',
      'files.edit',
      'files.multi-edit',
      'files.json.write',
      'files.snapshot.restore'
    ]
    const registry = createToolRegistry(names)
    syncAssistantToolsWithAgentKernel(registry)
    for (const name of names) {
      expect(getAgentKernel().getTool(name)?.tool.metadata).toMatchObject({
        source: 'assistant',
        effects: [{ kind: 'filesystem.write', risk: 'high' }]
      })
    }
  })

  it('exposes the policy-gated agent terminal through kernel sync and invocation', async () => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({
      allowed: true,
      policyId: 'policy-terminal'
    })
    const registry = createToolRegistry(['safe.tool', ' Agent.Terminal.Run '])

    syncAssistantToolsWithAgentKernel(registry)

    expect(
      getAgentKernel()
        .listCapabilities()
        .map((capability) => capability.capabilityId)
    ).toEqual(['chat.tool.safe.tool', 'chat.tool.agent.terminal.run'])
    expect(getAgentKernel().getTool('agent.terminal.run')).toBeDefined()

    await expect(
      invokeAssistantToolViaKernel({
        toolRegistry: registry,
        toolName: ' Agent.Terminal.Run ',
        args: { command: 'pwd' },
        context
      })
    ).resolves.toEqual({
      content: 'called:agent.terminal.run',
      metadata: { args: { command: 'pwd' } }
    })

    expect(registry.callTool).toHaveBeenCalled()
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

  it('preserves a reported failure body through kernel registration, event, audit and thrown gateway result', async () => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({ allowed: true, policyId: 'policy-allow' })
    const receipt = { content: '{"applied":1,"failed":1,"afterSha256":"actual"}', metadata: { snapshotId: 'before-snapshot', applied: 1, failed: 1 } }
    const registry = createToolRegistry(['partial.tool'])
    registry.callTool = vi.fn(async () => { throw new AssistantToolResultError({ message: 'Second edit did not match.', code: 'EDIT_STEP_FAILED' }, receipt) })
    const kernel = getAgentKernel()
    const gateway = vi.spyOn(kernel, 'invokeAuthorizedTool')
    try {
      await expect(invokeAssistantToolViaKernel({ toolRegistry: registry, toolName: 'partial.tool', args: {}, context })).rejects.toMatchObject({
        name: 'AssistantToolResultError', message: 'Second edit did not match.', code: 'EDIT_STEP_FAILED', toolResult: receipt
      })
      const result = await gateway.mock.results[0].value
      expect(result).toMatchObject({ ok: false, ...receipt, error: { message: 'Second edit did not match.', code: 'EDIT_STEP_FAILED' } })
      expect(kernel.listEvents().at(-1)?.metadata).toMatchObject({ ok: false, toolName: 'partial.tool' })
      expect(appendMagicPotMcpAudit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'observe', metadata: expect.objectContaining({ ok: false }) }))
      expect(registry.callTool).toHaveBeenCalledOnce()
    } finally { gateway.mockRestore() }
  })

  it.each([false, true])('preserves a settled failed receipt when cancellation races kernel normalization (empty=%s)', async (empty) => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({ allowed: true, policyId: 'policy-allow' })
    const controller = new AbortController(), cancellation = new Error('cancelled after dispatch')
    const receipt = empty ? { content: '' } : { content: 'actual failed operation output', metadata: { rollback: { attempted: true, succeeded: false } } }
    const failure = new AssistantToolResultError({ message: 'Commit failed and rollback did not restore all files.', code: 'EDIT_FAILED' }, receipt)
    const registry = createToolRegistry(['partial.tool'])
    registry.callTool = vi.fn(async () => { controller.abort(cancellation); throw failure })
    await expect(invokeAssistantToolViaKernel({ toolRegistry: registry, toolName: 'partial.tool', args: {}, context, signal: controller.signal })).rejects.toMatchObject({
      name: 'AssistantToolResultError', message: failure.message, code: failure.code, toolResult: receipt
    })
    expect(getAgentKernel().listEvents().at(-1)?.metadata).toMatchObject({ ok: false, toolName: 'partial.tool' })
    expect(registry.callTool).toHaveBeenCalledOnce()
  })

  it('still rejects a successful kernel result when cancelled during dispatch', async () => {
    vi.mocked(authorizeMagicPotMcpToolInvocation).mockReturnValue({ allowed: true, policyId: 'policy-allow' })
    const controller = new AbortController(), cancellation = new Error('cancelled during successful dispatch')
    const registry = createToolRegistry(['safe.tool'])
    registry.callTool = vi.fn(async () => { controller.abort(cancellation); return { content: 'not delivered as success' } })
    await expect(invokeAssistantToolViaKernel({ toolRegistry: registry, toolName: 'safe.tool', args: {}, context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', message: cancellation.message })
    expect(registry.callTool).toHaveBeenCalledOnce()
    expect(getAgentKernel().listEvents().filter(event => event.type === 'tool.invoked')).toEqual([])
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
