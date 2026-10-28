import { describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_BRIDGE_CHILD_EXIT_PROTOCOL_ERROR,
  runFigPluginBridgeChild,
  type FigPluginBridgeChildPort
} from './bridgeChildRuntime'
import {
  decodeFigPluginBridgeChildFrame,
  frameForBootstrap,
  frameForShutdown
} from './bridgeChildProtocol'

class FakePort implements FigPluginBridgeChildPort {
  listener?: (event: { data: unknown }) => void
  readonly posted: string[] = []
  on(_event: 'message', listener: (event: { data: unknown }) => void): void {
    this.listener = listener
  }
  removeListener(_event: 'message', listener: (event: { data: unknown }) => void): void {
    if (this.listener === listener) this.listener = undefined
  }
  postMessage(value: string): void {
    this.posted.push(value)
  }
  send(value: unknown, ports?: readonly unknown[]): void {
    this.listener?.({ data: value, ...(ports ? { ports } : {}) })
  }
}

const input = {
  protocol: 1 as const,
  nonce: 'a'.repeat(32),
  origin: 'http://127.0.0.1:41234'
}

describe('bridge child runtime endpoint', () => {
  it('accepts one bootstrap and exits cleanly on matching shutdown', () => {
    const port = new FakePort()
    const exit = vi.fn()
    runFigPluginBridgeChild(port, exit)
    port.send(frameForBootstrap(input))
    expect(decodeFigPluginBridgeChildFrame(port.posted[0])).toMatchObject({
      kind: 'ready',
      ...input
    })
    port.send(frameForShutdown({ ...input, reason: 'supervisor-stop' }))
    expect(exit).toHaveBeenCalledWith(0)
    expect(port.listener).toBeUndefined()
  })

  it('fails closed on malformed frames, duplicate bootstrap, and mismatched shutdown', () => {
    for (const send of [
      (port: FakePort) => port.send('not-json'),
      (port: FakePort) => {
        port.send(frameForBootstrap(input))
        port.send(frameForBootstrap(input))
      },
      (port: FakePort) => {
        port.send(frameForBootstrap(input))
        port.send(frameForShutdown({ ...input, nonce: 'b'.repeat(32), reason: 'supervisor-stop' }))
      },
      (port: FakePort) => {
        port.send(frameForBootstrap(input), [{}])
      }
    ]) {
      const port = new FakePort()
      const exit = vi.fn()
      runFigPluginBridgeChild(port, exit)
      send(port)
      expect(exit).toHaveBeenCalledWith(FIGPLUGIN_BRIDGE_CHILD_EXIT_PROTOCOL_ERROR)
    }
  })

  it('waits for child listener startup, forwards RPC frames, and awaits shutdown', async () => {
    const port = new FakePort()
    const exit = vi.fn()
    let start!: () => void
    let stop!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const stopped = new Promise<void>((resolve) => {
      stop = resolve
    })
    const rpc = vi.fn(() => true)
    runFigPluginBridgeChild(port, exit, {
      onReady: async () => {
        await started
      },
      onRpcMessage: rpc,
      onShutdown: async () => {
        await stopped
      }
    })
    port.send(frameForBootstrap(input))
    expect(port.posted).toHaveLength(0)
    start()
    await vi.waitFor(() => expect(port.posted).toHaveLength(1))
    port.send('{"kind":"response"}')
    expect(rpc).toHaveBeenCalledWith('{"kind":"response"}')
    port.send(frameForShutdown({ ...input, reason: 'supervisor-stop' }))
    expect(exit).not.toHaveBeenCalled()
    stop()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })
})
