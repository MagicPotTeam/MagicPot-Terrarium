import { describe, expect, it, vi } from 'vitest'
import { FigPluginBridgeError } from '@shared/figplugin/bridge'
import {
  createFigPluginBridgeChildRpcClient,
  createFigPluginBridgeChildRpcEndpoint,
  createFigPluginBridgeChildRuntimeHandler,
  FigPluginBridgeChildRpcError,
  type FigPluginBridgeChildRuntime
} from './bridgeChildRpc'
import {
  decodeFigPluginBridgeChildRpcRequest,
  decodeFigPluginBridgeChildRpcResponse,
  encodeFigPluginBridgeChildRpcCancel,
  encodeFigPluginBridgeChildRpcRequest,
  encodeFigPluginBridgeChildRpcResponse
} from './bridgeChildWire'
import { createChildProcessBridgeTransport } from './bridgeTransport'
import { decodeFigPluginBridgeChildFrame, frameForReady } from './bridgeChildProtocol'

type Listener = (...args: unknown[]) => void

class FakePort {
  readonly sent: string[] = []
  readonly listeners = new Set<Listener>()
  on(_event: 'message', listener: Listener): void {
    this.listeners.add(listener)
  }
  off(_event: 'message', listener: Listener): void {
    this.listeners.delete(listener)
  }
  send(frame: string): void {
    this.sent.push(frame)
  }
  emit(frame: string): void {
    for (const listener of [...this.listeners]) listener(frame)
  }
}

class ProcessFakePort extends FakePort {
  readonly killed = vi.fn()
  readonly lifecycle = new Map<'exit' | 'error', Listener[]>()
  onSend?: (frame: string) => void
  kill(): void {
    this.killed()
  }
  override send(frame: string): void {
    super.send(frame)
    this.onSend?.(frame)
  }
  once(event: 'message' | 'exit' | 'error', listener: Listener): void {
    if (event === 'message') {
      this.on('message', listener)
      return
    }
    const list = this.lifecycle.get(event) ?? []
    list.push(listener)
    this.lifecycle.set(event, list)
  }
  off(event: 'message' | 'exit' | 'error', listener: Listener): void {
    if (event === 'message') {
      super.off(event, listener)
      return
    }
    this.lifecycle.set(
      event,
      (this.lifecycle.get(event) ?? []).filter((item) => item !== listener)
    )
  }
  emitEvent(event: 'exit' | 'error', ...args: unknown[]): void {
    const listeners = this.lifecycle.get(event) ?? []
    this.lifecycle.delete(event)
    for (const listener of listeners) listener(...args)
  }
}

const nonce = 'a'.repeat(32)
const session = 'b'.repeat(32)
const token = 'c'.repeat(64)
const id = 'd'.repeat(32)
const correlationId = 'e'.repeat(32)

