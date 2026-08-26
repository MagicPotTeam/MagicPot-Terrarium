import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SocketHandler = (() => void) | null
type MessageHandler = ((event: { data: string }) => void) | null

type MockSocket = {
  onopen: SocketHandler
  onmessage: MessageHandler
  onclose: SocketHandler
  onerror: SocketHandler
  close: ReturnType<typeof vi.fn>
}

const { comfyHttpCliCtor, connectMock, sockets, profilesMock } = vi.hoisted(() => {
  const sockets: MockSocket[] = []
  const connectMock = vi.fn(() => {
    const socket: MockSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close: vi.fn()
    }
    sockets.push(socket)
    return socket
  })
  const comfyHttpCliCtor = vi.fn(function MockComfyHttpCli() {
    return { connect: connectMock }
  })
  const profilesMock = vi.fn()
  return { comfyHttpCliCtor, connectMock, sockets, profilesMock }
})

vi.mock('./http', () => ({
  COMFY_PROCESS_TRANSPORT_CLIENT_ID: 'test-client',
  ComfyHttpCli: comfyHttpCliCtor
}))

vi.mock('./comfyInstancePool', () => ({
  getConfiguredComfyProfiles: profilesMock
}))

import {
  getComfyState,
  initComfyStateListener,
  listenComfyEvent,
  stopComfyStateListener
} from './state'

listenComfyEvent({
  id: 'state-reconnect-test-listener',
  onEvent: vi.fn(),
  onEnd: vi.fn()
})

describe('ComfyStateManager websocket lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopComfyStateListener()
    comfyHttpCliCtor.mockClear()
    connectMock.mockClear()
    sockets.length = 0
    profilesMock.mockReset()
    profilesMock.mockReturnValue([
      { id: 'default', baseUrl: 'http://127.0.0.1:8188/', enabled: true, maxConcurrency: 1 }
    ])
  })

  afterEach(() => {
    stopComfyStateListener()
    vi.useRealTimers()
  })

  it('starts only one websocket when initialized repeatedly', () => {
    initComfyStateListener()
    initComfyStateListener()

    expect(comfyHttpCliCtor).toHaveBeenCalledTimes(1)
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
  })

  it('forwards progress events from every configured ComfyUI instance', () => {
    profilesMock.mockReturnValue([
      { id: 'first', baseUrl: 'http://127.0.0.1:8188/', enabled: true, maxConcurrency: 1 },
      { id: 'second', baseUrl: 'http://127.0.0.1:8189/', enabled: true, maxConcurrency: 1 }
    ])
    const listener = vi.fn()
    listenComfyEvent({ id: 'multi-instance-progress-listener', onEvent: listener, onEnd: vi.fn() })

    initComfyStateListener()

    expect(comfyHttpCliCtor).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(2)

    const progress = {
      type: 'progress',
      data: { prompt_id: 'task-2', value: 3, max: 10 }
    }
    sockets[1].onmessage?.({ data: JSON.stringify(progress) })

    expect(listener).toHaveBeenCalledWith(progress)
  })

  it('creates only one reconnect timer and ignores callbacks from the replaced socket', () => {
    initComfyStateListener()
    const firstSocket = sockets[0]

    firstSocket.onclose?.()
    firstSocket.onclose?.()

    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)

    firstSocket.onclose?.()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels pending reconnect and never reconnects after stop', () => {
    initComfyStateListener()
    sockets[0].onclose?.()
    expect(vi.getTimerCount()).toBe(1)

    stopComfyStateListener()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(60_000)
    expect(connectMock).toHaveBeenCalledTimes(1)
  })

  it('ignores message and close callbacks from an older generation', () => {
    initComfyStateListener()
    const oldSocket = sockets[0]
    stopComfyStateListener()

    initComfyStateListener()
    const currentSocket = sockets[1]
    currentSocket.onmessage?.({ data: JSON.stringify({ type: 'current', value: 1 }) })
    oldSocket.onmessage?.({ data: JSON.stringify({ type: 'stale', value: 2 }) })
    oldSocket.onclose?.()

    expect(getComfyState().lastMessage).toEqual({ type: 'current', value: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })
})
