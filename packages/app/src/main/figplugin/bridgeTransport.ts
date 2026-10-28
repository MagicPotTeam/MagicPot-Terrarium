import { randomBytes } from 'node:crypto'
import { figPluginBridgeOriginSchema } from '@shared/figplugin/bridge'
import {
  decodeFigPluginBridgeChildFrame,
  frameForBootstrap,
  frameForShutdown,
  FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL
} from './bridgeChildProtocol'
import type {
  FigPluginBridgeServer,
  FigPluginBridgeTransport,
  FigPluginBridgeSupervisorFailureCode
} from './bridgeSupervisor'
import {
  createFigPluginBridgeChildRpcEndpoint,
  createFigPluginBridgeChildRuntimeHandler,
  FigPluginBridgeChildRpcError,
  type FigPluginBridgeChildRpcEndpoint,
  type FigPluginBridgeChildRpcHandler,
  type FigPluginBridgeChildRpcRequestContext,
  type FigPluginBridgeChildRuntime,
  type FigPluginBridgeChildRpcTrace
} from './bridgeChildRpc'

export { FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL }
export type {
  FigPluginBridgeBootstrapFrame as FigPluginBridgeBootstrapMessage,
  FigPluginBridgeReadyFrame as FigPluginBridgeReadyMessage,
  FigPluginBridgeShutdownFrame as FigPluginBridgeShutdownMessage,
  FigPluginBridgeProcessMessage
} from './bridgeChildProtocol'

/**
 * Minimal child-process port. The real Node ChildProcess satisfies this shape,
 * while tests can use a deterministic in-memory port. No generic IPC channel,
 * credentials or arbitrary config object is exposed by this contract.
 */
export type FigPluginBridgeProcessPort = {
  /** Sends one already-framed JSON string over the child IPC channel. */
  send(frame: string): void
  kill(): void
  /** Persistent message listeners are used only by the optional RPC adapter. */
  on?(event: 'message', listener: (...args: unknown[]) => void): void
  once(event: 'message' | 'exit' | 'error', listener: (...args: unknown[]) => void): void
  off(event: 'message' | 'exit' | 'error', listener: (...args: unknown[]) => void): void
}

export class FigPluginBridgeTransportError extends Error {
  readonly code: FigPluginBridgeSupervisorFailureCode

  constructor(code: FigPluginBridgeSupervisorFailureCode) {
    super(`Bridge transport ${code.toLowerCase().replaceAll('_', ' ')}.`)
    this.name = 'FigPluginBridgeTransportError'
    this.code = code
  }
}

export type FigPluginBridgeChildTransportInput = { origin: string }
export type FigPluginBridgeChildLaunchInput = {
  origin: string
  protocol: typeof FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL
  nonce: string
}
export type FigPluginBridgeChildProcessTransportOptions<
  TInput extends FigPluginBridgeChildTransportInput
> = {
  /**
   * Launch metadata is deliberately narrower than the supervisor input. In
   * particular, runtime handles, profiles and credentials must never cross
   * the child-process boundary as an incidental spread property.
   */
  launch(
    input: FigPluginBridgeChildLaunchInput
  ): FigPluginBridgeProcessPort | Promise<FigPluginBridgeProcessPort>
  handshakeTimeoutMs?: number
  shutdownTimeoutMs?: number
  randomNonce?: () => string
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  /**
   * Optional parent-owned runtime dispatch. The child may host an HTTP
   * listener, but it never receives the runtime object or credentials.
   */
  rpc?: {
    handle: (
      input: TInput,
      request: FigPluginBridgeChildRpcRequestContext,
      signal: AbortSignal
    ) => unknown | Promise<unknown>
    onProtocolError?: (error: unknown) => void
    onTrace?: (event: FigPluginBridgeChildRpcTrace) => void
  }
}

const boundedTimeout = (value: number | undefined, fallback: number): number =>
  Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, 30_000) : fallback

const nonce = (): string => randomBytes(16).toString('hex')

/**
 * Contract adapter for a future Bridge child process. It is intentionally not
 * a process launcher: callers inject `launch`, so production can use Electron
 * utilityProcess/fork while tests prove handshake, timeout, exit and shutdown
 * semantics without claiming an OS-level E2E result.
 */
