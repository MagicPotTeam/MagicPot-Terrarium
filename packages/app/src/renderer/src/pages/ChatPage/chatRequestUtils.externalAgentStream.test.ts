import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type CustomSkill } from '@shared/config/config'
import type { LLMChatStreamResp, LLMProxySvc } from '@shared/api/svcLLMProxy'
import { requestChatCompletionStream, supportsStreamingChatCompletion } from './chatRequestUtils'

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: []
  }
})

const externalAgentSkill: CustomSkill = {
  id: 'stream-fixture-agent',
  type: 'agent',
  category: 'fixture',
  skillName: 'Stream fixture agent',
  prompt: 'Reply to the fixture.',
  apiAddress: 'https://fixture.invalid/agent',
  apiKey: ''
}

type StreamResponse = {
  onData: (event: LLMChatStreamResp) => void
  abortReceiver: { onAbort: (handler: () => void) => void; isAborted: () => boolean }
}

type TestApi = {
  svcManagedMedia: Record<string, never>
  svcLLMProxy: Partial<LLMProxySvc> & {
    externalAgentStream?: (request: unknown, response: StreamResponse) => Promise<void>
  }
}

const installApi = (svcLLMProxy: TestApi['svcLLMProxy']): void => {
  window.api = {
    svcManagedMedia: {},
    svcLLMProxy
  } as unknown as Window['api']
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let index = 0; index < 100 && !predicate(); index += 1) {
    await Promise.resolve()
  }
  expect(predicate()).toBe(true)
}

const delta = (value: string): LLMChatStreamResp => ({
  type: 'text-delta',
  delta: value,
  done: false
})

const done = (content: string): LLMChatStreamResp => ({
  type: 'done',
  delta: '',
  done: true,
  fullContent: content,
  finishReason: 'stop'
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('external-agent and IPC stream completion gates', () => {
  it('fails an IPC stream that resolves without a terminal done event', async () => {
    let stream!: StreamResponse
    let resolveStream!: () => void
    const chatStream = vi.fn((_request: unknown, response: StreamResponse) => {
      stream = response
      return new Promise<void>((resolve) => {
        resolveStream = resolve
      })
    })
    installApi({ chatStream })

    const events: LLMChatStreamResp[] = []
    const request = requestChatCompletionStream({
      config: createConfig(),
      messages: [{ role: 'user', content: 'partial only' }],
      onEvent: (event) => {
        if (event.type === 'text-delta') events.push(delta(event.delta))
      }
    })

    await waitFor(() => Boolean(stream))
    stream.onData(delta('partial'))
    resolveStream!()

    await expect(request).rejects.toThrow(/incomplete-stream/i)
    expect(events).toEqual([delta('partial')])
  })

  it('does not publish a late success or event after caller abort', async () => {
    let stream!: StreamResponse
    let resolveStream!: () => void
    const chatStream = vi.fn((_request: unknown, response: StreamResponse) => {
      stream = response
      return new Promise<void>((resolve) => {
        resolveStream = resolve
      })
    })
    const cancelConversation = vi.fn(() => Promise.resolve({ cancelled: true }))
    installApi({ chatStream, cancelConversation })

    const controller = new AbortController()
    const onEvent = vi.fn()
    const request = requestChatCompletionStream({
      config: createConfig(),
      messages: [{ role: 'user', content: 'abort me' }],
      conversationId: 'stream-abort-fixture',
      signal: controller.signal,
      onEvent
    })

    await waitFor(() => Boolean(stream))
    const reason = new Error('fixture abort')
    controller.abort(reason)
    await expect(request).rejects.toBe(reason)

    stream.onData(delta('late'))
    stream.onData(done('late'))
    resolveStream!()
    await Promise.resolve()

    expect(onEvent).not.toHaveBeenCalled()
    expect(cancelConversation).toHaveBeenCalledWith({
      conversationId: 'stream-abort-fixture'
    })
  })

  it('uses the same capability gate as the UI and delivers the first external chunk before done', async () => {
    let stream!: StreamResponse
    let resolveStream!: () => void
    const externalAgentStream = vi.fn((_request: unknown, response: StreamResponse) => {
      stream = response
      return new Promise<void>((resolve) => {
        resolveStream = resolve
      })
    })
    const remoteFetch = vi.fn(() =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        body: JSON.stringify({ content: 'unary fallback must not be selected' })
      })
    )
    installApi({ externalAgentStream, remoteFetch })

    const input = {
      config: createConfig(),
      messages: [{ role: 'user' as const, content: 'stream externally' }],
      externalAgentSkill,
      conversationId: 'external-capability-fixture'
    }
    expect(supportsStreamingChatCompletion(input)).toBe(true)

    const emitted: unknown[] = []
    let settled = false
    const request = requestChatCompletionStream({
      ...input,
      onEvent: (event) => emitted.push(event)
    }).then((result) => {
      settled = true
      return result
    })

    await waitFor(() => Boolean(stream))
    stream.onData(delta('first'))
    await waitFor(() => emitted.length > 0)
    expect(emitted).toContainEqual({ type: 'text-delta', delta: 'first' })
    expect(settled).toBe(false)
    expect(remoteFetch).not.toHaveBeenCalled()

    stream.onData(done('first'))
    resolveStream!()
    await expect(request).resolves.toMatchObject({ response: 'first' })
  })

  it('keeps the legacy unary path when the external stream RPC is unavailable', async () => {
    const remoteFetch = vi.fn(() =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        body: JSON.stringify({ content: 'unary fallback' })
      })
    )
    installApi({ remoteFetch })

    const input = {
      config: createConfig(),
      messages: [{ role: 'user' as const, content: 'legacy runtime' }],
      externalAgentSkill
    }
    expect(supportsStreamingChatCompletion(input)).toBe(false)

    const events: unknown[] = []
    await expect(
      requestChatCompletionStream({
        ...input,
        onEvent: (event) => events.push(event)
      })
    ).resolves.toMatchObject({ response: 'unary fallback' })
    expect(remoteFetch).toHaveBeenCalledTimes(1)
    expect(events).toEqual([{ type: 'text-delta', delta: 'unary fallback' }, { type: 'done' }])
  })

  it('preserves tool history and last-step usage metadata when the stream fails after a tool step', async () => {
    let stream!: StreamResponse
    let rejectStream!: (reason: unknown) => void
    const chatStream = vi.fn((_request: unknown, response: StreamResponse) => {
      stream = response
      return new Promise<void>((_resolve, reject) => {
        rejectStream = reject
      })
    })
    installApi({ chatStream })

    const metadata = {
      toolHistory: [
        {
          runId: 'fixture-run-2',
          toolCallId: 'fixture-call-2',
          toolName: 'audit.write',
          status: 'failed',
          error: 'owned tool failure'
        }
      ],
      lastStepUsage: { inputTokens: 13, outputTokens: 0 }
    }
    const upstreamError = new Error('fixture stream failure')
    const request = requestChatCompletionStream({
      config: createConfig(),
      messages: [{ role: 'user', content: 'fail after tool' }],
      onEvent: vi.fn()
    })

    await waitFor(() => Boolean(stream))
    stream.onData({ type: 'text-delta', delta: 'before failure', done: false, metadata })
    rejectStream!(upstreamError)

    await expect(request).rejects.toBe(upstreamError)
    expect((upstreamError as Error & { partialContent?: string }).partialContent).toBe(
      'before failure'
    )
    expect((upstreamError as Error & { metadata?: unknown }).metadata).toEqual(metadata)
  })
})
