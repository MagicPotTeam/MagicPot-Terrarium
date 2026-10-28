import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  FIGPLUGIN_ASSET_LIST_PATH,
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_MAX_EDGE,
  FIGPLUGIN_ASSET_MAX_PER_SESSION,
  FIGPLUGIN_ASSET_MAX_PIXELS,
  FIGPLUGIN_ASSET_MAX_TOTAL,
  FIGPLUGIN_ASSET_MAX_TOTAL_BYTES,
  FIGPLUGIN_ASSET_READ_PATH,
  FIGPLUGIN_ASSET_TTL_MS,
  figPluginAssetChunkSchema,
  figPluginAssetListRequestSchema,
  figPluginAssetListSchema,
  figPluginAssetReadRequestSchema,
  figPluginDesktopAssetRevokeSchema,
  figPluginDesktopAssetTargetSchema,
  figPluginSessionAssetSchema,
  type FigPluginSessionAsset
} from './hostAssets'

const target = {
  sessionId: 'a'.repeat(32),
  pluginId: 'owned.figma',
  projectId: 'owned-project'
}
const manifest = (): FigPluginSessionAsset => ({
  version: 1,
  kind: 'session-image-asset',
  purpose: 'local-preview',
  ...target,
  host: 'figma',
  assetId: 'b'.repeat(32),
  mimeType: 'image/png',
  sha256: 'c'.repeat(64),
  sizeBytes: 70,
  width: 1,
  height: 1,
  chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
  chunkCount: 1,
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_000_120_000
})
const readRequest = () => ({
  protocol: 1,
  purpose: 'local-preview',
  assetId: manifest().assetId,
  sha256: manifest().sha256,
  index: 0
})
const chunk = () => ({
  protocol: 1,
  purpose: 'local-preview',
  sessionId: target.sessionId,
  assetId: manifest().assetId,
  chunk: {
    version: 1,
    kind: 'content-addressed-binary-chunk',
    sha256: manifest().sha256,
    index: 0,
    chunkCount: 1,
    bytesBase64: 'AA=='
  }
})

