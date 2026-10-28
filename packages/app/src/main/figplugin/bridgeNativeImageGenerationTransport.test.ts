import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  figPluginPairResponseSchema,
  type FigPluginBridgeErrorCode,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import { FIGPLUGIN_ASSET_LIST_PATH, figPluginAssetListSchema } from '@shared/figplugin/hostAssets'
import type { FigPluginImageGenerationState } from '@shared/figplugin/imageGeneration'
import {
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_PREPARE_PATH as PREPARE,
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_STATUS_PATH as STATUS,
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_CANCEL_PATH as CANCEL,
  figPluginImageGenerationProposalPrepareResponseSchema,
  figPluginImageGenerationProposalStatusSchema,
  type FigPluginImageGenerationProposalPrepareResponse
} from '@shared/figplugin/nativeImageGeneration'
import {
  figPluginBridgeChildHttpRoute,
  startFigPluginBridgeChildHttpServer
} from './bridgeChildHttp'
import {
  createFigPluginBridgeChildRpcClient,
  createFigPluginBridgeChildRpcEndpoint,
  createFigPluginBridgeChildRuntimeHandler,
  type FigPluginBridgeChildRpcPort
} from './bridgeChildRpc'
import {
  FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES,
  FIGPLUGIN_BRIDGE_CHILD_RPC_METHODS,
  encodeFigPluginBridgeChildRpcRequest
} from './bridgeChildWire'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { startFigPluginBridgeServer } from './bridgeServer'

type Transport = 'development-http' | 'child-http-messagechannel-rpc'
type Host = FigPluginRuntimeBinding['host']
type HttpResult = { status: number; text: string; headers: IncomingHttpHeaders }
type Frame = { side: 'main' | 'child'; data: string }
const cleanups: Array<() => void | Promise<void>> = []
const within = async <T>(work: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Native proposal fixture timeout: ${label}`)),
          4500
        )
        timer.unref()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await within(Promise.resolve().then(cleanup), 'cleanup')
  vi.restoreAllMocks()
})
const reserveOrigin = async () => {
  const holder = createServer()
  try {
    holder.listen({ host: '127.0.0.1', port: 0 })
    await within(once(holder, 'listening'), 'loopback reservation')
    const address = holder.address()
    if (!address || typeof address === 'string') throw new Error('Invalid fixture address')
    return `http://127.0.0.1:${address.port}`
  } finally {
    if (holder.listening)
      await new Promise<void>((resolve, reject) =>
        holder.close((error) => (error ? reject(error) : resolve()))
      )
  }
}
const http = (
  origin: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  options: { method?: string; raw?: string | Buffer; chunked?: boolean } = {}
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const data = options.raw ?? (body === undefined ? '' : JSON.stringify(body))
    let settled = false
    const finish = (error?: Error, result?: HttpResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) reject(error)
      else resolve(result!)
    }
    const outgoing = httpRequest(
      origin,
      {
        path,
        method: options.method ?? 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          ...(options.chunked
            ? { 'Transfer-Encoding': 'chunked' }
            : { 'Content-Length': Buffer.byteLength(data) }),
          ...headers
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 128 * 1024) {
            outgoing.destroy(new Error('Response exceeded the cap'))
            return
          }
          chunks.push(chunk)
        })
        response.on('error', (error) => finish(error))
        response.on('end', () =>
          finish(undefined, {
            status: response.statusCode!,
            text: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers
          })
        )
      }
    )
    const deadline = setTimeout(() => outgoing.destroy(new Error('HTTP fixture timeout')), 4000)
    deadline.unref()
    outgoing.on('error', (error) => finish(error))
    outgoing.end(data)
  })
