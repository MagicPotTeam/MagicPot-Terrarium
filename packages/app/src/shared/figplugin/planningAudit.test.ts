import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  FIGPLUGIN_AUDIT_TTL_MS,
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_MAX_BYTES,
  FIGPLUGIN_AUDIT_MAX_LINE_BYTES,
  figPluginPlanningAuditEventSchema,
  figPluginPlanningModelMetadataSchema,
  figPluginPlanningHistoryRequestSchema,
  figPluginPlanningHistorySchema,
  type FigPluginPlanningAuditEvent,
  type FigPluginPlanningModelMetadata,
  type FigPluginPlanningHistoryRequest,
  type FigPluginPlanningHistory
} from './planningAudit'

const event = (): FigPluginPlanningAuditEvent => ({
  schemaVersion: 1,
  kind: 'planning',
  at: 1000,
  callId: 'a'.repeat(32),
  correlationId: 'b'.repeat(32),
  sequence: 1,
  requestId: 'owned_request',
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'owned-project',
  profileId: 'owned-vision-profile',
  profileRevision: 'c'.repeat(64),
  featureId: 'plan-preview',
  state: 'awaiting-approval',
  durationMs: 0,
  inputBytes: 400,
  estimatedInputTokens: 4200,
  nodeCount: 1,
  imageCount: 1,
  imageBytes: 70
})
const history = (): FigPluginPlanningHistory => ({
  records: [event()],
  truncated: false,
  recordedAt: 1000,
  retentionMs: FIGPLUGIN_AUDIT_TTL_MS,
  maxRecords: FIGPLUGIN_AUDIT_MAX_RECORDS,
  maxBytes: FIGPLUGIN_AUDIT_MAX_BYTES,
  writeFailed: false
})

