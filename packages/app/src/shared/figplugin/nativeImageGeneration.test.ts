import { describe, expect, it } from 'vitest'
import { FIGPLUGIN_BRIDGE_ERRORS } from './bridge'
import {
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_MAX_MS,
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_PREPARE_PATH,
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_STATUS_PATH,
  FIGPLUGIN_NATIVE_IMAGE_GENERATION_CANCEL_PATH,
  figPluginImageGenerationProposalPrepareRequestSchema,
  figPluginImageGenerationProposalPrepareResponseSchema,
  figPluginImageGenerationProposalStatusRequestSchema,
  figPluginImageGenerationProposalStatusSchema,
  figPluginImageGenerationProposalCancelRequestSchema,
  figPluginNativeImageGenerationDesktopProposalSchema,
  figPluginNativeImageGenerationDesktopStateSchema,
  figPluginNativeImageGenerationDesktopKeySchema
} from './nativeImageGeneration'

const createdAt = 1_800_000_000_000
const request = { protocol: 1, requestId: 'a'.repeat(32), sequence: 1, prompt: 'Synthetic square' }
const receipt = {
  protocol: 1,
  requestId: request.requestId,
  proposalId: 'b'.repeat(32),
  status: 'awaiting-approval',
  createdAt,
  expiresAt: createdAt + FIGPLUGIN_NATIVE_IMAGE_GENERATION_MAX_MS
}
const key = { protocol: 1, requestId: receipt.requestId, proposalId: receipt.proposalId }
const status = {
  ...key,
  phase: 'awaiting-approval',
  createdAt,
  updatedAt: createdAt,
  expiresAt: receipt.expiresAt
}
const desktop = {
  proposalId: receipt.proposalId,
  requestId: receipt.requestId,
  generationRequestId: 'c'.repeat(32),
  sessionId: 'd'.repeat(32),
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'owned-project',
  prompt: request.prompt,
  payloadSha256: 'e'.repeat(64),
  createdAt,
  expiresAt: receipt.expiresAt
}

