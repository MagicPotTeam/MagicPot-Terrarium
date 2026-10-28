import { describe, expect, it } from 'vitest'
import { validateServiceValue } from '../api/apiUtils/serviceValidation'
import { figPluginCenterSvcDef } from '../api/svcFigPluginCenter'
import { FIGPLUGIN_BRIDGE_ERRORS } from './bridge'
import {
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_MAX_EDGE,
  FIGPLUGIN_ASSET_MAX_PIXELS
} from './hostAssets'
import {
  FIGPLUGIN_IMAGE_GENERATION_MAX_MS,
  FIGPLUGIN_IMAGE_GENERATION_OPTIONS,
  figPluginImageGenerationAcceptSchema,
  figPluginImageGenerationKeySchema,
  figPluginImageGenerationOutputSchema,
  figPluginImageGenerationRequestSchema,
  figPluginImageGenerationStateSchema,
  supportsFigPluginImageGenerationProfile,
  type FigPluginImageGenerationAccept,
  type FigPluginImageGenerationOutput,
  type FigPluginImageGenerationState
} from './imageGeneration'
import { figPluginManagedConfigureRequestSchema, figPluginManagedSummarySchema } from './management'

const target = { sessionId: 'a'.repeat(32), pluginId: 'owned.figma', projectId: 'owned-project' }
const key = { ...target, requestId: 'b'.repeat(32) }
const createdAt = 1_800_000_000_000
const request = () => ({ ...key, prompt: 'Generate a synthetic green square.' })
const output = (): FigPluginImageGenerationOutput => ({
  ...key,
  jobId: 'c'.repeat(32),
  resultId: 'd'.repeat(32),
  profileId: 'selected-image-profile',
  profileRevision: 'e'.repeat(64),
  createdAt,
  expiresAt: createdAt + FIGPLUGIN_IMAGE_GENERATION_MAX_MS,
  reference: {
    version: 1,
    kind: 'managed',
    relativePath: 'user-output/synthetic/generated.png',
    sha256: 'f'.repeat(64),
    sizeBytes: 70,
    mimeType: 'image/png',
    originalFileName: 'generated.png'
  },
  localMediaUrl: 'local-media:///canonical/root/user-output/synthetic/generated.png',
  width: 1,
  height: 1
})
const state = (): FigPluginImageGenerationState => ({
  ...key,
  jobId: output().jobId,
  phase: 'awaiting-acceptance',
  createdAt,
  updatedAt: createdAt + 1000,
  expiresAt: createdAt + FIGPLUGIN_IMAGE_GENERATION_MAX_MS
})
const acceptance = (): FigPluginImageGenerationAccept => ({
  ...key,
  jobId: output().jobId,
  resultId: output().resultId,
  sha256: output().reference.sha256
})

