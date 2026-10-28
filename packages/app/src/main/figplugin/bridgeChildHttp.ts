import { Buffer } from 'node:buffer'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { TextDecoder } from 'node:util'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  FigPluginBridgeError,
  figPluginBridgeOriginSchema,
  parseFigPluginBridgeValue,
  type FigPluginBridgeErrorCode
} from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_BRIDGE_PROBE_PATH,
  FIGPLUGIN_BRIDGE_READINESS_PATH,
  figPluginBridgeProbeRequestSchema,
  figPluginBridgeProbeResponseSchema
} from '@shared/figplugin/bridgeReadiness'
import { FigPluginBridgeChildRpcError, type FigPluginBridgeChildRpcClient } from './bridgeChildRpc'
import {
  FIGPLUGIN_BRIDGE_CHILD_RPC_METHODS,
  isFigPluginBridgeChildCorrelationId,
  type FigPluginBridgeChildRpcMethod
} from './bridgeChildWire'
import { FIGPLUGIN_ASSET_LIST_PATH, FIGPLUGIN_ASSET_READ_PATH } from '@shared/figplugin/hostAssets'
import { FIGPLUGIN_EXECUTION_ASSET_READ_PATH } from '@shared/figplugin/hostExecutionAssets'
import {
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_PREPARE_PATH,
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_STATUS_PATH,
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_CANCEL_PATH
} from '@shared/figplugin/nativeImageGeneration'
import {
  createFigPluginBridgeRateLimiter,
  type FigPluginBridgeRateLimitOptions
} from './bridgeRateLimit'

/**
 * HTTP is intentionally kept in the child as a narrow ingress adapter. The
 * parent still owns every schema, credential check and runtime mutation; this
 * module only validates transport framing and forwards an allowlisted method
 * over the strict child RPC client.
 */
export type FigPluginBridgeChildHttpRoute = Readonly<{
  method: 'probe' | FigPluginBridgeChildRpcMethod
  auth: 'none' | 'session'
  limit: number
  noContent: boolean
}>

const routes: Readonly<Record<string, FigPluginBridgeChildHttpRoute>> = {
  [FIGPLUGIN_NATIVE_IMAGE_GENERATION_PREPARE_PATH]: {
    method: 'prepareImageGeneration',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  },
  [FIGPLUGIN_NATIVE_IMAGE_GENERATION_STATUS_PATH]: {
    method: 'imageGenerationStatus',
    auth: 'session',
    limit: 4096,
    noContent: false
  },
  [FIGPLUGIN_NATIVE_IMAGE_GENERATION_CANCEL_PATH]: {
    method: 'cancelImageGeneration',
    auth: 'session',
    limit: 4096,
    noContent: true
  },
  [FIGPLUGIN_EXECUTION_ASSET_READ_PATH]: {
    method: 'planAssetChunk',
    auth: 'session',
    limit: 4 * 1024,
    noContent: false
  },
  [FIGPLUGIN_ASSET_LIST_PATH]: {
    method: 'assetList',
    auth: 'session',
    limit: 4 * 1024,
    noContent: false
  },
  [FIGPLUGIN_ASSET_READ_PATH]: {
    method: 'assetChunk',
    auth: 'session',
    limit: 4 * 1024,
    noContent: false
  },
  [FIGPLUGIN_BRIDGE_PROBE_PATH]: { method: 'probe', auth: 'none', limit: 256, noContent: false },
  [FIGPLUGIN_BRIDGE_READINESS_PATH]: {
    method: 'readiness',
    auth: 'session',
    limit: 4 * 1024,
    noContent: false
  },
  '/figplugin/v1/pair': { method: 'redeem', auth: 'none', limit: 16 * 1024, noContent: false },
  '/figplugin/v1/prepare': {
    method: 'prepare',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  },
  '/figplugin/v1/status': {
    method: 'status',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  },
  '/figplugin/v1/cancel': {
    method: 'cancel',
    auth: 'session',
    limit: 64 * 1024,
    noContent: true
  },
  '/figplugin/v1/close': {
    method: 'closeSession',
    auth: 'session',
    limit: 64 * 1024,
    noContent: true
  },
  '/figplugin/v1/plan/status': {
    method: 'planStatus',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  },
  '/figplugin/v1/plan/correction/prepare': {
    method: 'prepareVisualCorrection',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  },
  '/figplugin/v1/plan/recovery/prepare': {
    method: 'prepareTaskRecovery',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  },
  '/figplugin/v1/plan/claim': {
    method: 'claimPlan',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  },
  '/figplugin/v1/plan/progress': {
    method: 'planProgress',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  },
  '/figplugin/v1/plan/result': {
    method: 'planResult',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  },
  '/figplugin/v1/plan/pixel-audit': {
    method: 'planPixelAudit',
    auth: 'session',
    limit: 64 * 1024,
    noContent: false
  }
}