describe('bounded session image asset contract', () => {
  it('keeps the local-preview budgets and dedicated read-only routes explicit', () => {
    expect(FIGPLUGIN_ASSET_MAX_BYTES).toBe(8 * 1024 * 1024)
    expect(FIGPLUGIN_ASSET_MAX_EDGE).toBe(4096)
    expect(FIGPLUGIN_ASSET_MAX_PIXELS).toBe(16 * 1024 * 1024)
    expect(FIGPLUGIN_ASSET_CHUNK_BYTES).toBe(24 * 1024)
    expect(FIGPLUGIN_ASSET_MAX_PER_SESSION).toBe(4)
    expect(FIGPLUGIN_ASSET_MAX_TOTAL).toBe(16)
    expect(FIGPLUGIN_ASSET_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024)
    expect(FIGPLUGIN_ASSET_TTL_MS).toBe(120_000)
    expect(FIGPLUGIN_ASSET_LIST_PATH).toBe('/figplugin/v1/assets/list')
    expect(FIGPLUGIN_ASSET_READ_PATH).toBe('/figplugin/v1/assets/read')
  })

  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)(
    'accepts exact %s metadata including the byte, edge, pixel and TTL boundaries',
    (mimeType) => {
      expect(figPluginSessionAssetSchema.parse({ ...manifest(), mimeType })).toEqual({
        ...manifest(),
        mimeType
      })
      const maximum = {
        ...manifest(),
        host: 'photoshop',
        mimeType,
        width: FIGPLUGIN_ASSET_MAX_EDGE,
        height: FIGPLUGIN_ASSET_MAX_EDGE,
        sizeBytes: FIGPLUGIN_ASSET_MAX_BYTES,
        chunkCount: Math.ceil(FIGPLUGIN_ASSET_MAX_BYTES / FIGPLUGIN_ASSET_CHUNK_BYTES)
      }
      expect(figPluginSessionAssetSchema.parse(maximum)).toEqual(maximum)
      const minimum = { ...manifest(), sizeBytes: 1, expiresAt: manifest().createdAt + 1 }
      expect(figPluginSessionAssetSchema.parse(minimum)).toEqual(minimum)
    }
  )

  it.each([
    { version: 2 },
    { kind: 'host-context-image' },
    { purpose: 'provider-input' },
    { purpose: 'native-write' },
    { sessionId: 'A'.repeat(32) },
    { sessionId: 'a'.repeat(32) + '\n' },
    { pluginId: '../outside' },
    { projectId: '../outside' },
    { projectId: 'owned-project\n' },
    { host: 'illustrator' },
    { assetId: 'B'.repeat(32) },
    { sha256: 'C'.repeat(64) },
    { sha256: 'c'.repeat(64) + '\n' },
    { mimeType: 'image/gif' },
    { mimeType: 'image/svg+xml' },
    { mimeType: 'image/png; charset=utf-8' },
    { sizeBytes: 0 },
    { sizeBytes: 1.5 },
    { sizeBytes: FIGPLUGIN_ASSET_MAX_BYTES + 1 },
    { width: 0 },
    { width: 1.5 },
    { width: FIGPLUGIN_ASSET_MAX_EDGE + 1 },
    { height: 0 },
    { height: FIGPLUGIN_ASSET_MAX_EDGE + 1 },
    { chunkSize: 256 * 1024 },
    { chunkCount: 0 },
    { chunkCount: 2 },
    { createdAt: -1 },
    { createdAt: 0.5 },
    { expiresAt: manifest().createdAt },
    { expiresAt: manifest().createdAt - 1 },
    { expiresAt: manifest().createdAt + FIGPLUGIN_ASSET_TTL_MS + 1 },
    { path: 'C:\\PRIVATE-FIXTURE.png' },
    { url: 'https://example.invalid/PRIVATE-FIXTURE.png' },
    { bytes: [137, 80, 78, 71] },
    { bytesBase64: 'PRIVATE-PIXELS' },
    { sessionToken: 'd'.repeat(64) },
    { profileId: 'PRIVATE-PROVIDER' }
  ])('rejects substituted, out-of-budget or undeclared manifest data: %j', (patch) => {
    expect(figPluginSessionAssetSchema.safeParse({ ...manifest(), ...patch }).success).toBe(false)
  })

  it('accepts only exact main-owned target and hash-bound revoke envelopes, never paths', () => {
    expect(figPluginDesktopAssetTargetSchema.parse(target)).toEqual(target)
    const revoke = { ...target, assetId: manifest().assetId, sha256: manifest().sha256 }
    expect(figPluginDesktopAssetRevokeSchema.parse(revoke)).toEqual(revoke)
    for (const patch of [
      { path: 'C:\\PRIVATE-FIXTURE.png' },
      { url: 'file:///PRIVATE-FIXTURE.png' },
      { token: 'd'.repeat(64) },
      { purpose: 'native-write' },
      { projectId: '' },
      { sessionId: 'not-a-session' },
      { pluginId: '../outside' }
    ]) {
      expect(figPluginDesktopAssetTargetSchema.safeParse({ ...target, ...patch }).success).toBe(
        false
      )
      expect(figPluginDesktopAssetRevokeSchema.safeParse({ ...revoke, ...patch }).success).toBe(
        false
      )
    }
    expect(figPluginDesktopAssetRevokeSchema.safeParse({ ...revoke, sha256: '0' }).success).toBe(
      false
    )
  })

  it('bounds the catalog and rejects duplicate assets or metadata from another session', () => {
    const catalog = {
      protocol: 1,
      purpose: 'local-preview',
      sessionId: target.sessionId,
      assets: []
    }
    expect(figPluginAssetListSchema.parse(catalog)).toEqual(catalog)
    const assets = Array.from({ length: FIGPLUGIN_ASSET_MAX_PER_SESSION }, (_, index) => ({
      ...manifest(),
      assetId: index.toString(16).padStart(32, '0')
    }))
    expect(figPluginAssetListSchema.parse({ ...catalog, assets }).assets).toEqual(assets)
    for (const patch of [
      { assets: [...assets, { ...manifest(), assetId: 'f'.repeat(32) }] },
      { assets: [manifest(), manifest()] },
      { assets: [{ ...manifest(), sessionId: 'e'.repeat(32) }] },
      { purpose: 'provider-input' },
      { sessionToken: 'd'.repeat(64) },
      { path: 'PRIVATE-FIXTURE' }
    ])
      expect(figPluginAssetListSchema.safeParse({ ...catalog, ...patch }).success).toBe(false)
  })

  it('requires explicit local-preview purpose and hash/index-bound reads with no alternate source', () => {
    const list = { protocol: 1, purpose: 'local-preview' }
    expect(figPluginAssetListRequestSchema.parse(list)).toEqual(list)
    expect(figPluginAssetReadRequestSchema.parse(readRequest())).toEqual(readRequest())
    for (const patch of [
      { protocol: 2 },
      { purpose: undefined },
      { purpose: 'provider-input' },
      { purpose: 'native-write' },
      { sessionId: target.sessionId },
      { path: 'C:\\PRIVATE-FIXTURE.png' },
      { url: 'https://example.invalid/PRIVATE-FIXTURE.png' },
      { bytesBase64: 'AA==' }
    ]) {
      expect(figPluginAssetListRequestSchema.safeParse({ ...list, ...patch }).success).toBe(false)
      expect(
        figPluginAssetReadRequestSchema.safeParse({ ...readRequest(), ...patch }).success
      ).toBe(false)
    }
    for (const patch of [
      { assetId: '' },
      { sha256: 'c'.repeat(63) },
      { index: -1 },
      { index: 0.5 },
      { index: Math.ceil(FIGPLUGIN_ASSET_MAX_BYTES / FIGPLUGIN_ASSET_CHUNK_BYTES) }
    ])
      expect(
        figPluginAssetReadRequestSchema.safeParse({ ...readRequest(), ...patch }).success
      ).toBe(false)
  })

  it('uses bounded strict binary chunk frames without leaking credentials into the payload', () => {
    expect(figPluginAssetChunkSchema.parse(chunk())).toEqual(chunk())
    const fullChunk = { ...chunk(), chunk: { ...chunk().chunk, bytesBase64: 'AAAA'.repeat(8192) } }
    expect(Buffer.from(fullChunk.chunk.bytesBase64, 'base64')).toHaveLength(
      FIGPLUGIN_ASSET_CHUNK_BYTES
    )
    expect(figPluginAssetChunkSchema.parse(fullChunk)).toEqual(fullChunk)
    expect(Buffer.byteLength(JSON.stringify(fullChunk))).toBeLessThan(128 * 1024)
    for (const patch of [
      { purpose: 'provider-input' },
      { protocol: 2 },
      { sessionToken: 'd'.repeat(64) },
      { path: 'PRIVATE-FIXTURE' }
    ])
      expect(figPluginAssetChunkSchema.safeParse({ ...chunk(), ...patch }).success).toBe(false)
    for (const patch of [
      { version: 2 },
      { kind: 'content-addressed-binary' },
      { sha256: 'invalid' },
      { index: -1 },
      { index: 0.5 },
      { index: 1 },
      { chunkCount: 0 },
      { bytesBase64: '' },
      { bytesBase64: 'A===' },
      { bytesBase64: 'AB==' },
      { bytesBase64: 'AAB=' },
      { bytesBase64: 'AA==\n' },
      { bytesBase64: 'data:image/png;base64,AA==' },
      { bytesBase64: 'AAAA'.repeat(8193) },
      { path: 'PRIVATE-FIXTURE' }
    ])
      expect(
        figPluginAssetChunkSchema.safeParse({ ...chunk(), chunk: { ...chunk().chunk, ...patch } })
          .success
      ).toBe(false)
  })
})
