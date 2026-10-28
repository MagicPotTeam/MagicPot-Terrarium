import { describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL,
  createChildProcessBridgeTransport,
  createParentOwnedFigPluginBridgeChildTransport,
  type FigPluginBridgeProcessMessage,
  type FigPluginBridgeProcessPort
} from './bridgeTransport'
import {
  decodeFigPluginBridgeChildFrame,
  frameForReady,
  type FigPluginBridgeChildFrame
} from './bridgeChildProtocol'
import {
  decodeFigPluginBridgeChildRpcResponse,
  encodeFigPluginBridgeChildRpcRequest
} from './bridgeChildWire'
import type { FigPluginBridgeChildRuntime } from './bridgeChildRpc'

type Listener = (...args: unknown[]) => void

class FakePort implements FigPluginBridgeProcessPort {
  readonly sent: string[] = []
  readonly killed = vi.fn()
  readonly #listeners = new Map<string, Set<Listener>>()
  readonly #wrappers = new Map<string, Map<Listener, Listener>>()
  onSend?: (frame: string) => void

  send(frame: string): void {
    this.sent.push(frame)
    this.onSend?.(frame)
  }

  kill(): void {
    this.killed()
  }

  on(event: 'message', listener: Listener): void {
    const listeners = this.#listeners.get(event) ?? new Set<Listener>()
    const wrappers = this.#wrappers.get(event) ?? new Map<Listener, Listener>()
    listeners.add(listener)
    wrappers.set(listener, listener)
    this.#listeners.set(event, listeners)
    this.#wrappers.set(event, wrappers)
  }

  once(event: 'message' | 'exit' | 'error', listener: Listener): void {
    const wrapped: Listener = (...args) => {
      this.#listeners.get(event)?.delete(wrapped)
      this.#wrappers.get(event)?.delete(listener)
      listener(...args)
    }
    const listeners = this.#listeners.get(event) ?? new Set<Listener>()
    const wrappers = this.#wrappers.get(event) ?? new Map<Listener, Listener>()
    listeners.add(wrapped)
    wrappers.set(listener, wrapped)
    this.#listeners.set(event, listeners)
    this.#wrappers.set(event, wrappers)
  }

  off(event: 'message' | 'exit' | 'error', listener: Listener): void {
    const wrappers = this.#wrappers.get(event)
    const wrapped = wrappers?.get(listener)
    this.#listeners.get(event)?.delete(wrapped ?? listener)
    if (wrapped) wrappers?.delete(listener)
  }

  emit(event: 'message' | 'exit' | 'error', ...args: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(...args)
  }

  listenerCount(event: 'message' | 'exit' | 'error'): number {
    return this.#listeners.get(event)?.size ?? 0
  }
}

const origin = 'http://127.0.0.1:41234'
const nonce = 'a'.repeat(32)

const make = (
  port: FakePort,
  overrides: Partial<Parameters<typeof createChildProcessBridgeTransport>[0]> = {}
) =>
  createChildProcessBridgeTransport({
    randomNonce: () => nonce,
    launch: vi.fn(async (input) => {
      port.onSend = (frame) => {
        const message = decodeFigPluginBridgeChildFrame(frame)
        if (message?.kind === 'bootstrap')
          queueMicrotask(() => port.emit('message', frameForReady(input)))
      }
      return port
    }),
    ...overrides
  })

