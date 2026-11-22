import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
const mocks = vi.hoisted(() => ({
  config: { current: undefined as Config | undefined },
  globalCall: vi.fn(), globalList: vi.fn(), fetch: vi.fn()
}))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
vi.mock('../config/config', () => ({ getConfig: () => mocks.config.current!, saveConfig: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: mocks.globalList, callTool: mocks.globalCall }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined), getMcpClientManager: () => ({ listToolsSnapshot: () => [] }) }))
vi.mock('electron', () => ({ net: {}, app: { isPackaged: false, getPath: () => process.cwd() }, BrowserWindow: { fromWebContents: () => undefined }, webContents: { fromId: () => undefined } }))
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const request = (): LLMChatReq => ({
  profileId: 'bounded-real-chat', route: { channel: 'generic', scopeType: 'dm', scopeId: 'executor-helper' },
  messages: [{ role: 'user', content: '/tool fixture.effect {"x":1}' }],
  skillRuntime: { bindings: [{ appId: 'assistant-runtime', source: 'assistant-runtime', toolNames: ['fixture.effect'] }] }
})
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', mocks.fetch)
  const config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.llm_config.api_profiles = [{ id: 'bounded-real-chat', model_name: 'fixture-model', base_url: 'http://127.0.0.1:1/v1', api_key: '', provider: 'openai', call_type: 'api', deployment: 'local', model_use: 'agent', api_mode: 'chat-completions' }]
  mocks.config.current = config
  mocks.globalList.mockReturnValue([{ name: 'fixture.effect', description: 'unmanaged global fixture', inputSchema: { type: 'object' } }])
  mocks.globalCall.mockResolvedValue({ content: 'unmanaged global receipt' })
  mocks.fetch.mockRejectedValue(Error('Unexpected provider dispatch during helper contract'))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real service explicit helper respects an injected executor (not managed authority by itself)', () => {
  it('routes explicit /tool through the exact callback, never global runtime', async () => {
    const signal = new AbortController().signal
    const executeTool = vi.fn(async () => ({ content: 'callback-owned receipt' }))
    const reply = await new LLMProxySvcImpl().chat(request(), { signal, runId: 'runtime-owned-run', executeTool })
    expect(executeTool).toHaveBeenCalledOnce()
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'fixture.effect', args: { x: 1 }, runId: 'runtime-owned-run', toolCallId: 'runtime-owned-run:tool:0', signal: expect.any(AbortSignal) }))
    expect(reply.content).toBe('callback-owned receipt')
    expect(mocks.globalCall).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('propagates callback failure instead of falling back to a global tool', async () => {
    const failure = Object.assign(Error('Recorded outcome requires review'), { code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' })
    const executeTool = vi.fn(async () => { throw failure })
    await expect(new LLMProxySvcImpl().chat(request(), { runId: 'runtime-owned-run', executeTool })).rejects.toBe(failure)
    expect(executeTool).toHaveBeenCalledOnce(); expect(mocks.globalCall).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
