import { describe, expect, it } from 'vitest'
import { apiDef } from '../api'
import {
  FIGPLUGIN_MANAGEMENT_ERRORS,
  FigPluginManagementError,
  figPluginManagedConfigureRequestSchema,
  figPluginManagementEmptyRequestSchema,
  figPluginManagedListSchema,
  figPluginManagedSummarySchema,
  figPluginManagedTargetSchema,
  figPluginPackageInstallRequestSchema,
  figPluginPackagePreviewSchema,
  parseFigPluginManagementValue
} from './management'

const preview = {
  receiptId: 'a'.repeat(48),
  expiresAt: 1_800_000_000_000,
  pluginId: 'demo.figma',
  name: 'Demo',
  version: '1.0.0',
  host: 'figma',
  expectedGeneration: 0,
  capabilities: ['dialogue'],
  signerFingerprint: 'b'.repeat(64),
  artifactSha256: 'c'.repeat(64),
  fileCount: 2,
  contentBytes: 256,
  signatureVerified: true,
  publisherTrusted: false,
  executesInDesktop: false
}
const manifestSha256 = 'd'.repeat(64)
const summary = {
  pluginId: 'demo.figma',
  name: 'Demo',
  version: '1.0.0',
  host: 'figma',
  generation: 1,
  capabilities: ['dialogue'],
  manifestSha256,
  materialization: 'verified-package',
  signerFingerprint: 'b'.repeat(64),
  artifactSha256: 'c'.repeat(64),
  fileCount: 2,
  contentBytes: 256,
  configured: false,
  ready: false,
  state: 'disabled',
  cleanupPending: false,
  settings: {}
}

