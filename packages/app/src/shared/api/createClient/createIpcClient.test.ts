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
})

class FakeMessagePort {
  public onmessage?: (event: { data: unknown }) => void
  public onmessageerror?: (event: { data: { toString: () => string } }) => void
  public closed = false
  private readonly listeners = new Map<string, () => void>()

  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener)
  }

  close() {
    this.closed = true
    this.listeners.get('close')?.()
  }
}

class FakeMessageChannel {
  public readonly port1 = new FakeMessagePort()
  public readonly port2 = { transferred: true }
}