describe('content-free planning audit contracts', () => {
  it('exports strict schemas with matching types and bounded retention constants', () => {
    expectTypeOf(
      figPluginPlanningAuditEventSchema.parse(event())
    ).toEqualTypeOf<FigPluginPlanningAuditEvent>()
    expectTypeOf(
      figPluginPlanningModelMetadataSchema.parse({})
    ).toEqualTypeOf<FigPluginPlanningModelMetadata>()
    expectTypeOf(
      figPluginPlanningHistoryRequestSchema.parse({})
    ).toEqualTypeOf<FigPluginPlanningHistoryRequest>()
    expectTypeOf(
      figPluginPlanningHistorySchema.parse(history())
    ).toEqualTypeOf<FigPluginPlanningHistory>()
    expect(FIGPLUGIN_AUDIT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(FIGPLUGIN_AUDIT_MAX_RECORDS).toBe(256)
    expect(FIGPLUGIN_AUDIT_MAX_BYTES).toBe(1024 * 1024)
    expect(FIGPLUGIN_AUDIT_MAX_LINE_BYTES).toBe(4096)
    expect(figPluginPlanningAuditEventSchema.parse(event())).toEqual(event())
  })

  it.each(['awaiting-approval', 'running', 'provider-dispatched'] as const)(
    'keeps %s distinct from provider completion',
    (state) => {
      expect(figPluginPlanningAuditEventSchema.safeParse({ ...event(), state }).success).toBe(true)
      for (const patch of [
        { errorCode: 'UPSTREAM_FAILED' },
        { resultBytes: 0 },
        { reportedTotalTokens: 0 }
      ])
        expect(
          figPluginPlanningAuditEventSchema.safeParse({ ...event(), state, ...patch }).success
        ).toBe(false)
    }
  )

  it.each([
    ['cancelled', 'CANCELLED'],
    ['denied', 'DENIED'],
    ['expired', 'EXPIRED'],
    ['failed', 'TIMEOUT'],
    ['failed', 'UPSTREAM_FAILED'],
    ['failed', 'CONFIGURATION_CHANGED']
  ])('requires exact terminal pairing %s/%s', (state, errorCode) => {
    const value = { ...event(), state, errorCode }
    expect(figPluginPlanningAuditEventSchema.safeParse(value).success).toBe(true)
    expect(
      figPluginPlanningAuditEventSchema.safeParse({ ...value, errorCode: undefined }).success
    ).toBe(false)
    expect(
      figPluginPlanningAuditEventSchema.safeParse({
        ...value,
        errorCode: state === 'failed' ? 'DENIED' : 'UPSTREAM_FAILED'
      }).success
    ).toBe(false)
    expect(figPluginPlanningAuditEventSchema.safeParse({ ...value, resultBytes: 1 }).success).toBe(
      false
    )
    expect(
      figPluginPlanningAuditEventSchema.safeParse({ ...value, reportedTotalTokens: 1 }).success
    ).toBe(false)
  })

  it('requires result size on completed calls and accepts only safe reported usage', () => {
    const value = {
      ...event(),
      state: 'completed',
      resultBytes: 32768,
      reportedTotalTokens: Number.MAX_SAFE_INTEGER
    }
    expect(figPluginPlanningAuditEventSchema.safeParse(value).success).toBe(true)
    for (const patch of [
      { resultBytes: undefined },
      { resultBytes: 32769 },
      { resultBytes: -1 },
      { reportedTotalTokens: Number.MAX_SAFE_INTEGER + 1 },
      { reportedTotalTokens: -1 },
      { reportedTotalTokens: 0.1 },
      { errorCode: 'UPSTREAM_FAILED' }
    ])
      expect(figPluginPlanningAuditEventSchema.safeParse({ ...value, ...patch }).success).toBe(
        false
      )
  })

  it.each([
    { at: -1 },
    { at: Infinity },
    { durationMs: 0.5 },
    { durationMs: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: 0 },
    { sequence: 9 },
    { inputBytes: 65537 },
    { estimatedInputTokens: 100001 },
    { nodeCount: 101 },
    { nodeCount: -1 },
    { imageCount: 2 },
    { imageCount: 0 },
    { imageBytes: 0 },
    { imageBytes: 24577 },
    { callId: 'A'.repeat(32) },
    { callId: 'a'.repeat(32) + '\n' },
    { correlationId: '' },
    { profileRevision: 'c'.repeat(63) },
    { requestId: 'r'.repeat(81) },
    { pluginId: 'p'.repeat(129) },
    { projectId: 'p'.repeat(161) },
    { profileId: 'p'.repeat(513) },
    { featureId: 'execute' },
    { kind: 'execution' },
    { host: 'other' },
    { schemaVersion: 2 }
  ])('rejects out-of-contract metadata %j', (patch) => {
    expect(figPluginPlanningAuditEventSchema.safeParse({ ...event(), ...patch }).success).toBe(
      false
    )
  })

  it('supports no-image analysis and the existing 512-character profile identity bound', () => {
    expect(
      figPluginPlanningAuditEventSchema.safeParse({
        ...event(),
        host: 'photoshop',
        featureId: 'read-only-analysis',
        profileId: 'p'.repeat(512),
        imageCount: 0,
        imageBytes: 0,
        nodeCount: 0
      }).success
    ).toBe(true)
  })

  it.each([
    'prompt',
    'context',
    'hostContext',
    'contextImage',
    'bytesBase64',
    'attachments',
    'content',
    'error',
    'errorMessage',
    'stack',
    'apiKey',
    'plan',
    'runId'
  ])('rejects content or authority fields: %s', (key) => {
    expect(
      figPluginPlanningAuditEventSchema.safeParse({ ...event(), [key]: 'PRIVATE' }).success
    ).toBe(false)
  })

  it('shares safe optional model metadata fields without coercion or leaking provider config', () => {
    expect(
      figPluginPlanningModelMetadataSchema.parse({
        provider: 'openai-compatible',
        modelName: 'Owned Vision v2'
      })
    ).toEqual({ provider: 'openai-compatible', modelName: 'Owned Vision v2' })
    expect(figPluginPlanningModelMetadataSchema.parse({})).toEqual({})
    for (const provider of [
      'OpenAI',
      'openai\n',
      'https://example.test',
      '../owned',
      'a'.repeat(65),
      ''
    ])
      expect(figPluginPlanningModelMetadataSchema.shape.provider.safeParse(provider).success).toBe(
        false
      )
    for (const modelName of [
      'SYNTHETIC\nTEXT',
      'x\u0000y',
      'x\u0085y',
      'x\u202ey',
      'x\u200by',
      'x\u2028y',
      'x'.repeat(161),
      ''
    ])
      expect(
        figPluginPlanningModelMetadataSchema.shape.modelName.safeParse(modelName).success
      ).toBe(false)
    expect(
      figPluginPlanningModelMetadataSchema.safeParse({ provider: 'openai', apiKey: 'PRIVATE' })
        .success
    ).toBe(false)
  })

  it('rejects events exceeding the UTF-8 line budget including the newline', () => {
    const value = {
      ...event(),
      requestId: '\0'.repeat(80),
      pluginId: '\0'.repeat(128),
      projectId: '\0'.repeat(160),
      profileId: '\0'.repeat(512)
    }
    expect(Buffer.byteLength(JSON.stringify(value) + '\n')).toBeGreaterThan(
      FIGPLUGIN_AUDIT_MAX_LINE_BYTES
    )
    expect(figPluginPlanningAuditEventSchema.safeParse(value).success).toBe(false)
  })

  it('allows only bounded historical filters and result projections', () => {
    const request = {
      callId: 'd'.repeat(32),
      correlationId: 'e'.repeat(32),
      pluginId: 'owned.figma',
      projectId: 'owned',
      limit: 256
    }
    expect(figPluginPlanningHistoryRequestSchema.parse(request)).toEqual(request)
    for (const patch of [
      { runId: 'd'.repeat(32) },
      { limit: 257 },
      { limit: 0 },
      { callId: 'bad' },
      { provider: 'openai' },
      { prompt: 'PRIVATE' }
    ])
      expect(
        figPluginPlanningHistoryRequestSchema.safeParse({ ...request, ...patch }).success
      ).toBe(false)
    expect(figPluginPlanningHistorySchema.parse(history())).toEqual(history())
    for (const patch of [
      { retentionMs: 0 },
      { maxRecords: 257 },
      { maxBytes: 2 * 1024 * 1024 },
      { records: Array.from({ length: 257 }, event) },
      { recordedAt: -1 },
      { failedClosed: false },
      { sessionToken: 'PRIVATE' },
      { writeFailed: undefined }
    ])
      expect(figPluginPlanningHistorySchema.safeParse({ ...history(), ...patch }).success).toBe(
        false
      )
  })
})
