import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import type { AbortReceiver } from '@shared/api/apiUtils/abortHandler'
import { requestChatCompletionStream } from './chatRequestUtils'

type StreamOptions = {
  abortReceiver: AbortReceiver
  onData: (event: LLMChatStreamResp) => void
}

const idleMs = 15 * 60 * 1000
const minuteMs = 60 * 1000
const done: LLMChatStreamResp = {
  type: 'done',
  delta: '',
  done: true,
  content: 'Fixture completion'
}
const retry = (attempt = 1, delayMs = minuteMs, nextRetryAt = Date.now() + delayMs) =>
  ({
    type: 'retry',
    delta: '',
    done: false,
    retry: { attempt, delayMs, nextRetryAt, reason: 'server-overloaded' }
  }) satisfies LLMChatStreamResp

const fixture = () => {
  let options!: StreamOptions
  let reject!: (reason: unknown) => void
  const pending = new Promise<void>((_resolve, rejectPending) => {
    reject = rejectPending
  })
  const abort = vi.fn()
  const chatStream = vi.fn((_request: unknown, stream: StreamOptions) => {
    options = stream
    stream.abortReceiver.onAbort(abort)
    return pending
  })
  const cancelConversation = vi.fn(() => new Promise<void>(() => undefined))
  vi.stubGlobal('api', { svcManagedMedia: {}, svcLLMProxy: { chatStream, cancelConversation } })
  const controller = new AbortController()
  const add = vi.spyOn(controller.signal, 'addEventListener')
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  const onEvent = vi.fn()
  let settled = false
  const run = () =>
    requestChatCompletionStream({
      config: { ...DEFAULT_CONFIG, use_remote_llm: false },
      messages: [{ role: 'user', content: 'Fixture test only' }],
      conversationId: 'fixture-retry-watchdog',
      signal: controller.signal,
      onEvent
    }).then(
      (result) => {
        settled = true
        return result
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )
  return {
    run,
    abort,
    chatStream,
    cancelConversation,
    controller,
    onEvent,
    add,
    remove,
    reject,
    emit: (event: LLMChatStreamResp) => options.onData(event),
    settled: () => settled
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const expectReleased = (f: ReturnType<typeof fixture>) => {
  const registration = f.add.mock.calls.find(([type]) => type === 'abort')
  expect(registration).toBeDefined()
  expect(f.remove).toHaveBeenCalledWith('abort', registration![1])
  expect(vi.getTimerCount()).toBe(0)
}

describe('IPC stream retry watchdog', () => {
  it('keeps active capacity retries alive beyond the original fifteen-minute deadline', async () => {
    const f = fixture()
    const result = f.run()
    await vi.advanceTimersByTimeAsync(0)
    for (let attempt = 1; attempt <= 5; attempt++) {
      f.emit(retry(attempt))
      await vi.advanceTimersByTimeAsync(14 * minuteMs)
      expect(f.settled()).toBe(false)
      expect(vi.getTimerCount()).toBe(1)
    }
    f.emit(done)
    expect(await result).toMatchObject({ result: { content: 'Fixture completion' } })
    expect(f.chatStream).toHaveBeenCalledOnce()
    expect(f.onEvent).toHaveBeenCalledTimes(6)
    expect(f.abort).not.toHaveBeenCalled()
    expect(f.cancelConversation).not.toHaveBeenCalled()
    expectReleased(f)
  })

  it('refreshes the idle window for genuine output, not only retries', async () => {
    const f = fixture()
    const result = f.run()
    await vi.advanceTimersByTimeAsync(14 * minuteMs)
    f.emit({ type: 'text-delta', delta: 'Still streaming', done: false })
    await vi.advanceTimersByTimeAsync(14 * minuteMs)
    expect(f.settled()).toBe(false)
    f.emit(done)
    expect(await result).toMatchObject({ result: { content: 'Fixture completion' } })
    expect(f.abort).not.toHaveBeenCalled()
    expectReleased(f)
  })

  it.each(['delay', 'next-retry-at'] as const)(
    'respects a long advertised retry %s, then times out if the stream goes silent',
    async (advice) => {
      const f = fixture()
      const result = f.run()
      await vi.advanceTimersByTimeAsync(0)
      const waitMs = 30 * minuteMs
      f.emit(
        retry(
          1,
          advice === 'delay' ? waitMs : minuteMs,
          Date.now() + (advice === 'next-retry-at' ? waitMs : minuteMs)
        )
      )
      await vi.advanceTimersByTimeAsync(waitMs + idleMs - 1)
      expect(f.settled()).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await result).toMatchObject({ name: 'TimeoutError' })
      expect(f.abort).toHaveBeenCalledOnce()
      expect(f.cancelConversation).toHaveBeenCalledOnce()
      expectReleased(f)
      f.emit(retry(2))
      f.emit(done)
      expect(f.onEvent).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('restores the normal idle window when a delayed retry actually starts', async () => {
    const f = fixture()
    const result = f.run()
    await vi.advanceTimersByTimeAsync(0)
    f.emit(retry(1, 30 * minuteMs))
    await vi.advanceTimersByTimeAsync(30 * minuteMs)
    f.emit(retry(1, 0))
    await vi.advanceTimersByTimeAsync(idleMs - 1)
    expect(f.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ name: 'TimeoutError' })
    expectReleased(f)
  })

  it('segments very long retry waits and cancels immediately without waiting for IPC', async () => {
    const f = fixture()
    const setTimeout = vi.spyOn(window, 'setTimeout')
    const result = f.run()
    await vi.advanceTimersByTimeAsync(0)
    f.emit(retry(1, 2 ** 31 + minuteMs))
    await vi.advanceTimersByTimeAsync(2 * idleMs)
    expect(f.settled()).toBe(false)
    expect(setTimeout.mock.calls.every(([, delay]) => Number(delay) <= idleMs)).toBe(true)
    const reason = new Error('Fixture user cancellation')
    f.controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.settled()).toBe(true)
    expect(await result).toBe(reason)
    expect(f.abort).toHaveBeenCalledOnce()
    expect(f.cancelConversation).toHaveBeenCalledOnce()
    expectReleased(f)
    f.emit(retry(2))
    f.emit(done)
    f.reject(new Error('Fixture late rejection'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onEvent).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases an extended watchdog after transport failure', async () => {
    const f = fixture()
    const result = f.run()
    await vi.advanceTimersByTimeAsync(0)
    f.emit(retry(1, 30 * minuteMs))
    const reason = new Error('Fixture terminal failure')
    f.reject(reason)
    expect(await result).toBe(reason)
    expectReleased(f)
    f.emit(done)
    await vi.advanceTimersByTimeAsync(45 * minuteMs)
    expect(f.onEvent).toHaveBeenCalledTimes(1)
    expect(f.cancelConversation).not.toHaveBeenCalled()
  })

  it('does not let invalid or empty events renew a stalled stream', async () => {
    const f = fixture()
    const result = f.run()
    await vi.advanceTimersByTimeAsync(14 * minuteMs)
    f.emit({ type: 'unknown', done: false, delta: '' } as unknown as LLMChatStreamResp)
    f.emit({ type: 'text-delta', done: false, delta: '' })
    f.emit({ type: 'attachment', done: false, delta: '' })
    expect(() => f.emit(retry(0, 30 * minuteMs))).toThrow('Invalid model retry event')
    await vi.advanceTimersByTimeAsync(minuteMs)
    expect(await result).toMatchObject({ name: 'TimeoutError' })
    expect(f.onEvent).not.toHaveBeenCalled()
    expectReleased(f)
  })

  it('settles a pre-aborted request without cancelling another request in the conversation', async () => {
    const f = fixture()
    const reason = new Error('Fixture already cancelled')
    f.controller.abort(reason)
    const result = f.run()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.settled()).toBe(true)
    expect(await result).toBe(reason)
    expect(f.chatStream).not.toHaveBeenCalled()
    expect(f.cancelConversation).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