describe('native image generation proposal contracts', () => {
  it('uses three fixed proposal-only routes with a bounded lifetime', () => {
    expect([
      FIGPLUGIN_NATIVE_IMAGE_GENERATION_PREPARE_PATH,
      FIGPLUGIN_NATIVE_IMAGE_GENERATION_STATUS_PATH,
      FIGPLUGIN_NATIVE_IMAGE_GENERATION_CANCEL_PATH
    ]).toEqual([
      '/figplugin/v1/image-generation/prepare',
      '/figplugin/v1/image-generation/status',
      '/figplugin/v1/image-generation/cancel'
    ])
    expect(FIGPLUGIN_NATIVE_IMAGE_GENERATION_MAX_MS).toBe(120_000)
    expect(figPluginImageGenerationProposalPrepareRequestSchema.parse(request)).toEqual(request)
    expect(figPluginImageGenerationProposalPrepareResponseSchema.parse(receipt)).toEqual(receipt)
    expect(figPluginImageGenerationProposalStatusRequestSchema.parse(key)).toEqual(key)
    expect(figPluginImageGenerationProposalCancelRequestSchema.parse(key)).toEqual(key)
    expect(figPluginImageGenerationProposalStatusSchema.parse(status)).toEqual(status)
  })

  it('bounds the original UTF-8 JSON before trimming the prompt', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ ...request, prompt: '' }))
    const exact = { ...request, prompt: 'x' + ' '.repeat(64 * 1024 - overhead - 1) }
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(64 * 1024)
    expect(figPluginImageGenerationProposalPrepareRequestSchema.parse(exact).prompt).toBe('x')
    expect(
      figPluginImageGenerationProposalPrepareRequestSchema.safeParse({
        ...exact,
        prompt: exact.prompt + ' '
      }).success
    ).toBe(false)
    const multibyte = { ...request, prompt: 'x' + '\u3000'.repeat(22_000) }
    expect(JSON.stringify(multibyte).length).toBeLessThan(64 * 1024)
    expect(Buffer.byteLength(JSON.stringify(multibyte))).toBeGreaterThan(64 * 1024)
    expect(figPluginImageGenerationProposalPrepareRequestSchema.safeParse(multibyte).success).toBe(
      false
    )
  })

  it('accepts bounded trimmed prompts and sequences without widening the request', () => {
    expect(
      figPluginImageGenerationProposalPrepareRequestSchema.parse({
        ...request,
        sequence: 1_000_000_000,
        prompt: ' \n synthetic \t '
      })
    ).toEqual({ ...request, sequence: 1_000_000_000, prompt: 'synthetic' })
    expect(
      figPluginImageGenerationProposalPrepareRequestSchema.parse({
        ...request,
        prompt: 'x'.repeat(8192)
      }).prompt
    ).toHaveLength(8192)
  })

  it.each([
    { protocol: 2 },
    { protocol: '1' },
    { requestId: 'A'.repeat(32) },
    { requestId: 'a'.repeat(31) },
    { requestId: 'a'.repeat(32) + '\n' },
    { requestId: 'not-a-native-id' },
    { sequence: 0 },
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: 1_000_000_001 },
    { sequence: '1' },
    { sequence: Number.NaN },
    { prompt: '' },
    { prompt: ' \n\t ' },
    { prompt: 'x'.repeat(8193) },
    { prompt: null }
  ])('refuses invalid native request fields %j', (change) => {
    expect(
      figPluginImageGenerationProposalPrepareRequestSchema.safeParse({ ...request, ...change })
        .success
    ).toBe(false)
  })

  it.each([
    'sessionId',
    'sessionToken',
    'token',
    'pluginId',
    'host',
    'projectId',
    'profileId',
    'profileRevision',
    'provider',
    'baseUrl',
    'apiKey',
    'generationRequestId',
    'proposalId',
    'jobId',
    'approved',
    'reference',
    'url',
    'hostWrite'
  ])('does not accept native authority or configuration field %s', (field) => {
    expect(
      figPluginImageGenerationProposalPrepareRequestSchema.safeParse({
        ...request,
        [field]: 'forbidden'
      }).success
    ).toBe(false)
  })

  it.each([
    { protocol: 2 },
    { requestId: undefined },
    { proposalId: undefined },
    { requestId: 'F'.repeat(32) },
    { proposalId: 'b'.repeat(31) },
    { proposalId: 'b'.repeat(32) + '\n' },
    { sessionId: 'd'.repeat(32) },
    { approved: true },
    { prompt: request.prompt },
    { jobId: 'c'.repeat(32) }
  ])('keeps both status and cancel envelopes complete and strict %j', (change) => {
    for (const schema of [
      figPluginImageGenerationProposalStatusRequestSchema,
      figPluginImageGenerationProposalCancelRequestSchema
    ])
      expect(schema.safeParse({ ...key, ...change }).success).toBe(false)
  })

  it.each([
    { createdAt: -1 },
    { createdAt: createdAt + 0.5 },
    { createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: createdAt },
    { expiresAt: createdAt - 1 },
    { expiresAt: receipt.expiresAt + 1 },
    { expiresAt: Number.POSITIVE_INFINITY }
  ])('rejects invalid native and Desktop lifetimes %j', (change) => {
    expect(
      figPluginImageGenerationProposalPrepareResponseSchema.safeParse({ ...receipt, ...change })
        .success
    ).toBe(false)
    expect(
      figPluginImageGenerationProposalStatusSchema.safeParse({ ...status, ...change }).success
    ).toBe(false)
    expect(
      figPluginNativeImageGenerationDesktopProposalSchema.safeParse({ ...desktop, ...change })
        .success
    ).toBe(false)
  })

  it.each([
    'awaiting-approval',
    'preparing',
    'generating',
    'materializing',
    'awaiting-acceptance',
    'accepted',
    'declined',
    'cancelled',
    'failed'
  ])('exposes only a metadata status for phase %s', (phase) => {
    expect(figPluginImageGenerationProposalStatusSchema.parse({ ...status, phase }).phase).toBe(
      phase
    )
  })

  it('accepts only existing coarse Bridge errors and safe status times', () => {
    for (const error of Object.keys(FIGPLUGIN_BRIDGE_ERRORS))
      expect(figPluginImageGenerationProposalStatusSchema.parse({ ...status, error }).error).toBe(
        error
      )
    for (const change of [
      { error: 'PRIVATE-PROVIDER-ERROR' },
      { phase: 'completed' },
      { phase: 'running' },
      { updatedAt: createdAt - 1 },
      { updatedAt: Number.MAX_SAFE_INTEGER + 1 },
      { updatedAt: 0.5 }
    ])
      expect(
        figPluginImageGenerationProposalStatusSchema.safeParse({ ...status, ...change }).success
      ).toBe(false)
  })

  it.each([
    'prompt',
    'payloadSha256',
    'generationRequestId',
    'jobId',
    'resultId',
    'reference',
    'localMediaUrl',
    'url',
    'path',
    'bytesBase64',
    'output',
    'profileId',
    'profileRevision',
    'apiKey',
    'provider',
    'sessionToken'
  ])('does not leak %s through native responses', (field) => {
    expect(
      figPluginImageGenerationProposalPrepareResponseSchema.safeParse({
        ...receipt,
        [field]: 'PRIVATE-DATA'
      }).success
    ).toBe(false)
    expect(
      figPluginImageGenerationProposalStatusSchema.safeParse({
        ...status,
        phase: 'accepted',
        [field]: 'PRIVATE-DATA'
      }).success
    ).toBe(false)
  })

  it('uses a main-preallocated distinct generation identity only in trusted Desktop proposals', () => {
    expect(figPluginNativeImageGenerationDesktopProposalSchema.parse(desktop)).toEqual(desktop)
    expect(
      figPluginNativeImageGenerationDesktopProposalSchema.parse({ ...desktop, host: 'photoshop' })
        .host
    ).toBe('photoshop')
    expect(
      figPluginNativeImageGenerationDesktopProposalSchema.safeParse({
        ...desktop,
        generationRequestId: desktop.requestId
      }).success
    ).toBe(false)
    expect(
      figPluginNativeImageGenerationDesktopProposalSchema.safeParse({
        ...desktop,
        generationRequestId: undefined
      }).success
    ).toBe(false)
  })

  it.each([
    { host: 'browser' },
    { projectId: '../other-project' },
    { projectId: 'owned-project\n' },
    { payloadSha256: 'E'.repeat(64) },
    { sessionId: 'a'.repeat(31) },
    { generationRequestId: 'c'.repeat(32) + '\n' },
    { sessionToken: 'f'.repeat(64) },
    { approved: true },
    { baseUrl: 'https://example.invalid' }
  ])('rejects altered or augmented Desktop metadata %j', (change) => {
    expect(
      figPluginNativeImageGenerationDesktopProposalSchema.safeParse({ ...desktop, ...change })
        .success
    ).toBe(false)
  })

  it('limits Desktop listing and approval to bounded proposals and their digest keys', () => {
    expect(figPluginNativeImageGenerationDesktopStateSchema.parse({ proposals: [] })).toEqual({
      proposals: []
    })
    expect(
      figPluginNativeImageGenerationDesktopStateSchema.parse({ proposals: Array(32).fill(desktop) })
        .proposals
    ).toHaveLength(32)
    expect(
      figPluginNativeImageGenerationDesktopStateSchema.safeParse({
        proposals: Array(33).fill(desktop)
      }).success
    ).toBe(false)
    const approval = { proposalId: desktop.proposalId, payloadSha256: desktop.payloadSha256 }
    expect(figPluginNativeImageGenerationDesktopKeySchema.parse(approval)).toEqual(approval)
    for (const extra of [
      { requestId: desktop.requestId },
      { generationRequestId: desktop.generationRequestId },
      { prompt: 'Replacement prompt' },
      { sessionId: desktop.sessionId },
      { approved: true },
      { profileId: 'replacement-profile' }
    ])
      expect(
        figPluginNativeImageGenerationDesktopKeySchema.safeParse({ ...approval, ...extra }).success
      ).toBe(false)
  })
})
