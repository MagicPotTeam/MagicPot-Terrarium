import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer } from 'node:net'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  figPluginBridgePrepareResponseSchema,
  figPluginBridgeStatusResponseSchema,
  figPluginPairResponseSchema,
  type FigPluginBridgeErrorCode,
  type FigPluginBridgePrepareRequest,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  figPluginExecutionClaimResponseSchema,
  figPluginExecutionResultResponseSchema,
  figPluginExecutionStatusSchema,
  type FigPluginExecutionPreview
} from '@shared/figplugin/execution'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_READ_PATH,
  FIGPLUGIN_ASSET_TTL_MS,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import { readExecutionAsset } from '@shared/figplugin/hostExecutionAssetClient'
import {
  FIGPLUGIN_EXECUTION_ASSET_READ_PATH,
  figPluginExecutionAssetChunkSchema
} from '@shared/figplugin/hostExecutionAssets'
import { stepValue, type HostContext, type HostPlan } from '@shared/figplugin/hostPlan'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import { planningAssetMetadata } from '@shared/figplugin/hostPlanningAssets'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
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
type Transport = 'development-http' | 'child-http-messagechannel-rpc'
type HttpResult = { status: number; text: string; headers: IncomingHttpHeaders }
type Frame = { side: 'main' | 'child'; data: string }
const cleanups: Array<() => void | Promise<void>> = []
const protocolErrors: ReturnType<typeof vi.fn>[] = []
const within = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Image transport fixture timeout: ${label}`)),
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
  try {
    for (const cleanup of cleanups.splice(0).reverse())
      await within(Promise.resolve().then(cleanup), 'cleanup')
  } finally {
    for (const error of protocolErrors.splice(0)) expect(error).not.toHaveBeenCalled()
  }
})
const reserveOrigin = async () => {
  const holder = createServer()
  try {
    holder.listen({ host: '127.0.0.1', port: 0 })
    await within(once(holder, 'listening'), 'reserve loopback')
    const address = holder.address()
    if (!address || typeof address === 'string') throw new Error('Invalid fixture address')
    return `http://127.0.0.1:${address.port}`
  } finally {
    if (holder.listening)
      await within(
        new Promise<void>((resolve, reject) =>
          holder.close((error) => (error ? reject(error) : resolve()))
        ),
        'close loopback reservation'
      )
  }
}
const http = (
  origin: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  options: { method?: string; raw?: string; chunked?: boolean } = {}
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const data = options.raw ?? (body === undefined ? '' : JSON.stringify(body))
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
        const parts: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 128 * 1024) {
            outgoing.destroy(new Error('Image transport response exceeded the unchanged cap'))
            return
          }
          parts.push(chunk)
        })
        response.on('error', (error) => finish(error))
        response.on('end', () =>
          finish(undefined, {
            status: response.statusCode!,
            text: Buffer.concat(parts).toString('utf8'),
            headers: response.headers
          })
        )
      }
    )
    const deadline = setTimeout(
      () => outgoing.destroy(new Error('Image transport HTTP timeout')),
      4000
    )
    deadline.unref()
    outgoing.on('error', (error) => finish(error))
    outgoing.end(data)
  })
