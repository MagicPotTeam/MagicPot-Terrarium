import { act, cleanup, render, waitFor } from '@testing-library/react'
import { COMFY_EVENT_CLIENT_ID_ALL } from '@shared/api/svcComfy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComfyEventProvider, useComfyEventCallback } from './useComfyEvent'

type StreamHandler = {
  abortReceiver: {
    isAborted: () => boolean
  }
  onData: (event: unknown) => void
}

type StreamCall = {
  clientId: string
  handler: StreamHandler
  resolve: () => void
  reject: (error: unknown) => void
}

const originalWindowApi = window.api
const streamHandlers = new Map<string, StreamHandler>()
let streamCalls: StreamCall[] = []
const connectWsMock = vi.fn((req: { client_id: string }, handler: StreamHandler) => {
  streamHandlers.set(req.client_id, handler)
  return new Promise<void>((resolve, reject) => {
    streamCalls.push({ clientId: req.client_id, handler, resolve, reject })
  })
})

function DefaultConsumer({ onEvent }: { onEvent: (event: unknown) => void }) {
  useComfyEventCallback((event) => onEvent(event), [])
  return null
}

function ScopedConsumer({
  clientId,
  onEvent
}: {
  clientId: string
  onEvent: (event: unknown) => void
}) {
  useComfyEventCallback((event) => onEvent(event), [], { clientId })
  return null
}

const progressEvent = (promptId: string) => ({
  type: 'progress',
  data: {
    prompt_id: promptId,
    value: 1,
    max: 2
  }
})

async function settleStream(call: StreamCall, error?: unknown) {
  await act(async () => {
    if (error) {
      call.reject(error)
    } else {
      call.resolve()
    }
    await Promise.resolve()
  })
}

function advanceTime(milliseconds: number) {
  act(() => {
    vi.advanceTimersByTime(milliseconds)
  })
}

describe('useComfyEvent', () => {
  beforeEach(() => {
    streamHandlers.clear()
    streamCalls = []
    connectWsMock.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcComfy: {
          connectWs: connectWsMock
        }
      } as unknown as Window['api']
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: originalWindowApi
    })
  })

  it('subscribes generic callbacks to the shared unfiltered event stream', async () => {
    const onEvent = vi.fn()

    render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={onEvent} />
      </ComfyEventProvider>
    )

    await waitFor(() => {
      expect(connectWsMock).toHaveBeenCalledWith(
        { client_id: COMFY_EVENT_CLIENT_ID_ALL },
        expect.objectContaining({
          onData: expect.any(Function)
        })
      )
    })

    streamHandlers.get(COMFY_EVENT_CLIENT_ID_ALL)?.onData(progressEvent('task-1'))

    expect(onEvent).toHaveBeenCalledWith(progressEvent('task-1'))
  })

  it('keeps scoped callbacks on their own client stream', async () => {
    const defaultEventSpy = vi.fn()
    const scopedEventSpy = vi.fn()
    const scopedClientId = 'canvas:thread:canvas-1:thread:agent-2'

    render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={defaultEventSpy} />
        <ScopedConsumer clientId={scopedClientId} onEvent={scopedEventSpy} />
      </ComfyEventProvider>
    )

    await waitFor(() => {
      expect(connectWsMock).toHaveBeenCalledTimes(2)
    })

    streamHandlers.get(COMFY_EVENT_CLIENT_ID_ALL)?.onData(progressEvent('task-default'))
    streamHandlers.get(scopedClientId)?.onData(progressEvent('task-scoped'))

    expect(defaultEventSpy).toHaveBeenCalledTimes(1)
    expect(defaultEventSpy).toHaveBeenCalledWith(progressEvent('task-default'))
    expect(scopedEventSpy).toHaveBeenCalledTimes(1)
    expect(scopedEventSpy).toHaveBeenCalledWith(progressEvent('task-scoped'))
  })

  it('keeps only one connection for callbacks sharing a client id', () => {
    render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={vi.fn()} />
        <DefaultConsumer onEvent={vi.fn()} />
      </ComfyEventProvider>
    )

    expect(connectWsMock).toHaveBeenCalledTimes(1)
  })

  it('reconnects with capped exponential backoff after repeated failures', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={vi.fn()} />
      </ComfyEventProvider>
    )

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const [index, delay] of expectedDelays.entries()) {
      await settleStream(streamCalls[index], new Error(`failure-${index}`))
      advanceTime(delay - 1)
      expect(connectWsMock).toHaveBeenCalledTimes(index + 1)
      advanceTime(1)
      expect(connectWsMock).toHaveBeenCalledTimes(index + 2)
    }
  })

  it('resets reconnect backoff after receiving valid data', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={vi.fn()} />
      </ComfyEventProvider>
    )

    await settleStream(streamCalls[0], new Error('first failure'))
    advanceTime(1_000)
    expect(connectWsMock).toHaveBeenCalledTimes(2)

    act(() => {
      streamCalls[1].handler.onData(progressEvent('valid-data'))
    })
    await settleStream(streamCalls[1], new Error('failure after data'))

    advanceTime(999)
    expect(connectWsMock).toHaveBeenCalledTimes(2)
    advanceTime(1)
    expect(connectWsMock).toHaveBeenCalledTimes(3)
  })

  it('cancels a pending retry when the last callback unregisters', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={vi.fn()} />
      </ComfyEventProvider>
    )

    await settleStream(streamCalls[0], new Error('failure'))
    expect(vi.getTimerCount()).toBe(1)

    view.rerender(<ComfyEventProvider>{null}</ComfyEventProvider>)
    expect(vi.getTimerCount()).toBe(0)
    advanceTime(60_000)
    expect(connectWsMock).toHaveBeenCalledTimes(1)
  })

  it('aborts an active stream and prevents its finally from reconnecting after unregister', async () => {
    vi.useFakeTimers()
    const view = render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={vi.fn()} />
      </ComfyEventProvider>
    )
    const oldCall = streamCalls[0]

    view.rerender(<ComfyEventProvider>{null}</ComfyEventProvider>)
    expect(oldCall.handler.abortReceiver.isAborted()).toBe(true)

    await settleStream(oldCall)
    advanceTime(60_000)
    expect(connectWsMock).toHaveBeenCalledTimes(1)
  })

  it('clears retry state and aborts active streams when the provider unmounts', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const activeView = render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={vi.fn()} />
      </ComfyEventProvider>
    )
    const activeCall = streamCalls[0]

    activeView.unmount()
    expect(activeCall.handler.abortReceiver.isAborted()).toBe(true)
    await settleStream(activeCall)
    advanceTime(60_000)
    expect(connectWsMock).toHaveBeenCalledTimes(1)

    const retryView = render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={vi.fn()} />
      </ComfyEventProvider>
    )
    await settleStream(streamCalls[1], new Error('failure'))
    expect(vi.getTimerCount()).toBe(1)

    retryView.unmount()
    expect(vi.getTimerCount()).toBe(0)
    advanceTime(60_000)
    expect(connectWsMock).toHaveBeenCalledTimes(2)
  })
})
