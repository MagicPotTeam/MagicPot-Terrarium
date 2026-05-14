import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerStreaming } from '../apiUtils/streaming'
import { registerIpcServer } from './registerIpcServer'

const { handleMock, onMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    on: onMock
  },
  MessagePortMain: class {}
}))

type DemoApi = {
  svcDemo: {
    ping(req: { value: string }): Promise<{ ok: boolean; value: string }>
    watch(req: { value: string }, resp: ServerStreaming<{ chunk: string }>): Promise<void>
  }
}

const apiDef = {
  svcDemo: {
    ping: { type: 'unary' },
    watch: { type: 'serverStreaming' }
  }
} as const

describe('registerIpcServer', () => {
  beforeEach(() => {
    handleMock.mockReset()
    onMock.mockReset()
  })

  it('registers unary handlers and delegates requests to the service implementation', async () => {
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(async (req) => ({ ok: true, value: req.value })),
        watch: vi.fn()
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    expect(handleMock).toHaveBeenCalledWith('svcDemo.ping', expect.any(Function))

    const handler = handleMock.mock.calls[0][1] as (
      event: unknown,
      req: { value: string }
    ) => Promise<{ ok: boolean; value: string }>
    await expect(handler({}, { value: 'demo' })).resolves.toEqual({ ok: true, value: 'demo' })
    expect(api.svcDemo.ping).toHaveBeenCalledWith({ value: 'demo' })
  })

  it('propagates unary handler failures without rewriting them', async () => {
    const failure = new Error('unary failed')
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(async () => {
          throw failure
        }),
        watch: vi.fn()
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const handler = handleMock.mock.calls[0][1] as (
      event: unknown,
      req: { value: string }
    ) => Promise<{ ok: boolean; value: string }>
    await expect(handler({}, { value: 'demo' })).rejects.toBe(failure)
  })

  it('registers server-streaming handlers and closes the port after success', async () => {
    const port = new FakeMessagePortMain()
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(async (_req, resp) => {
          expect(resp.abortReceiver?.isAborted()).toBe(false)
          resp.onData({ chunk: 'first' })
        })
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    expect(onMock).toHaveBeenCalledWith('svcDemo.watch', expect.any(Function))

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await listener({ ports: [port] }, { value: 'demo' })

    expect(port.start).toHaveBeenCalledTimes(1)
    expect(port.postMessage).toHaveBeenCalledWith({ data: { chunk: 'first' } })
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('marks streaming responses as aborted when the port sends a message or closes', async () => {
    const port = new FakeMessagePortMain()
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(async (_req, resp) => {
          port.emit('message')
          expect(resp.abortReceiver?.isAborted()).toBe(true)
          port.emit('close')
          expect(resp.abortReceiver?.isAborted()).toBe(true)
        })
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await listener({ ports: [port] }, { value: 'demo' })
  })

  it('serializes structured streaming errors and includes JSON payloads', async () => {
    const port = new FakeMessagePortMain()
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(async () => {
          throw { message: 'stream failed', code: 'E_STREAM' }
        })
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await listener({ ports: [port] }, { value: 'demo' })

    expect(port.postMessage).toHaveBeenCalledWith({
      error: {
        message: 'stream failed',
        payload: { message: 'stream failed', code: 'E_STREAM' }
      }
    })
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('wraps non-structured streaming failures into transport errors', async () => {
    const port = new FakeMessagePortMain()
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(async () => {
          throw new Error('plain stream failure')
        })
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await listener({ ports: [port] }, { value: 'demo' })

    expect(port.postMessage).toHaveBeenCalledWith({
      error: {
        message: 'plain stream failure'
      }
    })
  })

  it('falls back to Unknown error for empty non-structured streaming failures', async () => {
    const port = new FakeMessagePortMain()
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(async () => {
          throw ''
        })
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await listener({ ports: [port] }, { value: 'demo' })

    expect(port.postMessage).toHaveBeenCalledWith({
      error: {
        message: 'Unknown error'
      }
    })
  })
})

class FakeMessagePortMain {
  public readonly postMessage = vi.fn()
  public readonly close = vi.fn()
  public readonly start = vi.fn()
  private readonly listeners = new Map<string, () => void>()

  on(event: string, listener: () => void) {
    this.listeners.set(event, listener)
  }

  emit(event: string) {
    this.listeners.get(event)?.()
  }
}
