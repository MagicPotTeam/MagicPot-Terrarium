import { describe, it, expect, vi } from 'vitest'
import { OpenAIAPICli } from './clients'
import type { LLMChatParams } from './types'
const tools = [
  {
    name: 'files.read',
    description: 'Read local file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
]
const response = (payload: unknown) =>
  new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
const sse = (events: unknown[]) =>
  new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), {
    headers: { 'content-type': 'text/event-stream' }
  })
const create = (fetchImpl: typeof fetch, mode: 'responses' | 'chat-completions') =>
  new OpenAIAPICli(
    'owned',
    mode === 'responses' ? 'https://owned.test/v1' : 'https://owned.test/v1/chat/completions',
    'owned-model',
    { fetchImpl, apiMode: mode, enableHostedTools: false }
  )
describe('native tool transport', () => {
  it('isolated helpers disable hosted web/file tools even when client defaults enable them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.tools).toHaveLength(1)
      expect(body.tools[0].type).toBe('function')
      expect(body.max_output_tokens).toBe(2048)
      return response({ output_text: 'checked', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checked' }] }] })
    })
    const cli = new OpenAIAPICli('owned', 'https://api.openai.com/v1', 'gpt-5.4', { apiMode: 'responses', enableHostedTools: true, enableHostedWebSearch: true, fetchImpl: fetcher })
    expect(cli.supportsIsolatedReadOnlyTurns).toBe(true)
    expect(cli.supportsIsolatedMainToolTurns).toBe(true)
    await cli.chat({ messages: [{ role: 'user', content: 'inspect' }], tools, disableProviderTools: true, imageGenerationOptions: { enabled: false }, maxOutputTokens: 2048, retryCapacity: false })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('rejects isolated image requests before any upstream submission', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const cli = new OpenAIAPICli('owned', 'https://owned.test/v1', 'gpt-image-1', { apiMode: 'images', modelUse: 'image', fetchImpl: fetcher })
    await expect(cli.chat({ messages: [{ role: 'user', content: 'image' }], disableProviderTools: true })).rejects.toThrow('disabled')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['content', 'images'] as const)('client-owned text-only policy refuses mixed native/media %s before native normalization', async field => {
    const payload = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'one', type: 'function', function: { name: 'mp_tool_0', arguments: '{}' } }], [field]: [{ type: 'image_url', image_url: { url: 'https://images.invalid/mixed.png' } }] }, finish_reason: 'tool_calls' }] }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(payload))
    const cli = new OpenAIAPICli('owned', 'https://owned.test/v1/chat/completions', 'owned-model', { apiMode: 'chat-completions', fetchImpl: fetcher, requireTextOnlyResponse: true })
    await expect(cli.chat({ messages: [{ role: 'user', content: 'read' }], tools, retryCapacity: false })).rejects.toThrow(/text|media/i)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each(['length', 'content_filter'] as const)(
    'preserves non-streaming text-parts %s status rather than completing a tool-looking reply',
    async reason => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: '{"toolName":"files.read","args":{"path":"a.txt"}}' }] }, finish_reason: reason }] }))
      const result = await create(fetcher, 'chat-completions').chat({ messages: [{ role: 'user', content: 'read' }], tools, retryCapacity: false })
      expect(result.finishReason).toBe(reason === 'length' ? 'length' : 'error')
      expect(result.toolCalls).toBeUndefined()
      expect(fetcher).toHaveBeenCalledOnce()
    }
  )
  it.each(['responses', 'chat-completions'] as const)(
    'sends native definitions and accepts a tool-only %s response',
    async (mode) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        const def = mode === 'responses' ? body.tools?.[0] : body.tools?.[0]?.function
        expect(def).toMatchObject({
          name: 'mp_tool_0',
          strict: false,
          parameters: tools[0].inputSchema
        })
        return response(
          mode === 'responses'
            ? {
                output: [
                  {
                    type: 'reasoning',
                    id: 'rs_owned',
                    summary: [],
                    encrypted_content: 'opaque-owned'
                  },
                  {
                    type: 'function_call',
                    id: 'fc_owned',
                    call_id: 'call_owned',
                    name: def.name,
                    arguments: '{"path":"notes/a.txt"}'
                  }
                ]
              }
            : {
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_owned',
                          type: 'function',
                          function: { name: def.name, arguments: '{"path":"notes/a.txt"}' }
                        }
                      ]
                    },
                    finish_reason: 'tool_calls'
                  }
                ]
              }
        )
      })
      const cli = create(fetcher, mode)
      expect(cli.supportsNativeTools).toBe(true)
      const result = await cli.chat({
        messages: [{ role: 'user', content: 'read' }],
        tools
      } as LLMChatParams)
      expect(result.content).toBe('')
      expect(result.finishReason).toBe('tool_call')
      expect(result.toolCalls).toEqual([
        {
          id: 'call_owned',
          name: 'files.read',
          wireName: 'mp_tool_0',
          arguments: '{"path":"notes/a.txt"}'
        }
      ])
      if (mode === 'responses')
        expect(result.toolResponseItems?.[0]).toMatchObject({
          type: 'reasoning',
          encrypted_content: 'opaque-owned'
        })
    }
  )
  it.each(['responses', 'chat-completions'] as const)(
    'pairs a previous native %s call with its exact result',
    async (mode) => {
      const calls = [
        {
          id: 'call_owned',
          name: 'files.read',
          wireName: 'mp_tool_0',
          arguments: '{"path":"a.txt"}'
        }
      ]
      const items = [
        { type: 'reasoning', id: 'rs_owned', summary: [], encrypted_content: 'opaque-owned' },
        {
          type: 'function_call',
          id: 'fc_owned',
          call_id: 'call_owned',
          name: 'mp_tool_0',
          arguments: calls[0].arguments
        }
      ]
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (mode === 'responses') {
          expect(body.input.slice(-3)).toEqual([
            ...items,
            { type: 'function_call_output', call_id: 'call_owned', output: 'ACTUAL_FILE_CONTENT' }
          ])
          expect(body.include).toContain('reasoning.encrypted_content')
        } else
          expect(body.messages.slice(-2)).toEqual([
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_owned',
                  type: 'function',
                  function: { name: 'mp_tool_0', arguments: calls[0].arguments }
                }
              ]
            },
            { role: 'tool', tool_call_id: 'call_owned', content: 'ACTUAL_FILE_CONTENT' }
          ])
        return response(
          mode === 'responses'
            ? {
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'done' }]
                  }
                ]
              }
            : { choices: [{ message: { content: 'done' } }] }
        )
      })
      const result = await create(fetcher, mode).chat({
        messages: [{ role: 'user', content: 'read' }],
        tools,
        toolTurns: [
          {
            content: '',
            calls,
            results: [{ callId: 'call_owned', output: 'ACTUAL_FILE_CONTENT' }],
            responseItems: mode === 'responses' ? items : undefined
          }
        ]
      } as LLMChatParams)
      expect(result.content).toBe('done')
    }
  )
  it.each(['responses', 'chat-completions'] as const)(
    'projects a failed native result into a stateless tool-free explanation request on %s', async mode => {
      const output = JSON.stringify({ error: { code: 'MAGIC_AGENT_FILES_EDIT_FAILED', message: 'Step did not match.' }, report: { failed: 1, writeStatus: 'committed' }, mutation: { afterSha256: 'actual-after-state' } })
      const call = { id: 'failed-native', name: 'files.edit', wireName: 'mp_tool_3', arguments: '{"path":"a.txt"}' }
      const item = { type: 'function_call', id: 'fc_failed', call_id: call.id, name: call.wireName, arguments: call.arguments }
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBeUndefined()
        expect(body.previous_response_id).toBeUndefined()
        if (mode === 'responses') {
          expect(body.store).toBe(false)
          expect(body.input.slice(-2)).toEqual([item, { type: 'function_call_output', call_id: call.id, output }])
        } else expect(body.messages.slice(-2)).toEqual([
          { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.wireName, arguments: call.arguments } }] },
          { role: 'tool', tool_call_id: call.id, content: output }
        ])
        return response(mode === 'responses'
          ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The tool failed; no retry.' }] }] }
          : { choices: [{ message: { content: 'The tool failed; no retry.' }, finish_reason: 'stop' }] })
      })
      const cli = new OpenAIAPICli('fixture', 'https://api.openai.com/v1', 'gpt-5.4', { apiMode: mode, enableHostedTools: true, enableHostedWebSearch: true, fetchImpl: fetcher })
      const result = await cli.chat({ messages: [{ role: 'user', content: 'Explain the reported failure only.' }],
        toolTurns: [{ content: '', calls: [call], results: [{ callId: call.id, output }], ...(mode === 'responses' ? { responseItems: [item] } : {}) }],
        disableProviderTools: true, disableAutomaticImageGeneration: true, imageGenerationOptions: { enabled: false }, retryCapacity: false })
      expect(result.content).toBe('The tool failed; no retry.')
      expect(fetcher).toHaveBeenCalledOnce()
    }
  )
  it('retains a completed SSE function item even if the final response omits output', async () => {
    const item = {
      type: 'function_call',
      id: 'fc_owned',
      call_id: 'call_owned',
      name: 'mp_tool_0',
      arguments: '{"path":"a.txt"}'
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      sse([
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        {
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: 0,
          delta: item.arguments
        },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_owned', output: [] } }
      ])
    )
    const events: unknown[] = []
    const result = await create(fetcher, 'responses').chat({
      messages: [],
      tools,
      onDelta: (e) => events.push(e)
    } as LLMChatParams)
    expect(result.toolCalls?.[0]?.id).toBe('call_owned')
    expect(events).toEqual([])
  })
  it('rejects unbound native tool names without returning executable calls', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        output: [{ type: 'function_call', call_id: 'call_owned', name: 'unbound', arguments: '{}' }]
      })
    )
    await expect(
      create(fetcher, 'responses').chat({ messages: [], tools } as LLMChatParams)
    ).rejects.toThrow(/unbound/i)
  })
})