describe('explicit Desktop image generation request contracts', () => {
  it('uses a strict target and request identity, with a trimmed prompt only on generation', () => {
    expect(figPluginImageGenerationKeySchema.parse(key)).toEqual(key)
    expect(figPluginImageGenerationRequestSchema.parse(request())).toEqual(request())
    expect(
      figPluginImageGenerationRequestSchema.parse({ ...request(), prompt: ' \n square \t ' }).prompt
    ).toBe('square')
    for (const length of [1, 8192]) {
      const prompt = 'x'.repeat(length)
      expect(figPluginImageGenerationRequestSchema.parse({ ...key, prompt }).prompt).toBe(prompt)
    }
    expect(figPluginImageGenerationKeySchema.safeParse(request()).success).toBe(false)
  })

  it.each(['', ' \n\t', 'x'.repeat(8193), null, undefined, 1])(
    'rejects an absent, empty or unbounded prompt %j',
    (prompt) => {
      expect(figPluginImageGenerationRequestSchema.safeParse({ ...key, prompt }).success).toBe(
        false
      )
    }
  )

  it.each([
    { requestId: 'A'.repeat(32) },
    { requestId: 'b'.repeat(31) },
    { requestId: 'b'.repeat(33) },
    { requestId: 'b'.repeat(31) + '\n' },
    { requestId: 'b'.repeat(32) + '\n' },
    { requestId: 1 },
    { sessionId: 'a'.repeat(31) },
    { sessionId: 'A'.repeat(32) },
    { pluginId: '' },
    { projectId: '../another-project' },
    { projectId: 'owned-project\n' }
  ])('rejects malformed request or target identity %j', (patch) => {
    expect(
      figPluginImageGenerationRequestSchema.safeParse({ ...request(), ...patch }).success
    ).toBe(false)
    expect(figPluginImageGenerationKeySchema.safeParse({ ...key, ...patch }).success).toBe(false)
  })

  it.each([
    ['profileId', 'PRIVATE-PROFILE'],
    ['profileRevision', 'e'.repeat(64)],
    ['imageGenerationOptions', { enabled: true }],
    ['comparisonRouting', 'local'],
    ['sourceUrl', 'https://example.invalid/PRIVATE-IMAGE'],
    ['attachments', [{ url: 'PRIVATE-IMAGE' }]],
    ['owner', 'PRIVATE-OWNER'],
    ['approved', true],
    ['bytesBase64', 'PRIVATE-BYTES'],
    ['signal', {}]
  ])('rejects undeclared %s without leaking its payload at IPC validation', (field, value) => {
    const input = { ...request(), [field as string]: value }
    expect(figPluginImageGenerationRequestSchema.safeParse(input).success).toBe(false)
    expect(() =>
      validateServiceValue(input, figPluginCenterSvcDef.generateSessionImage.request)
    ).toThrow()
    try {
      validateServiceValue(input, figPluginCenterSvcDef.generateSessionImage.request)
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-')
      expect(JSON.stringify(error)).not.toContain('PRIVATE-')
    }
  })

  it('requires every request field and accepts no missing or added acceptance identity', () => {
    for (const field of Object.keys(request())) {
      const value: Record<string, unknown> = request()
      delete value[field]
      expect(figPluginImageGenerationRequestSchema.safeParse(value).success).toBe(false)
    }
    expect(figPluginImageGenerationAcceptSchema.parse(acceptance())).toEqual(acceptance())
    for (const field of Object.keys(acceptance())) {
      const value: Record<string, unknown> = acceptance()
      delete value[field]
      expect(figPluginImageGenerationAcceptSchema.safeParse(value).success).toBe(false)
    }
    for (const patch of [
      { jobId: 'C'.repeat(32) },
      { resultId: 'd'.repeat(31) },
      { sha256: 'F'.repeat(64) },
      { sha256: 'f'.repeat(64) + '\n' },
      { approved: true },
      { prompt: request().prompt },
      { reference: output().reference },
      { localMediaUrl: output().localMediaUrl }
    ])
      expect(
        figPluginImageGenerationAcceptSchema.safeParse({ ...acceptance(), ...patch }).success
      ).toBe(false)
  })
})

