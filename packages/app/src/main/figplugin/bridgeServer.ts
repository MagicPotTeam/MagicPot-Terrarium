import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { TextDecoder } from 'node:util'
import type { z } from 'zod'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  FigPluginBridgeError,
  figPluginBridgeCancelRequestSchema,
  figPluginBridgeOriginSchema,
  figPluginBridgePrepareRequestSchema,
  figPluginBridgePrepareResponseSchema,
  figPluginBridgeSessionCloseRequestSchema,
  figPluginBridgeStatusRequestSchema,
  figPluginBridgeStatusResponseSchema,
  figPluginPairRequestSchema,
  figPluginPairResponseSchema,
  parseFigPluginBridgeValue,
  type FigPluginBridgeErrorCode
} from '@shared/figplugin/bridge'
import {
  figPluginExecutionClaimRequestSchema,
  figPluginExecutionClaimResponseSchema,
  figPluginExecutionProgressRequestSchema,
  figPluginExecutionResultRequestSchema,
  figPluginExecutionResultResponseSchema,
  figPluginExecutionStatusRequestSchema,
  figPluginExecutionStatusSchema,
  figPluginVisualCorrectionPrepareRequestSchema,
  figPluginVisualCorrectionPrepareResponseSchema
} from '@shared/figplugin/execution'
import type { FigPluginBridgeRuntime } from './bridgeRuntime'

type Runtime = Pick<
  FigPluginBridgeRuntime,
  | 'redeem'
  | 'prepare'
  | 'status'
  | 'cancel'
  | 'closeSession'
  | 'planStatus'
  | 'prepareVisualCorrection'
  | 'claimPlan'
  | 'planProgress'
  | 'planResult'
>
type Options = { origin: string; runtime: Runtime; requestTimeoutMs?: number }
const paths = new Set([
  '/figplugin/v1/pair',
  '/figplugin/v1/prepare',
  '/figplugin/v1/status',
  '/figplugin/v1/cancel',
  '/figplugin/v1/close',
  '/figplugin/v1/plan/status',
  '/figplugin/v1/plan/correction/prepare',
  '/figplugin/v1/plan/claim',
  '/figplugin/v1/plan/progress',
  '/figplugin/v1/plan/result'
])
const allowedHeaders = ['content-type', 'authorization', 'x-figplugin-session']
const MAX_RAW_HEADERS = 32
const statusCodes: Record<FigPluginBridgeErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  EXPIRED: 410,
  BUSY: 429,
  CONFIGURATION_CHANGED: 409,
  DENIED: 403,
  CANCELLED: 409,
  TIMEOUT: 504,
  UPSTREAM_FAILED: 502
}
const invalid = (): never => {
  throw new FigPluginBridgeError('INVALID_REQUEST')
}
const errorBody = (code: FigPluginBridgeErrorCode): string =>
  JSON.stringify({ code, message: FIGPLUGIN_BRIDGE_ERRORS[code] })

// Inspect raw headers, not Node's merged/discarded duplicates (especially Host and credentials).
const headersOf = (request: IncomingMessage): Map<string, string> => {
  // maxHeadersCount is intentionally disabled below because Node silently truncates at that
  // boundary. Count the raw pairs ourselves so oversized requests are rejected, not normalized.
  if (request.rawHeaders.length / 2 > MAX_RAW_HEADERS) invalid()
  const headers = new Map<string, string>()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index].toLowerCase()
    if (headers.has(name)) invalid()
    headers.set(name, request.rawHeaders[index + 1])
  }
  return headers
}

const readJson = (request: IncomingMessage, limit: number, signal: AbortSignal): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let parts: string[] = []
    let bytes = 0
    const cleanup = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      signal.removeEventListener('abort', onAbort)
      request.pause()
    }
    const fail = (error: unknown): void => {
      cleanup()
      parts = []
      reject(error)
    }
    const onAbort = (): void => fail(signal.reason)
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > limit) return fail(new FigPluginBridgeError('INVALID_REQUEST'))
      try {
        parts.push(decoder.decode(chunk, { stream: true }))
      } catch {
        fail(new FigPluginBridgeError('INVALID_REQUEST'))
      }
    }
    const onEnd = (): void => {
      cleanup()
      try {
        // Trailers are not a second credential or input envelope.
        if (request.rawTrailers.length) invalid()
        const value: unknown = JSON.parse(parts.join('') + decoder.decode())
        parts = []
        resolve(value)
      } catch {
        fail(new FigPluginBridgeError('INVALID_REQUEST'))
      }
    }
    if (signal.aborted) return onAbort()
    request.on('data', onData)
    request.once('end', onEnd)
    signal.addEventListener('abort', onAbort, { once: true })
  })