const allowedHeaders = ['content-type', 'authorization', 'x-figplugin-session']
const MAX_RAW_HEADERS = 32
const MAX_RESPONSE_BYTES = 128 * 1024
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

/** Exported for unit tests and for the future child entrypoint. */
export const figPluginBridgeChildHttpRoute = (
  path: string
): FigPluginBridgeChildHttpRoute | undefined => routes[path]

/**
 * Keep the HTTP route table and the child wire allowlist as one contract.
 * This runtime check also protects packaged JavaScript callers that do not
 * receive TypeScript's union check when a route is added.
 */
export const assertFigPluginBridgeChildHttpRoutes = (): void => {
  const methods = new Set<string>(FIGPLUGIN_BRIDGE_CHILD_RPC_METHODS)
  for (const route of Object.values(routes)) {
    if (route.method !== 'probe' && !methods.has(route.method))
      throw new Error(`Bridge child HTTP route is not in the RPC allowlist: ${route.method}`)
  }
}

const headersOf = (request: IncomingMessage): Map<string, string> => {
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
        if (request.rawTrailers.length) invalid()
        const value = JSON.parse(parts.join('') + decoder.decode()) as unknown
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
    return await Promise.race([work, stopped])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const encodeResponse = (value: unknown): string => {
  try {
    const json = JSON.stringify(value)
    if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_RESPONSE_BYTES)
      throw new Error('invalid response')
    return json
  } catch {
    throw new FigPluginBridgeError('UPSTREAM_FAILED')
  }
}

const bodyCorrelationId = (value: unknown): string | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = (value as Record<string, unknown>).correlationId
  return isFigPluginBridgeChildCorrelationId(candidate) ? candidate : undefined
}

type Options = {
  origin: string
  rpc: Pick<FigPluginBridgeChildRpcClient, 'request' | 'close'>
  requestTimeoutMs?: number
  rateLimit?: FigPluginBridgeRateLimitOptions
}

