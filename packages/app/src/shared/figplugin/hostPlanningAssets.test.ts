import { describe, expect, it } from 'vitest'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_TTL_MS,
  type FigPluginSessionAsset
} from './hostAssets'
import {
  figPluginPlanningAssetCatalogSchema,
  figPluginPlanningAssetReferenceSchema,
  figPluginPlanningAssetReferencesSchema,
  planningAssetMetadata,
  selectPlanningAssetReferences
} from './hostPlanningAssets'
import {
  figPluginBridgePrepareRequestSchema,
  figPluginBridgePreviewSchema,
  type FigPluginBridgePrepareRequest
} from './bridge'
import { figPluginPlanningAuditEventSchema } from './planningAudit'

const now = 1_800_000_000_000
const identity = {
  sessionId: 'a'.repeat(32),
  pluginId: 'owned.figma',
  projectId: 'owned-project',
  host: 'figma' as const
}
const asset = (index = 1): FigPluginSessionAsset => ({
  ...identity,
  version: 1,
  kind: 'session-image-asset',
  purpose: 'local-preview',
  assetId: index.toString(16).padStart(32, '0'),
  sha256: index.toString(16).padStart(64, '0'),
  mimeType: 'image/png',
  sizeBytes: 70,
  width: 1,
  height: 1,
  chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
  chunkCount: 1,
  createdAt: now - 10,
  expiresAt: now - 10 + FIGPLUGIN_ASSET_TTL_MS
})
const reference = (value = asset()) => ({ assetId: value.assetId, sha256: value.sha256 })
const localCatalog = () => ({
  protocol: 1,
  purpose: 'local-preview',
  sessionId: identity.sessionId,
  assets: [asset(1), asset(2), asset(3)]
})
const planningCatalog = () => ({
  ...identity,
  version: 1,
  kind: 'planning-asset-catalog',
  purpose: 'model-planning-metadata',
  assets: [planningAssetMetadata(asset())]
})
const request = (): FigPluginBridgePrepareRequest => ({
  protocol: 1,
  requestId: 'asset-metadata-only',
  sequence: 1,
  prompt: 'Rename this rectangle',
  context: {
    selectionRevision: 'b'.repeat(32),
    nodes: [{ id: '1:2', type: 'RECTANGLE', name: 'Owned rectangle', locked: false }]
  },
  featureId: 'plan-preview',
  hostContext: {
    version: 1,
    host: 'figma',
    documentId: 'doc',
    scopeId: 'page',
    captureId: 'b'.repeat(32),
    selectedIds: ['1:2'],
    nodes: [
      {
        id: '1:2',
        type: 'RECTANGLE',
        name: 'Owned rectangle',
        parentId: 'page',
        ancestors: [],
        locked: false,
        visible: true,
        commands: ['node.rename']
      }
    ]
  }
})

