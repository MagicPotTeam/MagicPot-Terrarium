import { once } from 'node:events'
import { request as httpRequest, createServer, type IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIGPLUGIN_BRIDGE_ERRORS } from '@shared/figplugin/bridge'
import { FIGPLUGIN_BRIDGE_PROBE_PATH } from '@shared/figplugin/bridgeReadiness'
import { FigPluginBridgeChildRpcError, type FigPluginBridgeChildRpcClient } from './bridgeChildRpc'
import {
  assertFigPluginBridgeChildHttpRoutes,
  figPluginBridgeChildHttpRoute,
  startFigPluginBridgeChildHttpServer
} from './bridgeChildHttp'

const sessions = {
  authorization: `Bearer ${'b'.repeat(64)}`,
  'X-FigPlugin-Session': 'a'.repeat(32)
}
const jsonHeaders = {
  'Content-Type': 'application/json',
  'Content-Length': '0'
}
const servers: Array<{ close(): Promise<void> }> = []

const reserve = async (): Promise<{ origin: string; close(): Promise<void> }> => {
  const holder = createServer()
  holder.listen({ host: '127.0.0.1', port: 0 })
  await once(holder, 'listening')
  const address = holder.address()
  if (!address || typeof address === 'string') throw new Error('Invalid fixture address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => holder.close(() => resolve()))
  }
}

type Reply = { status: number; headers: IncomingMessage['headers']; text: string }
const post = (
  origin: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = sessions
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const request = httpRequest(
      origin,
      {
        method: 'POST',
        path,
        agent: false,
        headers: { ...jsonHeaders, ...headers, 'Content-Length': Buffer.byteLength(data) }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    request.on('error', reject)
    request.setTimeout(2_000, () => request.destroy(new Error('Fixture timeout')))
    request.end(data)
  })

const client = (
  request: FigPluginBridgeChildRpcClient['request'],
  close: FigPluginBridgeChildRpcClient['close'] = vi.fn()
): Pick<FigPluginBridgeChildRpcClient, 'request' | 'close'> => ({ request, close })

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('child bridge HTTP ingress', () => {
  it('keeps every HTTP route method in the child RPC allowlist', () => {
    expect(() => assertFigPluginBridgeChildHttpRoutes()).not.toThrow()
  })

  it('exposes only exact allowlisted routes and maps authenticated requests to RPC', async () => {
    expect(figPluginBridgeChildHttpRoute('/figplugin/v1/status')).toMatchObject({
      method: 'status',
      auth: 'session'
    })
    expect(figPluginBridgeChildHttpRoute('/figplugin/v1/unknown')).toBeUndefined()

    const reservation = await reserve()
    await reservation.close()
    const request = vi.fn().mockResolvedValue({ protocol: 1, callId: 'c'.repeat(32) })
    const rpc = client(request)
    const bridge = await startFigPluginBridgeChildHttpServer({
      origin: reservation.origin,
      rpc
    })
    servers.push(bridge)

    const body = { protocol: 1, callId: 'c'.repeat(32), correlationId: 'e'.repeat(32) }
    const response = await post(bridge.origin, '/figplugin/v1/status', body)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toEqual({ protocol: 1, callId: 'c'.repeat(32) })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'status',
        body,
        correlationId: 'e'.repeat(32),
        session: sessions['X-FigPlugin-Session'],
        token: 'b'.repeat(64),
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('keeps the probe local and rejects credentials on public routes', async () => {
    const reservation = await reserve()
    await reservation.close()
    const request = vi.fn()
    const bridge = await startFigPluginBridgeChildHttpServer({
      origin: reservation.origin,
      rpc: client(request)
    })
    servers.push(bridge)
    const probe = await post(
      bridge.origin,
      FIGPLUGIN_BRIDGE_PROBE_PATH,
      {
        protocol: 1,
        nonce: 'c'.repeat(32)
      },
      {}
    )
    expect(probe.status).toBe(200)
    expect(JSON.parse(probe.text)).toEqual({
      protocol: 1,
      kind: 'figplugin-bridge-probe',
      nonce: 'c'.repeat(32)
    })
    expect(request).not.toHaveBeenCalled()

    const forbidden = await post(bridge.origin, '/figplugin/v1/pair', { protocol: 1 }, sessions)
    expect(forbidden.status).toBe(401)
    expect(JSON.parse(forbidden.text)).toEqual({
      code: 'UNAUTHORIZED',
      message: FIGPLUGIN_BRIDGE_ERRORS.UNAUTHORIZED
    })
  })

  it('rate limits a child HTTP session before forwarding another RPC request', async () => {
    const reservation = await reserve()
    await reservation.close()
    const request = vi.fn().mockResolvedValue({ protocol: 1, callId: 'c'.repeat(32) })
    const bridge = await startFigPluginBridgeChildHttpServer({
      origin: reservation.origin,
      rateLimit: { windowMs: 10_000, maxRequests: 1 },
      rpc: client(request)
    })
    servers.push(bridge)

    const body = { protocol: 1, callId: 'c'.repeat(32) }
    expect((await post(bridge.origin, '/figplugin/v1/status', body)).status).toBe(200)
    const limited = await post(bridge.origin, '/figplugin/v1/status', body)
    expect(limited.status).toBe(429)
    expect(JSON.parse(limited.text)).toEqual({
      code: 'BUSY',
      message: FIGPLUGIN_BRIDGE_ERRORS.BUSY
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('preserves bounded RPC errors and aborts the RPC request on a deadline', async () => {
    const reservation = await reserve()
    await reservation.close()
    const unauthorized = vi.fn().mockRejectedValue(new FigPluginBridgeChildRpcError('UNAUTHORIZED'))
    const bridge = await startFigPluginBridgeChildHttpServer({
      origin: reservation.origin,
      rpc: client(unauthorized)
    })
    servers.push(bridge)
    const denied = await post(bridge.origin, '/figplugin/v1/status', { protocol: 1 })
    expect(denied.status).toBe(401)
    expect(JSON.parse(denied.text)).toEqual({
      code: 'UNAUTHORIZED',
      message: FIGPLUGIN_BRIDGE_ERRORS.UNAUTHORIZED
    })
    await bridge.close()
    servers.splice(servers.indexOf(bridge), 1)

    let aborted = false
    const slow = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason)
            },
            { once: true }
          )
        })
    )
    const secondReservation = await reserve()
    await secondReservation.close()
    const timed = await startFigPluginBridgeChildHttpServer({
      origin: secondReservation.origin,
      requestTimeoutMs: 20,
      rpc: client(slow as FigPluginBridgeChildRpcClient['request'])
    })
    servers.push(timed)
    const timeout = await post(timed.origin, '/figplugin/v1/status', { protocol: 1 })
    expect(timeout.status).toBe(504)
    expect(aborted).toBe(true)
  })
})
