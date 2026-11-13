import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as budget from './providerJsonBudget'
import { ClaudeAPICli, GeminiAPICli, OllamaAPICli, OpenAIAPICli } from './clients'
import type { LLMCli, LLMChatParams } from './types'

const secret = 'sensitive-prompt-😀'
type Kind = 'chat' | 'responses' | 'gemini' | 'claude' | 'ollama'
const kinds: Kind[] = ['chat', 'responses', 'gemini', 'claude', 'ollama']
const reply = (kind: Kind, streaming: boolean): Response => {
  if (streaming && kind === 'chat') return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  if (streaming && kind === 'responses') return new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
  const data = kind === 'chat' ? { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } : kind === 'responses' ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } : kind === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } : kind === 'claude' ? { content: [{ type: 'text', text: 'ok' }] } : { message: { content: 'ok' } }
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
}
function setup(kind: Kind) {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => reply(kind, !!JSON.parse(String(init?.body)).stream))
  const client: LLMCli = kind === 'chat' || kind === 'responses' ? new OpenAIAPICli('key', 'https://provider.invalid/v1', 'fixture-model', { apiMode: kind === 'chat' ? 'chat-completions' : 'responses', enableHostedTools: false, enableHostedWebSearch: false, fetchImpl }) : kind === 'gemini' ? new GeminiAPICli('key', 'https://provider.invalid', 'fixture-model', { fetchImpl }) : kind === 'claude' ? new ClaudeAPICli('key', 'https://provider.invalid', 'fixture-model', { fetchImpl }) : new OllamaAPICli('key', 'https://provider.invalid', 'fixture-model', { fetchImpl })
  return { fetchImpl, client }
}
afterEach(() => vi.restoreAllMocks())
describe('Responses hosted file-search budget fences', () => {
  let installedArrayBufferShim = false
  beforeAll(() => {
    // jsdom's Blob lacks arrayBuffer(); provide the real FileReader byte path
    // for this suite rather than changing production behavior or assertions.
    if (typeof Blob.prototype.arrayBuffer !== 'function' && typeof FileReader !== 'undefined') {
      installedArrayBufferShim = true
      Object.defineProperty(Blob.prototype, 'arrayBuffer', {
        configurable: true,
        value: function (this: Blob): Promise<ArrayBuffer> {
          return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('Expected ArrayBuffer'))
            reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
            reader.readAsArrayBuffer(this)
          })
        }
      })
    }
  })
  afterAll(() => {
    if (installedArrayBufferShim) Reflect.deleteProperty(Blob.prototype, 'arrayBuffer')
  })
  const params: LLMChatParams = { messages: [{ role: 'user', content: secret, attachments: [{ type: 'file', fileName: 'note.txt', mimeType: 'text/plain', url: 'data:text/plain;base64,b3duZWQ=' }] }], retryCapacity: true }
  const fixture = (deleteFails: boolean) => {
    const calls: { method: string; url: string }[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input), method = init?.method || 'GET'
      calls.push({ method, url })
      if (method === 'DELETE') {
        if (deleteFails) throw new Error('secret-cleanup-failure')
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/v1/files')) return Response.json({ id: 'file-budget-fixture' })
      if (url.endsWith('/v1/vector_stores')) return Response.json({ id: 'vs-budget-fixture' })
      if (url.endsWith('/vector_stores/vs-budget-fixture/files') && method === 'POST') return Response.json({ id: 'file-budget-fixture', status: 'in_progress' })
      if (url.includes('/vector_stores/vs-budget-fixture/files') && method === 'GET') return Response.json({ data: [{ id: 'file-budget-fixture', status: 'completed' }], has_more: false })
      throw new Error('unexpected fake request')
    })
    const client = new OpenAIAPICli('key', 'https://budget-fixture.invalid/v1', 'fixture-model', { apiMode: 'responses', enableHostedTools: true, enableHostedWebSearch: false, fetchImpl })
    return { calls, client }
  }
  it('rejects preflight before any setup or model POST', async () => {
    const real = budget.serializeProviderJsonWithBudget
    vi.spyOn(budget, 'serializeProviderJsonWithBudget').mockImplementation(value => real(value, 0))
    const f = fixture(false)
    await expect(f.client.chat(params)).rejects.toBeInstanceOf(budget.ProviderJsonBudgetError)
    expect(f.calls).toEqual([])
  })
  it.each([false, true])('cleans after final budget rejection; fake DELETE fails=%s', async deleteFails => {
    const real = budget.serializeProviderJsonWithBudget
    const sizes: number[] = []
    vi.spyOn(budget, 'serializeProviderJsonWithBudget').mockImplementation(value => {
      const body = real(value)
      sizes.push(budget.providerJsonUtf8Bytes(body))
      return real(value, sizes[0])
    })
    const f = fixture(deleteFails)
    let failure: unknown
    try { await f.client.chat(params) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(budget.ProviderJsonBudgetError)
    expect(sizes).toHaveLength(2)
    expect(sizes[1]).toBeGreaterThan(sizes[0])
    expect((failure as budget.ProviderJsonBudgetError).code).toBe('PROVIDER_JSON_BUDGET_EXCEEDED')
    expect(String((failure as Error).stack)).not.toContain(secret)
    expect(String((failure as Error).stack)).not.toContain('secret-cleanup-failure')
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
    expect(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/responses'))).toHaveLength(0)
    expect(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/v1/files'))).toHaveLength(1)
    expect(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/v1/vector_stores'))).toHaveLength(1)
    expect(f.calls.filter(call => call.method === 'DELETE').map(call => call.url).sort()).toEqual(['https://budget-fixture.invalid/v1/files/file-budget-fixture', 'https://budget-fixture.invalid/v1/vector_stores/vs-budget-fixture'])
  })
})

describe.each(kinds)('%s provider JSON budget', kind => {
  it.each([false, true])('boundary with onDelta=%s and retryCapacity', async streaming => {
    const real = budget.serializeProviderJsonWithBudget
    const spy = vi.spyOn(budget, 'serializeProviderJsonWithBudget')
    const params: LLMChatParams = { messages: [{ role: 'user', content: secret }], retryCapacity: true, ...(streaming ? { onDelta: vi.fn() } : {}) }
    const first = setup(kind)
    await first.client.chat(params)
    expect(spy).toHaveBeenCalled()
    const body = String(first.fetchImpl.mock.calls[0][1]?.body)
    const size = budget.providerJsonUtf8Bytes(body)
    spy.mockImplementation((value, max) => real(value, Math.min(max ?? budget.DEFAULT_PROVIDER_JSON_MAX_BYTES, size + 1)))
    const below = setup(kind)
    await below.client.chat(params)
    expect(below.fetchImpl).toHaveBeenCalledOnce()
    spy.mockImplementation((value, max) => real(value, Math.min(max ?? budget.DEFAULT_PROVIDER_JSON_MAX_BYTES, size)))
    const exact = setup(kind)
    await exact.client.chat(params)
    expect(exact.fetchImpl).toHaveBeenCalledOnce()
    spy.mockImplementation((value, max) => real(value, Math.min(max ?? budget.DEFAULT_PROVIDER_JSON_MAX_BYTES, size - 1)))
    const tooLarge = setup(kind)
    let failure: unknown
    try { await tooLarge.client.chat(params) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(budget.ProviderJsonBudgetError)
    expect(failure).toMatchObject({ code: 'PROVIDER_JSON_BUDGET_EXCEEDED', message: 'Provider request exceeds the size limit. Remove some attachments or send fewer images per message.' })
    expect(String((failure as Error).stack)).not.toContain(secret)
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
    expect(tooLarge.fetchImpl).not.toHaveBeenCalled()
  })
})

describe.each(['chat', 'responses'] as const)('%s native tool next turn', kind => {
  it('rejects an enlarged tool result before its second provider POST', async () => {
    const real = budget.serializeProviderJsonWithBudget
    const spy = vi.spyOn(budget, 'serializeProviderJsonWithBudget')
    const { client, fetchImpl } = setup(kind)
    const tools = [{ name: 'files.read', description: 'Read', inputSchema: { type: 'object', properties: {} } }]
    const first: LLMChatParams = { messages: [{ role: 'user', content: 'read' }], tools }
    await client.chat(first)
    const size = budget.providerJsonUtf8Bytes(String(fetchImpl.mock.calls[0][1]?.body))
    spy.mockImplementation((value, max) => real(value, Math.min(max ?? budget.DEFAULT_PROVIDER_JSON_MAX_BYTES, size)))
    const second: LLMChatParams = { ...first, toolTurns: [{ content: '', calls: [{ id: 'call_owned', name: 'files.read', wireName: 'mp_tool_0', arguments: '{}' }], results: [{ callId: 'call_owned', output: 'X'.repeat(1024) }] }] }
    await expect(client.chat(second)).rejects.toBeInstanceOf(budget.ProviderJsonBudgetError)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

it.each(['images', 'responses'] as const)('does not apply chat helper to %s image generation', async mode => {
  const spy = vi.spyOn(budget, 'serializeProviderJsonWithBudget')
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(mode === 'images' ? { data: [{ b64_json: 'aGVsbG8=' }] } : { output: [{ type: 'image_generation_call', result: 'aGVsbG8=' }] }), { headers: { 'content-type': 'application/json' } }))
  const client = new OpenAIAPICli('key', 'https://provider.invalid/v1', 'gpt-image-1', { apiMode: mode, modelUse: 'image', enableHostedTools: false, fetchImpl })
  await client.chat({ messages: [{ role: 'user', content: 'image' }], imageGenerationOptions: { enabled: true } })
  expect(fetchImpl).toHaveBeenCalledOnce()
  expect(spy).not.toHaveBeenCalled()
})