const auth = (peer: FigPluginPairResponse) => ({
  Authorization: `Bearer ${peer.sessionToken}`,
  'X-FigPlugin-Session': peer.sessionId
})
// The listener may reset an oversized sender after its complete refusal is flushed.
// Keep the raw response for these framing tests instead of treating reset as success.
const rawHttp = async (
  origin: string,
  path: string,
  peer: FigPluginPairResponse,
  raw: string | Buffer,
  chunked = false,
  declaredLength?: number
): Promise<HttpResult> => {
  const body = Buffer.from(raw)
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(origin).port) })
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  socket.on('error', () => {})
  const done = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  socket.setTimeout(4000, () => socket.destroy())
  try {
    await once(socket, 'connect')
    socket.write(
      Buffer.concat([
        Buffer.from(
          `POST ${path} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n` +
            `Authorization: Bearer ${peer.sessionToken}\r\nX-FigPlugin-Session: ${peer.sessionId}\r\n` +
            'Content-Type: application/json\r\n' +
            (chunked
              ? 'Transfer-Encoding: chunked'
              : `Content-Length: ${declaredLength ?? body.length}`) +
            '\r\n\r\n'
        ),
        ...(chunked
          ? [Buffer.from(body.length.toString(16) + '\r\n'), body, Buffer.from('\r\n0\r\n\r\n')]
          : [body])
      ])
    )
    await within(done, 'raw HTTP response')
    const response = Buffer.concat(chunks).toString('utf8')
    expect(Buffer.byteLength(response)).toBeLessThan(128 * 1024)
    const separator = response.indexOf('\r\n\r\n')
    expect(separator).toBeGreaterThan(0)
    const lines = response.slice(0, separator).split('\r\n')
    const match = /^HTTP\/1\.1 (\d{3}) /.exec(lines.shift()!)
    expect(match).not.toBeNull()
    const headers = Object.fromEntries(
      lines.map((line) => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]
      })
    )
    const text = response.slice(separator + 4)
    expect(Buffer.byteLength(text)).toBe(Number(headers['content-length']))
    return { status: Number(match![1]), text, headers }
  } finally {
    socket.destroy()
  }
}
const recordingPort = (
  port: MessagePort,
  side: Frame['side'],
  frames: Frame[]
): FigPluginBridgeChildRpcPort => ({
  postMessage: (data) => {
    frames.push({ side, data })
    port.postMessage(data)
  },
  on: (event, listener) => port.on(event, listener),
  off: (event, listener) => port.off(event, listener)
})
const errorResponse = (reply: HttpResult, status: number, code: FigPluginBridgeErrorCode) => {
  expect(reply.status).toBe(status)
  expect(JSON.parse(reply.text)).toEqual({ code, message: FIGPLUGIN_BRIDGE_ERRORS[code] })
  expect(reply.headers['cache-control']).toBe('no-store')
  expect(reply.text).not.toMatch(/PRIVATE|sessionToken|apiKey|localMediaUrl|bytesBase64/)
}
const request = (sequence = 1) => ({
  protocol: 1,
  requestId: sequence.toString(16).padStart(32, '0'),
  sequence,
  prompt: 'PRIVATE-SYNTHETIC-PROMPT: a green square'
})
const key = (receipt: FigPluginImageGenerationProposalPrepareResponse) => ({
  protocol: 1,
  requestId: receipt.requestId,
  proposalId: receipt.proposalId
})
const fixture = async (transport: Transport, host: Host = 'figma') => {
  const origin = await reserveOrigin()
  let clock = 1_800_000_000_000
  let valid = true
  let allowed = true
  let maxBytes = 65536
  let timeoutMs = 120_000
  const frames: Frame[] = []
  const protocolError = vi.fn()
  const invoke = vi.fn<ConstructorParameters<typeof FigPluginBridgeRuntime>[0]['invoke']>()
  const reserveWrite = vi.fn(() => true)
  const nativeWrite = vi.fn(() => false)
  const runtime = new FigPluginBridgeRuntime({
    now: () => clock,
    validateBinding: async () => valid,
    allowAssetTransfer: () => allowed,
    assetByteLimit: () => maxBytes,
    imageGenerationTimeoutMs: () => timeoutMs,
    allowNativeWrite: nativeWrite,
    writes: { reserve: reserveWrite, owns: () => true, release: vi.fn() },
    invoke
  })
  cleanups.push(() => {
    runtime.dispose()
    expect(protocolError).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(nativeWrite).not.toHaveBeenCalled()
    expect(reserveWrite).not.toHaveBeenCalled()
    for (const frame of frames)
      expect(Buffer.byteLength(frame.data)).toBeLessThanOrEqual(
        FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES
      )
  })
  if (transport === 'development-http') {
    const server = await startFigPluginBridgeServer({ origin, runtime, requestTimeoutMs: 3000 })
    cleanups.push(() => server.close())
  } else {
    // Real loopback + MessageChannel, not a claim of packaged utility-process or GUI validation.
    const { port1, port2 } = new MessageChannel()
    const nonce = 'b'.repeat(32)
    const endpoint = createFigPluginBridgeChildRpcEndpoint({
      port: recordingPort(port1, 'main', frames),
      nonce,
      handle: createFigPluginBridgeChildRuntimeHandler(runtime),
      onProtocolError: protocolError
    })
    const rpc = createFigPluginBridgeChildRpcClient({
      port: recordingPort(port2, 'child', frames),
      nonce
    })
    cleanups.push(() => {
      endpoint.close()
      rpc.close()
      port1.close()
      port2.close()
    })
    const server = await startFigPluginBridgeChildHttpServer({
      origin,
      rpc,
      requestTimeoutMs: 3000
    })
    cleanups.push(() => server.close())
  }
  const binding: FigPluginRuntimeBinding = {
    pluginId: `owned.${host}`,
    host,
    generation: 1,
    artifactSha256: 'b'.repeat(64),
    signerFingerprint: 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    bridgeOrigin: origin,
    projectId: 'owned-project',
    profileId: 'PRIVATE-PROVIDER-PROFILE',
    profileRevision: 'e'.repeat(64)
  }
  const pair = async () => {
    const ticket = await runtime.createPairing(binding)
    const reply = await http(origin, '/figplugin/v1/pair', {
      protocol: 1,
      ticketId: ticket.ticketId,
      pairingSecret: ticket.pairingSecret,
      pluginId: ticket.pluginId,
      host: ticket.host,
      artifactSha256: ticket.artifactSha256,
      clientNonce: 'f'.repeat(32)
    })
    expect(reply.status).toBe(200)
    return figPluginPairResponseSchema.parse(JSON.parse(reply.text))
  }
  const session = await pair()
  const send = (path: string, body: unknown, peer = session) => http(origin, path, body, auth(peer))
  const prepare = async (body: unknown = request()) => {
    const reply = await send(PREPARE, body)
    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    return figPluginImageGenerationProposalPrepareResponseSchema.parse(JSON.parse(reply.text))
  }
  const claim = async (receipt: FigPluginImageGenerationProposalPrepareResponse) => {
    const preview = runtime
      .nativeImageGenerationProposals()
      .find((item) => item.proposalId === receipt.proposalId)!
    expect(preview).toBeDefined()
    return runtime.claimNativeImageGeneration({
      proposalId: preview.proposalId,
      payloadSha256: preview.payloadSha256
    })
  }
  const readStatus = async (receipt: FigPluginImageGenerationProposalPrepareResponse) => {
    const reply = await send(STATUS, key(receipt))
    expect(reply.status).toBe(200)
    expect(reply.text).not.toMatch(
      /PRIVATE|prompt|jobId|generationRequestId|reference|url|sha256|output|profile|sessionId/i
    )
    return figPluginImageGenerationProposalStatusSchema.parse(JSON.parse(reply.text))
  }
  return {
    origin,
    runtime,
    frames,
    binding,
    session,
    pair,
    send,
    prepare,
    claim,
    readStatus,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
    invalidate: () => {
      valid = false
    },
    disallow: () => {
      allowed = false
    },
    limit: (bytes: number) => {
      maxBytes = bytes
    },
    timeout: (ms: number) => {
      timeoutMs = ms
    }
  }
}

