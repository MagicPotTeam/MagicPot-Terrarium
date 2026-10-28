import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  figPluginPairResponseSchema,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  FIGPLUGIN_ASSET_LIST_PATH,
  FIGPLUGIN_ASSET_READ_PATH,
  FIGPLUGIN_ASSET_TTL_MS,
  figPluginAssetChunkSchema,
  figPluginAssetListSchema,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import { assembleBinaryChunks, type BinaryChunkFrame } from '@shared/binaryChunkProtocol'
import { startFigPluginBridgeChildHttpServer } from './bridgeChildHttp'
import {
  createFigPluginBridgeChildRpcClient,
  createFigPluginBridgeChildRpcEndpoint,
  createFigPluginBridgeChildRuntimeHandler,
  type FigPluginBridgeChildRpcPort
} from './bridgeChildRpc'
import { FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES } from './bridgeChildWire'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { startFigPluginBridgeServer } from './bridgeServer'

type Host = FigPluginRuntimeBinding['host']
type Transport = 'in-process-loopback' | 'child-http-messagechannel-rpc'
type HttpResult = { status: number; text: string; cacheControl?: string }
type CapturedFrame = { side: 'parent' | 'child'; data: string }
const cleanups: Array<() => void | Promise<void>> = []
const effects: Array<readonly { mock: { calls: readonly unknown[] } }[]> = []
const within = async <T>(promise: Promise<T>, label: string, timeout = 4_500): Promise<T> => {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture timed out: ${label}`)), timeout)
        timer.unref()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
afterEach(async () => {
  try {
    for (const fixtureEffects of effects.splice(0))
      for (const effect of fixtureEffects) expect(effect).not.toHaveBeenCalled()
  } finally {
    for (const cleanup of cleanups.splice(0).reverse())
      await within(Promise.resolve().then(cleanup), 'cleanup')
  }
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
      await within(
        new Promise<void>((resolve, reject) =>
          holder.close((error) => (error ? reject(error) : resolve()))
        ),
        'reservation close'
      )
  }
}
const post = (
  origin: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    let settled = false
    const finish = (error?: Error, response?: HttpResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) reject(error)
      else resolve(response!)
    }
    const outgoing = httpRequest(
      origin,
      {
        path,
        method,
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      },
      (response) => {
        const parts: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 128 * 1024) {
            outgoing.destroy(new Error('Fixture response exceeded transport frame budget'))
            return
          }
          parts.push(chunk)
        })
        response.on('error', (error) => finish(error))
        response.on('end', () =>
          finish(undefined, {
            status: response.statusCode!,
            text: Buffer.concat(parts).toString('utf8'),
            cacheControl: response.headers['cache-control']
          })
        )
      }
    )
    const deadline = setTimeout(
      () => outgoing.destroy(new Error('Fixture HTTP request timed out')),
      4_000
    )
    deadline.unref()
    outgoing.on('error', (error) => finish(error))
    outgoing.end(data)
  })
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})
const pngChunk = (type: string, data: Buffer) => {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}
const fixtureBytes = () => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  // Legal ancillary padding makes three full/properly-finalized wire chunks from one black pixel.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk(
      'tEXt',
      Buffer.concat([Buffer.from('fixture\0'), Buffer.alloc(FIGPLUGIN_ASSET_CHUNK_BYTES * 2, 65)])
    ),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
const listRequest = { protocol: 1, purpose: 'local-preview' } as const
const readRequest = (asset: FigPluginSessionAsset, index = 0) => ({
  ...listRequest,
  assetId: asset.assetId,
  sha256: asset.sha256,
  index
})
const headersFor = (session: FigPluginPairResponse) => ({
  Authorization: `Bearer ${session.sessionToken}`,
  'X-FigPlugin-Session': session.sessionId
})
const recordingPort = (
  port: MessagePort,
  side: CapturedFrame['side'],
  frames: CapturedFrame[]
): FigPluginBridgeChildRpcPort => ({
  postMessage: (data) => {
    frames.push({ side, data })
    port.postMessage(data)
  },
  on: (event, listener) => port.on(event, listener),
  off: (event, listener) => port.off(event, listener)
})
const fixture = async (transport: Transport, host: Host) => {
  const origin = await reserveOrigin()
  let clock = 1_800_000_000_000
  let allowed = true
  let valid = true
  const frames: CapturedFrame[] = []
  const invoke = vi
    .fn<ConstructorParameters<typeof FigPluginBridgeRuntime>[0]['invoke']>()
    .mockResolvedValue({ content: 'must not be invoked' })
  const audit = vi.fn()
  const planningAudit = vi.fn()
  const writeAccess = vi.fn(() => true)
  const reserveWrite = vi.fn(() => true)
  const protocolError = vi.fn()
  const runtime = new FigPluginBridgeRuntime({
    now: () => clock,
    validateBinding: async () => valid,
    allowAssetTransfer: () => allowed,
    invoke,
    audit,
    planningAudit,
    allowNativeWrite: writeAccess,
    writes: { reserve: reserveWrite, owns: vi.fn(() => true), release: vi.fn() }
  })
  const approve = vi.spyOn(runtime, 'approve')
  const approvePlan = vi.spyOn(runtime, 'approvePlan')
  effects.push([
    invoke,
    audit,
    planningAudit,
    approve,
    approvePlan,
    writeAccess,
    reserveWrite,
    protocolError
  ])
  cleanups.push(() => runtime.dispose())
  if (transport === 'in-process-loopback') {
    const server = await startFigPluginBridgeServer({ origin, runtime, requestTimeoutMs: 3_000 })
    cleanups.push(() => server.close())
  } else {
    const { port1, port2 } = new MessageChannel()
    const nonce = 'a'.repeat(32)
    const endpoint = createFigPluginBridgeChildRpcEndpoint({
      port: recordingPort(port1, 'parent', frames),
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
      requestTimeoutMs: 3_000
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
    profileId: 'PRIVATE-PROVIDER-FIXTURE',
    profileRevision: 'e'.repeat(64)
  }
  const pair = async (value = binding) => {
    const ticket = await runtime.createPairing(value)
    const response = await post(origin, '/figplugin/v1/pair', {
      protocol: 1,
      ticketId: ticket.ticketId,
      pairingSecret: ticket.pairingSecret,
      pluginId: ticket.pluginId,
      host: ticket.host,
      artifactSha256: ticket.artifactSha256,
      clientNonce: 'f'.repeat(32)
    })
    expect(response.status).toBe(200)
    return figPluginPairResponseSchema.parse(JSON.parse(response.text))
  }
  const session = await pair()
  const target = {
    sessionId: session.sessionId,
    pluginId: binding.pluginId,
    projectId: binding.projectId
  }
  const bytes = fixtureBytes()
  const selection = await runtime.beginSessionAssetSelection(target)
  const asset = await runtime.publishSessionAsset(selection, {
    mimeType: 'image/png',
    width: 1,
    height: 1,
    bytes
  })
  const send = (path: string, body: unknown, peer = session) =>
    post(origin, path, body, headersFor(peer))
  const list = async () => {
    const response = await send(FIGPLUGIN_ASSET_LIST_PATH, listRequest)
    expect(response.status).toBe(200)
    return figPluginAssetListSchema.parse(JSON.parse(response.text))
  }
  return {
    runtime,
    origin,
    binding,
    pair,
    session,
    target,
    selection,
    bytes,
    asset,
    send,
    list,
    frames,
    advance: (milliseconds: number) => {
      clock += milliseconds
    },
    setAllowed: (value: boolean) => {
      allowed = value
    },
    setValid: (value: boolean) => {
      valid = value
    }
  }
}
const errorResponse = (response: HttpResult, status: number, code: string) => {
  expect(response.status).toBe(status)
  expect(JSON.parse(response.text)).toMatchObject({ code })
  expect(response.cacheControl).toBe('no-store')
  expect(Buffer.byteLength(response.text)).toBeLessThan(1024)
}

describe.each([
  { transport: 'in-process-loopback', host: 'figma' },
  { transport: 'in-process-loopback', host: 'photoshop' },
  { transport: 'child-http-messagechannel-rpc', host: 'figma' },
  { transport: 'child-http-messagechannel-rpc', host: 'photoshop' }
] as const)('$host session asset reads across $transport', ({ transport, host }) => {
  it('reconstructs exact approved bytes from authenticated idempotent HTTP/RPC chunks within the unchanged frame cap', async () => {
    const f = await fixture(transport, host)
    const response = await f.send(FIGPLUGIN_ASSET_LIST_PATH, listRequest)
    expect(response.status).toBe(200)
    expect(response.cacheControl).toBe('no-store')
    expect(figPluginAssetListSchema.parse(JSON.parse(response.text))).toEqual({
      protocol: 1,
      purpose: 'local-preview',
      sessionId: f.session.sessionId,
      assets: [f.asset]
    })
    for (const secret of [
      'bytesBase64',
      'path',
      'url',
      'sessionToken',
      'profileId',
      'profileRevision',
      f.session.sessionToken,
      f.binding.profileId,
      f.bytes.toString('base64')
    ])
      expect(response.text).not.toContain(secret)
    const chunks: BinaryChunkFrame[] = []
    expect(f.asset.chunkCount).toBe(3)
    for (let index = 0; index < f.asset.chunkCount; index++) {
      const read = await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset, index))
      expect(read.status).toBe(200)
      expect(read.cacheControl).toBe('no-store')
      expect(Buffer.byteLength(read.text)).toBeLessThan(128 * 1024)
      const parsed = figPluginAssetChunkSchema.parse(JSON.parse(read.text))
      expect(parsed).toMatchObject({
        sessionId: f.session.sessionId,
        assetId: f.asset.assetId,
        purpose: 'local-preview'
      })
      expect(Buffer.from(parsed.chunk.bytesBase64, 'base64')).toEqual(
        f.bytes.subarray(
          index * FIGPLUGIN_ASSET_CHUNK_BYTES,
          (index + 1) * FIGPLUGIN_ASSET_CHUNK_BYTES
        )
      )
      expect((await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset, index))).text).toBe(
        read.text
      )
      expect(read.text).not.toContain(f.session.sessionToken)
      chunks.push(parsed.chunk)
    }
    const assembled = await assembleBinaryChunks(
      {
        version: 1,
        kind: 'content-addressed-binary',
        mimeType: f.asset.mimeType,
        sha256: f.asset.sha256,
        sizeBytes: f.asset.sizeBytes,
        chunkSize: f.asset.chunkSize,
        chunkCount: f.asset.chunkCount
      },
      chunks.reverse()
    )
    expect(Buffer.from(assembled)).toEqual(f.bytes)
    expect(createHash('sha256').update(assembled).digest('hex')).toBe(f.asset.sha256)
    expect((await f.list()).assets).toEqual([f.asset])
    expect(f.runtime.listPreviews()).toEqual([])
    expect(f.runtime.listPlanExecutions()).toEqual([])
    if (transport === 'child-http-messagechannel-rpc') {
      expect(FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES).toBe(128 * 1024)
      expect(
        f.frames.some(
          (frame) => frame.side === 'parent' && Buffer.byteLength(frame.data) > 32 * 1024
        )
      ).toBe(true)
      for (const frame of f.frames)
        expect(Buffer.byteLength(frame.data)).toBeLessThan(FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES)
      const methods = f.frames
        .filter((frame) => frame.side === 'child')
        .map((frame) => JSON.parse(frame.data).method)
      expect(new Set(methods)).toEqual(new Set(['redeem', 'assetList', 'assetChunk']))
    }
  })

  it('requires exact bearer/session credentials and does not borrow another plugin or project session', async () => {
    const f = await fixture(transport, host)
    const other = await f.pair({
      ...f.binding,
      pluginId: `other.${host}`,
      projectId: 'other-project'
    })
    for (const path of [FIGPLUGIN_ASSET_LIST_PATH, FIGPLUGIN_ASSET_READ_PATH]) {
      const body = path === FIGPLUGIN_ASSET_LIST_PATH ? listRequest : readRequest(f.asset)
      const invalidHeaders: Record<string, string>[] = [
        {},
        { Authorization: `Bearer ${f.session.sessionToken}` },
        { 'X-FigPlugin-Session': f.session.sessionId },
        { ...headersFor(f.session), Authorization: `Bearer ${'0'.repeat(64)}` },
        { ...headersFor(f.session), Authorization: `Bearer ${other.sessionToken}` },
        { ...headersFor(f.session), 'X-FigPlugin-Session': other.sessionId }
      ]
      for (const headers of invalidHeaders)
        errorResponse(await post(f.origin, path, body, headers), 401, 'UNAUTHORIZED')
    }
    errorResponse(
      await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset), other),
      410,
      'EXPIRED'
    )
    const catalog = await f.send(FIGPLUGIN_ASSET_LIST_PATH, listRequest, other)
    expect(catalog.status).toBe(200)
    expect(figPluginAssetListSchema.parse(JSON.parse(catalog.text)).assets).toEqual([])
    expect((await f.list()).assets).toEqual([f.asset])
  })

  it('rejects alternate purposes, paths, URLs, bad hashes and bad chunk indexes with fixed sanitized errors', async () => {
    const f = await fixture(transport, host)
    for (const patch of [
      { protocol: 2 },
      { purpose: 'provider-input' },
      { purpose: 'native-write' },
      { purpose: undefined },
      { path: 'C:\\PRIVATE-TRANSPORT-FIXTURE.png' },
      { url: 'https://example.invalid/PRIVATE-TRANSPORT-FIXTURE.png' },
      { bytesBase64: 'UFJJVkFURS1QSVhFTFM=' },
      { projectId: 'other-project' },
      { pluginId: `other.${host}` }
    ]) {
      const list = await f.send(FIGPLUGIN_ASSET_LIST_PATH, { ...listRequest, ...patch })
      const read = await f.send(FIGPLUGIN_ASSET_READ_PATH, { ...readRequest(f.asset), ...patch })
      for (const response of [list, read]) {
        errorResponse(response, 400, 'INVALID_REQUEST')
        expect(response.text).not.toContain('PRIVATE-TRANSPORT-FIXTURE')
        expect(response.text).not.toContain(f.session.sessionToken)
        expect(response.text).not.toContain(f.bytes.toString('base64'))
      }
    }
    for (const patch of [
      { sha256: '0'.repeat(64) },
      { index: -1 },
      { index: 0.5 },
      { index: f.asset.chunkCount },
      { index: 1_000_000 }
    ])
      errorResponse(
        await f.send(FIGPLUGIN_ASSET_READ_PATH, { ...readRequest(f.asset), ...patch }),
        400,
        'INVALID_REQUEST'
      )
    expect((await f.list()).assets).toEqual([f.asset])
    expect((await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset))).status).toBe(200)
  })

  it('exposes no remote selection, publication, revoke or write method even to the authenticated native host', async () => {
    const f = await fixture(transport, host)
    for (const route of [
      'select',
      'publish',
      'revoke',
      'write',
      'beginSessionAssetSelection',
      'publishSessionAsset',
      'revokeSessionAsset'
    ])
      errorResponse(
        await f.send(`/figplugin/v1/assets/${route}`, {
          ...listRequest,
          ...f.target,
          assetId: f.asset.assetId,
          sha256: f.asset.sha256,
          selection: f.selection,
          mimeType: 'image/png',
          width: 1,
          height: 1,
          bytesBase64: 'UFJJVkFURS1QSVhFTFM='
        }),
        400,
        'INVALID_REQUEST'
      )
    errorResponse(
      await post(f.origin, FIGPLUGIN_ASSET_LIST_PATH, listRequest, headersFor(f.session), 'GET'),
      400,
      'INVALID_REQUEST'
    )
    expect((await f.list()).assets).toEqual([f.asset])
    await f.runtime.revokeSessionAsset({
      ...f.target,
      assetId: f.asset.assetId,
      sha256: f.asset.sha256
    })
    expect((await f.list()).assets).toEqual([])
    errorResponse(await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset)), 410, 'EXPIRED')
  })

  it('never refreshes asset lifetime when the transport retries reads and keeps only the session alive', async () => {
    const f = await fixture(transport, host)
    f.advance(FIGPLUGIN_ASSET_TTL_MS - 1)
    expect((await f.list()).assets).toEqual([f.asset])
    expect((await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset))).status).toBe(200)
    f.advance(1)
    expect((await f.list()).assets).toEqual([])
    errorResponse(await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset)), 410, 'EXPIRED')
    expect(f.runtime.listSessions()).toHaveLength(1)
  })

  it('destroys retained pixels on capability revocation and refuses configuration-stale credentials', async () => {
    const f = await fixture(transport, host)
    f.setAllowed(false)
    errorResponse(await f.send(FIGPLUGIN_ASSET_LIST_PATH, listRequest), 403, 'DENIED')
    errorResponse(await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset)), 403, 'DENIED')
    f.setAllowed(true)
    expect((await f.list()).assets).toEqual([])
    errorResponse(await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset)), 410, 'EXPIRED')
    f.setValid(false)
    errorResponse(
      await f.send(FIGPLUGIN_ASSET_LIST_PATH, listRequest),
      409,
      'CONFIGURATION_CHANGED'
    )
    errorResponse(
      await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset)),
      401,
      'UNAUTHORIZED'
    )
    expect(f.runtime.listSessions()).toEqual([])
  })

  it('removes session assets when authenticated close arrives over the same production route', async () => {
    const f = await fixture(transport, host)
    const closing = await f.send('/figplugin/v1/close', { protocol: 1 })
    expect(closing.status).toBe(204)
    expect(closing.text).toBe('')
    expect(f.runtime.listSessions()).toEqual([])
    errorResponse(await f.send(FIGPLUGIN_ASSET_LIST_PATH, listRequest), 401, 'UNAUTHORIZED')
    errorResponse(
      await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f.asset)),
      401,
      'UNAUTHORIZED'
    )
  })
})
import { Buffer } from 'node:buffer'
