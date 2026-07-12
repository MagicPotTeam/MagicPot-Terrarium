import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentKernel, getAgentKernel } from './index'

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
    expect(kernel.getSession(undefined as unknown as string)).toBeUndefined()
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

  it('supports bulk registration and removes tool registrations by capability id or tool name', () => {
    const kernel = getAgentKernel()

    const [first, second] = kernel.registerCapabilities([
      {
        capabilityId: 'cap.first',
        name: 'First',
        kind: 'resource',
        description: 'First resource',
        version: '1.0.0',
        scope: 'global',
        transport: ['internal']
      },
      {
        capabilityId: 'cap.second',
        name: 'Second',
        kind: 'prompt',
        description: 'Second prompt',
        version: '1.0.0',
        scope: 'workspace',
        transport: ['mcp']
      }
    ])

    const [tool] = kernel.registerTools([
      {
        tool: {
          capabilityId: 'cap.tool',
          name: 'tool.name',
          toolName: 'tool.alias',
          kind: 'tool',
          description: 'Tool',
          version: '1.0.0',
          scope: 'session',
          transport: ['internal']
        }
      }
    ])
    const fallbackToolName = kernel.registerTool({
      tool: {
        capabilityId: 'cap.fallback-tool-name',
        name: '',
        kind: 'tool',
        description: 'Tool with capability id fallback',
        version: '1.0.0',
        scope: 'session',
        transport: ['internal']
      }
    })

    expect(kernel.listCapabilities()).toEqual(
      expect.arrayContaining([
        first,
        second,
        expect.objectContaining({ capabilityId: tool.capabilityId }),
        expect.objectContaining({ capabilityId: fallbackToolName.capabilityId })
      ])
    )
    expect(fallbackToolName.toolName).toBe('cap.fallback-tool-name')
    expect(kernel.getTool('tool.alias')?.tool.capabilityId).toBe('cap.tool')
    expect(kernel.getTool(undefined as unknown as string)).toBeUndefined()
    expect(kernel.removeCapability('cap.tool')).toBe(true)
    expect(kernel.getTool('tool.alias')).toBeUndefined()
    expect(kernel.removeCapability('')).toBe(false)
    expect(kernel.removeCapability('missing')).toBe(false)
  })

  it('uses ad hoc invokers and registers missing sessions from invocation requests', async () => {
    const kernel = getAgentKernel()
    const transientSession = {
      sessionKey: 'generic:dm:transient',
      route: {
        channel: 'generic',
        scopeType: 'dm' as const,
        scopeId: 'transient'
      },
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'transient',
      aliases: ['generic:dm:transient'],
      createdAt: 1,
      updatedAt: 1
    }

    const result = await kernel.invokeTool(
      {
        invocationId: 'invoke-1',
        toolName: 'adhoc.tool',
        args: {},
        session: transientSession,
        source: 'bot',
        traceLabel: 'trace-1'
      },
      async (request) => ({
        ok: true,
        content: `${request.source}:${request.session.sessionKey}`
      })
    )

    expect(result).toMatchObject({
      invocationId: 'invoke-1',
      toolName: 'adhoc.tool',
      sessionKey: 'generic:dm:transient',
      content: 'bot:generic:dm:transient'
    })
    expect(kernel.getSession('generic:dm:transient')).toMatchObject({
      sessionKey: 'generic:dm:transient'
    })
    expect(kernel.listEvents('generic:dm:transient').at(-1)).toMatchObject({
      runId: 'trace-1',
      type: 'tool.invoked',
      metadata: {
        source: 'bot'
      }
    })
  })

  it('rejects missing tool invokers and post-invocation aborts', async () => {
    const kernel = getAgentKernel()
    const session = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'missing-tool'
    })

    await expect(
      kernel.invokeTool({
        toolName: 'missing.tool',
        args: {},
        session,
        source: 'mcp'
      })
    ).rejects.toThrow('No tool invoker has been registered')

    const controller = new AbortController()
    await expect(
      kernel.invokeTool(
        {
          toolName: 'adhoc.abort',
          args: {},
          session,
          signal: controller.signal,
          source: 'assistant'
        },
        async () => {
          controller.abort('after invocation')
          return { ok: true }
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
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

  it('updates runs and handles missing run lookups without mutating state', () => {
    const kernel = getAgentKernel()
    const session = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'run-update'
    })
    const run = kernel.createMasterRun({
      session,
      goal: 'Initial goal',
      requestedBy: 'tester',
      modelName: 'model-a',
      metadata: { priority: 'high' },
      parallelism: 0
    })

    const updated = kernel.updateRun(run.runId, {
      status: 'running',
      startedAt: 20,
      steps: [
        {
          stepId: 'step-1',
          label: 'Step 1',
          dependsOn: [],
          status: 'completed',
          attempts: 1,
          maxAttempts: 1,
          createdAt: 1
        }
      ]
    })

    expect(run.parallelism).toBe(1)
    expect(updated).toMatchObject({
      runId: run.runId,
      status: 'running',
      startedAt: 20,
      requestedBy: 'tester',
      modelName: 'model-a',
      metadata: { priority: 'high' }
    })
    expect(kernel.updateRun('missing', { status: 'failed' })).toBeUndefined()
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

    vi.setSystemTime(new Date('2026-04-14T00:10:00.000Z'))

    const third = kernel.registerSession(
      {
        channel: 'telegram',
        scopeType: 'group',
        scopeId: 'group-1'
      },
      {
        aliases: ['minimal-update']
      }
    )

    expect(third.threadId).toBeUndefined()
    expect(third.senderId).toBe('user-1')
    expect(third.senderName).toBe('alice')
    expect(third.workspaceId).toBe('workspace-1')
    expect(third.aliases).toEqual(expect.arrayContaining(['minimal-update']))
  })

  it('merges thread ids from both new and existing session identities', () => {
    const kernel = getAgentKernel()
    const first = kernel.registerSession({
      channel: 'generic',
      scopeType: 'group',
      scopeId: 'merge-thread',
      threadId: 'thread-1'
    })
    const second = kernel.registerSession({
      channel: 'generic',
      scopeType: 'group',
      scopeId: 'merge-thread',
      threadId: 'thread-1'
    })
    const base = kernel.registerSession({
      channel: 'generic',
      scopeType: 'group',
      scopeId: 'merge-thread-current'
    })
    const internals = kernel as unknown as {
      sessions: Map<
        string,
        {
          identity: typeof base
          source: 'assistant'
        }
      >
    }
    internals.sessions.set(base.sessionKey, {
      identity: { ...base, threadId: 'thread-current' },
      source: 'assistant'
    })
    const currentThread = kernel.registerSession({
      channel: 'generic',
      scopeType: 'group',
      scopeId: 'merge-thread-current'
    })

    expect(first.threadId).toBe('thread-1')
    expect(second.threadId).toBe('thread-1')
    expect(currentThread.threadId).toBe('thread-current')
  })

  it('uses assistant and kernel source fallbacks when registering invocation sessions', async () => {
    const kernel = getAgentKernel()
    const assistantSession = {
      sessionKey: 'generic:dm:assistant-source',
      route: {
        channel: 'generic',
        scopeType: 'dm' as const,
        scopeId: 'assistant-source'
      },
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'assistant-source',
      aliases: ['generic:dm:assistant-source'],
      createdAt: 1,
      updatedAt: 1
    }
    const kernelSession = {
      ...assistantSession,
      sessionKey: 'generic:dm:kernel-source',
      route: {
        channel: 'generic',
        scopeType: 'dm' as const,
        scopeId: 'kernel-source'
      },
      scopeId: 'kernel-source',
      aliases: ['generic:dm:kernel-source']
    }
    const mcpSession = {
      ...assistantSession,
      sessionKey: 'generic:dm:mcp-source',
      route: {
        channel: 'generic',
        scopeType: 'dm' as const,
        scopeId: 'mcp-source'
      },
      scopeId: 'mcp-source',
      aliases: ['generic:dm:mcp-source']
    }

    await kernel.invokeTool(
      {
        toolName: 'assistant.source',
        args: {},
        session: assistantSession,
        source: 'assistant'
      },
      async (request) => ({ ok: true, content: request.source })
    )
    await kernel.invokeTool(
      {
        toolName: 'mcp.source',
        args: {},
        session: mcpSession,
        source: 'mcp'
      },
      async (request) => ({ ok: true, content: request.source })
    )
    await kernel.invokeTool(
      {
        toolName: 'kernel.source',
        args: {},
        session: kernelSession
      },
      async (request) => ({ ok: true, content: request.source })
    )

    expect(kernel.getSession('generic:dm:assistant-source')).toBeDefined()
    expect(kernel.getSession('generic:dm:mcp-source')).toBeDefined()
    expect(kernel.getSession('generic:dm:kernel-source')).toBeDefined()
    expect(kernel.listEvents('generic:dm:kernel-source').at(-1)?.metadata).toMatchObject({
      source: 'kernel'
    })
  })

  it('defaults updated runs back to pending when status is cleared', () => {
    const kernel = getAgentKernel()
    const session = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'pending-update'
    })
    const run = kernel.createMasterRun({ session, goal: 'Reset status' })
    ;(kernel.getRun(run.runId) as { status?: unknown }).status = undefined

    expect(kernel.updateRun(run.runId, { status: undefined })).toMatchObject({
      status: 'pending'
    })
    expect(kernel.getRun(undefined as unknown as string)).toBeUndefined()

    const unregistered = {
      ...session,
      sessionKey: 'generic:dm:unregistered-run',
      route: {
        channel: 'generic',
        scopeType: 'dm' as const,
        scopeId: 'unregistered-run'
      },
      scopeId: 'unregistered-run',
      aliases: ['generic:dm:unregistered-run']
    }
    expect(
      kernel.createMasterRun({ session: unregistered, goal: 'Unregistered session' })
    ).toMatchObject({
      session: unregistered
    })
  })

  it('retains only the newest events across all event producers', async () => {
    const kernel = new AgentKernel({ maxEvents: 2 })
    const session = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'bounded-events'
    })

    kernel.registerCapability({
      capabilityId: 'bounded.capability',
      name: 'Bounded capability',
      kind: 'resource',
      description: 'Emits a capability event.',
      version: '1.0.0',
      scope: 'global',
      transport: ['internal']
    })
    kernel.recordEvent({
      runId: 'manual-1',
      sessionKey: session.sessionKey,
      type: 'run.updated',
      message: 'first retained event'
    })
    await kernel.invokeTool(
      {
        toolName: 'bounded.tool',
        args: {},
        session,
        source: 'kernel'
      },
      async () => ({ ok: true })
    )

    expect(kernel.listEvents().map((event) => event.type)).toEqual(['run.updated', 'tool.invoked'])
  })

  it('bounds terminal runs while preserving active runs', () => {
    const kernel = new AgentKernel({ maxTerminalRuns: 1, maxInactiveSessions: 10 })
    const session = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'bounded-runs'
    })
    const oldestTerminal = kernel.createMasterRun({ session, goal: 'old terminal' })
    const active = kernel.createMasterRun({ session, goal: 'active' })
    const newestTerminal = kernel.createMasterRun({ session, goal: 'new terminal' })

    kernel.updateRun(oldestTerminal.runId, { status: 'completed' })
    kernel.updateRun(active.runId, { status: 'running' })
    kernel.updateRun(newestTerminal.runId, { status: 'failed' })

    expect(kernel.getRun(oldestTerminal.runId)).toBeUndefined()
    expect(kernel.getRun(active.runId)?.status).toBe('running')
    expect(kernel.getRun(newestTerminal.runId)?.status).toBe('failed')
    expect(kernel.listRuns()).toHaveLength(2)
  })

  it('preserves zero-retention sessions through run creation and while runs are active', () => {
    const kernel = new AgentKernel({ maxInactiveSessions: 0, maxTerminalRuns: 10 })
    const masterSession = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'zero-retention-master'
    })

    expect(kernel.getSession(masterSession.sessionKey)).toBeDefined()

    const masterRun = kernel.createMasterRun({
      session: masterSession,
      goal: 'stay pending'
    })
    const subagentSession = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'zero-retention-subagent'
    })
    const subagentRun = kernel.createSubagentRun({
      session: subagentSession,
      masterRunId: masterRun.runId,
      goal: 'stay running'
    })
    kernel.updateRun(subagentRun.runId, { status: 'running' })

    const terminalSession = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'zero-retention-terminal'
    })
    const terminalRun = kernel.createMasterRun({
      session: terminalSession,
      goal: 'trigger inactive pruning'
    })
    kernel.updateRun(terminalRun.runId, { status: 'completed' })

    expect(kernel.getSession(masterSession.sessionKey)).toBeDefined()
    expect(kernel.getSession(subagentSession.sessionKey)).toBeDefined()
    expect(kernel.getSession(terminalSession.sessionKey)).toBeUndefined()
  })

  it('bounds inactive sessions without evicting a session with an active run', () => {
    const kernel = new AgentKernel({ maxInactiveSessions: 1, maxTerminalRuns: 10 })
    const activeSession = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'active-session'
    })
    const activeRun = kernel.createMasterRun({ session: activeSession, goal: 'stay active' })
    kernel.updateRun(activeRun.runId, { status: 'running' })

    const oldInactive = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'old-inactive'
    })
    const newestInactive = kernel.registerSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'new-inactive'
    })

    expect(kernel.getSession(activeSession.sessionKey)).toBeDefined()
    expect(kernel.getRun(activeRun.runId)).toBeDefined()
    expect(kernel.getSession(oldInactive.sessionKey)).toBeUndefined()
    expect(kernel.getSession(newestInactive.sessionKey)).toBeDefined()
  })
})
