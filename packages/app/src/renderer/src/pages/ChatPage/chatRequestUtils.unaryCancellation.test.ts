import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type CustomSkill } from '@shared/config/config'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

type Route = 'local' | 'external' | 'external-stream-fallback'
type Outcome = { status: 'fulfilled' | 'rejected'; value: unknown }

const externalAgentSkill: CustomSkill = {
  id: 'unary-cancel-fixture',
  type: 'agent',
  category: 'fixture',
  skillName: 'Unary cancellation fixture',
  prompt: 'Respond to the fixture.',
  apiAddress: 'https://fixture.invalid/agent',
  apiKey: ''
}

const fixture = (route: Route, conversationId: string | undefined = 'fixture-unary-cancel') => {
  let resolve!: (result: unknown) => void
  let reject!: (reason: unknown) => void
  const pending = new Promise<unknown>((resolvePending, rejectPending) => {
    resolve = resolvePending
    reject = rejectPending
  })
  const transport = vi.fn(() => pending)
  // The main process and even its cancellation acknowledgement may both be stalled.
  const cancelConversation = vi.fn(() => new Promise<void>(() => undefined))
  vi.stubGlobal('api', {
    svcManagedMedia: {},
    svcLLMProxy: { chat: transport, remoteFetch: transport, cancelConversation }
  })
  const controller = new AbortController()
  const add = vi.spyOn(controller.signal, 'addEventListener')
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  const onEvent = vi.fn()
  const response =
    route === 'local'
      ? { content: 'Fixture completion' }
      : { status: 200, statusText: 'OK', body: '{"content":"Fixture completion"}' }
  let outcome: Outcome | undefined
  const run = () => {
    const input = {
      config: { ...DEFAULT_CONFIG, use_remote_llm: false },
      messages: [{ role: 'user' as const, content: 'Fixture request only' }],
      ...(route === 'local' ? {} : { externalAgentSkill }),
      conversationId,
      signal: controller.signal
    }
    const request =
      route === 'external-stream-fallback'
        ? requestChatCompletionStream({ ...input, onEvent })
        : requestChatCompletion(input)
    return request.then(
      (value) => {
        outcome = { status: 'fulfilled', value }
        return outcome
      },
      (value: unknown) => {
        outcome = { status: 'rejected', value }
        return outcome
      }
    )
  }
  return {
    run,
    transport,
    cancelConversation,
    controller,
    add,
    remove,
    onEvent,
    response,
    resolve,
    reject,
    outcome: () => outcome
  }
}

