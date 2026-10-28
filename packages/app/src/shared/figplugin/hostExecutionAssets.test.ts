import { describe, expect, it } from 'vitest'
import {
  FIGPLUGIN_EXECUTION_ASSET_READ_PATH,
  executionAssetFromSessionAsset,
  executionAssetMetadata,
  figPluginExecutionAssetChunkSchema,
  figPluginExecutionAssetReadRequestSchema,
  figPluginExecutionAssetSchema
} from './hostExecutionAssets'
import { figPluginExecutionIntentSchema, figPluginExecutionPreviewSchema } from './execution'

const now = 1_800_000_000_000
const identity = {
  sessionId: '1'.repeat(32),
  pluginId: 'test-plugin',
  host: 'figma' as const,
  projectId: 'project'
}
const session = {
  version: 1,
  kind: 'session-image-asset',
  purpose: 'local-preview',
  ...identity,
  assetId: '2'.repeat(32),
  mimeType: 'image/png',
  sha256: '3'.repeat(64),
  sizeBytes: 1,
  width: 20,
  height: 10,
  chunkSize: 24576,
  chunkCount: 1,
  createdAt: now,
  expiresAt: now + 120000
}
const asset = executionAssetFromSessionAsset(session, identity, now)
const intent = {
  protocol: 1,
  purpose: 'execute-host-plan',
  executionId: '4'.repeat(32),
  callId: '5'.repeat(32),
  pluginId: identity.pluginId,
  host: identity.host,
  documentId: 'document',
  scopeId: 'page',
  captureId: '6'.repeat(32),
  plan: {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: '6'.repeat(32),
    steps: [
      {
        command: 'image.fill',
        targetId: 'node',
        assetId: asset.assetId,
        sha256: asset.sha256,
        scaleMode: 'FILL'
      }
    ]
  },
  planSha256: '7'.repeat(64),
  expiresAt: now + 119000,
  adapterVersion: 'fixture',
  actionId: '8'.repeat(32),
  executionAssets: [asset]
}
const preview = {
  protocol: 1,
  executionId: intent.executionId,
  callId: intent.callId,
  pluginId: identity.pluginId,
  host: identity.host,
  projectId: identity.projectId,
  documentId: intent.documentId,
  scopeId: intent.scopeId,
  captureId: intent.captureId,
  plan: intent.plan,
  planSha256: intent.planSha256,
  contextSha256: '9'.repeat(64),
  adapterVersion: 'fixture',
  rollback: 'verified-in-place',
  visualAudit: 'hash-only',
  risk: 'high',
  differences: [
    {
      targetId: 'node',
      command: 'image.fill',
      before: { fingerprint: 'a'.repeat(64) },
      after: { assetId: asset.assetId, sha256: asset.sha256, scaleMode: 'FILL' }
    }
  ],
  state: 'awaiting-approval',
  requiresWriteApproval: true,
  createdAt: now + 1,
  expiresAt: intent.expiresAt,
  executionAssets: [asset]
}
const request = {
  protocol: 1,
  purpose: 'host-plan-execution',
  callId: intent.callId,
  executionId: intent.executionId,
  actionId: intent.actionId,
  planSha256: intent.planSha256,
  assetId: asset.assetId,
  sha256: asset.sha256,
  index: 0
}
const response = {
  protocol: 1,
  purpose: 'host-plan-execution',
  callId: intent.callId,
  executionId: intent.executionId,
  actionId: intent.actionId,
  planSha256: intent.planSha256,
  sessionId: identity.sessionId,
  assetId: asset.assetId,
  chunk: {
    version: 1,
    kind: 'content-addressed-binary-chunk',
    sha256: asset.sha256,
    index: 0,
    chunkCount: 1,
    bytesBase64: 'AA=='
  }
}