describe('native image generation transport allowlists', () => {
  it('adds only the three authenticated bounded methods and keeps cancellation bodyless', () => {
    for (const [path, method, limit, noContent] of [
      [PREPARE, 'prepareImageGeneration', 65536, false],
      [STATUS, 'imageGenerationStatus', 4096, false],
      [CANCEL, 'cancelImageGeneration', 4096, true]
    ] as const) {
      expect(figPluginBridgeChildHttpRoute(path)).toEqual({
        method,
        auth: 'session',
        limit,
        noContent
      })
      expect(FIGPLUGIN_BRIDGE_CHILD_RPC_METHODS).toContain(method)
      expect(() =>
        encodeFigPluginBridgeChildRpcRequest({
          nonce: 'a'.repeat(32),
          requestId: 'b'.repeat(32),
          method,
          body: {}
        })
      ).toThrow()
    }
    for (const suffix of ['approve', 'accept', 'proposals', 'output', 'generate'])
      expect(
        figPluginBridgeChildHttpRoute(`/figplugin/v1/image-generation/${suffix}`)
      ).toBeUndefined()
    expect(FIGPLUGIN_BRIDGE_CHILD_RPC_METHODS).not.toContain('approveNativeImageGeneration')
    expect(FIGPLUGIN_BRIDGE_CHILD_RPC_METHODS).not.toContain('claimNativeImageGeneration')
  })
})

