import { actionsFromArray, type AgentAction } from '@shared/agent'
import { describe, expect, it, vi } from 'vitest'
import { AgentKernel } from './index'

const event = (eventId = 'event-1') => ({
  eventId,
  type: 'test.requested',
  payload: { value: 1 },
  createdAt: 1,
  correlationId: 'correlation-1',
  sessionId: 'session-1',
  agentId: 'agent-1',
  provenance: { source: 'test', requestedBy: 'vitest' }
})

const collect = async (actions: AsyncIterable<AgentAction>): Promise<AgentAction[]> => {
  const result: AgentAction[] = []
  for await (const action of actions) result.push(action)
  return result
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AgentKernel dispatch', () => {
  it('streams actions before handler completion and preserves order', async () => {
    const kernel = new AgentKernel()
    const release = deferred()
    kernel.registerActionHandler('test.requested', async function* () {
      yield { actionId: 'action-2', type: 'test.second', payload: { order: 2 } }
      await release.promise
      yield { actionId: 'action-1', type: 'test.first', payload: { order: 1 } }
    })

    const iterator = kernel.dispatch(event())[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { actionId: 'action-2' } })
    const pending = iterator.next()
    let completed = false
    void pending.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    release.resolve()
    await expect(pending).resolves.toMatchObject({ value: { actionId: 'action-1' } })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('supports the array adapter and unregistering handlers', async () => {
    const kernel = new AgentKernel()
    const unregister = kernel.registerActionHandler('test.requested', () =>
      actionsFromArray([{ actionId: 'action-1', type: 'test.done', payload: null }])
    )
    await expect(collect(kernel.dispatch(event()))).resolves.toHaveLength(1)
    unregister()
    await expect(collect(kernel.dispatch(event('event-2')))).rejects.toThrow(
      'No Agent action handler has been registered for "test.requested".'
    )
  })

  it('propagates AbortSignal and consumer cancellation into the handler', async () => {
    const kernel = new AgentKernel()
    const observed = deferred()
    kernel.registerActionHandler('test.requested', async function* (_event, context) {
      yield { actionId: 'action-1', type: 'test.started', payload: null }
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => {
            observed.resolve()
            reject(context.signal.reason)
          },
          { once: true }
        )
      })
    })

    const iterator = kernel.dispatch(event())[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    await observed.promise

    const preAborted = new AbortController()
    preAborted.abort('stopped')
    expect(() => kernel.dispatch(event('event-2'), preAborted.signal)).toThrowError(
      expect.objectContaining({ name: 'AbortError', message: 'stopped' })
    )
  })

  it('detaches one cancelled subscriber while another shared subscriber completes', async () => {
    const kernel = new AgentKernel()
    const release = deferred()
    const handlerAborted = vi.fn()
    kernel.registerActionHandler('test.requested', async function* (_event, context) {
      context.signal.addEventListener('abort', handlerAborted, { once: true })
      yield { actionId: 'action-1', type: 'test.started', payload: null }
      await release.promise
      yield { actionId: 'action-2', type: 'test.done', payload: null }
    })

    const cancelled = new AbortController()
    const first = kernel.dispatch(event(), cancelled.signal)[Symbol.asyncIterator]()
    const second = kernel.dispatch(event())[Symbol.asyncIterator]()
    await Promise.all([first.next(), second.next()])
    const firstPending = first.next()
    const secondPending = second.next()
    cancelled.abort('subscriber stopped')
    await expect(firstPending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'subscriber stopped'
    })
    expect(handlerAborted).not.toHaveBeenCalled()
    release.resolve()
    await expect(secondPending).resolves.toMatchObject({ value: { actionId: 'action-2' } })
    await expect(second.next()).resolves.toEqual({ done: true, value: undefined })
    expect(handlerAborted).not.toHaveBeenCalled()
  })

  it('detaches an early-returning subscriber while another shared subscriber completes', async () => {
    const kernel = new AgentKernel()
    const release = deferred()
    const handlerAborted = vi.fn()
    kernel.registerActionHandler('test.requested', async function* (_event, context) {
      context.signal.addEventListener('abort', handlerAborted, { once: true })
      yield { actionId: 'action-1', type: 'test.started', payload: null }
      await release.promise
      yield { actionId: 'action-2', type: 'test.done', payload: null }
    })

    const first = kernel.dispatch(event())[Symbol.asyncIterator]()
    const second = kernel.dispatch(event())[Symbol.asyncIterator]()
    await Promise.all([first.next(), second.next()])
    const secondPending = second.next()
    await first.return?.()
    expect(handlerAborted).not.toHaveBeenCalled()
    release.resolve()
    await expect(secondPending).resolves.toMatchObject({ value: { actionId: 'action-2' } })
    await expect(second.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('snapshots handler input and defensively clones streamed and replayed actions', async () => {
    const kernel = new AgentKernel()
    let handlerEventPayload: unknown
    kernel.registerActionHandler('test.requested', (received) => {
      handlerEventPayload = received.payload
      ;(received.payload as { value: number }).value = 99
      return actionsFromArray([
        { actionId: 'action-1', type: 'test.done', payload: { nested: { value: 1 } } }
      ])
    })
    const input = event()
    const first = await collect(kernel.dispatch(input))
    ;(input.payload as { value: number }).value = 42
    ;(first[0].payload as { nested: { value: number } }).nested.value = 77

    const replay = await collect(kernel.dispatch(event()))
    expect(handlerEventPayload).toEqual({ value: 99 })
    expect(replay).toEqual([
      { actionId: 'action-1', type: 'test.done', payload: { nested: { value: 1 } } }
    ])
  })

  it('joins concurrent duplicates and replays the same successful actions', async () => {
    const kernel = new AgentKernel()
    const release = deferred()
    const handler = vi.fn(async function* () {
      yield { actionId: 'action-1', type: 'test.first', payload: null }
      await release.promise
      yield { actionId: 'action-2', type: 'test.second', payload: null }
    })
    kernel.registerActionHandler('test.requested', handler)

    const first = collect(kernel.dispatch(event()))
    const second = collect(kernel.dispatch(event()))
    release.resolve()
    const expected = [
      { actionId: 'action-1', type: 'test.first', payload: null },
      { actionId: 'action-2', type: 'test.second', payload: null }
    ]
    await expect(first).resolves.toEqual(expected)
    await expect(second).resolves.toEqual(expected)
    await expect(collect(kernel.dispatch(event()))).resolves.toEqual(expected)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('shares a failure with concurrent subscribers and retries after they detach', async () => {
    const kernel = new AgentKernel()
    const release = deferred()
    const failure = new Error('handler failed')
    let attempt = 0
    const handler = vi.fn(async function* () {
      await release.promise
      if (attempt++ === 0) throw failure
      yield { actionId: 'retry-action', type: 'test.done', payload: null }
    })
    kernel.registerActionHandler('test.requested', handler)

    const first = collect(kernel.dispatch(event()))
    const second = collect(kernel.dispatch(event()))
    release.resolve()
    await expect(first).rejects.toBe(failure)
    await expect(second).rejects.toBe(failure)
    await expect(collect(kernel.dispatch(event()))).resolves.toEqual([
      { actionId: 'retry-action', type: 'test.done', payload: null }
    ])
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('allows the same event ID to retry after its only subscriber aborts', async () => {
    const kernel = new AgentKernel()
    let attempt = 0
    const handler = vi.fn(async function* (_event, context) {
      if (attempt++ === 0) {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true
          })
        })
      }
      yield { actionId: 'retry-action', type: 'test.done', payload: null }
    })
    kernel.registerActionHandler('test.requested', handler)

    const controller = new AbortController()
    const first = collect(kernel.dispatch(event(), controller.signal))
    controller.abort('cancel first attempt')
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    await expect(collect(kernel.dispatch(event()))).resolves.toEqual([
      { actionId: 'retry-action', type: 'test.done', payload: null }
    ])
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('validates events and handler outputs', async () => {
    const kernel = new AgentKernel()
    kernel.registerActionHandler('test.requested', () =>
      actionsFromArray([{ actionId: '', type: 'test.done', payload: null }])
    )

    expect(() => kernel.dispatch({ ...event(), eventId: '' })).toThrow('eventId is required')
    expect(() => kernel.dispatch({ ...event(), type: '' })).toThrow('type is required')
    expect(() => kernel.dispatch({ ...event(), createdAt: Number.NaN })).toThrow(
      'createdAt must be finite and nonnegative'
    )
    expect(() => kernel.dispatch({ ...event(), createdAt: -1 })).toThrow(
      'createdAt must be finite and nonnegative'
    )
    expect(() => kernel.dispatch({ ...event(), payload: { value: BigInt(1) } as never })).toThrow(
      'payload must be JSON serializable'
    )
    await expect(collect(kernel.dispatch(event('bad-output')))).rejects.toThrow(
      'actionId is required'
    )

    const wrongOutput = new AgentKernel()
    wrongOutput.registerActionHandler('test.requested', (() => []) as never)
    await expect(collect(wrongOutput.dispatch(event('wrong-output')))).rejects.toThrow(
      'must return an AsyncIterable'
    )
  })

  it('scopes action IDs to an event and rejects conflicting duplicates within an event', async () => {
    const kernel = new AgentKernel()
    kernel.registerActionHandler('test.requested', ({ eventId }) =>
      actionsFromArray([{ actionId: 'shared', type: 'test.done', payload: { eventId } }])
    )
    await expect(collect(kernel.dispatch(event()))).resolves.toHaveLength(1)
    await expect(collect(kernel.dispatch(event('event-2')))).resolves.toHaveLength(1)

    const conflicting = new AgentKernel()
    conflicting.registerActionHandler('test.requested', () =>
      actionsFromArray([
        { actionId: 'shared', type: 'test.done', payload: { value: 1 } },
        { actionId: 'shared', type: 'test.done', payload: { value: 2 } }
      ])
    )
    await expect(collect(conflicting.dispatch(event()))).rejects.toThrow(
      'Conflicting Agent action already exists'
    )
  })

  it('bounds completed dispatch retention and rejects conflicting event ID reuse while retained', async () => {
    const kernel = new AgentKernel({ maxDispatchResults: 1 })
    const handler = vi.fn(({ eventId }) =>
      actionsFromArray([{ actionId: eventId, type: 'test.done', payload: null }])
    )
    kernel.registerActionHandler('test.requested', handler)

    await collect(kernel.dispatch(event('event-1')))
    await expect(
      collect(kernel.dispatch({ ...event('event-1'), payload: { value: 2 } }))
    ).rejects.toThrow('Conflicting Agent event already exists')
    await collect(kernel.dispatch(event('event-2')))
    await collect(kernel.dispatch(event('event-1')))
    expect(handler).toHaveBeenCalledTimes(3)
  })
})
