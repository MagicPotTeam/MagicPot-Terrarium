import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import {
  FigPluginBridgeError,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_MAX_EDGE,
  FIGPLUGIN_ASSET_MAX_PER_SESSION,
  FIGPLUGIN_ASSET_MAX_TOTAL,
  FIGPLUGIN_ASSET_MAX_TOTAL_BYTES,
  FIGPLUGIN_ASSET_TTL_MS,
  figPluginAssetChunkSchema,
  figPluginAssetListSchema,
  figPluginSessionAssetSchema,
  type FigPluginAssetMime,
  type FigPluginDesktopAssetTarget,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import { assembleBinaryChunks, type BinaryChunkFrame } from '@shared/binaryChunkProtocol'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { FigPluginBridgeController } from './bridgeController'
import type { FigPluginRuntimeDescriptor } from './centerStore'
import type { startFigPluginBridgeServer } from './bridgeServer'

type Options = ConstructorParameters<typeof FigPluginBridgeRuntime>[0]
type Host = FigPluginRuntimeBinding['host']
const now = 1_800_000_000_000
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const binding = (host: Host = 'figma'): FigPluginRuntimeBinding => ({
  pluginId: `owned.${host}`,
  host,
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  projectId: 'owned-project',
  profileId: 'PRIVATE-PROVIDER-FIXTURE',
  profileRevision: 'd'.repeat(64)
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
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
// Synthetic all-black pixels and optional legal ancillary padding; no user image fixtures.
const png = (width = 1, height = 1, padding = 0) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) raw[row * (width * 4 + 1) + column * 4 + 4] = 255
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...(padding
      ? [pngChunk('tEXt', Buffer.concat([Buffer.from('fixture\0'), Buffer.alloc(padding, 65)]))]
      : []),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
// Pillow-encoded 1x1 black test pixels. These constants are static, not provider output.
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==',
  'base64'
)
const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=', 'base64')
const materialized = (bytes: Uint8Array = png(), mimeType: FigPluginAssetMime = 'image/png') => ({
  mimeType,
  width: 1,
  height: 1,
  bytes
})
const listRequest = { protocol: 1, purpose: 'local-preview' } as const
const readRequest = (asset: FigPluginSessionAsset, index = 0) => ({
  ...listRequest,
  assetId: asset.assetId,
  sha256: asset.sha256,
  index
})
const pair = async (runtime: FigPluginBridgeRuntime, value = binding()) => {
  const ticket = await runtime.createPairing(value)
  return runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: ticket.pluginId,
    host: ticket.host,
    artifactSha256: ticket.artifactSha256,
    clientNonce: 'e'.repeat(32)
  })
}
const targetFor = (
  session: FigPluginPairResponse,
  value = binding()
): FigPluginDesktopAssetTarget => ({
  sessionId: session.sessionId,
  pluginId: value.pluginId,
  projectId: value.projectId
})
const fixtures: Array<{
  runtime: FigPluginBridgeRuntime
  effects: readonly { mock: { calls: readonly unknown[] } }[]
}> = []
const make = (options: Partial<Options> = {}) => {
  const validate = vi.fn<Options['validateBinding']>().mockResolvedValue(true)
  const invoke = vi.fn<Options['invoke']>().mockResolvedValue({ content: 'must not be invoked' })
  const audit = vi.fn<NonNullable<Options['audit']>>()
  const planningAudit = vi.fn<NonNullable<Options['planningAudit']>>()
  const writeAccess = vi.fn(() => true)
  const writes = { reserve: vi.fn(() => true), owns: vi.fn(() => true), release: vi.fn() }
  const runtime = new FigPluginBridgeRuntime({
    validateBinding: validate,
    invoke,
    audit,
    planningAudit,
    allowNativeWrite: writeAccess,
    allowAssetTransfer: () => true,
    writes,
    ...options
  })
  const approve = vi.spyOn(runtime, 'approve')
  const approvePlan = vi.spyOn(runtime, 'approvePlan')
  const result = {
    runtime,
    validate,
    invoke,
    audit,
    planningAudit,
    writeAccess,
    writes,
    approve,
    approvePlan
  }
  fixtures.push({
    runtime,
    effects: [
      invoke,
      audit,
      planningAudit,
      writeAccess,
      writes.reserve,
      writes.owns,
      writes.release,
      approve,
      approvePlan
    ]
  })
  return result
}
const fixture = async (host: Host = 'figma', options: Partial<Options> = {}) => {
  const f = make(options)
  const value = binding(host)
  const session = await pair(f.runtime, value)
  const target = targetFor(session, value)
  const select = () => f.runtime.beginSessionAssetSelection(target)
  const publish = async (input = materialized()) =>
    f.runtime.publishSessionAsset(await select(), input)
  const catalog = () => f.runtime.listSessionAssets(target)
  const nativeList = (input: unknown = listRequest) =>
    f.runtime.assetList(session.sessionId, session.sessionToken, input)
  const read = (asset: FigPluginSessionAsset, index = 0) =>
    f.runtime.assetChunk(session.sessionId, session.sessionToken, readRequest(asset, index))
  return { ...f, session, target, select, publish, catalog, nativeList, read }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  const active = fixtures.splice(0)
  try {
    for (const f of active) for (const effect of f.effects) expect(effect).not.toHaveBeenCalled()
  } finally {
    for (const f of active) f.runtime.dispose()
    vi.useRealTimers()
  }
})