describe.each<Transport>(['development-http', 'child-http-messagechannel-rpc'])(
  '%s native proposals',
  (transport) => {
    it.each<Host>(['figma', 'photoshop'])(
      'queues only a Desktop proposal for %s and projects no generated output',
      async (host) => {
        const f = await fixture(transport, host)
        const receipt = await f.prepare()
        expect(receipt).toEqual({
          protocol: 1,
          requestId: request().requestId,
          proposalId: expect.stringMatching(/^[a-f0-9]{32}$/),
          status: 'awaiting-approval',
          createdAt: f.now(),
          expiresAt: f.now() + 120_000
        })
        const [preview] = f.runtime.nativeImageGenerationProposals()
        expect(preview).toMatchObject({
          requestId: receipt.requestId,
          proposalId: receipt.proposalId,
          sessionId: f.session.sessionId,
          pluginId: f.binding.pluginId,
          host,
          projectId: f.binding.projectId,
          prompt: request().prompt
        })
        expect(preview.generationRequestId).not.toBe(receipt.requestId)
        expect((await f.readStatus(receipt)).phase).toBe('awaiting-approval')
        expect(f.runtime.listPreviews()).toEqual([])
        const claimed = await f.claim(receipt)
        expect(claimed.request.requestId).toBe(preview.generationRequestId)
        expect((await f.readStatus(receipt)).phase).toBe('preparing')
        expect(f.runtime.nativeImageGenerationProposals()).toEqual([])
        const state: FigPluginImageGenerationState = {
          sessionId: claimed.request.sessionId,
          pluginId: claimed.request.pluginId,
          projectId: claimed.request.projectId,
          requestId: claimed.request.requestId,
          jobId: 'c'.repeat(32),
          phase: 'preparing',
          createdAt: f.now(),
          updatedAt: f.now(),
          expiresAt: receipt.expiresAt - 1
        }
        for (const phase of [
          'preparing',
          'awaiting-approval',
          'generating',
          'materializing',
          'awaiting-acceptance',
          'accepted'
        ] as const) {
          f.runtime.observeNativeImageGeneration(claimed, { ...state, phase })
          expect(await f.readStatus(receipt)).toEqual({
            ...key(receipt),
            phase,
            createdAt: receipt.createdAt,
            updatedAt: f.now(),
            expiresAt: receipt.expiresAt
          })
        }
        const assets = await f.send(FIGPLUGIN_ASSET_LIST_PATH, {
          protocol: 1,
          purpose: 'local-preview'
        })
        expect(assets.status).toBe(200)
        expect(figPluginAssetListSchema.parse(JSON.parse(assets.text)).assets).toEqual([])
        for (const suffix of ['approve', 'accept', 'proposals', 'output', 'generate'])
          errorResponse(
            await f.send(`/figplugin/v1/image-generation/${suffix}`, key(receipt)),
            400,
            'INVALID_REQUEST'
          )
        if (transport === 'child-http-messagechannel-rpc') {
          const frames = f.frames
            .filter((frame) => frame.side === 'child')
            .map((frame) => JSON.parse(frame.data))
          const prepared = frames.find((frame) => frame.method === 'prepareImageGeneration')
          expect(prepared.body.requestId).toBe(receipt.requestId)
          expect(prepared.requestId).not.toBe(receipt.requestId)
          expect(frames.some((frame) => frame.method === 'imageGenerationStatus')).toBe(true)
          const returned = f.frames.filter((frame) => frame.side === 'main').slice(1)
          for (const frame of returned)
            expect(frame.data).not.toMatch(
              /PRIVATE|generationRequestId|payloadSha256|jobId|localMediaUrl/
            )
        }
      }
    )

    it('keeps replay receipts stable, rejects mutated bodies and shares sequence admission with existing prepare', async () => {
      const f = await fixture(transport)
      const receipt = await f.prepare()
      expect(await f.prepare()).toEqual(receipt)
      for (const changed of [
        { ...request(), prompt: 'different prompt' },
        { ...request(), sequence: 2 },
        request(2)
      ]) {
        const reply = await f.send(PREPARE, changed)
        errorResponse(
          reply,
          changed.requestId === receipt.requestId ? 400 : 429,
          changed.requestId === receipt.requestId ? 'INVALID_REQUEST' : 'BUSY'
        )
      }
      expect((await f.send(CANCEL, key(receipt))).status).toBe(204)
      expect(await f.prepare()).toEqual(receipt)
      const normal = {
        protocol: 1,
        requestId: 'ordinary-native-request',
        sequence: 1,
        prompt: 'Read-only request',
        context: { nodes: [], selectionRevision: 'owned' }
      }
      errorResponse(await f.send('/figplugin/v1/prepare', normal), 400, 'INVALID_REQUEST')
      const second = await f.prepare(request(2))
      expect(second.proposalId).not.toBe(receipt.proposalId)
      expect(f.runtime.nativeImageGenerationProposals()).toHaveLength(1)
    })

    it('binds status and cancellation to both native request ID and proposal ID within one authenticated session', async () => {
      const f = await fixture(transport)
      const receipt = await f.prepare()
      const other = await f.pair()
      for (const path of [STATUS, CANCEL]) {
        errorResponse(await f.send(path, key(receipt), other), 401, 'UNAUTHORIZED')
        errorResponse(
          await f.send(path, { ...key(receipt), requestId: 'c'.repeat(32) }),
          401,
          'UNAUTHORIZED'
        )
        errorResponse(
          await f.send(path, { ...key(receipt), proposalId: 'd'.repeat(32) }),
          401,
          'UNAUTHORIZED'
        )
      }
      expect((await f.readStatus(receipt)).phase).toBe('awaiting-approval')
    })

    it('rejects native authority fields and incomplete or scalar status/cancel envelopes without mutating the proposal', async () => {
      const f = await fixture(transport)
      for (const change of [
        { protocol: 2 },
        { requestId: 'A'.repeat(32) },
        { sequence: 0 },
        { sequence: 1_000_000_001 },
        { prompt: ' '.repeat(10) },
        { prompt: 'x'.repeat(8193) },
        { generationRequestId: 'b'.repeat(32) },
        { sessionId: f.session.sessionId },
        { approved: true },
        { profileId: 'PRIVATE-OVERRIDE' },
        { context: {} },
        { correlationId: 'f'.repeat(32) }
      ])
        errorResponse(await f.send(PREPARE, { ...request(), ...change }), 400, 'INVALID_REQUEST')
      expect(f.runtime.nativeImageGenerationProposals()).toEqual([])
      const receipt = await f.prepare()
      for (const path of [STATUS, CANCEL])
        for (const value of [
          receipt.proposalId,
          {},
          { ...key(receipt), protocol: 2 },
          { protocol: 1, proposalId: receipt.proposalId },
          { ...key(receipt), approved: true },
          { ...key(receipt), output: 'PRIVATE-OUTPUT' }
        ])
          errorResponse(await f.send(path, value), 400, 'INVALID_REQUEST')
      expect((await f.readStatus(receipt)).phase).toBe('awaiting-approval')
      const cancelled = await f.send(CANCEL, key(receipt))
      expect(cancelled.status).toBe(204)
      expect(cancelled.text).toBe('')
      expect(cancelled.headers['content-type']).toBeUndefined()
      expect((await f.readStatus(receipt)).phase).toBe('cancelled')
    })

    it('enforces the raw 64KiB prepare bound for length, chunked and UTF-8 input before trim', async () => {
      const f = await fixture(transport)
      const base = JSON.stringify(request())
      const raw = base + ' '.repeat(65536 - Buffer.byteLength(base))
      expect((await rawHttp(f.origin, PREPARE, f.session, raw)).status).toBe(200)
      errorResponse(
        await rawHttp(f.origin, PREPARE, f.session, '', false, 65537),
        400,
        'INVALID_REQUEST'
      )
      errorResponse(
        await rawHttp(f.origin, PREPARE, f.session, raw + ' ', true),
        400,
        'INVALID_REQUEST'
      )
      const multibyte = JSON.stringify({ ...request(), prompt: 'x' + '\u3000'.repeat(22_000) })
      expect(multibyte.length).toBeLessThan(65536)
      errorResponse(
        await rawHttp(f.origin, PREPARE, f.session, multibyte, true),
        400,
        'INVALID_REQUEST'
      )
      for (const malformed of [
        Buffer.from([0xc3, 0x28]),
        Buffer.from('\ufeff' + base),
        Buffer.from('{')
      ])
        errorResponse(
          await http(f.origin, PREPARE, undefined, auth(f.session), { raw: malformed }),
          400,
          'INVALID_REQUEST'
        )
      expect(f.runtime.nativeImageGenerationProposals()).toHaveLength(1)
    })

    it('enforces the smaller 4KiB status/cancel bounds without dropping an oversized envelope', async () => {
      const f = await fixture(transport)
      const receipt = await f.prepare()
      const base = JSON.stringify(key(receipt))
      const raw = base + ' '.repeat(4096 - Buffer.byteLength(base))
      for (const path of [STATUS, CANCEL])
        for (const chunked of [false, true])
          errorResponse(
            await http(f.origin, path, undefined, auth(f.session), { raw: raw + ' ', chunked }),
            400,
            'INVALID_REQUEST'
          )
      expect((await f.readStatus(receipt)).phase).toBe('awaiting-approval')
      expect((await http(f.origin, STATUS, undefined, auth(f.session), { raw })).status).toBe(200)
      expect((await http(f.origin, CANCEL, undefined, auth(f.session), { raw })).status).toBe(204)
    })

    it('retains exact bearer/session, Host, opaque-Origin and preflight checks for every new route', async () => {
      const f = await fixture(transport)
      for (const path of [PREPARE, STATUS, CANCEL]) {
        const body =
          path === PREPARE
            ? request()
            : { protocol: 1, requestId: 'a'.repeat(32), proposalId: 'b'.repeat(32) }
        errorResponse(await http(f.origin, path, body), 401, 'UNAUTHORIZED')
        errorResponse(
          await http(f.origin, path, body, {
            ...auth(f.session),
            Authorization: 'Bearer ' + '0'.repeat(64)
          }),
          401,
          'UNAUTHORIZED'
        )
        errorResponse(
          await http(f.origin, path, body, {
            ...auth(f.session),
            Host: 'localhost:' + new URL(f.origin).port
          }),
          400,
          'INVALID_REQUEST'
        )
        errorResponse(
          await http(f.origin, path, body, {
            ...auth(f.session),
            Origin: 'https://example.invalid'
          }),
          403,
          'DENIED'
        )
        errorResponse(
          await http(f.origin, path, body, { ...auth(f.session), Cookie: 'private=value' }),
          400,
          'INVALID_REQUEST'
        )
        errorResponse(
          await http(f.origin, path + '?approved=1', body, auth(f.session)),
          400,
          'INVALID_REQUEST'
        )
        const preflight = await http(
          f.origin,
          path,
          undefined,
          {
            Origin: 'null',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type, authorization, x-figplugin-session'
          },
          { method: 'OPTIONS' }
        )
        expect(preflight.status).toBe(204)
        expect(preflight.headers['access-control-allow-origin']).toBe('*')
        expect(preflight.headers['access-control-allow-credentials']).toBeUndefined()
      }
      const accepted = await http(f.origin, PREPARE, request(), {
        ...auth(f.session),
        Origin: 'null'
      })
      expect(accepted.status).toBe(200)
      expect(accepted.headers['access-control-allow-origin']).toBe('*')
      expect(accepted.headers['access-control-allow-credentials']).toBeUndefined()
    })

    it('cancels claimed main work with 204 and cannot project a late coordinator completion', async () => {
      const f = await fixture(transport)
      const receipt = await f.prepare()
      const claimed = await f.claim(receipt)
      expect(claimed.signal.aborted).toBe(false)
      expect((await f.send(CANCEL, key(receipt))).status).toBe(204)
      expect(claimed.signal.aborted).toBe(true)
      f.runtime.observeNativeImageGeneration(claimed, {
        sessionId: claimed.request.sessionId,
        pluginId: claimed.request.pluginId,
        projectId: claimed.request.projectId,
        requestId: claimed.request.requestId,
        jobId: 'c'.repeat(32),
        phase: 'accepted',
        createdAt: f.now(),
        updatedAt: f.now(),
        expiresAt: receipt.expiresAt
      })
      expect((await f.readStatus(receipt)).phase).toBe('cancelled')
      expect(f.runtime.isNativeImageGenerationCurrent(claimed)).toBe(false)
      expect(f.runtime.nativeImageGenerationProposals()).toEqual([])
    })

    it('does not renew the original proposal deadline by status polling', async () => {
      const f = await fixture(transport)
      f.timeout(10_000)
      const receipt = await f.prepare()
      const claimed = await f.claim(receipt)
      f.advance(9999)
      expect((await f.readStatus(receipt)).expiresAt).toBe(receipt.expiresAt)
      f.advance(1)
      expect(await f.readStatus(receipt)).toMatchObject({
        phase: 'failed',
        error: 'EXPIRED',
        expiresAt: receipt.expiresAt
      })
      expect(claimed.signal.aborted).toBe(true)
      f.advance(120_000)
      errorResponse(await f.send(STATUS, key(receipt)), 401, 'UNAUTHORIZED')
    })

    it.each(['close', 'revoke', 'binding-change'] as const)(
      'removes proposal authority after %s',
      async (change) => {
        const f = await fixture(transport)
        const receipt = await f.prepare()
        const claimed = await f.claim(receipt)
        if (change === 'close')
          expect((await f.send('/figplugin/v1/close', { protocol: 1 })).status).toBe(204)
        else if (change === 'revoke') f.runtime.revokePlugin(f.binding.pluginId)
        else {
          f.invalidate()
          errorResponse(await f.send(STATUS, key(receipt)), 409, 'CONFIGURATION_CHANGED')
        }
        expect(claimed.signal.aborted).toBe(true)
        expect(f.runtime.nativeImageGenerationProposals()).toEqual([])
        expect(f.runtime.isNativeImageGenerationCurrent(claimed)).toBe(false)
        errorResponse(await f.send(STATUS, key(receipt)), 401, 'UNAUTHORIZED')
        errorResponse(await f.send(CANCEL, key(receipt)), 401, 'UNAUTHORIZED')
      }
    )

    it('rejects denied permissions without dispatch', async () => {
      const f = await fixture(transport)
      f.disallow()
      errorResponse(await f.send(PREPARE, request()), 403, 'DENIED')
      expect(f.runtime.nativeImageGenerationProposals()).toEqual([])
    })

    it('enforces signed byte limits and aborts claimed work if they change', async () => {
      const f = await fixture(transport)
      f.limit(1)
      errorResponse(await f.send(PREPARE, request()), 400, 'INVALID_REQUEST')
      f.limit(1024)
      errorResponse(
        await f.send(PREPARE, { ...request(), prompt: 'x' + ' '.repeat(1024) }),
        400,
        'INVALID_REQUEST'
      )
      f.limit(65536)
      const receipt = await f.prepare()
      const claimed = await f.claim(receipt)
      f.limit(32768)
      errorResponse(await f.send(STATUS, key(receipt)), 409, 'CONFIGURATION_CHANGED')
      expect(claimed.signal.aborted).toBe(true)
      expect(await f.readStatus(receipt)).toMatchObject({
        phase: 'failed',
        error: 'CONFIGURATION_CHANGED'
      })
    })

    it('rejects augmented responses at both development serialization and the parent RPC boundary', async () => {
      const f = await fixture(transport)
      const receipt = await f.prepare()
      vi.spyOn(f.runtime, 'prepareImageGeneration').mockResolvedValue(
        Object.assign({}, receipt, { output: 'PRIVATE-IMAGE' })
      )
      errorResponse(await f.send(PREPARE, request()), 502, 'UPSTREAM_FAILED')
      const status = await f.readStatus(receipt)
      vi.spyOn(f.runtime, 'imageGenerationStatus').mockResolvedValue(
        Object.assign({}, status, { localMediaUrl: 'PRIVATE-LOCAL-IMAGE' })
      )
      errorResponse(await f.send(STATUS, key(receipt)), 502, 'UPSTREAM_FAILED')
      for (const frame of f.frames.filter((frame) => frame.side === 'main'))
        expect(frame.data).not.toMatch(/PRIVATE-IMAGE|PRIVATE-LOCAL-IMAGE/)
    })
  }
)
