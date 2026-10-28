import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIpcClient } from './createIpcClient'
import type { ServerStreaming } from '../apiUtils/streaming'

const { invokeMock, postMessageMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  postMessageMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: invokeMock,
    postMessage: postMessageMock
  }
}))

type TestApi = {
  svcDemo: {
    ping(req: { value: string }): Promise<{ ok: boolean }>
    watch(req: { value: string }, resp: ServerStreaming<{ chunk: string }>): Promise<void>
  }
}

describe('createIpcClient', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    postMessageMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const createDemoClient = () =>
    createIpcClient<TestApi>({
      svcDemo: {
        ping: { type: 'unary' },
        watch: { type: 'serverStreaming' }
      }
    })

  it('forwards unary requests and returns the IPC response', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true })

    const client = createDemoClient()

    await expect(client.svcDemo.ping({ value: 'demo' })).resolves.toEqual({ ok: true })
    expect(invokeMock).toHaveBeenCalledWith('svcDemo.ping', { value: 'demo' })
  })

  it('strips the Electron remote method wrapper from unary errors', async () => {
    invokeMock.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'svcDemo.ping': [Hunyuan3D] 当前配置的腾讯云 SecretId 无效或已失效。"
      )
    )

    const client = createDemoClient()

    const error = await client.svcDemo.ping({ value: 'demo' }).then(
      () => {
        throw new Error('Expected unary invoke to fail')
      },
      (caught): Error => caught as Error
    )

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('[Hunyuan3D] 当前配置的腾讯云 SecretId 无效或已失效。')
    expect(error.message).not.toContain('Error invoking remote method')
  })

  it('keeps non-wrapped unary errors unchanged', async () => {
    invokeMock.mockRejectedValueOnce(new Error('Network timeout'))

    const client = createDemoClient()

    await expect(client.svcDemo.ping({ value: 'demo' })).rejects.toThrow('Network timeout')
  })

  it('normalizes non-error unary rejections into Error instances', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'E_DEMO' })

    const client = createDemoClient()

    await expect(client.svcDemo.ping({ value: 'demo' })).rejects.toThrow('{"code":"E_DEMO"}')
  })

  it('normalizes primitive unary rejections into Error instances', async () => {
    invokeMock.mockRejectedValueOnce('primitive failure')

    const client = createDemoClient()

    await expect(client.svcDemo.ping({ value: 'demo' })).rejects.toThrow('primitive failure')
  })

  it('streams server messages through a transferred message port', async () => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const onData = vi.fn()
    const client = createDemoClient()

    const promise = client.svcDemo.watch({ value: 'demo' }, { onData })

    expect(postMessageMock).toHaveBeenCalledWith('svcDemo.watch', { value: 'demo' }, [
      channels[0].port2
    ])

    channels[0].port1.onmessage?.({ data: { data: { chunk: 'first' } } })
    channels[0].port1.close()

    await expect(promise).resolves.toBeUndefined()
    expect(onData).toHaveBeenCalledWith({ chunk: 'first' })
  })

  it('settles and closes the local stream when posting to IPC fails synchronously', async () => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const failure = new Error('renderer IPC is unavailable')
    postMessageMock.mockImplementationOnce(() => {
      throw failure
    })

    const promise = createDemoClient().svcDemo.watch({ value: 'demo' }, { onData: vi.fn() })

    await expect(promise).rejects.toBe(failure)
    expect(channels[0].port1.closed).toBe(true)
    expect(channels[0].port2.closed).toBe(true)
  })

  it('rejects streaming calls when the transport sends an error', async () => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const client = createDemoClient()

    const promise = client.svcDemo.watch({ value: 'demo' }, { onData: vi.fn() })
    channels[0].port1.onmessage?.({ data: { error: { message: 'stream failed' } } })

    await expect(promise).rejects.toEqual({ message: 'stream failed' })
  })

  it('turns message-port delivery failures into structured streaming errors', async () => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const client = createDemoClient()

    const promise = client.svcDemo.watch({ value: 'demo' }, { onData: vi.fn() })
    channels[0].port1.onmessageerror?.({ data: { toString: () => 'bad port payload' } })

    await expect(promise).rejects.toEqual({ message: 'bad port payload' })
  })

  it('falls back to an unknown streaming error when message-port failures are empty', async () => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const client = createDemoClient()

    const promise = client.svcDemo.watch({ value: 'demo' }, { onData: vi.fn() })
    channels[0].port1.onmessageerror?.({ data: { toString: () => '' } })

    await expect(promise).rejects.toEqual({ message: 'Unknown error' })
  })

  it('closes the client port when the caller aborts a streaming request', async () => {
    const channels: FakeMessageChannel[] = []
    let abortHandler: (() => void) | undefined
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const client = createDemoClient()

    const promise = client.svcDemo.watch(
      { value: 'demo' },
      {
        onData: vi.fn(),
        abortReceiver: {
          isAborted: () => false,
          onAbort: (handler) => {
            abortHandler = handler
          }
        }
      }
    )

    abortHandler?.()

    await expect(promise).resolves.toBeUndefined()
    expect(channels[0].port1.closed).toBe(true)
  })

  it('rejects callback exceptions without leaving the stream open or accepting late data', async () => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const failure = Object.assign(new Error('Invalid tool-status event'), {
      code: 'INVALID_STREAM_EVENT',
      metadata: { toolHistory: [{ toolCallId: 'owned', status: 'completed' }] }
    })
    const onData = vi.fn(() => {
      throw failure
    })
    const promise = createDemoClient().svcDemo.watch({ value: 'demo' }, { onData })
    const outcome = promise.catch((error: unknown) => error)
    const port = channels[0].port1
    const deliver = port.onmessage!

    expect(() => deliver({ data: { data: { chunk: 'invalid' } } })).not.toThrow()
    expect(await outcome).toBe(failure)
    expect(port.closed).toBe(true)
    deliver({ data: { data: { chunk: 'late' } } })
    port.close()
    expect(onData).toHaveBeenCalledOnce()
  })

  it('closes rejected transports and ignores queued data after their structured error', async () => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const failure = { message: 'Owned stream failure', code: 'OWNED_FAILURE', status: 503 }
    const onData = vi.fn()
    const promise = createDemoClient().svcDemo.watch({ value: 'demo' }, { onData })
    const outcome = promise.catch((error: unknown) => error)
    const port = channels[0].port1
    const deliver = port.onmessage!

    deliver({ data: { error: failure } })
    expect(await outcome).toBe(failure)
    expect(port.closed).toBe(true)
    deliver({ data: { data: { chunk: 'late' } } })
    expect(onData).not.toHaveBeenCalled()
  })

  it.each([undefined, null])('settles messageerror events with %s data', async (data) => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const promise = createDemoClient().svcDemo.watch({ value: 'demo' }, { onData: vi.fn() })
    const outcome = promise.catch((error: unknown) => error)
    const port = channels[0].port1

    expect(() => port.onmessageerror?.({ data })).not.toThrow()
    expect(await outcome).toEqual({ message: 'Unknown error' })
    expect(port.closed).toBe(true)
  })

  it('normalizes non-string messageerror representations to Unknown error', async () => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const promise = createDemoClient().svcDemo.watch({ value: 'demo' }, { onData: vi.fn() })
    const outcome = promise.catch((error: unknown) => error)
    const port = channels[0].port1

    port.onmessageerror?.({ data: { toString: () => ({ unexpected: true }) } })

    await expect(outcome).resolves.toEqual({ message: 'Unknown error' })
    expect(port.closed).toBe(true)
  })

  it('ignores queued data and repeated aborts after local cancellation', async () => {
    const channels: FakeMessageChannel[] = []
    let abortHandler: (() => void) | undefined
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const onData = vi.fn()
    const promise = createDemoClient().svcDemo.watch(
      { value: 'demo' },
      {
        onData,
        abortReceiver: {
          isAborted: () => false,
          onAbort: (handler) => {
            abortHandler = handler
          }
        }
      }
    )
    const port = channels[0].port1
    const close = vi.spyOn(port, 'close')
    const deliver = port.onmessage!
    abortHandler?.()
    await expect(promise).resolves.toBeUndefined()
    abortHandler?.()
    deliver({ data: { data: { chunk: 'late' } } })

    expect(onData).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('settles only after the last queued data event is delivered before remote close', async () => {
    const channels: FakeMessageChannel[] = []
    vi.stubGlobal(
      'MessageChannel',
      class extends FakeMessageChannel {
        constructor() {
          super()
          channels.push(this)
        }
      }
    )
    const onData = vi.fn()
    const promise = createDemoClient().svcDemo.watch({ value: 'demo' }, { onData })
    const port = channels[0].port1
    const deliver = port.onmessage!
    deliver({ data: { data: { chunk: 'first' } } })
    deliver({ data: { data: { chunk: 'done' } } })
    expect(port.closed).toBe(false)
    port.close()
    await expect(promise).resolves.toBeUndefined()
    deliver({ data: { data: { chunk: 'late' } } })

    expect(onData.mock.calls).toEqual([[{ chunk: 'first' }], [{ chunk: 'done' }]])
  })
})

class FakeMessagePort {
  public onmessage?: (event: { data: unknown }) => void
  public onmessageerror?: (event: { data: unknown }) => void
  public closed = false
  private readonly listeners = new Map<string, () => void>()

  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener)
  }

  removeEventListener(event: string, listener: () => void) {
    if (this.listeners.get(event) === listener) this.listeners.delete(event)
  }

  close() {
    this.closed = true
    this.listeners.get('close')?.()
  }
}

class FakeMessageChannel {
  public readonly port1 = new FakeMessagePort()
  public readonly port2 = Object.assign(new FakeMessagePort(), { transferred: true })
}