describe('execution-only image resource envelopes', () => {
  it('projects an explicitly caller-bound session descriptor without accepting local-preview as execution authority', () => {
    expect(asset.kind).toBe('execution-image-asset')
    expect(asset.purpose).toBe('host-plan-execution')
    expect(figPluginExecutionAssetSchema.safeParse(session).success).toBe(false)
    expect(() =>
      executionAssetFromSessionAsset(session, { ...identity, sessionId: 'a'.repeat(32) }, now)
    ).toThrow()
    expect(() => executionAssetFromSessionAsset(session, identity, session.expiresAt)).toThrow()
    expect(executionAssetMetadata(asset)).toEqual({
      assetId: asset.assetId,
      sha256: asset.sha256,
      mimeType: 'image/png',
      sizeBytes: 1,
      width: 20,
      height: 10,
      expiresAt: asset.expiresAt
    })
    expect(() => executionAssetMetadata(session)).toThrow()
  })

  it.each([
    { purpose: 'local-preview' },
    { kind: 'session-image-asset' },
    { url: 'https://example.test/image' },
    { path: 'C:/image.png' },
    { chunkSize: 16384 },
    { chunkCount: 2 },
    { sizeBytes: 8388609 },
    { width: 4097 },
    { height: 0 },
    { expiresAt: now + 120001 },
    { createdAt: now + 120000 }
  ])('rejects malformed or over-authorized execution descriptors %j', (change) => {
    expect(figPluginExecutionAssetSchema.safeParse({ ...asset, ...change }).success).toBe(false)
  })

  it('carries only mandatory action binding on the separate bounded endpoint', () => {
    expect(FIGPLUGIN_EXECUTION_ASSET_READ_PATH).toBe('/figplugin/v1/plan/assets/read')
    expect(figPluginExecutionAssetReadRequestSchema.parse(request)).toEqual(request)
    expect(figPluginExecutionAssetChunkSchema.parse(response)).toEqual(response)
    for (const key of ['callId', 'executionId', 'actionId', 'planSha256']) {
      const incomplete = { ...request } as Record<string, unknown>
      delete incomplete[key]
      expect(figPluginExecutionAssetReadRequestSchema.safeParse(incomplete).success).toBe(false)
      const incompleteResponse = { ...response } as Record<string, unknown>
      delete incompleteResponse[key]
      expect(figPluginExecutionAssetChunkSchema.safeParse(incompleteResponse).success).toBe(false)
    }
    for (const extra of [
      { requestId: 'lineage' },
      { runId: 'a'.repeat(32) },
      { correlationId: 'a'.repeat(32) },
      { purpose: 'local-preview' },
      { pathname: 'C:/image.png' }
    ]) {
      expect(
        figPluginExecutionAssetReadRequestSchema.safeParse({ ...request, ...extra }).success
      ).toBe(false)
      expect(figPluginExecutionAssetChunkSchema.safeParse({ ...response, ...extra }).success).toBe(
        false
      )
    }
    for (const bytesBase64 of ['AB==', 'AA==\n', 'AAAA'.repeat(8193)])
      expect(
        figPluginExecutionAssetChunkSchema.safeParse({
          ...response,
          chunk: { ...response.chunk, bytesBase64 }
        }).success
      ).toBe(false)
  })

  it('requires exact image refs in preview and intent, with bounded and matching lease metadata', () => {
    for (const [schema, value] of [
      [figPluginExecutionPreviewSchema, preview],
      [figPluginExecutionIntentSchema, intent]
    ] as const) {
      expect(schema.safeParse(value).success).toBe(true)
      for (const executionAssets of [
        undefined,
        [],
        [asset, asset],
        [{ ...asset, assetId: 'a'.repeat(32) }],
        [{ ...asset, sha256: 'a'.repeat(64) }],
        [{ ...asset, host: 'photoshop' }],
        [{ ...asset, pluginId: 'another-plugin' }],
        [{ ...asset, expiresAt: now + 100 }],
        [asset, { ...asset, assetId: 'a'.repeat(32) }],
        [session]
      ]) {
        expect(schema.safeParse({ ...value, executionAssets }).success).toBe(false)
      }
      const nonImage = {
        ...value,
        plan: {
          ...value.plan,
          steps: [{ command: 'node.rename', targetId: 'node', name: 'After' }]
        }
      }
      expect(schema.safeParse(nonImage).success).toBe(false)
      expect(schema.safeParse({ ...nonImage, executionAssets: undefined }).success).toBe(true)
    }
    expect(
      figPluginExecutionPreviewSchema.safeParse({
        ...preview,
        executionAssets: [{ ...asset, projectId: 'other' }]
      }).success
    ).toBe(false)
    expect(
      figPluginExecutionPreviewSchema.safeParse({ ...preview, createdAt: now - 1 }).success
    ).toBe(false)
    expect(figPluginExecutionPreviewSchema.safeParse({ ...preview, risk: 'medium' }).success).toBe(
      false
    )
  })

  it('requires same-session and project provenance when more than one image is used', () => {
    const second = { ...asset, assetId: 'a'.repeat(32) }
    const value = {
      ...intent,
      plan: {
        ...intent.plan,
        steps: [
          ...intent.plan.steps,
          { ...intent.plan.steps[0], targetId: 'other', assetId: second.assetId }
        ]
      },
      executionAssets: [asset, second]
    }
    expect(figPluginExecutionIntentSchema.safeParse(value).success).toBe(true)
    for (const extra of [{ projectId: 'elsewhere' }, { sessionId: 'b'.repeat(32) }])
      expect(
        figPluginExecutionIntentSchema.safeParse({
          ...value,
          executionAssets: [asset, { ...second, ...extra }]
        }).success
      ).toBe(false)
  })

  it('rejects image recovery without a durable image binding and still rejects visual correction', () => {
    const recovery = {
      baselineId: 'a'.repeat(32),
      sourceExecutionId: 'b'.repeat(32),
      requestId: intent.captureId,
      round: 1,
      maxCorrectionRounds: 3,
      targetIds: ['node']
    }
    const visualCorrection = {
      authorizationId: 'c'.repeat(32),
      baselineId: 'a'.repeat(32),
      sourceExecutionId: 'b'.repeat(32),
      round: 1,
      maxCorrectionRounds: 3,
      authorizedTargetIds: ['node']
    }
    expect(figPluginExecutionPreviewSchema.safeParse({ ...preview, recovery }).success).toBe(false)
    expect(figPluginExecutionIntentSchema.safeParse({ ...intent, recovery }).success).toBe(false)
    expect(
      figPluginExecutionPreviewSchema.safeParse({ ...preview, visualCorrection }).success
    ).toBe(false)
    expect(
      figPluginExecutionIntentSchema.safeParse({
        ...intent,
        visualCorrection,
        visualTargetIds: ['node']
      }).success
    ).toBe(false)
  })
})
