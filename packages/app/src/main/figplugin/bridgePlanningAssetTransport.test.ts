import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  figPluginBridgePrepareResponseSchema,
  figPluginBridgeStatusResponseSchema,
  figPluginPairResponseSchema,
  type FigPluginBridgePrepareRequest,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import { FIGPLUGIN_ASSET_TTL_MS, type FigPluginSessionAsset } from '@shared/figplugin/hostAssets'
import { planningAssetMetadata } from '@shared/figplugin/hostPlanningAssets'
import { encodeContextPng } from '@shared/figplugin/pixelAuditRuntime'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { startFigPluginBridgeServer } from './bridgeServer'
import { startFigPluginBridgeChildHttpServer } from './bridgeChildHttp'
import {
  createFigPluginBridgeChildRpcClient,
  createFigPluginBridgeChildRpcEndpoint,
  createFigPluginBridgeChildRuntimeHandler,
  type FigPluginBridgeChildRpcPort
} from './bridgeChildRpc'
import { FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES } from './bridgeChildWire'

type Host = FigPluginRuntimeBinding['host']
type Transport = 'in-process-loopback' | 'child-http-messagechannel-rpc'
type HttpResult = { status: number; text: string; cacheControl?: string }
type Frame = { side: 'main' | 'child'; data: string }
type Options = ConstructorParameters<typeof FigPluginBridgeRuntime>[0]
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const reference = (asset: FigPluginSessionAsset) => ({
  assetId: asset.assetId,
  sha256: asset.sha256
})
const reserveOrigin = async () => {
  const holder = createServer()
  holder.listen({ host: '127.0.0.1', port: 0 })
  await once(holder, 'listening')
  const address = holder.address()
  if (!address || typeof address === 'string') throw new Error('Invalid loopback fixture address')
  await new Promise<void>((resolve, reject) =>
    holder.close((error) => (error ? reject(error) : resolve()))
  )
  return `http://127.0.0.1:${address.port}`
}
const post = (
  origin: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const outgoing = httpRequest(
      origin,
      {
        path: `/figplugin/v1/${path}`,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            text: Buffer.concat(chunks).toString('utf8'),
            cacheControl: response.headers['cache-control']
          })
        )
      }
    )
    outgoing.on('error', reject)
    outgoing.setTimeout(4000, () =>
      outgoing.destroy(new Error('Planning asset fixture HTTP timeout'))
    )
    outgoing.end(data)
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
const request = (host: Host): FigPluginBridgePrepareRequest => {
  const id = host === 'figma' ? '1:2' : '42'
  const type = host === 'figma' ? 'RECTANGLE' : 'pixel'
  const scope = host === 'figma' ? 'page' : '7'
  return {
    protocol: 1,
    requestId: 'selected-metadata-over-wire',
    sequence: 1,
    prompt: 'Plan a rename using only selected metadata',
    context: {
      selectionRevision: 'a'.repeat(32),
      nodes: [{ id, type, name: 'Owned fixture', locked: false }]
    },
    featureId: 'plan-preview',
    hostContext: {
      version: 1,
      host,
      documentId: host === 'figma' ? 'doc' : '7',
      scopeId: scope,
      captureId: 'a'.repeat(32),
      selectedIds: [id],
      nodes: [
        {
          id,
          type,
          name: 'Owned fixture',
          parentId: scope,
          ancestors: [],
          locked: false,
          visible: true,
          commands: ['node.rename']
        }
      ]
    }
  }
}
const fixture = async (transport: Transport, host: Host) => {
  const origin = await reserveOrigin()
  let clock = 1_800_000_000_000
  let allowed = true
  let maxBytes = 65536
  const frames: Frame[] = []
  const protocolError = vi.fn()
  const audit = vi.fn()
  const nativeWrite = vi.fn(() => false)
  const reserveWrite = vi.fn(() => true)
  const invoke = vi
    .fn<Options['invoke']>()
    .mockImplementation(async (_b, _p, _s, _c, dispatched, check) => {
      check()
      dispatched()
      return { content: 'Owned response without asset metadata' }
    })
  const runtime = new FigPluginBridgeRuntime({
    now: () => clock,
    validateBinding: async () => true,
    allowAssetTransfer: () => allowed,
    assetByteLimit: () => maxBytes,
    invoke,
    audit,
    allowNativeWrite: nativeWrite,
    writes: { reserve: reserveWrite, owns: () => true, release: () => undefined }
  })
  cleanups.push(() => {
    runtime.dispose()
    expect(protocolError).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    expect(nativeWrite).not.toHaveBeenCalled()
    expect(reserveWrite).not.toHaveBeenCalled()
  })
  if (transport === 'in-process-loopback') {
    const server = await startFigPluginBridgeServer({ origin, runtime, requestTimeoutMs: 3000 })
    cleanups.push(() => server.close())
  } else {
    // Actual HTTP and MessagePorts, without claiming Electron child-process supervision evidence.
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
    profileId: 'synthetic-nonvision',
    profileRevision: 'e'.repeat(64)
  }
  const pair = async (value = binding) => {
    const ticket = await runtime.createPairing(value)
    const response = await post(origin, 'pair', {
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
  const publish = async (red: number) => {
    const bytes = encodeContextPng(1, 1, new Uint8Array([red, 0, 0, 255]), 4)
    if (!bytes) throw new Error('Synthetic pixel fixture failed')
    return runtime.publishSessionAsset(await runtime.beginSessionAssetSelection(target), {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes
    })
  }
  const first = await publish(1)
  const second = await publish(2)
  const send = (path: string, body: unknown, peer = session) =>
    post(origin, path, body, {
      Authorization: `Bearer ${peer.sessionToken}`,
      'X-FigPlugin-Session': peer.sessionId
    })
  const prepare = (
    input: unknown = { ...request(host), assetReferences: [reference(second), reference(first)] }
  ) => send('prepare', input)
  const status = async (callId: string) => {
    const response = await send('status', { protocol: 1, callId })
    expect(response.status).toBe(200)
    expect(response.cacheControl).toBe('no-store')
    return figPluginBridgeStatusResponseSchema.parse(JSON.parse(response.text))
  }
  const revoke = (asset: FigPluginSessionAsset) =>
    runtime.revokeSessionAsset({ ...target, ...reference(asset) })
  return {
    runtime,
    invoke,
    binding,
    pair,
    session,
    target,
    first,
    second,
    prepare,
    send,
    status,
    revoke,
    frames,
    advance: (ms: number) => {
      clock += ms
    },
    setAllowed: (value: boolean) => {
      allowed = value
    },
    setMaxBytes: (value: number) => {
      maxBytes = value
    }
  }
}
const receiptFrom = (response: HttpResult) => {
  expect(response.status).toBe(200)
  expect(response.cacheControl).toBe('no-store')
  expect(response.text).not.toContain('assetCatalog')
  expect(response.text).not.toContain('assetReferences')
  return figPluginBridgePrepareResponseSchema.parse(JSON.parse(response.text))
}

describe.each([
  { transport: 'in-process-loopback', host: 'figma' },
  { transport: 'in-process-loopback', host: 'photoshop' },
  { transport: 'child-http-messagechannel-rpc', host: 'figma' },
  { transport: 'child-http-messagechannel-rpc', host: 'photoshop' }
] as const)('$host metadata planning over $transport', ({ transport, host }) => {
  it('preserves exact selected references while main alone expands the metadata after native approval', async () => {
    const f = await fixture(transport, host)
    const receipt = receiptFrom(await f.prepare())
    expect(f.invoke).not.toHaveBeenCalled()
    const preview = f.runtime.listPreviews()[0]
    expect(preview.assetReferences).toEqual([reference(f.second), reference(f.first)])
    expect(preview.assetCatalog).toEqual({
      version: 1,
      kind: 'planning-asset-catalog',
      purpose: 'model-planning-metadata',
      ...f.target,
      host,
      assets: [planningAssetMetadata(f.second), planningAssetMetadata(f.first)]
    })
    await f.runtime.approve(receipt.callId, preview.payloadSha256)
    await vi.waitFor(async () =>
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'completed' })
    )
    expect(f.invoke).toHaveBeenCalledOnce()
    expect(f.invoke.mock.calls[0][1].assetCatalog).toEqual(preview.assetCatalog)
    expect(f.runtime.listPlanExecutions()).toEqual([])
    if (transport === 'child-http-messagechannel-rpc') {
      expect(f.frames.length).toBeGreaterThan(0)
      expect(f.frames.some((frame) => frame.data.includes('assetReferences'))).toBe(true)
      for (const frame of f.frames) {
        expect(Buffer.byteLength(frame.data)).toBeLessThanOrEqual(
          FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES
        )
        for (const forbidden of [
          'bytesBase64',
          'assetCatalog',
          'planning-asset-catalog',
          'data:image',
          'assets.read'
        ])
          expect(frame.data).not.toContain(forbidden)
      }
    }
  })

  it('leaves available local-preview assets out of both preview and invocation by default', async () => {
    const f = await fixture(transport, host)
    const receipt = receiptFrom(await f.prepare(request(host)))
    const preview = f.runtime.listPreviews()[0]
    expect(preview).not.toHaveProperty('assetCatalog')
    expect(preview).not.toHaveProperty('assetReferences')
    await f.runtime.approve(receipt.callId, preview.payloadSha256)
    await vi.waitFor(async () =>
      expect(await f.status(receipt.callId)).toMatchObject({ status: 'completed' })
    )
    expect(f.invoke.mock.calls[0][1]).not.toHaveProperty('assetCatalog')
  })

  it('rejects forged, duplicated, cross-host and caller-authored catalogs over the real transport', async () => {
    const f = await fixture(transport, host)
    const base = { ...request(host), assetReferences: [reference(f.first)] }
    for (const invalid of [
      { ...base, assetReferences: [{ ...reference(f.first), sha256: '0'.repeat(64) }] },
      { ...base, assetReferences: [reference(f.first), reference(f.first)] },
      { ...base, assetReferences: [{ ...reference(f.first), path: 'C:\\private\\input.png' }] },
      {
        ...base,
        assetReferences: [{ ...reference(f.first), url: 'https://example.invalid/private.png' }]
      },
      { ...base, assetCatalog: { assets: [planningAssetMetadata(f.first)] } },
      { ...base, featureId: undefined, hostContext: undefined },
      { ...base, ...request(host === 'figma' ? 'photoshop' : 'figma') }
    ]) {
      const response = await f.prepare(invalid)
      expect(response.status).toBe(400)
      expect(JSON.parse(response.text)).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(response.cacheControl).toBe('no-store')
      expect(response.text).not.toContain(f.first.assetId)
      expect(f.runtime.listPreviews()).toEqual([])
      expect(f.invoke).not.toHaveBeenCalled()
    }
    receiptFrom(await f.prepare(base))
  })

  it('does not authorize a foreign session even when its reference hash is valid', async () => {
    const f = await fixture(transport, host)
    const peer = await f.pair()
    const response = await f.send(
      'prepare',
      {
        ...request(host),
        assetReferences: [reference(f.first)]
      },
      peer
    )
    expect(response.status).toBe(410)
    expect(JSON.parse(response.text)).toMatchObject({ code: 'EXPIRED' })
    expect(f.invoke).not.toHaveBeenCalled()
    expect(f.runtime.listPreviews()).toEqual([])
    receiptFrom(await f.prepare())
  })

  it('distinguishes unselected revocation from selected revocation before approval', async () => {
    const f = await fixture(transport, host)
    const receipt = receiptFrom(
      await f.prepare({ ...request(host), assetReferences: [reference(f.first)] })
    )
    const preview = f.runtime.listPreviews()[0]
    await f.revoke(f.second)
    expect(await f.status(receipt.callId)).toMatchObject({ status: 'awaiting-approval' })
    await f.revoke(f.first)
    expect(await f.status(receipt.callId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'CANCELLED'
    })
    await expect(f.runtime.approve(receipt.callId, preview.payloadSha256)).rejects.toBeDefined()
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('discards late in-flight metadata results after selected source revocation', async () => {
    const f = await fixture(transport, host)
    const late = deferred<{ content: string }>()
    f.invoke.mockImplementation(async (_b, _p, _s, _c, dispatched, check) => {
      check()
      dispatched()
      return late.promise
    })
    const receipt = receiptFrom(await f.prepare())
    await f.runtime.approve(receipt.callId, f.runtime.listPreviews()[0].payloadSha256)
    expect(f.invoke).toHaveBeenCalledOnce()
    await f.revoke(f.first)
    expect(f.invoke.mock.calls[0][2].aborted).toBe(true)
    const terminal = await f.status(receipt.callId)
    expect(terminal).toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' })
    late.resolve({ content: 'PRIVATE-LATE-RESULT' })
    await vi.waitFor(async () => expect(await f.status(receipt.callId)).toEqual(terminal))
    expect(f.runtime.listPreviews()).toEqual([])
    expect(f.runtime.listPlanExecutions()).toEqual([])
    expect(f.frames.some((frame) => frame.data.includes('PRIVATE-LATE-RESULT'))).toBe(false)
  })

  it('expires source metadata independently from the freshly renewed bearer session', async () => {
    const f = await fixture(transport, host)
    f.advance(FIGPLUGIN_ASSET_TTL_MS - 10)
    const receipt = receiptFrom(await f.prepare())
    expect(receipt.expiresAt).toBe(f.first.expiresAt)
    f.advance(10)
    expect(await f.status(receipt.callId)).toMatchObject({ status: 'failed', errorCode: 'EXPIRED' })
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it.each(['capability-drop', 'budget-drop'] as const)(
    'rechecks %s at the final dispatch boundary',
    async (change) => {
      const f = await fixture(transport, host)
      const gate = deferred<void>()
      const provider = vi.fn()
      f.invoke.mockImplementation(async (_b, _p, _s, _c, dispatched, check) => {
        await gate.promise
        check()
        provider()
        dispatched()
        return { content: 'Unapproved dispatch' }
      })
      const receipt = receiptFrom(await f.prepare())
      await f.runtime.approve(receipt.callId, f.runtime.listPreviews()[0].payloadSha256)
      if (change === 'capability-drop') f.setAllowed(false)
      else f.setMaxBytes(f.first.sizeBytes - 1)
      gate.resolve()
      await vi.waitFor(async () => expect((await f.status(receipt.callId)).status).toBe('failed'))
      expect(provider).not.toHaveBeenCalled()
      expect(f.runtime.listPreviews()).toEqual([])
    }
  )
})
