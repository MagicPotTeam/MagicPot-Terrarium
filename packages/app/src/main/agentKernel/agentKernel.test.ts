import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentKernel } from './index'

describe('agentKernel', () => {
  beforeEach(() => {
    getAgentKernel().clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalizes route identity into a shared session key', () => {
    const kernel = getAgentKernel()
    const session = kernel.registerSession({
      channel: 'telegram',
      scopeType: 'group',
      scopeId: ' group-1 ',
      threadId: ' thread-9 '
    })

    expect(session.sessionKey).toBe('telegram:group:group-1:thread:thread-9')
    expect(kernel.getSession(session.sessionKey)?.scopeType).toBe('group')
  })

  it('registers capabilities and tool contracts without duplicating catalogs', async () => {
    const kernel = getAgentKernel()
    kernel.registerSession({
      channel: 'telegram',
      scopeType: 'group',
      scopeId: 'group-1'
    })

    const tool = kernel.registerTool({
      tool: {
        capabilityId: 'assistant.session.summary',
        name: 'session.summary',
        kind: 'tool',
        description: 'Return a summary of the current session.',
        version: '1.0.0',
        scope: 'session',
        transport: ['internal'],
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      invoker: async (request) => ({
        ok: true,
        content: `invoked:${request.toolName}`,
        metadata: {
          sessionKey: request.session.sessionKey
        }
      })
    })

    const toolName = tool.toolName || tool.name
    const result = await kernel.invokeTool({
      toolName,
      args: {},
      session: kernel.listSessions()[0],
      source: 'kernel'
    })

    expect(result.ok).toBe(true)
    expect(result.content).toBe('invoked:session.summary')
    expect(kernel.listCapabilities()).toHaveLength(1)
  })

  it('tracks master and subagent orchestration records', () => {
    const kernel = getAgentKernel()
    const session = kernel.registerSession({
      channel: 'telegram',
      scopeType: 'group',
      scopeId: 'group-1'
    })

    const master = kernel.createMasterRun({
      session,
      goal: 'Coordinate a release',
      label: 'release-master',
      parallelism: 2
    })
    const subagent = kernel.createSubagentRun({
      session,
      masterRunId: master.runId,
      parentRunId: master.runId,
      goal: 'Draft release notes',
      label: 'release-notes'
    })

    expect(kernel.getRun(master.runId)?.kind).toBe('master')
    expect(kernel.getRun(subagent.runId)?.masterRunId).toBe(master.runId)
    expect(kernel.listRuns(session.sessionKey)).toHaveLength(2)
    expect(
      kernel.listEvents(session.sessionKey).some((event) => event.type === 'run.created')
    ).toBe(true)
  })

  it('passes AbortSignal through tool invocation and rejects pre-aborted requests', async () => {
    const kernel = getAgentKernel()
    const session = kernel.registerSession({
      channel: 'telegram',
      scopeType: 'group',
      scopeId: 'group-1'
    })
    const controller = new AbortController()
    const invoker = vi.fn(async (request) => ({
      ok: true,
      content: String(request.signal === controller.signal)
    }))

    kernel.registerTool({
      tool: {
        capabilityId: 'assistant.signal.check',
        name: 'signal.check',
        kind: 'tool',
        description: 'Verify the request signal is forwarded.',
        version: '1.0.0',
        scope: 'session',
        transport: ['internal'],
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      invoker
    })

    const result = await kernel.invokeTool({
      toolName: 'signal.check',
      args: {},
      session,
      signal: controller.signal,
      source: 'kernel'
    })

    expect(result.ok).toBe(true)
    expect(result.content).toBe('true')
    expect(invoker).toHaveBeenCalledTimes(1)

    controller.abort('stop tool execution')

    await expect(
      kernel.invokeTool({
        toolName: 'signal.check',
        args: {},
        session,
        signal: controller.signal,
        source: 'kernel'
      })
    ).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(invoker).toHaveBeenCalledTimes(1)
  })

  it('preserves session creation metadata while merging aliases and workspace updates', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-14T00:00:00.000Z'))

    const kernel = getAgentKernel()
    const first = kernel.registerSession(
      {
        channel: 'telegram',
        scopeType: 'group',
        scopeId: 'group-1',
        senderId: 'user-1'
      },
      {
        aliases: ['telegram-group-1']
      }
    )

    vi.setSystemTime(new Date('2026-04-14T00:05:00.000Z'))

    const second = kernel.registerSession(
      {
        channel: 'telegram',
        scopeType: 'group',
        scopeId: 'group-1',
        senderId: 'user-1',
        senderName: 'alice'
      },
      {
        workspaceId: 'workspace-1',
        aliases: ['shared-release-room']
      }
    )

    expect(second.sessionKey).toBe(first.sessionKey)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(second.workspaceId).toBe('workspace-1')
    expect(second.senderName).toBe('alice')
    expect(second.aliases).toEqual(
      expect.arrayContaining(['telegram:group:group-1', 'telegram-group-1', 'shared-release-room'])
    )
    expect(kernel.getSession(first.sessionKey)).toMatchObject({
      createdAt: first.createdAt,
      workspaceId: 'workspace-1',
      senderName: 'alice'
    })
  })
})
