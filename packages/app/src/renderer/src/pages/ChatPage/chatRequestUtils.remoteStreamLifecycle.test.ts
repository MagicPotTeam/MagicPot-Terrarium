import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import type { AbortReceiver } from '@shared/api/apiUtils/abortHandler'
import { requestChatCompletionStream } from './chatRequestUtils'

type StreamOptions = {
  abortReceiver: AbortReceiver
  onData: (event: LLMChatStreamResp) => void
}
const deadlineMs = 15 * 60 * 1000
const done: LLMChatStreamResp = {
  type: 'done',
  delta: '',
  done: true,
  content: 'Fixture completion'
}
const delta: LLMChatStreamResp = { type: 'text-delta', delta: 'Fixture delta', done: false }

const fixture = () => {
  let options!: StreamOptions
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const pending = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  const abort = vi.fn()
  const chatStream = vi.fn((_request: unknown, stream: StreamOptions) => {
    options = stream
    stream.abortReceiver.onAbort(abort)
    return pending
  })
  // Cancellation IPC may itself be stalled; it must not block renderer settlement.
  const cancelConversation = vi.fn(() => new Promise<void>(() => undefined))
  window.api = {
    svcManagedMedia: {},
    svcLLMProxy: { chatStream, cancelConversation }
  } as unknown as Window['api']
  const controller = new AbortController()
  const add = vi.spyOn(controller.signal, 'addEventListener')
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  const onEvent = vi.fn()
  const run = () =>
    requestChatCompletionStream({
      config: { ...DEFAULT_CONFIG, use_remote_llm: true },
      remoteProfile: {
        id: 'fixture-profile',
        model_name: 'gpt-4.1-mini',
        base_url: 'https://api.openai.com/v1',
        provider: 'openai',
        api_mode: 'responses'
      },
      profileId: 'fixture-profile',
      conversationId: 'fixture-watchdog',
      messages: [{ role: 'user', content: 'Fixture test only' }],
      signal: controller.signal,
      onEvent
    })
  return {
    run,
    chatStream,
    cancelConversation,
    abort,
    controller,
    add,
    remove,
    onEvent,
    resolve,
    reject,
    stream: () => options
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const expectReleased = (f: ReturnType<typeof fixture>) => {
  const registration = f.add.mock.calls.find(([type]) => type === 'abort')
  expect(registration).toBeDefined()
  expect(f.remove).toHaveBeenCalledWith('abort', registration![1])
  expect(vi.getTimerCount()).toBe(0)
}

describe('remote Responses IPC stream watchdog', () => {
  it('times out a stalled IPC, cancels it and ignores late events and rejection', async () => {
    const f = fixture()
    let settled = false
    const result = f.run().catch((error: unknown) => {
      settled = true
      return error
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.chatStream).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(deadlineMs - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await result).toMatchObject({ name: 'TimeoutError' })
    expect(f.abort).toHaveBeenCalledOnce()
    expect(f.stream().abortReceiver.isAborted()).toBe(true)
    expect(f.cancelConversation).toHaveBeenCalledWith({
      conversationId: 'fixture-watchdog',
      cancellationId: (f.chatStream.mock.calls[0][0] as { cancellationId: string }).cancellationId
    })
    expectReleased(f)
    f.stream().onData(delta)
    f.stream().onData(done)
    f.reject(new Error('Fixture late IPC rejection'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onEvent).not.toHaveBeenCalled()
  })

  it('settles immediately on caller abort even when both IPC calls remain pending', async () => {
    const f = fixture()
    let settled = false
    const result = f.run().catch((error: unknown) => {
      settled = true
      return error
    })
    await vi.advanceTimersByTimeAsync(0)
    const reason = new Error('Fixture cancellation')
    f.controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(await result).toBe(reason)
    expect(f.abort).toHaveBeenCalledOnce()
    expect(f.cancelConversation).toHaveBeenCalledOnce()
    expectReleased(f)
    f.stream().onData(delta)
    f.stream().onData(done)
    f.resolve()
    await vi.advanceTimersByTimeAsync(deadlineMs)
    expect(f.onEvent).not.toHaveBeenCalled()
    expect(f.abort).toHaveBeenCalledOnce()
  })

  it('cleans up on normal completion and ignores callbacks after completion', async () => {
    const f = fixture()
    const result = f.run()
    await vi.advanceTimersByTimeAsync(0)
    f.stream().onData(delta)
    f.stream().onData(done)
    f.resolve()
    await expect(result).resolves.toMatchObject({ result: { content: 'Fixture completion' } })
    expectReleased(f)
    expect(f.onEvent.mock.calls.map(([event]) => event.type)).toEqual(['text-delta', 'done'])
    f.stream().onData(delta)
    f.stream().onData(done)
    f.controller.abort()
    await vi.advanceTimersByTimeAsync(deadlineMs)
    expect(f.onEvent).toHaveBeenCalledTimes(2)
    expect(f.abort).not.toHaveBeenCalled()
    expect(f.cancelConversation).not.toHaveBeenCalled()
  })

  it('cleans up on IPC rejection without changing the error', async () => {
    const f = fixture()
    const result = f.run().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    const reason = new Error('Fixture IPC failure')
    f.reject(reason)
    expect(await result).toBe(reason)
    expectReleased(f)
    f.stream().onData(done)
    expect(f.onEvent).not.toHaveBeenCalled()
  })
})
