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
  // Contract changed with backlog item 7: an admitted member turn starts no new model step,
  // retry or tool call once its team has ended; what was already sent is not recalled.
  const gate = () => {
    let release!: () => void, started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    return { entered, pending, release, started }
  }
  const endTeam = () => h.assertActive.mockImplementation(() => { throw Error('Team has ended.') })
  const nativeCall = (id: string, args = '{}') => ({ id, name: 'web_search', wireName: 'mp_tool_0', arguments: args })
  it('sends no native fallback step when End is recorded while the first model call is in flight', async () => {
    configure()
    const step = gate()
    const chat = vi.fn().mockImplementationOnce(async () => { step.started(); await step.pending; throw Object.assign(Error('tools not supported'), { statusCode: 400 }) }).mockResolvedValueOnce('fallback result')
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const service = new LLMProxySvcImpl(), result = service.chat(request)
    await step.entered
    endTeam()
    step.release()
    await expect(result).rejects.toThrow('Team has ended.')
    expect(chat).toHaveBeenCalledTimes(1)
    await expect(service.chat(request)).rejects.toThrow('Team has ended.')
    expect(chat).toHaveBeenCalledTimes(1)
  })
  it('starts no requested tool when End is recorded while the model call that asked for it is in flight', async () => {
    configure()
    const step = gate()
    h.callTool.mockResolvedValue({ content: 'stub tool output' })
    const chat = vi.fn().mockImplementationOnce(async () => {
      step.started(); await step.pending
      return { content: '', toolCalls: [nativeCall('call-1')] }
    }).mockResolvedValueOnce('completed with tool output')
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const service = new LLMProxySvcImpl(), result = service.chat(request)
    await step.entered
    endTeam()
    step.release()
    const error = await result.catch((e: unknown) => e) as Error & { metadata?: { toolHistory?: unknown[] } }
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Team has ended.')
    expect(error.metadata?.toolHistory).toEqual([])
    expect(h.callTool).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledTimes(1)
    await expect(service.chat(request)).rejects.toThrow('Team has ended.')
    expect(chat).toHaveBeenCalledTimes(1)
  })
  it('keeps a finished call of a native batch and starts none of the rest after End', async () => {
    configure()
    const tool = gate()
    h.callTool.mockImplementationOnce(async () => { tool.started(); await tool.pending; return { content: 'first output' } })
      .mockResolvedValueOnce({ content: 'second output' })
    const chat = vi.fn().mockResolvedValueOnce({ content: '', toolCalls: [nativeCall('call-1'), nativeCall('call-2')] })
      .mockResolvedValueOnce('answer after both tools')
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = new LLMProxySvcImpl().chat(request)
    await tool.entered
    endTeam()
    tool.release()
    const error = await result.catch((e: unknown) => e) as Error & { metadata?: { toolHistory?: Array<Record<string, unknown>> } }
    expect(error.message).toBe('Team has ended.')
    expect(h.callTool).toHaveBeenCalledOnce()
    expect(chat).toHaveBeenCalledOnce()
    expect(error.metadata?.toolHistory).toHaveLength(1)
    expect(error.metadata?.toolHistory?.[0]).toMatchObject({ toolName: 'web_search', status: 'completed', content: 'first output' })
    expect(error.metadata?.toolHistory?.[0]).not.toHaveProperty('error')
  })
  it('returns the answer of a model step that was in flight after a completed tool round', async () => {
    configure()
    const step = gate()
    h.callTool.mockResolvedValue({ content: 'stub tool output' })
    const chat = vi.fn().mockResolvedValueOnce({ content: '', toolCalls: [nativeCall('call-1')] })
      .mockImplementationOnce(async () => { step.started(); await step.pending; return 'answer after the tool' })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = new LLMProxySvcImpl().chat(request)
    await step.entered
    endTeam()
    step.release()
    const response = await result
    expect(response.content).toBe('answer after the tool')
    expect(response.metadata?.toolHistory).toEqual([expect.objectContaining({ toolName: 'web_search', status: 'completed', content: 'stub tool output' })])
    expect(chat).toHaveBeenCalledTimes(2)
    expect(h.callTool).toHaveBeenCalledOnce()
  })
  it('refuses a capacity retry notice after End and forwards it unchanged while the team is active', async () => {
    configure()
    const notice = { type: 'retry' as const, retry: { attempt: 1, delayMs: 2000, nextRetryAt: 1_000, reason: 'rate-limited' as const } }
    const step = gate()
    let noticeError: unknown
    const chat = vi.fn(async (params: { retryCapacity?: boolean; onDelta?: (event: typeof notice) => void }) => {
      step.started(); await step.pending
      try { params.onDelta?.(notice) } catch (error) { noticeError = error; throw error }
      return 'answer after a retry'
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const ended = new LLMProxySvcImpl().chat(request)
    await step.entered
    endTeam()
    step.release()
    await expect(ended).rejects.toThrow('Team has ended.')
    expect(noticeError).toBeInstanceOf(Error)
    expect((noticeError as Error).message).toBe('Team has ended.')
    expect(chat.mock.calls[0][0].retryCapacity).toBe(true)
    expect(chat).toHaveBeenCalledOnce()
    // Active team: the same notice reaches the stream unchanged and the turn completes.
    configure()
    chat.mockClear(); noticeError = undefined
    const onData = vi.fn()
    await new LLMProxySvcImpl().chatStream(request, { onData } as never)
    expect(noticeError).toBeUndefined()
    expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'retry', retry: notice.retry }))
    expect(onData).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'done', finishReason: 'stop', fullContent: 'answer after a retry' }))
    expect(h.assertActive).toHaveBeenCalledTimes(3) // entry, model step, retry notice
  })
  it('sends no second provider attempt of a rate-limited step after End', async () => {
    configure()
    const step = gate()
    const { retryModelCapacity } = await import('@shared/llm/modelCapacityRetry')
    const attempt = vi.fn().mockImplementationOnce(async () => { step.started(); await step.pending; throw Object.assign(Error('rate limited'), { statusCode: 429 }) })
      .mockResolvedValueOnce('answer of a second attempt')
    const chat = vi.fn((params: { onDelta?: () => void; signal?: AbortSignal }) => retryModelCapacity(params as never, attempt))
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = new LLMProxySvcImpl().chat(request)
    await step.entered
    endTeam()
    step.release()
    await expect(result).rejects.toThrow('Team has ended.')
    expect(attempt).toHaveBeenCalledOnce()
    expect(chat).toHaveBeenCalledOnce()
  })
  it('ends a stream with the End error and its streamed text, without starting the tool', async () => {
    configure()
    const step = gate()
    h.callTool.mockResolvedValue({ content: 'stub tool output' })
    const chat = vi.fn(async (params: { onDelta?: (event: { type: 'text-delta'; delta: string }) => void }) => {
      params.onDelta?.({ type: 'text-delta', delta: 'Looking this up. ' })
      step.started(); await step.pending
      return { content: 'Looking this up. ', toolCalls: [nativeCall('call-1')] }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const onData = vi.fn()
    const result = new LLMProxySvcImpl().chatStream(request, { onData } as never)
    await step.entered
    endTeam()
    step.release()
    await result
    const frames = onData.mock.calls.map(([frame]) => frame as Record<string, unknown>)
    expect(frames.map(frame => frame.type)).toEqual(['text-delta', 'error', 'done'])
    expect(frames[1]).toMatchObject({ error: 'Team has ended.', fullContent: 'Looking this up. ', finishReason: 'error' })
    expect(frames[2]).toMatchObject({ error: 'Team has ended.', fullContent: 'Looking this up. ', finishReason: 'error' })
    expect(frames.filter(frame => frame.type === 'done' && frame.finishReason !== 'error')).toEqual([])
    expect(h.callTool).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledOnce()
  })
  it('runs no explicit /tool command when End is recorded after the entry check', async () => {
    configure()
    h.callTool.mockResolvedValue({ content: 'stub tool output' })
    const chat = vi.fn()
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const command = { ...request, messages: [{ role: 'user' as const, content: '/tool web_search {}' }] }
    h.assertActive.mockImplementationOnce(() => undefined)
    endTeam()
    await expect(new LLMProxySvcImpl().chat(command)).rejects.toThrow('Team has ended.')
    expect(h.callTool).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
    // The /tools listing starts nothing and stays available to an admitted request.
    h.assertActive.mockReset().mockImplementationOnce(() => undefined)
    endTeam()
    const listing = await new LLMProxySvcImpl().chat({ ...request, messages: [{ role: 'user' as const, content: '/tools' }] })
    expect(listing.content).toContain('web_search')
    expect(h.callTool).not.toHaveBeenCalled()
  })
  it('stops only the member of the ended team when two teams run at the same time', async () => {
    configure()
    const teamA = { ...tuple, thread: 'team-a' }, teamB = { ...tuple, thread: 'team-b' }
    const ended = new Set<string>()
    h.assertActive.mockImplementation((member: { thread: string }) => { if (ended.has(member.thread)) throw Error('Team has ended.') })
    h.callTool.mockImplementation(async (_route: unknown, _name: string, args: { team: string }) => ({ content: 'output ' + args.team }))
    const first = gate()
    let inFlight = 0
    const chat = vi.fn(async (params: { messages: Array<{ content: unknown }>; toolTurns?: unknown[] }) => {
      const team = String(params.messages[0].content)
      if (params.toolTurns?.length) return 'answer ' + team
      if (++inFlight === 2) first.started()
      await first.pending
      return { content: '', toolCalls: [nativeCall('call-' + team, JSON.stringify({ team }))] }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const service = new LLMProxySvcImpl()
    const a = service.chat({ ...request, conversationId: 'member-a', messages: [{ role: 'user' as const, content: 'A' }], teamMember: teamA })
    const b = service.chat({ ...request, conversationId: 'member-b', messages: [{ role: 'user' as const, content: 'B' }], teamMember: teamB })
    await first.entered
    ended.add('team-a')
    first.release()
    await expect(a).rejects.toThrow('Team has ended.')
    const answer = await b
    expect(answer.content).toBe('answer B')
    expect(answer.metadata?.toolHistory).toEqual([expect.objectContaining({ status: 'completed', content: 'output B' })])
    expect(h.callTool).toHaveBeenCalledOnce()
    expect(h.callTool.mock.calls[0][2]).toEqual({ team: 'B' })
    expect(chat).toHaveBeenCalledTimes(3)
  })
  it('never opens the End store for a request without teamMember across two tool rounds', async () => {
    configure()
    endTeam()
    h.callTool.mockResolvedValue({ content: 'stub tool output' })
    const chat = vi.fn().mockResolvedValueOnce({ content: '', toolCalls: [nativeCall('call-1')] })
      .mockResolvedValueOnce({ content: '', toolCalls: [nativeCall('call-2')] })
      .mockResolvedValueOnce('ordinary answer')
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const { teamMember: _member, ...ordinary } = request
    const response = await new LLMProxySvcImpl().chat(ordinary)
    expect(response.content).toBe('ordinary answer')
    expect(h.callTool).toHaveBeenCalledTimes(2)
    expect(chat).toHaveBeenCalledTimes(3)
    expect(h.assertActive).not.toHaveBeenCalled()
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
