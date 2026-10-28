import {
  decodeFigPluginBridgeChildFrame,
  frameForReady,
  type FigPluginBridgeChildFrame
} from './bridgeChildProtocol'

export const FIGPLUGIN_BRIDGE_CHILD_EXIT_PROTOCOL_ERROR = 2

type ParentPortEvent = { data: unknown; ports?: readonly unknown[] }
export type FigPluginBridgeChildPort = {
  on(event: 'message', listener: (event: ParentPortEvent) => void): unknown
  removeListener(event: 'message', listener: (event: ParentPortEvent) => void): unknown
  postMessage(value: string): void
}

type ChildPhase = 'await-bootstrap' | 'starting' | 'ready' | 'shutting-down' | 'closed'

export type FigPluginBridgeChildSession = Pick<
  Extract<FigPluginBridgeChildFrame, { kind: 'bootstrap' }>,
  'protocol' | 'nonce' | 'origin'
>

export type FigPluginBridgeChildRuntimeOptions = {
  /** Start the child HTTP listener and RPC client before ready is emitted. */
  onReady?: (session: FigPluginBridgeChildSession) => void | Promise<void>
  /** Consume a non-protocol frame (normally a child RPC response). */
  onRpcMessage?: (value: unknown) => boolean | Promise<boolean>
  /** Close the child HTTP listener/RPC client before a clean exit. */
  onShutdown?: () => void | Promise<void>
  /** Called when a malformed frame is rejected. */
  onProtocolError?: (value: unknown) => void
}

const eventData = (event: unknown): unknown => {
  if (!event || typeof event !== 'object' || !('data' in event)) return undefined
  return (event as { data?: unknown }).data
}

const hasTransferredPorts = (event: unknown): boolean => {
  if (!event || typeof event !== 'object' || !('ports' in event)) return false
  const ports = (event as { ports?: unknown }).ports
  return ports !== undefined && (!Array.isArray(ports) || ports.length > 0)
}

/**
 * Runs the fixed utility-process protocol endpoint. This endpoint deliberately
 * owns no Bridge runtime, HTTP listener, credentials, or filesystem authority;
 * it only proves the parent can establish and close an isolated child.
 */
export function runFigPluginBridgeChild(
  port: FigPluginBridgeChildPort,
  exit: (code: number) => void,
  options: FigPluginBridgeChildRuntimeOptions = {}
): void {
  let phase: ChildPhase = 'await-bootstrap'
  let session:
    | Pick<
        Extract<FigPluginBridgeChildFrame, { kind: 'bootstrap' }>,
        'protocol' | 'nonce' | 'origin'
      >
    | undefined
  const stop = (code: number): void => {
    if (phase === 'closed') return
    phase = 'closed'
    try {
      if (registeredListener) port.removeListener('message', registeredListener)
    } catch {
      // Exit remains authoritative if listener cleanup is unavailable.
    }
    exit(code)
  }

  const failProtocol = (value: unknown): void => {
    try {
      options.onProtocolError?.(value)
    } catch {
      // Protocol failure remains authoritative if diagnostics fail.
    }
    stop(FIGPLUGIN_BRIDGE_CHILD_EXIT_PROTOCOL_ERROR)
  }

  const onMessage = async (event: ParentPortEvent): Promise<void> => {
    if (phase === 'closed') return
    if (hasTransferredPorts(event)) {
      failProtocol(event)
      return
    }
    const frame = decodeFigPluginBridgeChildFrame(eventData(event))

    if (phase === 'await-bootstrap') {
      if (!frame || frame.kind !== 'bootstrap') {
        failProtocol(eventData(event))
        return
      }
      session = { protocol: frame.protocol, nonce: frame.nonce, origin: frame.origin }
      phase = 'starting'
      try {
        const ready = options.onReady?.(session)
        if (ready && typeof (ready as PromiseLike<void>).then === 'function') await ready
        if (phase !== 'starting') return
        phase = 'ready'
        port.postMessage(frameForReady(session))
      } catch {
        failProtocol(frame)
      }
      return
    }

    if (phase === 'starting' || phase === 'shutting-down' || !session) {
      failProtocol(eventData(event))
      return
    }

    if (!frame) {
      if (!options.onRpcMessage) {
        failProtocol(eventData(event))
        return
      }
      try {
        if (!(await options.onRpcMessage(eventData(event)))) failProtocol(eventData(event))
      } catch {
        failProtocol(eventData(event))
      }
      return
    }

    if (
      frame.kind !== 'shutdown' ||
      frame.protocol !== session.protocol ||
      frame.nonce !== session.nonce ||
      frame.origin !== session.origin
    ) {
      failProtocol(frame)
      return
    }
    phase = 'shutting-down'
    try {
      const shutdown = options.onShutdown?.()
      if (shutdown && typeof (shutdown as PromiseLike<void>).then === 'function') await shutdown
      stop(0)
    } catch {
      failProtocol(frame)
    }
  }

  // Electron's event emitter ignores the returned Promise; keep rejection
  // inside the handler so malformed/failed startup always exits fail-closed.
  const registeredListener = (event: ParentPortEvent): void => {
    void onMessage(event).catch(() => failProtocol(eventData(event)))
  }
  port.on('message', registeredListener)
}
