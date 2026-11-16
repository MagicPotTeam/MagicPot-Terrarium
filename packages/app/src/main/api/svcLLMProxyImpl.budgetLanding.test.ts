import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({
  assertActive: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  // Only the model-step cap is made adjustable: it cannot be reached through
  // the real 64-call loop, because every model step either ends the turn,
  // repairs once or runs at least one tool.
  modelSteps: undefined as number | undefined
}))
vi.mock('electron', () => ({ net: {} }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => { throw new Error('Unexpected production path') } }))
vi.mock('./teamEndStore', () => ({
  getTeamEndStore: () => h,
  assertTeamRequestActive: (req: { teamMember?: unknown }) => { if (Object.hasOwn(req, 'teamMember')) h.assertActive(req.teamMember) }
}))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock(import('@shared/llm/nativeTools'), async original => {
  const actual = await original()
  return {
    ...actual,
    get MAX_AGENT_MODEL_STEPS() { return h.modelSteps ?? actual.MAX_AGENT_MODEL_STEPS }
  }
})
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools, callTool: h.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { AGENT_TOOL_CALL_SOFT_BUDGET, MAX_AGENT_TOOL_CALLS, MAX_NATIVE_TRANSCRIPT_BYTES } from '@shared/llm/nativeTools'
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

type ChatParams = {
  tools?: unknown[]
  toolTurns?: Array<{ calls: unknown[]; results: unknown[] }>
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>
  systemPrompt?: string
  disableProviderTools?: boolean
  disableAutomaticImageGeneration?: boolean
  imageGenerationOptions?: { enabled?: boolean }
  signal?: AbortSignal
}

const SUMMARY = 'Summary: 64 files read; the rest remains.'
const SOFT_NOTE = /Tool budget notice/
const tool = { name: 'files.read', description: 'Read owned file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
const request = (extra: Record<string, unknown> = {}) => ({
  conversationId: 'budget-landing',
  profileId: 'profile',
  systemPrompt: 'You are the base agent.',
  messages: [{ role: 'user' as const, content: 'Read every file' }],
  skillRuntime: { bindings: [{ appId: 'magicpot.core', toolNames: ['files.read'] }] },
  ...extra
})
const call = (id: string) => ({ id, name: 'files.read', wireName: 'mp_tool_0', arguments: JSON.stringify({ path: id + '.txt' }) })
const legacyCall = (n: number) => JSON.stringify({ toolName: 'files.read', args: { path: n + '.txt' } })

/** Snapshot every request: the loop mutates its own arrays after a call returns. */
const recordingChat = (respond: (params: ChatParams, index: number) => unknown) => {
  const seen: ChatParams[] = []
  const chat = vi.fn(async (params: ChatParams) => {
    const { signal, ...rest } = params as ChatParams & { onDelta?: unknown; invocation?: unknown }
    void signal
    seen.push(structuredClone({ ...rest, onDelta: undefined }) as ChatParams)
    return respond(params, seen.length - 1)
  })
  return { chat, seen }
}

beforeEach(() => {
  h.assertActive.mockReset(); h.listTools.mockReset(); h.callTool.mockReset(); h.modelSteps = undefined
  const config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'profile', model_name: 'model', base_url: 'https://example.invalid/v1', api_key: 'unused' }]
  vi.mocked(getConfig).mockReturnValue(config)
  h.listTools.mockReturnValue([tool])
  h.callTool.mockImplementation(async (_route: unknown, _name: string, args: { path: string }) => ({ content: 'file:' + args.path }))
})
afterEach(() => vi.clearAllMocks())

