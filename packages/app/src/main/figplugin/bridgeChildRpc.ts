import { randomBytes } from 'node:crypto'
import type { z } from 'zod'
import {
  FigPluginBridgeError,
  FIGPLUGIN_BRIDGE_ERRORS,
  figPluginBridgeCancelRequestSchema,
  figPluginBridgeSessionCloseRequestSchema,
  figPluginBridgeStatusRequestSchema,
  parseFigPluginBridgeValue,
  type FigPluginBridgeErrorCode
} from '@shared/figplugin/bridge'
import {
  figPluginImageGenerationProposalPrepareRequestSchema,
  figPluginImageGenerationProposalPrepareResponseSchema,
  figPluginImageGenerationProposalStatusRequestSchema,
  figPluginImageGenerationProposalStatusSchema,
  figPluginImageGenerationProposalCancelRequestSchema
} from '@shared/figplugin/nativeImageGeneration'
import {
  decodeFigPluginBridgeChildRpcCancel,
  decodeFigPluginBridgeChildRpcRequest,
  decodeFigPluginBridgeChildRpcResponse,
  encodeFigPluginBridgeChildRpcCancel,
  encodeFigPluginBridgeChildRpcRequest,
  encodeFigPluginBridgeChildRpcResponse,
  isFigPluginBridgeChildCorrelationId,
  type FigPluginBridgeChildRpcMethod,
  type FigPluginBridgeChildRpcRequest
} from './bridgeChildWire'

/**
 * The child side of Electron's utility-process IPC is intentionally tiny. A
 * child HTTP listener can use the client below, while the parent owns the
 * Bridge runtime and installs the endpoint. No arbitrary Electron message or
 * transferable is accepted by this contract.
 */
export type FigPluginBridgeChildRpcPort = {
  send?: (frame: string) => void
  postMessage?: (frame: string) => void
  on?: (event: 'message', listener: (...args: unknown[]) => void) => unknown
  off?: (event: 'message', listener: (...args: unknown[]) => void) => unknown
  removeListener?: (event: 'message', listener: (...args: unknown[]) => void) => unknown
}

export type FigPluginBridgeChildRpcRequestContext = Readonly<{
  method: FigPluginBridgeChildRpcMethod
  /** Transport lineage; omitted only for legacy direct handler callers. */
  correlationId?: string
  session?: string
  token?: string
  body: unknown
}>

export type FigPluginBridgeChildRpcHandler = (
  request: FigPluginBridgeChildRpcRequestContext,
  signal: AbortSignal
) => unknown | Promise<unknown>

export type FigPluginBridgeChildRpcTrace = Readonly<{
  correlationId: string
  requestId: string
  method: FigPluginBridgeChildRpcMethod
  stage: 'received' | 'completed' | 'failed' | 'cancelled'
  /** Elapsed wall-clock time from request receipt to this stage. */
  durationMs: number
  errorCode?: FigPluginBridgeErrorCode
}>

export type FigPluginBridgeChildRpcEndpointOptions = {
  port: FigPluginBridgeChildRpcPort
  nonce: string
  handle: FigPluginBridgeChildRpcHandler
  onTrace?: (event: FigPluginBridgeChildRpcTrace) => void
  now?: () => number
  onProtocolError?: (error: unknown) => void
}

export type FigPluginBridgeChildRpcEndpoint = {
  close(): void
}

export class FigPluginBridgeChildRpcError extends Error {
  readonly code:
    'IPC_SEND_FAILED' | 'IPC_TIMEOUT' | 'IPC_HANDSHAKE_FAILED' | FigPluginBridgeErrorCode

  constructor(
    code: 'IPC_SEND_FAILED' | 'IPC_TIMEOUT' | 'IPC_HANDSHAKE_FAILED' | FigPluginBridgeErrorCode
  ) {
    super(
      code in FIGPLUGIN_BRIDGE_ERRORS
        ? FIGPLUGIN_BRIDGE_ERRORS[code as FigPluginBridgeErrorCode]
        : `Bridge child RPC ${code.toLowerCase().replaceAll('_', ' ')}.`
    )
    this.name = 'FigPluginBridgeChildRpcError'
    this.code = code
  }
}

const requestId = (): string => randomBytes(16).toString('hex')

