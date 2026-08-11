import { describe, expect, it, vi } from 'vitest'
import type { AgentAction, AgentEvent, DriveProgressPayload } from '@shared/agent'
import type { MagicAgentPlatformRunReq } from '@shared/api/svcMagicAgentPlatform'
import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
import type { AssistantInboundMessage, AssistantRuntimeResult } from '../assistantRuntime/types'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/magicpot-test-user-data'),
    getVersion: vi.fn(() => '1.0.0')
  }
}))

import { AgentKernel } from '../agentKernel'
import { MagicAgentPlatformAdapter } from './platformAdapter'
import { attachDriveTrustedDispatchContext } from './driveTrustedDispatchContext'
import { attachRuntimeChannelTrustedDispatchContext } from './runtimeChannelTrustedDispatchContext'
import { attachTriggerTrustedDispatchContext } from './triggerTrustedDispatchContext'
import { MagicAgentToolRegistry } from './toolRegistry'
import { MagicAgentCreativeToolRegistry } from './tools'
import type { MagicAgentCreativeToolAdapter } from './tools'

const createChatService = (reply: LLMChatResp = { content: 'done' }) => ({
  chat: vi.fn(async (_req: LLMChatReq) => reply)
})

const createAssistantRuntime = () => ({
  listTools: vi.fn(() => [
    {
      name: 'assistant.echo',
      description: 'Assistant echo.',
      inputSchema: { type: 'object' }
    },
    {
      name: 'files.write',
      description: 'Write file.',
      inputSchema: { type: 'object' }
    },
    {
      name: 'files.edit',
      description: 'Edit file.',
      inputSchema: { type: 'object' }
    },
    {
      name: 'files.patch',
      description: 'Patch file.',
      inputSchema: { type: 'object' }
    }
  ]),
  callTool: vi.fn(async (_route, name: string, args: Record<string, unknown>) => ({
    content: `assistant:${name}`,
    metadata: { args }
  })),
  handleMessage: vi.fn(async (req: AssistantInboundMessage): Promise<AssistantRuntimeResult> => ({
    runId: 'assistant-run-1',
    sessionKey: `${req.route.channel}:${req.route.scopeType}:${req.route.scopeId}`,
    historySize: 1,
    status: 'completed',
    reply: { content: `assistant-run:${req.text || ''}` },
    events: [
      {
        eventId: 'assistant-event-1',
        runId: 'assistant-run-1',
        sessionKey: `${req.route.channel}:${req.route.scopeType}:${req.route.scopeId}`,
        route: req.route,
        type: 'completed',
        level: 'info',
        message: 'AssistantRuntime completed.',
        createdAt: 1234
      }
    ]
  }))
})

const creativeAdapter: MagicAgentCreativeToolAdapter = {
  definitions: () => [
    {
      name: 'creative.echo',
      category: 'image',
      description: 'Creative echo.',
      inputSchema: { type: 'object' },
      status: 'available',
      permissionLevel: 'read',
      requiresConfirmation: false,
      disabledByDefault: false
    }
  ],
  callTool: async (name, args) =>
    name === 'creative.echo'
      ? {
          ok: true,
          toolName: name,
          category: 'image',
          status: 'available',
          data: { args }
        }
      : null
}

class ScriptedDispatchKernel extends AgentKernel {
  lastEvent?: AgentEvent

  constructor(private readonly actions: AgentAction[]) {
    super()
  }

  override dispatch(event: AgentEvent): AsyncIterable<AgentAction> {
    this.lastEvent = event
    const actions = this.actions
    return {
      async *[Symbol.asyncIterator]() {
        yield* actions
      }
    }
  }
}

const trustedTriggerRequest = (
  overrides: Partial<MagicAgentPlatformRunReq> = {},
  contextOverrides: Partial<Parameters<typeof attachTriggerTrustedDispatchContext>[1]> = {}
): MagicAgentPlatformRunReq => {
  const agentId = String(overrides.agentId ?? contextOverrides.targetAgentId ?? 'agent-1')
  const sessionId = String(overrides.sessionId ?? contextOverrides.targetSessionId ?? 'session-1')
  return attachTriggerTrustedDispatchContext(
    {
      agentId,
      text: 'trigger prompt',
      sessionId,
      route: {
        channel: 'magic-agent-trigger',
        scopeType: 'agent',
        scopeId: agentId,
        threadId: 'trigger-runtime'
      },
      ...overrides
    },
    {
      triggerId: 'trigger-1',
      occurrenceId: 'occurrence-1',
      requestId: 'request-1',
      occurrenceAt: 1234,
      triggerType: 'schedule',
      triggerTitle: 'Nightly',
      targetAgentId: agentId,
      targetSessionId: sessionId,
      source: 'cron',
      attempt: 2,
      ...contextOverrides
    }
  )
}

