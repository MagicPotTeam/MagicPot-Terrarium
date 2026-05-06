import { beforeEach, describe, expect, it, vi } from 'vitest'

const callToolMock = vi.fn()
const appendAuditMock = vi.fn()
const authorizeMock = vi.fn()
const getRouteMock = vi.fn()

vi.mock('../assistantRuntime/runtime', () => ({
  getAssistantRuntime: () => ({
    callTool: callToolMock
  })
}))

vi.mock('./platform/runtime', () => ({
  appendMagicPotMcpAudit: (...args: unknown[]) => appendAuditMock(...args),
  authorizeMagicPotMcpToolInvocation: (...args: unknown[]) => authorizeMock(...args),
  getMagicPotMcpRouteForSession: (...args: unknown[]) => getRouteMock(...args)
}))

describe('invokeMagicPotMcpToolForSession', () => {
  beforeEach(() => {
    vi.resetModules()
    callToolMock.mockReset()
    appendAuditMock.mockReset()
    authorizeMock.mockReset()
    getRouteMock.mockReset()

    authorizeMock.mockReturnValue({
      allowed: true,
      policyId: 'bot-runtime'
    })
    getRouteMock.mockReturnValue({
      channel: 'telegram',
      scopeType: 'group',
      scopeId: 'group-1'
    })
  })

  it('forwards tool execution through the chat runtime tool path', async () => {
    callToolMock.mockResolvedValue({
      content: 'ok'
    })

    const { invokeMagicPotMcpToolForSession } = await import('./toolExecutor')
    const result = await invokeMagicPotMcpToolForSession({
      sessionId: 'mcp-session-1',
      toolName: 'workspace.context',
      input: {}
    })

    expect(callToolMock).toHaveBeenCalledTimes(1)
    expect(callToolMock).toHaveBeenCalledWith(
      {
        channel: 'telegram',
        scopeType: 'group',
        scopeId: 'group-1'
      },
      'workspace.context',
      {},
      {
        allowedToolNames: null
      }
    )
    expect(result).toMatchObject({
      toolName: 'workspace.context',
      output: {
        content: 'ok'
      }
    })
  })
})
