import { describe, expect, it } from 'vitest'
import { validateServiceValue } from '../api/apiUtils/serviceValidation'
import { figPluginCenterSvcDef } from '../api/svcFigPluginCenter'
import { FIGPLUGIN_ASSET_CHUNK_BYTES, FIGPLUGIN_ASSET_MAX_BYTES } from './hostAssets'
import {
  figPluginDesktopManagedAssetRequestSchema,
  figPluginManagedAssetReferenceSchema,
  type FigPluginManagedAssetReference
} from './managedSessionAsset'

const target = { sessionId: 'a'.repeat(32), pluginId: 'owned.figma', projectId: 'owned-project' }
const reference = (): FigPluginManagedAssetReference => ({
  version: 1,
  kind: 'managed',
  relativePath: 'user-output/synthetic/generated.png',
  sha256: 'b'.repeat(64),
  sizeBytes: 70,
  mimeType: 'image/png',
  originalFileName: 'generated.png'
})
const request = () => ({ ...target, source: { kind: 'managed-media', reference: reference() } })

describe('managed output to session source contract', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)(
    'accepts exact %s reference metadata without granting a session asset',
    (mimeType) => {
      const value = { ...reference(), mimeType }
      expect(figPluginManagedAssetReferenceSchema.parse(value)).toEqual(value)
      expect(figPluginDesktopManagedAssetRequestSchema.parse(request())).toEqual(request())
      expect(
        validateServiceValue(request(), figPluginCenterSvcDef.chooseManagedSessionAsset.request)
      ).toEqual(request())
      expect(value).not.toHaveProperty('assetId')
      expect(value).not.toHaveProperty('sessionId')
      expect(value).not.toHaveProperty('purpose')
    }
  )

  it('accepts exact bounded minima and maxima without normalizing reference identity', () => {
    for (const sizeBytes of [1, FIGPLUGIN_ASSET_MAX_BYTES])
      expect(
        figPluginManagedAssetReferenceSchema.parse({ ...reference(), sizeBytes }).sizeBytes
      ).toBe(sizeBytes)
    const maximum = {
      ...reference(),
      relativePath: 'a'.repeat(1024),
      originalFileName: 'n'.repeat(255)
    }
    expect(figPluginManagedAssetReferenceSchema.parse(maximum)).toEqual(maximum)
    const unicode = { ...reference(), originalFileName: '\u56fe\u50cf.png' }
    expect(figPluginManagedAssetReferenceSchema.parse(unicode)).toEqual(unicode)
  })

  it.each([
    '',
    '/absolute.png',
    '../private.png',
    'a/../private.png',
    './image.png',
    'a/./image.png',
    'a//image.png',
    'a/image.png/',
    'C:/private/image.png',
    'C:\\private\\image.png',
    '\\\\server\\share\\image.png',
    'https://example.invalid/image.png',
    'file:///private/image.png',
    'local-media://image.png',
    'a/image.png?download=1',
    'a/image.png#fragment',
    'a/%2e%2e/image.png',
    'a/%252e%252e/image.png',
    'a/%00.png',
    'a/%zz.png',
    'a/image\u0000.png',
    'a/image\n.png',
    'a'.repeat(1025)
  ])('rejects noncanonical managed relative path %j', (relativePath) => {
    expect(
      figPluginManagedAssetReferenceSchema.safeParse({ ...reference(), relativePath }).success
    ).toBe(false)
  })

  it.each([
    '',
    '.',
    '..',
    ' ',
    ' image.png',
    'image.png ',
    'image.',
    'a/image.png',
    'a\\image.png',
    'C:image.png',
    'file?.png',
    'file*.png',
    'file|.png',
    'file<.png',
    'file>.png',
    'file".png',
    'image\u0000.png',
    'image\n.png',
    'image\u007f.png',
    'image\u0085.png',
    'image\u202e.png',
    'image\u200b.png',
    'CON',
    'con.png',
    'PRN.jpg',
    'AUX.webp',
    'NUL.png',
    'COM1.png',
    'LPT9.png',
    'n'.repeat(256)
  ])('rejects unsafe original filename %j', (originalFileName) => {
    expect(
      figPluginManagedAssetReferenceSchema.safeParse({ ...reference(), originalFileName }).success
    ).toBe(false)
  })

  it.each([
    { version: 2 },
    { kind: 'project-asset' },
    { sha256: 'B'.repeat(64) },
    { sha256: 'b'.repeat(63) },
    { sha256: 'b'.repeat(64) + '\n' },
    { sizeBytes: 0 },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { sizeBytes: Infinity },
    { sizeBytes: FIGPLUGIN_ASSET_MAX_BYTES + 1 },
    { sizeBytes: '70' },
    { mimeType: 'image/gif' },
    { mimeType: 'image/svg+xml' },
    { mimeType: 'IMAGE/PNG' },
    { mimeType: 'image/png; charset=utf-8' },
    { originalFileName: null }
  ])('rejects malformed reference fields %j', (patch) => {
    expect(
      figPluginManagedAssetReferenceSchema.safeParse({ ...reference(), ...patch }).success
    ).toBe(false)
  })

  it('requires every identity field and rejects absent or nonobject sources', () => {
    for (const key of Object.keys(reference())) {
      const value: Record<string, unknown> = { ...reference() }
      delete value[key]
      expect(figPluginManagedAssetReferenceSchema.safeParse(value).success).toBe(false)
    }
    for (const source of [undefined, null, [], 'PRIVATE-SOURCE', { kind: 'file' }, reference()])
      expect(
        figPluginDesktopManagedAssetRequestSchema.safeParse({ ...target, source }).success
      ).toBe(false)
    for (const key of Object.keys(target)) {
      const value: Record<string, unknown> = request()
      delete value[key]
      expect(figPluginDesktopManagedAssetRequestSchema.safeParse(value).success).toBe(false)
    }
  })

  it.each([
    ['url', 'https://example.invalid/PRIVATE-SOURCE.png'],
    ['originalUrl', 'file:///PRIVATE-SOURCE.png'],
    ['mediaId', 'PRIVATE-SOURCE'],
    ['derivatives', []],
    ['owner', 'trusted-user'],
    ['completed', true],
    ['taskId', 'completed-task'],
    ['projectId', target.projectId],
    ['status', 'ready'],
    ['width', 1],
    ['height', 1],
    ['bytesBase64', 'PRIVATE-BYTES'],
    ['sourcePath', 'C:\\PRIVATE-SOURCE.png'],
    ['approved', true]
  ] as const)(
    'rejects undeclared %s at every source/request boundary and sanitizes IPC rejection',
    (key, value) => {
      for (const input of [
        { ...request(), [key]: value },
        { ...target, source: { ...request().source, [key]: value } },
        { ...target, source: { ...request().source, reference: { ...reference(), [key]: value } } }
      ]) {
        // projectId is a real target field, never a permitted source ownership assertion.
        if (
          key === 'projectId' &&
          !Object.hasOwn(input.source, key) &&
          !Object.hasOwn(input.source.reference, key)
        )
          continue
        expect(figPluginDesktopManagedAssetRequestSchema.safeParse(input).success).toBe(false)
        expect(() =>
          validateServiceValue(input, figPluginCenterSvcDef.chooseManagedSessionAsset.request)
        ).toThrow()
        try {
          validateServiceValue(input, figPluginCenterSvcDef.chooseManagedSessionAsset.request)
        } catch (error) {
          expect(String(error)).not.toContain('PRIVATE-')
          expect(JSON.stringify(error)).not.toContain('PRIVATE-')
        }
      }
    }
  )

  it('returns only a strict local-preview descriptor or null, never the managed source or grant claims', () => {
    const response = {
      version: 1,
      kind: 'session-image-asset',
      purpose: 'local-preview',
      ...target,
      host: 'figma',
      assetId: 'c'.repeat(32),
      mimeType: 'image/png',
      sha256: reference().sha256,
      sizeBytes: 70,
      width: 1,
      height: 1,
      chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
      chunkCount: 1,
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_120_000
    }
    const validator = figPluginCenterSvcDef.chooseManagedSessionAsset.response
    expect(validateServiceValue(null, validator)).toBeNull()
    expect(validateServiceValue(response, validator)).toEqual(response)
    for (const patch of [
      { reference: reference() },
      { relativePath: reference().relativePath },
      { owner: 'trusted' },
      { completed: true }
    ])
      expect(() => validateServiceValue({ ...response, ...patch }, validator)).toThrow()
    expect(() => validateServiceValue(reference(), validator)).toThrow()
  })
})