describe('FIGPLUGIN bounded package management contracts', () => {
  it('extends the existing service without a parallel registry or unvalidated IPC', () => {
    for (const method of [
      'listPackages',
      'choosePackage',
      'installPackage',
      'configurePackage',
      'removePackage',
      'copyPackagePath',
      'revealPackage',
      'discardPreview'
    ] as const) {
      const def = apiDef.svcFigPluginCenter[method]
      expect(def.type).toBe('unary')
      expect(def.request).toBeDefined()
      expect(def.response).toBeDefined()
    }
    expect(apiDef.svcFigPluginCenter.execute.type).toBe('unary')
  })

  it('accepts honest verified-but-not-publisher-trusted previews and disabled status', () => {
    expect(figPluginPackagePreviewSchema.parse(preview)).toEqual(preview)
    expect(figPluginManagedSummarySchema.parse(summary)).toEqual(summary)
  })

  it.each([
    { publisherTrusted: true },
    { executesInDesktop: true },
    { signatureVerified: false },
    { receiptId: '../escape' },
    { expectedGeneration: -1 },
    { fileCount: 65 },
    { contentBytes: 8 * 1024 * 1024 + 1 },
    { sourcePath: 'C:/fixture-data/package' },
    { publicKeyPem: 'fixture-public-key' },
    { contentBase64: 'Zml4dHVyZQ==' }
  ])('rejects authority/path/content additions in a preview: %j', (override) => {
    expect(figPluginPackagePreviewSchema.safeParse({ ...preview, ...override }).success).toBe(false)
  })

  it.each([
    { ready: true },
    { state: 'ready' },
    { settings: { api_key: 'fixture-secret' } },
    { files: ['plugin.js'] },
    { path: 'C:/package' }
  ])('forbids unsupported or sensitive listing state: %j', (override) => {
    expect(figPluginManagedSummarySchema.safeParse({ ...summary, ...override }).success).toBe(false)
  })

  it('distinguishes cleanup-only tombstones from usable package materialization', () => {
    const tombstone = {
      ...summary,
      manifestSha256,
      state: 'uninstalled',
      materialization: 'cleanup-pending',
      cleanupPending: true
    }
    expect(figPluginManagedSummarySchema.safeParse(tombstone).success).toBe(true)
    for (const override of [
      { configured: true },
      { cleanupPending: false },
      { settings: { analysisProfileId: 'ref' } },
      { state: 'disabled' }
    ]) {
      expect(figPluginManagedSummarySchema.safeParse({ ...tombstone, ...override }).success).toBe(
        false
      )
    }
    expect(
      figPluginManagedSummarySchema.safeParse({ ...summary, signerFingerprint: undefined }).success
    ).toBe(false)
  })

  it('bounds returned inventory independently from the store scan budget', () => {
    expect(
      figPluginManagedListSchema.safeParse({
        items: Array.from({ length: 256 }, () => ({ ...summary, manifestSha256: 'd'.repeat(64) })),
        truncated: true,
        skippedRecords: 512
      }).success
    ).toBe(true)
    expect(
      figPluginManagedListSchema.safeParse({
        items: Array.from({ length: 257 }, () => ({ ...summary, manifestSha256: 'd'.repeat(64) })),
        truncated: true,
        skippedRecords: 0
      }).success
    ).toBe(false)
    expect(
      figPluginManagedListSchema.safeParse({ items: [], truncated: false, skippedRecords: 513 })
        .success
    ).toBe(false)
  })

  it('allows empty reference settings or bounded model references, not configuration objects', () => {
    const target = { pluginId: 'demo.figma', expectedGeneration: 3 }
    expect(
      figPluginManagedConfigureRequestSchema.parse({ ...target, settings: {} }).settings
    ).toEqual({})
    expect(
      figPluginManagedConfigureRequestSchema.parse({
        ...target,
        settings: { analysisProfileId: 'profile::model' }
      }).settings
    ).toEqual({ analysisProfileId: 'profile::model' })
    for (const settings of [
      { api_key: 'private' },
      { analysisProfile: {} },
      { analysisProfileId: 'a'.repeat(513) },
      { provider: 'openai' }
    ]) {
      expect(
        figPluginManagedConfigureRequestSchema.safeParse({ ...target, settings }).success
      ).toBe(false)
    }
  })

  it('requires generation CAS and no renderer-chosen file paths for installation or path actions', () => {
    const req = {
      receiptId: preview.receiptId,
      expectedGeneration: 0,
      idempotencyKey: 'unique-operation'
    }
    expect(figPluginPackageInstallRequestSchema.parse(req)).toEqual(req)
    for (const value of [
      { ...req, path: '/tmp/file' },
      { ...req, manifest: {} },
      { ...req, expectedGeneration: 0.5 },
      { ...req, idempotencyKey: '' }
    ]) {
      expect(figPluginPackageInstallRequestSchema.safeParse(value).success).toBe(false)
    }
    expect(
      figPluginManagedTargetSchema.safeParse({
        pluginId: 'demo',
        expectedGeneration: 0,
        path: '/tmp/file'
      }).success
    ).toBe(false)
    expect(figPluginManagementEmptyRequestSchema.safeParse({ path: '/tmp/file' }).success).toBe(
      false
    )
  })

  it('sanitizes unknown keys and validation data rather than serializing raw Zod errors', () => {
    try {
      parseFigPluginManagementValue(figPluginManagementEmptyRequestSchema, {
        'fixture-secret': '/tmp/private'
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
      expect(JSON.stringify(error)).not.toContain('fixture-secret')
      expect(JSON.stringify(error)).not.toContain('/tmp/private')
      return
    }
    throw new Error('Expected invalid fixture rejection')
  })

  it.each(
    Object.keys(FIGPLUGIN_MANAGEMENT_ERRORS) as Array<keyof typeof FIGPLUGIN_MANAGEMENT_ERRORS>
  )('uses a fixed safe error message for %s', (code) => {
    const error = new FigPluginManagementError(code)
    expect(error.message).toBe(FIGPLUGIN_MANAGEMENT_ERRORS[code])
    expect(error.cause).toBeUndefined()
    expect(error.payload).toBeUndefined()
  })
})