describe('bridge child RPC endpoint/client', () => {
  it('dispatches an allowlisted request and emits a canonical response', async () => {
    const port = new FakePort()
    const handle = vi.fn(async (request) => ({ method: request.method, body: request.body }))
    createFigPluginBridgeChildRpcEndpoint({ port, nonce, handle })
    port.emit(
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId: id,
        correlationId,
        method: 'prepare',
        session,
        token,
        body: { prompt: 'hello' }
      })
    )
    await vi.waitFor(() => expect(port.sent).toHaveLength(1))
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'prepare', session, token }),
      expect.any(AbortSignal)
    )
    expect(decodeFigPluginBridgeChildRpcResponse(port.sent[0], nonce)).toEqual({
      kind: 'response',
      protocol: 1,
      nonce,
      requestId: id,
      correlationId,
      ok: true,
      result: { method: 'prepare', body: { prompt: 'hello' } }
    })
  })

  it('emits bounded lineage traces with elapsed duration and classified failures', async () => {
    const port = new FakePort()
    const traces: unknown[] = []
    let now = 100
    createFigPluginBridgeChildRpcEndpoint({
      port,
      nonce,
      now: () => now,
      onTrace: (event) => traces.push(event),
      handle: async () => {
        now = 137
        throw new FigPluginBridgeError('TIMEOUT')
      }
    })
    port.emit(
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId: id,
        correlationId,
        method: 'prepare',
        session,
        token,
        body: {}
      })
    )
    await vi.waitFor(() => expect(port.sent).toHaveLength(1))
    expect(traces).toEqual([
      {
        correlationId,
        requestId: id,
        method: 'prepare',
        stage: 'received',
        durationMs: 0
      },
      {
        correlationId,
        requestId: id,
        method: 'prepare',
        stage: 'failed',
        durationMs: 37,
        errorCode: 'TIMEOUT'
      }
    ])
  })

  it('keeps legacy wire responses correlation-free and rejects an unsolicited correlated cancel', async () => {
    const port = new FakePort()
    createFigPluginBridgeChildRpcEndpoint({ port, nonce, handle: async () => 'legacy' })
    port.emit(
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId: id,
        method: 'redeem',
        body: {}
      })
    )
    await vi.waitFor(() => expect(port.sent).toHaveLength(1))
    expect(decodeFigPluginBridgeChildRpcResponse(port.sent[0], nonce)).not.toHaveProperty(
      'correlationId'
    )

    const inFlight = new FakePort()
    const protocolError = vi.fn()
    createFigPluginBridgeChildRpcEndpoint({
      port: inFlight,
      nonce,
      onProtocolError: protocolError,
      handle: () => new Promise(() => undefined)
    })
    inFlight.emit(
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId: id,
        method: 'redeem',
        body: {}
      })
    )
    await Promise.resolve()
    inFlight.emit(encodeFigPluginBridgeChildRpcCancel({ nonce, requestId: id, correlationId }))
    expect(protocolError).toHaveBeenCalledOnce()
    expect(inFlight.listeners).toHaveLength(0)
  })

  it('maps runtime errors to shared codes without leaking messages', async () => {
    const port = new FakePort()
    createFigPluginBridgeChildRpcEndpoint({
      port,
      nonce,
      handle: () => {
        throw new Error('credential=do-not-leak')
      }
    })
    port.emit(
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId: id,
        method: 'prepare',
        session,
        token,
        body: {}
      })
    )
    await vi.waitFor(() => expect(port.sent).toHaveLength(1))
    expect(decodeFigPluginBridgeChildRpcResponse(port.sent[0], nonce)).toMatchObject({
      requestId: id,
      ok: false,
      errorCode: 'UPSTREAM_FAILED'
    })
    expect(port.sent[0]).not.toContain('credential')
  })

  it('fails closed and removes the endpoint on malformed or duplicate requests', async () => {
    const port = new FakePort()
    const protocolError = vi.fn()
    const endpoint = createFigPluginBridgeChildRpcEndpoint({
      port,
      nonce,
      handle: async () => 'ok',
      onProtocolError: protocolError
    })
    port.emit('{"kind":"request"}')
    expect(protocolError).toHaveBeenCalledOnce()
    expect(port.listeners).toHaveLength(0)
    endpoint.close()
  })

  it('rejects a request ID replay after the first response settles', async () => {
    const port = new FakePort()
    const protocolError = vi.fn()
    createFigPluginBridgeChildRpcEndpoint({
      port,
      nonce,
      handle: async () => 'ok',
      onProtocolError: protocolError
    })
    const frame = encodeFigPluginBridgeChildRpcRequest({
      nonce,
      requestId: id,
      method: 'prepare',
      session,
      token,
      body: {}
    })
    port.emit(frame)
    await vi.waitFor(() => expect(port.sent).toHaveLength(1))
    port.emit(frame)
    expect(protocolError).toHaveBeenCalledOnce()
    expect(port.listeners).toHaveLength(0)
  })

  it('cancels an in-flight request and suppresses a late result', async () => {
    const port = new FakePort()
    let release!: () => void
    const settled = new Promise<void>((resolve) => {
      release = resolve
    })
    const aborted = vi.fn()
    createFigPluginBridgeChildRpcEndpoint({
      port,
      nonce,
      handle: async (_request, signal) => {
        signal.addEventListener('abort', aborted)
        await settled
        return 'late'
      }
    })
    port.emit(
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId: id,
        method: 'prepare',
        session,
        token,
        body: {}
      })
    )
    await Promise.resolve()
    port.emit(encodeFigPluginBridgeChildRpcCancel({ nonce, requestId: id }))
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(aborted).toHaveBeenCalledOnce()
    expect(port.sent).toHaveLength(0)
  })

  it('client resolves responses, cancels on abort, and ignores late responses', async () => {
    const port = new FakePort()
    const client = createFigPluginBridgeChildRpcClient({ port, nonce })
    const pending = client.request({
      method: 'prepare',
      session,
      token,
      body: {},
      signal: AbortSignal.timeout(1_000)
    })
    const request = decodeFigPluginBridgeChildRpcRequest(port.sent[0], nonce)
    port.emit(
      encodeFigPluginBridgeChildRpcResponse({
        nonce,
        requestId: request.requestId,
        result: { ok: true }
      })
    )
    await expect(pending).resolves.toEqual({ ok: true })
    // A duplicate/late response cannot affect a completed promise.
    port.emit(
      encodeFigPluginBridgeChildRpcResponse({
        nonce,
        requestId: request.requestId,
        result: { ok: false }
      })
    )

    const controller = new AbortController()
    const cancelled = client.request({
      method: 'prepare',
      session,
      token,
      body: {},
      signal: controller.signal
    })
    const second = decodeFigPluginBridgeChildRpcRequest(port.sent.at(-1), nonce)
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(port.sent.at(-1)).toBe(
      encodeFigPluginBridgeChildRpcCancel({
        nonce,
        requestId: second.requestId,
        correlationId: second.correlationId
      })
    )
  })

  it('requires a matching response correlation when the request supplied one', async () => {
    const port = new FakePort()
    const client = createFigPluginBridgeChildRpcClient({ port, nonce })
    const pending = client.request({
      method: 'prepare',
      session,
      token,
      correlationId,
      body: {}
    })
    const request = decodeFigPluginBridgeChildRpcRequest(port.sent[0], nonce)
    port.emit(
      encodeFigPluginBridgeChildRpcResponse({
        nonce,
        requestId: request.requestId,
        result: { ok: true }
      })
    )
    await expect(pending).rejects.toMatchObject({ code: 'IPC_HANDSHAKE_FAILED' })
  })

  it('fails every pending client request on a malformed parent frame', async () => {
    const port = new FakePort()
    const client = createFigPluginBridgeChildRpcClient({ port, nonce })
    const first = client.request({ method: 'prepare', session, token, body: {} })
    const second = client.request({ method: 'status', session, token, body: {} })
    port.emit('{"kind":"response"}')
    await expect(first).rejects.toBeInstanceOf(FigPluginBridgeChildRpcError)
    await expect(second).rejects.toMatchObject({ code: 'IPC_HANDSHAKE_FAILED' })
  })

  it('keeps runtime dispatch in the parent and authenticates non-redeem methods', async () => {
    const runtime = {
      redeem: vi.fn(async (body) => ({ redeemed: body })),
      prepare: vi.fn(async (s, t, body) => ({ s, t, body })),
      prepareImageGeneration: vi.fn<FigPluginBridgeChildRuntime['prepareImageGeneration']>(),
      imageGenerationStatus: vi.fn<FigPluginBridgeChildRuntime['imageGenerationStatus']>(),
      cancelImageGeneration: vi
        .fn<FigPluginBridgeChildRuntime['cancelImageGeneration']>()
        .mockResolvedValue(undefined),
      status: vi.fn(async (s, t, callId) => ({ s, t, callId })),
      readiness: vi.fn(async () => ({ ready: true })),
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
    const handler = createFigPluginBridgeChildRuntimeHandler(runtime)
    await expect(
      handler(
        { method: 'status', session, token, body: { protocol: 1, callId: id } },
        new AbortController().signal
      )
    ).resolves.toEqual({ s: session, t: token, callId: id })
    await expect(
      handler({ method: 'redeem', body: { ticketId: 'x' } }, new AbortController().signal)
    ).resolves.toEqual({ redeemed: { ticketId: 'x' } })
    await expect(
      handler({ method: 'prepare', body: {} }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('wires the optional parent RPC endpoint without sending runtime metadata to the child', async () => {
    const port = new ProcessFakePort()
    const runtime = { secret: 'parent-only' }
    const handle = vi.fn(async (_input, request) => ({ method: request.method }))
    const transport = createChildProcessBridgeTransport({
      randomNonce: () => nonce,
      launch: async (input) => {
        port.onSend = (frame) => {
          const decoded = decodeFigPluginBridgeChildFrame(frame)
          if (decoded?.kind === 'bootstrap')
            queueMicrotask(() =>
              port.emit(
                frameForReady({
                  protocol: decoded.protocol,
                  nonce: decoded.nonce,
                  origin: decoded.origin
                })
              )
            )
        }
        return port
      },
      rpc: { handle }
    })
    const server = await transport.start({ origin: 'http://127.0.0.1:41234', runtime } as never)
    port.emit(
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId: id,
        method: 'redeem',
        body: {}
      })
    )
    await vi.waitFor(() => expect(port.sent.length).toBeGreaterThan(1))
    expect(handle).toHaveBeenCalledOnce()
    expect(handle.mock.calls[0][0]).toEqual({ origin: 'http://127.0.0.1:41234', runtime })
    expect(decodeFigPluginBridgeChildRpcResponse(port.sent.at(-1), nonce)).toMatchObject({
      requestId: id,
      ok: true,
      result: { method: 'redeem' }
    })
    const closing = server.close()
    port.emitEvent('exit')
    await closing
  })
})
