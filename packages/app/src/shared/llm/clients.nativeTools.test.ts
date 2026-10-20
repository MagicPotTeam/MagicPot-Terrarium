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