const headersFor = (session: FigPluginPairResponse) => ({
  Authorization: `Bearer ${session.sessionToken}`,
  'X-FigPlugin-Session': session.sessionId
})
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
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
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
const syntheticPng = (red: number) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  // One synthetic pixel plus legal ancillary padding exercises three wire chunks.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk(
      'tEXt',
      Buffer.concat([Buffer.from('fixture\0'), Buffer.alloc(FIGPLUGIN_ASSET_CHUNK_BYTES * 2, 65)])
    ),
    pngChunk('IDAT', deflateSync(Buffer.from([0, red, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
const hostContext = (host: Host): HostContext => {
  const command = host === 'figma' ? 'image.fill' : 'image.pixels'
  return {
    version: 1,
    host,
    documentId: host === 'figma' ? 'owned-document' : '7',
    scopeId: host === 'figma' ? 'owned-page' : '7',
    captureId: 'a'.repeat(32),
    selectedIds: ['42'],
    nodes: [
      {
        id: '42',
        type: host === 'figma' ? 'RECTANGLE' : 'pixel',
        name: 'Synthetic target',
        parentId: null,
        ancestors: [],
        locked: false,
        visible: true,
        commands: [command],
        ...(host === 'figma'
          ? { imageFill: { status: 'available' as const, fingerprint: 'd'.repeat(64) } }
          : {
              imagePixels: {
                status: 'available' as const,
                historyStateId: 7,
                bounds: { left: 10, top: 20, right: 11, bottom: 21 },
                width: 1,
                height: 1
              }
            })
      }
    ],
    execution: {
      mode: 'native-write',
      adapterVersion: 'synthetic-image-transport-1',
      supports: [command],
      rollback: host === 'figma' ? 'verified-in-place' : 'native-history',
      visualAudit: 'hash-only'
    }
  }
}
const errorResponse = (response: HttpResult, status: number, code: FigPluginBridgeErrorCode) => {
  expect(response.status).toBe(status)
  expect(JSON.parse(response.text)).toEqual({ code, message: FIGPLUGIN_BRIDGE_ERRORS[code] })
  expect(response.headers['cache-control']).toBe('no-store')
  expect(Buffer.byteLength(response.text)).toBeLessThan(1024)
  expect(response.text).not.toMatch(/bytesBase64|PRIVATE-|path|url|sessionToken/)
}
const fixture = async (transport: Transport, host: Host) => {
  const origin = await reserveOrigin()
  let clock = 1_800_000_000_000
  let allowed = true
  let writable = true
  let ownsWrite = true
  let valid = true
  let maxBytes = FIGPLUGIN_ASSET_MAX_BYTES
  const frames: Frame[] = []
  const protocolError = vi.fn()
  protocolErrors.push(protocolError)
  const audit = vi.fn()
  const reserve = vi.fn(() => true)
  const invoke = vi.fn<ConstructorParameters<typeof FigPluginBridgeRuntime>[0]['invoke']>()
  const runtime = new FigPluginBridgeRuntime({
    now: () => clock,
    validateBinding: async () => valid,
    allowAssetTransfer: () => allowed,
    allowNativeWrite: () => writable,
    assetByteLimit: () => maxBytes,
    writes: { reserve, owns: () => ownsWrite, release: vi.fn() },
    invoke,
    audit
  })
  cleanups.push(() => runtime.dispose())
  if (transport === 'development-http') {
    const server = await startFigPluginBridgeServer({ origin, runtime, requestTimeoutMs: 3000 })
    cleanups.push(() => server.close())
  } else {
    // Real loopback and MessageChannel RPC, not packaged Electron or native-host evidence.
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
    profileId: 'PRIVATE-PROVIDER-FIXTURE',
    profileRevision: 'e'.repeat(64)
  }
  const pair = async (value = binding) => {
    const ticket = await runtime.createPairing(value)
    const response = await http(origin, '/figplugin/v1/pair', {
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
  const publish = async (bytes: Buffer): Promise<FigPluginSessionAsset> =>
    runtime.publishSessionAsset(await runtime.beginSessionAssetSelection(target), {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes
    })
  const bytes = syntheticPng(1)
  const asset = await publish(bytes)
  const unselected = await publish(syntheticPng(2))
  const context = hostContext(host)
  const plan: HostPlan = {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: context.captureId,
    steps: [
      host === 'figma'
        ? {
            command: 'image.fill',
            targetId: '42',
            assetId: asset.assetId,
            sha256: asset.sha256,
            scaleMode: 'FIT'
          }
        : { command: 'image.pixels', targetId: '42', assetId: asset.assetId, sha256: asset.sha256 }
    ]
  }
  invoke.mockImplementation(async (_binding, preview, _signal, _correlation, dispatched, check) => {
    check()
    dispatched()
    return {
      content: JSON.stringify(
        createHostPlanningPreview(JSON.stringify(plan), context, preview.assetCatalog?.assets)
      )
    }
  })
  const send = (path: string, body: unknown, peer = session) =>
    http(origin, path, body, headersFor(peer))
  const prepare = async (sequence = 1) => {
    const request: FigPluginBridgePrepareRequest = {
      protocol: 1,
      requestId: `image-execution-${sequence}`,
      sequence,
      prompt: 'Use the selected synthetic image on the selected target.',
      context: {
        selectionRevision: context.captureId,
        nodes: context.nodes.map(({ id, type, name, locked }) => ({ id, type, name, locked }))
      },
      featureId: 'plan-preview',
      hostContext: context,
      assetReferences: [{ assetId: asset.assetId, sha256: asset.sha256 }]
    }
    const response = await send('/figplugin/v1/prepare', request)
    expect(response.status).toBe(200)
    return figPluginBridgePrepareResponseSchema.parse(JSON.parse(response.text))
  }
  const approveModel = async (sequence = 1) => {
    const receipt = await prepare(sequence)
    const preview = runtime.listPreviews().find((value) => value.callId === receipt.callId)!
    await runtime.approve(receipt.callId, preview.payloadSha256)
    await vi.waitFor(async () => {
      const response = await send('/figplugin/v1/status', { protocol: 1, callId: receipt.callId })
      expect(response.status).toBe(200)
      expect(figPluginBridgeStatusResponseSchema.parse(JSON.parse(response.text)).status).toBe(
        'completed'
      )
    })
    const execution = runtime.listPlanExecutions().find((value) => value.callId === receipt.callId)
    expect(execution).toBeDefined()
    return execution!
  }
  const claim = async (execution: FigPluginExecutionPreview) => {
    const response = await send('/figplugin/v1/plan/claim', {
      protocol: 1,
      callId: execution.callId,
      executionId: execution.executionId
    })
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    return figPluginExecutionClaimResponseSchema.parse(JSON.parse(response.text))
  }
  const ready = async () => {
    const execution = await approveModel()
    await runtime.approvePlan(execution.executionId, execution.planSha256)
    const claimed = await claim(execution)
    if (claimed.status !== 'ready') throw new Error('Missing image execution intent')
    return { execution, intent: claimed.intent }
  }
  return {
    runtime,
    origin,
    session,
    binding,
    target,
    pair,
    asset,
    unselected,
    bytes,
    context,
    plan,
    frames,
    invoke,
    audit,
    reserve,
    send,
    prepare,
    approveModel,
    claim,
    ready,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
    revoke: () =>
      runtime.revokeSessionAsset({ ...target, assetId: asset.assetId, sha256: asset.sha256 }),
    setAllowed: (value: boolean) => {
      allowed = value
    },
    setWritable: (value: boolean) => {
      writable = value
    },
    setOwnsWrite: (value: boolean) => {
      ownsWrite = value
    },
    setValid: (value: boolean) => {
      valid = value
    },
    setMaxBytes: (value: number) => {
      maxBytes = value
    }
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const readRequest = (f: Fixture, execution: FigPluginExecutionPreview, index = 0) => ({
  protocol: 1,
  purpose: 'host-plan-execution',
  callId: execution.callId,
  executionId: execution.executionId,
  actionId: execution.executionId,
  planSha256: execution.planSha256,
  assetId: f.asset.assetId,
  sha256: f.asset.sha256,
  index
})
const read = (f: Fixture, execution: FigPluginExecutionPreview, index = 0) =>
  f.send(FIGPLUGIN_EXECUTION_ASSET_READ_PATH, readRequest(f, execution, index))
const status = async (f: Fixture, execution: FigPluginExecutionPreview) => {
  const response = await f.send('/figplugin/v1/plan/status', {
    protocol: 1,
    callId: execution.callId,
    executionId: execution.executionId
  })
  expect(response.status).toBe(200)
  return figPluginExecutionStatusSchema.parse(JSON.parse(response.text))
}

describe.each([
  { transport: 'development-http', host: 'figma' },
  { transport: 'development-http', host: 'photoshop' },
  { transport: 'child-http-messagechannel-rpc', host: 'figma' },
  { transport: 'child-http-messagechannel-rpc', host: 'photoshop' }
] as const)('$host execution image reads over $transport', ({ transport, host }) => {
  it('requires separate desktop write approval and claim, then the shared client downloads exact bounded bytes', async () => {
    const f = await fixture(transport, host)
    const receipt = await f.prepare()
    expect(f.invoke).not.toHaveBeenCalled()
    expect(f.runtime.listPlanExecutions()).toEqual([])
    const modelPreview = f.runtime.listPreviews()[0]
    expect(modelPreview.assetCatalog?.assets).toEqual([planningAssetMetadata(f.asset)])
    await f.runtime.approve(receipt.callId, modelPreview.payloadSha256)
    await vi.waitFor(() => expect(f.runtime.listPlanExecutions()).toHaveLength(1))
    const execution = f.runtime.listPlanExecutions()[0]
    const descriptor = { ...f.asset, kind: 'execution-image-asset', purpose: 'host-plan-execution' }
    expect(execution).toMatchObject({
      state: 'awaiting-approval',
      requiresWriteApproval: true,
      risk: 'high',
      executionAssets: [descriptor],
      plan: f.plan,
      planSha256: createHash('sha256').update(canonicalFigPluginJson(f.plan)).digest('hex')
    })
    expect(execution.executionAssets).toEqual([descriptor])
    expect(await f.claim(execution)).toEqual({
      protocol: 1,
      status: 'pending',
      state: 'awaiting-approval'
    })
    errorResponse(await read(f, execution), 403, 'DENIED')
    expect(f.reserve).not.toHaveBeenCalled()
    for (const route of ['approve', 'approvePlan'])
      errorResponse(
        await f.send(`/figplugin/v1/plan/${route}`, { ...execution }),
        400,
        'INVALID_REQUEST'
      )
    errorResponse(
      await f.send('/figplugin/v1/plan/claim', {
        protocol: 1,
        callId: execution.callId,
        approved: true,
        executionAssets: [descriptor]
      }),
      400,
      'INVALID_REQUEST'
    )
    await f.runtime.approvePlan(execution.executionId, execution.planSha256)
    errorResponse(await read(f, execution), 403, 'DENIED')
    expect(f.reserve).not.toHaveBeenCalled()
    expect(f.frames.every((frame) => !frame.data.includes('bytesBase64'))).toBe(true)
    const claimed = await f.claim(execution)
    if (claimed.status !== 'ready') throw new Error('Missing image execution intent')
    expect(claimed.intent).toMatchObject({
      callId: execution.callId,
      executionId: execution.executionId,
      actionId: execution.executionId,
      pluginId: f.binding.pluginId,
      host,
      documentId: f.context.documentId,
      scopeId: f.context.scopeId,
      plan: f.plan,
      planSha256: execution.planSha256,
      executionAssets: [descriptor],
      expiresAt: execution.expiresAt
    })
    expect(claimed.intent.executionAssets).toEqual([descriptor])
    expect(await f.claim(execution)).toEqual(claimed)
    expect(f.reserve).toHaveBeenCalledOnce()
    expect(f.invoke).toHaveBeenCalledOnce()
    expect(f.asset.chunkCount).toBe(3)
    const chunks: string[] = []
    const downloaded = await readExecutionAsset(claimed.intent.executionAssets![0], {
      identity: { ...f.target, host },
      intent: claimed.intent,
      now: f.now,
      sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
      readChunk: async (request) => {
        const response = await f.send(FIGPLUGIN_EXECUTION_ASSET_READ_PATH, request)
        expect(response.status).toBe(200)
        expect(response.headers['cache-control']).toBe('no-store')
        const parsed = figPluginExecutionAssetChunkSchema.parse(JSON.parse(response.text))
        expect(Buffer.from(parsed.chunk.bytesBase64, 'base64')).toEqual(
          f.bytes.subarray(
            request.index * FIGPLUGIN_ASSET_CHUNK_BYTES,
            (request.index + 1) * FIGPLUGIN_ASSET_CHUNK_BYTES
          )
        )
        expect(parsed.chunk.bytesBase64.length).toBeLessThanOrEqual(32768)
        expect((await f.send(FIGPLUGIN_EXECUTION_ASSET_READ_PATH, request)).text).toBe(
          response.text
        )
        chunks.push(response.text)
        return parsed
      }
    })
    expect(Buffer.from(downloaded)).toEqual(f.bytes)
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(f.asset.sha256)
    expect(chunks).toHaveLength(3)
    expect(await status(f, execution)).toMatchObject({
      state: 'claimed',
      completed: 0,
      effect: 'none'
    })
    for (const serialized of [
      JSON.stringify(claimed),
      ...chunks,
      JSON.stringify(f.audit.mock.calls)
    ]) {
      expect(serialized).not.toMatch(/PRIVATE-|bytesPath|filePath|data:image|https?:|sessionToken/)
      expect(serialized).not.toContain(f.session.sessionToken)
    }
    expect(JSON.stringify(f.invoke.mock.calls[0][1])).not.toMatch(
      /bytesBase64|execution-image-asset/
    )
    if (transport === 'child-http-messagechannel-rpc') {
      expect(FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES).toBe(128 * 1024)
      const methods = f.frames
        .filter((frame) => frame.side === 'child')
        .map((frame) => JSON.parse(frame.data).method)
      expect(methods.filter((method) => method === 'planAssetChunk')).toHaveLength(8)
      expect(methods).not.toContain('assetChunk')
      expect(
        f.frames.some((frame) => frame.side === 'main' && Buffer.byteLength(frame.data) > 32 * 1024)
      ).toBe(true)
      for (const frame of f.frames) {
        expect(Buffer.byteLength(frame.data)).toBeLessThanOrEqual(
          FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES
        )
        expect(frame.data).not.toMatch(/PRIVATE-|assetCatalog|planning-asset-catalog|data:image/)
      }
    }
  })

  it('requires exact bearer/session credentials and refuses both same-plugin and foreign-project sessions', async () => {
    const f = await fixture(transport, host)
    const { execution } = await f.ready()
    const peer = await f.pair()
    const foreign = await f.pair({
      ...f.binding,
      pluginId: `foreign.${host}`,
      projectId: 'foreign-project'
    })
    const invalid: Record<string, string>[] = [
      {},
      { Authorization: `Bearer ${f.session.sessionToken}` },
      { 'X-FigPlugin-Session': f.session.sessionId },
      { ...headersFor(f.session), Authorization: `Bearer ${'0'.repeat(64)}` },
      { ...headersFor(f.session), Authorization: `Bearer ${peer.sessionToken}` },
      { ...headersFor(f.session), 'X-FigPlugin-Session': peer.sessionId },
      { ...headersFor(f.session), Authorization: `bearer ${f.session.sessionToken}` }
    ]
    for (const headers of invalid)
      errorResponse(
        await http(
          f.origin,
          FIGPLUGIN_EXECUTION_ASSET_READ_PATH,
          readRequest(f, execution),
          headers
        ),
        401,
        'UNAUTHORIZED'
      )
    for (const session of [peer, foreign])
      errorResponse(
        await f.send(FIGPLUGIN_EXECUTION_ASSET_READ_PATH, readRequest(f, execution), session),
        401,
        'UNAUTHORIZED'
      )
    expect((await read(f, execution)).status).toBe(200)
  })

  it('rejects purpose confusion, invented authority, malformed ids and indexes without reflecting input', async () => {
    const f = await fixture(transport, host)
    const { execution } = await f.ready()
    for (const patch of [
      { protocol: 2 },
      { purpose: 'local-preview' },
      { purpose: 'model-planning-metadata' },
      { purpose: undefined },
      { executionId: undefined },
      { actionId: 'x'.repeat(32) },
      { planSha256: undefined },
      { sha256: 'a'.repeat(63) },
      { index: -1 },
      { index: 0.5 },
      { index: '0' },
      { index: 1000000 },
      { path: 'C:\\PRIVATE-IMAGE\\input.png' },
      { url: 'https://example.invalid/PRIVATE-IMAGE.png' },
      { bytesBase64: 'UFJJVkFURS1CWVRFUw==' },
      { sessionId: f.session.sessionId },
      { projectId: f.binding.projectId },
      { executionAssets: [f.asset] },
      { approved: true },
      { correlationId: 'a'.repeat(32) }
    ])
      errorResponse(
        await f.send(FIGPLUGIN_EXECUTION_ASSET_READ_PATH, {
          ...readRequest(f, execution),
          ...patch
        }),
        400,
        'INVALID_REQUEST'
      )
    for (const raw of ['null', '[]', '{', 'true', '"PRIVATE-IMAGE"'])
      errorResponse(
        await http(
          f.origin,
          FIGPLUGIN_EXECUTION_ASSET_READ_PATH,
          undefined,
          headersFor(f.session),
          { raw }
        ),
        400,
        'INVALID_REQUEST'
      )
    errorResponse(
      await f.send(FIGPLUGIN_ASSET_READ_PATH, readRequest(f, execution)),
      400,
      'INVALID_REQUEST'
    )
    expect((await read(f, execution)).status).toBe(200)
    expect(await status(f, execution)).toMatchObject({ state: 'claimed', effect: 'none' })
  })

  it('binds each read to the claimed call, execution, action, plan, selected asset and exact chunk', async () => {
    const f = await fixture(transport, host)
    const { execution } = await f.ready()
    const other = await f.approveModel(2)
    for (const [patch, code, httpStatus] of [
      [{ callId: '0'.repeat(32) }, 'UNAUTHORIZED', 401],
      [{ callId: other.callId }, 'DENIED', 403],
      [{ executionId: '0'.repeat(32) }, 'EXPIRED', 410],
      [{ executionId: other.executionId }, 'DENIED', 403],
      [{ actionId: '0'.repeat(32) }, 'DENIED', 403],
      [{ planSha256: '0'.repeat(64) }, 'DENIED', 403],
      [{ sha256: '0'.repeat(64) }, 'INVALID_REQUEST', 400],
      [{ assetId: f.unselected.assetId, sha256: f.unselected.sha256 }, 'INVALID_REQUEST', 400],
      [{ index: f.asset.chunkCount }, 'INVALID_REQUEST', 400]
    ] as const)
      errorResponse(
        await f.send(FIGPLUGIN_EXECUTION_ASSET_READ_PATH, {
          ...readRequest(f, execution),
          ...patch
        }),
        httpStatus,
        code
      )
    expect((await read(f, execution, 2)).status).toBe(200)
    expect(await status(f, execution)).toMatchObject({ state: 'claimed' })
    expect(await status(f, other)).toMatchObject({ state: 'awaiting-approval' })
  })

  it.each(['status', 'cancel', 'close'] as const)(
    'validates the complete %s request before it can observe or end an image claim',
    async (route) => {
      const f = await fixture(transport, host)
      const { execution } = await f.ready()
      const body = route === 'close' ? { protocol: 1 } : { protocol: 1, callId: execution.callId }
      for (const invalid of [
        { ...body, protocol: 2 },
        { ...body, protocol: undefined },
        { ...body, path: 'C:\\PRIVATE-IMAGE\\input.png' }
      ]) {
        errorResponse(await f.send(`/figplugin/v1/${route}`, invalid), 400, 'INVALID_REQUEST')
        expect((await read(f, execution)).status).toBe(200)
        expect(await status(f, execution)).toMatchObject({ state: 'claimed' })
      }
    }
  )

  it('enforces opaque-origin CORS, exact route/method and the 4096-byte request cap for fixed and chunked bodies', async () => {
    const f = await fixture(transport, host)
    const { execution } = await f.ready()
    const body = readRequest(f, execution)
    const opaque = { ...headersFor(f.session), Origin: 'null' }
    const good = await http(f.origin, FIGPLUGIN_EXECUTION_ASSET_READ_PATH, body, opaque)
    expect(good.status).toBe(200)
    expect(good.headers['access-control-allow-origin']).toBe('*')
    expect(good.headers['access-control-allow-credentials']).toBeUndefined()
    expect(good.headers.vary).toBe('Origin')
    const preflight = await http(
      f.origin,
      FIGPLUGIN_EXECUTION_ASSET_READ_PATH,
      undefined,
      {
        Origin: 'null',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization,x-figplugin-session'
      },
      { method: 'OPTIONS' }
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-origin']).toBe('*')
    expect(preflight.headers['access-control-allow-methods']).toBe('POST')
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined()
    const forbiddenOrigin = await http(f.origin, FIGPLUGIN_EXECUTION_ASSET_READ_PATH, body, {
      ...headersFor(f.session),
      Origin: 'https://example.invalid'
    })
    errorResponse(forbiddenOrigin, 403, 'DENIED')
    expect(forbiddenOrigin.headers['access-control-allow-origin']).toBeUndefined()
    errorResponse(
      await http(
        f.origin,
        FIGPLUGIN_EXECUTION_ASSET_READ_PATH,
        undefined,
        {
          Origin: 'null',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'cookie'
        },
        { method: 'OPTIONS' }
      ),
      400,
      'INVALID_REQUEST'
    )
    for (const path of [
      `${FIGPLUGIN_EXECUTION_ASSET_READ_PATH}?index=0`,
      `${FIGPLUGIN_EXECUTION_ASSET_READ_PATH}/`,
      '/figplugin/v1/plan/assets/list',
      '/figplugin/v1/plan/assets/write',
      '/figplugin/v1/plan/assets/revoke'
    ])
      errorResponse(await f.send(path, body), 400, 'INVALID_REQUEST')
    errorResponse(
      await http(f.origin, FIGPLUGIN_EXECUTION_ASSET_READ_PATH, body, headersFor(f.session), {
        method: 'GET'
      }),
      400,
      'INVALID_REQUEST'
    )
    const framingHeaders: Record<string, string>[] = [
      { Cookie: 'PRIVATE-CREDENTIAL' },
      { 'Content-Type': 'text/plain' },
      { Host: 'localhost:1' }
    ]
    for (const extra of framingHeaders)
      errorResponse(
        await http(f.origin, FIGPLUGIN_EXECUTION_ASSET_READ_PATH, body, {
          ...headersFor(f.session),
          ...extra
        }),
        400,
        'INVALID_REQUEST'
      )
    const raw = JSON.stringify(body)
    for (const chunked of [false, true]) {
      expect(
        (
          await http(f.origin, FIGPLUGIN_EXECUTION_ASSET_READ_PATH, undefined, opaque, {
            raw: raw.padEnd(4096, ' '),
            chunked
          })
        ).status
      ).toBe(200)
      errorResponse(
        await http(f.origin, FIGPLUGIN_EXECUTION_ASSET_READ_PATH, undefined, opaque, {
          raw: raw.padEnd(4097, ' '),
          chunked
        }),
        400,
        'INVALID_REQUEST'
      )
    }
  })

  it.each(['denied', 'cancelled', 'failed', 'completed'] as const)(
    'refuses further chunks after the execution becomes %s, including simulated host terminal receipts',
    async (ending) => {
      const f = await fixture(transport, host)
      const { execution, intent } = await f.ready()
      expect((await read(f, execution)).status).toBe(200)
      if (ending === 'denied') f.runtime.denyPlan(execution.executionId)
      else if (ending === 'cancelled') {
        expect(
          (await f.send('/figplugin/v1/cancel', { protocol: 1, callId: execution.callId })).status
        ).toBe(204)
      } else {
        const completed = ending === 'completed'
        const response = await f.send('/figplugin/v1/plan/result', {
          protocol: 1,
          executionId: intent.executionId,
          actionId: intent.actionId,
          status: ending,
          effect: completed ? 'applied' : 'none',
          completed: completed ? 1 : 0,
          total: 1,
          readback: {
            version: 1,
            kind: 'host-plan-readback',
            host,
            documentId: f.context.documentId,
            scopeId: f.context.scopeId,
            captureId: f.context.captureId,
            steps: [
              {
                command: f.plan.steps[0].command,
                targetId: '42',
                observation: completed ? 'requested' : 'unknown',
                ...(completed
                  ? {
                      value: stepValue(f.plan.steps[0]),
                      imageEvidence:
                        host === 'figma'
                          ? {
                              kind: 'figma-image-fill',
                              sourceSha256: f.asset.sha256,
                              nativeImageHash: 'synthetic-native-hash',
                              fillsSha256: '7'.repeat(64)
                            }
                          : {
                              kind: 'photoshop-pixels',
                              sourceSha256: f.asset.sha256,
                              pixelSha256: '7'.repeat(64),
                              width: 1,
                              height: 1,
                              bounds: { left: 10, top: 20, right: 11, bottom: 21 }
                            }
                    }
                  : {})
              }
            ]
          },
          ...(completed
            ? {
                visualEvidence: [
                  {
                    targetId: '42',
                    before: { sha256: '8'.repeat(64), width: 1, height: 1 },
                    after: { sha256: '9'.repeat(64), width: 1, height: 1 },
                    changed: true
                  }
                ]
              }
            : { errorCode: 'EXECUTION_FAILED' })
        })
        expect(response.status).toBe(200)
        expect(
          figPluginExecutionResultResponseSchema.parse(JSON.parse(response.text)).status.state
        ).toBe(ending)
      }
      errorResponse(await read(f, execution, 1), 403, 'DENIED')
      expect(await f.claim(execution)).toMatchObject({ status: 'terminal', state: ending })
      expect(await status(f, execution)).toMatchObject({ state: ending })
    }
  )

  it.each([
    'source-revoke',
    'asset-capability',
    'write-capability',
    'byte-ceiling',
    'write-owner',
    'binding',
    'session-close'
  ] as const)('revalidates %s between chunks without reviving a previous claim', async (change) => {
    const f = await fixture(transport, host)
    const { execution } = await f.ready()
    expect((await read(f, execution)).status).toBe(200)
    let expected: [number, FigPluginBridgeErrorCode] = [403, 'DENIED']
    if (change === 'source-revoke') await f.revoke()
    if (change === 'asset-capability') f.setAllowed(false)
    if (change === 'write-capability') f.setWritable(false)
    if (change === 'byte-ceiling') {
      f.setMaxBytes(f.asset.sizeBytes - 1)
      expected = [410, 'EXPIRED']
    }
    if (change === 'write-owner') f.setOwnsWrite(false)
    if (change === 'binding') {
      f.setValid(false)
      expected = [409, 'CONFIGURATION_CHANGED']
    }
    if (change === 'session-close') {
      expect((await f.send('/figplugin/v1/close', { protocol: 1 })).status).toBe(204)
      expected = [401, 'UNAUTHORIZED']
    }
    errorResponse(await read(f, execution, 1), ...expected)
    f.setAllowed(true)
    f.setWritable(true)
    f.setMaxBytes(FIGPLUGIN_ASSET_MAX_BYTES)
    f.setOwnsWrite(true)
    f.setValid(true)
    errorResponse(
      await read(f, execution, 1),
      change === 'binding' || change === 'session-close' ? 401 : 403,
      change === 'binding' || change === 'session-close' ? 'UNAUTHORIZED' : 'DENIED'
    )
    expect(f.invoke).toHaveBeenCalledOnce()
  })

  it('expires the source-bound intent at the original lease boundary despite authenticated retries', async () => {
    const f = await fixture(transport, host)
    f.advance(10000)
    const { execution, intent } = await f.ready()
    expect(intent.expiresAt).toBe(f.asset.expiresAt)
    expect(intent.expiresAt - f.asset.createdAt).toBe(FIGPLUGIN_ASSET_TTL_MS)
    f.advance(f.asset.expiresAt - f.now() - 1)
    expect((await read(f, execution)).status).toBe(200)
    expect((await read(f, execution)).status).toBe(200)
    f.advance(1)
    errorResponse(await read(f, execution, 1), 410, 'EXPIRED')
    expect(f.runtime.listSessions()).toHaveLength(1)
    expect(f.invoke).toHaveBeenCalledOnce()
    expect(f.runtime.listPlanExecutions()).toEqual([])
  })
})