const expectReleased = (f: ReturnType<typeof fixture>) => {
  for (const [event, listener] of f.add.mock.calls) {
    if (event === 'abort') expect(f.remove).toHaveBeenCalledWith('abort', listener)
  }
  expect(vi.getTimerCount()).toBe(0)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe.each<Route>(['local', 'external', 'external-stream-fallback'])(
  '%s unary cancellation lifetime',
  (route) => {
    it('rejects pre-aborted requests without dispatching or cancelling another request', async () => {
      const f = fixture(route)
      const reason = new Error('Fixture already cancelled')
      f.controller.abort(reason)
      const result = f.run()
      await vi.advanceTimersByTimeAsync(0)

      expect(f.outcome()?.status).toBe('rejected')
      expect((await result).value).toBe(reason)
      expect(f.transport).not.toHaveBeenCalled()
      expect(f.cancelConversation).not.toHaveBeenCalled()
      expect(f.onEvent).not.toHaveBeenCalled()
      expectReleased(f)
    })

    it.each(['resolve', 'reject'] as const)(
      'settles immediately on abort, sends one cancellation, and ignores late %s',
      async (lateOutcome) => {
        const f = fixture(route)
        const result = f.run()
        await vi.advanceTimersByTimeAsync(0)
        expect(f.transport).toHaveBeenCalledOnce()

        const reason = new DOMException('Fixture user stop', 'AbortError')
        f.controller.abort(reason)
        await vi.advanceTimersByTimeAsync(0)
        expect(f.outcome()?.status).toBe('rejected')
        expect((await result).value).toBe(reason)
        expect(f.cancelConversation).toHaveBeenCalledOnce()
        expectReleased(f)

        if (lateOutcome === 'resolve') f.resolve(f.response)
        else f.reject(new Error('Fixture late transport failure'))
        await vi.advanceTimersByTimeAsync(0)
        expect(f.outcome()?.value).toBe(reason)
        expect(f.onEvent).not.toHaveBeenCalled()
        expect(f.transport).toHaveBeenCalledOnce()
        expect(f.cancelConversation).toHaveBeenCalledOnce()
        expectReleased(f)
      }
    )

    it('does not cancel a settled successful request when its caller later aborts', async () => {
      const f = fixture(route)
      const result = f.run()
      await vi.advanceTimersByTimeAsync(0)
      f.resolve(f.response)
      expect(await result).toMatchObject({
        status: 'fulfilled',
        value:
          route === 'external-stream-fallback'
            ? { response: 'Fixture completion' }
            : { content: 'Fixture completion' }
      })
      expectReleased(f)

      f.controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.cancelConversation).not.toHaveBeenCalled()
      expect(f.transport).toHaveBeenCalledOnce()
    })

    it('preserves the caller abort reason even when cancellation immediately rejects IPC', async () => {
      const f = fixture(route)
      f.cancelConversation.mockImplementation(() => {
        f.reject(new Error('Fixture transport cancellation diagnostic'))
        return Promise.resolve()
      })
      const result = f.run()
      await vi.advanceTimersByTimeAsync(0)
      const reason = new DOMException('Fixture original cancellation', 'AbortError')
      f.controller.abort(reason)
      await vi.advanceTimersByTimeAsync(0)

      expect(f.outcome()?.status).toBe('rejected')
      expect((await result).value).toBe(reason)
      expect(f.cancelConversation).toHaveBeenCalledOnce()
      expect(f.onEvent).not.toHaveBeenCalled()
      expectReleased(f)
    })

    it('handles abort during synchronous IPC invocation before its promise is returned', async () => {
      const f = fixture(route)
      const reason = new Error('Fixture stopped while invoking IPC')
      f.transport.mockImplementation(() => {
        f.controller.abort(reason)
        return new Promise<never>(() => undefined)
      })
      const result = f.run()
      await vi.advanceTimersByTimeAsync(0)

      expect(f.outcome()?.status).toBe('rejected')
      expect((await result).value).toBe(reason)
      expect(f.cancelConversation).toHaveBeenCalledOnce()
      expect(f.onEvent).not.toHaveBeenCalled()
      expectReleased(f)
    })

    it('does not accept an already fulfilled IPC response when the caller has aborted', async () => {
      const f = fixture(route)
      const reason = new Error('Fixture cancelled alongside completion')
      f.transport.mockImplementation(() => {
        const response = Promise.resolve(f.response)
        f.controller.abort(reason)
        return response
      })
      const result = f.run()
      await vi.advanceTimersByTimeAsync(0)

      expect(f.outcome()?.status).toBe('rejected')
      expect((await result).value).toBe(reason)
      expect(f.cancelConversation).toHaveBeenCalledOnce()
      expect(f.onEvent).not.toHaveBeenCalled()
      expectReleased(f)
    })

    it('settles on abort even without a conversation cancellation endpoint key', async () => {
      const f = fixture(route, '')
      const result = f.run()
      await vi.advanceTimersByTimeAsync(0)
      const reason = new Error('Fixture stop without conversation ID')
      f.controller.abort(reason)
      await vi.advanceTimersByTimeAsync(0)

      expect(f.outcome()?.status).toBe('rejected')
      expect((await result).value).toBe(reason)
      expect(f.cancelConversation).not.toHaveBeenCalled()
      expect(f.onEvent).not.toHaveBeenCalled()
      expectReleased(f)
    })

    it('keeps an AbortError from another window without normalizing away its identity', async () => {
      const f = fixture(route)
      const frame = document.createElement('iframe')
      document.body.appendChild(frame)
      try {
        const realm = frame.contentWindow as Window & typeof globalThis
        const reason = new realm.Error('Fixture cross-window cancellation')
        reason.name = 'AbortError'
        const result = f.run()
        await vi.advanceTimersByTimeAsync(0)
        f.controller.abort(reason)
        await vi.advanceTimersByTimeAsync(0)

        expect(f.outcome()?.status).toBe('rejected')
        expect((await result).value).toBe(reason)
        expect(f.cancelConversation).toHaveBeenCalledOnce()
        expectReleased(f)
      } finally {
        frame.remove()
      }
    })
  }
)