describe('generated managed output contract', () => {
  it('accepts only bounded managed image metadata, not a session-asset or write grant', () => {
    expect(figPluginImageGenerationOutputSchema.parse(output())).toEqual(output())
    const maximum = {
      ...output(),
      profileId: 'p'.repeat(512),
      reference: { ...output().reference, sizeBytes: FIGPLUGIN_ASSET_MAX_BYTES },
      width: FIGPLUGIN_ASSET_MAX_EDGE,
      height: FIGPLUGIN_ASSET_MAX_EDGE
    }
    expect(figPluginImageGenerationOutputSchema.parse(maximum)).toEqual(maximum)
    expect(maximum.width * maximum.height).toBe(FIGPLUGIN_ASSET_MAX_PIXELS)
    for (const field of ['assetId', 'purpose', 'approved', 'content', 'prompt', 'sourceUrl'])
      expect(output()).not.toHaveProperty(field)
  })

  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)(
    'allows the existing controlled %s MIME allowlist',
    (mimeType) => {
      const value = { ...output(), reference: { ...output().reference, mimeType } }
      expect(figPluginImageGenerationOutputSchema.parse(value)).toEqual(value)
    }
  )

  it.each([
    { jobId: 'C'.repeat(32) },
    { resultId: 'd'.repeat(31) },
    { profileId: '' },
    { profileId: 'p'.repeat(513) },
    { profileRevision: 'E'.repeat(64) },
    { profileRevision: 'e'.repeat(63) },
    { profileRevision: 'e'.repeat(64) + '\n' },
    { createdAt: -1 },
    { createdAt: 0.5 },
    { createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: createdAt },
    { expiresAt: createdAt - 1 },
    { expiresAt: createdAt + FIGPLUGIN_IMAGE_GENERATION_MAX_MS + 1 },
    { expiresAt: Infinity },
    { width: 0 },
    { height: 0 },
    { width: FIGPLUGIN_ASSET_MAX_EDGE + 1 },
    { height: FIGPLUGIN_ASSET_MAX_EDGE + 1 },
    { width: 1.5 },
    { height: NaN },
    { assetId: 'c'.repeat(32) },
    { approved: true },
    { sourceUrl: 'https://example.invalid/private.png' },
    { bytesBase64: 'PRIVATE-BYTES' }
  ])('rejects invalid, oversized or undeclared output fields %j', (patch) => {
    expect(figPluginImageGenerationOutputSchema.safeParse({ ...output(), ...patch }).success).toBe(
      false
    )
  })

  it.each([
    { kind: 'project-asset' },
    { sizeBytes: 0 },
    { sizeBytes: FIGPLUGIN_ASSET_MAX_BYTES + 1 },
    { mimeType: 'image/gif' },
    { mimeType: 'image/svg+xml' },
    { relativePath: '../generated.png' },
    { originalFileName: 'CON.png' },
    { sha256: 'F'.repeat(64) },
    { owner: 'PRIVATE-OWNER' },
    { taskId: 'completed-task' },
    { url: 'https://example.invalid/generated.png' },
    { derivatives: [] }
  ])('retains the existing strict managed-reference boundary %j', (patch) => {
    expect(
      figPluginImageGenerationOutputSchema.safeParse({
        ...output(),
        reference: { ...output().reference, ...patch }
      }).success
    ).toBe(false)
  })

  it('requires every output and managed-reference field', () => {
    for (const field of Object.keys(output())) {
      const value: Record<string, unknown> = output()
      delete value[field]
      expect(figPluginImageGenerationOutputSchema.safeParse(value).success).toBe(false)
    }
    for (const field of Object.keys(output().reference)) {
      const reference: Record<string, unknown> = { ...output().reference }
      delete reference[field]
      expect(
        figPluginImageGenerationOutputSchema.safeParse({ ...output(), reference }).success
      ).toBe(false)
    }
  })

  it.each([
    'https://example.invalid/user-output/synthetic/generated.png',
    'file:///canonical/root/user-output/synthetic/generated.png',
    'data:image/png;base64,AAAA',
    'blob:generated-image',
    'local-media://remote/user-output/synthetic/generated.png',
    'local-media://user:secret@remote/user-output/synthetic/generated.png',
    'local-media:///canonical/root/user-output/synthetic/generated.png?download=1',
    'local-media:///canonical/root/user-output/synthetic/generated.png#fragment',
    'local-media:///canonical/root/user-output/synthetic/other.png',
    'local-media:///canonical/root//user-output/synthetic/generated.png',
    'local-media:///canonical/%00/user-output/synthetic/generated.png',
    'local-media:///canonical/%5c/user-output/synthetic/generated.png',
    'local-media:///canonical/%2f..%2f/user-output/synthetic/generated.png',
    'local-media:relative/user-output/synthetic/generated.png',
    'x'.repeat(4097)
  ])('refuses a remote, unsafe or mismatched local preview URL %j', (localMediaUrl) => {
    expect(
      figPluginImageGenerationOutputSchema.safeParse({ ...output(), localMediaUrl }).success
    ).toBe(false)
  })

  it('allows matching canonical POSIX and encoded Windows local-media paths', () => {
    for (const localMediaUrl of [
      output().localMediaUrl,
      'local-media:///C:/Users/Synthetic%20User/.chat_media/user-output/synthetic/generated.png'
    ])
      expect(
        figPluginImageGenerationOutputSchema.parse({ ...output(), localMediaUrl }).localMediaUrl
      ).toBe(localMediaUrl)
  })
})

