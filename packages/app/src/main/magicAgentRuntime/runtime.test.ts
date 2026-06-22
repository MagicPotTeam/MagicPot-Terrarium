import { describe, expect, it, vi } from 'vitest'
import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
import { MagicAgentRuntime } from './runtime'

const createRuntime = (
  replies: LLMChatResp[] | ((req: LLMChatReq) => Promise<LLMChatResp> | LLMChatResp)
) => {
  let id = 0
  let now = 1000
  const chat =
    typeof replies === 'function'
      ? vi.fn(async (req: LLMChatReq) => replies(req))
      : vi.fn(async () => replies.shift() || { content: 'done' })
  const runtime = new MagicAgentRuntime({
    chatService: { chat },
    randomUUID: () => `id-${++id}`,
    now: () => now++
  })
  return { runtime, chat }
}

describe('MagicAgentRuntime', () => {
  it('completes a no-tool chat run with the default agent', async () => {
    const { runtime, chat } = createRuntime([{ content: 'hello from agent' }])

    const result = await runtime.run({ messages: [{ role: 'user', content: 'hello' }] })

    expect(result).toMatchObject({
      runId: 'id-1',
      agentId: 'magicpot.default.chat',
      status: 'completed',
      reply: { content: 'hello from agent' }
    })
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'hello from agent' })
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'run.created',
        'run.started',
        'chat.requested',
        'chat.completed',
        'run.completed'
      ])
    )
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('does not execute model-declared tool calls unless explicitly enabled', async () => {
    const { runtime, chat } = createRuntime([
      {
        content: '/tool demo.echo {"text":"paint"}',
        metadata: { toolCalls: [{ id: 'call-1', name: 'demo.echo', args: { text: 'paint' } }] }
      }
    ])
    const handler = vi.fn(async () => ({ content: 'should not run' }))
    runtime.registerTool({
      name: 'demo.echo',
      description: 'Echo test tool.',
      inputSchema: { type: 'object' },
      handler
    })

    const result = await runtime.run({ messages: [{ role: 'user', content: 'use tool' }] })

    expect(result.status).toBe('completed')
    expect(result.toolCalls).toEqual([])
    expect(result.reply.content).toContain('/tool demo.echo')
    expect(handler).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('executes a parsed metadata tool call only when explicitly enabled and feeds the result into the next chat request', async () => {
    const { runtime, chat } = createRuntime([
      {
        content: '',
        metadata: {
          toolCalls: [
            {
              id: 'call-1',
              function: { name: 'demo.echo', arguments: '{"text":"paint"}' }
            }
          ]
        }
      },
      { content: 'tool finished' }
    ])
    runtime.registerTool({
      name: 'demo.echo',
      description: 'Echo test tool.',
      inputSchema: { type: 'object' },
      handler: async (args, context) => ({
        content: `echo:${args.text}`,
        metadata: { runId: context.runId, agentId: context.agentId }
      })
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'use tool' }],
      enableToolExecution: true
    })

    expect(result.status).toBe('completed')
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'demo.echo', args: { text: 'paint' } }])
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          name: 'demo.echo',
          toolCallId: 'call-1',
          content: expect.stringContaining('echo:paint'),
          metadata: expect.objectContaining({ toolResult: true, toolName: 'demo.echo' })
        })
      ])
    )
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('returns permission_denied when a requested tool is outside the allowlist', async () => {
    const { runtime } = createRuntime([
      {
        content: '/tool forbidden.tool {"x":1}'
      }
    ])
    runtime.registerTool({
      name: 'forbidden.tool',
      description: 'Forbidden test tool.',
      inputSchema: { type: 'object' },
      handler: async () => ({ content: 'should not run' })
    })

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'try forbidden' }],
      allowedToolNames: ['allowed.tool'],
      enableToolExecution: true
    })

    expect(result.status).toBe('permission_denied')
    expect(result.error).toContain('not allowed')
    expect(result.events.at(-1)).toMatchObject({
      type: 'run.failed',
      metadata: { status: 'permission_denied' }
    })
  })

  it('returns aborted when the input signal is already aborted', async () => {
    const { runtime, chat } = createRuntime([{ content: 'should not be requested' }])
    const controller = new AbortController()
    controller.abort('user cancelled')

    const result = await runtime.run({
      messages: [{ role: 'user', content: 'cancel' }],
      signal: controller.signal
    })

    expect(result.status).toBe('aborted')
    expect(result.error).toContain('user cancelled')
    expect(chat).not.toHaveBeenCalled()
  })

  it('returns timeout when a chat request exceeds the run timeout', async () => {
    vi.useFakeTimers()
    try {
      const { runtime } = createRuntime(() => new Promise<LLMChatResp>(() => undefined))
      const pending = runtime.run({
        messages: [{ role: 'user', content: 'slow' }],
        timeoutMs: 5
      })

      await vi.advanceTimersByTimeAsync(5)
      const result = await pending

      expect(result.status).toBe('timeout')
      expect(result.error).toContain('timed out')
      expect(result.events.at(-1)).toMatchObject({
        type: 'run.timeout',
        metadata: { status: 'timeout' }
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