const sendFrame = (port: FigPluginBridgeChildRpcPort, frame: string): void => {
  try {
    if (typeof port.send === 'function') {
      port.send(frame)
      return
    }
    if (typeof port.postMessage === 'function') {
      port.postMessage(frame)
      return
    }
  } catch {
    throw new FigPluginBridgeChildRpcError('IPC_SEND_FAILED')
  }
  throw new FigPluginBridgeChildRpcError('IPC_SEND_FAILED')
}

const eventValue = (...args: unknown[]): unknown => {
  // Electron utilityProcess emits (event, value), whereas MessagePort emits
  // ({ data }). Tests and the fixed child entry may emit the value directly.
  const candidate = args.length > 1 ? args[1] : args[0]
  if (candidate && typeof candidate === 'object' && 'data' in candidate)
    return (candidate as { data?: unknown }).data
  return candidate
}

const addMessageListener = (
  port: FigPluginBridgeChildRpcPort,
  listener: (...args: unknown[]) => void
): (() => void) => {
  if (typeof port.on !== 'function') throw new FigPluginBridgeChildRpcError('IPC_HANDSHAKE_FAILED')
  port.on('message', listener)
  return () => {
    try {
      if (typeof port.off === 'function') port.off('message', listener)
      else port.removeListener?.('message', listener)
    } catch {
      // Listener cleanup is best effort during process teardown.
    }
  }
}

const errorCode = (error: unknown): FigPluginBridgeErrorCode =>
  error instanceof FigPluginBridgeError &&
  Object.prototype.hasOwnProperty.call(FIGPLUGIN_BRIDGE_ERRORS, error.code)
    ? error.code
    : error instanceof FigPluginBridgeChildRpcError &&
        Object.prototype.hasOwnProperty.call(FIGPLUGIN_BRIDGE_ERRORS, error.code)
      ? (error.code as FigPluginBridgeErrorCode)
      : 'UPSTREAM_FAILED'

/**
 * Parent-side RPC endpoint. The parent receives requests emitted by a child
 * HTTP listener and dispatches them to the main-owned runtime. Every request
 * has one AbortController; cancellation suppresses a late response even when
 * the runtime ignores the signal.
 */
