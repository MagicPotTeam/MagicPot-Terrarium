import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { getConfig } from '../config/config'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const h = vi.hoisted(() => ({ sender: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => '/memory-files-fixture' }, webContents: { fromId: h.sender }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: '/memory-files-fixture', root: '/fixture-root' } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools, callTool: h.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-files-project', threadId: 'parent-pane' } as const
const url = 'file:///D:/app/index.html#/canvas?id=memory-files-project'
const invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 163, isMainFrame: true, senderUrl: url, frameUrl: url })
let service: LLMProxySvcImpl, sender: EventEmitter
beforeEach(() => {
  vi.clearAllMocks()
  const config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'memory-profile', model_name: 'Fixture', base_url: 'https://model.example/v1', api_key: 'fixture-not-sent' }]
  vi.mocked(getConfig).mockReturnValue(config)
  sender = Object.assign(new EventEmitter(), { id: 163, isDestroyed: () => false, getURL: () => url })
  h.sender.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(163, route, { trustedUrl: url, trustedWebContents: sender as never })
  h.listTools.mockReturnValue([]); service = new LLMProxySvcImpl()
})
afterEach(async () => { await service.cancelConversation({ conversationId: 'current-memory', cancellationId: 'memory-call' }, invoke('cancelConversation')); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })

describe('memory-file helpers are separate real request-owned tools, not notes or read-only helper aliases', () => {
  it.each(['chat', 'chatStream'].flatMap(method => [false, true].map(native => ({ method, native }))))('exposes separate names through $method native=$native without starting a child on listing', async ({ method, native }) => {
    const chat = vi.fn(async input => {
      const prompt = String(input.systemPrompt)
      if (native) {
        const names = input.tools.map((tool: { name: string }) => tool.name)
        expect(names).toEqual(expect.arrayContaining(['memory_read', 'memory_write', 'explore', 'critic', 'fork', 'scratchpad', 'search_memory']))
        for (const name of ['memory_read', 'memory_write']) expect(input.tools.find((tool: { name: string }) => tool.name === name).inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['task'] })
      } else for (const name of ['memory_read', 'memory_write', 'explore', 'critic', 'fork', 'scratchpad', 'search_memory']) expect(prompt).toContain(`Tool: ${name}`)
      return 'Observed separate memory-helper contracts without executing a child.'
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
    const request = { route, conversationId: 'current-memory', cancellationId: 'memory-call', profileId: 'memory-profile', messages: [{ role: 'user' as const, content: 'What memory helper tools are available?' }] }
    const onData = vi.fn()
    if (method === 'chat') expect(await service.chat(request, invoke(method))).toMatchObject({ content: 'Observed separate memory-helper contracts without executing a child.' })
    else { await service.chatStream(request, { onData }, invoke(method)); expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'Observed separate memory-helper contracts without executing a child.' })) }
    expect(cliFromProfile).toHaveBeenCalledOnce(); expect(chat).toHaveBeenCalledOnce(); expect(h.callTool).not.toHaveBeenCalled()
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
})
