import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMFY_EVENT_CLIENT_ID_ALL } from '@shared/api/svcComfy'
import { ComfyEventProvider, useComfyEventCallback } from './useComfyEvent'

type StreamHandler = {
  onData: (event: unknown) => void
}

const originalWindowApi = window.api
const streamHandlers = new Map<string, StreamHandler>()
const connectWsMock = vi.fn(async (req: { client_id: string }, resp: StreamHandler) => {
  streamHandlers.set(req.client_id, resp)
  return new Promise<void>(() => {})
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

describe('useComfyEvent', () => {
  beforeEach(() => {
    streamHandlers.clear()
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

    streamHandlers.get(COMFY_EVENT_CLIENT_ID_ALL)?.onData({
      type: 'progress',
      data: {
        prompt_id: 'task-1',
        value: 1,
        max: 2
      }
    })

    expect(onEvent).toHaveBeenCalledWith({
      type: 'progress',
      data: {
        prompt_id: 'task-1',
        value: 1,
        max: 2
      }
    })
  })

  it('keeps scoped callbacks on their own client stream', async () => {
    const defaultEventSpy = vi.fn()
    const scopedEventSpy = vi.fn()

    render(
      <ComfyEventProvider>
        <DefaultConsumer onEvent={defaultEventSpy} />
        <ScopedConsumer clientId="canvas:thread:canvas-1:thread:agent-2" onEvent={scopedEventSpy} />
      </ComfyEventProvider>
    )

    await waitFor(() => {
      expect(connectWsMock).toHaveBeenCalledTimes(2)
    })

    streamHandlers.get(COMFY_EVENT_CLIENT_ID_ALL)?.onData({
      type: 'progress',
      data: {
        prompt_id: 'task-default',
        value: 1,
        max: 4
      }
    })
    streamHandlers.get('canvas:thread:canvas-1:thread:agent-2')?.onData({
      type: 'progress',
      data: {
        prompt_id: 'task-scoped',
        value: 3,
        max: 4
      }
    })

    expect(defaultEventSpy).toHaveBeenCalledTimes(1)
    expect(defaultEventSpy).toHaveBeenCalledWith({
      type: 'progress',
      data: {
        prompt_id: 'task-default',
        value: 1,
        max: 4
      }
    })

    expect(scopedEventSpy).toHaveBeenCalledTimes(1)
    expect(scopedEventSpy).toHaveBeenCalledWith({
      type: 'progress',
      data: {
        prompt_id: 'task-scoped',
        value: 3,
        max: 4
      }
    })
  })
})