describe('agent loop budget landing (native tools)', () => {
  it('lands a model that keeps asking for tools with one tool-less summary call', async () => {
    let n = 0
    const { chat, seen } = recordingChat(params => params.tools
      ? { content: '', toolCalls: [call('c' + n++)], finishReason: 'tool_call' }
      : { content: SUMMARY })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = await new LLMProxySvcImpl().chat(request())
    expect(result.content).toBe(SUMMARY)
    expect(result.finishReason).toBe('length')
    expect(result.metadata?.limitReached).toBe('tool_calls')
    // 64 executed steps, the 65th asked for one more call (refused), then one final call.
    expect(chat).toHaveBeenCalledTimes(MAX_AGENT_TOOL_CALLS + 2)
    expect(seen.filter(p => !p.tools)).toHaveLength(1)
    expect(seen.at(-1)!.tools).toBeUndefined()
    expect(h.callTool).toHaveBeenCalledTimes(64)
    const history = result.metadata?.toolHistory as Array<Record<string, unknown>>
    expect(history).toHaveLength(64)
    expect(new Set(history.map(r => r.toolCallId)).size).toBe(64)
    expect(history.every(r => r.status === 'completed')).toBe(true)
    expect(history.map(r => (r.args as { path: string }).path)).toEqual(Array.from({ length: 64 }, (_, i) => `c${i}.txt`))
  })

  it('sends the final call without any tool surface and with every kept result as plain text', async () => {
    let n = 0
    const { chat, seen } = recordingChat(params => params.tools
      ? { content: '', toolCalls: [call('c' + n++)] }
      : { content: SUMMARY })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    await new LLMProxySvcImpl().chat(request())
    const final = seen.at(-1)!
    expect(final.tools).toBeUndefined()
    expect(final.toolTurns).toBeUndefined()
    expect(final.disableProviderTools).toBe(true)
    expect(final.disableAutomaticImageGeneration).toBe(true)
    expect(final.imageGenerationOptions).toEqual({ enabled: false })
    // No provider-specific tool frames: every provider family accepts this shape.
    expect(final.messages.some(m => m.role === 'tool' || 'tool_calls' in m)).toBe(false)
    const results = final.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('[Tool Result]'))
    expect(results).toHaveLength(64)
    expect(results[0].content).toContain('file:c0.txt')
    expect(results[63].content).toContain('file:c63.txt')
    expect(final.messages[0]).toEqual({ role: 'user', content: 'Read every file' })
    const last = final.messages.at(-1)!
    expect(last.role).toBe('user')
    expect(last.content).toMatch(/Tool budget reached/)
    expect(final.systemPrompt).toBe('You are the base agent.')
    // The previous step still had the full tool surface.
    expect(seen.at(-2)!.toolTurns).toHaveLength(64)
  })

  it('adds the 75 % wrap-up note once, from the soft budget on, never before', async () => {
    let n = 0
    const { chat, seen } = recordingChat(params => params.tools
      ? { content: '', toolCalls: [call('c' + n++)] }
      : { content: SUMMARY })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    await new LLMProxySvcImpl().chat(request())
    expect(AGENT_TOOL_CALL_SOFT_BUDGET).toBe(48)
    seen.slice(0, AGENT_TOOL_CALL_SOFT_BUDGET).forEach(p => expect(p.systemPrompt).not.toMatch(SOFT_NOTE))
    seen.slice(AGENT_TOOL_CALL_SOFT_BUDGET, -1).forEach(p => {
      expect(p.systemPrompt!.match(new RegExp(SOFT_NOTE.source, 'g'))).toHaveLength(1)
      expect(p.messages.some(m => typeof m.content === 'string' && SOFT_NOTE.test(m.content))).toBe(false)
    })
    expect(seen.at(-1)!.systemPrompt).not.toMatch(SOFT_NOTE)
  })

  it('does not add the note to a short run', async () => {
    const { chat, seen } = recordingChat((_params, i) => i < 3 ? { content: '', toolCalls: [call('s' + i)] } : { content: 'done' })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = await new LLMProxySvcImpl().chat(request())
    expect(result.content).toBe('done')
    expect(result.finishReason).not.toBe('length')
    expect(result.metadata?.limitReached).toBeUndefined()
    seen.forEach(p => expect(p.systemPrompt).not.toMatch(SOFT_NOTE))
  })

  it('still refuses a batch that crosses the cap as a whole', async () => {
    let n = 0
    const { chat, seen } = recordingChat(params => {
      if (!params.tools) return { content: SUMMARY }
      if (n < 62) return { content: '', toolCalls: [call('c' + n++)] }
      return { content: '', toolCalls: [call('x1'), call('x2'), call('x3')] }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = await new LLMProxySvcImpl().chat(request())
    expect(h.callTool).toHaveBeenCalledTimes(62)
    expect(result.metadata?.limitReached).toBe('tool_calls')
    expect(result.metadata?.toolHistory).toHaveLength(62)
    expect(chat).toHaveBeenCalledTimes(64)
    expect(seen.at(-1)!.messages.some(m => typeof m.content === 'string' && m.content.includes('x1.txt'))).toBe(false)
  })

  it('lands on the transcript budget without sending the turn that overflowed it', async () => {
    const big = 'y'.repeat(Math.ceil(MAX_NATIVE_TRANSCRIPT_BYTES / 3) + 1024)
    h.callTool.mockImplementation(async (_route: unknown, _name: string, args: { path: string }) => ({ content: args.path + ':' + big }))
    let n = 0
    const { chat, seen } = recordingChat(params => params.tools
      ? { content: '', toolCalls: [call('t' + n++)] }
      : { content: SUMMARY })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = await new LLMProxySvcImpl().chat(request())
    expect(result.content).toBe(SUMMARY)
    expect(result.finishReason).toBe('length')
    expect(result.metadata?.limitReached).toBe('transcript')
    expect(h.callTool).toHaveBeenCalledTimes(3)
    expect(chat).toHaveBeenCalledTimes(4)
    expect(seen.filter(p => !p.tools)).toHaveLength(1)
    // The receipt of the overflowing call is kept for the user ...
    const history = result.metadata?.toolHistory as Array<Record<string, unknown>>
    expect(history).toHaveLength(3)
    expect(history[2]).toMatchObject({ status: 'completed', content: 't2.txt:' + big })
    // ... but its bytes never reach the final request.
    const final = seen.at(-1)!
    const results = final.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('[Tool Result]'))
    expect(results).toHaveLength(2)
    expect(JSON.stringify(final.messages)).not.toContain('t2.txt:')
    expect(String(final.messages.at(-1)!.content)).toMatch(/not shown/)
  })

  it('lands on the model-step budget', async () => {
    h.modelSteps = 3
    let n = 0
    const { chat, seen } = recordingChat(params => params.tools
      ? { content: '', toolCalls: [call('m' + n++)] }
      : { content: SUMMARY })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = await new LLMProxySvcImpl().chat(request())
    expect(result.content).toBe(SUMMARY)
    expect(result.finishReason).toBe('length')
    expect(result.metadata?.limitReached).toBe('model_steps')
    expect(chat).toHaveBeenCalledTimes(4)
    expect(seen.filter(p => !p.tools)).toHaveLength(1)
    expect(result.metadata?.toolHistory).toHaveLength(3)
  })

  it('cancels, without another call, when aborted during the final call', async () => {
    let n = 0
    let finalStarted!: () => void
    const started = new Promise<void>(resolve => { finalStarted = resolve })
    const chat = vi.fn(async (params: ChatParams) => {
      if (params.tools) return { content: '', toolCalls: [call('a' + n++)] }
      finalStarted()
      return await new Promise((_resolve, reject) => {
        const fail = () => reject(params.signal!.reason instanceof Error ? params.signal!.reason : new Error('aborted'))
        if (params.signal!.aborted) fail()
        params.signal!.addEventListener('abort', fail, { once: true })
      })
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const service = new LLMProxySvcImpl()
    const pending = service.chat(request())
    await started
    await expect(service.cancelConversation({ conversationId: 'budget-landing' })).resolves.toEqual({ cancelled: true })
    const error = await pending.catch(e => e)
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(error.message).not.toMatch(/budget/)
    expect(error.metadata.toolHistory).toHaveLength(64)
    expect(chat).toHaveBeenCalledTimes(66)
  })

  it('keeps the budget error when the final call returns no usable text', async () => {
    let n = 0
    const chat = vi.fn(async (params: ChatParams) => params.tools
      ? { content: '', toolCalls: [call('e' + n++)] }
      : { content: '', toolCalls: [call('late')] })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const error = await new LLMProxySvcImpl().chat(request()).catch(e => e)
    expect(error.message).toMatch(/tool-call budget exhausted/)
    expect(error.metadata.toolHistory).toHaveLength(64)
    expect(h.callTool).toHaveBeenCalledTimes(64)
    expect(chat).toHaveBeenCalledTimes(66)
  })

  it('keeps the budget error, not the provider error, when the final call fails', async () => {
    let n = 0
    const chat = vi.fn(async (params: ChatParams) => {
      if (params.tools) return { content: '', toolCalls: [call('f' + n++)] }
      throw new Error('provider exploded')
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const error = await new LLMProxySvcImpl().chat(request()).catch(e => e)
    expect(error.message).toMatch(/tool-call budget exhausted/)
    expect(error.cause).toMatchObject({ message: 'provider exploded' })
    expect(error.metadata.toolHistory).toHaveLength(64)
    expect(chat).toHaveBeenCalledTimes(66)
  })

  it('makes no final call for a team member whose team ended during the run', async () => {
    const tuple = { scope: 's', thread: 't', lead: 'l', member: 'm' }
    let n = 0
    const chat = vi.fn(async (params: ChatParams) => {
      if (n === 10) h.assertActive.mockImplementation(() => { throw new Error('Team has ended.') })
      return params.tools ? { content: '', toolCalls: [call('t' + n++)] } : { content: SUMMARY }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const error = await new LLMProxySvcImpl().chat(request({ teamMember: tuple })).catch(e => e)
    expect(error.message).toMatch(/tool-call budget exhausted/)
    expect(chat).toHaveBeenCalledTimes(65)
    expect(chat.mock.calls.every(([p]) => p.tools)).toBe(true)
  })

  it('lands a team member whose team is still active like any other run', async () => {
    const tuple = { scope: 's', thread: 't', lead: 'l', member: 'm' }
    let n = 0
    const { chat, seen } = recordingChat(params => params.tools ? { content: '', toolCalls: [call('t' + n++)] } : { content: SUMMARY })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const result = await new LLMProxySvcImpl().chat(request({ teamMember: tuple }))
    expect(result).toMatchObject({ content: SUMMARY, finishReason: 'length', metadata: { limitReached: 'tool_calls' } })
    expect(seen.filter(p => !p.tools)).toHaveLength(1)
  })

  it('streams the summary and ends with a done event, not an error', async () => {
    let n = 0
    const chat = vi.fn(async (params: ChatParams & { onDelta?: (e: unknown) => void }) => {
      if (params.tools) return { content: '', toolCalls: [call('s' + n++)] }
      params.onDelta?.({ type: 'text-delta', delta: SUMMARY })
      return { content: SUMMARY }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const events: Array<Record<string, unknown>> = []
    await new LLMProxySvcImpl().chatStream(request(), { onData: (e: Record<string, unknown>) => events.push(e) } as never)
    expect(events.some(e => e.type === 'error')).toBe(false)
    expect(events.some(e => e.type === 'text-delta' && e.delta === SUMMARY)).toBe(true)
    const done = events.filter(e => e.type === 'done')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ content: SUMMARY, finishReason: 'length', metadata: { limitReached: 'tool_calls' } })
    expect((done[0].metadata as { toolHistory: unknown[] }).toolHistory).toHaveLength(64)
    expect(chat).toHaveBeenCalledTimes(66)
  })
})

describe('agent loop budget landing (text tool protocol)', () => {
  it('lands a legacy JSON tool loop with tool instructions removed from the final call', async () => {
    let n = 0
    const { chat, seen } = recordingChat(params => /Input schema/.test(params.systemPrompt || '')
      ? { content: legacyCall(n++) }
      : { content: SUMMARY })
    vi.mocked(cliFromProfile).mockReturnValue({ chat } as never)
    const result = await new LLMProxySvcImpl().chat(request())
    expect(result).toMatchObject({ content: SUMMARY, finishReason: 'length', metadata: { limitReached: 'tool_calls' } })
    expect(result.metadata?.toolHistory).toHaveLength(64)
    expect(chat).toHaveBeenCalledTimes(66)
    const final = seen.at(-1)!
    expect(final.systemPrompt).toBe('You are the base agent.')
    expect(final.tools).toBeUndefined()
    expect(final.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('[Tool Result]'))).toHaveLength(64)
    expect(final.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(seen.slice(AGENT_TOOL_CALL_SOFT_BUDGET, -1).every(p => SOFT_NOTE.test(p.systemPrompt || ''))).toBe(true)
    expect(seen.slice(0, AGENT_TOOL_CALL_SOFT_BUDGET).some(p => SOFT_NOTE.test(p.systemPrompt || ''))).toBe(false)
  })

  it('drops the overflowing legacy result from the final call on the transcript budget', async () => {
    const big = 'z'.repeat(Math.ceil(MAX_NATIVE_TRANSCRIPT_BYTES / 3) + 1024)
    h.callTool.mockImplementation(async (_route: unknown, _name: string, args: { path: string }) => ({ content: args.path + ':' + big }))
    let n = 0
    const { chat, seen } = recordingChat(params => /Input schema/.test(params.systemPrompt || '')
      ? { content: legacyCall(n++) }
      : { content: SUMMARY })
    vi.mocked(cliFromProfile).mockReturnValue({ chat } as never)
    const result = await new LLMProxySvcImpl().chat(request())
    expect(result).toMatchObject({ content: SUMMARY, finishReason: 'length', metadata: { limitReached: 'transcript' } })
    expect(result.metadata?.toolHistory).toHaveLength(3)
    expect(chat).toHaveBeenCalledTimes(4)
    const final = seen.at(-1)!
    expect(JSON.stringify(final.messages)).not.toContain('2.txt:')
    expect(final.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('[Tool Result]'))).toHaveLength(2)
  })

  it('withholds a final answer that is itself a tool invocation and keeps the budget error', async () => {
    let n = 0
    const deltas: unknown[] = []
    const chat = vi.fn(async (params: ChatParams & { onDelta?: (e: unknown) => void }) => {
      const text = legacyCall(n++)
      if (!/Input schema/.test(params.systemPrompt || '')) params.onDelta?.({ type: 'text-delta', delta: text })
      return { content: text }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat } as never)
    const events: Array<Record<string, unknown>> = []
    await new LLMProxySvcImpl().chatStream(request(), { onData: (e: Record<string, unknown>) => { events.push(e); deltas.push(e) } } as never)
    expect(chat).toHaveBeenCalledTimes(66)
    expect(h.callTool).toHaveBeenCalledTimes(64)
    expect(events.some(e => e.type === 'text-delta')).toBe(false)
    const error = events.find(e => e.type === 'error')
    expect(String(error?.error)).toMatch(/tool-call budget exhausted/)
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'error' })
  })
})

describe('loops that keep the old budget error', () => {
  it('does not land a structured-output request (the summary could not satisfy the schema)', async () => {
    let n = 0
    const { chat, seen } = recordingChat(params => params.tools ? { content: '', toolCalls: [call('j' + n++)] } : { content: SUMMARY })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const structuredOutput = { name: 'plan', schema: { type: 'object', properties: {} } }
    const error = await new LLMProxySvcImpl().chat(request({ structuredOutput })).catch(e => e)
    expect(error.message).toMatch(/tool-call budget exhausted/)
    expect(chat).toHaveBeenCalledTimes(65)
    // No promise of a summary to a run that will not get one.
    seen.forEach(p => expect(p.systemPrompt || '').not.toMatch(SOFT_NOTE))
  })
})
