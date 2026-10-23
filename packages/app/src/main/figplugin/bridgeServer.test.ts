import { getEventListeners, once } from 'node:events'
import { request as httpRequest, Server, ServerResponse, type IncomingMessage } from 'node:http'
import { createConnection, createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  FigPluginBridgeError,
  type FigPluginBridgeErrorCode,
  type FigPluginBridgePrepareRequest,
  type FigPluginPairRequest,
  type FigPluginPairResponse
} from '@shared/figplugin/bridge'
import { startFigPluginBridgeServer } from './bridgeServer'

type Runtime = Parameters<typeof startFigPluginBridgeServer>[0]['runtime']
type Bridge = Awaited<ReturnType<typeof startFigPluginBridgeServer>>
const bridges: Bridge[] = []
const sockets = new Set<Socket>()
const session: FigPluginPairResponse = {
  protocol: 1,
  sessionId: 'a'.repeat(32),
  sessionToken: 'b'.repeat(64),
  expiresAt: 1_900_000_000_000,
  idleTimeoutMs: 120_000
}
const callId = 'c'.repeat(32)
const call = { protocol: 1 as const, callId }
const prepared = {
  ...call,
  status: 'awaiting-approval' as const,
  expiresAt: 1_900_000_000_000
}
const pairBody: FigPluginPairRequest = {
  protocol: 1,
  ticketId: 'd'.repeat(32),
  pairingSecret: 'e'.repeat(64),
  pluginId: 'demo.figma',
  host: 'figma',
  artifactSha256: 'f'.repeat(64),
  clientNonce: '0'.repeat(32)
}
const prepareBody = (sequence = 1): FigPluginBridgePrepareRequest => ({
  protocol: 1,
  requestId: `request_${sequence}`,
  sequence,
  prompt: 'Describe 界🌱',
  context: { nodes: [], selectionRevision: 'revision-1' }
})
const credentials = {
  Authorization: `Bearer ${session.sessionToken}`,
  'X-FigPlugin-Session': session.sessionId
}
const methods = ['redeem', 'prepare', 'status', 'cancel', 'closeSession'] as const
const makeRuntime = () => ({
  redeem: vi.fn<Runtime['redeem']>().mockResolvedValue(session),
  prepare: vi.fn<Runtime['prepare']>().mockResolvedValue(prepared),
  status: vi.fn<Runtime['status']>().mockResolvedValue({ ...call, status: 'awaiting-approval' }),
  cancel: vi.fn<Runtime['cancel']>().mockResolvedValue(undefined),
  closeSession: vi.fn<Runtime['closeSession']>(),
  planStatus: vi.fn<Runtime['planStatus']>(),
  prepareTaskRecovery: vi.fn<Runtime['prepareTaskRecovery']>(),
  prepareVisualCorrection: vi.fn<Runtime['prepareVisualCorrection']>().mockResolvedValue({
    protocol: 1,
    status: 'pending',
    expiresAt: 1_900_000_000_000
  }),
  claimPlan: vi.fn<Runtime['claimPlan']>(),
  planProgress: vi.fn<Runtime['planProgress']>(),
  planResult: vi.fn<Runtime['planResult']>(),
  planPixelAudit: vi.fn<Runtime['planPixelAudit']>()
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
// Only the fixture asks the OS for a temporary port. The transport always binds the exact origin.
const reserve = async () => {
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
const fixture = async (requestTimeoutMs?: number) => {
  const reservation = await reserve()
  await reservation.close()
  const runtime = makeRuntime()
  const bridge = await startFigPluginBridgeServer({
    origin: reservation.origin,
    runtime,
    requestTimeoutMs
  })
  bridges.push(bridge)
  return { ...bridge, runtime }
}
type Reply = { status: number; headers: IncomingMessage['headers']; text: string }
const post = (
  origin: string,
  path: string,
  body: unknown,
  headers: Record<string, string | undefined> = credentials,
  method = 'POST'
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const request = httpRequest(
      origin,
      {
        method,
        path,
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
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
    request.setTimeout(4_000, () => request.destroy(new Error('Fixture request timed out')))
    request.end(data)
  })
const openWire = async (origin: string, localAddress?: string) => {
  const socket = createConnection({
    host: '127.0.0.1',
    port: Number(new URL(origin).port),
    localAddress
  })
  sockets.add(socket)
  const chunks: Buffer[] = []
  socket.on('data', (chunk) => chunks.push(chunk))
  // Disconnect tests intentionally cause resets; never leak them as uncaught errors.
  socket.on('error', () => {})
  const done = new Promise<string>((resolve) => {
    socket.once('close', () => {
      sockets.delete(socket)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
  socket.setTimeout(4_000, () => socket.destroy())
  await once(socket, 'connect')
  return { socket, done }
}
const wire = async (origin: string, data: string | Buffer, localAddress?: string) => {
  const connection = await openWire(origin, localAddress)
  connection.socket.write(data)
  return connection.done
}
const packet = (
  origin: string,
  body: string | Buffer = JSON.stringify(call),
  extra: string[] = [],
  path = '/figplugin/v1/status',
  framing = `Content-Length: ${Buffer.byteLength(body)}`
): Buffer =>
  Buffer.concat([
    Buffer.from(
      `POST ${path} HTTP/1.1\r\nHost: ${origin.slice(7)}\r\n` +
        `Authorization: ${credentials.Authorization}\r\n` +
        `X-FigPlugin-Session: ${session.sessionId}\r\nContent-Type: application/json\r\n` +
        [...extra, framing].filter(Boolean).join('\r\n') +
        '\r\n\r\n'
    ),
    Buffer.from(body)
  ])
const expectError = (response: Reply, code: FigPluginBridgeErrorCode, status: number) => {
  expect(response.status).toBe(status)
  expect(JSON.parse(response.text)).toEqual({ code, message: FIGPLUGIN_BRIDGE_ERRORS[code] })
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers.vary).toBe('Origin')
  expect(response.headers['access-control-allow-credentials']).toBeUndefined()
}
const expectWireError = (response: string, code: FigPluginBridgeErrorCode, status: number) => {
  expect(response).toMatch(new RegExp(`^HTTP/1.1 ${status} `))
  expect(response.match(/HTTP\/1\.1/g)).toHaveLength(1)
  expect(JSON.parse(response.split('\r\n\r\n')[1])).toEqual({
    code,
    message: FIGPLUGIN_BRIDGE_ERRORS[code]
  })
}
const expectUnused = (runtime: ReturnType<typeof makeRuntime>) => {
  for (const method of methods) expect(runtime[method]).not.toHaveBeenCalled()
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
  vi.restoreAllMocks()
})

describe('dedicated FigPlugin bridge HTTP contract', () => {
  it('pairs and forwards sequence, status, cancel and close only to the narrow runtime API', async () => {
    const { origin, runtime } = await fixture()
    const paired = await post(origin, '/figplugin/v1/pair', pairBody, {})
    expect(paired.status).toBe(200)
    expect(JSON.parse(paired.text)).toEqual(session)
    expect(runtime.redeem).toHaveBeenCalledWith(pairBody)
    for (const sequence of [1, 2, 1]) {
      const response = await post(origin, '/figplugin/v1/prepare', prepareBody(sequence))
      expect(JSON.parse(response.text)).toEqual(prepared)
      expect(runtime.prepare).toHaveBeenLastCalledWith(
        session.sessionId,
        session.sessionToken,
        prepareBody(sequence)
      )
    }
    expect(runtime.prepare).toHaveBeenCalledTimes(3) // Replay policy belongs to runtime, not HTTP.
    const status = await post(origin, '/figplugin/v1/status', call)
    expect(JSON.parse(status.text)).toEqual({ ...call, status: 'awaiting-approval' })
    expect(runtime.status).toHaveBeenCalledWith(session.sessionId, session.sessionToken, callId)
    const cancelled = await post(origin, '/figplugin/v1/cancel', call)
    expect(cancelled.status).toBe(204)
    expect(cancelled.text).toBe('')
    expect(runtime.cancel).toHaveBeenCalledWith(session.sessionId, session.sessionToken, callId)
    const closed = await post(origin, '/figplugin/v1/close', { protocol: 1, callId })
    expect(closed.status).toBe(204)
    expect(closed.text).toBe('')
    expect(runtime.closeSession).toHaveBeenCalledWith(session.sessionId, session.sessionToken)
    expect(status.headers['access-control-allow-origin']).toBeUndefined()
    expect(status.headers['cache-control']).toBe('no-store')
  })

  it('forwards bounded visual correction preparation through the authenticated route', async () => {
    const { origin, runtime } = await fixture()
    const request = { protocol: 1 as const, sourceExecutionId: '1'.repeat(32) }
    const response = await post(origin, '/figplugin/v1/plan/correction/prepare', request)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toEqual({
      protocol: 1,
      status: 'pending',
      expiresAt: 1_900_000_000_000
    })
    expect(runtime.prepareVisualCorrection).toHaveBeenCalledExactlyOnceWith(
      session.sessionId,
      session.sessionToken,
      request
    )
  })

  it('binds IPv4 only, applies hard connection/header time limits, and clamps timeout overrides', async () => {
    const emitted = vi.spyOn(Server.prototype, 'emit')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const { origin } = await fixture(120_000)
    await post(origin, '/figplugin/v1/status', call)
    const index = emitted.mock.calls.findIndex(([name]) => String(name) === 'request')
    const server = emitted.mock.contexts[index] as Server
    expect(server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' })
    expect(server.maxConnections).toBe(32)
    // Node's maxHeadersCount silently truncates raw headers; the bridge enforces its own
    // rejection bound in headersOf() instead.
    expect(server.maxHeadersCount).toBe(0)
    expect(server.requestTimeout).toBe(15_000)
    expect(server.headersTimeout).toBe(5_000)
    const expiry = timers.mock.calls.find(([callback]) => callback.name === 'expire')
    expect(expiry?.[1]).toBeGreaterThan(14_000)
    expect(expiry?.[1]).toBeLessThanOrEqual(15_000)
  })

  it.each([
    'http://127.0.0.1:0',
    'http://127.0.0.1:1023',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:041234',
    'http://localhost:41234',
    'http://0.0.0.0:41234',
    'http://[::1]:41234',
    'http://127.0.0.1:41234/',
    'http://127.0.0.1:41234?token=PRIVATE',
    'http://PRIVATE@127.0.0.1:41234'
  ])('rejects a noncanonical origin without listening: %s', async (origin) => {
    const runtime = makeRuntime()
    await expect(startFigPluginBridgeServer({ origin, runtime })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: FIGPLUGIN_BRIDGE_ERRORS.INVALID_REQUEST
    })
    expectUnused(runtime)
  })

  it('rejects EADDRINUSE without probing or falling back', async () => {
    const occupied = await reserve()
    try {
      await expect(
        startFigPluginBridgeServer({ origin: occupied.origin, runtime: makeRuntime() })
      ).rejects.toMatchObject({ code: 'EADDRINUSE', message: 'The plugin bridge could not start.' })
    } finally {
      await occupied.close()
    }
    const bridge = await startFigPluginBridgeServer({
      origin: occupied.origin,
      runtime: makeRuntime()
    })
    bridges.push(bridge)
    expect(bridge.origin).toBe(occupied.origin)
  })

  it.each([
    ['GET', '/figplugin/v1/status'],
    ['PUT', '/figplugin/v1/prepare'],
    ['POST', '/figplugin/v1/status?token=PRIVATE'],
    ['POST', '/figplugin/v1/status?'],
    ['POST', '/figplugin/v1/status/'],
    ['POST', '/figplugin/v1/status/extra'],
    ['POST', '/figplugin/v1/status/extra'],
    ['POST', '/figplugin%2fv1/status'],
    ['POST', '/figplugin/v1/%73tatus'],
    ['POST', '/figplugin/v1/../v1/status'],
    ['POST', '/figplugin/v1/status#PRIVATE'],
    ['POST', 'http://127.0.0.1:41234/figplugin/v1/status'],
    ['POST', 'http://[MALFORMED/PRIVATE'],
    ['POST', '/figplugin/v1/approve'],
    ['POST', '/figplugin/v1/executePlan'],
    ['POST', '/figplugin/v1/plan/prepare'],
    ['POST', '/figplugin/v1/plan/execute'],
    ['POST', '/figplugin/v1/plan/cancel'],
    ['POST', '/figplugin/v1/list'],
    ['POST', '/v1/chat/completions'],
    ['OPTIONS', '*']
  ])('rejects non-allowlisted method/target %s %s', async (method, path) => {
    const { origin, runtime } = await fixture()
    expectError(await post(origin, path, call, credentials, method), 'INVALID_REQUEST', 400)
    expectUnused(runtime)
  })

  it('rejects CONNECT, upgrade and Expect without automatic protocol responses', async () => {
    const { origin, runtime } = await fixture()
    for (const request of [
      `CONNECT ${origin.slice(7)} HTTP/1.1\r\nHost: ${origin.slice(7)}\r\n\r\n`,
      packet(origin, JSON.stringify(call), ['Connection: Upgrade', 'Upgrade: websocket']),
      packet(origin, JSON.stringify(call), ['Expect: 100-continue']),
      packet(origin, JSON.stringify(call), ['Expect: PRIVATE'])
    ]) {
      expectWireError(await wire(origin, request), 'INVALID_REQUEST', 400)
    }
    expectUnused(runtime)
  })
})

describe('opaque origin, raw Host, and credential envelopes', () => {
  it('allows unauthenticated minimal preflight and uses wildcard only for exact null origin', async () => {
    const { origin, runtime } = await fixture()
    const response = await wire(
      origin,
      `OPTIONS /figplugin/v1/prepare HTTP/1.1\r\nHost: ${origin.slice(7)}\r\n` +
        'Origin: null\r\nAccess-Control-Request-Method: POST\r\n' +
        'Access-Control-Request-Headers: Content-Type, Authorization, X-FigPlugin-Session\r\n\r\n'
    )
    expect(response).toMatch(/^HTTP\/1.1 204 /)
    expect(response).toContain('Access-Control-Allow-Origin: *\r\n')
    expect(response).toContain('Access-Control-Allow-Methods: POST\r\n')
    expect(response).toContain(
      'Access-Control-Allow-Headers: content-type, authorization, x-figplugin-session\r\n'
    )
    expect(response.toLowerCase()).not.toContain('allow-credentials')
    expectUnused(runtime)
    const status = await post(origin, '/figplugin/v1/status', call, {
      ...credentials,
      Origin: 'null'
    })
    expect(status.status).toBe(200)
    expect(status.headers['access-control-allow-origin']).toBe('*')
    expect(status.headers['access-control-allow-credentials']).toBeUndefined()
    const unauthorized = await post(origin, '/figplugin/v1/status', call, { Origin: 'null' })
    expectError(unauthorized, 'UNAUTHORIZED', 401)
    expect(unauthorized.headers['access-control-allow-origin']).toBe('*')
    const native = await wire(
      origin,
      `OPTIONS /figplugin/v1/pair HTTP/1.1\r\nHost: ${origin.slice(7)}\r\n\r\n`
    )
    expect(native).toMatch(/^HTTP\/1.1 204 /)
    expect(native).not.toContain('Access-Control-Allow-Origin')
  })

  it.each(['https://www.figma.com', 'https://alien.invalid', 'NULL', '', 'null, null'])(
    'rejects origin %s before runtime work',
    async (Origin) => {
      const { origin, runtime } = await fixture()
      const response = await post(origin, '/figplugin/v1/status', call, { ...credentials, Origin })
      expectError(response, 'DENIED', 403)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
      expectUnused(runtime)
    }
  )

  it.each([
    ['Access-Control-Request-Method: GET'],
    ['Access-Control-Request-Headers: authorization, cookie'],
    ['Access-Control-Request-Headers: x-provider-key'],
    ['Origin: null', 'Origin: null']
  ])('rejects excess preflight authority %j', async (...extra) => {
    const { origin, runtime } = await fixture()
    const response = await wire(
      origin,
      `OPTIONS /figplugin/v1/status HTTP/1.1\r\nHost: ${origin.slice(7)}\r\n` +
        extra.join('\r\n') +
        '\r\n\r\n'
    )
    expectWireError(response, 'INVALID_REQUEST', 400)
    expectUnused(runtime)
  })

  it.each(['localhost:41234', 'foreign.invalid', '127.0.0.1', '127.0.0.1:1'])(
    'rejects foreign Host %s even with trusted-looking forwarding headers',
    async (Host) => {
      const { origin, runtime } = await fixture()
      expectError(
        await post(origin, '/figplugin/v1/status', call, {
          ...credentials,
          Host,
          'X-Forwarded-Host': origin.slice(7),
          'X-Forwarded-For': '127.0.0.1',
          Forwarded: `for=127.0.0.1;host=${origin.slice(7)}`
        }),
        'INVALID_REQUEST',
        400
      )
      expectUnused(runtime)
    }
  )

  it('does not trust forwarded peer identity and rejects missing/duplicate raw Host', async () => {
    const { origin, runtime } = await fixture()
    expectWireError(
      await wire(
        origin,
        packet(origin, JSON.stringify(call), ['X-Forwarded-For: 127.0.0.1']),
        '127.0.0.2'
      ),
      'INVALID_REQUEST',
      400
    )
    for (const line of [`Host: ${origin.slice(7)}`, 'hOsT: foreign.invalid']) {
      expectWireError(
        await wire(origin, packet(origin, JSON.stringify(call), [line])),
        'INVALID_REQUEST',
        400
      )
    }
    expectWireError(
      await wire(origin, 'POST /figplugin/v1/pair HTTP/1.1\r\nContent-Length: 0\r\n\r\n'),
      'INVALID_REQUEST',
      400
    )
    expectUnused(runtime)
  })

  it.each([
    {},
    { Authorization: credentials.Authorization },
    { 'X-FigPlugin-Session': session.sessionId },
    { ...credentials, Authorization: `bearer ${session.sessionToken}` },
    { ...credentials, Authorization: `Bearer  ${session.sessionToken}` },
    { ...credentials, Authorization: `Basic ${session.sessionToken}` },
    { ...credentials, Authorization: `Bearer ${'B'.repeat(64)}` },
    { ...credentials, Authorization: `Bearer ${'b'.repeat(63)}` },
    { ...credentials, 'X-FigPlugin-Session': 'A'.repeat(32) },
    { ...credentials, 'X-FigPlugin-Session': 'a'.repeat(33) }
  ])('requires canonical bearer AND session headers: %j', async (headers) => {
    const { origin, runtime } = await fixture()
    for (const route of ['prepare', 'status', 'cancel', 'close']) {
      expectError(await post(origin, `/figplugin/v1/${route}`, call, headers), 'UNAUTHORIZED', 401)
    }
    expectUnused(runtime)
  })

  it('rejects duplicate credential headers and forbids either credential on pairing', async () => {
    const { origin, runtime } = await fixture()
    for (const header of [
      `authorization: ${credentials.Authorization}`,
      `x-figplugin-session: ${session.sessionId}`
    ]) {
      expectWireError(
        await wire(origin, packet(origin, JSON.stringify(call), [header])),
        'INVALID_REQUEST',
        400
      )
    }
    for (const headers of [
      { Authorization: credentials.Authorization },
      { 'X-FigPlugin-Session': session.sessionId },
      credentials
    ]) {
      expectError(await post(origin, '/figplugin/v1/pair', pairBody, headers), 'UNAUTHORIZED', 401)
    }
    expectUnused(runtime)
    const response = await post(origin, '/figplugin/v1/pair', pairBody, {
      'X-Unrelated': 'ignored'
    })
    expect(response.status).toBe(200)
  })
})

describe('bounded JSON transport and fixed errors', () => {
  it.each([
    { 'Content-Type': 'text/plain' },
    { 'Content-Type': 'application/json; charset=utf-8' },
    { 'Content-Type': 'application/json, application/json' },
    { 'Content-Encoding': 'gzip' },
    { 'Content-Encoding': 'identity' },
    { Cookie: 'session=PRIVATE' }
  ])('rejects alternate envelopes %j', async (headers) => {
    const { origin, runtime } = await fixture()
    expectError(
      await post(origin, '/figplugin/v1/status', call, { ...credentials, ...headers }),
      'INVALID_REQUEST',
      400
    )
    expectUnused(runtime)
  })

  it.each([
    ['pair', { ...pairBody, providerKey: 'PRIVATE' }],
    ['pair', { ...pairBody, pairingSecret: Buffer.from('PRIVATE').toString('base64') }],
    ['pair', { ...pairBody, pairingSecret: 'f'.repeat(63) }],
    ['prepare', { ...prepareBody(), context: { ...prepareBody().context, base64: 'PRIVATE' } }],
    ['prepare', { ...prepareBody(), headers: { Authorization: 'PRIVATE' } }],
    ['prepare', { ...prepareBody(), sequence: 0 }],
    ['prepare', { ...prepareBody(), prompt: 'a'.repeat(16_385) }],
    ['status', { ...call, sessionToken: 'PRIVATE' }],
    ['cancel', { ...call, callId: 'x' }],
    ['close', { protocol: 1, unknown: 'PRIVATE' }],
    ['status', null],
    ['status', []],
    ['status', 'PRIVATE']
  ])('schema validates %s before calling runtime', async (route, body) => {
    const { origin, runtime } = await fixture()
    expectError(
      await post(origin, `/figplugin/v1/${route}`, body, route === 'pair' ? {} : credentials),
      'INVALID_REQUEST',
      400
    )
    expectUnused(runtime)
  })

  it('prechecks declared byte lengths, including pair-specific limit, without reading the body', async () => {
    const { origin, runtime } = await fixture()
    expectWireError(
      await wire(origin, packet(origin, '', [], '/figplugin/v1/status', 'Content-Length: 65537')),
      'INVALID_REQUEST',
      400
    )
    expectWireError(
      await wire(
        origin,
        `POST /figplugin/v1/pair HTTP/1.1\r\nHost: ${origin.slice(7)}\r\n` +
          'Content-Type: application/json\r\nContent-Length: 16385\r\n\r\n'
      ),
      'INVALID_REQUEST',
      400
    )
    expectUnused(runtime)
  })

  it('allows valid chunking and split UTF-8, but caps streamed bytes', async () => {
    const { origin, runtime } = await fixture()
    const body = Buffer.from(JSON.stringify(prepareBody()))
    const split = body.indexOf(Buffer.from('界')) + 1
    const chunks = [body.subarray(0, split), body.subarray(split)]
    const chunked = Buffer.concat([
      ...chunks.flatMap((chunk) => [
        Buffer.from(`${chunk.length.toString(16)}\r\n`),
        chunk,
        Buffer.from('\r\n')
      ]),
      Buffer.from('0\r\n\r\n')
    ])
    const response = await wire(
      origin,
      packet(origin, chunked, [], '/figplugin/v1/prepare', 'Transfer-Encoding: chunked')
    )
    expect(response).toMatch(/^HTTP\/1.1 200 /)
    expect(runtime.prepare).toHaveBeenCalledWith(
      session.sessionId,
      session.sessionToken,
      prepareBody()
    )
    const oversized = '10001\r\n' + ' '.repeat(65_537) + '\r\n0\r\n\r\n'
    expectWireError(
      await wire(
        origin,
        packet(origin, oversized, [], '/figplugin/v1/status', 'Transfer-Encoding: chunked')
      ),
      'INVALID_REQUEST',
      400
    )
    expect(runtime.status).not.toHaveBeenCalled()
    expectWireError(
      await wire(
        origin,
        `POST /figplugin/v1/pair HTTP/1.1\r\nHost: ${origin.slice(7)}\r\n` +
          'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n' +
          '4001\r\n' +
          ' '.repeat(16_385) +
          '\r\n0\r\n\r\n'
      ),
      'INVALID_REQUEST',
      400
    )
    expect(runtime.redeem).not.toHaveBeenCalled()
  })

  it.each([
    Buffer.from('{PRIVATE'),
    Buffer.from(''),
    Buffer.concat([Buffer.from('{"PRIVATE":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
    Buffer.concat([Buffer.from(JSON.stringify(call)), Buffer.from([0xe2])]),
    Buffer.from('\ufeff' + JSON.stringify(call))
  ])('rejects corrupt JSON/fatal UTF-8 without echoing input', async (body) => {
    const { origin, runtime } = await fixture()
    const response = await wire(origin, packet(origin, body))
    expectWireError(response, 'INVALID_REQUEST', 400)
    expect(response).not.toContain('PRIVATE')
    expectUnused(runtime)
  })

  it.each([
    ['Content-Length: -1', ''],
    ['Content-Length: 1\r\nContent-Length: 1', 'x'],
    ['Transfer-Encoding: gzip, chunked', '0\r\n\r\n'],
    ['Transfer-Encoding: gzip', 'FIXTURE'],
    ['Content-Length: 4\r\nTransfer-Encoding: chunked', '0\r\n\r\n'],
    ['Transfer-Encoding: chunked', 'INVALID\r\nFIXTURE\r\n0\r\n\r\n'],
    ['Transfer-Encoding: chunked', '2\r\n{}\r\n0\r\nAuthorization: FIXTURE\r\n\r\n']
  ])('rejects malformed framing or trailers %s', async (framing, body) => {
    const { origin, runtime } = await fixture()
    expectWireError(
      await wire(origin, packet(origin, body, [], '/figplugin/v1/status', framing)),
      'INVALID_REQUEST',
      400
    )
    expectUnused(runtime)
  })

  it('rejects more than 32 headers and parser overflows without logging raw data', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { origin, runtime } = await fixture()
    for (const extra of [
      Array.from({ length: 28 }, (_, index) => `X-${index}: FIXTURE`),
      ['X-Overflow: ' + 'FIXTURE'.repeat(3_000)],
      ['X-Invalid: FIXTURE\u0001'],
      ['Content-Type: application/json']
    ]) {
      const response = await wire(origin, packet(origin, JSON.stringify(call), extra))
      expectWireError(response, 'INVALID_REQUEST', 400)
      expect(response).not.toContain('FIXTURE')
    }
    expectUnused(runtime)
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID_REQUEST', 400],
    ['UNAUTHORIZED', 401],
    ['EXPIRED', 410],
    ['BUSY', 429],
    ['CONFIGURATION_CHANGED', 409],
    ['DENIED', 403],
    ['CANCELLED', 409],
    ['TIMEOUT', 504],
    ['UPSTREAM_FAILED', 502]
  ] as const)('maps runtime %s to fixed HTTP %i', async (code, status) => {
    const { origin, runtime } = await fixture()
    const error = new FigPluginBridgeError(code)
    error.message = 'PRIVATE provider failure'
    runtime.status.mockRejectedValue(error)
    expectError(await post(origin, '/figplugin/v1/status', call), code, status)
  })

  it('sanitizes unknown runtime exceptions and validates every JSON response before sending', async () => {
    const { origin, runtime } = await fixture()
    runtime.status.mockRejectedValueOnce(new Error('PRIVATE provider stack'))
    expectError(await post(origin, '/figplugin/v1/status', call), 'UPSTREAM_FAILED', 502)
    runtime.redeem.mockResolvedValueOnce({
      ...session,
      providerKey: 'PRIVATE'
    } as FigPluginPairResponse)
    expectError(await post(origin, '/figplugin/v1/pair', pairBody, {}), 'UPSTREAM_FAILED', 502)
    runtime.prepare.mockResolvedValueOnce({ ...prepared, status: 'running' } as never)
    expectError(await post(origin, '/figplugin/v1/prepare', prepareBody()), 'UPSTREAM_FAILED', 502)
    runtime.status.mockResolvedValueOnce({
      ...call,
      status: 'completed',
      content: 'x'.repeat(32_769)
    })
    expectError(await post(origin, '/figplugin/v1/status', call), 'UPSTREAM_FAILED', 502)
    // Valid shared content can exceed the transport's JSON byte cap after escaping.
    runtime.status.mockResolvedValueOnce({
      ...call,
      status: 'completed',
      content: '\u0000'.repeat(32_768)
    })
    expectError(await post(origin, '/figplugin/v1/status', call), 'UPSTREAM_FAILED', 502)
    runtime.status.mockResolvedValueOnce({
      ...call,
      status: 'completed',
      content: 'ok',
      reportedTotalTokens: 2
    })
    const response = await post(origin, '/figplugin/v1/status', call)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toEqual({
      ...call,
      status: 'completed',
      content: 'ok',
      reportedTotalTokens: 2
    })
  })
})

describe('deadlines, bounded activity, and transport disposal', () => {
  it('times out partial bodies, removes read listeners, and never starts late work', async () => {
    const emitted = vi.spyOn(Server.prototype, 'emit')
    const { origin, runtime } = await fixture(50)
    const connection = await openWire(origin)
    connection.socket.write(packet(origin, '{', [], '/figplugin/v1/status', 'Content-Length: 100'))
    const started = Date.now()
    expectWireError(await connection.done, 'TIMEOUT', 504)
    expect(Date.now() - started).toBeLessThan(1_000)
    connection.socket.write(JSON.stringify(call))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expectUnused(runtime)
    const request = emitted.mock.calls.find(
      ([name]) => String(name) === 'request'
    )![1] as IncomingMessage
    for (const event of ['data', 'end', 'aborted', 'error']) {
      expect(
        request
          .listeners(event)
          .filter((listener) => ['onData', 'onEnd', 'disconnect'].includes(listener.name))
      ).toEqual([])
    }
  })

  it.each(['pair', 'prepare', 'status', 'cancel', 'close'] as const)(
    'bounds %s runtime awaits even when nested work ignores the HTTP deadline',
    async (route) => {
      const { origin, runtime, close } = await fixture(40)
      const nested = deferred<never>()
      const entered = deferred<void>()
      const method = (
        {
          pair: 'redeem',
          prepare: 'prepare',
          status: 'status',
          cancel: 'cancel',
          close: 'closeSession'
        } as const
      )[route]
      runtime[method].mockImplementation((async () => {
        entered.resolve()
        return await nested.promise
      }) as never)
      const pending = post(
        origin,
        `/figplugin/v1/${route}`,
        route === 'pair'
          ? pairBody
          : route === 'prepare'
            ? prepareBody()
            : route === 'close'
              ? { protocol: 1 }
              : call,
        route === 'pair' ? {} : credentials
      )
      await entered.promise
      const started = Date.now()
      expectError(await pending, 'TIMEOUT', 504)
      expect(Date.now() - started).toBeLessThan(1_000)
      await close()
      nested.reject(new Error('PRIVATE late failure'))
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  )

  it('uses one deadline for reading plus runtime, and cleans abort listeners', async () => {
    const signals = vi.spyOn(AbortSignal.prototype, 'addEventListener')
    const { origin, runtime } = await fixture(150)
    const nested = deferred<never>()
    runtime.status.mockReturnValueOnce(nested.promise)
    const connection = await openWire(origin)
    const body = JSON.stringify(call)
    const started = Date.now()
    connection.socket.write(
      packet(origin, '', [], '/figplugin/v1/status', `Content-Length: ${body.length}`)
    )
    await new Promise((resolve) => setTimeout(resolve, 90))
    connection.socket.write(body)
    expectWireError(await connection.done, 'TIMEOUT', 504)
    expect(runtime.status).toHaveBeenCalledTimes(1)
    expect(Date.now() - started).toBeLessThan(240)
    for (const signal of new Set(signals.mock.contexts)) {
      expect(getEventListeners(signal as AbortSignal, 'abort')).toHaveLength(0)
    }
    nested.resolve(undefined as never)
  })

  it('caps 16 active requests including readers, frees disconnected slots, and closes ignored work', async () => {
    const { origin, runtime, close } = await fixture(3_000)
    const never = deferred<never>()
    const entered = deferred<void>()
    runtime.status.mockImplementation(async () => {
      if (runtime.status.mock.calls.length === 15) entered.resolve()
      return await never.promise
    })
    const pending = Array.from({ length: 15 }, () =>
      post(origin, '/figplugin/v1/status', call).catch(() => undefined)
    )
    await entered.promise
    const reader = await openWire(origin)
    reader.socket.write(packet(origin, '{', [], '/figplugin/v1/status', 'Content-Length: 100'))
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expectError(await post(origin, '/figplugin/v1/status', call), 'BUSY', 429)
    expect(runtime.status).toHaveBeenCalledTimes(15)
    reader.socket.destroy()
    await reader.done
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    runtime.cancel.mockResolvedValue(undefined)
    expect((await post(origin, '/figplugin/v1/cancel', call)).status).toBe(204)
    const started = Date.now()
    const firstClose = close()
    expect(close()).toBe(firstClose)
    await firstClose
    expect(Date.now() - started).toBeLessThan(1_000)
    await Promise.all(pending)
    never.reject(new Error('PRIVATE late provider error'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(post(origin, '/figplugin/v1/status', call)).rejects.toBeDefined()
    expect(runtime.closeSession).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'timeout'] as const)(
    'retains all 16 dispatch slots after %s until underlying work settles',
    async (ending) => {
      const { origin, runtime, close } = await fixture(ending === 'timeout' ? 250 : 3_000)
      const gates = Array.from({ length: 17 }, () => deferred<typeof prepared>())
      const entered = deferred<void>()
      const reentered = deferred<void>()
      let pending = 0
      let peak = 0
      runtime.prepare.mockImplementation(() => {
        const count = runtime.prepare.mock.calls.length
        pending += 1
        peak = Math.max(peak, pending)
        if (count === 16) entered.resolve()
        if (count === 17) reentered.resolve()
        return gates[count - 1].promise.finally(() => {
          pending -= 1
        })
      })
      const connections = await Promise.all(Array.from({ length: 16 }, () => openWire(origin)))
      for (const connection of connections) {
        connection.socket.write(
          packet(origin, JSON.stringify(prepareBody()), [], '/figplugin/v1/prepare')
        )
      }
      await entered.promise
      if (ending === 'disconnect') {
        for (const connection of connections) connection.socket.destroy()
      }
      for (const response of await Promise.all(connections.map((connection) => connection.done))) {
        if (ending === 'timeout') expectWireError(response, 'TIMEOUT', 504)
        else expect(response).toBe('')
      }
      expect(pending).toBe(16)
      // No payload bytes are sent: BUSY must precede reading as well as dispatch.
      expectWireError(
        await wire(origin, packet(origin, '', [], '/figplugin/v1/prepare', 'Content-Length: 100')),
        'BUSY',
        429
      )
      expectError(await post(origin, '/figplugin/v1/status', call), 'BUSY', 429)
      expect(runtime.prepare.mock.calls.length).toBe(16)
      expect(runtime.status.mock.calls.length).toBe(0)
      if (ending === 'timeout') gates[0].reject(new Error('PRIVATE late failure'))
      else gates[0].resolve(prepared)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(pending).toBe(15)
      const replacement = await openWire(origin)
      replacement.socket.write(
        packet(origin, JSON.stringify(prepareBody()), [], '/figplugin/v1/prepare')
      )
      await reentered.promise
      expect(pending).toBe(16)
      expect(peak).toBe(16)
      const started = Date.now()
      await close()
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(await replacement.done).toBe('')
      expect(pending).toBe(16)
      const end = vi.spyOn(ServerResponse.prototype, 'end')
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      for (const [index, gate] of gates.slice(1).entries()) {
        if (index % 2) gate.reject(new Error('PRIVATE late failure'))
        else gate.resolve(prepared)
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(pending).toBe(0)
      expect(runtime.prepare.mock.calls.length).toBe(17)
      expect(end.mock.calls.length).toBe(0)
      expect(log.mock.calls.length + warn.mock.calls.length + error.mock.calls.length).toBe(0)
    }
  )

  it('rechecks dispatch capacity when already-admitted body readers finish', async () => {
    const { origin, runtime, close } = await fixture(3_000)
    const gate = deferred<typeof prepared>()
    const entered = deferred<void>()
    runtime.prepare.mockImplementation(() => {
      if (runtime.prepare.mock.calls.length === 15) entered.resolve()
      return gate.promise
    })
    const connections = await Promise.all(Array.from({ length: 15 }, () => openWire(origin)))
    const body = JSON.stringify(prepareBody())
    for (const connection of connections) {
      connection.socket.write(packet(origin, body, [], '/figplugin/v1/prepare'))
    }
    await entered.promise
    for (const connection of connections) connection.socket.destroy()
    await Promise.all(connections.map((connection) => connection.done))
    // Confirm both readers entered readJson before completing either body.
    const original = Server.prototype.emit
    const emitted = vi.spyOn(Server.prototype, 'emit')
    const readers = await Promise.all([openWire(origin), openWire(origin)])
    const reading = deferred<void>()
    emitted.mockImplementation(function (this: Server, ...args) {
      const result = original.apply(this, args)
      if (
        String(args[0]) === 'request' &&
        emitted.mock.calls.filter(([name]) => String(name) === 'request').length === 2
      ) {
        reading.resolve()
      }
      return result
    })
    for (const reader of readers) {
      reader.socket.write(
        packet(
          origin,
          '',
          [],
          '/figplugin/v1/prepare',
          `Content-Length: ${Buffer.byteLength(body)}`
        )
      )
    }
    await reading.promise
    for (const reader of readers) reader.socket.write(body)
    const rejected = await Promise.race(readers.map((reader) => reader.done))
    expectWireError(rejected, 'BUSY', 429)
    expect(runtime.prepare.mock.calls.length).toBe(16)
    await close()
    await Promise.all(readers.map((reader) => reader.done))
    gate.resolve(prepared)
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('times out incomplete headers and idle connections without runtime work', async () => {
    const { origin, runtime } = await fixture(40)
    for (const prefix of ['', 'POST /figplugin/v1/status HTTP/1.1\r\nHost: ']) {
      const connection = await openWire(origin)
      connection.socket.write(prefix)
      const started = Date.now()
      expect(await connection.done).toBe('')
      expect(Date.now() - started).toBeLessThan(1_000)
    }
    expectUnused(runtime)
  })

  it('close destroys readers and idle sockets and prevents pipelined runtime work', async () => {
    const { origin, runtime, close } = await fixture()
    await wire(origin, Buffer.concat([packet(origin), packet(origin)]))
    expectUnused(runtime)
    const idle = await openWire(origin)
    const reader = await openWire(origin)
    reader.socket.write(packet(origin, '{', [], '/figplugin/v1/status', 'Content-Length: 100'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const started = Date.now()
    await close()
    await Promise.all([idle.done, reader.done])
    expect(Date.now() - started).toBeLessThan(1_000)
    expectUnused(runtime)
  })

  it('never delivers a late pairing secret after timeout or invokes any approval API', async () => {
    const { origin, runtime, close } = await fixture(30)
    const gate = deferred<FigPluginPairResponse>()
    runtime.redeem.mockReturnValueOnce(gate.promise)
    const response = await post(origin, '/figplugin/v1/pair', pairBody, {})
    expectError(response, 'TIMEOUT', 504)
    gate.resolve(session)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(response.text).not.toContain(session.sessionToken)
    expect(runtime.prepare).not.toHaveBeenCalled()
    expect(runtime.closeSession).not.toHaveBeenCalled()
    await close()
  })
})

describe('anonymous bounded bridge connectivity probe', () => {
  it('echoes only a challenge without pairing, model calls or host operations', async () => {
    const f = await fixture()
    const nonce = '7'.repeat(32)
    const reply = await post(f.origin, '/figplugin/v1/probe', { protocol: 1, nonce }, {})
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.text)).toEqual({ protocol: 1, kind: 'figplugin-bridge-probe', nonce })
    expect(reply.headers['cache-control']).toBe('no-store')
    for (const method of Object.values(f.runtime)) expect(method).not.toHaveBeenCalled()
  })

  it('refuses credentials, extra input, oversized input and foreign browser origins', async () => {
    const f = await fixture()
    const body = { protocol: 1, nonce: '7'.repeat(32) }
    expect((await post(f.origin, '/figplugin/v1/probe', body)).status).toBe(401)
    expect(
      (await post(f.origin, '/figplugin/v1/probe', { ...body, prompt: 'PRIVATE' }, {})).status
    ).toBe(400)
    expect(
      (await post(f.origin, '/figplugin/v1/probe', { ...body, nonce: 'x'.repeat(300) }, {})).status
    ).toBe(400)
    expect(
      (await post(f.origin, '/figplugin/v1/probe', body, { Origin: 'https://untrusted.example' }))
        .status
    ).toBe(403)
    expect((await post(f.origin, '/figplugin/v1/probe?alias=1', body, {})).status).toBe(400)
    expect(
      (await post(f.origin, '/figplugin/v1/probe', body, { Cookie: 'session=PRIVATE' })).status
    ).toBe(400)
    for (const method of Object.values(f.runtime)) expect(method).not.toHaveBeenCalled()
  })
})