describe('image generation state and Desktop API', () => {
  it.each([
    'preparing',
    'awaiting-approval',
    'generating',
    'materializing',
    'awaiting-acceptance',
    'accepted',
    'declined',
    'cancelled',
    'failed'
  ] as const)('carries only bounded state metadata for %s', (phase) => {
    const value = { ...state(), phase }
    expect(figPluginImageGenerationStateSchema.parse(value)).toEqual(value)
  })

  it('permits only enumerated Bridge errors and can record a terminal update after expiry', () => {
    for (const error of Object.keys(FIGPLUGIN_BRIDGE_ERRORS)) {
      const value = { ...state(), phase: 'failed', error, updatedAt: state().expiresAt + 1 }
      expect(figPluginImageGenerationStateSchema.parse(value)).toEqual(value)
    }
    expect(
      figPluginImageGenerationStateSchema.safeParse({ ...state(), error: 'PRIVATE-DETAIL' }).success
    ).toBe(false)
  })

  it.each([
    { jobId: 'C'.repeat(32) },
    { phase: 'completed' },
    { phase: 'running' },
    { createdAt: -1 },
    { updatedAt: createdAt - 1 },
    { updatedAt: Number.MAX_SAFE_INTEGER + 1 },
    { updatedAt: 1.5 },
    { expiresAt: createdAt },
    { expiresAt: createdAt + FIGPLUGIN_IMAGE_GENERATION_MAX_MS + 1 },
    { prompt: 'PRIVATE-PROMPT' },
    { content: 'PRIVATE-CONTENT' },
    { sourceUrl: 'https://example.invalid/private.png' },
    { sourceUrls: ['https://example.invalid/private.png'] },
    { localMediaUrl: output().localMediaUrl },
    { reference: output().reference },
    { errorDetail: 'PRIVATE-ERROR' }
  ])('rejects malformed state or content-bearing fields %j', (patch) => {
    expect(figPluginImageGenerationStateSchema.safeParse({ ...state(), ...patch }).success).toBe(
      false
    )
  })

  it('wires four strict unary Desktop methods with nullable output/state and exact completion results', () => {
    const generate = figPluginCenterSvcDef.generateSessionImage
    const status = figPluginCenterSvcDef.sessionImageGenerationState
    const cancel = figPluginCenterSvcDef.cancelSessionImageGeneration
    const accept = figPluginCenterSvcDef.acceptSessionImageGeneration
    for (const method of [generate, status, cancel, accept]) expect(method.type).toBe('unary')
    expect(validateServiceValue(request(), generate.request)).toEqual(request())
    expect(validateServiceValue(output(), generate.response)).toEqual(output())
    expect(validateServiceValue(null, generate.response)).toBeNull()
    expect(validateServiceValue(key, status.request)).toEqual(key)
    expect(validateServiceValue(state(), status.response)).toEqual(state())
    expect(validateServiceValue(null, status.response)).toBeNull()
    expect(validateServiceValue(key, cancel.request)).toEqual(key)
    expect(validateServiceValue(acceptance(), accept.request)).toEqual(acceptance())
    for (const method of [cancel, accept]) {
      for (const completed of [true, false])
        expect(validateServiceValue({ completed }, method.response)).toEqual({ completed })
      for (const response of [null, {}, { completed: 'true' }, { completed: true, approved: true }])
        expect(() => validateServiceValue(response, method.response)).toThrow()
    }
    for (const method of [status, cancel])
      expect(() => validateServiceValue(request(), method.request)).toThrow()
    expect(() => validateServiceValue(key, accept.request)).toThrow()
    expect(() => validateServiceValue(state(), generate.response)).toThrow()
    expect(() => validateServiceValue(output(), status.response)).toThrow()
  })
})