describe.each(['figma', 'photoshop'] as const)('%s session image asset authority', (host) => {
  it.each([
    { mimeType: 'image/png' as const, bytes: png() },
    { mimeType: 'image/jpeg' as const, bytes: jpeg },
    { mimeType: 'image/webp' as const, bytes: webp }
  ])(
    'publishes exact verified $mimeType bytes with a current immutable selection binding',
    async ({ mimeType, bytes }) => {
      const f = await fixture(host)
      const mutableTarget = { ...f.target }
      const selecting = f.runtime.beginSessionAssetSelection(mutableTarget)
      mutableTarget.projectId = 'substituted-project'
      const selection = await selecting
      expect(selection).toEqual({
        target: f.target,
        host,
        bindingSha256: sha256(Buffer.from(canonicalFigPluginJson(binding(host)))),
        expiresAt: now + FIGPLUGIN_ASSET_TTL_MS,
        maxBytes: FIGPLUGIN_ASSET_MAX_BYTES
      })
      const asset = await f.runtime.publishSessionAsset(selection, materialized(bytes, mimeType))
      expect(figPluginSessionAssetSchema.parse(asset)).toEqual(asset)
      expect(asset).toMatchObject({
        ...f.target,
        host,
        purpose: 'local-preview',
        mimeType,
        width: 1,
        height: 1,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
        chunkCount: 1,
        createdAt: now,
        expiresAt: selection.expiresAt
      })
      expect(asset.assetId).toMatch(/^[a-f0-9]{32}$/)
      expect(await f.catalog()).toEqual(await f.nativeList())
      expect((await f.catalog()).assets).toEqual([asset])
      expect(Buffer.from((await f.read(asset)).chunk.bytesBase64, 'base64')).toEqual(bytes)
      await expect(
        f.runtime.publishSessionAsset(selection, materialized(bytes, mimeType))
      ).rejects.toBeInstanceOf(FigPluginBridgeError)
      expect(f.runtime.listPreviews()).toEqual([])
      expect(f.runtime.listPlanExecutions()).toEqual([])
    }
  )

  it('copies the exact Uint8Array view and metadata before asynchronous revalidation', async () => {
    const f = await fixture(host)
    const selection = await f.select()
    const expected = png()
    const backing = Buffer.concat([Buffer.alloc(9, 42), expected, Buffer.alloc(11, 43)])
    const input = materialized(backing.subarray(9, 9 + expected.length))
    const gate = deferred<boolean>()
    f.validate.mockReturnValueOnce(gate.promise)
    const publishing = f.runtime.publishSessionAsset(selection, input)
    expect(f.validate).toHaveBeenLastCalledWith(binding(host))
    backing.fill(0)
    input.width = 2
    input.mimeType = 'image/jpeg'
    gate.resolve(true)
    const asset = await publishing
    expect(asset).toMatchObject({
      mimeType: 'image/png',
      width: 1,
      sha256: sha256(expected),
      sizeBytes: expected.length
    })
    expect(Buffer.from((await f.read(asset)).chunk.bytesBase64, 'base64')).toEqual(expected)
    Reflect.set(asset, 'width', 99)
    const catalog = await f.catalog()
    Reflect.set(catalog.assets[0], 'sha256', '0'.repeat(64))
    catalog.assets.splice(0)
    expect((await f.catalog()).assets).toMatchObject([{ width: 1, sha256: sha256(expected) }])
    const chunk = await f.read((await f.catalog()).assets[0])
    Reflect.set(chunk.chunk, 'bytesBase64', 'AAAA')
    expect(
      Buffer.from((await f.read((await f.catalog()).assets[0])).chunk.bytesBase64, 'base64')
    ).toEqual(expected)
  })

  it('returns repeatable bounded binary chunks that reconstruct and hash to the exact published image', async () => {
    const f = await fixture(host)
    const bytes = png(1, 1, FIGPLUGIN_ASSET_CHUNK_BYTES * 2)
    const asset = await f.publish(materialized(bytes))
    expect(asset.chunkCount).toBe(3)
    const chunks: BinaryChunkFrame[] = []
    for (let index = 0; index < asset.chunkCount; index++) {
      const value = await f.read(asset, index)
      expect(figPluginAssetChunkSchema.parse(value)).toEqual(value)
      expect(value).toMatchObject({
        protocol: 1,
        purpose: 'local-preview',
        sessionId: f.target.sessionId,
        assetId: asset.assetId
      })
      expect(value.chunk).toMatchObject({
        sha256: asset.sha256,
        index,
        chunkCount: asset.chunkCount
      })
      expect(Buffer.from(value.chunk.bytesBase64, 'base64')).toEqual(
        bytes.subarray(index * asset.chunkSize, (index + 1) * asset.chunkSize)
      )
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(128 * 1024)
      expect(await f.read(asset, index)).toEqual(value)
      chunks.push(value.chunk)
    }
    const reconstructed = await assembleBinaryChunks(
      {
        version: 1,
        kind: 'content-addressed-binary',
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        chunkSize: asset.chunkSize,
        chunkCount: asset.chunkCount
      },
      chunks.reverse()
    )
    expect(Buffer.from(reconstructed)).toEqual(bytes)
    expect(sha256(reconstructed)).toBe(asset.sha256)
    expect((await f.catalog()).assets).toEqual([asset])
  })

  it('keeps catalogs metadata-only and excludes pixels, source paths, credentials and provider bindings', async () => {
    const f = await fixture(host)
    const bytes = png()
    await f.publish(materialized(bytes))
    for (const catalog of [await f.catalog(), await f.nativeList()]) {
      expect(figPluginAssetListSchema.parse(catalog)).toEqual(catalog)
      expect(Object.keys(catalog).sort()).toEqual(['assets', 'protocol', 'purpose', 'sessionId'])
      expect(Object.keys(catalog.assets[0]).sort()).toEqual([
        'assetId',
        'chunkCount',
        'chunkSize',
        'createdAt',
        'expiresAt',
        'height',
        'host',
        'kind',
        'mimeType',
        'pluginId',
        'projectId',
        'purpose',
        'sessionId',
        'sha256',
        'sizeBytes',
        'version',
        'width'
      ])
      const text = JSON.stringify(catalog)
      for (const secret of [
        'bytesBase64',
        'path',
        'url',
        'sessionToken',
        'profileId',
        'profileRevision',
        f.session.sessionToken,
        binding(host).profileId,
        bytes.toString('base64')
      ])
        expect(text).not.toContain(secret)
    }
  })
})

