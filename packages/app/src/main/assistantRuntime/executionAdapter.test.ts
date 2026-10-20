import { beforeEach } from 'vitest'
import { describe, expect, it, vi } from 'vitest'
import { createToolResultAction, ToolInvokeAction, ToolResultAction } from '@shared/agent'

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  sync: vi.fn()
}))

vi.mock('../agentKernel/toolBridge', () => ({
  invokeAssistantToolViaKernel: bridge.invoke,
  syncAssistantToolsWithAgentKernel: bridge.sync
}))

// The Node suite owns its storage root; do not initialize Electron's native build environment.
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => ({ pathMap: { data: process.cwd() } })
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

import {
  AssistantExecutionAdapter,
  buildAssistantToolInvokeAction,
  validateAssistantToolInvokeAction
} from './executionAdapter'

describe('AssistantExecutionAdapter tool actions', () => {
  it('builds stable action and invocation IDs from run, index, name, and canonical args', () => {
    const first = buildAssistantToolInvokeAction({
      runId: 'run-1',
      toolCallIndex: 2,
      toolName: 'demo.echo',
      args: { nested: { b: true, a: 1 }, text: 'hello' },
      requestedAt: 10
    })
    const reordered = buildAssistantToolInvokeAction({
      runId: 'run-1',
      toolCallIndex: 2,
      toolName: 'demo.echo',
      args: { text: 'hello', nested: { a: 1, b: true } },
      requestedAt: 20
    })

    expect(first.actionId).toBe(reordered.actionId)
    expect(first.payload.invocationId).toBe(first.actionId)
    expect(first.payload.idempotencyKey).toBe(first.actionId)
    expect(reordered.payload.requestedAt).toBe(20)
  })

  it('rejects non-JSON invocation args and result metadata by construction', () => {
    expect(() =>
      buildAssistantToolInvokeAction({
        runId: 'run-1',
        toolCallIndex: 0,
        toolName: 'demo.echo',
        args: { invalid: undefined },
        requestedAt: 10
      })
    ).toThrow('Tool invocation args must be a JSON object.')

    expect(() =>
      createToolResultAction({
        actionId: 'result-1',
        payload: {
          invocationId: 'invocation-1',
          toolName: 'demo.echo',
          ok: true,
          metadata: { invalid: undefined } as never,
          startedAt: 10,
          finishedAt: 10,
          durationMs: 0
        }
      })
    ).toThrow('Tool result metadata must be a JSON object.')
  })
})

type ToolCallRequest = Parameters<AssistantExecutionAdapter['callTool']>[2]

const makeRequest = (): ToolCallRequest =>
  ({
    config: {},
    route: { channel: 'test', conversationId: 'conversation' },
    sessionStore: {},
    taskState: {}
  }) as unknown as ToolCallRequest