const withinDeadline = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  let onAbort!: () => void
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    // Attach a rejection handler even when work ignores cancellation and settles much later.
    return await Promise.race([work, stopped])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const serialize = (schema: z.ZodTypeAny, value: unknown): string => {
  try {
    const json = JSON.stringify(schema.parse(value))
    if (Buffer.byteLength(json, 'utf8') > 128 * 1024) throw new Error()
    return json
  } catch {
    throw new FigPluginBridgeError('UPSTREAM_FAILED')
  }
}

const dispatch = async (
  runtime: Runtime,
  path: string,
  session: string,
  token: string,
  body: unknown
): Promise<string | undefined> => {
  switch (path) {
    case '/figplugin/v1/pair':
      return serialize(
        figPluginPairResponseSchema,
        await runtime.redeem(parseFigPluginBridgeValue(figPluginPairRequestSchema, body))
      )
    case '/figplugin/v1/prepare':
      return serialize(
        figPluginBridgePrepareResponseSchema,
        await runtime.prepare(
          session,
          token,
          parseFigPluginBridgeValue(figPluginBridgePrepareRequestSchema, body)
        )
      )
    case '/figplugin/v1/status':
      return serialize(
        figPluginBridgeStatusResponseSchema,
        await runtime.status(
          session,
          token,
          parseFigPluginBridgeValue(figPluginBridgeStatusRequestSchema, body).callId
        )
      )
    case '/figplugin/v1/cancel':
      await runtime.cancel(
        session,
        token,
        parseFigPluginBridgeValue(figPluginBridgeCancelRequestSchema, body).callId
      )
      return undefined
    case '/figplugin/v1/close':
      parseFigPluginBridgeValue(figPluginBridgeSessionCloseRequestSchema, body)
      await runtime.closeSession(session, token)
      return undefined
    case '/figplugin/v1/plan/status':
      return serialize(
        figPluginExecutionStatusSchema,
        await runtime.planStatus(
          session,
          token,
          parseFigPluginBridgeValue(figPluginExecutionStatusRequestSchema, body)
        )
      )
    case '/figplugin/v1/plan/correction/prepare':
      return serialize(
        figPluginVisualCorrectionPrepareResponseSchema,
        await runtime.prepareVisualCorrection(
          session,
          token,
          parseFigPluginBridgeValue(figPluginVisualCorrectionPrepareRequestSchema, body)
        )
      )
    case '/figplugin/v1/plan/claim':
      return serialize(
        figPluginExecutionClaimResponseSchema,
        await runtime.claimPlan(
          session,
          token,
          parseFigPluginBridgeValue(figPluginExecutionClaimRequestSchema, body)
        )
      )
    case '/figplugin/v1/plan/progress':
      return serialize(
        figPluginExecutionStatusSchema,
        runtime.planProgress(
          session,
          token,
          parseFigPluginBridgeValue(figPluginExecutionProgressRequestSchema, body)
        )
      )
    case '/figplugin/v1/plan/result':
      return serialize(
        figPluginExecutionResultResponseSchema,
        runtime.planResult(
          session,
          token,
          parseFigPluginBridgeValue(figPluginExecutionResultRequestSchema, body)
        )
      )
    default:
      return invalid()
  }
}

/** Dedicated IPv4 loopback transport; never attach to the application/LLM server.
 * Opaque Origin: null is NOT an identity. Only the desktop-issued 256-bit pairing
 * secret and runtime-owned bearer sessions authorize work. No approval API is exposed.
 */
