import { describe, expect, it, vi } from 'vitest'
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
    }
  ]),
  callTool: vi.fn(async (_route, name: string, args: Record<string, unknown>) => ({
    content: `assistant:${name}`,
    metadata: { args }
  })),
  handleMessage: vi.fn(
    async (req: AssistantInboundMessage): Promise<AssistantRuntimeResult> => ({
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
    })
  )
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

describe('MagicAgentPlatformAdapter', () => {
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
      expect.arrayContaining(['assistantRuntime:assistant.echo', 'creative:creative.echo'])
    )
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
    expect(listedTools).not.toContain('assistantRuntime:agent.terminal.run')
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
          traceLabel: 'safe-run'
        })
      })
    )
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

  it('does not allow renderer-facing runAgent to re-expose AssistantRuntime terminal execution', async () => {
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
        execution: expect.objectContaining({ allowedToolNames: ['assistant.echo'] })
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