describe('AssistantExecutionAdapter tool lifecycle', () => {
  beforeEach(() => {
    bridge.invoke.mockReset()
    bridge.sync.mockReset()
  })

  it('callTool observes invoke then success, preserves original metadata, and calls the kernel once', async () => {
    const originalMetadata = { safe: true, optional: undefined }
    bridge.invoke.mockResolvedValue({ content: 'ok', metadata: originalMetadata })
    const actions: Array<ToolInvokeAction | ToolResultAction> = []
    const adapter = new AssistantExecutionAdapter({
      chatService: { chat: vi.fn() },
      onAgentAction: (action) => {
        actions.push(action)
        if (action.type === 'tool.result' && action.payload.metadata) {
          action.payload.metadata.safe = false
        }
      }
    })

    const result = await adapter.callTool('demo.echo', { value: 1 }, makeRequest())
    expect(result).toEqual({
      content: 'ok',
      metadata: { safe: true, optional: undefined }
    })
    expect(result.metadata).toBe(originalMetadata)
    expect(originalMetadata.safe).toBe(true)
    expect(actions.map((action) => action.type)).toEqual(['tool.invoke', 'tool.result'])
    expect((actions[1] as ToolResultAction).payload).toMatchObject({
      ok: true,
      metadata: { safe: false }
    })
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
  })

  it('callTool preserves cooperative checkpoint and enter/leave hooks', async () => {
    bridge.invoke.mockResolvedValue({ content: 'ok' })
    const leave = vi.fn()
    const checkpoint = vi.fn(async () => undefined)
    const enter = vi.fn(() => leave)
    const request = {
      ...makeRequest(),
      cooperativeExecution: { checkpoint, enter }
    } as Parameters<AssistantExecutionAdapter['callTool']>[2]
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })

    await adapter.callTool('demo.echo', {}, request)

    expect(checkpoint).toHaveBeenCalledWith('tool-invocation')
    expect(enter).toHaveBeenCalledWith('tool-invocation')
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('callTool observes a failed result and rethrows the original error', async () => {
    const original = Object.assign(new Error('broken'), { code: 'BROKEN' })
    bridge.invoke.mockRejectedValue(original)
    const actions: Array<ToolInvokeAction | ToolResultAction> = []
    const adapter = new AssistantExecutionAdapter({
      chatService: { chat: vi.fn() },
      onAgentAction: (action) => {
        actions.push(action)
      }
    })

    await expect(adapter.callTool('demo.echo', {}, makeRequest())).rejects.toBe(original)
    expect(actions.map((action) => action.type)).toEqual(['tool.invoke', 'tool.result'])
    expect((actions[1] as ToolResultAction).payload).toMatchObject({
      ok: false,
      error: { message: 'broken', code: 'BROKEN' }
    })
  })

  it('/tool observes invoke then successful result in order', async () => {
    bridge.invoke.mockResolvedValue({ content: 'from tool' })
    const actions: Array<ToolInvokeAction | ToolResultAction> = []
    const adapter = new AssistantExecutionAdapter({
      chatService: { chat: vi.fn() },
      onAgentAction: (action) => {
        actions.push(action)
      }
    })

    const result = await adapter.run({
      ...makeRequest(),
      runId: 'run-tool',
      req: { text: '/tool demo.echo {"value":1}' },
      messages: []
    } as never)

    expect(result.reply.content).toBe('from tool')
    expect(actions.map((action) => action.type)).toEqual(['tool.invoke', 'tool.result'])
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
  })
  it('allowlist denial observes invoke then failure without calling the kernel', async () => {
    const actions: Array<ToolInvokeAction | ToolResultAction> = []
    const adapter = new AssistantExecutionAdapter({
      chatService: { chat: vi.fn() },
      onAgentAction: (action) => {
        actions.push(action)
      }
    })

    await expect(
      adapter.callTool('demo.echo', {}, makeRequest(), { allowedToolNames: ['other.tool'] })
    ).rejects.toThrow()
    expect(actions.map((action) => action.type)).toEqual(['tool.invoke', 'tool.result'])
    expect((actions[1] as ToolResultAction).payload.ok).toBe(false)
    expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it('rejects tampered deterministic identity before observation or execution', () => {
    const descriptor = {
      runId: 'run-1',
      toolCallIndex: 0,
      toolName: 'demo.echo',
      args: { value: 1 },
      requestedAt: 10
    }
    const action = buildAssistantToolInvokeAction(descriptor)
    const tampered = { ...action, actionId: 'tampered' }

    expect(() => validateAssistantToolInvokeAction(tampered, descriptor)).toThrow(
      'trusted descriptor'
    )
  })

  it('fails closed on proposed observer failure and never retries after terminal failure', async () => {
    bridge.invoke.mockResolvedValue({ content: 'ok' })
    const proposedFailure = new Error('observer unavailable')
    const proposedAdapter = new AssistantExecutionAdapter({
      chatService: { chat: vi.fn() },
      onAgentAction: () => {
        throw proposedFailure
      }
    })
    await expect(proposedAdapter.callTool('demo.echo', {}, makeRequest())).rejects.toBe(
      proposedFailure
    )
    expect(bridge.invoke).not.toHaveBeenCalled()

    const terminalFailure = new Error('terminal observer unavailable')
    const terminalAdapter = new AssistantExecutionAdapter({
      chatService: { chat: vi.fn() },
      onAgentAction: (action) => {
        if (action.type === 'tool.result') throw terminalFailure
      }
    })
    await expect(terminalAdapter.callTool('demo.echo', {}, makeRequest())).rejects.toBe(
      terminalFailure
    )
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
  })
})

describe('durable tool intent and outcome', () => {
  it('persists intent before effect and reuses the recorded outcome for the same invocation', async () => {
    const journal: Array<{ metadata?: Record<string, unknown> }> = []
    const order: string[] = []
    const sessionStore = {
      getSession: vi.fn(async () => ({ eventLog: structuredClone(journal) })),
      appendEvents: vi.fn(async (_route, events) => {
        order.push((events[0].metadata.agentAction as { type: string }).type)
        journal.push(...structuredClone(events))
      })
    }
    bridge.invoke.mockReset()
    bridge.invoke.mockImplementation(async (input) => {
      order.push('effect')
      expect(input.signal).toBe(controller.signal)
      return { content: 'durable result', metadata: { owned: true } }
    })
    const controller = new AbortController()
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
    const request = {
      ...makeRequest(),
      route: { channel: 'test', scopeType: 'dm', scopeId: 'durable' },
      sessionStore
    } as unknown as ToolCallRequest
    const options = {
      runId: 'owned-run',
      toolCallId: 'owned-run:tool:0',
      allowedToolNames: ['demo.echo'],
      signal: controller.signal
    }
    expect(await adapter.callTool('demo.echo', { value: 1 }, request, options)).toMatchObject({
      content: 'durable result'
    })
    expect(order).toEqual(['tool.invoke', 'effect', 'tool.result'])
    const reopenedAdapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
    expect(
      await reopenedAdapter.callTool('demo.echo', { value: 1 }, request, options)
    ).toMatchObject({ content: 'durable result' })
    expect(bridge.invoke).toHaveBeenCalledOnce()
    expect(journal).toHaveLength(2)
  })

  it('does not repeat an invocation whose intent persisted but outcome is unknown', async () => {
    const action = buildAssistantToolInvokeAction({
      runId: 'interrupted',
      toolCallId: 'interrupted:tool:0',
      toolCallIndex: 0,
      toolName: 'demo.echo',
      args: { value: 1 }
    })
    const request = {
      ...makeRequest(),
      sessionStore: {
        getSession: async () => ({ eventLog: [{ metadata: { agentAction: action } }] }),
        appendEvents: vi.fn()
      }
    } as unknown as ToolCallRequest
    bridge.invoke.mockReset()
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
    await expect(
      adapter.callTool('demo.echo', { value: 1 }, request, {
        runId: 'interrupted',
        toolCallId: 'interrupted:tool:0'
      })
    ).rejects.toMatchObject({ code: 'TOOL_REPLAY_REQUIRES_REVIEW' })
    expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it('never executes a tool when the intent cannot be persisted', async () => {
    const request = {
      ...makeRequest(),
      sessionStore: {
        appendEvents: vi.fn(async () => {
          throw new Error('owned disk failure')
        })
      }
    } as unknown as ToolCallRequest
    bridge.invoke.mockReset()
    const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
    await expect(adapter.callTool('demo.echo', {}, request)).rejects.toThrow('owned disk failure')
    expect(bridge.invoke).not.toHaveBeenCalled()
  })
})

it('does not mistake another completed invocation for the requested tool result', async () => {
  const journal: Array<{ metadata?: Record<string, unknown> }> = []
  const sessionStore = {
    getSession: async () => ({ eventLog: structuredClone(journal) }),
    appendEvents: async (
      _route: unknown,
      events: Array<{ metadata?: Record<string, unknown> }>
    ) => {
      journal.push(...structuredClone(events))
    }
  }
  const request = { ...makeRequest(), sessionStore } as unknown as ToolCallRequest
  bridge.invoke.mockReset()
  bridge.invoke.mockImplementation(async ({ args }) => ({ content: String(args.value) }))
  const adapter = new AssistantExecutionAdapter({ chatService: { chat: vi.fn() } })
  expect(
    await adapter.callTool('demo.echo', { value: 'first' }, request, {
      runId: 'same-run',
      toolCallId: 'call-1'
    })
  ).toMatchObject({ content: 'first' })
  expect(
    await adapter.callTool('demo.echo', { value: 'second' }, request, {
      runId: 'same-run',
      toolCallId: 'call-2'
    })
  ).toMatchObject({ content: 'second' })
  expect(bridge.invoke).toHaveBeenCalledTimes(2)
})
