import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const config: Config = {
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] }
}

const requestInput = () => ({
  config,
  messages: [{ role: 'user' as const, content: 'Continue the request' }],
  conversationId: 'owned-conversation'
})

const installFailure = (error: unknown) => {
  const chat = vi.fn().mockRejectedValue(error)
  const chatStream = vi.fn().mockRejectedValue(error)
  const cancelConversation = vi.fn()
  vi.stubGlobal('api', { svcLLMProxy: { chat, chatStream, cancelConversation } })
  return { chat, chatStream, cancelConversation }
}

const request = (streaming: boolean) =>
  streaming
    ? requestChatCompletionStream({ ...requestInput(), onEvent: vi.fn() })
    : requestChatCompletion(requestInput())

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each([false, true])('local IPC service errors (streaming: %s)', (streaming) => {
  it('preserves a structured active-conversation error without cancelling or retrying the owner', async () => {
    const transport = {
      message: 'A request is already active for conversation "owned-conversation".',
      code: 'LLM_CONVERSATION_REQUEST_ACTIVE'
    }
    const calls = installFailure(transport)
    const failure = await request(streaming).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject(transport)
    expect((failure as Error).message).not.toContain('[object Object]')
    expect(streaming ? calls.chatStream : calls.chat).toHaveBeenCalledOnce()
    expect(calls.cancelConversation).not.toHaveBeenCalled()
    expect(transport).not.toHaveProperty('partialContent')
  })

  it('retains typed service diagnostics across a plain-object rejection', async () => {
    const transport = {
      message: 'Service unavailable',
      name: 'ServiceError',
      code: 'UPSTREAM_UNAVAILABLE',
      statusCode: 503,
      body: '{"error":{"code":"server_overloaded"}}'
    }
    installFailure(transport)

    await expect(request(streaming)).rejects.toMatchObject({
      message: transport.message,
      name: transport.name,
      code: transport.code,
      status: 503,
      body: transport.body
    })
  })

  it('keeps the original Error identity and code', async () => {
    const original = Object.assign(new Error('Original diagnostic'), { code: 'OWNED_ERROR' })
    installFailure(original)
    await expect(request(streaming)).rejects.toBe(original)
    expect(original.code).toBe('OWNED_ERROR')
  })

  it('maps structured Responses-permission errors without dropping the service code', async () => {
    installFailure({
      message: '401 Missing scopes: api.responses.write',
      code: 'AUTHENTICATION_ERROR',
      status: 401
    })
    await expect(request(streaming)).rejects.toMatchObject({
      message: expect.stringContaining('missing the required Responses permission'),
      code: 'AUTHENTICATION_ERROR',
      status: 401
    })
  })

  it('still accepts string failures', async () => {
    installFailure('Transport disconnected')
    await expect(request(streaming)).rejects.toThrow('Transport disconnected')
  })
})

it('attaches streamed content and checkpoints to a structured failure', async () => {
  const metadata = { toolHistory: [{ toolCallId: 'completed-tool', status: 'completed' }] }
  const chatStream = vi.fn(
    async (_request: unknown, response: { onData: (chunk: LLMChatStreamResp) => void }) => {
      response.onData({ type: 'text-delta', delta: 'Keep this output', done: false, metadata })
      throw { message: 'Transport failed', code: 'STREAM_FAILED', status: 502 }
    }
  )
  vi.stubGlobal('api', { svcLLMProxy: { chatStream } })

  await expect(request(true)).rejects.toMatchObject({
    message: 'Transport failed',
    code: 'STREAM_FAILED',
    status: 502,
    partialContent: 'Keep this output',
    metadata,
    partialResult: { content: 'Keep this output', metadata }
  })
  expect(chatStream).toHaveBeenCalledOnce()
})
