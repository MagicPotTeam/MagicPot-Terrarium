import * as fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import * as configModule from '../config/config'
import type { AssistantRuntime } from '../assistantRuntime/runtime'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const {
  generateFromMessagesMock,
  Hunyuan3DClientMock,
  clearHy3dCosPrefixMock,
  uploadLocalHy3dModelMock,
  uploadBufferedHy3dModelMock,
  signHy3dCosModelMock,
  fetchMock,
  useActualHunyuan3DClient,
  listToolsMock,
  callToolMock
} = vi.hoisted(() => ({
  generateFromMessagesMock: vi.fn(),
  Hunyuan3DClientMock: vi.fn(),
  clearHy3dCosPrefixMock: vi.fn(),
  uploadLocalHy3dModelMock: vi.fn(),
  uploadBufferedHy3dModelMock: vi.fn(),
  signHy3dCosModelMock: vi.fn(),
  fetchMock: vi.fn(),
  useActualHunyuan3DClient: { current: false },
  listToolsMock: vi.fn(),
  callToolMock: vi.fn()
}))

vi.mock(import('../config/config'), () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn()
}))

vi.mock(import('@shared/llm'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/llm')>()
  return {
    ...actual,
    cliFromProfile: vi.fn()
  }
})

vi.mock(import('../llmProxy/hunyuan3dClient'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llmProxy/hunyuan3dClient')>()
  return {
    Hunyuan3DClient: Hunyuan3DClientMock.mockImplementation(
      (...args: ConstructorParameters<typeof actual.Hunyuan3DClient>) => {
        if (useActualHunyuan3DClient.current) {
          return new actual.Hunyuan3DClient(...args)
        }
        return {
          generateFromMessages: generateFromMessagesMock
        }
      }
    )
  }
})

vi.mock(import('../llmProxy/hunyuan3dCos'), () => ({
  signHy3dCosModel: signHy3dCosModelMock,
  uploadBufferedHy3dModel: uploadBufferedHy3dModelMock,
  uploadLocalHy3dModel: uploadLocalHy3dModelMock,
  clearHy3dCosPrefix: clearHy3dCosPrefixMock
}))

vi.mock(import('../assistantRuntime/runtime'), () => ({
  getAssistantRuntime: vi.fn(
    () =>
      ({
        listTools: listToolsMock,
        callTool: callToolMock
      }) as unknown as AssistantRuntime
  )
}))

vi.mock(import('../mcp/runtime'), () => ({
  syncMcpClientManager: vi.fn(async () => undefined)
}))

const mockConfig = (overrides: Partial<Config>): void => {
  vi.mocked(configModule.getConfig).mockReturnValue({
    ...DEFAULT_CONFIG,
    ...overrides,
    llm_config: {
      ...DEFAULT_CONFIG.llm_config,
      ...(overrides.llm_config || {})
    },
    plugin_config: {
      ...DEFAULT_CONFIG.plugin_config!,
      ...(overrides.plugin_config || {})
    }
  } as Config)
}