describe('session image asset validation and isolation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'fails closed when the signed asset byte policy is not a positive safe integer: %s',
    async (limit) => {
      const f = await fixture('figma', { assetByteLimit: () => limit })
      await expect(f.select()).rejects.toMatchObject({ code: 'DENIED' })
      await expect(f.catalog()).rejects.toMatchObject({ code: 'DENIED' })
      await expect(f.nativeList()).rejects.toMatchObject({ code: 'DENIED' })
    }
  )

  it('binds the signed raw-byte ceiling into the selection, accepts its exact edge and rejects before revalidation', async () => {
    const policy = vi.fn<NonNullable<Options['assetByteLimit']>>().mockReturnValue(512)
    const f = await fixture('figma', { assetByteLimit: policy })
    const selection = await f.select()
    expect(selection.maxBytes).toBe(512)
    expect(policy).toHaveBeenLastCalledWith(binding())
    expect(Object.isFrozen(policy.mock.calls[0][0])).toBe(true)
    const padding = 512 - png().length - 12 - Buffer.byteLength('fixture\0')
    const bytes = png(1, 1, padding)
    expect(bytes.length).toBe(512)
    const asset = await f.runtime.publishSessionAsset(selection, materialized(bytes))
    expect(asset.sizeBytes).toBe(512)
    expect(Buffer.from((await f.read(asset)).chunk.bytesBase64, 'base64')).toEqual(bytes)
    const smaller = await f.select()
    const validations = f.validate.mock.calls.length
    await expect(
      f.runtime.publishSessionAsset(smaller, materialized(png(1, 1, padding + 1)))
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.validate).toHaveBeenCalledTimes(validations)
    policy.mockReturnValue(FIGPLUGIN_ASSET_MAX_BYTES + 1)
    expect((await f.select()).maxBytes).toBe(FIGPLUGIN_ASSET_MAX_BYTES)
  })

  it('never expands an already issued selection when a synthetic policy later permits more bytes', async () => {
    let limit = png().length
    const f = await fixture('figma', { assetByteLimit: () => limit })
    const selection = await f.select()
    limit = 512
    const bytes = png(1, 1, 100)
    await expect(
      f.runtime.publishSessionAsset(selection, materialized(bytes))
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await f.catalog()).assets).toEqual([])
    expect(await f.publish(materialized(bytes))).toMatchObject({ sizeBytes: bytes.length })
  })

  it('rechecks a narrowed signed ceiling after a publisher resumes from asynchronous validation', async () => {
    let limit = 512
    const f = await fixture('figma', { assetByteLimit: () => limit })
    const selection = await f.select()
    const bytes = png(1, 1, 100)
    const gate = deferred<boolean>()
    f.validate.mockReturnValueOnce(gate.promise)
    const publishing = f.runtime
      .publishSessionAsset(selection, materialized(bytes))
      .catch((error: unknown) => error)
    limit = bytes.length - 1
    gate.resolve(true)
    expect(await publishing).toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await f.catalog()).assets).toEqual([])
    expect(await f.publish()).toMatchObject({ sizeBytes: png().length })
  })

  it('evicts oversized stored assets on read-time policy narrowing without reviving them when the ceiling grows again', async () => {
    let limit = 512
    const f = await fixture('figma', { assetByteLimit: () => limit })
    const large = await f.publish(materialized(png(1, 1, 100)))
    const small = await f.publish()
    const gate = deferred<boolean>()
    f.validate.mockReturnValueOnce(gate.promise)
    const reading = f.read(large).catch((error: unknown) => error)
    limit = large.sizeBytes - 1
    gate.resolve(true)
    expect(await reading).toMatchObject({ code: 'EXPIRED' })
    expect((await f.catalog()).assets).toEqual([small])
    limit = 0
    await expect(f.nativeList()).rejects.toMatchObject({ code: 'DENIED' })
    limit = 512
    expect((await f.nativeList()).assets).toEqual([])
    await expect(f.read(large)).rejects.toMatchObject({ code: 'EXPIRED' })
    await expect(f.read(small)).rejects.toMatchObject({ code: 'EXPIRED' })
  })

  it('denies a throwing byte-policy callback rather than surfacing its details or retaining assets', async () => {
    const policy = vi.fn<NonNullable<Options['assetByteLimit']>>().mockReturnValue(512)
    const f = await fixture('figma', { assetByteLimit: policy })
    const asset = await f.publish()
    policy.mockImplementation(() => {
      throw new Error('PRIVATE-BYTE-POLICY')
    })
    const error = await f.nativeList().catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'DENIED' })
    expect(String(error)).not.toContain('PRIVATE-BYTE-POLICY')
    policy.mockReturnValue(512)
    expect((await f.catalog()).assets).toEqual([])
    await expect(f.read(asset)).rejects.toMatchObject({ code: 'EXPIRED' })
  })

  it('uses the actual Controller signed descriptor ceiling and rejects a same-identity limit change', async () => {
    type Store = ConstructorParameters<typeof FigPluginBridgeController>[0]
    type Wire = Parameters<typeof startFigPluginBridgeServer>[0]['runtime']
    let wire!: Wire
    let current: FigPluginRuntimeDescriptor = {
      ...binding(),
      capabilities: ['dialogue', 'asset-transfer'],
      limits: {
        maxPayloadBytes: 512,
        maxResultBytes: 256,
        maxConfigBytes: 1024,
        maxCallTimeoutMs: 30_000,
        maxConcurrentCalls: 1
      }
    }
    const store: Store = {
      getRuntimeDescriptor: vi
        .fn<Store['getRuntimeDescriptor']>()
        .mockImplementation(async () => structuredClone(current)),
      onRuntimeInvalidated: vi.fn(() => () => {})
    }
    const chat = vi.fn<LLMProxySvc['chat']>()
    const cancelConversation = vi.fn<LLMProxySvc['cancelConversation']>()
    const model = {
      listProfiles: vi.fn<LLMProxySvc['listProfiles']>().mockResolvedValue({
        profiles: [
          {
            id: binding().profileId,
            model_name: 'Synthetic descriptor fixture',
            model_use: 'chat',
            configurationRevision: binding().profileRevision
          }
        ]
      }),
      chat,
      cancelConversation,
      isProfileRevisionCurrent: (id: string, revision: string) =>
        id === binding().profileId && revision === binding().profileRevision,
      onProfileConfigurationChanged: () => () => {}
    }
    const startServer = vi
      .fn<typeof startFigPluginBridgeServer>()
      .mockImplementation(async (input) => {
        wire = input.runtime
        return { origin: input.origin, close: async () => {} }
      })
    const controller = new FigPluginBridgeController(store, model, { startServer })
    try {
      const resolved = await controller.resolveBinding(
        { pluginId: current.pluginId, expectedGeneration: current.generation },
        'owned-project'
      )
      const ticket = await controller.createPairing(resolved)
      const session = await wire.redeem({
        protocol: 1,
        ticketId: ticket.ticketId,
        pairingSecret: ticket.pairingSecret,
        pluginId: ticket.pluginId,
        host: ticket.host,
        artifactSha256: ticket.artifactSha256,
        clientNonce: 'e'.repeat(32)
      })
      const target = targetFor(session)
      const selection = await controller.beginSessionAssetSelection(target)
      expect(selection.maxBytes).toBe(current.limits.maxPayloadBytes)
      const padding = 512 - png().length - 12 - Buffer.byteLength('fixture\0')
      const asset = await controller.publishSessionAsset(
        selection,
        materialized(png(1, 1, padding))
      )
      expect(asset.sizeBytes).toBe(512)
      await expect(
        controller.publishSessionAsset(
          await controller.beginSessionAssetSelection(target),
          materialized(png(1, 1, padding + 1))
        )
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect((await controller.listSessionAssets(target)).assets).toEqual([asset])
      current = { ...current, limits: { ...current.limits, maxPayloadBytes: 511 } }
      await expect(
        wire.assetList(session.sessionId, session.sessionToken, listRequest)
      ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
      await expect(
        wire.assetChunk(session.sessionId, session.sessionToken, readRequest(asset))
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(controller.desktopState()).toMatchObject({ sessions: [], previews: [] })
      expect(chat).not.toHaveBeenCalled()
      expect(cancelConversation).not.toHaveBeenCalled()
    } finally {
      await controller.dispose()
    }
  })

  it('requires the explicit asset capability rather than treating paired or write authority as asset consent', async () => {
    for (const allowAssetTransfer of [undefined, () => false]) {
      const f = await fixture('figma', { allowAssetTransfer })
      await expect(f.select()).rejects.toMatchObject({ code: 'DENIED' })
      await expect(f.catalog()).rejects.toMatchObject({ code: 'DENIED' })
      await expect(f.nativeList()).rejects.toMatchObject({ code: 'DENIED' })
    }
  })

  it('binds selection and revocation to the exact main-owned session, plugin, project and receipt identity', async () => {
    const f = await fixture()
    const selection = await f.select()
    for (const target of [
      { ...f.target, sessionId: '0'.repeat(32) },
      { ...f.target, pluginId: 'other.figma' },
      { ...f.target, projectId: 'other-project' }
    ]) {
      await expect(f.runtime.beginSessionAssetSelection(target)).rejects.toMatchObject({
        code: 'UNAUTHORIZED'
      })
      await expect(f.runtime.listSessionAssets(target)).rejects.toMatchObject({
        code: 'UNAUTHORIZED'
      })
    }
    for (const forged of [
      structuredClone(selection),
      { ...selection, host: 'photoshop' },
      { ...selection, bindingSha256: '0'.repeat(64) },
      { ...selection, target: { ...f.target, projectId: 'other-project' } }
    ])
      await expect(
        f.runtime.publishSessionAsset(forged as never, materialized())
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    const asset = await f.runtime.publishSessionAsset(selection, materialized())
    for (const patch of [
      { pluginId: 'other.figma' },
      { projectId: 'other-project' },
      { sessionId: '0'.repeat(32) }
    ])
      await expect(
        f.runtime.revokeSessionAsset({
          ...f.target,
          assetId: asset.assetId,
          sha256: asset.sha256,
          ...patch
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      f.runtime.revokeSessionAsset({ ...f.target, assetId: asset.assetId, sha256: '0'.repeat(64) })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await f.catalog()).assets).toEqual([asset])
  })

  it('does not let another session, plugin or project read an asset using valid independent credentials', async () => {
    const f = await fixture()
    const asset = await f.publish()
    for (const value of [
      binding(),
      { ...binding(), pluginId: 'other.figma' },
      { ...binding(), projectId: 'other-project' },
      binding('photoshop')
    ]) {
      const other = await pair(f.runtime, value)
      expect(
        await f.runtime.assetList(other.sessionId, other.sessionToken, listRequest)
      ).toMatchObject({ assets: [] })
      await expect(
        f.runtime.assetChunk(other.sessionId, other.sessionToken, readRequest(asset))
      ).rejects.toMatchObject({ code: 'EXPIRED' })
      await expect(
        f.runtime.assetList(f.session.sessionId, other.sessionToken, listRequest)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      await expect(
        f.runtime.assetChunk(other.sessionId, f.session.sessionToken, readRequest(asset))
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
    for (const token of ['', 'malformed', '0'.repeat(64), f.session.sessionToken + '\n']) {
      await expect(
        f.runtime.assetList(f.session.sessionId, token, listRequest)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      await expect(
        f.runtime.assetChunk(f.session.sessionId, token, readRequest(asset))
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
    expect(await f.read(asset)).toMatchObject({ assetId: asset.assetId })
  })

  it('rejects unknown fields, alternate purposes and substituted hashes or indexes without changing stored assets', async () => {
    const f = await fixture()
    const asset = await f.publish()
    for (const patch of [
      { purpose: 'provider-input' },
      { purpose: 'native-write' },
      { purpose: undefined },
      { protocol: 2 },
      { path: 'C:\\PRIVATE-FIXTURE.png' },
      { url: 'https://example.invalid/PRIVATE-FIXTURE.png' },
      { bytesBase64: 'AA==' },
      { pluginId: 'other.figma' },
      { projectId: 'other-project' }
    ]) {
      await expect(f.nativeList({ ...listRequest, ...patch })).rejects.toMatchObject({
        code: 'INVALID_REQUEST'
      })
      await expect(
        f.runtime.assetChunk(f.session.sessionId, f.session.sessionToken, {
          ...readRequest(asset),
          ...patch
        })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    for (const patch of [
      { sha256: '0'.repeat(64) },
      { index: -1 },
      { index: 0.5 },
      { index: asset.chunkCount },
      { index: 1_000_000 }
    ])
      await expect(
        f.runtime.assetChunk(f.session.sessionId, f.session.sessionToken, {
          ...readRequest(asset),
          ...patch
        })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    for (const target of [
      { ...f.target, path: 'C:\\PRIVATE-FIXTURE.png' },
      { ...f.target, url: 'file:///PRIVATE-FIXTURE.png' }
    ]) {
      await expect(f.runtime.beginSessionAssetSelection(target)).rejects.toMatchObject({
        code: 'INVALID_REQUEST'
      })
      await expect(f.runtime.listSessionAssets(target)).rejects.toMatchObject({
        code: 'INVALID_REQUEST'
      })
      await expect(
        f.runtime.revokeSessionAsset({ ...target, assetId: asset.assetId, sha256: asset.sha256 })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect((await f.catalog()).assets).toEqual([asset])
    expect(Buffer.from((await f.read(asset)).chunk.bytesBase64, 'base64')).toEqual(png())
  })

  it('inspects actual image MIME and dimensions, refusing spoofed, animated, malformed and oversized publications', async () => {
    const f = await fixture()
    const bytes = png()
    const invalid = [
      { ...materialized(), mimeType: 'image/gif' },
      { ...materialized(), mimeType: 'image/jpeg' },
      { ...materialized(jpeg), mimeType: 'image/png' },
      { ...materialized(), width: 2 },
      { ...materialized(), height: 2 },
      { ...materialized(), width: 0 },
      { ...materialized(), height: 1.5 },
      { ...materialized(), bytes: [137, 80, 78, 71] },
      { ...materialized(), bytes: new Uint8Array() },
      { ...materialized(), bytes: Buffer.alloc(FIGPLUGIN_ASSET_MAX_BYTES + 1) },
      { ...materialized(), bytes: bytes.subarray(0, -1) },
      { ...materialized(), bytes: Buffer.alloc(70) },
      { ...materialized(), bytes: Buffer.concat([bytes, Buffer.from([0])]) },
      { ...materialized(png(FIGPLUGIN_ASSET_MAX_EDGE + 1)), width: FIGPLUGIN_ASSET_MAX_EDGE + 1 },
      {
        ...materialized(png(1, FIGPLUGIN_ASSET_MAX_EDGE + 1)),
        height: FIGPLUGIN_ASSET_MAX_EDGE + 1
      },
      { ...materialized(), path: 'C:\\PRIVATE-FIXTURE.png' },
      { ...materialized(), url: 'https://example.invalid/PRIVATE-FIXTURE.png' },
      { ...materialized(), sha256: sha256(bytes) },
      { ...materialized(), purpose: 'provider-input' }
    ]
    const animated = Buffer.concat([
      bytes.subarray(0, 33),
      pngChunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])),
      bytes.subarray(33)
    ])
    invalid.push(materialized(animated))
    for (const input of invalid) {
      await expect(
        f.runtime.publishSessionAsset(await f.select(), input as never)
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect((await f.catalog()).assets).toEqual([])
    }
    const edge = await f.publish({
      ...materialized(png(FIGPLUGIN_ASSET_MAX_EDGE)),
      width: FIGPLUGIN_ASSET_MAX_EDGE
    })
    expect(edge.width).toBe(FIGPLUGIN_ASSET_MAX_EDGE)
  })

  it('accepts exactly the byte cap and bounded final chunk while rejecting the next byte', async () => {
    const f = await fixture()
    const padding = FIGPLUGIN_ASSET_MAX_BYTES - png().length - 12 - Buffer.byteLength('fixture\0')
    const bytes = png(1, 1, padding)
    expect(bytes.length).toBe(FIGPLUGIN_ASSET_MAX_BYTES)
    const asset = await f.publish(materialized(bytes))
    expect(asset.sizeBytes).toBe(FIGPLUGIN_ASSET_MAX_BYTES)
    const first = await f.read(asset)
    const last = await f.read(asset, asset.chunkCount - 1)
    expect(Buffer.from(first.chunk.bytesBase64, 'base64')).toHaveLength(FIGPLUGIN_ASSET_CHUNK_BYTES)
    expect(Buffer.from(last.chunk.bytesBase64, 'base64')).toEqual(
      bytes.subarray((asset.chunkCount - 1) * asset.chunkSize)
    )
    await expect(f.publish(materialized(png(1, 1, padding + 1)))).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect((await f.catalog()).assets).toEqual([asset])
  })
})

describe('session image lifetime and atomic publication', () => {
  it('revokes only the exact asset and makes its bytes unavailable without invalidating its peer asset', async () => {
    const f = await fixture()
    const first = await f.publish()
    const second = await f.publish()
    expect(second.assetId).not.toBe(first.assetId)
    expect(second.sha256).toBe(first.sha256)
    await f.runtime.revokeSessionAsset({
      ...f.target,
      assetId: first.assetId,
      sha256: first.sha256
    })
    expect((await f.catalog()).assets).toEqual([second])
    await expect(f.read(first)).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(await f.read(second)).toMatchObject({ assetId: second.assetId })
  })

  it('expires assets and unused selections on their original deadline even when reads keep the session alive', async () => {
    const f = await fixture()
    const unused = await f.select()
    const asset = await f.publish()
    await vi.advanceTimersByTimeAsync(FIGPLUGIN_ASSET_TTL_MS - 1)
    expect((await f.nativeList()).assets).toEqual([asset])
    expect((await f.read(asset)).assetId).toBe(asset.assetId)
    await vi.advanceTimersByTimeAsync(1)
    expect((await f.nativeList()).assets).toEqual([])
    await expect(f.read(asset)).rejects.toMatchObject({ code: 'EXPIRED' })
    await expect(f.runtime.publishSessionAsset(unused, materialized())).rejects.toMatchObject({
      code: 'EXPIRED'
    })
    expect(f.runtime.listSessions()).toHaveLength(1)
    expect(await f.publish()).toMatchObject({ createdAt: now + FIGPLUGIN_ASSET_TTL_MS })
  })

  it('caps selection and publication at session idle and absolute expiry rather than extending session authority', async () => {
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(30_000)
    const idleSelection = await f.select()
    expect(idleSelection.expiresAt).toBeLessThanOrEqual(now + 120_000)
    const idleAsset = await f.runtime.publishSessionAsset(idleSelection, materialized())
    expect(idleAsset.expiresAt).toBeLessThanOrEqual(now + 120_000)
    for (let index = 0; index < 8; index++) {
      await vi.advanceTimersByTimeAsync(60_000)
      await f.nativeList()
    }
    await vi.advanceTimersByTimeAsync(60_000)
    await f.nativeList()
    const lastSelection = await f.select()
    const last = await f.runtime.publishSessionAsset(lastSelection, materialized())
    expect(lastSelection.expiresAt).toBe(f.session.expiresAt)
    expect(last.expiresAt).toBe(f.session.expiresAt)
    await vi.advanceTimersByTimeAsync(f.session.expiresAt - Date.now())
    expect(f.runtime.listSessions()).toEqual([])
    await expect(f.read(last)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it.each([
    'close',
    'plugin-revoke',
    'transport-revoke',
    'configuration',
    'dispose',
    'idle-expire'
  ] as const)('drops published pixels and prevents further reads after %s', async (action) => {
    const f = await fixture()
    const asset = await f.publish()
    if (action === 'close') f.runtime.closeSession(f.session.sessionId, f.session.sessionToken)
    else if (action === 'plugin-revoke') f.runtime.revokePlugin(f.target.pluginId)
    else if (action === 'transport-revoke') f.runtime.revokeTransport()
    else if (action === 'configuration') f.runtime.revokeInvalidBindings(() => false)
    else if (action === 'dispose') f.runtime.dispose()
    else await vi.advanceTimersByTimeAsync(120_000)
    await expect(f.read(asset)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(f.catalog()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    if (action !== 'dispose') expect(f.runtime.listSessions()).toEqual([])
  })

  it('removes all retained assets if the current binding fails or its validator throws', async () => {
    for (const fail of [false, new Error('PRIVATE-VALIDATOR-DETAILS')]) {
      const f = await fixture()
      const asset = await f.publish()
      if (fail instanceof Error) f.validate.mockRejectedValue(fail)
      else f.validate.mockResolvedValue(false)
      const error = await f.nativeList().catch((value: unknown) => value)
      expect(error).toBeInstanceOf(FigPluginBridgeError)
      expect(error).toMatchObject({ code: 'CONFIGURATION_CHANGED' })
      expect(String(error)).not.toContain('PRIVATE-VALIDATOR-DETAILS')
      expect(JSON.stringify(error)).not.toContain('bytesBase64')
      expect(f.runtime.listSessions()).toEqual([])
      await expect(f.read(asset)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
  })

  it.each([
    'close',
    'plugin-revoke',
    'transport-revoke',
    'configuration',
    'dispose',
    'expiry'
  ] as const)(
    'does not revive a late selection or publish after %s races asynchronous validation',
    async (action) => {
      for (const operation of ['select', 'publish'] as const) {
        const f = await fixture()
        const selection = operation === 'publish' ? await f.select() : undefined
        const gate = deferred<boolean>()
        f.validate.mockReturnValueOnce(gate.promise)
        const pending =
          operation === 'select'
            ? f.select()
            : f.runtime.publishSessionAsset(selection!, materialized())
        const result = pending.catch((error: unknown) => error)
        if (action === 'close') f.runtime.closeSession(f.session.sessionId, f.session.sessionToken)
        else if (action === 'plugin-revoke') f.runtime.revokePlugin(f.target.pluginId)
        else if (action === 'transport-revoke') f.runtime.revokeTransport()
        else if (action === 'configuration') f.runtime.revokeInvalidBindings(() => false)
        else if (action === 'dispose') f.runtime.dispose()
        else await vi.advanceTimersByTimeAsync(120_000)
        gate.resolve(true)
        expect(await result).toBeInstanceOf(FigPluginBridgeError)
        await expect(f.catalog()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
        if (action !== 'dispose') expect(f.runtime.listSessions()).toEqual([])
      }
    }
  )

  it('makes revoke win over a chunk read paused at asynchronous binding validation', async () => {
    const f = await fixture()
    const asset = await f.publish()
    const gate = deferred<boolean>()
    f.validate.mockReturnValueOnce(gate.promise)
    const reading = f.read(asset).catch((error: unknown) => error)
    const revoking = f.runtime.revokeSessionAsset({
      ...f.target,
      assetId: asset.assetId,
      sha256: asset.sha256
    })
    gate.resolve(true)
    await revoking
    const result = await reading
    expect(result).toBeInstanceOf(FigPluginBridgeError)
    expect(result).toMatchObject({ code: 'EXPIRED' })
    expect((await f.catalog()).assets).toEqual([])
  })

  it.each(['close', 'transport-revoke', 'dispose'] as const)(
    'does not return catalog metadata or pixels after %s races native read validation',
    async (action) => {
      for (const operation of ['list', 'chunk'] as const) {
        const f = await fixture()
        const asset = await f.publish()
        const gate = deferred<boolean>()
        f.validate.mockReturnValueOnce(gate.promise)
        const reading = (operation === 'list' ? f.nativeList() : f.read(asset)).catch(
          (error: unknown) => error
        )
        if (action === 'close') f.runtime.closeSession(f.session.sessionId, f.session.sessionToken)
        else if (action === 'transport-revoke') f.runtime.revokeTransport()
        else f.runtime.dispose()
        gate.resolve(true)
        expect(await reading).toBeInstanceOf(FigPluginBridgeError)
        expect(await reading).toMatchObject({ code: 'UNAUTHORIZED' })
      }
    }
  )

  it('atomically enforces the per-session cap when validated concurrent publishers resume together', async () => {
    const f = await fixture()
    const selections = await Promise.all(Array.from({ length: 8 }, () => f.select()))
    const gate = deferred<boolean>()
    f.validate.mockReturnValue(gate.promise)
    const publishing = selections.map((selection) =>
      f.runtime.publishSessionAsset(selection, materialized())
    )
    const results = Promise.allSettled(publishing)
    const overCapacity = await Promise.all(
      publishing
        .slice(FIGPLUGIN_ASSET_MAX_PER_SESSION)
        .map((promise) => promise.catch((error: unknown) => error))
    )
    for (const error of overCapacity) expect(error).toMatchObject({ code: 'BUSY' })
    gate.resolve(true)
    const settled = await results
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(
      FIGPLUGIN_ASSET_MAX_PER_SESSION
    )
    const rejected = settled.filter((result) => result.status === 'rejected')
    expect(rejected).toHaveLength(4)
    for (const result of rejected) expect(result.reason).toMatchObject({ code: 'BUSY' })
    expect((await f.catalog()).assets).toHaveLength(FIGPLUGIN_ASSET_MAX_PER_SESSION)
    expect(new Set((await f.catalog()).assets.map((asset) => asset.assetId)).size).toBe(
      FIGPLUGIN_ASSET_MAX_PER_SESSION
    )
  })

  it('atomically enforces the global cap across sessions and releases quota on exact revocation', async () => {
    const f = make()
    const targets = await Promise.all(
      Array.from({ length: 5 }, async () => targetFor(await pair(f.runtime)))
    )
    const selections = await Promise.all(
      targets.flatMap((target) =>
        Array.from({ length: 4 }, () => f.runtime.beginSessionAssetSelection(target))
      )
    )
    const gate = deferred<boolean>()
    f.validate.mockReturnValue(gate.promise)
    const results = Promise.allSettled(
      selections.map((selection) => f.runtime.publishSessionAsset(selection, materialized()))
    )
    gate.resolve(true)
    const settled = await results
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(
      FIGPLUGIN_ASSET_MAX_TOTAL
    )
    for (const result of settled.filter((result) => result.status === 'rejected'))
      expect(result.reason).toMatchObject({ code: 'BUSY' })
    const catalogs = await Promise.all(targets.map((target) => f.runtime.listSessionAssets(target)))
    expect(catalogs.reduce((sum, catalog) => sum + catalog.assets.length, 0)).toBe(
      FIGPLUGIN_ASSET_MAX_TOTAL
    )
    const fullIndex = catalogs.findIndex((catalog) => catalog.assets.length > 0)
    const openIndex = catalogs.findIndex(
      (catalog) => catalog.assets.length < FIGPLUGIN_ASSET_MAX_PER_SESSION
    )
    expect(openIndex).toBeGreaterThanOrEqual(0)
    const asset = catalogs[fullIndex].assets[0]
    await f.runtime.revokeSessionAsset({
      ...targets[fullIndex],
      assetId: asset.assetId,
      sha256: asset.sha256
    })
    const replacement = await f.runtime.publishSessionAsset(
      await f.runtime.beginSessionAssetSelection(targets[openIndex]),
      materialized()
    )
    expect(replacement.assetId).not.toBe(asset.assetId)
    expect(
      (await Promise.all(targets.map((target) => f.runtime.listSessionAssets(target)))).reduce(
        (sum, catalog) => sum + catalog.assets.length,
        0
      )
    ).toBe(FIGPLUGIN_ASSET_MAX_TOTAL)
  })

  it('accounts for all pending owned bytes until cancelled validators actually settle', async () => {
    const f = make()
    const targets = await Promise.all(
      Array.from({ length: 3 }, async () => targetFor(await pair(f.runtime)))
    )
    const selections = await Promise.all(
      targets
        .slice(0, 2)
        .flatMap((target) =>
          Array.from({ length: 4 }, () => f.runtime.beginSessionAssetSelection(target))
        )
    )
    const spare = await f.runtime.beginSessionAssetSelection(targets[2])
    const padding = FIGPLUGIN_ASSET_MAX_BYTES - png().length - 12 - Buffer.byteLength('fixture\0')
    const bytes = png(1, 1, padding)
    expect(bytes.length * selections.length).toBe(FIGPLUGIN_ASSET_MAX_TOTAL_BYTES)
    const gate = deferred<boolean>()
    f.validate.mockReturnValue(gate.promise)
    const settling = Promise.allSettled(
      selections.map((selection) => f.runtime.publishSessionAsset(selection, materialized(bytes)))
    )
    await expect(f.runtime.publishSessionAsset(spare, materialized())).rejects.toMatchObject({
      code: 'BUSY'
    })
    f.runtime.revokeTransport()
    f.validate.mockResolvedValue(true)
    const freshTarget = targetFor(await pair(f.runtime))
    const blocked = await f.runtime.beginSessionAssetSelection(freshTarget)
    await expect(f.runtime.publishSessionAsset(blocked, materialized())).rejects.toMatchObject({
      code: 'BUSY'
    })
    gate.resolve(true)
    for (const result of await settling) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'UNAUTHORIZED' })
    }
    const asset = await f.runtime.publishSessionAsset(
      await f.runtime.beginSessionAssetSelection(freshTarget),
      materialized()
    )
    expect((await f.runtime.listSessionAssets(freshTarget)).assets).toEqual([asset])
  }, 10_000)
})
import { Buffer } from 'node:buffer'
