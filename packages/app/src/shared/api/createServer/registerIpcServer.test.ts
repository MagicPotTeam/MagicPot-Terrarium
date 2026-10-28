import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerStreaming } from '../apiUtils/streaming'
import { registerIpcServer } from './registerIpcServer'

const { handleMock, onMock, consoleErrorMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  consoleErrorMock: vi.fn()
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
    consoleErrorMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(consoleErrorMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
      event: {
        sender?: { id?: number; getURL?: () => string }
        senderFrame?: { url?: string; parent?: unknown }
      },
      req: { value: string }
    ) => Promise<{ ok: boolean; value: string }>
    await expect(
      handler(
        {
          sender: { id: 42, getURL: () => 'app://renderer/index.html' },
          senderFrame: { url: 'app://renderer/index.html#/agent-studio', parent: null }
        },
        { value: 'demo' }
      )
    ).resolves.toEqual({ ok: true, value: 'demo' })
    expect(api.svcDemo.ping).toHaveBeenCalledWith(
      { value: 'demo' },
      expect.objectContaining({
        methodName: 'svcDemo.ping',
        senderId: 42,
        senderUrl: 'app://renderer/index.html',
        frameUrl: 'app://renderer/index.html#/agent-studio',
        isMainFrame: true
      })
    )
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
      event: {
        ports: FakeMessagePortMain[]
        sender?: { id?: number; getURL?: () => string }
        senderFrame?: { url?: string; parent?: unknown }
      },
      req: { value: string }
    ) => Promise<void>
    await listener(
      {
        ports: [port],
        sender: { id: 7, getURL: () => 'app://renderer/index.html' },
        senderFrame: { url: 'app://renderer/index.html#/watch', parent: null }
      },
      { value: 'demo' }
    )

    expect(api.svcDemo.watch).toHaveBeenCalledWith(
      { value: 'demo' },
      expect.any(Object),
      expect.objectContaining({
        methodName: 'svcDemo.watch',
        senderId: 7,
        frameUrl: 'app://renderer/index.html#/watch',
        isMainFrame: true
      })
    )
    expect(port.start).toHaveBeenCalledTimes(1)
    expect(port.postMessage).toHaveBeenCalledWith({ data: { chunk: 'first' } })
    expect(port.close).toHaveBeenCalledTimes(1)
    expect(port.listenerCount('message')).toBe(0)
    expect(port.listenerCount('close')).toBe(0)
  })

  it('rejects malformed streaming IPC messages without invoking the service', async () => {
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn()
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void> | void
    expect(() => listener({ ports: [] }, { value: 'demo' })).not.toThrow()
    expect(api.svcDemo.watch).not.toHaveBeenCalled()
    expect(consoleErrorMock).toHaveBeenCalledWith(
      'svcDemo.watch: missing MessagePort for server-streaming request'
    )
  })

  it('ignores callbacks that fire after a successful stream has been cleaned up', async () => {
    const port = new FakeMessagePortMain()
    let emitLate: (() => void) | undefined
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(async (_req, resp) => {
          emitLate = () => resp.onData({ chunk: 'late' })
        })
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await listener({ ports: [port] }, { value: 'demo' })
    emitLate?.()

    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it('turns a data-port delivery failure into cancellation without throwing', async () => {
    const port = new FakeMessagePortMain()
    port.postMessage.mockImplementation(() => {
      throw new Error('renderer port is closed')
    })
    let aborted = false
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(async (_req, resp) => {
          resp.abortReceiver?.onAbort(() => {
            aborted = true
          })
          expect(() => resp.onData({ chunk: 'first' })).not.toThrow()
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

    expect(aborted).toBe(true)
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('cleans up the port when a streaming handler throws synchronously', async () => {
    const port = new FakeMessagePortMain()
    const failure = new Error('sync stream failure')
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(() => {
          throw failure
        }) as unknown as DemoApi['svcDemo']['watch']
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await expect(listener({ ports: [port] }, { value: 'demo' })).resolves.toBeUndefined()
    expect(port.postMessage).toHaveBeenCalledWith({
      error: { message: 'sync stream failure', code: 'INTERNAL_ERROR' }
    })
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
          resp.onData({ chunk: 'late' })
        })
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await listener({ ports: [port] }, { value: 'demo' })
    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'legacy main-frame reload',
      event: 'did-start-navigation',
      args: [{}, 'app://renderer/index.html', false, true]
    },
    {
      label: 'main-frame document navigation',
      event: 'did-start-navigation',
      args: [{ isMainFrame: true, isSameDocument: false }]
    },
    { label: 'renderer process exit', event: 'render-process-gone', args: [{}] },
    { label: 'renderer destruction', event: 'destroyed', args: [] }
  ])(
    'aborts an orphaned stream on $label without waiting for port close',
    async ({ event, args }) => {
      const fixture = createPendingStreamFixture()
      let settled = false
      void fixture.running.then(() => {
        settled = true
      })

      fixture.sender.emit(event, ...args)
      expect(fixture.response().abortReceiver?.isAborted()).toBe(true)
      expect(fixture.onAbort).toHaveBeenCalledOnce()
      expect(fixture.port.close).not.toHaveBeenCalled()
      await Promise.resolve()
      expect(settled).toBe(false)

      fixture.sender.emit(event, ...args)
      fixture.port.emit('close')
      expect(fixture.onAbort).toHaveBeenCalledOnce()

      fixture.finish()
      await fixture.running
      expect(fixture.sender.eventNames()).toEqual([])
    }
  )

  it('keeps streams alive for subframe and same-document navigation', async () => {
    const fixture = createPendingStreamFixture()

    fixture.sender.emit('did-start-navigation', {}, 'app://renderer/frame.html', false, false)
    fixture.sender.emit('did-start-navigation', {}, 'app://renderer/index.html#next', true, true)
    fixture.sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    fixture.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(fixture.response().abortReceiver?.isAborted()).toBe(false)
    expect(fixture.onAbort).not.toHaveBeenCalled()

    fixture.finish()
    await fixture.running
  })

  it.each(['success', 'failure'] as const)(
    'removes only its renderer lifecycle listeners after %s',
    async (outcome) => {
      const sender = new EventEmitter()
      const unrelatedListener = vi.fn()
      sender.on('did-start-navigation', unrelatedListener)
      const fixture = createPendingStreamFixture(sender)
      expect(sender.listenerCount('did-start-navigation')).toBe(2)
      expect(sender.listenerCount('render-process-gone')).toBe(1)
      expect(sender.listenerCount('destroyed')).toBe(1)

      if (outcome === 'failure') fixture.fail(new Error('fixture stream failed'))
      else fixture.finish()
      await fixture.running

      expect(sender.listenerCount('did-start-navigation')).toBe(1)
      expect(sender.listenerCount('render-process-gone')).toBe(0)
      expect(sender.listenerCount('destroyed')).toBe(0)
      sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      sender.emit('render-process-gone', {})
      sender.emit('destroyed')
      expect(unrelatedListener).toHaveBeenCalledOnce()
      expect(fixture.onAbort).not.toHaveBeenCalled()
    }
  )

  it('does not cancel a stream owned by another renderer', async () => {
    const first = createPendingStreamFixture()
    const second = createPendingStreamFixture()

    first.sender.emit('destroyed')
    expect(first.onAbort).toHaveBeenCalledOnce()
    expect(second.onAbort).not.toHaveBeenCalled()
    expect(second.response().abortReceiver?.isAborted()).toBe(false)

    first.finish()
    second.finish()
    await Promise.all([first.running, second.running])
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
        code: 'E_STREAM',
        payload: { message: 'stream failed', code: 'E_STREAM' }
      }
    })
    expect(consoleErrorMock).toHaveBeenCalledWith('cleanupPort error', {
      message: 'stream failed',
      code: 'E_STREAM',
      payload: { message: 'stream failed', code: 'E_STREAM' }
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
        message: 'plain stream failure',
        code: 'INTERNAL_ERROR'
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
        message: 'Unknown error',
        code: 'INTERNAL_ERROR'
      }
    })
  })

  it('does not reject cleanup when the renderer closes before a terminal error is posted', async () => {
    const port = new FakeMessagePortMain()
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(async () => {
          port.emit('close')
          throw new Error('stream failed after renderer close')
        })
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await expect(listener({ ports: [port] }, { value: 'demo' })).resolves.toBeUndefined()
    expect(port.close).toHaveBeenCalledTimes(1)
    expect(port.postMessage).not.toHaveBeenCalled()
    expect(consoleErrorMock).not.toHaveBeenCalledWith(
      'cleanupPort error',
      expect.objectContaining({ message: 'stream failed after renderer close' })
    )
  })

  it('does not reject when posting a terminal error itself fails', async () => {
    const port = new FakeMessagePortMain()
    port.postMessage.mockImplementation(() => {
      throw new Error('renderer port is closed')
    })
    const api: DemoApi = {
      svcDemo: {
        ping: vi.fn(),
        watch: vi.fn(async () => {
          throw new Error('stream failed')
        })
      }
    }

    registerIpcServer<DemoApi>(apiDef, api)

    const listener = onMock.mock.calls[0][1] as (
      event: { ports: FakeMessagePortMain[] },
      req: { value: string }
    ) => Promise<void>
    await expect(listener({ ports: [port] }, { value: 'demo' })).resolves.toBeUndefined()
    expect(port.close).toHaveBeenCalledTimes(1)
    expect(consoleErrorMock).toHaveBeenCalledWith('cleanupPort transport error', {
      message: 'renderer port is closed',
      code: 'INTERNAL_ERROR'
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
    return this
  }

  removeListener(event: string, listener: () => void) {
    if (this.listeners.get(event) === listener) this.listeners.delete(event)
    return this
  }

  listenerCount(event: string) {
    return this.listeners.has(event) ? 1 : 0
  }

  emit(event: string) {
    this.listeners.get(event)?.()
  }
}

function createPendingStreamFixture(sender = new EventEmitter()) {
  const port = new FakeMessagePortMain()
  const onAbort = vi.fn()
  let response!: ServerStreaming<{ chunk: string }>
  let finish!: () => void
  let fail!: (reason: Error) => void
  const pending = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const api: DemoApi = {
    svcDemo: {
      ping: vi.fn(),
      watch: vi.fn((_req, resp) => {
        response = resp
        resp.abortReceiver?.onAbort(onAbort)
        return pending
      })
    }
  }
  registerIpcServer<DemoApi>(apiDef, api)
  const listener = onMock.mock.calls.at(-1)![1] as (
    event: { ports: FakeMessagePortMain[]; sender: EventEmitter },
    req: { value: string }
  ) => Promise<void>
  const running = listener({ ports: [port], sender }, { value: 'demo' })
  return { port, sender, onAbort, response: () => response, finish, fail, running }
}