export function createFigPluginBridgeChildRpcEndpoint(
  options: FigPluginBridgeChildRpcEndpointOptions
): FigPluginBridgeChildRpcEndpoint {
  const pending = new Map<
    string,
    {
      controller: AbortController
      requestId: string
      correlationId: string
      /** Only echo a correlation ID that was present on the wire request. */
      wireCorrelationId?: string
      method: FigPluginBridgeChildRpcMethod
      startedAt: number
      traced: boolean
    }
  >()
  // Request IDs are single-use for the whole child lifetime. Retaining a
  // bounded set prevents a replay after a response has already settled.
  const seen = new Set<string>()
  const MAX_SEEN_REQUESTS = 4096
  let closed = false
  let remove = (): void => undefined
  const onProtocolError = options.onProtocolError
  const now = options.now ?? Date.now

  const trace = (
    request: {
      requestId: string
      correlationId: string
      method: FigPluginBridgeChildRpcMethod
    },
    stage: FigPluginBridgeChildRpcTrace['stage'],
    startedAt: number,
    error?: FigPluginBridgeErrorCode
  ): void => {
    try {
      const elapsed = now() - startedAt
      options.onTrace?.({
        correlationId: request.correlationId,
        requestId: request.requestId,
        method: request.method,
        stage,
        durationMs: Number.isFinite(elapsed)
          ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(elapsed)))
          : 0,
        ...(error === undefined ? {} : { errorCode: error })
      })
    } catch {
      // Tracing is advisory and cannot affect the RPC authority.
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    remove()
    for (const current of pending.values()) {
      current.controller.abort(new FigPluginBridgeError('CANCELLED'))
      if (!current.traced) {
        current.traced = true
        trace(current, 'cancelled', current.startedAt, 'CANCELLED')
      }
    }
    pending.clear()
  }

  const report = (error: unknown): void => {
    try {
      onProtocolError?.(error)
    } catch {
      // A diagnostic callback must never escape an IPC event handler.
    }
  }

  const listener = (...args: unknown[]): void => {
    if (closed) return
    const frame = eventValue(...args)
    let request: FigPluginBridgeChildRpcRequest
    try {
      // A cancel is checked first because its envelope has no method/body.
      try {
        const cancel = decodeFigPluginBridgeChildRpcCancel(frame, options.nonce)
        const current = pending.get(cancel.requestId)
        if (current) {
          if (
            cancel.correlationId !== undefined &&
            (current.wireCorrelationId === undefined ||
              cancel.correlationId !== current.wireCorrelationId)
          ) {
            close()
            report(new FigPluginBridgeChildRpcError('IPC_HANDSHAKE_FAILED'))
            return
          }
          current.controller.abort(new FigPluginBridgeError('CANCELLED'))
          if (!current.traced) {
            current.traced = true
            trace(current, 'cancelled', current.startedAt, 'CANCELLED')
          }
        }
        return
      } catch {
        request = decodeFigPluginBridgeChildRpcRequest(frame, options.nonce)
      }
    } catch (error) {
      close()
      report(error)
      return
    }

    if (seen.has(request.requestId) || seen.size >= MAX_SEEN_REQUESTS) {
      close()
      report(new FigPluginBridgeChildRpcError('IPC_HANDSHAKE_FAILED'))
      return
    }
    seen.add(request.requestId)
    const controller = new AbortController()
    const current = {
      controller,
      requestId: request.requestId,
      correlationId: request.correlationId ?? requestId(),
      ...(request.correlationId === undefined ? {} : { wireCorrelationId: request.correlationId }),
      method: request.method,
      startedAt: now(),
      traced: false
    }
    pending.set(request.requestId, current)
    trace(current, 'received', current.startedAt)
    const context: FigPluginBridgeChildRpcRequestContext = {
      method: request.method,
      correlationId: current.correlationId,
      ...(request.session === undefined ? {} : { session: request.session }),
      ...(request.token === undefined ? {} : { token: request.token }),
      body: request.body
    }
    Promise.resolve()
      .then(() => options.handle(context, controller.signal))
      .then((result) => {
        // Cancellation wins over a handler that resolves in the same turn.
        if (controller.signal.aborted || closed) return
        sendFrame(
          options.port,
          encodeFigPluginBridgeChildRpcResponse({
            nonce: options.nonce,
            requestId: request.requestId,
            ...(current.wireCorrelationId === undefined
              ? {}
              : { correlationId: current.wireCorrelationId }),
            result
          })
        )
        if (!current.traced) {
          current.traced = true
          trace(current, 'completed', current.startedAt)
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || closed) return
        const code = errorCode(error)
        if (!current.traced) {
          current.traced = true
          trace(current, 'failed', current.startedAt, code)
        }
        try {
          sendFrame(
            options.port,
            encodeFigPluginBridgeChildRpcResponse({
              nonce: options.nonce,
              requestId: request.requestId,
              ...(current.wireCorrelationId === undefined
                ? {}
                : { correlationId: current.wireCorrelationId }),
              errorCode: code
            })
          )
        } catch (sendError) {
          report(sendError)
        }
      })
      .finally(() => {
        pending.delete(request.requestId)
      })
  }

  remove = addMessageListener(options.port, listener)
  return { close }
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
  correlationId?: string
}

export type FigPluginBridgeChildRpcClient = {
  request(input: {
    method: FigPluginBridgeChildRpcMethod
    body: unknown
    correlationId?: string
    session?: string
    token?: string
    signal?: AbortSignal
  }): Promise<unknown>
  /** Consume one parent response. Returns false for a protocol violation. */
  handleMessage(value: unknown): boolean
  close(error?: FigPluginBridgeChildRpcError): void
}

/**
 * Main-process runtime surface used by the optional child-process adapter.
 * Keeping this contract explicit prevents the transport factory from accepting
 * a renderer service, provider client, or arbitrary object as an RPC authority.
 */
export type FigPluginBridgeChildRuntime = {
  redeem(input: unknown): Promise<unknown>
  prepare(session: string, token: string, input: unknown): Promise<unknown>
  prepareImageGeneration(session: string, token: string, input: unknown): Promise<unknown>
  imageGenerationStatus(session: string, token: string, input: unknown): Promise<unknown>
  cancelImageGeneration(session: string, token: string, input: unknown): Promise<void>
  status(session: string, token: string, callId: unknown): Promise<unknown>
  readiness(session: string, token: string, input: unknown): Promise<unknown>
  assetList(session: string, token: string, input: unknown): Promise<unknown>
  assetChunk(session: string, token: string, input: unknown): Promise<unknown>
  planAssetChunk(session: string, token: string, input: unknown): Promise<unknown>
  cancel(session: string, token: string, callId: unknown): Promise<void>
  closeSession(session: string, token: string): void | Promise<void>
  planStatus(session: string, token: string, input: unknown): Promise<unknown>
  prepareVisualCorrection(session: string, token: string, input: unknown): Promise<unknown>
  prepareTaskRecovery(session: string, token: string, input: unknown): Promise<unknown>
  claimPlan(session: string, token: string, input: unknown): Promise<unknown>
  planProgress(session: string, token: string, input: unknown): unknown
  planResult(session: string, token: string, input: unknown): unknown
  planPixelAudit(session: string, token: string, input: unknown): Promise<unknown>
}