export function createChildProcessBridgeTransport<
  TInput extends FigPluginBridgeChildTransportInput
>(options: FigPluginBridgeChildProcessTransportOptions<TInput>): FigPluginBridgeTransport<TInput> {
  const handshakeTimeoutMs = boundedTimeout(options.handshakeTimeoutMs, 5_000)
  const shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs, 2_000)
  const makeNonce = options.randomNonce ?? nonce
  const setTimer = options.setTimeout ?? globalThis.setTimeout
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout

  return {
    kind: 'child-process',
    async start(input): Promise<FigPluginBridgeServer> {
      const parsedOrigin = figPluginBridgeOriginSchema.safeParse(input.origin)
      if (!parsedOrigin.success) throw new FigPluginBridgeTransportError('IPC_HANDSHAKE_FAILED')
      const origin = parsedOrigin.data
      const processNonce = makeNonce()
      if (!/^[a-f0-9]{32}$/.test(processNonce))
        throw new FigPluginBridgeTransportError('IPC_HANDSHAKE_FAILED')
      const port = await options.launch({
        origin,
        protocol: FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL,
        nonce: processNonce
      })
      let exited = false
      let closing = false
      let killAttempted = false
      let crashReported = false
      let rpcEndpoint: FigPluginBridgeChildRpcEndpoint | undefined
      const crashListeners = new Set<() => void>()
      const killBestEffort = (): void => {
        if (killAttempted) return
        killAttempted = true
        try {
          port.kill()
        } catch {
          // Preserve the handshake error; child cleanup is best effort only.
        }
      }
      const notifyCrash = (): void => {
        if (crashReported) return
        crashReported = true
        for (const listener of crashListeners) {
          try {
            listener()
          } catch {
            // A lifecycle observer cannot prevent child cleanup or another
            // observer from seeing the crash.
          }
        }
      }
      const onExit = (): void => {
        if (exited) return
        exited = true
        rpcEndpoint?.close()
        rpcEndpoint = undefined
        port.off('error', onRuntimeError)
        if (!closing) notifyCrash()
      }
      port.once('exit', onExit)

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimer(() => {
          finish(new FigPluginBridgeTransportError('IPC_TIMEOUT'))
        }, handshakeTimeoutMs)
        const cleanup = (): void => {
          clearTimer(timer)
          port.off('message', onMessage)
          port.off('error', onError)
          port.off('exit', onHandshakeExit)
        }
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          cleanup()
          // A failed handshake never exposes a usable server. Detach the
          // permanent crash listener so a rejected start cannot retain the
          // process port or report a late crash into a discarded transport.
          if (error) {
            port.off('exit', onExit)
            // The launch succeeded, so a failed handshake must not leave an
            // unowned child process behind. Keep the original bounded error.
            killBestEffort()
          }
          if (error) reject(error)
          else resolve()
        }
        const onMessage = (value: unknown): void => {
          const message = decodeFigPluginBridgeChildFrame(value)
          if (!message || message.kind !== 'ready') {
            finish(new FigPluginBridgeTransportError('IPC_HANDSHAKE_FAILED'))
            return
          }
          if (
            message.protocol !== FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL ||
            message.nonce !== processNonce ||
            message.origin !== origin
          ) {
            finish(new FigPluginBridgeTransportError('IPC_HANDSHAKE_FAILED'))
            return
          }
          finish()
        }
        const onError = (): void => finish(new FigPluginBridgeTransportError('CHILD_CRASHED'))
        const onHandshakeExit = (): void =>
          finish(new FigPluginBridgeTransportError('CHILD_CRASHED'))
        port.once('message', onMessage)
        port.once('error', onError)
        port.once('exit', onHandshakeExit)
        try {
          port.send(
            frameForBootstrap({
              protocol: FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL,
              nonce: processNonce,
              origin
            })
          )
        } catch {
          finish(new FigPluginBridgeTransportError('IPC_SEND_FAILED'))
        }
      })
      if (exited) throw new FigPluginBridgeTransportError('CHILD_CRASHED')

      // ChildProcess can emit an error independently of its eventual exit.
      // Keep one bounded listener after the handshake so a late IPC error is
      // surfaced through the same crash path instead of becoming an unhandled
      // EventEmitter error in the desktop main process.
      function onRuntimeError(): void {
        // An IPC error is a crash signal, not proof that the process has
        // exited. Keep the listener armed so a second error cannot become an
        // unhandled EventEmitter error while the child is shutting down.
        if (!closing) {
          notifyCrash()
          if (!exited) port.once('error', onRuntimeError)
        }
      }
      port.once('error', onRuntimeError)

      if (options.rpc) {
        try {
          rpcEndpoint = createFigPluginBridgeChildRpcEndpoint({
            port,
            nonce: processNonce,
            handle: (request, signal) => options.rpc!.handle(input, request, signal),
            onProtocolError: (error) => {
              // A child that emits an invalid/duplicate RPC frame is no
              // longer a trusted transport. Revoke the endpoint and kill the
              // process rather than leaving HTTP requests hanging.
              try {
                options.rpc?.onProtocolError?.(error)
              } finally {
                try {
                  notifyCrash()
                } finally {
                  killBestEffort()
                }
              }
            },
            onTrace: options.rpc.onTrace
          })
        } catch (error) {
          killBestEffort()
          throw error instanceof FigPluginBridgeChildRpcError
            ? error
            : new FigPluginBridgeTransportError('IPC_HANDSHAKE_FAILED')
        }
      }

      const waitForExit = (): Promise<void> => {
        if (exited) return Promise.resolve()
        return new Promise((resolve, reject) => {
          const timer = setTimer(() => {
            port.off('exit', onShutdownExit)
            reject(new FigPluginBridgeTransportError('IPC_TIMEOUT'))
          }, shutdownTimeoutMs)
          const onShutdownExit = (): void => {
            clearTimer(timer)
            port.off('error', onRuntimeError)
            resolve()
          }
          port.once('exit', onShutdownExit)
        })
      }
      let closePromise: Promise<void> | undefined
      const close = (): Promise<void> => {
        if (closePromise) return closePromise
        closing = true
        const pending = (async () => {
          rpcEndpoint?.close()
          rpcEndpoint = undefined
          if (exited) return
          try {
            port.send(
              frameForShutdown({
                protocol: FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL,
                nonce: processNonce,
                origin,
                reason: 'supervisor-stop'
              })
            )
          } catch {
            killBestEffort()
            throw new FigPluginBridgeTransportError('IPC_SEND_FAILED')
          }
          try {
            await waitForExit()
          } catch (error) {
            killBestEffort()
            throw error
          }
        })()
        // A failed close is retryable: the supervisor intentionally retains
        // the server handle until a later stop() can observe the exit.
        closePromise = pending.catch((error: unknown) => {
          closePromise = undefined
          throw error
        })
        return closePromise
      }
      return {
        origin,
        close,
        onCrash(listener) {
          crashListeners.add(listener)
          return () => crashListeners.delete(listener)
        }
      }
    }
  }
}

