import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  figPluginBridgePrepareResponseSchema,
  figPluginBridgeStatusResponseSchema,
  figPluginPairResponseSchema,
  type FigPluginBridgePrepareRequest,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import { type HostContextImage } from '@shared/figplugin/hostContextImage'
import { startFigPluginBridgeChildHttpServer } from './bridgeChildHttp'
import {
  createFigPluginBridgeChildRpcClient,
  createFigPluginBridgeChildRpcEndpoint,
  createFigPluginBridgeChildRuntimeHandler
} from './bridgeChildRpc'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { startFigPluginBridgeServer } from './bridgeServer'

type Host = FigPluginRuntimeBinding['host']
const image = (host: Host): HostContextImage => ({
  version: 1,
  kind: 'host-context-image',
  captureId: 'a'.repeat(32),
  targetId: host === 'figma' ? '1:2' : '42',
  mimeType: 'image/png',
  width: 1,
  height: 1,
  sizeBytes: 70,
  sha256: 'abc58d5127d7cdf313beb9ec8ee839860a9c6bfbc48c8b8eb6a3f7d8bb63de6f',
  bytesBase64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='
})
const request = (host: Host): FigPluginBridgePrepareRequest => {
  const targetId = image(host).targetId
  const type = host === 'figma' ? 'RECTANGLE' : 'pixel'
  const scopeId = host === 'figma' ? 'page' : '7'
  return {
    protocol: 1,
    requestId: 'image-over-http',
    sequence: 1,
    prompt: 'Describe the selected object',
    context: {
      selectionRevision: 'a'.repeat(32),
      nodes: [{ id: targetId, type, name: 'Owned', locked: false }]
    },
    featureId: 'plan-preview',
    hostContext: {
      version: 1,
      host,
      documentId: host === 'figma' ? 'document' : '7',
      scopeId,
      captureId: 'a'.repeat(32),
      selectedIds: [targetId],
      nodes: [
        {
          id: targetId,
          type,
          name: 'Owned',
          parentId: scopeId,
          ancestors: [],
          locked: false,
          visible: true,
          commands: ['node.rename']
        }
      ]
    },
    contextImage: image(host)
  }
}
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const reserveOrigin = async (): Promise<string> => {
  const holder = createServer()
  holder.listen({ host: '127.0.0.1', port: 0 })
  await once(holder, 'listening')
  const address = holder.address()
  if (!address || typeof address === 'string') throw new Error('Invalid fixture address')
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
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const outgoing = httpRequest(
      origin,
      {
        path,
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
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () =>
          resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    outgoing.on('error', reject)
    outgoing.setTimeout(4_000, () => outgoing.destroy(new Error('Fixture request timed out')))
    outgoing.end(data)
  })

const fixture = async (transport: 'development-http' | 'child-http-rpc', host: Host) => {
  const origin = await reserveOrigin()
  const invoke = vi
    .fn<ConstructorParameters<typeof FigPluginBridgeRuntime>[0]['invoke']>()
    .mockResolvedValue({ content: 'Bounded planning result' })
  const runtime = new FigPluginBridgeRuntime({ validateBinding: async () => true, invoke })
  cleanups.push(() => runtime.dispose())
  if (transport === 'development-http') {
    const server = await startFigPluginBridgeServer({ origin, runtime })
    cleanups.push(() => server.close())
  } else {
    // Real MessagePorts exercise wire serialization, not Electron process supervision.
    const { port1, port2 } = new MessageChannel()
    const nonce = 'b'.repeat(32)
    const endpoint = createFigPluginBridgeChildRpcEndpoint({
      port: port1,
      nonce,
      handle: createFigPluginBridgeChildRuntimeHandler(runtime)
    })
    const rpc = createFigPluginBridgeChildRpcClient({ port: port2, nonce })
    cleanups.push(() => {
      endpoint.close()
      rpc.close()
      port1.close()
      port2.close()
    })
    const server = await startFigPluginBridgeChildHttpServer({ origin, rpc })
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
    profileId: 'vision',
    profileRevision: 'e'.repeat(64)
  }
  const ticket = await runtime.createPairing(binding)
  const paired = await post(origin, '/figplugin/v1/pair', {
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: ticket.pluginId,
    host: ticket.host,
    artifactSha256: ticket.artifactSha256,
    clientNonce: 'f'.repeat(32)
  })
  expect(paired.status).toBe(200)
  const session = figPluginPairResponseSchema.parse(JSON.parse(paired.text))
  const send = (path: string, body: unknown) =>
    post(origin, `/figplugin/v1/${path}`, body, {
      Authorization: `Bearer ${session.sessionToken}`,
      'X-FigPlugin-Session': session.sessionId
    })
  return { runtime, invoke, send }
}

describe.each([
  { transport: 'development-http', host: 'figma' },
  { transport: 'development-http', host: 'photoshop' },
  { transport: 'child-http-rpc', host: 'figma' },
  { transport: 'child-http-rpc', host: 'photoshop' }
] as const)('$host context image across $transport', ({ transport, host }) => {
  it('preserves approved PNG bytes end to end without echoing them in HTTP results', async () => {
    const f = await fixture(transport, host)
    const prepared = await f.send('prepare', request(host))
    expect(prepared.status).toBe(200)
    expect(prepared.text).not.toContain(image(host).bytesBase64)
    const receipt = figPluginBridgePrepareResponseSchema.parse(JSON.parse(prepared.text))
    expect(receipt.status).toBe('awaiting-approval')
    expect(f.invoke).not.toHaveBeenCalled()
    const pending = f.runtime.listPreviews()[0]
    expect(pending.contextImage).toEqual(image(host))
    await f.runtime.approve(receipt.callId, pending.payloadSha256)
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledOnce())
    expect(f.invoke.mock.calls[0][1].contextImage).toEqual(image(host))
    expect(f.invoke.mock.calls[0][0].host).toBe(host)
    await vi.waitFor(async () => {
      const response = await f.send('status', { protocol: 1, callId: receipt.callId })
      expect(response.status).toBe(200)
      expect(figPluginBridgeStatusResponseSchema.parse(JSON.parse(response.text))).toMatchObject({
        status: 'completed'
      })
      expect(response.text).not.toContain(image(host).bytesBase64)
      expect(response.text).not.toContain('contextImage')
    })
    expect(f.runtime.listPreviews()).toEqual([])
  })

  it('rejects altered image scope, hash and external sources before retaining or dispatching', async () => {
    const f = await fixture(transport, host)
    for (const invalidImage of [
      { ...image(host), sha256: '0'.repeat(64) },
      { ...image(host), captureId: '0'.repeat(32) },
      { ...image(host), targetId: 'outside' },
      { ...image(host), url: 'https://example.invalid/private.png' }
    ]) {
      const response = await f.send('prepare', { ...request(host), contextImage: invalidImage })
      expect(response.status).toBe(400)
      expect(JSON.parse(response.text)).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(f.runtime.listPreviews()).toEqual([])
      expect(f.invoke).not.toHaveBeenCalled()
      expect(response.text).not.toContain(image(host).bytesBase64)
    }
    expect((await f.send('prepare', request(host))).status).toBe(200)
  })

  it('keeps the paired host binding across the transport even when the other host request is valid', async () => {
    const f = await fixture(transport, host)
    const response = await f.send('prepare', request(host === 'figma' ? 'photoshop' : 'figma'))
    expect(response.status).toBe(400)
    expect(JSON.parse(response.text)).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.runtime.listPreviews()).toEqual([])
    expect(f.invoke).not.toHaveBeenCalled()
    expect((await f.send('prepare', request(host))).status).toBe(200)
  })

  it('drops image authority when cancellation arrives through the same transport', async () => {
    const f = await fixture(transport, host)
    const prepared = await f.send('prepare', request(host))
    expect(prepared.status).toBe(200)
    const receipt = figPluginBridgePrepareResponseSchema.parse(JSON.parse(prepared.text))
    const pending = f.runtime.listPreviews()[0]
    expect((await f.send('cancel', { protocol: 1, callId: receipt.callId })).status).toBe(204)
    expect(f.runtime.listPreviews()).toEqual([])
    await expect(f.runtime.approve(receipt.callId, pending.payloadSha256)).rejects.toBeDefined()
    expect(f.invoke).not.toHaveBeenCalled()
  })
})
