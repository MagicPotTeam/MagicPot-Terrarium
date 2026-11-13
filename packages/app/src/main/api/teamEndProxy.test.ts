import { describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ assertActive: vi.fn(), end: vi.fn(() => ({ ended: true as const })), listTools: vi.fn(), callTool: vi.fn() }))
vi.mock('electron', () => ({ net: {} }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => { throw new Error('Unexpected production path') } }))
vi.mock('./teamEndStore', () => ({ getTeamEndStore: () => h, assertTeamRequestActive: (req: { teamMember?: unknown }) => { if (Object.hasOwn(req, 'teamMember')) h.assertActive(req.teamMember) } }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools, callTool: h.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

describe('proxy member End entry gate, model never invoked', () => {
  it('checks chat and streaming before any provider setup; ordinary chat does not invoke gate', async () => {
    const service = new LLMProxySvcImpl(), tuple = { scope: 's', thread: 't', lead: 'l', member: 'm' }
    h.assertActive.mockImplementation(() => { throw new Error('Team has ended.') })
    await expect(service.chat({ messages: [], teamMember: tuple })).rejects.toThrow('ended')
    await expect(service.chatStream({ messages: [], teamMember: tuple }, {} as never)).rejects.toThrow('ended')
    expect(h.assertActive).toHaveBeenCalledTimes(2)
    await expect(service.chat({ messages: [], teamMember: undefined })).rejects.toThrow('ended')
    expect(h.assertActive).toHaveBeenCalledTimes(3)
    expect(await service.endTeam({ scope: 's', thread: 't', lead: 'l' })).toEqual({ ended: true })
  })
})

describe('model step after End (inert model)', () => {
  const tuple = { scope: 's', thread: 't', lead: 'l', member: 'm' }
  const request = { profileId: 'profile', messages: [{ role: 'user' as const, content: 'test' }], teamMember: tuple, skillRuntime: { bindings: [{ appId: 'test', toolNames: ['web_search'] }] } }
  function configure() {
    h.assertActive.mockReset(); h.listTools.mockReset(); h.callTool.mockReset()
    const config = structuredClone(DEFAULT_CONFIG)
    config.llm_config.api_profiles = [{ id: 'profile', model_name: 'model', base_url: 'https://example.invalid/v1', api_key: 'unused' }]
    vi.mocked(getConfig).mockReturnValue(config)
    h.listTools.mockReturnValue([{ name: 'web_search', description: 'stub', inputSchema: { type: 'object', properties: {} } }])
  }
  it('continues native fallback and final result after End without a second entry admission', async () => {
    configure()
    let finish!: () => void, started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const pending = new Promise<void>(resolve => { finish = resolve })
    const chat = vi.fn().mockImplementationOnce(async () => { started(); await pending; throw Object.assign(Error('tools not supported'), { statusCode: 400 }) }).mockResolvedValueOnce('fallback result')
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const service = new LLMProxySvcImpl(), result = service.chat(request)
    await entered
    h.assertActive.mockImplementation(() => { throw Error('Team has ended.') })
    finish()
    await expect(result).resolves.toMatchObject({ content: 'fallback result' })
    expect(chat).toHaveBeenCalledTimes(2)
    await expect(service.chat(request)).rejects.toThrow('Team has ended.')
    expect(chat).toHaveBeenCalledTimes(2)
  })
  it('runs a tool and its continuation after End for an already admitted request', async () => {
    configure()
    let finish!: () => void, started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const pending = new Promise<void>(resolve => { finish = resolve })
    h.callTool.mockResolvedValue({ content: 'stub tool output' })
    const chat = vi.fn().mockImplementationOnce(async () => {
      started(); await pending
      return { content: '', toolCalls: [{ id: 'call-1', name: 'web_search', wireName: 'mp_tool_0', arguments: '{}' }] }
    }).mockResolvedValueOnce('completed with tool output')
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const service = new LLMProxySvcImpl(), result = service.chat(request)
    await entered
    h.assertActive.mockImplementation(() => { throw Error('Team has ended.') })
    finish()
    const response = await result
    expect(response.content).toBe('completed with tool output')
    expect(h.callTool).toHaveBeenCalledOnce()
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[1][0].toolTurns).toEqual(expect.arrayContaining([expect.objectContaining({ results: [expect.objectContaining({ output: 'stub tool output' })] })]))
    expect(response.metadata?.toolHistory).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'web_search', status: 'completed', content: 'stub tool output' })]))
    await expect(service.chat(request)).rejects.toThrow('Team has ended.')
    expect(chat).toHaveBeenCalledTimes(2)
  })
  it('finishes an admitted stream after End and rejects new streams before another provider call', async () => {
    configure()
    const noNetwork = vi.fn(async () => { throw new Error('Unexpected network') })
    vi.stubGlobal('fetch', noNetwork)
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    const chat = vi.fn(async (input: { onDelta?: (event: { type: 'text-delta'; delta: string }) => void }) => {
      started()
      await pending
      input.onDelta?.({ type: 'text-delta', delta: 'finished response' })
      return 'finished response'
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: false } as never)
    const service = new LLMProxySvcImpl({ retryModelCapacity: false })
    const onData = vi.fn()
    const result = service.chatStream(request, { onData } as never)
    const outcome = result.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    const bounded = async <T,>(operation: Promise<T>, duration: number): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Fixture deadline exceeded')), duration) })])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    try {
      const admission = await bounded(Promise.race([
        entered.then(() => 'entered' as const),
        outcome.then(() => 'settled' as const)
      ]), 1500)
      expect(admission).toBe('entered')
      h.assertActive.mockImplementation(() => { throw Error('Team has ended.') })
      release()
      await expect(bounded(outcome, 1500)).resolves.toEqual({ ok: true })
      expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'text-delta', delta: 'finished response', done: false }))
      expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', done: true, fullContent: 'finished response', finishReason: 'stop' }))
      const afterEndData = vi.fn()
      await expect(bounded(service.chatStream(request, { onData: afterEndData } as never), 1500)).rejects.toThrow('Team has ended.')
      expect(afterEndData).not.toHaveBeenCalled()
      expect(chat).toHaveBeenCalledOnce()
      expect(noNetwork).not.toHaveBeenCalled()
    } finally {
      release()
      try { await bounded(outcome, 1500) } finally { vi.unstubAllGlobals() }
    }
  })
  it('returns an already running final answer after End', async () => {
    configure()
    let finish!: () => void, started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const pending = new Promise<void>(resolve => { finish = resolve })
    const chat = vi.fn(async (_input: unknown) => { started(); await pending; return 'finished response' })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = new LLMProxySvcImpl().chat(request)
    await entered
    h.assertActive.mockImplementation(() => { throw Error('Team has ended.') })
    finish()
    await expect(result).resolves.toMatchObject({ content: 'finished response' })
    expect(chat).toHaveBeenCalledTimes(1)
  })
})
