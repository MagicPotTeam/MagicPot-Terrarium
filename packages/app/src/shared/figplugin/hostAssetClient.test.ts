import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  readSessionAsset,
  validateSessionAsset,
  validateSessionAssetCatalog
} from './hostAssetClient'
import type { FigPluginSessionAsset } from './hostAssets'

const now = 1_800_000_000_000
const identity = { sessionId: '1'.repeat(32), pluginId: 'local-preview', host: 'figma' as const }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fixture = (size = 24579) => {
  const bytes = new Uint8Array(size).map((_, index) => index % 251)
  const asset: FigPluginSessionAsset = {
    version: 1,
    kind: 'session-image-asset',
    purpose: 'local-preview',
    ...identity,
    projectId: 'project_a',
    assetId: '2'.repeat(32),
    mimeType: 'image/png',
    sha256: hash(bytes),
    sizeBytes: bytes.length,
    width: 64,
    height: 32,
    chunkSize: 24576,
    chunkCount: Math.ceil(bytes.length / 24576),
    createdAt: now,
    expiresAt: now + 120000
  }
  const frames = Array.from({ length: asset.chunkCount }, (_, index) => ({
    protocol: 1,
    purpose: 'local-preview',
    sessionId: asset.sessionId,
    assetId: asset.assetId,
    chunk: {
      version: 1,
      kind: 'content-addressed-binary-chunk',
      sha256: asset.sha256,
      index,
      chunkCount: asset.chunkCount,
      bytesBase64: Buffer.from(bytes.subarray(index * 24576, (index + 1) * 24576)).toString(
        'base64'
      )
    }
  }))
  return { bytes, asset, frames }
}