describe('native stream completion integrity', () => {
  it.each(['responses', 'chat-completions'] as const)(
    'rejects a truncated %s tool frame even when its arguments happen to be valid JSON',
    async (mode) => {
      const event =
        mode === 'responses'
          ? [
              {
                type: 'response.incomplete',
                response: {
                  incomplete_details: { reason: 'max_output_tokens' },
                  output: [
                    {
                      type: 'function_call',
                      call_id: 'call_short',
                      name: 'mp_tool_0',
                      arguments: '{}'
                    }
                  ]
                }
              }
            ]
          : [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          id: 'call_short',
                          index: 0,
                          type: 'function',
                          function: { name: 'mp_tool_0', arguments: '{}' }
                        }
                      ]
                    },
                    finish_reason: 'length'
                  }
                ]
              }
            ]
      const stream = sse(event)
      const body =
        mode === 'chat-completions'
          ? new Response((await stream.text()) + 'data: [DONE]\n\n', {
              headers: { 'content-type': 'text/event-stream' }
            })
          : stream
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(body)
      await expect(
        create(fetcher, mode).chat({ messages: [], tools, onDelta: () => {} })
      ).rejects.toThrow(/incomplete/i)
      expect(fetcher).toHaveBeenCalledOnce()
    }
  )
  it('rejects a tool finish marker with no actual calls', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      )
    await expect(
      create(fetcher, 'chat-completions').chat({ messages: [], tools, onDelta: () => {} })
    ).rejects.toThrow(/missing.*call/i)
  })
})