describe('createChildProcessBridgeTransport', () => {
  it('sends only bounded bootstrap metadata and accepts the matching ready message', async () => {
    const port = new FakePort()
    const launch = vi.fn(async (input: { origin: string; protocol: 1; nonce: string }) => {
      expect(input).toEqual({ origin, protocol: FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL, nonce })
      expect(input).not.toHaveProperty('runtime')
      expect(input).not.toHaveProperty('credentials')
      port.onSend = (frame) => {
        const message = decodeFigPluginBridgeChildFrame(frame)
        if (message?.kind === 'bootstrap')
          queueMicrotask(() =>
            port.emit(
              'message',
              frameForReady({
                protocol: message.protocol,
                nonce: message.nonce,
                origin: message.origin
              })
            )
          )
      }
      return port
    })
    const transport = createChildProcessBridgeTransport({ randomNonce: () => nonce, launch })
    const runtime = { secret: 'must-not-cross-boundary' }
    const server = await transport.start({ origin, runtime, credentials: 'secret' } as never)

    expect(launch).toHaveBeenCalledOnce()
    expect(server.origin).toBe(origin)
    expect(port.sent.map(decodeFigPluginBridgeChildFrame)).toEqual([
      {
        frame: 'magicpot.figplugin.bridge-child/v1',
        kind: 'bootstrap',
        protocol: 1,
        nonce,
        origin
      }
    ])
  })

  it.each([
    ['nonce', { nonce: 'b'.repeat(32) }],
    ['origin', { origin: 'http://127.0.0.1:41235' }],
    ['protocol', { protocol: 99 }]
  ] as const)('rejects a ready message with a mismatched %s', async (_label, mismatch) => {
    const port = new FakePort()
    const transport = createChildProcessBridgeTransport({
      randomNonce: () => nonce,
      launch: async (input) => {
        port.onSend = (frame) => {
          const message = decodeFigPluginBridgeChildFrame(frame)
          if (message?.kind === 'bootstrap')
            queueMicrotask(() =>
              port.emit(
                'message',
                JSON.stringify({
                  frame: 'magicpot.figplugin.bridge-child/v1',
                  kind: 'ready',
                  ...input,
                  ...mismatch
                })
              )
            )
        }
        return port
      }
    })
    await expect(transport.start({ origin })).rejects.toMatchObject({
      code: 'IPC_HANDSHAKE_FAILED'
    })
    expect(port.killed).toHaveBeenCalledOnce()
    expect(port.listenerCount('exit')).toBe(0)
  })

  it('fails closed for invalid origins before launching a child', async () => {
    const launch = vi.fn()
    const transport = createChildProcessBridgeTransport({ randomNonce: () => nonce, launch })
    await expect(transport.start({ origin: 'https://127.0.0.1:41234' })).rejects.toMatchObject({
      code: 'IPC_HANDSHAKE_FAILED'
    })
    expect(launch).not.toHaveBeenCalled()
  })

  it('rejects a handshake timeout and detaches process listeners', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakePort()
      const transport = createChildProcessBridgeTransport({
        randomNonce: () => nonce,
        handshakeTimeoutMs: 10,
        launch: async () => port
      })
      const pending = transport.start({ origin })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'IPC_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
      expect(port.killed).toHaveBeenCalledOnce()
      expect(port.listenerCount('exit')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a child exit before ready and reports a later crash after ready', async () => {
    const beforeReady = new FakePort()
    const early = createChildProcessBridgeTransport({
      randomNonce: () => nonce,
      launch: async () => {
        beforeReady.onSend = () => queueMicrotask(() => beforeReady.emit('exit', 17, null))
        return beforeReady
      }
    })
    await expect(early.start({ origin })).rejects.toMatchObject({ code: 'CHILD_CRASHED' })

    const ready = new FakePort()
    const transport = make(ready)
    const server = await transport.start({ origin })
    const crashed = vi.fn()
    const detach = server.onCrash?.(crashed)
    ready.emit('exit', 1, 'SIGTERM')
    expect(crashed).toHaveBeenCalledOnce()
    detach?.()
  })

  it('keeps a runtime error listener armed and de-duplicates error/exit crash signals', async () => {
    const port = new FakePort()
    const transport = make(port)
    const server = await transport.start({ origin })
    const crashed = vi.fn()
    server.onCrash?.(crashed)

    port.emit('error', new Error('first'))
    port.emit('error', new Error('second'))
    expect(crashed).toHaveBeenCalledOnce()
    expect(port.listenerCount('error')).toBe(1)

    port.emit('exit', 1, 'SIGTERM')
    expect(crashed).toHaveBeenCalledOnce()
    expect(port.listenerCount('error')).toBe(0)
  })

  it('sends shutdown and shares one close promise across concurrent callers', async () => {
    const port = new FakePort()
    const transport = make(port)
    const server = await transport.start({ origin })
    const first = server.close()
    const second = server.close()
    expect(first).toBe(second)
    expect(decodeFigPluginBridgeChildFrame(port.sent.at(-1))).toEqual({
      frame: 'magicpot.figplugin.bridge-child/v1',
      kind: 'shutdown',
      protocol: FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL,
      nonce,
      origin,
      reason: 'supervisor-stop'
    })
    port.emit('exit', 0, null)
    await expect(first).resolves.toBeUndefined()
  })

  it('kills the child and reports a bounded error when shutdown times out', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakePort()
      const transport = make(port, { shutdownTimeoutMs: 10 })
      const server = await transport.start({ origin })
      const pending = server.close()
      const rejected = expect(pending).rejects.toMatchObject({ code: 'IPC_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
      expect(port.killed).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows a later stop retry after a timed-out close observes child exit', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakePort()
      const transport = make(port, { shutdownTimeoutMs: 10 })
      const server = await transport.start({ origin })
      const first = server.close()
      const rejected = expect(first).rejects.toMatchObject({ code: 'IPC_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
      expect(port.killed).toHaveBeenCalledOnce()

      // The kill can complete asynchronously. Once exit is observed, a
      // supervisor retry must not reuse the rejected promise.
      port.emit('exit', 137, 'SIGKILL')
      const second = server.close()
      expect(second).not.toBe(first)
      await expect(second).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills and reports a child that violates the RPC wire contract', async () => {
    const port = new FakePort()
    const transport = createChildProcessBridgeTransport({
      randomNonce: () => nonce,
      launch: async (input) => {
        port.onSend = (frame) => {
          const message = decodeFigPluginBridgeChildFrame(frame)
          if (message?.kind === 'bootstrap')
            queueMicrotask(() => port.emit('message', frameForReady(input)))
        }
        return port
      },
      rpc: { handle: vi.fn(async () => undefined) }
    })
    const server = await transport.start({ origin })
    const crashed = vi.fn()
    server.onCrash?.(crashed)
    port.emit('message', '{"kind":"request"}')
    expect(port.killed).toHaveBeenCalledOnce()
    expect(crashed).toHaveBeenCalledOnce()
  })

  it('dispatches parent-owned runtime RPC without putting the runtime in launch metadata', async () => {
    const port = new FakePort()
    const runtime = {
      redeem: vi.fn(async (body: unknown) => ({ redeemed: body })),
      prepare: vi.fn(async () => ({})),
      prepareImageGeneration: vi.fn<FigPluginBridgeChildRuntime['prepareImageGeneration']>(),
      imageGenerationStatus: vi.fn<FigPluginBridgeChildRuntime['imageGenerationStatus']>(),
      cancelImageGeneration: vi
        .fn<FigPluginBridgeChildRuntime['cancelImageGeneration']>()
        .mockResolvedValue(undefined),
      status: vi.fn(async () => ({})),
      readiness: vi.fn(async () => ({})),
      assetList: vi.fn(async () => ({})),
      assetChunk: vi.fn(async () => ({})),
      planAssetChunk: vi.fn(async () => ({})),
      cancel: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      planStatus: vi.fn(async () => ({})),
      prepareVisualCorrection: vi.fn(async () => ({})),
      prepareTaskRecovery: vi.fn(async () => ({})),
      claimPlan: vi.fn(async () => ({})),
      planProgress: vi.fn(() => ({})),
      planResult: vi.fn(() => ({})),
      planPixelAudit: vi.fn(async () => ({}))
    }
    const launch = vi.fn(async (input: { origin: string; protocol: 1; nonce: string }) => {
      expect(input).toEqual({ origin, protocol: FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL, nonce })
      expect(input).not.toHaveProperty('runtime')
      port.onSend = (frame) => {
        const message = decodeFigPluginBridgeChildFrame(frame)
        if (message?.kind === 'bootstrap')
          queueMicrotask(() => port.emit('message', frameForReady(input)))
      }
      return port
    })
    const transport = createParentOwnedFigPluginBridgeChildTransport({
      randomNonce: () => nonce,
      launch
    })
    const server = await transport.start({ origin, runtime })

    port.emit(
      'message',
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId: 'b'.repeat(32),
        method: 'redeem',
        body: { ticketId: 'ticket' }
      })
    )
    await vi.waitFor(() => expect(runtime.redeem).toHaveBeenCalledWith({ ticketId: 'ticket' }))
    await vi.waitFor(() => expect(port.sent.length).toBeGreaterThan(1))
    expect(decodeFigPluginBridgeChildRpcResponse(port.sent.at(-1), nonce)).toMatchObject({
      requestId: 'b'.repeat(32),
      ok: true,
      result: { redeemed: { ticketId: 'ticket' } }
    })

    const closing = server.close()
    port.emit('exit', 0, null)
    await closing
  })
})