/** Child-side RPC client for a controlled HTTP listener. */
export function createFigPluginBridgeChildRpcClient(options: {
  port: FigPluginBridgeChildRpcPort
  nonce: string
  /** Let bridgeChildRuntime own the single IPC message listener. */
  listen?: boolean
}): FigPluginBridgeChildRpcClient {
  const pending = new Map<string, Pending>()
  let closed = false
  const handleMessage = (value: unknown): boolean => {
    if (closed) return false
    let response
    try {
      response = decodeFigPluginBridgeChildRpcResponse(value, options.nonce)
    } catch {
      // Requests are emitted by this child, so any non-response frame is a
      // parent protocol violation. Fail every pending call, not just one ID.
      close(new FigPluginBridgeChildRpcError('IPC_HANDSHAKE_FAILED'))
      return false
    }
    const current = pending.get(response.requestId)
    if (!current) {
      // Late/duplicate responses never revive a completed HTTP request.
      return true
    }
    if (current.correlationId !== undefined && response.correlationId !== current.correlationId) {
      close(new FigPluginBridgeChildRpcError('IPC_HANDSHAKE_FAILED'))
      return false
    }
    pending.delete(response.requestId)
    if (current.signal && current.onAbort)
      current.signal.removeEventListener('abort', current.onAbort)
    if (response.ok) current.resolve(response.result)
    else current.reject(new FigPluginBridgeChildRpcError(response.errorCode))
    return true
  }
  const remove =
    options.listen === false
      ? () => undefined
      : addMessageListener(options.port, (...args) => {
          handleMessage(eventValue(...args))
        })

  const close = (error = new FigPluginBridgeChildRpcError('IPC_HANDSHAKE_FAILED')): void => {
    if (closed) return
    closed = true
    remove()
    for (const [id, current] of pending) {
      if (current.signal && current.onAbort)
        current.signal.removeEventListener('abort', current.onAbort)
      current.reject(error)
      pending.delete(id)
    }
  }

  return {
    request(input) {
      if (closed) return Promise.reject(new FigPluginBridgeChildRpcError('IPC_HANDSHAKE_FAILED'))
      const id = requestId()
      const correlationId =
        input.correlationId === undefined
          ? undefined
          : isFigPluginBridgeChildCorrelationId(input.correlationId)
            ? input.correlationId
            : undefined
      const promise = new Promise<unknown>((resolve, reject) => {
        if (input.correlationId !== undefined && !correlationId) {
          reject(new FigPluginBridgeChildRpcError('IPC_HANDSHAKE_FAILED'))
          return
        }
        const current: Pending = { resolve, reject, signal: input.signal, correlationId }
        const abort = (): void => {
          if (!pending.delete(id)) return
          try {
            sendFrame(
              options.port,
              encodeFigPluginBridgeChildRpcCancel({
                nonce: options.nonce,
                requestId: id,
                correlationId
              })
            )
          } catch {
            // The local abort outcome is authoritative; the child is likely
            // already disconnected, so do not replace CANCELLED with a send error.
          }
          reject(new FigPluginBridgeError('CANCELLED'))
        }
        current.onAbort = abort
        pending.set(id, current)
        if (input.signal) {
          if (input.signal.aborted) {
            abort()
            return
          }
          input.signal.addEventListener('abort', abort, { once: true })
        }
        try {
          sendFrame(
            options.port,
            encodeFigPluginBridgeChildRpcRequest({
              nonce: options.nonce,
              requestId: id,
              correlationId,
              method: input.method,
              ...(input.session === undefined ? {} : { session: input.session }),
              ...(input.token === undefined ? {} : { token: input.token }),
              body: input.body
            })
          )
        } catch (error) {
          pending.delete(id)
          if (input.signal) input.signal.removeEventListener('abort', abort)
          reject(error)
        }
      })
      return promise
    },
    handleMessage,
    close
  }
}