/** Start an exact-origin IPv4 loopback listener for the child process. */
export async function startFigPluginBridgeChildHttpServer({
  origin,
  rpc,
  requestTimeoutMs,
  rateLimit
}: Options): Promise<{ origin: string; close(): Promise<void> }> {
  assertFigPluginBridgeChildHttpRoutes()
  const canonicalOrigin = figPluginBridgeOriginSchema.parse(origin)
  const host = canonicalOrigin.slice('http://'.length)
  const port = Number(host.slice(host.lastIndexOf(':') + 1))
  const timeout = Number.isFinite(requestTimeoutMs)
    ? Math.max(1, Math.min(15_000, Math.floor(requestTimeoutMs!)))
    : 15_000
  const limiter = createFigPluginBridgeRateLimiter(rateLimit)
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
    requireHostHeader: false
  })
  server.maxConnections = 32
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
      if (originHeader !== undefined && originHeader !== 'null')
        throw new FigPluginBridgeError('DENIED')
      if (originHeader === 'null') response.setHeader('Access-Control-Allow-Origin', '*')
      const route = routes[request.url ?? '']
      if (!route || !['POST', 'OPTIONS'].includes(request.method ?? '')) invalid()
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
        )
          invalid()
        if (transfer !== undefined || (length !== undefined && Number(length) !== 0)) invalid()
        response.setHeader('Access-Control-Allow-Methods', 'POST')
        response.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '))
        send(204)
        return
      }
      let session: string | undefined
      let token: string | undefined
      const authorization = headers.get('authorization')
      if (route.auth === 'none') {
        if (authorization !== undefined || headers.has('x-figplugin-session'))
          throw new FigPluginBridgeError('UNAUTHORIZED')
      } else {
        session = headers.get('x-figplugin-session')
        if (
          !/^Bearer [a-f0-9]{64}$(?![\s\S])/.test(authorization ?? '') ||
          !/^[a-f0-9]{32}$(?![\s\S])/.test(session ?? '')
        )
          throw new FigPluginBridgeError('UNAUTHORIZED')
        token = authorization!.slice('Bearer '.length)
      }
      const rateKey = session
        ? `session:${session}`
        : `anonymous:${request.socket.remoteAddress ?? 'unknown'}:${request.url ?? ''}`
      if (!limiter.consume(rateKey)) throw new FigPluginBridgeError('BUSY')
      if (headers.get('content-type')?.toLowerCase() !== 'application/json') invalid()
      if (
        length !== undefined &&
        (!Number.isSafeInteger(Number(length)) || Number(length) > route.limit)
      )
        invalid()
      if (closing || active.size >= 16 || dispatching >= 16) throw new FigPluginBridgeError('BUSY')
      active.add(controller)
      const body = await readJson(request, route.limit, controller.signal)
      const correlationId = bodyCorrelationId(body)
      if (performance.now() >= deadline.at) expire()
      controller.signal.throwIfAborted()
      if (dispatching >= 16) throw new FigPluginBridgeError('BUSY')
      dispatching += 1
      const work =
        route.method === 'probe'
          ? Promise.resolve(
              figPluginBridgeProbeResponseSchema.parse({
                protocol: 1,
                kind: 'figplugin-bridge-probe',
                nonce: parseFigPluginBridgeValue(figPluginBridgeProbeRequestSchema, body).nonce
              })
            )
          : route.method === 'redeem'
            ? rpc.request({
                method: route.method,
                body,
                ...(correlationId === undefined ? {} : { correlationId }),
                signal: controller.signal
              })
            : rpc.request({
                method: route.method,
                body,
                ...(correlationId === undefined ? {} : { correlationId }),
                ...(session === undefined ? {} : { session }),
                ...(token === undefined ? {} : { token }),
                signal: controller.signal
              })
      const result = await withinDeadline(work, controller.signal).finally(() => {
        dispatching -= 1
      })
      if (performance.now() >= deadline.at) expire()
      controller.signal.throwIfAborted()
      send(route.noContent ? 204 : 200, route.noContent ? undefined : encodeResponse(result))
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason?.code === 'CANCELLED') return
      const code =
        (error instanceof FigPluginBridgeError || error instanceof FigPluginBridgeChildRpcError) &&
        Object.prototype.hasOwnProperty.call(FIGPLUGIN_BRIDGE_ERRORS, error.code)
          ? (error.code as FigPluginBridgeErrorCode)
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
  server.on('checkContinue', receive)
  server.on('checkExpectation', receive)
  server.on('connection', (socket) => {
    sockets.add(socket)
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
  server.on('clientError', (_error, socket) => rejectSocket(socket))
  server.on('connect', (_request, socket) => rejectSocket(socket))
  server.on('upgrade', (_request, socket) => rejectSocket(socket))
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        rpc.close()
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
        for (const controller of active) controller.abort(new FigPluginBridgeError('CANCELLED'))
        server.closeAllConnections()
        for (const socket of sockets) socket.destroy()
        limiter.clear()
        await Promise.all([stopped, ...handlers])
      })()
    }
    return closing
  }
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException): void => {
      server.off('listening', listening)
      reject(
        Object.assign(new Error('The plugin bridge child could not start.'), {
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
    server.listen({ host: '127.0.0.1', port, exclusive: true })
  })
  return { origin: canonicalOrigin, close }
}
