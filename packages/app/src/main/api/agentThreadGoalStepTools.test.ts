import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { agentThreadJobs } from './agentThreadJobs'
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

const user: LLMChatReq = {
  ...scope,
  messages: [{ role: 'user', content: 'Goal step' }],
  threadEventOrigin: 'drive_ready'
}
const goalStep = (charge: (tool: string) => void = () => undefined) => ({
  provider: {
    listTools: () => [
      { name: 'drive_status', description: 'goal', inputSchema: { type: 'object' } }
    ],
    callTool: vi.fn(async () => ({ content: 'ok' }))
  },
  chargeToolCall: vi.fn(charge)
})
const prepare = (step: ReturnType<typeof goalStep>, local = true) =>
  prepareCanvasAgentTools({ ...user }, invocation(), {
    local,
    terminalEnabled: false,
    listTools: () => [read],
    goalStep: step
  })

/** S5: a goal step turn's tool calls are charged at the one canvas admission every call passes. */
describe('goal step canvas admission', () => {
  it('lists the goal tools and charges each call before it runs', async () => {
    const step = goalStep()
    const prepared = prepare(step)
    try {
      expect(prepared.toolProvider!.listTools().map((tool) => tool.name)).toContain('drive_status')
      expect(prepared.request.skillRuntime?.bindings?.[0]?.toolNames).toEqual(
        expect.arrayContaining(['drive_status', 'files.read'])
      )
      const run = vi.fn(async () => {
        expect(step.chargeToolCall).toHaveBeenCalledWith('files.read')
        return 'done'
      })
      await expect(prepared.admission!.run('files.read', undefined, run)).resolves.toBe('done')
      expect(run).toHaveBeenCalledTimes(1)
      // An event-origin step: no trigger installs and the same approval-gated tool set.
      expect(prepared.toolProvider!.listTools().map((tool) => tool.name)).not.toContain('add_timer')
    } finally {
      prepared.dispose?.(true)
    }
  })

  it('refuses the call past the budget: it never runs', async () => {
    const prepared = prepare(
      goalStep(() => {
        throw new Error('Goal tool-call budget exhausted (2/2)')
      })
    )
    try {
      const run = vi.fn(async () => 'done')
      await expect(prepared.admission!.run('files.read', undefined, run)).rejects.toThrow(
        'budget exhausted'
      )
      expect(run).not.toHaveBeenCalled()
    } finally {
      prepared.dispose?.(true)
    }
  })

  it('never runs a goal step without trusted canvas admission', () => {
    expect(() => prepare(goalStep(), false)).toThrow('goal step requires')
    // Children call tools outside the charged admission: a goal step never gets them.
    for (const child of [
      {
        createSubagentClient: async () => ({ chat: vi.fn(), supportsIsolatedReadOnlyTurns: true })
      },
      { createMemoryClient: vi.fn() as never, commitMemoryFile: vi.fn() as never }
    ])
      expect(() =>
        prepareCanvasAgentTools({ ...user }, invocation(), {
          local: true,
          terminalEnabled: false,
          goalStep: goalStep(),
          ...child
        } as never)
      ).toThrow('goal step requires')
    expect(() =>
      prepareCanvasAgentTools({ ...user }, undefined, {
        local: true,
        terminalEnabled: false,
        goalStep: goalStep()
      })
    ).toThrow('goal step requires')
  })
})