describe('planning image reference and metadata-only contracts', () => {
  it('selects only the exact requested subset in caller order into detached references', () => {
    const source = localCatalog()
    const selected = [reference(source.assets[2]), reference(source.assets[0])]
    const result = selectPlanningAssetReferences(source, selected, identity, now)
    expect(result).toEqual(selected)
    expect(result).not.toBe(selected)
    expect(result[0]).not.toBe(selected[0])
    source.assets[2].sha256 = 'f'.repeat(64)
    selected[0].assetId = 'f'.repeat(32)
    expect(result).toEqual([reference(asset(3)), reference(asset(1))])
  })

  it('requires one to four distinct exact lowercase hash references, never a local-preview grant', () => {
    const valid = reference()
    expect(figPluginPlanningAssetReferenceSchema.parse(valid)).toEqual(valid)
    expect(
      figPluginPlanningAssetReferencesSchema.parse([1, 2, 3, 4].map((n) => reference(asset(n))))
    ).toHaveLength(4)
    for (const invalid of [
      [],
      [valid, valid],
      [valid, { ...valid, sha256: 'f'.repeat(64) }],
      [1, 2, 3, 4, 5].map((n) => reference(asset(n))),
      [{ ...valid, assetId: 'A'.repeat(32) }],
      [{ ...valid, sha256: `${valid.sha256}\n` }],
      [{ ...valid, purpose: 'local-preview' }],
      [{ ...valid, sessionId: identity.sessionId }],
      [{ ...valid, bytesBase64: 'AAAA' }],
      [{ ...valid, url: 'https://example.invalid/pixel.png' }]
    ])
      expect(figPluginPlanningAssetReferencesSchema.safeParse(invalid).success).toBe(false)
  })

  it('fails closed on forged, expired, duplicate or cross-bound catalog entries', () => {
    const valid = localCatalog()
    for (const refs of [
      [reference(asset(4))],
      [{ ...reference(), sha256: 'f'.repeat(64) }],
      [reference(), reference()]
    ])
      expect(() => selectPlanningAssetReferences(valid, refs, identity, now)).toThrow()
    for (const changed of [
      { sessionId: 'f'.repeat(32) },
      { pluginId: 'other.figma' },
      { projectId: 'other-project' },
      { host: 'photoshop' as const }
    ])
      expect(() =>
        selectPlanningAssetReferences(valid, [reference()], { ...identity, ...changed }, now)
      ).toThrow()
    for (const changed of [
      { expiresAt: now },
      { createdAt: now + 1 },
      { host: 'photoshop' },
      { projectId: 'other-project' },
      { name: 'PRIVATE-NAME' },
      { path: 'C:\\fixture-local\\pixel.png' }
    ])
      expect(() =>
        selectPlanningAssetReferences(
          { ...valid, assets: [{ ...asset(), ...changed }, asset(2)] },
          [reference()],
          identity,
          now
        )
      ).toThrow()
    expect(() =>
      selectPlanningAssetReferences(
        { ...valid, assets: [asset(), asset()] },
        [reference()],
        identity,
        now
      )
    ).toThrow()
    expect(() =>
      selectPlanningAssetReferences(valid, [reference()], identity, Number.NaN)
    ).toThrow()
  })

  it('projects only seven explicitly allowed metadata fields from a validated static asset', () => {
    const input = asset()
    expect(planningAssetMetadata(input)).toEqual({
      assetId: input.assetId,
      sha256: input.sha256,
      mimeType: 'image/png',
      sizeBytes: 70,
      width: 1,
      height: 1,
      expiresAt: input.expiresAt
    })
    for (const extra of ['bytesBase64', 'name', 'path', 'url', 'pixels'])
      expect(() => planningAssetMetadata({ ...input, [extra]: 'PRIVATE' })).toThrow()
    expect(() => planningAssetMetadata({ ...input, chunkCount: 2 })).toThrow()
    expect(() =>
      planningAssetMetadata({ ...input, sizeBytes: FIGPLUGIN_ASSET_MAX_BYTES + 1 })
    ).toThrow()
  })

  it('keeps the model catalog strict, bounded and distinguishable from local-preview transport', () => {
    const input = planningCatalog()
    expect(figPluginPlanningAssetCatalogSchema.parse(input)).toEqual(input)
    for (const invalid of [
      { ...input, purpose: 'local-preview' },
      { ...input, assets: [] },
      { ...input, assets: [input.assets[0], input.assets[0]] },
      { ...input, assets: [1, 2, 3, 4, 5].map((n) => planningAssetMetadata(asset(n))) },
      { ...input, assets: [asset()] },
      { ...input, host: 'browser' },
      { ...input, bytesBase64: 'AAAA' },
      ...['path', 'url', 'name', 'chunkSize', 'chunkCount', 'bytesBase64', 'pixels'].map((key) => ({
        ...input,
        assets: [{ ...input.assets[0], [key]: 'PRIVATE' }]
      }))
    ])
      expect(figPluginPlanningAssetCatalogSchema.safeParse(invalid).success).toBe(false)
  })

  it('accepts references only on exact host planning and never accepts caller-authored metadata', () => {
    const input = { ...request(), assetReferences: [reference()] }
    expect(figPluginBridgePrepareRequestSchema.parse(input)).toEqual(input)
    expect(figPluginBridgePrepareRequestSchema.parse(request())).not.toHaveProperty(
      'assetReferences'
    )
    for (const invalid of [
      { ...input, assetCatalog: planningCatalog() },
      { ...input, featureId: undefined, hostContext: undefined },
      { ...input, hostContext: undefined },
      { ...input, assetReferences: [] },
      { ...input, context: { ...input.context, selectionRevision: 'f'.repeat(32) } }
    ])
      expect(figPluginBridgePrepareRequestSchema.safeParse(invalid).success).toBe(false)
  })

  it('requires the preview catalog and references to match exactly, including host and order', () => {
    const input = request()
    const preview = {
      callId: 'c'.repeat(32),
      pluginId: identity.pluginId,
      host: identity.host,
      projectId: identity.projectId,
      profileId: 'nonvision',
      profileRevision: 'd'.repeat(64),
      context: input.context,
      prompt: input.prompt,
      expiresAt: now + 1000,
      payloadSha256: 'e'.repeat(64),
      estimatedInputTokens: 100,
      featureId: input.featureId,
      hostContext: input.hostContext,
      assetReferences: [reference()],
      assetCatalog: planningCatalog()
    }
    expect(figPluginBridgePreviewSchema.parse(preview)).toEqual(preview)
    for (const invalid of [
      { ...preview, assetReferences: undefined },
      { ...preview, assetCatalog: undefined },
      { ...preview, assetReferences: [reference(asset(2))] },
      { ...preview, assetCatalog: { ...preview.assetCatalog, host: 'photoshop' } },
      { ...preview, assetCatalog: { ...preview.assetCatalog, pluginId: 'other.figma' } },
      { ...preview, assetCatalog: { ...preview.assetCatalog, projectId: 'other-project' } },
      {
        ...preview,
        assetReferences: [reference(asset(2)), reference()],
        assetCatalog: {
          ...preview.assetCatalog,
          assets: [planningAssetMetadata(asset()), planningAssetMetadata(asset(2))]
        }
      }
    ])
      expect(figPluginBridgePreviewSchema.safeParse(invalid).success).toBe(false)
  })

  it('allows only the inseparable bounded planning audit count and catalog digest', () => {
    const event = {
      schemaVersion: 1,
      kind: 'planning',
      at: now,
      callId: 'a'.repeat(32),
      correlationId: 'b'.repeat(32),
      sequence: 1,
      requestId: 'metadata-audit',
      pluginId: identity.pluginId,
      host: identity.host,
      projectId: identity.projectId,
      profileId: 'nonvision',
      profileRevision: 'c'.repeat(64),
      featureId: 'plan-preview',
      state: 'awaiting-approval',
      durationMs: 0,
      inputBytes: 500,
      estimatedInputTokens: 1000,
      nodeCount: 1,
      imageCount: 0,
      imageBytes: 0,
      assetCount: 1,
      assetCatalogSha256: 'd'.repeat(64)
    }
    expect(figPluginPlanningAuditEventSchema.parse(event)).toEqual(event)
    for (const invalid of [
      { ...event, assetCount: undefined },
      { ...event, assetCatalogSha256: undefined },
      { ...event, assetCount: 0 },
      { ...event, assetCount: 5 },
      { ...event, assetCount: 1.5 },
      { ...event, featureId: 'read-only-analysis' },
      { ...event, assetCatalog: planningCatalog() },
      { ...event, assetReferences: [reference()] },
      { ...event, assetIds: [asset().assetId] }
    ])
      expect(figPluginPlanningAuditEventSchema.safeParse(invalid).success).toBe(false)
  })
})