describe('image generation profile metadata and settings', () => {
  const profile = {
    id: 'selected-image-profile',
    model_name: 'explicit-image-model',
    provider: 'openai',
    model_use: 'image',
    api_mode: 'images'
  }

  it('filters only explicit OpenAI image API metadata, not model names or revision availability', () => {
    for (const api_mode of ['images', 'responses']) {
      for (const call_type of [undefined, 'api']) {
        expect(supportsFigPluginImageGenerationProfile({ ...profile, api_mode, call_type })).toBe(
          true
        )
        expect(
          supportsFigPluginImageGenerationProfile({
            ...profile,
            api_mode,
            call_type,
            is_ocr_model: false,
            configurationRevision: 'not-a-consent-revision'
          })
        ).toBe(true)
      }
    }
    expect(supportsFigPluginImageGenerationProfile({ ...profile, model_name: 'plain-name' })).toBe(
      true
    )
  })

  it.each([
    { provider: 'gemini' },
    { provider: 'OPENAI' },
    { provider: undefined },
    { model_use: 'agent' },
    { model_use: 'vision' },
    { model_use: undefined },
    { api_mode: 'chat-completions' },
    { api_mode: 'auto' },
    { api_mode: undefined },
    { call_type: 'browser' },
    { call_type: 'playwright' },
    { call_type: '' },
    { call_type: null },
    { is_ocr_model: true }
  ])('rejects unsupported profile metadata %j', (patch) => {
    expect(supportsFigPluginImageGenerationProfile({ ...profile, ...patch })).toBe(false)
  })

  it('rejects missing and nonobject metadata without probing a provider', () => {
    for (const value of [undefined, null, false, 'gpt-image-1', [], {}])
      expect(supportsFigPluginImageGenerationProfile(value)).toBe(false)
  })

  it('freezes the bounded generation options without a model or routing override', () => {
    expect(FIGPLUGIN_IMAGE_GENERATION_MAX_MS).toBe(120_000)
    expect(FIGPLUGIN_IMAGE_GENERATION_OPTIONS).toEqual({
      enabled: true,
      action: 'generate',
      outputFormat: 'png',
      size: '1024x1024',
      quality: 'auto',
      background: 'auto'
    })
    expect(Object.isFrozen(FIGPLUGIN_IMAGE_GENERATION_OPTIONS)).toBe(true)
    expect(Reflect.set(FIGPLUGIN_IMAGE_GENERATION_OPTIONS, 'action', 'edit')).toBe(false)
    expect(FIGPLUGIN_IMAGE_GENERATION_OPTIONS.action).toBe('generate')
    expect(FIGPLUGIN_IMAGE_GENERATION_OPTIONS).not.toHaveProperty('model')
    expect(FIGPLUGIN_IMAGE_GENERATION_OPTIONS).not.toHaveProperty('comparisonRouting')
  })

  it('adds an optional image generation profile without changing existing settings', () => {
    const configured = { pluginId: target.pluginId, expectedGeneration: 1 }
    for (const settings of [
      {},
      { analysisProfileId: 'analysis' },
      { backgroundRemovalProfileId: 'background' },
      { imageGenerationProfileId: 'image' },
      { imageGenerationProfileId: 'i'.repeat(512) },
      {
        analysisProfileId: 'analysis',
        backgroundRemovalProfileId: 'background',
        imageGenerationProfileId: 'image'
      }
    ]) {
      const value = { ...configured, settings }
      expect(figPluginManagedConfigureRequestSchema.parse(value)).toEqual(value)
      expect(validateServiceValue(value, figPluginCenterSvcDef.configurePackage.request)).toEqual(
        value
      )
    }
    expect(
      figPluginManagedConfigureRequestSchema.parse({
        ...configured,
        settings: { imageGenerationProfileId: ' image ' }
      }).settings
    ).toEqual({ imageGenerationProfileId: 'image' })
  })

  it.each(['', ' ', 'i'.repeat(513), null, 1, { profileId: 'image' }])(
    'rejects invalid image profile settings %j',
    (imageGenerationProfileId) => {
      expect(
        figPluginManagedConfigureRequestSchema.safeParse({
          pluginId: target.pluginId,
          expectedGeneration: 1,
          settings: { imageGenerationProfileId }
        }).success
      ).toBe(false)
    }
  )

  it('keeps settings strict and preserves the reference in package listings', () => {
    const summary = {
      pluginId: target.pluginId,
      name: 'Synthetic package',
      version: '1.0.0',
      host: 'figma',
      generation: 1,
      capabilities: ['asset-transfer'],
      manifestSha256: 'a'.repeat(64),
      materialization: 'metadata-only',
      fileCount: 0,
      contentBytes: 0,
      configured: true,
      ready: false,
      state: 'disabled',
      cleanupPending: false,
      settings: { imageGenerationProfileId: 'image' }
    }
    expect(figPluginManagedSummarySchema.parse(summary)).toEqual(summary)
    for (const settings of [
      { imageGenerationProfileId: 'image', imageGenerationOptions: {} },
      { imageGenerationProfileId: 'image', profileRevision: 'a'.repeat(64) },
      { imageGenerationProfileId: 'image', approved: true }
    ]) {
      expect(figPluginManagedSummarySchema.safeParse({ ...summary, settings }).success).toBe(false)
      expect(
        figPluginManagedConfigureRequestSchema.safeParse({
          pluginId: target.pluginId,
          expectedGeneration: 1,
          settings
        }).success
      ).toBe(false)
    }
    expect(
      figPluginManagedSummarySchema.safeParse({
        ...summary,
        materialization: 'cleanup-pending',
        state: 'uninstalled',
        configured: false,
        cleanupPending: true
      }).success
    ).toBe(false)
  })
})