describe('MagicAgentPlatformAdapter', () => {
  it('dispatches trusted Trigger requests with deterministic identity and provenance', async () => {
    const dispatchKernel = new AgentKernel()
    const dispatchSpy = vi.spyOn(dispatchKernel, 'dispatch')
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel
    })

    await adapter.runAgent(trustedTriggerRequest())
    const event = dispatchSpy.mock.calls[0][0]
    expect(event).toMatchObject({
      type: 'trigger.fired',
      createdAt: 1234,
      correlationId: event.eventId,
      sessionId: 'session-1',
      agentId: 'agent-1',
      payload: {
        request: expect.objectContaining({
          agentId: 'agent-1',
          text: 'trigger prompt',
          sessionId: 'session-1'
        }),
        triggerId: 'trigger-1',
        occurrenceId: 'occurrence-1',
        requestId: 'request-1',
        occurrenceAt: 1234,
        triggerType: 'schedule',
        triggerTitle: 'Nightly',
        source: 'cron',
        attempt: 2,
        targetAgentId: 'agent-1',
        targetSessionId: 'session-1'
      },
      provenance: {
        source: 'trigger',
        requestedBy: 'trigger:trigger-1',
        channel: 'magic-agent-trigger',
        traceId: event.eventId
      }
    })

    await adapter.runAgent(trustedTriggerRequest())
    expect(dispatchSpy.mock.calls[1][0].eventId).toBe(event.eventId)
    for (const request of [
      trustedTriggerRequest({}, { occurrenceId: 'occurrence-2' }),
      trustedTriggerRequest({}, { attempt: 3 }),
      trustedTriggerRequest(
        {
          agentId: 'agent-2',
          sessionId: 'session-2',
          route: {
            channel: 'magic-agent-trigger',
            scopeType: 'agent',
            scopeId: 'agent-2',
            threadId: 'trigger-runtime'
          }
        },
        { targetAgentId: 'agent-2', targetSessionId: 'session-2' }
      ),
      trustedTriggerRequest({ text: 'different prompt' })
    ]) {
      await adapter.runAgent(request)
      expect(dispatchSpy.mock.calls.at(-1)?.[0].eventId).not.toBe(event.eventId)
    }
    adapter.dispose()
  })

  it('strictly rejects Trigger context binding mismatches and context conflicts', async () => {
    const dispatchKernel = new AgentKernel()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel
    })
    const mismatches = [
      trustedTriggerRequest({
        route: {
          channel: 'generic',
          scopeType: 'agent',
          scopeId: 'agent-1',
          threadId: 'trigger-runtime'
        }
      }),
      trustedTriggerRequest({
        route: {
          channel: 'magic-agent-trigger',
          scopeType: 'dm',
          scopeId: 'agent-1',
          threadId: 'trigger-runtime'
        }
      }),
      trustedTriggerRequest({
        route: {
          channel: 'magic-agent-trigger',
          scopeType: 'agent',
          scopeId: 'agent-2',
          threadId: 'trigger-runtime'
        }
      }),
      trustedTriggerRequest({
        route: {
          channel: 'magic-agent-trigger',
          scopeType: 'agent',
          scopeId: 'agent-1',
          threadId: 'other-thread'
        }
      })
    ]
    for (const request of mismatches)
      await expect(adapter.runAgent(request)).rejects.toThrow('must match')
    await expect(
      adapter.runAgent(
        trustedTriggerRequest(
          {
            agentId: 'agent-2',
            route: {
              channel: 'magic-agent-trigger',
              scopeType: 'agent',
              scopeId: 'agent-1',
              threadId: 'trigger-runtime'
            }
          },
          { targetAgentId: 'agent-1' }
        )
      )
    ).rejects.toThrow('targetAgentId must match')
    await expect(
      adapter.runAgent(
        trustedTriggerRequest({ sessionId: 'session-2' }, { targetSessionId: 'session-1' })
      )
    ).rejects.toThrow('targetSessionId must match')

    const conflicting = attachDriveTrustedDispatchContext(trustedTriggerRequest(), {
      driveId: 'drive-1',
      driveRevision: 1,
      status: 'active',
      targetAgentId: 'agent-1'
    })
    await expect(adapter.runAgent(conflicting)).rejects.toThrow('conflicting')
    adapter.dispose()
  })

  it('rejects trusted Runtime Channel context that is not strictly bound to its request route', async () => {
    const assistantRuntime = createAssistantRuntime()
    const dispatchKernel = new AgentKernel()
    const dispatchSpy = vi.spyOn(dispatchKernel, 'dispatch')
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel
    })
    const context = {
      channelId: 'channel-1',
      memberId: 'member-1',
      pendingMessageIds: ['message-1'],
      agentInstanceId: 'instance-1'
    }

    for (const route of [
      { channel: 'generic', scopeType: 'dm', scopeId: 'channel-1' },
      { channel: 'runtime-channel', scopeType: 'group', scopeId: 'channel-1' },
      { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel-2' }
    ] as const) {
      const request = attachRuntimeChannelTrustedDispatchContext(
        { text: 'mismatched trusted route', route },
        context
      )
      await expect(adapter.runAgent(request)).rejects.toThrow('must match')
    }

    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(assistantRuntime.handleMessage).not.toHaveBeenCalled()
    adapter.dispose()
  })

  it('rolls back user.message registration when channel.message registration fails', () => {
    const dispatchKernel = new AgentKernel()
    const unregisterOccupied = dispatchKernel.registerActionHandler(
      'channel.message',
      async function* () {
        yield* []
      }
    )

    expect(
      () =>
        new MagicAgentPlatformAdapter({
          chatService: createChatService(),
          assistantRuntime: createAssistantRuntime(),
          creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
          dispatchKernel
        })
    ).toThrow('already registered')

    const unregisterUser = dispatchKernel.registerActionHandler('user.message', async function* () {
      yield* []
    })
    unregisterUser()
    unregisterOccupied()
  })

  it('rolls back prior registrations when drive.assigned registration fails', () => {
    const dispatchKernel = new AgentKernel()
    const unregisterOccupied = dispatchKernel.registerActionHandler(
      'drive.assigned',
      async function* () {
        yield* []
      }
    )
    expect(
      () =>
        new MagicAgentPlatformAdapter({
          chatService: createChatService(),
          assistantRuntime: createAssistantRuntime(),
          creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
          dispatchKernel
        })
    ).toThrow('already registered')
    const unregisterUser = dispatchKernel.registerActionHandler('user.message', async function* () {
      yield* []
    })
    const unregisterChannel = dispatchKernel.registerActionHandler(
      'channel.message',
      async function* () {
        yield* []
      }
    )
    unregisterUser()
    unregisterChannel()
    unregisterOccupied()
  })

  it('rolls back all prior registrations when trigger.fired registration fails', () => {
    const dispatchKernel = new AgentKernel()
    const unregisterOccupied = dispatchKernel.registerActionHandler(
      'trigger.fired',
      async function* () {
        yield* []
      }
    )
    expect(
      () =>
        new MagicAgentPlatformAdapter({
          chatService: createChatService(),
          assistantRuntime: createAssistantRuntime(),
          creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
          dispatchKernel
        })
    ).toThrow('already registered')
    const unregisterUser = dispatchKernel.registerActionHandler('user.message', async function* () {
      yield* []
    })
    const unregisterChannel = dispatchKernel.registerActionHandler(
      'channel.message',
      async function* () {
        yield* []
      }
    )
    const unregisterDrive = dispatchKernel.registerActionHandler(
      'drive.assigned',
      async function* () {
        yield* []
      }
    )
    unregisterUser()
    unregisterChannel()
    unregisterDrive()
    unregisterOccupied()
  })

  it('cleans invocation signal ownership when route validation throws', async () => {
    const signal = new AbortController().signal
    const addSpy = vi.spyOn(signal, 'addEventListener')
    const removeSpy = vi.spyOn(signal, 'removeEventListener')
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })

    await expect(
      adapter.runAgent({ text: 'missing route' } as MagicAgentPlatformRunReq, { signal })
    ).rejects.toThrow('explicit trusted route')
    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    adapter.dispose()
  })

  it('dispatches trusted Drive assignments with deterministic identity and provenance', async () => {
    const dispatchKernel = new AgentKernel()
    const dispatchSpy = vi.spyOn(dispatchKernel, 'dispatch')
    const reportOrder: string[] = []
    const reportDriveProgress = vi.fn(async (_payload: DriveProgressPayload) => {
      reportOrder.push('progress')
    })
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel,
      reportDriveProgress
    })
    const request = (revision = 2, text = 'Continue goal', targetAgentId = 'agent-1') =>
      attachDriveTrustedDispatchContext(
        {
          agentId: targetAgentId,
          sessionId: 'drive-session',
          text,
          route: { channel: 'magicpot-drive://runtime', scopeType: 'channel', scopeId: 'drive-1' },
          metadata: { driveId: 'drive-1', driveRevision: revision }
        },
        {
          driveId: 'drive-1',
          driveRevision: revision,
          status: 'active',
          ownerId: 'owner-1',
          assigneeId: 'assignee-1',
          targetAgentId,
          targetSessionId: 'drive-session'
        }
      )

    const firstResponse = await adapter.runAgent(request()).then((response) => {
      reportOrder.push('returned')
      return response
    })
    expect(firstResponse.content).toBe('assistant-run:Continue goal')
    expect(reportOrder).toEqual(['progress', 'returned'])
    const first = dispatchSpy.mock.calls[0][0]
    expect(first).toMatchObject({
      type: 'drive.assigned',
      createdAt: 0,
      correlationId: first.eventId,
      sessionId: 'drive-session',
      agentId: 'agent-1',
      provenance: {
        source: 'drive',
        requestedBy: 'drive-owner:owner-1',
        channel: 'drive-1',
        traceId: first.eventId
      },
      payload: {
        request: {
          agentId: 'agent-1',
          sessionId: 'drive-session',
          text: 'Continue goal',
          route: { channel: 'magicpot-drive://runtime', scopeType: 'channel', scopeId: 'drive-1' },
          metadata: { driveId: 'drive-1', driveRevision: 2 }
        },
        driveId: 'drive-1',
        driveRevision: 2,
        status: 'active',
        ownerId: 'owner-1',
        assigneeId: 'assignee-1',
        targetAgentId: 'agent-1',
        targetSessionId: 'drive-session'
      }
    })
    await adapter.runAgent(request())
    await adapter.runAgent(request(3))
    await adapter.runAgent(request(2, 'Different text'))
    await adapter.runAgent(request(2, 'Continue goal', 'agent-2'))
    expect(dispatchSpy.mock.calls[1][0].eventId).toBe(first.eventId)
    expect(dispatchSpy.mock.calls[2][0].eventId).not.toBe(first.eventId)
    expect(dispatchSpy.mock.calls[3][0].eventId).not.toBe(first.eventId)
    expect(dispatchSpy.mock.calls[4][0].eventId).not.toBe(first.eventId)
    expect(reportDriveProgress).toHaveBeenCalledTimes(4)
    expect(reportDriveProgress.mock.calls[0][0]).toEqual({
      driveId: 'drive-1',
      expectedRevision: 2,
      summary: 'assistant-run:Continue goal',
      evidence: [
        { kind: 'run', ref: 'assistant-run-1' },
        { kind: 'session', ref: 'drive-session' }
      ],
      reportedAt: 0,
      idempotencyKey: `${first.eventId}:drive-progress`
    })
    expect(reportDriveProgress.mock.calls[1][0].idempotencyKey).not.toBe(
      reportDriveProgress.mock.calls[0][0].idempotencyKey
    )
    adapter.dispose()
  })

  it('joins concurrent duplicate Drive progress and retries after reporter failure', async () => {
    let releaseReport!: () => void
    const reportGate = new Promise<void>((resolve) => {
      releaseReport = resolve
    })
    let fail = false
    const reportDriveProgress = vi.fn(async () => {
      if (fail) throw new Error('temporary progress failure')
      await reportGate
    })
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      reportDriveProgress
    })
    const request = attachDriveTrustedDispatchContext(
      {
        agentId: 'agent-1',
        sessionId: 'drive-session',
        text: 'Concurrent goal',
        route: { channel: 'magicpot-drive://runtime', scopeType: 'channel', scopeId: 'drive-1' },
        metadata: { driveId: 'drive-1', driveRevision: 2 }
      },
      {
        driveId: 'drive-1',
        driveRevision: 2,
        status: 'active',
        targetAgentId: 'agent-1',
        targetSessionId: 'drive-session'
      }
    )

    const first = adapter.runAgent(request)
    const second = adapter.runAgent(request)
    await vi.waitFor(() => expect(reportDriveProgress).toHaveBeenCalledOnce())
    releaseReport()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(reportDriveProgress).toHaveBeenCalledOnce()

    fail = true
    const retryRequest = attachDriveTrustedDispatchContext(
      { ...request, text: 'Retry goal' },
      {
        driveId: 'drive-1',
        driveRevision: 2,
        status: 'active',
        targetAgentId: 'agent-1',
        targetSessionId: 'drive-session'
      }
    )
    await expect(adapter.runAgent(retryRequest)).rejects.toThrow('temporary progress failure')
    fail = false
    await expect(adapter.runAgent(retryRequest)).resolves.toMatchObject({ status: 'completed' })
    expect(reportDriveProgress).toHaveBeenCalledTimes(3)
    adapter.dispose()
  })

  it('rejects a trusted Drive run when progress reporting fails', async () => {
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      reportDriveProgress: async () => {
        throw new Error('progress reporter unavailable')
      }
    })
    const request = attachDriveTrustedDispatchContext(
      {
        agentId: 'agent-1',
        sessionId: 'drive-session',
        text: 'Continue goal',
        route: { channel: 'magicpot-drive://runtime', scopeType: 'channel', scopeId: 'drive-1' },
        metadata: { driveId: 'drive-1', driveRevision: 2 }
      },
      {
        driveId: 'drive-1',
        driveRevision: 2,
        status: 'active',
        targetAgentId: 'agent-1',
        targetSessionId: 'drive-session'
      }
    )

    await expect(adapter.runAgent(request)).rejects.toThrow('progress reporter unavailable')
    adapter.dispose()
  })

  it('rejects Drive route, metadata, agent, and session mismatches before dispatch', async () => {
    const dispatchKernel = new AgentKernel()
    const dispatchSpy = vi.spyOn(dispatchKernel, 'dispatch')
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel
    })
    const context = {
      driveId: 'drive-1',
      driveRevision: 2,
      status: 'active' as const,
      targetAgentId: 'agent-1',
      targetSessionId: 'session-1'
    }
    const valid = {
      agentId: 'agent-1',
      sessionId: 'session-1',
      text: 'work',
      route: { channel: 'magicpot-drive://runtime', scopeType: 'channel', scopeId: 'drive-1' },
      metadata: { driveId: 'drive-1', driveRevision: 2 }
    } as const
    const mismatches: MagicAgentPlatformRunReq[] = [
      { ...valid, route: { ...valid.route, scopeId: 'drive-2' } },
      { ...valid, metadata: { ...valid.metadata, driveId: 'drive-2' } },
      { ...valid, metadata: { ...valid.metadata, driveRevision: 3 } },
      { ...valid, agentId: 'agent-2' },
      { ...valid, sessionId: 'session-2' }
    ]
    for (const mismatch of mismatches) {
      await expect(
        adapter.runAgent(attachDriveTrustedDispatchContext(mismatch, context))
      ).rejects.toThrow()
    }
    expect(dispatchSpy).not.toHaveBeenCalled()
    adapter.dispose()
  })

  it('dispatches one structured user.message without recursively invoking AssistantRuntime', async () => {
    const assistantRuntime = createAssistantRuntime()
    const dispatchKernel = new AgentKernel()
    const dispatchSpy = vi.spyOn(dispatchKernel, 'dispatch')
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel
    })

    const response = await adapter.runAgent({
      agentId: 'magicpot.default.chat',
      text: 'dispatch once',
      sessionId: 'stable-session',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
      metadata: { correlationId: 'stable-correlation', requestedBy: 'authorized-service' }
    })

    expect(response.content).toBe('assistant-run:dispatch once')
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(assistantRuntime.handleMessage).toHaveBeenCalledTimes(1)
    expect(dispatchSpy.mock.calls[0][0]).toMatchObject({
      type: 'user.message',
      correlationId: 'stable-correlation',
      sessionId: 'stable-session',
      agentId: 'magicpot.default.chat',
      provenance: { source: 'magicAgentPlatform', requestedBy: 'authorized-service' }
    })
  })

  it('dispatches trusted Runtime Channel wakes with deterministic structured identity', async () => {
    const assistantRuntime = createAssistantRuntime()
    const dispatchKernel = new AgentKernel()
    const dispatchSpy = vi.spyOn(dispatchKernel, 'dispatch')
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel
    })
    const request = () =>
      attachRuntimeChannelTrustedDispatchContext(
        {
          agentId: 'magicpot.default.chat',
          text: 'exact channel wake text',
          route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel-1' }
        },
        {
          channelId: 'channel-1',
          memberId: 'member-1',
          pendingMessageIds: ['message-1', 'message-2'],
          agentInstanceId: 'instance-1'
        }
      )

    await adapter.runAgent(request())
    const first = dispatchSpy.mock.calls[0][0]
    expect(first).toMatchObject({
      type: 'channel.message',
      correlationId: first.eventId,
      provenance: {
        source: 'runtimeChannel',
        requestedBy: 'runtime-channel-member:member-1',
        channel: 'channel-1',
        traceId: first.eventId
      },
      payload: {
        request: {
          agentId: 'magicpot.default.chat',
          text: 'exact channel wake text',
          route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel-1' }
        },
        channelId: 'channel-1',
        memberId: 'member-1',
        pendingMessageIds: ['message-1', 'message-2'],
        agentInstanceId: 'instance-1'
      }
    })

    await adapter.runAgent(request())
    expect(dispatchSpy.mock.calls[1][0].eventId).toBe(first.eventId)

    const changedInstance = attachRuntimeChannelTrustedDispatchContext(
      { ...request() },
      {
        channelId: 'channel-1',
        memberId: 'member-1',
        pendingMessageIds: ['message-1', 'message-2'],
        agentInstanceId: 'instance-2'
      }
    )
    await adapter.runAgent(changedInstance)
    const changedBatch = attachRuntimeChannelTrustedDispatchContext(
      { ...request() },
      {
        channelId: 'channel-1',
        memberId: 'member-1',
        pendingMessageIds: ['message-2', 'message-1'],
        agentInstanceId: 'instance-1'
      }
    )
    await adapter.runAgent(changedBatch)
    expect(dispatchSpy.mock.calls[2][0].eventId).not.toBe(first.eventId)
    expect(dispatchSpy.mock.calls[3][0].eventId).not.toBe(first.eventId)
    expect(assistantRuntime.handleMessage).toHaveBeenCalledTimes(3)
  })

  it('joins concurrent duplicate trusted wakes without corrupting invocation options', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const assistantRuntime = createAssistantRuntime()
    assistantRuntime.handleMessage.mockImplementation(async (req: AssistantInboundMessage) => {
      await gate
      return {
        runId: 'run',
        sessionKey: 'session',
        historySize: 1,
        status: 'completed',
        reply: { content: req.text ?? '' },
        events: []
      }
    })
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })
    const makeRequest = () =>
      attachRuntimeChannelTrustedDispatchContext(
        {
          text: 'duplicate',
          route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel' }
        },
        {
          channelId: 'channel',
          memberId: 'member',
          pendingMessageIds: ['message'],
          agentInstanceId: 'instance'
        }
      )
    const first = adapter.runAgent(makeRequest())
    await vi.waitFor(() => expect(assistantRuntime.handleMessage).toHaveBeenCalledTimes(1))
    const second = adapter.runAgent(makeRequest())
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ content: 'duplicate' }),
      expect.objectContaining({ content: 'duplicate' })
    ])
    expect(assistantRuntime.handleMessage).toHaveBeenCalledTimes(1)
  })

  it('executes child.start as a managed child reservation before reply', async () => {
    const response = {
      runId: 'child-run',
      agentId: 'agent-1',
      status: 'completed',
      content: 'reserved'
    }
    const payload = {
      parentInstanceId: 'instance-1',
      parentExpectedRevision: 2,
      child: {
        id: 'child-1',
        name: 'Child',
        definitionId: 'definition-1',
        configVersion: 'config-1',
        limits: {
          maxChildren: 0,
          maxDepth: 1,
          maxConcurrency: 1,
          maxRuntimeMs: 1000,
          allowedToolNames: ['read'],
          workspaceRoots: ['C:/workspace']
        }
      },
      createdAt: 10,
      idempotencyKey: 'child-1'
    }
    const startChild = vi.fn()
    const kernel = new ScriptedDispatchKernel([
      { actionId: 'child', type: 'child.start', payload },
      { actionId: 'reply', type: 'reply.emit', payload: { response } }
    ])
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: kernel,
      startChild
    })
    const request = attachRuntimeChannelTrustedDispatchContext(
      {
        text: 'channel',
        route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel-1' }
      },
      {
        channelId: 'channel-1',
        memberId: 'member-1',
        pendingMessageIds: ['incoming-1'],
        agentInstanceId: 'instance-1'
      }
    )

    await expect(adapter.runAgent(request)).resolves.toEqual(response)
    expect(startChild).toHaveBeenCalledWith(payload, {
      actor: { kind: 'agent', id: 'instance-1' },
      agentInstanceId: 'instance-1',
      sourceEvent: kernel.lastEvent
    })
  })

  it('rejects child.start outside or mismatching trusted channel context', async () => {
    const childAction: AgentAction = {
      actionId: 'child',
      type: 'child.start',
      payload: {
        parentInstanceId: 'other',
        parentExpectedRevision: 0,
        child: {
          id: 'child',
          name: 'Child',
          definitionId: 'definition',
          configVersion: 'config',
          limits: {
            maxChildren: 0,
            maxDepth: 0,
            maxConcurrency: 1,
            maxRuntimeMs: 1,
            allowedToolNames: [],
            workspaceRoots: []
          }
        },
        createdAt: 0,
        idempotencyKey: 'key'
      }
    }
    const reply: AgentAction = {
      actionId: 'reply',
      type: 'reply.emit',
      payload: {
        response: { runId: 'run', agentId: 'agent', status: 'completed', content: 'done' }
      }
    }
    const userAdapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: new ScriptedDispatchKernel([childAction, reply]),
      startChild: vi.fn()
    })
    await expect(
      userAdapter.runAgent({
        text: 'user',
        route: { channel: 'chat', scopeType: 'dm', scopeId: 'user' }
      })
    ).rejects.toThrow('only valid for a trusted channel.message event')

    const channelAdapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: new ScriptedDispatchKernel([childAction, reply]),
      startChild: vi.fn()
    })
    await expect(
      channelAdapter.runAgent(
        attachRuntimeChannelTrustedDispatchContext(
          {
            text: 'channel',
            route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel' }
          },
          {
            channelId: 'channel',
            memberId: 'member',
            pendingMessageIds: ['message'],
            agentInstanceId: 'instance'
          }
        )
      )
    ).rejects.toThrow('does not match trusted Channel context')
  })

  it('executes message.publish only for matching trusted channel context before reply', async () => {
    const response = {
      runId: 'scripted-run',
      agentId: 'agent-1',
      status: 'completed',
      content: 'published'
    }
    const payload = {
      channelId: 'channel-1',
      publisherMemberId: 'member-1',
      messageId: 'out-1',
      payload: { text: 'hello' },
      priority: 2,
      publishedAt: 10,
      expiresAt: 20,
      expectedChannelRevision: 3,
      idempotencyKey: 'publish-1'
    }
    const publishMessage = vi.fn()
    const kernel = new ScriptedDispatchKernel([
      { actionId: 'publish', type: 'message.publish', payload },
      { actionId: 'reply', type: 'reply.emit', payload: { response } }
    ])
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: kernel,
      publishMessage
    })
    const request = attachRuntimeChannelTrustedDispatchContext(
      {
        text: 'channel',
        route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel-1' }
      },
      {
        channelId: 'channel-1',
        memberId: 'member-1',
        pendingMessageIds: ['incoming-1'],
        agentInstanceId: 'instance-1'
      }
    )

    await expect(adapter.runAgent(request)).resolves.toEqual(response)
    expect(publishMessage).toHaveBeenCalledWith(payload, {
      agentInstanceId: 'instance-1',
      sourceEvent: kernel.lastEvent
    })
  })

  it('settles identical message.publish actions once and retries failures', async () => {
    const response = {
      runId: 'scripted-run',
      agentId: 'agent-1',
      status: 'completed',
      content: 'published'
    }
    const publish = {
      actionId: 'publish-once',
      type: 'message.publish',
      payload: {
        channelId: 'channel-1',
        publisherMemberId: 'member-1',
        messageId: 'out-1',
        payload: null,
        priority: 0,
        publishedAt: 10,
        expectedChannelRevision: 3,
        idempotencyKey: 'publish-once'
      }
    } satisfies AgentAction
    const request = () =>
      attachRuntimeChannelTrustedDispatchContext(
        {
          text: 'channel',
          route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel-1' }
        },
        {
          channelId: 'channel-1',
          memberId: 'member-1',
          pendingMessageIds: ['incoming-1'],
          agentInstanceId: 'instance-1'
        }
      )
    let rejectFirst = true
    const publishMessage = vi.fn(async () => {
      if (rejectFirst) {
        rejectFirst = false
        throw new Error('publisher failed')
      }
    })
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: new ScriptedDispatchKernel([
        publish,
        { actionId: 'reply', type: 'reply.emit', payload: { response } }
      ]),
      publishMessage
    })
    await expect(adapter.runAgent(request())).rejects.toThrow('publisher failed')
    await expect(adapter.runAgent(request())).resolves.toEqual(response)
    await expect(
      Promise.all([adapter.runAgent(request()), adapter.runAgent(request())])
    ).resolves.toEqual([response, response])
    expect(publishMessage).toHaveBeenCalledTimes(2)
  })

  it('rejects message.publish outside matching trusted channel context and after reply', async () => {
    const response = {
      runId: 'scripted-run',
      agentId: 'agent-1',
      status: 'completed',
      content: 'done'
    }
    const publish: AgentAction = {
      actionId: 'publish',
      type: 'message.publish',
      payload: {
        channelId: 'wrong-channel',
        publisherMemberId: 'member-1',
        messageId: 'out-1',
        payload: {},
        priority: 0,
        publishedAt: 10,
        expectedChannelRevision: 3,
        idempotencyKey: 'publish-1'
      }
    }
    const userAdapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: new ScriptedDispatchKernel([publish])
    })
    await expect(
      userAdapter.runAgent({
        text: 'user',
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      })
    ).rejects.toThrow('only valid for a trusted channel.message event')

    const request = attachRuntimeChannelTrustedDispatchContext(
      {
        text: 'channel',
        route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel-1' }
      },
      {
        channelId: 'channel-1',
        memberId: 'member-1',
        pendingMessageIds: ['incoming-1'],
        agentInstanceId: 'instance-1'
      }
    )
    const mismatchAdapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: new ScriptedDispatchKernel([publish])
    })
    await expect(mismatchAdapter.runAgent(request)).rejects.toThrow(
      'does not match trusted Channel'
    )
    const terminalAdapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: new ScriptedDispatchKernel([
        { actionId: 'reply', type: 'reply.emit', payload: { response } },
        {
          actionId: publish.actionId,
          type: publish.type,
          payload: {
            channelId: 'channel-1',
            publisherMemberId: 'member-1',
            messageId: 'out-1',
            payload: {},
            priority: 0,
            publishedAt: 10,
            expectedChannelRevision: 3,
            idempotencyKey: 'publish-1'
          }
        }
      ])
    })
    await expect(terminalAdapter.runAgent(request)).rejects.toThrow('action after terminal')
  })

  it('accepts reply-only trusted Channel dispatch behavior without publishing', async () => {
    const response = {
      runId: 'scripted-run',
      agentId: 'agent-1',
      status: 'completed',
      content: 'scripted reply'
    }
    const publishMessage = vi.fn()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: new ScriptedDispatchKernel([
        { actionId: 'reply', type: 'reply.emit', payload: { response } }
      ]),
      publishMessage
    })

    await expect(
      adapter.runAgent(
        attachRuntimeChannelTrustedDispatchContext(
          {
            text: 'reply only',
            route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel-1' }
          },
          {
            channelId: 'channel-1',
            memberId: 'member-1',
            pendingMessageIds: ['incoming-1'],
            agentInstanceId: 'instance-1'
          }
        )
      )
    ).resolves.toEqual(response)
    expect(publishMessage).not.toHaveBeenCalled()
  })

  it('rejects drive.progress for user, channel, and trigger dispatches', async () => {
    const progress: AgentAction = {
      actionId: 'progress',
      type: 'drive.progress',
      payload: {
        driveId: 'drive-1',
        expectedRevision: 2,
        summary: 'progress',
        evidence: [{ kind: 'text', ref: 'checkpoint' }],
        reportedAt: 10,
        idempotencyKey: 'progress-1'
      }
    }
    const requests: MagicAgentPlatformRunReq[] = [
      {
        text: 'user',
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      },
      attachRuntimeChannelTrustedDispatchContext(
        {
          text: 'channel',
          route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel-1' }
        },
        {
          channelId: 'channel-1',
          memberId: 'member-1',
          pendingMessageIds: ['message-1'],
          agentInstanceId: 'instance-1'
        }
      ),
      trustedTriggerRequest()
    ]
    for (const request of requests) {
      const adapter = new MagicAgentPlatformAdapter({
        chatService: createChatService(),
        assistantRuntime: createAssistantRuntime(),
        creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
        dispatchKernel: new ScriptedDispatchKernel([progress])
      })
      await expect(adapter.runAgent(request)).rejects.toThrow(
        'drive.progress is only valid for a trusted drive.assigned event'
      )
    }
  })

  it('rejects drive.progress mismatches and actions after reply', async () => {
    const driveRequest = attachDriveTrustedDispatchContext(
      {
        agentId: 'agent-1',
        sessionId: 'drive-session',
        text: 'drive',
        route: { channel: 'magicpot-drive://runtime', scopeType: 'channel', scopeId: 'drive-1' },
        metadata: { driveId: 'drive-1', driveRevision: 2 }
      },
      {
        driveId: 'drive-1',
        driveRevision: 2,
        status: 'active',
        targetAgentId: 'agent-1',
        targetSessionId: 'drive-session'
      }
    )
    for (const progressPayload of [
      {
        driveId: 'drive-2',
        expectedRevision: 2,
        summary: 'progress',
        evidence: [{ kind: 'text', ref: 'checkpoint' }],
        reportedAt: 10,
        idempotencyKey: 'progress-drive-mismatch'
      },
      {
        driveId: 'drive-1',
        expectedRevision: 3,
        summary: 'progress',
        evidence: [{ kind: 'text', ref: 'checkpoint' }],
        reportedAt: 10,
        idempotencyKey: 'progress-revision-mismatch'
      }
    ]) {
      const mismatchAdapter = new MagicAgentPlatformAdapter({
        chatService: createChatService(),
        assistantRuntime: createAssistantRuntime(),
        creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
        dispatchKernel: new ScriptedDispatchKernel([
          { actionId: 'progress', type: 'drive.progress', payload: progressPayload }
        ])
      })
      await expect(mismatchAdapter.runAgent(driveRequest)).rejects.toThrow(
        'drive.progress does not match trusted Drive context'
      )
    }

    const response = {
      runId: 'scripted-run',
      agentId: 'agent-1',
      status: 'completed',
      content: 'done'
    }
    const afterReplyAdapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: new ScriptedDispatchKernel([
        { actionId: 'reply', type: 'reply.emit', payload: { response } },
        {
          actionId: 'progress',
          type: 'drive.progress',
          payload: {
            driveId: 'drive-1',
            expectedRevision: 2,
            summary: 'progress',
            evidence: [{ kind: 'text', ref: 'checkpoint' }],
            reportedAt: 10,
            idempotencyKey: 'progress-after-reply'
          }
        }
      ])
    })
    await expect(afterReplyAdapter.runAgent(driveRequest)).rejects.toThrow('action after terminal')
  })

  it('rejects unsupported and multiple unary terminal actions', async () => {
    const unsupported = new ScriptedDispatchKernel([
      { actionId: 'a', type: 'tool.call', payload: {} }
    ])
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: unsupported
    })
    const request = {
      text: 'bad terminal',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
    } as const
    await expect(adapter.runAgent(request)).rejects.toThrow('unsupported action')

    const response = {
      runId: 'scripted-run',
      agentId: 'agent-1',
      status: 'completed',
      content: 'done'
    }
    const multiple = new ScriptedDispatchKernel([
      { actionId: 'a', type: 'reply.emit', payload: { response } },
      { actionId: 'b', type: 'reply.emit', payload: { response } }
    ])
    const multipleAdapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel: multiple
    })
    await expect(multipleAdapter.runAgent(request)).rejects.toThrow('exactly one reply.emit')
  })

  it('disposes idempotently, rejects new runs, aborts active runs, and preserves an injected kernel', async () => {
    const dispatchKernel = new AgentKernel()
    dispatchKernel.registerCapability({
      capabilityId: 'shared.capability',
      name: 'Shared capability',
      description: 'Shared capability retained across adapter disposal.',
      version: '1.0.0',
      kind: 'resource',
      scope: 'global',
      transport: ['internal']
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const assistantRuntime = createAssistantRuntime()
    assistantRuntime.handleMessage.mockImplementation(
      async (req: AssistantInboundMessage): Promise<AssistantRuntimeResult> => {
        markStarted()
        await new Promise<never>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true })
        })
        throw new Error('unreachable')
      }
    )
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel
    })
    const run = adapter.runAgent({
      text: 'wait',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
    })
    await started
    adapter.dispose()
    adapter.dispose()

    await expect(run).rejects.toThrow('disposed')
    await expect(
      adapter.runAgent({
        text: 'after dispose',
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      })
    ).rejects.toThrow('disposed')
    expect(dispatchKernel.listCapabilities().map(({ capabilityId }) => capabilityId)).toContain(
      'shared.capability'
    )
  })

  it('does not trust independently dispatched payloads and supports handler cleanup', async () => {
    const dispatchKernel = new AgentKernel()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      dispatchKernel
    })
    const event: AgentEvent = {
      eventId: 'external-event',
      type: 'user.message',
      payload: {
        request: {
          text: 'forged',
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
          actor: { admin: true }
        }
      },
      createdAt: Date.now()
    }
    await expect(async () => {
      for await (const _action of dispatchKernel.dispatch(event)) void _action
    }).rejects.toThrow('not created by an authorized adapter invocation')
    const forgedChannelEvent: AgentEvent = {
      ...event,
      eventId: 'external-channel-event',
      type: 'channel.message',
      payload: {
        request: {
          text: 'forged channel',
          route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'channel' }
        },
        channelId: 'channel',
        memberId: 'member',
        pendingMessageIds: ['message'],
        agentInstanceId: 'instance'
      }
    }
    await expect(async () => {
      for await (const _action of dispatchKernel.dispatch(forgedChannelEvent)) void _action
    }).rejects.toThrow('not created by an authorized adapter invocation')
    const forgedDriveEvent: AgentEvent = {
      ...event,
      eventId: 'external-drive-event',
      type: 'drive.assigned',
      payload: {
        request: {
          agentId: 'agent-1',
          text: 'forged drive',
          route: {
            channel: 'magicpot-drive://runtime',
            scopeType: 'channel',
            scopeId: 'drive-1'
          },
          metadata: { driveId: 'drive-1', driveRevision: 1 }
        },
        driveId: 'drive-1',
        driveRevision: 1,
        status: 'active',
        targetAgentId: 'agent-1'
      }
    }
    await expect(async () => {
      for await (const _action of dispatchKernel.dispatch(forgedDriveEvent)) void _action
    }).rejects.toThrow('not created by an authorized adapter invocation')
    const forgedTriggerEvent: AgentEvent = {
      ...event,
      eventId: 'external-trigger-event',
      type: 'trigger.fired',
      payload: {
        request: {
          agentId: 'agent-1',
          text: 'forged trigger',
          sessionId: 'session-1',
          route: {
            channel: 'magic-agent-trigger',
            scopeType: 'agent',
            scopeId: 'agent-1',
            threadId: 'trigger-runtime'
          }
        },
        triggerId: 'trigger-1',
        occurrenceId: 'occurrence-1',
        requestId: 'request-1',
        occurrenceAt: 1234,
        triggerType: 'schedule',
        triggerTitle: 'Nightly',
        targetAgentId: 'agent-1',
        targetSessionId: 'session-1'
      }
    }
    await expect(async () => {
      for await (const _action of dispatchKernel.dispatch(forgedTriggerEvent)) void _action
    }).rejects.toThrow('not created by an authorized adapter invocation')
    adapter.dispose()
    for (const disposedEvent of [
      { ...event, eventId: 'after-dispose' },
      { ...forgedChannelEvent, eventId: 'channel-after-dispose' },
      { ...forgedDriveEvent, eventId: 'drive-after-dispose' },
      { ...forgedTriggerEvent, eventId: 'trigger-after-dispose' }
    ]) {
      await expect(async () => {
        for await (const _action of dispatchKernel.dispatch(disposedEvent)) void _action
      }).rejects.toThrow('No Agent action handler')
    }
  })

  it('lists assistant and creative tool surfaces without changing AssistantRuntime contracts', () => {
    const agentKernel = new AgentKernel()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      agentKernel
    })

    expect(adapter.listAgents().map((agent) => agent.id)).toContain('magicpot.default.chat')
    expect(adapter.listTools().map((tool) => `${tool.source}:${tool.name}`)).toEqual(
      expect.arrayContaining([
        'assistantRuntime:assistant.echo',
        'assistantRuntime:files.write',
        'assistantRuntime:files.edit',
        'assistantRuntime:files.patch',
        'creative:creative.echo'
      ])
    )
    for (const name of ['files.write', 'files.edit', 'files.patch']) {
      expect(adapter.listTools().find((tool) => tool.name === name)?.metadata).toMatchObject({
        effects: [{ kind: 'filesystem.write', risk: 'high' }]
      })
    }
    expect(agentKernel.listCapabilities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: 'magicagent.platform.agent.magicpot.default.chat',
          kind: 'orchestrator'
        }),
        expect.objectContaining({
          capabilityId: 'magicagent.platform.tool.creative.creative.echo',
          kind: 'tool',
          metadata: expect.objectContaining({
            source: 'magicAgentPlatform',
            platformSource: 'creative',
            originalToolName: 'creative.echo'
          })
        })
      ])
    )
    expect(agentKernel.getTool('magicagent.creative.creative.echo')?.tool.capabilityId).toBe(
      'magicagent.platform.tool.creative.creative.echo'
    )
  })

  it('filters terminal creative tools from platform listing, direct calls, and kernel surface', async () => {
    const terminalCall = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      ok: true,
      toolName: name,
      category: 'terminal' as const,
      status: 'available' as const,
      data: { args }
    }))
    const terminalAdapter: MagicAgentCreativeToolAdapter = {
      definitions: () => [
        {
          name: 'terminal.run',
          category: 'terminal',
          description: 'Terminal run.',
          inputSchema: { type: 'object' },
          status: 'available',
          permissionLevel: 'destructive',
          requiresConfirmation: false,
          disabledByDefault: false
        }
      ],
      callTool: terminalCall
    }
    const assistantRuntime = createAssistantRuntime()
    assistantRuntime.listTools.mockReturnValue([
      {
        name: 'assistant.echo',
        description: 'Assistant echo.',
        inputSchema: { type: 'object' }
      },
      {
        name: ' Agent.Terminal.Run ',
        description: 'Assistant terminal.',
        inputSchema: { type: 'object' }
      }
    ])
    const agentKernel = new AgentKernel()
    const toolRegistry = new MagicAgentToolRegistry()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({
        adapters: [creativeAdapter, terminalAdapter]
      }),
      agentKernel,
      toolRegistry
    })

    const listedTools = adapter
      .listTools()
      .map((tool) => `${tool.source}:${tool.name.trim().toLowerCase()}`)
    expect(listedTools).toContain('assistantRuntime:agent.terminal.run')
    expect(listedTools).not.toContain('creative:terminal.run')
    expect(
      agentKernel.listCapabilities().map((capability) => capability.capabilityId)
    ).not.toContain('magicagent.platform.tool.creative.terminal.run')
    expect(agentKernel.getTool('magicagent.creative.terminal.run')).toBeUndefined()
    expect(toolRegistry.get('agent.terminal.run')).toBeUndefined()
    expect(toolRegistry.get('terminal.run')).toBeUndefined()

    await expect(
      adapter.callTool({
        source: 'creative',
        name: ' Terminal.Run ',
        args: { command: 'pwd' },
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      })
    ).resolves.toMatchObject({
      ok: false,
      toolName: 'terminal.run',
      source: 'creative',
      status: 'permission-denied'
    })
    expect(terminalCall).not.toHaveBeenCalled()
  })

  it('rejects mixed-case direct AssistantRuntime tool calls at the platform boundary', async () => {
    const assistantRuntime = createAssistantRuntime()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })

    await expect(
      adapter.callTool({
        name: ' Assistant.Echo ',
        args: { text: 'hi' },
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      })
    ).resolves.toMatchObject({
      ok: false,
      toolName: 'assistant.echo',
      source: 'assistantRuntime',
      status: 'permission-denied',
      content:
        'AssistantRuntime tools are not directly callable through the MagicAgent platform service. Use route-scoped runAgent with an explicit allowedToolNames list.'
    })

    expect(assistantRuntime.callTool).not.toHaveBeenCalled()
  })

  it('runs agents through AssistantRuntime with normalized route and execution policy', async () => {
    const assistantRuntime = createAssistantRuntime()
    const chatService = createChatService({
      content: '',
      metadata: { toolCalls: [{ id: 'unsafe', name: 'creative.echo', args: { prompt: 'bypass' } }] }
    })
    const adapter = new MagicAgentPlatformAdapter({
      chatService,
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })

    await expect(
      adapter.runAgent({
        agentId: 'magicpot.default.chat',
        text: 'make art',
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
        allowedToolNames: ['assistant.echo'],
        maxToolIterations: 2,
        metadata: { traceLabel: 'safe-run' }
      })
    ).resolves.toMatchObject({
      runId: 'assistant-run-1',
      agentId: 'magicpot.default.chat',
      status: 'completed',
      content: 'assistant-run:make art',
      toolCalls: []
    })

    expect(chatService.chat).not.toHaveBeenCalled()
    expect(assistantRuntime.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
        text: 'make art',
        execution: expect.objectContaining({
          mode: 'inherit',
          allowedToolNames: ['assistant.echo'],
          maxToolCalls: 2,
          traceLabel: 'safe-run'
        })
      })
    )
  })

  it('passes files.patch only through the route-scoped Agent execution allowlist', async () => {
    const assistantRuntime = createAssistantRuntime()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })

    await adapter.runAgent({
      agentId: 'magicpot.default.chat',
      text: 'apply approved patch',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
      allowedToolNames: ['files.patch']
    })

    expect(assistantRuntime.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({ allowedToolNames: ['files.patch'] })
      })
    )
    await expect(
      adapter.callTool({
        name: 'files.patch',
        args: { path: 'a.txt', patch: 'unsafe' },
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      })
    ).resolves.toMatchObject({ status: 'permission-denied' })
    expect(assistantRuntime.callTool).not.toHaveBeenCalled()
  })

  it('includes the default registered agent system prompt in AssistantRuntime execution', async () => {
    const assistantRuntime = createAssistantRuntime()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })
    const defaultAgent = adapter.listAgents().find((agent) => agent.id === 'magicpot.default.chat')

    await adapter.runAgent({
      agentId: 'magicpot.default.chat',
      text: 'use the default agent',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
    })

    expect(defaultAgent?.systemPrompt).toBeTruthy()
    expect(assistantRuntime.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: defaultAgent?.systemPrompt })
    )
  })

  it('composes a dynamically registered agent prompt before the request addendum', async () => {
    const assistantRuntime = createAssistantRuntime()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })
    adapter.registerAgent({
      id: 'test.dynamic',
      name: 'Dynamic agent',
      systemPrompt: 'Follow the registered agent instructions.'
    })

    await adapter.runAgent({
      agentId: 'test.dynamic',
      text: 'use the dynamic agent',
      systemPrompt: 'Also format the answer as JSON.',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
    })

    expect(assistantRuntime.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'Follow the registered agent instructions.\n\nAlso format the answer as JSON.'
      })
    )
  })

  it('does not duplicate identical agent and request prompts after trimming', async () => {
    const assistantRuntime = createAssistantRuntime()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })
    adapter.registerAgent({
      id: 'test.no-duplicate',
      name: 'No duplicate agent',
      systemPrompt: 'Use one copy of this prompt.'
    })

    await adapter.runAgent({
      agentId: 'test.no-duplicate',
      text: 'avoid duplication',
      systemPrompt: '  Use one copy of this prompt.  ',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
    })

    expect(assistantRuntime.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'Use one copy of this prompt.' })
    )
  })

  it('forwards graph cancellation signals into AssistantRuntime agent execution', async () => {
    const assistantRuntime = createAssistantRuntime()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })
    const controller = new AbortController()

    let finishRun: ((value: AssistantRuntimeResult) => void) | undefined
    assistantRuntime.handleMessage.mockImplementation(
      async () =>
        new Promise<AssistantRuntimeResult>((resolve) => {
          finishRun = resolve
        })
    )
    const runPromise = adapter.runAgent(
      {
        agentId: 'magicpot.default.chat',
        text: 'cancel-aware run',
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      },
      { signal: controller.signal }
    )
    await Promise.resolve()

    const forwardedSignal = assistantRuntime.handleMessage.mock.calls[0]?.[0].signal
    expect(forwardedSignal).toBeInstanceOf(AbortSignal)
    expect(forwardedSignal).not.toBe(controller.signal)
    controller.abort('graph cancelled')
    expect(forwardedSignal?.aborted).toBe(true)
    expect(forwardedSignal?.reason).toBe('graph cancelled')
    finishRun?.({
      runId: 'assistant-run-cancelled',
      sessionKey: 'generic:dm:demo',
      historySize: 1,
      status: 'cancelled',
      reply: { content: 'cancelled' },
      events: []
    })
    await expect(runPromise).resolves.toMatchObject({ status: 'aborted' })
  })

  it('enforces platform run timeout requests and reports timeout status', async () => {
    const assistantRuntime = createAssistantRuntime()
    assistantRuntime.handleMessage.mockImplementation(
      async () => new Promise<AssistantRuntimeResult>(() => undefined)
    )
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })

    await expect(
      adapter.runAgent({
        agentId: 'magicpot.default.chat',
        text: 'time out',
        timeoutMs: 15,
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      })
    ).resolves.toMatchObject({
      status: 'timeout',
      error: expect.stringContaining('timed out after 15ms')
    })
    expect(assistantRuntime.handleMessage.mock.calls[0]?.[0].signal?.aborted).toBe(true)
  })

  it('forwards graph cancellation signals into creative tool execution', async () => {
    let receivedSignal: AbortSignal | undefined
    const signalAwareAdapter: MagicAgentCreativeToolAdapter = {
      definitions: creativeAdapter.definitions,
      callTool: async (name, args, context) => {
        receivedSignal = context?.signal
        return {
          ok: true,
          toolName: name,
          category: 'image',
          status: 'available',
          data: { args }
        }
      }
    }
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [signalAwareAdapter] })
    })
    const controller = new AbortController()

    await adapter.callTool(
      {
        source: 'creative',
        name: 'creative.echo',
        args: { prompt: 'paint' },
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      },
      { signal: controller.signal }
    )

    expect(receivedSignal).toBe(controller.signal)
  })

  it('defaults route-scoped agent runs to no assistant tools when allowedToolNames is omitted', async () => {
    const assistantRuntime = createAssistantRuntime()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })

    await adapter.runAgent({
      agentId: 'magicpot.default.chat',
      text: 'no tools by default',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
    })

    expect(assistantRuntime.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({ allowedToolNames: [] })
      })
    )
  })

  it('allows trusted platform routes to request the policy-gated AssistantRuntime terminal', async () => {
    const assistantRuntime = createAssistantRuntime()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime,
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })

    await adapter.runAgent({
      agentId: 'magicpot.default.chat',
      text: 'try terminal',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
      allowedToolNames: ['assistant.echo', ' Agent.Terminal.Run ']
    })

    expect(assistantRuntime.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          allowedToolNames: ['assistant.echo', 'agent.terminal.run']
        })
      })
    )
  })

  it('requires an explicit route for platform agent runs', async () => {
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })

    await expect(
      adapter.runAgent({
        agentId: 'magicpot.default.chat',
        text: 'missing route'
      } as never)
    ).rejects.toThrow(/explicit trusted route/)
  })

  it('fails closed for direct magicAgentRuntime tool calls at the platform boundary', async () => {
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] })
    })

    await expect(
      adapter.callTool({
        source: 'magicAgentRuntime',
        name: 'creative.echo',
        args: { prompt: 'bypass' },
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      })
    ).resolves.toMatchObject({
      ok: false,
      source: 'magicAgentRuntime',
      status: 'permission-denied'
    })
  })

  it('returns structured creative tool results and unavailable responses', async () => {
    const agentKernel = new AgentKernel()
    const adapter = new MagicAgentPlatformAdapter({
      chatService: createChatService(),
      assistantRuntime: createAssistantRuntime(),
      creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [creativeAdapter] }),
      agentKernel
    })

    await expect(
      adapter.callTool({
        source: 'creative',
        name: 'creative.echo',
        args: { prompt: 'paint' },
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      })
    ).resolves.toMatchObject({
      ok: true,
      source: 'creative',
      status: 'ok',
      data: { args: { prompt: 'paint' } }
    })
    expect(agentKernel.listEvents().at(-1)).toMatchObject({
      type: 'tool.invoked',
      metadata: expect.objectContaining({
        toolName: 'magicagent.creative.creative.echo',
        source: 'kernel'
      })
    })

    await expect(
      adapter.callTool({
        source: 'creative',
        name: 'missing.creative',
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
      })
    ).resolves.toMatchObject({
      ok: false,
      source: 'creative',
      status: 'unavailable',
      unavailableReason: 'Unknown MagicAgent creative tool: missing.creative'
    })
  })
})