/**
 * Explicit parent-owned runtime adapter for production callers that opt in to
 * the child transport. The runtime is supplied only through the supervisor's
 * private start input and is never included in bootstrap metadata. The
 * default controller path remains the in-process transport.
 */
export type FigPluginBridgeParentOwnedChildTransportInput = FigPluginBridgeChildTransportInput & {
  runtime: FigPluginBridgeChildRuntime
}

export function createParentOwnedFigPluginBridgeChildTransport(
  options: Omit<
    FigPluginBridgeChildProcessTransportOptions<FigPluginBridgeParentOwnedChildTransportInput>,
    'rpc'
  > & {
    onTrace?: (event: FigPluginBridgeChildRpcTrace) => void
  }
): FigPluginBridgeTransport<FigPluginBridgeParentOwnedChildTransportInput> {
  const handlers = new WeakMap<object, FigPluginBridgeChildRpcHandler>()
  return createChildProcessBridgeTransport({
    ...options,
    rpc: {
      handle: (input, request, signal) => {
        let handler = handlers.get(input.runtime)
        if (!handler) {
          handler = createFigPluginBridgeChildRuntimeHandler(input.runtime)
          handlers.set(input.runtime, handler)
        }
        return handler(request, signal)
      },
      onTrace: options.onTrace
    }
  })
}