describe('LLMProxySvcImpl', () => {
  afterEach(() => {
    useActualHunyuan3DClient.current = false
    fetchMock.mockReset()
    listToolsMock.mockReset()
    callToolMock.mockReset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('keeps normal chat on Agent API profiles even when Quick App profiles are present', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-profile',
            model_name: 'Quick Model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system prompt'
    })

    expect(cliFromProfile).toHaveBeenCalledTimes(1)
    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-profile',
        model_name: 'Agent Model',
        base_url: 'https://agent.example/v1',
        api_key: 'agent-key'
      }),
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(cliFromProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'quick-profile'
      })
    )
    expect(agentChat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system prompt'
    })
    expect(resp.content).toBe('agent response')
  })

  it('uses Quick App API profiles when the request asks for qapp profile scope', async () => {
    const quickChat = vi.fn().mockResolvedValue('quick response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: quickChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-profile',
            model_name: 'Quick Model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileScope: 'qapp',
      profileId: 'quick-profile',
      messages: [{ role: 'user', content: 'hello' }]
    })

    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'quick-profile',
        model_name: 'Quick Model',
        base_url: 'https://quick.example/v1',
        api_key: 'quick-key'
      }),
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(quickChat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: undefined
    })
    expect(resp.content).toBe('quick response')
  })

  it('passes AbortSignal through to the selected LLM client', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    const controller = new AbortController()
    const svc = new LLMProxySvcImpl()
    await svc.chat(
      {
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'hello' }]
      },
      {
        signal: controller.signal
      }
    )

    expect(agentChat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: undefined,
      signal: controller.signal
    })
  })

  it('cancels an in-flight conversation by conversationId', async () => {
    const agentChat = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              const error = signal.reason instanceof Error ? signal.reason : new Error('aborted')
              if (!('name' in error) || !error.name) {
                ;(error as Error).name = 'AbortError'
              }
              reject(error)
            },
            { once: true }
          )
          if (signal?.aborted) {
            const error = signal.reason instanceof Error ? signal.reason : new Error('aborted')
            ;(error as Error).name = 'AbortError'
            reject(error)
            return
          }
        })
    )
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const pending = svc.chat({
      conversationId: 'conversation-1',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'hello' }]
    })

    await expect(svc.cancelConversation({ conversationId: 'conversation-1' })).resolves.toEqual({
      cancelled: true
    })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('exposes bound MCP tools to normal chat and executes them through the local runtime', async () => {
    const agentChat = vi
      .fn()
      .mockResolvedValueOnce('{"toolName":"mcp.github.issues.list","args":{"repo":"magicpot"}}')
      .mockResolvedValueOnce('Found 3 issues in magicpot.')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      mcp_config: {
        ...DEFAULT_CONFIG.mcp_config,
        client: {
          ...DEFAULT_CONFIG.mcp_config.client,
          servers: [
            {
              id: 'github',
              enabled: true,
              transport: 'stdio',
              command: 'github-mcp'
            }
          ]
        }
      }
    })

    listToolsMock.mockImplementation((allowedToolNames?: string[] | null) => {
      const tools = [
        {
          name: 'mcp.github.issues.list',
          description: 'List issues',
          inputSchema: {
            type: 'object',
            properties: {
              repo: { type: 'string' }
            }
          }
        },
        {
          name: 'mcp.github.pulls.list',
          description: 'List pulls',
          inputSchema: {
            type: 'object'
          }
        }
      ]
      return Array.isArray(allowedToolNames)
        ? tools.filter((tool) => allowedToolNames.includes(tool.name))
        : tools
    })
    callToolMock.mockResolvedValue({
      content: 'Issue #1\nIssue #2\nIssue #3',
      metadata: { ok: true }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-conv',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'List recent GitHub issues for magicpot.' }],
      skillRuntime: {
        skillId: 'github-agent',
        bindings: [
          {
            appId: 'mcp.github',
            toolNames: [' mcp.github.issues.list ', 'mcp.github.issues.list']
          }
        ]
      }
    })

    expect(listToolsMock).toHaveBeenCalledWith(['mcp.github.issues.list'])
    expect(agentChat).toHaveBeenCalledTimes(2)
    expect(agentChat.mock.calls[0]?.[0]?.systemPrompt).toContain('Tool: mcp.github.issues.list')
    expect(agentChat.mock.calls[0]?.[0]?.systemPrompt).not.toContain('mcp.github.pulls.list')
    expect(callToolMock).toHaveBeenCalledWith(
      {
        channel: 'generic',
        scopeType: 'dm',
        scopeId: 'tagging-conv'
      },
      'mcp.github.issues.list',
      { repo: 'magicpot' },
      {
        allowedToolNames: ['mcp.github.issues.list']
      }
    )
    expect(agentChat.mock.calls[1]?.[0].messages).toEqual([
      { role: 'user', content: 'List recent GitHub issues for magicpot.' },
      {
        role: 'assistant',
        content: '{"toolName":"mcp.github.issues.list","args":{"repo":"magicpot"}}'
      },
      {
        role: 'assistant',
        content:
          '[Tool Result]\ntoolName: mcp.github.issues.list\nargs:\n{\n  "repo": "magicpot"\n}\n\nIssue #1\nIssue #2\nIssue #3'
      }
    ])
    expect(resp.content).toBe('Found 3 issues in magicpot.')
  })

  it('does not leak unbound MCP tools into normal chat tool visibility', async () => {
    const agentChat = vi.fn().mockResolvedValue('No external tools are available for this skill.')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([
      {
        name: 'mcp.github.issues.list',
        description: 'List issues',
        inputSchema: {}
      }
    ])

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-unbound',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'Can you use GitHub MCP here?' }],
      skillRuntime: {
        skillId: 'no-tools-skill',
        bindings: [
          {
            appId: 'mcp.github',
            resourceUris: ['magicpot://chat/tools']
          }
        ]
      }
    })

    expect(listToolsMock).not.toHaveBeenCalled()
    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).toHaveBeenCalledTimes(1)
    expect(agentChat.mock.calls[0]?.[0]?.messages).toEqual([
      { role: 'user', content: 'Can you use GitHub MCP here?' }
    ])
    expect(agentChat.mock.calls[0]?.[0]?.systemPrompt).toBeUndefined()
    expect(resp.content).toBe('No external tools are available for this skill.')
  })

  it('does not mistake ordinary structured JSON output for a tool invocation', async () => {
    const agentChat = vi.fn().mockResolvedValue('{"summary":"ready"}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'structured-output',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'Return a JSON summary.' }],
      skillRuntime: {
        skillId: 'structured-skill',
        execution: {
          outputMode: 'structured'
        },
        outputSchema: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: { type: 'string' }
          }
        }
      }
    })

    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).toHaveBeenCalledTimes(1)
    expect(resp).toEqual({
      content: '{\n  "summary": "ready"\n}'
    })
  })

  it('ignores tool-shaped JSON when the requested tool is not bound to the current skill', async () => {
    const agentChat = vi.fn().mockResolvedValue('{"toolName":"mcp.github.pulls.list","args":{}}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    listToolsMock.mockReturnValue([
      {
        name: 'mcp.github.issues.list',
        description: 'List issues',
        inputSchema: {}
      }
    ])

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tool-shaped-json',
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'Return JSON only.' }],
      skillRuntime: {
        skillId: 'github-agent',
        bindings: [
          {
            appId: 'mcp.github',
            toolNames: ['mcp.github.issues.list']
          }
        ]
      }
    })

    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).toHaveBeenCalledTimes(1)
    expect(resp).toEqual({
      content: '{"toolName":"mcp.github.pulls.list","args":{}}'
    })
  })

  it('short-circuits /tools through the local runtime when skillRuntime binds tools', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([
      {
        name: 'session.status',
        description: 'Status',
        inputSchema: {}
      }
    ])

    mockConfig({})

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-conv',
      messages: [{ role: 'user', content: '/tools' }],
      skillRuntime: {
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: [' session.status ', 'session.status']
          }
        ]
      }
    })

    expect(listToolsMock).toHaveBeenCalledWith(['session.status'])
    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).not.toHaveBeenCalled()
    expect(resp.content).toContain('Available chat tools:')
    expect(resp.content).toContain('- session.status: Status')
  })

  it('keeps explicit empty tool bindings when short-circuiting /tools', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    listToolsMock.mockReturnValue([])

    mockConfig({})

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-empty',
      messages: [{ role: 'user', content: '/tools' }],
      skillRuntime: {
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: []
          }
        ]
      }
    })

    expect(listToolsMock).toHaveBeenCalledWith([])
    expect(callToolMock).not.toHaveBeenCalled()
    expect(agentChat).not.toHaveBeenCalled()
    expect(resp.content).toBe('No chat tools are available.')
  })

  it('short-circuits /tool through the local runtime with allowedToolNames', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    callToolMock.mockResolvedValue({
      content: 'tool output',
      metadata: { ok: true }
    })

    mockConfig({})

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      conversationId: 'tagging-tool',
      messages: [{ role: 'user', content: '/tool session.status {"verbose":true}' }],
      skillRuntime: {
        skillId: 'built-in.tagging',
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: ['session.status']
          }
        ]
      }
    })

    expect(callToolMock).toHaveBeenCalledWith(
      {
        channel: 'generic',
        scopeType: 'dm',
        scopeId: 'tagging-tool'
      },
      'session.status',
      { verbose: true },
      {
        allowedToolNames: ['session.status']
      }
    )
    expect(listToolsMock).not.toHaveBeenCalled()
    expect(agentChat).not.toHaveBeenCalled()
    expect(resp).toEqual({
      content: 'tool output'
    })
  })

  it('falls back to sessionUrl when building the shared skill runtime route', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)
    callToolMock.mockResolvedValue({
      content: 'tool output',
      metadata: { ok: true }
    })

    mockConfig({})

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      sessionUrl: ' https://example.com/sessions/skill-42 ',
      messages: [{ role: 'user', content: '/tool session.status {"verbose":false}' }],
      skillRuntime: {
        bindings: [
          {
            appId: 'magicpot.core',
            toolNames: ['session.status']
          }
        ]
      }
    })

    expect(callToolMock).toHaveBeenCalledWith(
      {
        channel: 'generic',
        scopeType: 'dm',
        scopeId: 'https://example.com/sessions/skill-42'
      },
      'session.status',
      { verbose: false },
      {
        allowedToolNames: ['session.status']
      }
    )
  })

  it('runs chat in isolated mode with only the latest message', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'agent-profile',
      systemPrompt: 'system prompt',
      messages: [
        { role: 'system', content: 'old turn' },
        { role: 'user', content: 'latest question' }
      ],
      skillRuntime: {
        execution: {
          mode: 'isolated'
        }
      }
    })

    expect(agentChat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'latest question' }],
      systemPrompt: 'system prompt',
      signal: undefined
    })
    expect(resp.content).toBe('agent response')
  })

  it('honors no-history policy by dropping prior messages', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'agent-profile',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'history reply' },
        { role: 'user', content: 'latest question' }
      ],
      skillRuntime: {
        execution: {
          allowHistory: false
        }
      }
    })

    expect(agentChat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'latest question' }],
      systemPrompt: undefined,
      signal: undefined
    })
    expect(resp.content).toBe('agent response')
  })

  it('limits skill runtime context and disables session continuation for finite context', async () => {
    const agentChat = vi.fn().mockResolvedValue('agent response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId: 'agent-profile',
      sessionUrl: 'session-should-not-continue',
      messages: [
        { role: 'user', content: 'm1' },
        { role: 'assistant', content: 'm2' },
        { role: 'user', content: 'm3' },
        { role: 'assistant', content: 'm4' },
        { role: 'user', content: 'latest question' }
      ],
      skillRuntime: {
        execution: {
          mode: 'inherit',
          allowHistory: true,
          contextMessageLimit: 3,
          persistSessionUrl: false
        }
      }
    })

    const chatRequest = agentChat.mock.calls[0]?.[0]
    expect(chatRequest.messages).toEqual([
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' },
      { role: 'assistant', content: 'm4' },
      { role: 'user', content: 'latest question' }
    ])
    expect(chatRequest.sessionUrl).toBeUndefined()
  })

  it('validates structured skill output against the declared schema', async () => {
    const agentChat = vi.fn().mockResolvedValue('{"summary":"ok"}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'agent-profile',
      messages: [{ role: 'user', content: 'return structured json' }],
      skillRuntime: {
        execution: {
          outputMode: 'structured'
        },
        outputSchema: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: { type: 'string' }
          }
        }
      }
    })

    expect(resp).toEqual({
      content: '{\n  "summary": "ok"\n}'
    })
  })

  it('rejects structured skill output that does not satisfy the declared schema', async () => {
    const agentChat = vi.fn().mockResolvedValue('{"summary":1}')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()

    await expect(
      svc.chat({
        profileId: 'agent-profile',
        messages: [{ role: 'user', content: 'return structured json' }],
        skillRuntime: {
          execution: {
            outputMode: 'structured'
          },
          outputSchema: {
            type: 'object',
            required: ['summary'],
            properties: {
              summary: { type: 'string' }
            }
          }
        }
      })
    ).rejects.toThrow('Structured output validation failed')
  })

  it('routes builtin tagging skill requests through Tagger Provider V2', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        '{"tags":["red dragon"],"tagsText":"red dragon","caption":"A red dragon icon."}'
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'tagger-profile',
            model_name: 'WD14 Local',
            base_url: 'http://127.0.0.1:7860',
            api_key: 'local-key',
            provider: 'openai',
            deployment: 'local',
            tagger_provider: 'wdtagger',
            tagger_endpoint: 'http://127.0.0.1:7860/api',
            tagger_runtime_cache_scope: 'profile'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'tagger-profile',
      messages: [{ role: 'user', content: 'tag this asset' }],
      skillRuntime: {
        skillId: 'builtin-tagging',
        execution: {
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'structured',
          fallbackStrategy: 'smaller-batches',
          persistSessionUrl: false
        }
      }
    })

    expect(cliFromProfile).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]
    expect(requestUrl).toBe('http://127.0.0.1:7860/api/tagger/v2/infer')
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-key',
        'Content-Type': 'application/json'
      }
    })
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      provider: {
        id: 'wdtagger',
        name: 'WDTagger',
        family: 'tagger',
        endpoint: 'http://127.0.0.1:7860/api',
        cacheKey: expect.any(String)
      },
      profile: {
        id: 'tagger-profile',
        modelName: 'WD14 Local',
        taggerProvider: 'wdtagger',
        taggerEndpoint: 'http://127.0.0.1:7860/api'
      },
      request: {
        skillId: 'builtin-tagging',
        outputMode: 'structured'
      }
    })
    expect(resp.content).toContain('"tags"')
    expect(resp.content).toContain('"caption"')
  })

  it('preserves structured OCR payloads returned by Tagger Provider V2', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          content:
            '{"results":[{"fileName":"doc.png","tags":["wdtagger"],"tagsText":"wdtagger","caption":"doc caption","ocrResult":{"kind":"document","text":"invoice #1"}}]}',
          ocrResult: {
            kind: 'document',
            text: 'invoice #1'
          }
        })
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'tagger-profile',
            model_name: 'WD14 Local',
            base_url: 'http://127.0.0.1:7860',
            api_key: 'local-key',
            provider: 'openai',
            deployment: 'local',
            tagger_provider: 'wdtagger',
            tagger_endpoint: 'http://127.0.0.1:7860/api',
            tagger_runtime_cache_scope: 'profile'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'tagger-profile',
      messages: [
        {
          role: 'user',
          content: 'read and tag this asset',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,UE5H',
              fileName: 'doc.png',
              mimeType: 'image/png'
            }
          ]
        }
      ],
      skillRuntime: {
        skillId: 'builtin-tagging',
        execution: {
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'structured',
          fallbackStrategy: 'smaller-batches',
          persistSessionUrl: false
        }
      }
    })

    expect(resp.content).toContain('"results"')
    expect(resp.ocrResult).toEqual({
      kind: 'document',
      text: 'invoice #1'
    })
  })

  it('routes OCR-capable qinglong providers through the same Tagger Provider V2 endpoint', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          content:
            '{"results":[{"fileName":"invoice.png","tags":[],"tagsText":"","caption":"Invoice #42","ocrResult":{"kind":"document","text":"Invoice #42","sourceImageUrl":"data:image/png;base64,UE5H"}}]}',
          ocrResult: {
            kind: 'document',
            text: 'Invoice #42',
            sourceImageUrl: 'data:image/png;base64,UE5H'
          },
          attachments: [
            {
              type: 'file',
              url: 'file:///C:/magicpot/invoice.md',
              fileName: 'invoice.md',
              mimeType: 'text/markdown'
            }
          ]
        })
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ocr-provider-profile',
            model_name: 'PaddleOCR VL',
            base_url: 'http://127.0.0.1:7860',
            api_key: '',
            provider: 'openai',
            deployment: 'local',
            model_use: 'ocr',
            tagger_provider: 'paddle_ocr',
            tagger_endpoint: 'http://127.0.0.1:7860/api',
            tagger_runtime_cache_scope: 'profile'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'ocr-provider-profile',
      messages: [
        {
          role: 'user',
          content: 'read this invoice',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,UE5H',
              fileName: 'invoice.png',
              mimeType: 'image/png'
            }
          ]
        }
      ],
      skillRuntime: {
        skillId: 'builtin-tagging',
        execution: {
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'structured',
          fallbackStrategy: 'smaller-batches',
          persistSessionUrl: false
        }
      }
    })

    const [requestUrl, requestInit] = fetchMock.mock.calls[0]
    expect(requestUrl).toBe('http://127.0.0.1:7860/api/tagger/v2/infer')
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      provider: {
        id: 'paddle_ocr',
        name: 'Paddle OCR',
        family: 'ocr'
      },
      profile: {
        id: 'ocr-provider-profile',
        modelName: 'PaddleOCR VL',
        taggerProvider: 'paddle_ocr'
      }
    })
    expect(resp.content).toContain('"ocrResult"')
    expect(resp.ocrResult).toEqual({
      kind: 'document',
      text: 'Invoice #42',
      sourceImageUrl: 'data:image/png;base64,UE5H'
    })
    expect(resp.attachments).toEqual([
      {
        type: 'file',
        url: 'file:///C:/magicpot/invoice.md',
        fileName: 'invoice.md',
        mimeType: 'text/markdown'
      }
    ])
  })

  it('includes tagger provider metadata in runtime profile listing', async () => {
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'tagger-profile',
            model_name: 'cella110n/cl_tagger',
            base_url: 'http://127.0.0.1:7861',
            api_key: '',
            provider: 'openai',
            deployment: 'local',
            tagger_provider: 'cl_tagger',
            tagger_runtime_cache_scope: 'endpoint'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})

    expect(profiles.profiles).toEqual([
      expect.objectContaining({
        id: 'tagger-profile',
        model_name: 'cella110n/cl_tagger',
        deployment: 'local',
        model_use: 'chat',
        is_vision_model: false,
        is_ocr_model: false,
        tagger_provider: 'cl_tagger',
        tagger_runtime_cache_scope: 'endpoint',
        tagger_runtime_key: expect.stringContaining('http://127.0.0.1:7861')
      })
    ])
  })

  it('reports only Agent API profiles in runtime profile listing and status', async () => {
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-profile',
            model_name: 'Quick Model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-key'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})
    const status = await svc.serverStatus({})

    expect(profiles.profiles).toEqual([
      {
        id: 'agent-profile',
        model_name: 'Agent Model',
        deployment: 'cloud',
        model_use: 'chat',
        is_vision_model: false,
        is_ocr_model: false
      }
    ])
    expect(status.availableProfiles).toBe(1)
  })

  it('keeps keyless Ollama profiles available to Agent runtime', async () => {
    const agentChat = vi.fn().mockResolvedValue('ollama response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ollama-profile',
            model_name: 'llama3.2',
            base_url: 'http://localhost:11434',
            api_key: '',
            is_ollama: true
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})
    const status = await svc.serverStatus({})
    const resp = await svc.chat({
      profileId: 'ollama-profile',
      messages: [{ role: 'user', content: 'hello ollama' }]
    })

    expect(profiles.profiles).toEqual([
      {
        id: 'ollama-profile',
        model_name: 'llama3.2',
        deployment: 'local',
        model_use: 'chat',
        is_vision_model: false,
        is_ocr_model: false
      }
    ])
    expect(status.availableProfiles).toBe(1)
    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ollama-profile',
        model_name: 'llama3.2',
        base_url: 'http://localhost:11434',
        api_key: '',
        is_ollama: true
      }),
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(resp.content).toBe('ollama response')
  })

  it('exposes multimodal profiles as vision-capable in the runtime profile list', async () => {
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'multimodal-profile',
            model_name: 'GPT-4o',
            base_url: 'https://example.com/v1',
            api_key: 'agent-key',
            model_use: 'multimodal'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})

    expect(profiles.profiles).toEqual([
      {
        id: 'multimodal-profile',
        model_name: 'GPT-4o',
        deployment: 'cloud',
        model_use: 'multimodal',
        is_vision_model: true,
        is_ocr_model: false
      }
    ])
  })

  it('exposes general-agent profiles as vision-capable in the runtime profile list', async () => {
    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'gpt-5.4',
            base_url: 'https://api.openai.com/v1',
            api_key: 'agent-key',
            model_use: 'agent'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})

    expect(profiles.profiles).toEqual([
      {
        id: 'agent-profile',
        model_name: 'gpt-5.4',
        deployment: 'cloud',
        model_use: 'agent',
        is_vision_model: true,
        is_ocr_model: false
      }
    ])
  })

  it('accepts explicit Ollama providers on generic Agent gateways without API keys', async () => {
    const agentChat = vi.fn().mockResolvedValue('ollama response')
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ollama-profile',
            model_name: 'llama3.2',
            base_url: 'https://gateway.example/llm',
            api_key: '',
            provider: 'ollama'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const profiles = await svc.listProfiles({})
    const status = await svc.serverStatus({})
    const resp = await svc.chat({
      profileId: 'ollama-profile',
      messages: [{ role: 'user', content: 'hello ollama' }]
    })

    expect(profiles.profiles).toEqual([
      {
        id: 'ollama-profile',
        model_name: 'llama3.2',
        deployment: 'cloud',
        model_use: 'chat',
        is_vision_model: false,
        is_ocr_model: false
      }
    ])
    expect(status.availableProfiles).toBe(1)
    expect(cliFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ollama-profile',
        model_name: 'llama3.2',
        base_url: 'https://gateway.example/llm',
        api_key: '',
        provider: 'ollama'
      }),
      expect.objectContaining({
        fetchImpl: expect.any(Function)
      })
    )
    expect(resp.content).toBe('ollama response')
  })

  it('parses structured OCR responses returned as JSON strings', async () => {
    const agentChat = vi.fn().mockResolvedValue(
      JSON.stringify({
        content: 'OCR completed',
        attachments: [
          {
            type: 'file',
            url: 'file:///C:/magicpot/result.xlsx',
            fileName: 'result.xlsx'
          }
        ],
        ocrResult: {
          kind: 'table',
          text: 'A1'
        }
      })
    )
    vi.mocked(cliFromProfile).mockReturnValue({ chat: agentChat } as never)

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'ocr-profile',
            model_name: 'OCR Model',
            base_url: 'http://127.0.0.1:8000/v1',
            api_key: '',
            provider: 'openai',
            deployment: 'local',
            model_use: 'ocr'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'ocr-profile',
      messages: [{ role: 'user', content: 'read this image' }]
    })

    expect(resp).toEqual({
      content: 'OCR completed',
      attachments: [
        {
          type: 'file',
          url: 'file:///C:/magicpot/result.xlsx',
          fileName: 'result.xlsx'
        }
      ],
      ocrResult: {
        kind: 'table',
        text: 'A1'
      }
    })
  })

  it('routes BigModel OCR profiles through layout_parsing and returns OCR output', async () => {
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        model: 'GLM-OCR',
        md_results: '# OCR Result\nhello world',
        layout_visualization: ['https://cdn.example.com/layout.png'],
        layout_details: [[{ label: 'text', bbox_2d: [0.1, 0.2, 0.5, 0.4] }]],
        data_info: {
          pages: [{ width: 1000, height: 500 }]
        }
      }),
      text: async () => ''
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'glm-ocr-profile',
      messages: [
        {
          role: 'user',
          content: 'read this image',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,UE5H',
              fileName: 'page.png',
              mimeType: 'image/png'
            }
          ]
        }
      ]
    })

    expect(cliFromProfile).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]
    expect(requestUrl).toBe('https://open.bigmodel.cn/api/paas/v4/layout_parsing')
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer glm-key',
        'Content-Type': 'application/json'
      }
    })
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: 'glm-ocr',
      file: 'UE5H'
    })
    expect(resp).toEqual({
      content: '# OCR Result\nhello world',
      attachments: [
        {
          type: 'image',
          url: 'https://cdn.example.com/layout.png',
          fileName: 'glm-ocr-layout-1.png',
          mimeType: 'image/png'
        }
      ],
      ocrResult: {
        kind: 'document',
        text: '# OCR Result\nhello world',
        sourceImageUrl: 'data:image/png;base64,UE5H',
        boxes: [
          {
            x: 100,
            y: 100,
            width: 400,
            height: 100,
            page: 1,
            label: 'text'
          }
        ]
      }
    })
  })

  it('prefers source attachments over the canvas snapshot for BigModel OCR', async () => {
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        model: 'GLM-OCR',
        md_results: 'source result'
      }),
      text: async () => ''
    })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'glm-ocr-profile',
      messages: [
        {
          role: 'user',
          content: 'read this image',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,U09VUkNF',
              fileName: 'asset.png',
              mimeType: 'image/png'
            },
            {
              type: 'image',
              url: 'data:image/png;base64,U05BUFNIT1Q=',
              fileName: 'canvas-target-selection.png',
              mimeType: 'image/png'
            }
          ]
        }
      ]
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, requestInit] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: 'glm-ocr',
      file: 'U09VUkNF'
    })
    expect(resp.content).toBe('source result')
    expect(resp.ocrResult?.sourceImageUrl).toBe('data:image/png;base64,U09VUkNF')
  })

  it('falls back to the canvas snapshot only when all source attachments fail for BigModel OCR', async () => {
    vi.stubGlobal('fetch', fetchMock)

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => '{"error":{"code":"1214","message":"OCR仅支持PDF、JPG、PNG、JPEG格式"}}'
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          model: 'GLM-OCR',
          md_results: 'snapshot result'
        }),
        text: async () => ''
      })

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'glm-ocr-profile',
      messages: [
        {
          role: 'user',
          content: 'read this image',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,U09VUkNF',
              fileName: 'asset.png',
              mimeType: 'image/png'
            },
            {
              type: 'image',
              url: 'data:image/png;base64,U05BUFNIT1Q=',
              fileName: 'canvas-target-selection.png',
              mimeType: 'image/png'
            }
          ]
        }
      ]
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, secondInit] = fetchMock.mock.calls[1]
    expect(JSON.parse(String(secondInit?.body))).toEqual({
      model: 'glm-ocr',
      file: 'U05BUFNIT1Q='
    })
    expect(resp.content).toBe('snapshot result')
    expect(resp.ocrResult?.sourceImageUrl).toBe('data:image/png;base64,U05BUFNIT1Q=')
  })

  it.each([
    ['file URL', 'file:///C:/magicpot/invoice.png'],
    ['local-media URL', 'local-media:///C:/magicpot/invoice.png'],
    ['absolute local path', 'C:/magicpot/invoice.png']
  ])('rejects %s attachments on BigModel OCR without reading local disk', async (_label, url) => {
    vi.stubGlobal('fetch', fetchMock)
    const readFileSpy = vi.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('should-not-read'))

    mockConfig({
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'glm-ocr-profile',
            model_name: 'GLM-OCR',
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key: 'glm-key',
            provider: 'openai'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'glm-ocr-profile',
        messages: [
          {
            role: 'user',
            content: 'read this image',
            attachments: [
              {
                type: 'image',
                url,
                fileName: 'invoice.png',
                mimeType: 'image/png'
              }
            ]
          }
        ]
      })
    ).rejects.toThrow('local file attachments')

    expect(readFileSpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes the configured Tencent region into Hunyuan3D requests', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: 'ap-shanghai',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
      messages: [{ role: 'user', content: '一个简约风格的白色马克杯' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      '',
      '',
      'secret-id',
      'secret-key',
      'ap-shanghai'
    )
    expect(generateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: '一个简约风格的白色马克杯' }],
      'SubmitHunyuanTo3DRapidJob',
      expect.objectContaining({
        EnablePBR: false,
        FaceLevel: 'low',
        PolygonType: 'triangle',
        ProfileTemplate: 'DEFAULT'
      })
    )
    expect(resp.content).toBe('[Generated 3D Model](https://example.com/cup.glb)')
  })

  it('trims configured Tencent credentials before constructing the Hunyuan3D client', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '  secret-id  ',
        tencent_secret_key: '\nsecret-key\t',
        api_region: 'ap-shanghai',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
      messages: [{ role: 'user', content: 'trim secrets before use' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      '',
      '',
      'secret-id',
      'secret-key',
      'ap-shanghai'
    )
  })

  it('passes the encoded model source file name hint into Hunyuan3D post-process requests', async () => {
    generateFromMessagesMock.mockResolvedValue(
      '[Generated OBJ Package.zip](https://example.com/cup.zip)'
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: 'ap-shanghai',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId:
        'hunyuan3d-pro::SubmitTextureTo3DJob::3.1::Normal::500000::DEFAULT::triangle::triangle::0::DEFAULT::Generated%20OBJ%20Package.zip',
      messages: [
        { role: 'user', content: 'https://example.com/download?id=obj-1\nadd bronze texture' }
      ]
    })

    expect(generateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: 'https://example.com/download?id=obj-1\nadd bronze texture' }],
      'SubmitTextureTo3DJob',
      expect.objectContaining({
        SourceFileName: 'Generated OBJ Package.zip'
      })
    )
  })

  it('uses ap-guangzhou when neither Tencent API region nor COS region is configured', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: '',
        cos_region: ''
      }
    })

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
      messages: [{ role: 'user', content: 'missing region' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      '',
      '',
      'secret-id',
      'secret-key',
      'ap-guangzhou'
    )
  })

  it('does not reuse the COS region when a dedicated Tencent API region is not configured', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: '',
        cos_region: 'ap-singapore'
      }
    })

    const svc = new LLMProxySvcImpl()
    await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
      messages: [{ role: 'user', content: 'default api region' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      '',
      '',
      'secret-id',
      'secret-key',
      'ap-guangzhou'
    )
  })

  it('allows the Pro REST path to run with a Hunyuan API profile even when Tencent secrets are absent', async () => {
    generateFromMessagesMock.mockResolvedValue('[Generated 3D Model](https://example.com/cup.glb)')

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://proxy.example',
            api_key: 'hy-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob',
      messages: [{ role: 'user', content: 'api token pro path' }]
    })

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      'hy-token',
      'https://proxy.example',
      '',
      '',
      'ap-guangzhou'
    )
    expect(generateFromMessagesMock).toHaveBeenCalledWith(
      [{ role: 'user', content: 'api token pro path' }],
      'SubmitHunyuanTo3DProJob',
      expect.any(Object)
    )
    expect(resp.content).toBe('[Generated 3D Model](https://example.com/cup.glb)')
  })

  it('verifies the Pro API-key submit and poll flow end-to-end through the service layer', async () => {
    useActualHunyuan3DClient.current = true
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          Response: {
            JobId: 'job-pro-1'
          }
        }),
        text: async () => ''
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          Response: {
            Status: 'DONE',
            ResultFile3Ds: [
              {
                Type: 'GLB',
                Url: 'https://example.com/download?id=mesh-1'
              }
            ]
          }
        }),
        text: async () => ''
      })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://proxy.example/v1',
            api_key: 'hy-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resultPromise = svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob',
      messages: [{ role: 'user', content: 'a bronze dragon statue' }]
    })
    const expectation = expect(resultPromise).resolves.toEqual({
      content: '[Generated 3D Model](https://example.com/download?id=mesh-1)'
    })

    await vi.advanceTimersByTimeAsync(5000)
    await expectation

    expect(Hunyuan3DClientMock).toHaveBeenCalledWith(
      'hy-token',
      'https://proxy.example/v1',
      '',
      '',
      'ap-guangzhou'
    )

    const [submitUrl, submitInit] = fetchMock.mock.calls[0]
    expect(submitUrl).toBe('https://proxy.example/v1/ai3d/submit')
    expect(submitInit).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer hy-token',
        'Content-Type': 'application/json'
      }
    })
    expect(JSON.parse(String(submitInit?.body))).toMatchObject({
      Prompt: 'a bronze dragon statue',
      GenerateType: 'Normal',
      EnablePBR: false
    })

    const [queryUrl, queryInit] = fetchMock.mock.calls[1]
    expect(queryUrl).toBe('https://proxy.example/v1/ai3d/query')
    expect(JSON.parse(String(queryInit?.body))).toEqual({ JobId: 'job-pro-1' })
  })

  it('preserves Tencent RequestId when the Pro API-key poll path fails through the service layer', async () => {
    useActualHunyuan3DClient.current = true
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          Response: {
            JobId: 'job-pro-fail-1'
          }
        }),
        text: async () => ''
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          Response: {
            Status: 'FAIL',
            ErrorCode: 'InvalidParameter',
            ErrorMessage: 'bad prompt',
            RequestId: 'req-pro-fail-1'
          }
        }),
        text: async () => ''
      })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: '',
        api_region: '',
        cos_region: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://proxy.example/v1',
            api_key: 'hy-token'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    const resultPromise = svc.chat({
      profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DProJob',
      messages: [{ role: 'user', content: 'bad request' }]
    })
    const expectation = expect(resultPromise).rejects.toThrow('RequestId=req-pro-fail-1')

    await vi.advanceTimersByTimeAsync(5000)
    await expectation
  })

  it('clears the configured Hunyuan3D COS prefix', async () => {
    clearHy3dCosPrefixMock.mockResolvedValue({
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      keyPrefix: 'magicpot/hunyuan3d',
      matchedCount: 3,
      deletedCount: 3,
      errorCount: 0
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.clearHy3DCosPrefix({})

    expect(clearHy3dCosPrefixMock).toHaveBeenCalledWith(
      { secretId: 'secret-id', secretKey: 'secret-key' },
      {
        bucket: 'magicpot-1314265479',
        region: 'ap-guangzhou',
        keyPrefix: 'magicpot/hunyuan3d'
      }
    )
    expect(resp).toEqual({
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      keyPrefix: 'magicpot/hunyuan3d',
      matchedCount: 3,
      deletedCount: 3,
      errorCount: 0
    })
  })

  it('clears the selected Hunyuan3D quick app profile COS prefix', async () => {
    clearHy3dCosPrefixMock.mockResolvedValue({
      bucket: 'profile-bucket-1250000000',
      region: 'ap-shanghai',
      keyPrefix: 'profiles/hy3d',
      matchedCount: 1,
      deletedCount: 1,
      errorCount: 0
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'legacy-secret-id',
        tencent_secret_key: 'legacy-secret-key',
        cos_bucket: 'legacy-bucket-1250000000',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'legacy/hy3d'
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://api.ai3d.cloud.tencent.com',
            api_key: '',
            tencent_secret_id: 'profile-secret-id',
            tencent_secret_key: 'profile-secret-key',
            cos_bucket: 'profile-bucket-1250000000',
            cos_region: 'ap-shanghai',
            cos_key_prefix: 'profiles/hy3d'
          }
        ]
      }
    })

    const svc = new LLMProxySvcImpl()
    await svc.clearHy3DCosPrefix({ profileId: 'plugin-hunyuan' })

    expect(clearHy3dCosPrefixMock).toHaveBeenCalledWith(
      { secretId: 'profile-secret-id', secretKey: 'profile-secret-key' },
      {
        bucket: 'profile-bucket-1250000000',
        region: 'ap-shanghai',
        keyPrefix: 'profiles/hy3d'
      }
    )
  })

  it('uploads a local model file via uploadHy3DModel', async () => {
    uploadLocalHy3dModelMock.mockResolvedValue({
      url: 'https://cos.example/signed-url',
      key: 'magicpot/hunyuan3d/2026/04/04/model.glb',
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      fileName: 'model.glb',
      expiresAt: '2026-04-05T00:00:00Z'
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.uploadHy3DModel({ filePath: 'C:/models/model.glb' })

    expect(uploadLocalHy3dModelMock).toHaveBeenCalledWith(
      { secretId: 'secret-id', secretKey: 'secret-key' },
      { bucket: 'magicpot-1314265479', region: 'ap-guangzhou', keyPrefix: 'magicpot/hunyuan3d' },
      'C:/models/model.glb'
    )
    expect(resp.key).toBe('magicpot/hunyuan3d/2026/04/04/model.glb')
    expect(resp.fileName).toBe('model.glb')
  })

  it('uploads a buffered model via uploadHy3DModel', async () => {
    uploadBufferedHy3dModelMock.mockResolvedValue({
      url: 'https://cos.example/signed-url',
      key: 'magicpot/hunyuan3d/2026/04/04/cube.obj',
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      fileName: 'cube.obj',
      expiresAt: '2026-04-05T00:00:00Z'
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const base64Data = Buffer.from('cube-data').toString('base64')
    const svc = new LLMProxySvcImpl()
    const resp = await svc.uploadHy3DModel({ fileName: 'cube.obj', fileDataBase64: base64Data })

    expect(uploadBufferedHy3dModelMock).toHaveBeenCalledWith(
      { secretId: 'secret-id', secretKey: 'secret-key' },
      { bucket: 'magicpot-1314265479', region: 'ap-guangzhou', keyPrefix: 'magicpot/hunyuan3d' },
      'cube.obj',
      expect.any(Buffer)
    )
    expect(resp.fileName).toBe('cube.obj')
  })

  it('signs an existing COS model key via signHy3DModel', async () => {
    signHy3dCosModelMock.mockReturnValue({
      url: 'https://cos.example/signed-url?sign=abc',
      expiresAt: '2026-04-05T00:00:00Z'
    })

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    const resp = await svc.signHy3DModel({
      key: 'magicpot/hunyuan3d/model.glb',
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou'
    })

    expect(signHy3dCosModelMock).toHaveBeenCalledWith(
      { secretId: 'secret-id', secretKey: 'secret-key' },
      {
        bucket: 'magicpot-1314265479',
        region: 'ap-guangzhou',
        keyPrefix: 'magicpot/hunyuan3d'
      },
      'magicpot/hunyuan3d/model.glb'
    )
    expect(resp.url).toContain('signed-url')
  })

  it('refuses to sign a COS model outside the configured bucket or region', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const svc = new LLMProxySvcImpl()

    await expect(
      svc.signHy3DModel({
        key: 'magicpot/hunyuan3d/model.glb',
        bucket: 'other-bucket',
        region: 'ap-guangzhou'
      })
    ).rejects.toThrow('outside the configured bucket and region')

    await expect(
      svc.signHy3DModel({
        key: 'magicpot/hunyuan3d/model.glb',
        bucket: 'magicpot-1314265479',
        region: 'ap-shanghai'
      })
    ).rejects.toThrow('outside the configured bucket and region')

    expect(signHy3dCosModelMock).not.toHaveBeenCalled()
  })

  it('throws a field-specific error when only SecretId is missing', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(svc.clearHy3DCosPrefix({})).rejects.toThrow('SecretId')
    await expect(svc.clearHy3DCosPrefix({})).rejects.not.toThrow('SecretKey')
  })

  it('throws a field-specific error when only COS Bucket is missing', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: '',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(svc.clearHy3DCosPrefix({})).rejects.toThrow('COS Bucket')
    await expect(svc.clearHy3DCosPrefix({})).rejects.not.toThrow('COS Region')
  })

  it('surfaces a clearer message when COS rejects the configured SecretId', async () => {
    clearHy3dCosPrefixMock.mockRejectedValue(
      new Error(
        'InvalidAccessKeyId: The Access Key Id you provided does not exist in our records. requestId:req-cos-123 traceId:trace-cos-456'
      )
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou',
        cos_key_prefix: 'magicpot/hunyuan3d'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(svc.clearHy3DCosPrefix({})).rejects.toThrow(
      'The configured Tencent Cloud SecretId is invalid or has expired'
    )
  })

  it('throws when Hunyuan3D chat is attempted without Tencent credentials', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: '',
        tencent_secret_key: ''
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
        messages: [{ role: 'user', content: 'test' }]
      })
    ).rejects.toThrow('SecretId')
  })

  it('surfaces a clearer message when Tencent rejects the configured SecretId', async () => {
    generateFromMessagesMock.mockRejectedValue(
      new Error(
        'The SecretId is not found, please ensure that your SecretId is correct. requestId:req-123 traceId:trace-456'
      )
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: 'ap-guangzhou',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob',
        messages: [{ role: 'user', content: 'test' }]
      })
    ).rejects.toThrow('The configured Tencent Cloud SecretId is invalid or has expired')
  })

  it('preserves Hunyuan3D client errors that are already normalized', async () => {
    generateFromMessagesMock.mockRejectedValue(
      new Error(
        '[Hunyuan3D] UV 展开提交在 5 次尝试后仍失败，请稍后重试。当前输入是 GLB；如果持续失败，可先用“格式转换”输出 FBX，再重新执行 UV 展开。 requestId:req-uv-123 traceId:trace-uv-456'
      )
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: 'ap-guangzhou',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(
      svc.chat({
        profileId: 'hunyuan3d-pro::SubmitHunyuanTo3DUVJob',
        messages: [{ role: 'user', content: 'https://example.com/models/robot.glb' }]
      })
    ).rejects.toThrow('UV 展开提交在 5 次尝试后仍失败')
  })

  it('rewrites generic Hunyuan3D internal job failures into actionable UV guidance', async () => {
    generateFromMessagesMock.mockRejectedValue(
      new Error(
        '[Hunyuan3D] Job failed: FailedOperation.InnerError 服务内部错误，请重试。 RequestId=req-uv-inner-123'
      )
    )

    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        api_region: 'ap-guangzhou',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    const error = await svc
      .chat({
        profileId:
          'hunyuan3d-pro::SubmitHunyuanTo3DUVJob::3.1::Normal::500000::DEFAULT::quadrilateral::quadrilateral::0::DEFAULT::robot.glb',
        messages: [{ role: 'user', content: 'https://example.com/models/robot.glb' }]
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(
      'Tencent 3D service is temporarily unavailable and the job failed'
    )
    expect((error as Error).message).toContain('Current input is GLB')
    expect((error as Error).message).toContain('requestId:req-uv-inner-123')
  })

  it('throws when uploadHy3DModel is called without file path or buffer', async () => {
    mockConfig({
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'magicpot-1314265479',
        cos_region: 'ap-guangzhou'
      }
    })

    const svc = new LLMProxySvcImpl()
    await expect(svc.uploadHy3DModel({})).rejects.toThrow(
      '[Hunyuan3D] Missing model file to upload.'
    )
  })
})
