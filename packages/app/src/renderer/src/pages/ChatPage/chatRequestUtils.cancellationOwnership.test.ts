import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type CustomSkill } from '@shared/config/config'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const input = () => ({
  config: { ...DEFAULT_CONFIG, use_remote_llm: false },
  messages: [{ role: 'user' as const, content: 'Owned cancellation fixture' }],
  conversationId: 'same-chat'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each([false, true])('request-scoped cancellation (stream: %s)', (streaming) => {
  it('does not cancel an existing chat when the new request is already aborted', async () => {
    const chat = vi.fn()
    const chatStream = vi.fn()
    const cancelConversation = vi.fn()
    vi.stubGlobal('api', { svcLLMProxy: { chat, chatStream, cancelConversation } })
    const controller = new AbortController()
    controller.abort(new DOMException('Never dispatched', 'AbortError'))
    const request = { ...input(), signal: controller.signal }
    await expect(
      streaming
        ? requestChatCompletionStream({ ...request, onEvent: vi.fn() })
        : requestChatCompletion(request)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(chat).not.toHaveBeenCalled()
    expect(chatStream).not.toHaveBeenCalled()
    expect(cancelConversation).not.toHaveBeenCalled()
  })

  it('binds cancellation to one attempt, not a later request in the same conversation', async () => {
    const pending: Array<{
      request: { cancellationId: string; conversationId: string }
      resolve: (value: { content: string } | void) => void
      response?: { onData: (event: LLMChatStreamResp) => void }
    }> = []
    const transport = vi.fn(
      (request, response?) =>
        new Promise<{ content: string } | void>((resolve) => {
          pending.push({ request, response, resolve })
        })
    )
    const cancelConversation = vi.fn().mockResolvedValue({ cancelled: true })
    vi.stubGlobal('api', {
      svcLLMProxy: { chat: transport, chatStream: transport, cancelConversation }
    })
    const run = (controller: AbortController) => {
      const request = { ...input(), signal: controller.signal }
      return streaming
        ? requestChatCompletionStream({ ...request, onEvent: vi.fn() })
        : requestChatCompletion(request)
    }
    const firstController = new AbortController()
    const first = run(firstController).catch((error: unknown) => error)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    firstController.abort(new DOMException('User stopped first attempt', 'AbortError'))
    expect(await first).toMatchObject({ name: 'AbortError' })
    const second = run(new AbortController())
    await vi.waitFor(() => expect(pending).toHaveLength(2))

    expect(pending[0].request.cancellationId).toEqual(expect.any(String))
    expect(pending[1].request.cancellationId).not.toBe(pending[0].request.cancellationId)
    expect(cancelConversation).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'same-chat',
      cancellationId: pending[0].request.cancellationId
    })
    if (streaming) {
      pending[0].response!.onData({
        type: 'done',
        delta: '',
        done: true,
        content: 'Late old output'
      })
      pending[1].response!.onData({ type: 'done', delta: '', done: true, content: 'New output' })
      pending[0].resolve()
      pending[1].resolve()
    } else {
      pending[0].resolve({ content: 'Late old output' })
      pending[1].resolve({ content: 'New output' })
    }
    await expect(second).resolves.toMatchObject(
      streaming ? { result: { content: 'New output' } } : { content: 'New output' }
    )
  })
})

it.each(['external-unary', 'external-stream', 'external-stream-fallback'] as const)(
  'targets only the old attempt when cancelling %s and ignores its late completion',
  async (route) => {
    const skill: CustomSkill = {
      id: 'owned-cancellation-skill',
      type: 'agent',
      category: 'fixture',
      skillName: 'Owned cancellation skill',
      prompt: 'Fixture only',
      apiAddress: 'https://fixture.invalid/agent',
      apiKey: ''
    }
    const pending: Array<{
      request: { cancellationId: string; conversationId: string; body: string }
      response?: { onData: (event: LLMChatStreamResp) => void }
      resolve: (value?: unknown) => void
    }> = []
    const transport = vi.fn(
      (request, response?) =>
        new Promise((resolve) => {
          pending.push({ request, response, resolve })
        })
    )
    const cancelConversation = vi.fn().mockResolvedValue({ cancelled: true })
    vi.stubGlobal('api', {
      svcManagedMedia: {},
      svcLLMProxy: {
        remoteFetch: transport,
        ...(route === 'external-stream' ? { externalAgentStream: transport } : {}),
        cancelConversation
      }
    })
    const run = (controller: AbortController) => {
      const value = { ...input(), externalAgentSkill: skill, signal: controller.signal }
      return route === 'external-unary'
        ? requestChatCompletion(value)
        : requestChatCompletionStream({ ...value, onEvent: vi.fn() })
    }
    const controller = new AbortController()
    const first = run(controller).catch((error: unknown) => error)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    controller.abort(new DOMException('Stop old external request', 'AbortError'))
    expect(await first).toMatchObject({ name: 'AbortError' })
    const second = run(new AbortController())
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[0].request.cancellationId).toEqual(expect.any(String))
    expect(pending[1].request.cancellationId).not.toBe(pending[0].request.cancellationId)
    expect(cancelConversation).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'same-chat',
      cancellationId: pending[0].request.cancellationId
    })
    for (const request of pending)
      expect(JSON.parse(request.request.body)).not.toHaveProperty('cancellationId')
    for (const [index, item] of pending.entries()) {
      const content = index === 0 ? 'Ignored old external output' : 'New external output'
      if (route === 'external-stream') {
        item.response!.onData({ type: 'done', delta: '', done: true, content })
        item.resolve()
      } else item.resolve({ status: 200, statusText: 'OK', body: JSON.stringify({ content }) })
    }
    await expect(second).resolves.toMatchObject(
      route === 'external-unary'
        ? { content: 'New external output' }
        : { result: { content: 'New external output' } }
    )
    expect(cancelConversation).toHaveBeenCalledTimes(1)
  }
)
