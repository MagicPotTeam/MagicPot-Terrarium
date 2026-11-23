import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { agentThreadJobs } from './agentThreadJobs'
import { SUBAGENT_READ_TOOLS } from './agentThreadSubagentCatalog'
import {
  createAgentThreadTriggerTools,
  mayInstallTriggers,
  TRIGGER_TOOL_DEFINITIONS
} from './agentThreadTriggerTools'
import { prepareCanvasAgentTools } from './canvasAgentTools'

const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({
  webContents: { fromId: electron.fromId },
  BrowserWindow: { fromWebContents: electron.parent }
}))
vi.mock('../config/config', () => ({ getConfig: () => ({}) }))
const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project',
  threadId: 'pane'
} as const
const scope = { route, conversationId: 'conversation' }
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = (method = 'chat') => ({
  methodName: `svcLLMProxy.${method}`,
  senderId: 71,
  isMainFrame: true,
  senderUrl: url,
  frameUrl: url
})
const read = {
  name: 'files.read',
  description: 'Read text',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string' } }
  }
}
beforeEach(() => {
  const sender = Object.assign(new EventEmitter(), {
    id: 71,
    isDestroyed: () => false,
    getURL: () => url
  })
  electron.fromId.mockReturnValue(sender)
  electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
})
afterEach(() => {
  agentThreadJobs.dispose()
  clearMagicAgentTrustedRouteBindingsForTest()
  vi.clearAllMocks()
})

const fakeTriggers = () => ({
  install: vi.fn((input: { name?: string }) => ({
    triggerId: input.name ?? 'trigger_0a1b2c3d',
    record: { nextFireAt: 60_000 } as never
  })),
  remove: vi.fn((_route: unknown, _conversation: string, id: string) => id === 'tick')
})
const user: LLMChatReq = {
  ...scope,
  messages: [{ role: 'user', content: 'Check the synthetic build every minute' }]
}
const turns: Record<string, LLMChatReq> = {
  'trigger_fire event': { ...user, threadEventOrigin: 'trigger_fire' },
  'job_done event': { ...user, threadEventOrigin: 'job_done' },
  'event delivery': { ...user, threadEvent: { id: 'event-1', lease: 'lease-1' } as never },
  'team member': { ...user, teamMember: { leadSessionId: 'lead', memberId: 'm1' } as never },
  'team message hop': { ...user, teamMessageHop: 1 },
  'team message delivery': { ...user, teamMessageDelivery: { id: 'message-1', lease: 'lease-1' } },
  'goal progress': { ...user, goalProgressToken: 'goal-token' }
}
function tools(request: LLMChatReq, triggers = fakeTriggers()) {
  const provider = createAgentThreadTriggerTools({
    request,
    triggers,
    assertInvocation: () => undefined,
    installAllowed: mayInstallTriggers(request)
  })
  const call = (name: string, args: Record<string, unknown>) =>
    provider.callTool(name, args, { route, runId: 'run', toolCallId: `${name}-call` })
  return { provider, call, triggers }
}