describe('portable session asset reader', () => {
  it('uses the existing strict binary protocol without browser base64 or crypto globals', async () => {
    const { bytes, asset, frames } = fixture()
    vi.stubGlobal('atob', undefined)
    vi.stubGlobal('btoa', undefined)
    vi.stubGlobal('crypto', undefined)
    try {
      const readChunk = vi.fn(async ({ index }) => frames[index])
      expect(
        await readSessionAsset(asset, { identity, readChunk, sha256: hash, now: () => now })
      ).toEqual(bytes)
      expect(readChunk.mock.calls.map(([request]) => request.index)).toEqual([0, 1])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads the complete 8 MiB limit using bounded chunks', async () => {
    const { bytes, asset, frames } = fixture(8 * 1024 * 1024)
    const result = await readSessionAsset(asset, {
      identity,
      now: () => now,
      sha256: hash,
      readChunk: ({ index }) => frames[index]
    })
    expect(Buffer.compare(Buffer.from(result), Buffer.from(bytes))).toBe(0)
    expect(frames).toHaveLength(342)
  })

  it.each([
    { sessionId: '3'.repeat(32) },
    { pluginId: 'other' },
    { host: 'photoshop' },
    { projectId: 'elsewhere' },
    { expiresAt: now },
    { createdAt: now + 1 },
    { chunkCount: 3 },
    { chunkSize: 24577 },
    { sizeBytes: 8388609 },
    { width: 4097 },
    { purpose: 'provider' },
    { pathname: 'C:/secret' }
  ])('rejects identity, authority and manifest changes %j', (change) => {
    expect(() =>
      validateSessionAsset(
        { ...fixture().asset, ...change },
        { ...identity, projectId: 'project_a' },
        now
      )
    ).toThrow()
  })

  it('rejects mixed-project, duplicate, expired or foreign-session catalogs', () => {
    const { asset } = fixture()
    const catalog = {
      protocol: 1,
      purpose: 'local-preview',
      sessionId: identity.sessionId,
      assets: [asset]
    }
    expect(validateSessionAssetCatalog(catalog, identity, now)).toEqual(catalog)
    for (const assets of [
      [asset, asset],
      [asset, { ...asset, assetId: '3'.repeat(32), projectId: 'other' }],
      [{ ...asset, expiresAt: now }],
      [{ ...asset, sessionId: '4'.repeat(32) }]
    ])
      expect(() => validateSessionAssetCatalog({ ...catalog, assets }, identity, now)).toThrow()
  })

  it.each([
    'extra',
    'wrong-session',
    'wrong-asset',
    'wrong-hash',
    'duplicate',
    'count',
    'length',
    'tampered',
    'noncanonical',
    'whitespace'
  ])('rejects %s frames before publishing bytes', async (fault) => {
    const { asset, frames } = fixture(24577)
    const changed = structuredClone(frames)
    if (fault === 'extra') Object.assign(changed[0].chunk, { path: 'never' })
    if (fault === 'wrong-session') changed[0].sessionId = 'f'.repeat(32)
    if (fault === 'wrong-asset') changed[0].assetId = 'f'.repeat(32)
    if (fault === 'wrong-hash') changed[0].chunk.sha256 = 'f'.repeat(64)
    if (fault === 'duplicate') changed[1].chunk.index = 0
    if (fault === 'count') changed[0].chunk.chunkCount = 3
    if (fault === 'length') changed[0].chunk.bytesBase64 = 'AA=='
    if (fault === 'tampered') changed[1].chunk.bytesBase64 = 'AQ=='
    if (fault === 'noncanonical') changed[1].chunk.bytesBase64 = 'AB=='
    if (fault === 'whitespace') changed[1].chunk.bytesBase64 += '\n'
    await expect(
      readSessionAsset(asset, {
        identity,
        now: () => now,
        sha256: hash,
        readChunk: ({ index }) => changed[index]
      })
    ).rejects.toThrow()
  })

  it('cancels an unresponsive read and ignores its late response', async () => {
    const { asset, frames } = fixture()
    const controller = new AbortController()
    let release!: (value: unknown) => void
    const read = readSessionAsset(asset, {
      identity,
      now: () => now,
      sha256: hash,
      signal: controller.signal,
      readChunk: () =>
        new Promise((resolve) => {
          release = resolve
        })
    })
    await Promise.resolve()
    controller.abort()
    await expect(read).rejects.toThrow('CANCELLED')
    release(frames[0])
    await Promise.resolve()
  })

  it('clears assembled bytes when cancellation races whole-object hashing', async () => {
    const { asset, frames } = fixture()
    const controller = new AbortController()
    let captured!: Uint8Array
    const read = readSessionAsset(asset, {
      identity,
      now: () => now,
      signal: controller.signal,
      readChunk: ({ index }) => frames[index],
      sha256(bytes) {
        captured = bytes
        controller.abort()
        return new Promise(() => {})
      }
    })
    await expect(read).rejects.toThrow('CANCELLED')
    expect(captured.every((byte) => byte === 0)).toBe(true)
  })

  it('fails closed after expiry or a lifecycle transition during a read', async () => {
    const { asset, frames } = fixture()
    for (const fault of ['expired', 'epoch']) {
      let time = now
      let current = true
      await expect(
        readSessionAsset(asset, {
          identity,
          now: () => time,
          isCurrent: () => current,
          sha256: hash,
          readChunk: ({ index }) => {
            if (fault === 'expired') time = asset.expiresAt
            else current = false
            return frames[index]
          }
        })
      ).rejects.toThrow()
    }
  })

  it('enforces its deadline even for an unresponsive transport', async () => {
    vi.useFakeTimers()
    try {
      const { asset } = fixture()
      const read = readSessionAsset(asset, {
        identity,
        now: () => now,
        deadline: now + 10,
        sha256: hash,
        readChunk: () => new Promise(() => {})
      })
      const checked = expect(read).rejects.toThrow('EXPIRED')
      await vi.advanceTimersByTimeAsync(10)
      await checked
    } finally {
      vi.useRealTimers()
    }
  })
})