/**
 * Adapt the main-owned runtime to the allowlisted wire method set. Runtime
 * methods retain their own schemas and authentication checks. Scalar-argument
 * methods need their complete envelope validated here before fields are dropped.
 */
export function createFigPluginBridgeChildRuntimeHandler(
  runtime: FigPluginBridgeChildRuntime
): FigPluginBridgeChildRpcHandler {
  const authenticated = (request: FigPluginBridgeChildRpcRequestContext): [string, string] => {
    if (!request.session || !request.token) throw new FigPluginBridgeError('UNAUTHORIZED')
    return [request.session, request.token]
  }
  const nativeResponse = (schema: z.ZodTypeAny, value: unknown): unknown => {
    try {
      return schema.parse(value)
    } catch {
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
  }
  return async (request) => {
    switch (request.method) {
      case 'redeem':
        return runtime.redeem(request.body)
      case 'prepare': {
        const [session, token] = authenticated(request)
        return runtime.prepare(session, token, request.body)
      }
      case 'prepareImageGeneration': {
        const [session, token] = authenticated(request)
        parseFigPluginBridgeValue(
          figPluginImageGenerationProposalPrepareRequestSchema,
          request.body
        )
        return nativeResponse(
          figPluginImageGenerationProposalPrepareResponseSchema,
          // Main must enforce its signed input limit against the untrimmed native payload.
          await runtime.prepareImageGeneration(session, token, request.body)
        )
      }
      case 'imageGenerationStatus': {
        const [session, token] = authenticated(request)
        const body = parseFigPluginBridgeValue(
          figPluginImageGenerationProposalStatusRequestSchema,
          request.body
        )
        return nativeResponse(
          figPluginImageGenerationProposalStatusSchema,
          await runtime.imageGenerationStatus(session, token, body)
        )
      }
      case 'cancelImageGeneration': {
        const [session, token] = authenticated(request)
        const body = parseFigPluginBridgeValue(
          figPluginImageGenerationProposalCancelRequestSchema,
          request.body
        )
        await runtime.cancelImageGeneration(session, token, body)
        return undefined
      }
      case 'status': {
        const [session, token] = authenticated(request)
        const body = parseFigPluginBridgeValue(figPluginBridgeStatusRequestSchema, request.body)
        return runtime.status(session, token, body.callId)
      }
      case 'readiness': {
        const [session, token] = authenticated(request)
        return runtime.readiness(session, token, request.body)
      }
      case 'assetList': {
        const [session, token] = authenticated(request)
        return runtime.assetList(session, token, request.body)
      }
      case 'assetChunk': {
        const [session, token] = authenticated(request)
        return runtime.assetChunk(session, token, request.body)
      }
      case 'planAssetChunk': {
        const [session, token] = authenticated(request)
        return runtime.planAssetChunk(session, token, request.body)
      }
      case 'cancel': {
        const [session, token] = authenticated(request)
        const body = parseFigPluginBridgeValue(figPluginBridgeCancelRequestSchema, request.body)
        return runtime.cancel(session, token, body.callId)
      }
      case 'closeSession': {
        const [session, token] = authenticated(request)
        parseFigPluginBridgeValue(figPluginBridgeSessionCloseRequestSchema, request.body)
        return runtime.closeSession(session, token)
      }
      case 'planStatus': {
        const [session, token] = authenticated(request)
        return runtime.planStatus(session, token, request.body)
      }
      case 'prepareVisualCorrection': {
        const [session, token] = authenticated(request)
        return runtime.prepareVisualCorrection(session, token, request.body)
      }
      case 'prepareTaskRecovery': {
        const [session, token] = authenticated(request)
        return runtime.prepareTaskRecovery(session, token, request.body)
      }
      case 'claimPlan': {
        const [session, token] = authenticated(request)
        return runtime.claimPlan(session, token, request.body)
      }
      case 'planProgress': {
        const [session, token] = authenticated(request)
        return runtime.planProgress(session, token, request.body)
      }
      case 'planResult': {
        const [session, token] = authenticated(request)
        return runtime.planResult(session, token, request.body)
      }
      case 'planPixelAudit': {
        const [session, token] = authenticated(request)
        return runtime.planPixelAudit(session, token, request.body)
      }
    }
  }
}