describe('trigger tools (KohakuTerrarium 2.2.3)', () => {
  it('keeps KT names, parameters, defaults and required fields', () => {
    const schema = (name: string) =>
      TRIGGER_TOOL_DEFINITIONS.find((tool) => tool.name === name)!.inputSchema as unknown as {
        properties: Record<string, { type: string; default?: unknown }>
        required: string[]
      }
    expect(TRIGGER_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'add_timer',
      'add_schedule',
      'delete_trigger'
    ])
    expect(Object.keys(schema('add_timer').properties)).toEqual([
      'name',
      'interval',
      'prompt',
      'immediate'
    ])
    expect(schema('add_timer').required).toEqual(['interval', 'prompt'])
    expect(schema('add_timer').properties.immediate).toMatchObject({
      type: 'boolean',
      default: false
    })
    expect(Object.keys(schema('add_schedule').properties)).toEqual([
      'name',
      'every_minutes',
      'daily_at',
      'hourly_at',
      'prompt'
    ])
    expect(schema('add_schedule').required).toEqual(['prompt'])
    expect(schema('delete_trigger').required).toEqual(['trigger_id'])
    expect(TRIGGER_TOOL_DEFINITIONS[0].description).toContain('at least 60 seconds')
  })

  it('answers with KT result text', async () => {
    const { call, triggers } = tools(user)
    expect((await call('add_timer', { interval: 300, prompt: 'Check it' })).content).toBe(
      "Trigger `add_timer` correctly set up and running in the background with interval=300, prompt='Check it'. trigger_id=trigger_0a1b2c3d"
    )
    expect(
      (await call('add_schedule', { name: 'standup', daily_at: '09:30', prompt: 'Summarize' }))
        .content
    ).toBe(
      "Trigger `add_schedule` correctly set up and running in the background with daily_at='09:30', prompt='Summarize'. trigger_id=standup"
    )
    expect(triggers.install).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tool: 'add_schedule',
        name: 'standup',
        spec: { kind: 'schedule', daily_at: '09:30' }
      })
    )
    expect((await call('delete_trigger', { trigger_id: 'tick' })).content).toBe(
      'Removed trigger: tick'
    )
    await expect(call('delete_trigger', { trigger_id: 'gone' })).rejects.toThrow(
      'Trigger not found: gone'
    )
  })

  it('refuses a timer under the floor with a clear error and installs nothing', async () => {
    const { call, triggers } = tools(user)
    await expect(call('add_timer', { interval: 30, prompt: 'Too often' })).rejects.toThrow(
      /at least 60 seconds \(got 30\)/
    )
    await expect(
      call('add_schedule', { every_minutes: 5, daily_at: '09:00', prompt: 'x' })
    ).rejects.toThrow(/exactly one/)
    await expect(call('add_timer', { interval: 60, prompt: 'x', extra: true })).rejects.toThrow(
      /Invalid add_timer/
    )
    expect(triggers.install).not.toHaveBeenCalled()
  })

  it.each(Object.entries(turns))(
    "lets only the user's own turn install: a %s turn can only delete",
    async (_label, request) => {
      expect(mayInstallTriggers(request)).toBe(false)
      const { provider, call, triggers } = tools(request)
      expect(provider.listTools().map((tool) => tool.name)).toEqual(['delete_trigger'])
      await expect(call('add_timer', { interval: 60, prompt: 'spawn' })).rejects.toThrow(
        /user's own message/
      )
      await expect(call('add_schedule', { hourly_at: 0, prompt: 'spawn' })).rejects.toThrow(
        /user's own message/
      )
      expect(triggers.install).not.toHaveBeenCalled()
      expect((await call('delete_trigger', { trigger_id: 'tick' })).content).toBe(
        'Removed trigger: tick'
      )
    }
  )

  it('refuses install for goal progress (the provider option) too', () => {
    expect(mayInstallTriggers(user)).toBe(true)
    expect(mayInstallTriggers(user, { goalProgress: {} })).toBe(false)
  })

  it('gives sub-agents (explore, critic, fork, ...) no trigger tool at all', async () => {
    for (const tool of TRIGGER_TOOL_DEFINITIONS)
      expect(SUBAGENT_READ_TOOLS as readonly string[]).not.toContain(tool.name)
    const prepared = prepareCanvasAgentTools({ ...user }, invocation(), {
      local: true,
      terminalEnabled: false,
      listTools: () => [read],
      createSubagentClient: async () => ({ chat: vi.fn(), supportsIsolatedReadOnlyTurns: true }),
      callSubagentReadTool: async () => ({ content: '' }),
      triggers: fakeTriggers()
    })
    try {
      // A child's tool call goes through the read-only side admission, which refuses every trigger tool.
      for (const tool of TRIGGER_TOOL_DEFINITIONS)
        await expect(
          prepared.readAdmission!.run(
            tool.name,
            new AbortController().signal,
            async () => undefined
          )
        ).rejects.toThrow('read-only')
    } finally {
      prepared.dispose!(true)
    }
  })
})

describe('the tool set of a trigger turn', () => {
  const listFor = (request: LLMChatReq, method: string) => {
    const prepared = prepareCanvasAgentTools(request, invocation(method), {
      local: true,
      terminalEnabled: false,
      scriptToolsEnabled: () => true,
      shellToolsEnabled: () => true,
      listTools: () => [read],
      createSubagentClient: async () => ({ chat: vi.fn(), supportsIsolatedReadOnlyTurns: true }),
      callSubagentReadTool: async () => ({ content: '' }),
      triggers: fakeTriggers()
    })
    try {
      return prepared.toolProvider!.listTools().map((tool) => tool.name)
    } finally {
      prepared.dispose!(true)
    }
  }

  it("is the ordinary event-turn set: a user turn's tools minus installing, nothing added", () => {
    const own = listFor(user, 'chat')
    const trigger = listFor({ ...user, threadEventOrigin: 'trigger_fire' }, 'chatStream')
    const job = listFor({ ...user, threadEventOrigin: 'job_done' }, 'chatStream')
    expect(own).toEqual(expect.arrayContaining(['add_timer', 'add_schedule', 'delete_trigger']))
    expect(trigger).toEqual(own.filter((name) => name !== 'add_timer' && name !== 'add_schedule'))
    expect(trigger).toEqual(job)
    expect(trigger).toContain('delete_trigger')
  })

  it('lists no trigger tool outside a local canvas thread', () => {
    const prepared = prepareCanvasAgentTools({ ...user }, invocation(), {
      local: false,
      terminalEnabled: false,
      triggers: fakeTriggers()
    })
    expect(prepared.toolProvider?.listTools().map((tool) => tool.name) ?? []).not.toContain(
      'add_timer'
    )
    prepared.dispose?.(true)
  })
})