export async function startFigPluginBridgeServer({
  origin,
  runtime,
  requestTimeoutMs
}: Options): Promise<{ origin: string; close(): Promise<void> }> {
  const canonicalOrigin = parseFigPluginBridgeValue(figPluginBridgeOriginSchema, origin)
  const host = canonicalOrigin.slice('http://'.length)
  const port = Number(host.slice('127.0.0.1:'.length))
  const timeout = Number.isFinite(requestTimeoutMs)
    ? Math.max(1, Math.min(15_000, Math.floor(requestTimeoutMs!)))
    : 15_000
  const sockets = new Set<Socket>()
  const active = new Set<AbortController>()
  const handlers = new Set<Promise<void>>()
  const requests = new WeakMap<object, AbortController>()
  const replied = new WeakSet<object>()
  const deadlines = new WeakMap<Socket, { at: number; headers: ReturnType<typeof setTimeout> }>()
  let dispatching = 0
  let closing: Promise<void> | undefined
  const server = createServer({
    maxHeaderSize: 16 * 1024,
    requestTimeout: 15_000,
    headersTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
    // Our raw Host check also supplies the fixed JSON envelope for a missing Host.
    requireHostHeader: false
  })
  server.maxConnections = 32
  // Do not let Node silently discard headers before headersOf() enforces the raw 32-header bound.
  // Silent truncation would turn an oversized request into an apparently valid one.
  server.maxHeadersCount = 0

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller = new AbortController()
    requests.set(request.socket, controller)
    const deadline = deadlines.get(request.socket)!
    clearTimeout(deadline.headers)
    const disconnect = (): void => controller.abort(new FigPluginBridgeError('CANCELLED'))
    const expire = (): void => controller.abort(new FigPluginBridgeError('TIMEOUT'))
    const remaining = deadline.at - performance.now()
    const timer = setTimeout(expire, Math.max(1, remaining))
    timer.unref()
    if (remaining <= 0) expire()
    request.once('aborted', disconnect)
    request.on('error', disconnect)
    response.on('error', disconnect)
    response.once('close', disconnect)
    // Keep error handlers through socket teardown, including malformed/incomplete bodies.
    request.socket.once('close', () => {
      request.off('error', disconnect)
      response.off('error', disconnect)
    })
    response.once('finish', () => request.socket.destroy())
    response.shouldKeepAlive = false
    response.setHeader('Connection', 'close')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Vary', 'Origin')
    const send = (status: number, json?: string): void => {
      if (response.destroyed || response.writableEnded || replied.has(request.socket)) return
      replied.add(request.socket)
      response.statusCode = status
      if (json !== undefined) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('Content-Length', Buffer.byteLength(json, 'utf8'))
      }
      response.end(json)
    }
    try {
      const headers = headersOf(request)
      if (request.socket.remoteAddress !== '127.0.0.1' || headers.get('host') !== host) invalid()
      const originHeader = headers.get('origin')
      if (originHeader !== undefined && originHeader !== 'null') {
        throw new FigPluginBridgeError('DENIED')
      }
      // Figma's sandbox uses an opaque origin and documents wildcard ACAO. Never credentials.
      if (originHeader === 'null') response.setHeader('Access-Control-Allow-Origin', '*')
      if (!paths.has(request.url ?? '') || !['POST', 'OPTIONS'].includes(request.method ?? '')) {
        invalid()
      }
      if (headers.has('cookie') || headers.has('content-encoding') || headers.has('expect'))
        invalid()
      const transfer = headers.get('transfer-encoding')
      if (transfer !== undefined && transfer.toLowerCase() !== 'chunked') invalid()
      const length = headers.get('content-length')
      if (length !== undefined && !/^[0-9]+$/.test(length)) invalid()
      if (request.method === 'OPTIONS') {
        const method = headers.get('access-control-request-method')
        const requested = headers.get('access-control-request-headers')
        if (method !== undefined && method !== 'POST') invalid()
        if (
          requested !== undefined &&
          !requested
            .split(',')
            .every((value) => allowedHeaders.includes(value.trim().toLowerCase()))
        ) {
          invalid()
        }
        if (transfer !== undefined || (length !== undefined && Number(length) !== 0)) invalid()
        response.setHeader('Access-Control-Allow-Methods', 'POST')
        response.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '))
        send(204)
        return
      }
      let session = ''
      let token = ''
      const authorization = headers.get('authorization')
      if (request.url === '/figplugin/v1/pair') {
        if (authorization !== undefined || headers.has('x-figplugin-session')) {
          throw new FigPluginBridgeError('UNAUTHORIZED')
        }
      } else {
        session = headers.get('x-figplugin-session') ?? ''
        if (
          !/^Bearer [a-f0-9]{64}$(?![\s\S])/.test(authorization ?? '') ||
          !/^[a-f0-9]{32}$(?![\s\S])/.test(session)
        ) {
          throw new FigPluginBridgeError('UNAUTHORIZED')
        }
        token = authorization!.slice('Bearer '.length)
      }
      if (headers.get('content-type')?.toLowerCase() !== 'application/json') invalid()
      const limit = request.url === '/figplugin/v1/pair' ? 16 * 1024 : 64 * 1024
      if (
        length !== undefined &&
        (!Number.isSafeInteger(Number(length)) || Number(length) > limit)
      ) {
        invalid()
      }
      if (closing || active.size >= 16 || dispatching >= 16) throw new FigPluginBridgeError('BUSY')
      active.add(controller)
      const body = await readJson(request, limit, controller.signal)
      // Check the clock too: microtasks may run before an already-due timer callback.
      if (performance.now() >= deadline.at) expire()
      controller.signal.throwIfAborted()
      // Readers can finish together after other transports have disconnected.
      if (dispatching >= 16) throw new FigPluginBridgeError('BUSY')
      dispatching += 1
      const work = dispatch(runtime, request.url!, session, token, body).finally(() => {
        // HTTP cancellation releases the transport, not work that ignores it.
        dispatching -= 1
      })
      const json = await withinDeadline(work, controller.signal)
      if (performance.now() >= deadline.at) expire()
      controller.signal.throwIfAborted()
      send(json === undefined ? 204 : 200, json)
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason?.code === 'CANCELLED') return
      const code =
        error instanceof FigPluginBridgeError &&
        Object.prototype.hasOwnProperty.call(FIGPLUGIN_BRIDGE_ERRORS, error.code)
          ? error.code
          : 'UPSTREAM_FAILED'
      send(statusCodes[code], errorBody(code))
    } finally {
      clearTimeout(timer)
      active.delete(controller)
      request.off('aborted', disconnect)
      response.off('close', disconnect)
    }
  }
  const receive = (request: IncomingMessage, response: ServerResponse): void => {
    // One request per connection; pipelining must not create work behind a rejected request.
    if (requests.has(request.socket) || replied.has(request.socket)) {
      requests.get(request.socket)?.abort(new FigPluginBridgeError('CANCELLED'))
      request.socket.destroy()
      return
    }
    const work = handle(request, response)
    handlers.add(work)
    void work.finally(() => handlers.delete(work)).catch(() => request.socket.destroy())
  }
  server.on('request', receive)
  // Do not let Node send automatic 100/417 responses outside our fixed envelope.
  server.on('checkContinue', receive)
  server.on('checkExpectation', receive)
  server.on('connection', (socket) => {
    sockets.add(socket)
    // Bound even idle peers that never send the first HTTP byte.
    const headers = setTimeout(() => socket.destroy(), Math.min(5_000, timeout))
    headers.unref()
    deadlines.set(socket, { at: performance.now() + timeout, headers })
    const quietError = (): void => {
      socket.destroy()
    }
    socket.on('error', quietError)
    socket.once('close', () => {
      clearTimeout(headers)
      sockets.delete(socket)
      socket.off('error', quietError)
    })
  })
  const rejectSocket = (socket: Duplex): void => {
    requests.get(socket)?.abort(new FigPluginBridgeError('CANCELLED'))
    // A synchronous envelope rejection can precede Node's parser error for the same packet.
    if (replied.has(socket)) return
    if (!socket.writable) {
      socket.destroy()
      return
    }
    replied.add(socket)
    const json = errorBody('INVALID_REQUEST')
    socket.end(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\n' +
        'Vary: Origin\r\nContent-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
      () => socket.destroy()
    )
  }
  // Never log parser errors: they can contain raw packets, URLs and credentials.
  server.on('clientError', (_error, socket) => rejectSocket(socket))
  server.on('connect', (_request, socket) => rejectSocket(socket))
  server.on('upgrade', (_request, socket) => rejectSocket(socket))
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
        for (const controller of active) controller.abort(new FigPluginBridgeError('CANCELLED'))
        server.closeAllConnections()
        for (const socket of sockets) socket.destroy()
        await Promise.all([stopped, ...handlers])
      })()
    }
    return closing
  }
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException): void => {
      server.off('listening', listening)
      reject(
        Object.assign(new Error('The plugin bridge could not start.'), {
          code: error.code === 'EADDRINUSE' ? 'EADDRINUSE' : 'BRIDGE_START_FAILED'
        })
      )
    }
    const listening = (): void => {
      server.off('error', failed)
      server.on('error', () => void close())
      resolve()
    }
    server.once('error', failed)
    server.once('listening', listening)
    // A literal IPv4 address binds AF_INET only. No port zero, probing or fallback.
    server.listen({ host: '127.0.0.1', port, exclusive: true })
  })
  // Closing this transport does not dispose the parent-owned runtime. An already-started
  // redeem/prepare cannot be revoked by these APIs: late sessions/previews expire in runtime,
  // never deliver secrets over a dead response, and cannot invoke a model without main approval.
  return { origin: canonicalOrigin, close }
}
