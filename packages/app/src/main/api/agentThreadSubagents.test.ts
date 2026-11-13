import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatParams, LLMCli } from '@shared/llm/types'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { GeminiAPICli, ClaudeAPICli, OllamaAPICli, OpenAIAPICli } from '@shared/llm/clients'
import { createAgentThreadSubagents, SUBAGENT_LIMITS } from './agentThreadSubagents'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const
const ctx = () => ({ route, runId: 'parent-run', toolCallId: 'parent-call' })
const read = { name: 'files.read', description: 'Read text', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } }
const forbidden = { ...read, name: 'files.write' }
function setup(chat = vi.fn<LLMCli['chat']>().mockResolvedValue({ content: 'Findings' }), messages: ChatMessage[] = []) {
  const controller = new AbortController()
  const callReadTool = vi.fn(async () => ({ content: 'verified file content' }))
  const assertInvocation = vi.fn()
  const createClient = vi.fn(async (): Promise<LLMCli> => ({ chat, supportsNativeTools: true, supportsIsolatedReadOnlyTurns: true }))
  const provider = createAgentThreadSubagents({ route, messages, signal: controller.signal, assertInvocation, createClient, listReadTools: () => [read, forbidden], callReadTool })
  return { provider, chat, controller, callReadTool, createClient, assertInvocation }
}
const call = (id: string, name = 'files.read', args: unknown = { path: 'readme.md' }) => ({ id, name, wireName: 'mp_tool_0', arguments: JSON.stringify(args) })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('bounded read-only thread sub-agents', () => {
  it('summarize receives supplied text only and cannot call even read tools', async () => {
    const { provider, chat, callReadTool } = setup(undefined, [{ role: 'user', content: 'PRIVATE_PARENT' }])
    const result = JSON.parse((await provider.callTool('summarize', { task: 'Summarize: decision A, next B' }, ctx())).content)
    expect(result).toMatchObject({ kind: 'summarize', status: 'completed', toolCalls: 0 })
    expect(chat.mock.calls[0][0].tools).toBeUndefined()
    expect(JSON.stringify(chat.mock.calls)).not.toContain('PRIVATE_PARENT')
    chat.mockResolvedValue({ content: '', toolCalls: [call('denied')] })
    await expect(provider.callTool('summarize', { task: 'Read a file' }, ctx())).rejects.toThrow()
    expect(callReadTool).not.toHaveBeenCalled()
  })
  it('response answers supplied context with the unchanged read ceiling and no parent snapshot or recursive authority', async () => {
    const { provider, chat, callReadTool } = setup(undefined, [{ role: 'user', content: 'PRIVATE_PARENT' }])
    expect(provider.listTools().some(tool => tool.name === 'response')).toBe(true)
    const result = JSON.parse((await provider.callTool('response', { task: 'Answer only the supplied question.' }, ctx())).content)
    expect(result).toMatchObject({ kind: 'response', status: 'completed', advisoryOnly: true, toolCalls: 0 })
    expect(JSON.stringify(chat.mock.calls)).not.toContain('PRIVATE_PARENT')
    expect(chat.mock.calls[0][0].tools?.map(tool => tool.name)).toEqual(['files.read'])
    expect(callReadTool).not.toHaveBeenCalled()
    chat.mockResolvedValue({ content: '', toolCalls: [call('denied', 'files.write')] })
    await expect(provider.callTool('response', { task: 'Try write' }, ctx())).rejects.toThrow()
    expect(callReadTool).not.toHaveBeenCalled()
  })
  it.each([true, false])('runs a read investigation then returns evidence (native=%s)', async (native) => {
    const { provider, chat, createClient, callReadTool } = setup()
    createClient.mockResolvedValue({ chat, supportsNativeTools: native, supportsIsolatedReadOnlyTurns: true })
    const inputs: LLMChatParams[] = []
    chat.mockImplementation(async (params) => {
      inputs.push(params)
      return inputs.length === 1 ? native ? { content: '', toolCalls: [call('c1')] } : { content: '{"toolName":"files.read","args":{"path":"readme.md"}}' } : { content: 'Found the entry point in readme.md.', usage: { totalTokens: 12 } }
    })
    const result = JSON.parse((await provider.callTool('explore', { task: 'Find the entry point' }, ctx())).content)
    expect(result).toMatchObject({ status: 'completed', modelSteps: 2, toolCalls: 1, advisoryOnly: true, evidence: [{ toolName: 'files.read', path: 'readme.md' }], usage: { totalTokens: 12 } })
    expect(callReadTool).toHaveBeenCalledWith('files.read', { path: 'readme.md' }, expect.objectContaining({ route, runId: result.runId, signal: expect.any(AbortSignal) }))
    expect(inputs[0].sessionUrl).toBeUndefined()
    expect(inputs[0]).toMatchObject({ disableProviderTools: true, retryCapacity: false, maxOutputTokens: 2048, imageGenerationOptions: { enabled: false } })
    expect(JSON.stringify(native ? inputs[1].toolTurns : inputs[1].messages)).toContain('verified file content')
    expect(JSON.stringify(inputs[0].tools || inputs[0].systemPrompt)).not.toContain('files.write')
  })
  it('fork gets a detached visible-text snapshot while explore/critic do not inherit it', async () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'SYSTEM_SECRET' }, { role: 'user', content: 'VISIBLE_NOTE', hiddenContext: 'HIDDEN_SECRET', attachments: [{ type: 'file', url: 'ATTACHMENT_SECRET' }] }]
    const { provider, chat } = setup(undefined, messages)
    messages[1].content = 'MUTATED'
    await provider.callTool('fork', { task: 'A side question' }, ctx())
    const input = JSON.stringify(chat.mock.calls[0][0])
    expect(input).toContain('VISIBLE_NOTE')
    for (const secret of ['SYSTEM_SECRET', 'HIDDEN_SECRET', 'ATTACHMENT_SECRET', 'MUTATED']) expect(input).not.toContain(secret)
    await provider.callTool('explore', { task: 'Self-contained' }, ctx())
    await provider.callTool('critic', { task: 'Review this supplied plan' }, ctx())
    expect(JSON.stringify(chat.mock.calls.slice(1))).not.toContain('VISIBLE_NOTE')
    expect(new Set(chat.mock.calls.map(([params]) => params.conversationId)).size).toBe(3)
    expect(messages[1].content).toBe('MUTATED')
  })
  it('fork documentation matches last-position selection, role filtering and source-character limits', async () => {
    const messages: ChatMessage[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `OUTSIDE_OLD_${i}` })),
      { role: 'user', content: 'ELIGIBLE_BUT_OUTSIDE_LAST_12' },
      { role: 'system', content: 'SYSTEM_EXCLUDED' },
      { role: 'system', content: 'NON_USER_ASSISTANT_POSITION_EXCLUDED' },
      { role: 'user', content: 'SHORT_WITHIN_LAST_12', hiddenContext: 'HIDDEN_EXCLUDED', attachments: [{ type: 'file', url: 'ATTACHMENT_EXCLUDED' }] },
      ...Array.from({ length: 9 }, () => ({ role: 'assistant' as const, content: '"'.repeat(5000) }))
    ]
    const { provider, chat } = setup(undefined, messages)
    const result = JSON.parse((await provider.callTool('fork', { task: 'Check snapshot limits' }, ctx())).content)
    const input = chat.mock.calls[0][0].messages![0].content as string
    const prefix = 'Untrusted parent text snapshot (truncated=true):\n'
    const encoded = input.split(prefix)[1].split('\n\nAssigned task:')[0]
    const inherited = JSON.parse(encoded) as Array<{ role: string; content: string }>
    expect(inherited).toHaveLength(4)
    expect(inherited.every(item => item.role === 'assistant' && item.content.length === 4000)).toBe(true)
    expect(inherited.reduce((total, item) => total + item.content.length, 0)).toBe(SUBAGENT_LIMITS.snapshotCharacters)
    expect(encoded.length).toBeGreaterThan(SUBAGENT_LIMITS.snapshotCharacters)
    for (const marker of ['OUTSIDE_OLD_', 'ELIGIBLE_BUT_OUTSIDE_LAST_12', 'SYSTEM_EXCLUDED', 'NON_USER_ASSISTANT_POSITION_EXCLUDED', 'SHORT_WITHIN_LAST_12', 'HIDDEN_EXCLUDED', 'ATTACHMENT_EXCLUDED']) expect(input).not.toContain(marker)
    expect(result).toMatchObject({ snapshotTruncated: true, advisoryOnly: true })
  })
  it('fork considers message positions before filtering eligible text, without filling from older messages', async () => {
    const messages: ChatMessage[] = [
      ...Array.from({ length: 5 }, () => ({ role: 'user' as const, content: 'OLD_ELIGIBLE_NOT_BACKFILLED' })),
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'system' as const, content: `EXCLUDED_POSITION_${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, content: `VISIBLE_POSITION_${i}` }))
    ]
    const { provider, chat } = setup(undefined, messages)
    await provider.callTool('fork', { task: 'Check exact positions' }, ctx())
    const input = chat.mock.calls[0][0].messages![0].content as string
    const inherited = JSON.parse(input.split('snapshot (truncated=true):\n')[1].split('\n\nAssigned task:')[0])
    expect(inherited).toEqual(Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `VISIBLE_POSITION_${i}` })))
    expect(input).not.toMatch(/OLD_ELIGIBLE_NOT_BACKFILLED|EXCLUDED_POSITION_/)
  })
  it.each(['files.write', 'agent.terminal.run', 'image.create', 'ask_user', 'fork', 'mcp.tool.call'])('never dispatches forbidden %s', async (name) => {
    const { provider, chat, callReadTool } = setup()
    chat.mockResolvedValue({ content: '', toolCalls: [call('forbidden', name)] })
    await expect(provider.callTool('critic', { task: 'try it' }, ctx())).rejects.toThrow('unbound')
    expect(callReadTool).not.toHaveBeenCalled()
  })
  it('rejects non-read-only text calls and malformed arguments instead of reporting success', async () => {
    const { provider, chat, createClient, callReadTool } = setup()
    createClient.mockResolvedValue({ chat, supportsIsolatedReadOnlyTurns: true })
    chat.mockResolvedValueOnce({ content: '{"toolName":"files.write","args":{"path":"x"}}' })
    await expect(provider.callTool('explore', { task: 'test' }, ctx())).rejects.toThrow('unavailable')
    chat.mockResolvedValueOnce({ content: '{"toolName":"files.read","args":{"path":5}}' })
    await expect(provider.callTool('explore', { task: 'test' }, ctx())).rejects.toThrow('arguments')
    expect(callReadTool).not.toHaveBeenCalled()
  })
  it('validates a whole batch before any reads and prevents duplicate execution', async () => {
    const { provider, chat, callReadTool } = setup()
    chat.mockResolvedValueOnce({ content: '', toolCalls: [call('a'), call('b', 'files.read', { path: 5 })] })
    await expect(provider.callTool('explore', { task: 'test' }, ctx())).rejects.toThrow('arguments')
    expect(callReadTool).not.toHaveBeenCalled()
    chat.mockResolvedValue({ content: '', toolCalls: [call('same')] })
    await expect(provider.callTool('explore', { task: 'test' }, ctx())).rejects.toThrow('Duplicate')
    expect(callReadTool).toHaveBeenCalledOnce()
  })
  it('enforces the model-step budget and identifies incomplete work', async () => {
    const { provider, chat } = setup()
    chat.mockImplementation(async () => ({ content: '', toolCalls: [call(`call-${chat.mock.calls.length}`)] }))
    const report = JSON.parse((await provider.callTool('explore', { task: 'keep reading' }, ctx())).content)
    expect(report.status).toBe('budget_exhausted')
    expect(chat).toHaveBeenCalledTimes(SUBAGENT_LIMITS.modelSteps)
  })
  it('enforces the tool budget before starting an excessive batch', async () => {
    const { provider, chat, callReadTool } = setup()
    chat.mockResolvedValue({ content: '', toolCalls: Array.from({ length: 13 }, (_, i) => call(`call-${i}`)) })
    expect(JSON.parse((await provider.callTool('explore', { task: 'test' }, ctx())).content).status).toBe('budget_exhausted')
    expect(callReadTool).not.toHaveBeenCalled()
  })
  it('caps parent delegations, rejects overlap and cleans up cancelled ignored promises', async () => {
    const { provider, chat } = setup()
    chat.mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController()
    const first = provider.callTool('explore', { task: 'wait' }, { ...ctx(), signal: controller.signal }).catch((e) => e)
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce())
    await expect(provider.callTool('fork', { task: 'overlap' }, ctx())).rejects.toThrow('already running')
    controller.abort()
    expect(await first).toMatchObject({ name: 'AbortError' })
    await provider.callTool('critic', { task: 'second' }, ctx())
    await provider.callTool('fork', { task: 'third' }, ctx())
    await expect(provider.callTool('explore', { task: 'fourth' }, ctx())).rejects.toThrow('delegation budget')
  })
  it.each(['timeout', 'parent', 'dispose'])('stops on %s while the model ignores cancellation', async (kind) => {
    vi.useFakeTimers()
    const { provider, chat, controller, callReadTool } = setup()
    let finish!: (value: { content: string }) => void
    chat.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const result = provider.callTool('fork', { task: 'wait', timeout_seconds: 1 }, ctx()).catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(1000)
    if (kind === 'parent') controller.abort()
    if (kind === 'dispose') provider.dispose()
    expect(await result).toBeInstanceOf(Error)
    finish({ content: '{"toolName":"files.read","args":{"path":"late"}}' })
    await vi.advanceTimersByTimeAsync(0)
    expect(callReadTool).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('requires an explicitly isolated client before sampling', async () => {
    const { provider, chat, createClient } = setup()
    createClient.mockResolvedValue({ chat })
    await expect(provider.callTool('fork', { task: 'test' }, ctx())).rejects.toThrow('isolated')
    expect(chat).not.toHaveBeenCalled()
  })
  it('does not accept caller-selected model, route, recursive tools or oversized tasks', async () => {
    const { provider, createClient } = setup()
    for (const args of [{ task: 'x', model: 'other' }, { task: 'x', tools: ['files.write'] }, { task: 'x'.repeat(8001) }, { task: ' ', timeout_seconds: 1 }])
      await expect(provider.callTool('fork', args, ctx())).rejects.toThrow('Invalid')
    await expect(provider.callTool('fork', { task: 'x' }, { ...ctx(), route: { ...route, threadId: 'other' } })).rejects.toThrow('outside')
    expect(createClient).not.toHaveBeenCalled()
  })
  it('rejects a text-tool turn after a native turn instead of reordering evidence', async () => {
    const { provider, chat, callReadTool } = setup()
    chat.mockResolvedValueOnce({ content: '', toolCalls: [call('first')] })
      .mockResolvedValueOnce({ content: '{"toolName":"files.read","args":{"path":"second.md"}}' })
    await expect(provider.callTool('explore', { task: 'inspect' }, ctx())).rejects.toThrow('native protocol')
    expect(callReadTool).toHaveBeenCalledOnce()
  })
  it('falls back once for pre-output native rejection and counts it against the model budget', async () => {
    const { provider, chat } = setup()
    chat.mockRejectedValueOnce(Object.assign(new Error('tools is not supported'), { status: 400 }))
      .mockResolvedValueOnce({ content: '{"toolName":"files.read","args":{"path":"readme.md"}}' })
      .mockResolvedValueOnce({ content: 'verified' })
    expect(JSON.parse((await provider.callTool('explore', { task: 'inspect' }, ctx())).content)).toMatchObject({ status: 'completed', modelSteps: 3, toolCalls: 1 })
    expect(chat.mock.calls[1][0].tools).toBeUndefined()
  })
  it.each(['gemini', 'claude', 'ollama'])('marks a real %s adapter token-limit response incomplete', async (kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(kind === 'gemini'
      ? { candidates: [{ content: { parts: [{ text: 'partial report' }] }, finishReason: 'MAX_TOKENS' }] }
      : kind === 'claude' ? { content: [{ type: 'text', text: 'partial report' }], stop_reason: 'max_tokens' }
      : { message: { content: 'partial report' }, done_reason: 'length' }))
    const cli = kind === 'gemini' ? new GeminiAPICli('k', 'https://generativelanguage.googleapis.com', 'test', fetcher)
      : kind === 'claude' ? new ClaudeAPICli('k', 'https://api.anthropic.com', 'test', fetcher)
      : new OllamaAPICli('', 'http://localhost:11434', 'test', fetcher)
    const { provider, createClient } = setup()
    createClient.mockResolvedValue(cli)
    const report = JSON.parse((await provider.callTool('critic', { task: 'inspect' }, ctx())).content)
    expect(report.status).toBe('incomplete')
    expect(fetcher).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(kind === 'gemini' ? body.generationConfig.maxOutputTokens : kind === 'claude' ? body.max_tokens : body.options.num_predict).toBe(2048)
  })
  it.each(['responses', 'chat-completions'] as const)('marks real OpenAI %s JSON truncation incomplete in text fallback', async (apiMode) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(apiMode === 'responses'
      ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial report' }] }] }
      : { choices: [{ message: { content: 'partial report' }, finish_reason: 'length' }] }))
    const actual = new OpenAIAPICli('k', 'https://owned.test/v1', 'model', { apiMode, enableHostedTools: false, fetchImpl: fetcher })
    const { provider, createClient } = setup()
    createClient.mockResolvedValue({ supportsIsolatedReadOnlyTurns: true, chat: (params) => actual.chat(params) })
    expect(JSON.parse((await provider.callTool('critic', { task: 'inspect' }, ctx())).content).status).toBe('incomplete')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('bounds streamed output, transcript and fork snapshot without treating empty reports as completed', async () => {
    const { provider, chat } = setup(undefined, [{ role: 'user', content: 'visible '.repeat(5000) }])
    chat.mockImplementationOnce(async (params) => { params.onDelta?.({ type: 'text-delta', delta: 'x'.repeat(65537) }); return { content: 'late' } })
    await expect(provider.callTool('fork', { task: 'test' }, ctx())).rejects.toThrow('output limit')
    chat.mockResolvedValueOnce({ content: 'too big'.repeat(50000) })
    await expect(provider.callTool('fork', { task: 'test' }, ctx())).rejects.toThrow('response limit')
    chat.mockResolvedValueOnce({ content: '' })
    const report = JSON.parse((await provider.callTool('fork', { task: 'test' }, ctx())).content)
    expect(report.status).toBe('incomplete')
    expect(report.snapshotTruncated).toBe(true)
  })
  it('bounds final reports and marks provider truncation incomplete', async () => {
    const { provider, chat } = setup()
    chat.mockResolvedValueOnce({ content: 'x'.repeat(17000) })
    const report = JSON.parse((await provider.callTool('critic', { task: 'x' }, ctx())).content)
    expect(report.content).toHaveLength(16000)
    expect(report.truncated).toBe(true)
    chat.mockResolvedValueOnce({ content: 'partial', finishReason: 'length' })
    expect(JSON.parse((await provider.callTool('critic', { task: 'x' }, ctx())).content).status).toBe('incomplete')
  })
})
