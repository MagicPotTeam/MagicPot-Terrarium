import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  figPluginExecutionPreviewSchema,
  type FigPluginExecutionPreview
} from '@shared/figplugin/execution'
import { FIGPLUGIN_ASSET_CHUNK_BYTES } from '@shared/figplugin/hostAssets'
import {
  executionAssetMetadata,
  type FigPluginExecutionAsset
} from '@shared/figplugin/hostExecutionAssets'
import type { HostContext, HostPlan } from '@shared/figplugin/hostPlan'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import {
  recoveryImagesManifestContent,
  type FigPluginRecoveryImages
} from '@shared/figplugin/hostImageRecovery'
import {
  buildPlanExecutionApprovalDetails,
  buildVisualBaselineApprovalDetails
} from './bridgeApprovalDetails'

const now = Date.parse('2026-10-26T00:00:00Z')
const bounds = { left: -10, top: 20, right: 30, bottom: 50 }
const fixture = (host: 'figma' | 'photoshop', scaleMode: 'FILL' | 'FIT' = 'FILL') => {
  const asset: FigPluginExecutionAsset = {
    version: 1,
    kind: 'execution-image-asset',
    purpose: 'host-plan-execution',
    sessionId: '1'.repeat(32),
    pluginId: 'synthetic.plugin',
    projectId: 'synthetic-project',
    host,
    assetId: '2'.repeat(32),
    sha256: '3'.repeat(64),
    mimeType: 'image/png',
    sizeBytes: 234,
    width: 40,
    height: 30,
    chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
    chunkCount: 1,
    createdAt: now - 1000,
    expiresAt: now + 119_000
  }
  const command = host === 'figma' ? 'image.fill' : 'image.pixels'
  const context: HostContext = {
    version: 1,
    host,
    documentId: 'synthetic-document',
    scopeId: 'synthetic-scope',
    captureId: '4'.repeat(32),
    selectedIds: ['exact-target'],
    execution: {
      mode: 'native-write',
      adapterVersion: `synthetic-${host}-adapter`,
      supports: [command],
      rollback: 'verified-in-place',
      visualAudit: 'hash-only'
    },
    nodes: [
      {
        id: 'exact-target',
        type: host === 'figma' ? 'RECTANGLE' : 'pixel',
        name: 'Synthetic target',
        parentId: null,
        ancestors: [],
        locked: false,
        visible: true,
        commands: [command],
        ...(host === 'figma'
          ? { imageFill: { status: 'available' as const, fingerprint: '5'.repeat(64) } }
          : {
              imagePixels: {
                status: 'available' as const,
                historyStateId: 7,
                bounds,
                width: 40,
                height: 30
              }
            })
      }
    ]
  }
  const plan: HostPlan = {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: context.captureId,
    steps: [
      host === 'figma'
        ? {
            command: 'image.fill',
            targetId: 'exact-target',
            assetId: asset.assetId,
            sha256: asset.sha256,
            scaleMode
          }
        : {
            command: 'image.pixels',
            targetId: 'exact-target',
            assetId: asset.assetId,
            sha256: asset.sha256
          }
    ]
  }
  const planned = createHostPlanningPreview(JSON.stringify(plan), context, [
    executionAssetMetadata(asset)
  ])
  const preview = figPluginExecutionPreviewSchema.parse({
    protocol: 1,
    executionId: '6'.repeat(32),
    callId: '7'.repeat(32),
    pluginId: asset.pluginId,
    host,
    projectId: asset.projectId,
    documentId: context.documentId,
    scopeId: context.scopeId,
    captureId: context.captureId,
    plan: planned.plan,
    executionAssets: [asset],
    planSha256: '8'.repeat(64),
    contextSha256: '9'.repeat(64),
    adapterVersion: planned.execution!.adapterVersion,
    rollback: planned.execution!.rollback,
    visualAudit: planned.execution!.visualAudit,
    risk: planned.risk,
    differences: planned.differences,
    state: 'awaiting-approval',
    requiresWriteApproval: true,
    createdAt: now,
    expiresAt: now + 60_000
  })
  return { asset, preview }
}

describe('native IMAGE WRITE consent details', () => {
  it.each(['figma', 'photoshop'] as const)(
    'discloses the complete %s execution identity, TTL and exact original-image grant',
    (host) => {
      const { asset, preview } = fixture(host)
      const details = buildPlanExecutionApprovalDetails(preview)
      for (const line of [
        `Plugin: ${preview.pluginId} (${host})`,
        `Project: ${preview.projectId}`,
        `Execution: ${preview.executionId}`,
        `Call: ${preview.callId}`,
        `Document: ${preview.documentId}`,
        `Scope: ${preview.scopeId}`,
        `Capture: ${preview.captureId}`,
        `Created at (Unix ms): ${preview.createdAt}`,
        `Expires at (Unix ms): ${preview.expiresAt}`,
        'Write lifetime (ms): 60000',
        'Risk: high',
        `Adapter: ${preview.adapterVersion}`,
        `Plan SHA-256: ${preview.planSha256}`,
        `Context SHA-256: ${preview.contextSha256}`,
        JSON.stringify(preview.executionAssets, null, 2),
        JSON.stringify(preview.differences, null, 2)
      ])
        expect(details).toContain(line)
      expect(preview.executionAssets).toEqual([asset])
      expect(details).toContain('separate from local-preview and model-metadata consent')
      expect(details).toContain(
        'only for this claimed action and plan, before the displayed expiry'
      )
      expect(details).toContain('EXIF, location and color profiles, is not stripped')
      expect(details).toContain('sends no image pixels to a model')
      expect(details).toContain('cannot recall bytes already read')
      expect(details).toContain('A separate checkpoint acceptance is required')
      expect(details).toContain('Automatic image visual correction remains unsupported')
      expect(details).toContain('This is not a full-document backup.')
      expect(details).toContain('Model-send approval is separate and does not grant this write.')
      expect(details).not.toContain('Operation: restore accepted task properties')
      expect(details).not.toContain('Operation: bounded visual correction')
    }
  )

  it.each(['FILL', 'FIT'] as const)(
    'shows the exact Figma %s mode and ownership-limited ALL-fill replacement',
    (mode) => {
      const { preview } = fixture('figma', mode)
      const details = buildPlanExecutionApprovalDetails(preview)
      expect(details).toContain(`"scaleMode": "${mode}"`)
      expect(details).toContain('"targetId": "exact-target"')
      expect(details).toContain('replaces ALL fills')
      expect(details).toContain('does not resize or move the node')
      expect(details).toContain('still-owned in-flight transaction')
      expect(details).toContain('must not overwrite later user edits')
      expect(details).toContain('Rollback: verified-in-place')
      expect(details).not.toContain('Photoshop image.pixels')
    }
  )

  it('shows the Photoshop approved rectangle and exact-size ALL-layer-pixel replacement, never a patch', () => {
    const { preview } = fixture('photoshop')
    const details = buildPlanExecutionApprovalDetails(preview)
    expect(preview.differences[0].before).toEqual({
      historyStateId: 7,
      bounds,
      width: 40,
      height: 30
    })
    for (const [name, value] of Object.entries(bounds))
      expect(details).toContain(`"${name}": ${value}`)
    expect(details).toContain('"width": 40')
    expect(details).toContain('"height": 30')
    expect(details).toContain('replaces ALL pixels of the existing target layer')
    expect(details).toContain('NOT a region-only patch')
    expect(details).toContain('exactly match the approved rectangle; no scaling')
    expect(details).toContain('Transparent borders may shrink')
    expect(details).toContain('RGB/sRGB/8-bit pixel layers')
    expect(details).toContain('128 MiB live native allocation ceiling')
    expect(details).toContain('canonical RGBA pixels, not hidden RGB or raw storage identity')
    expect(details).toContain('still-owned native history transaction only')
    expect(details).toContain('must preserve later foreign history')
    expect(details).toContain('Rollback: native-history')
    expect(details).not.toContain('Figma image.fill')
  })

  it('retains ordinary property-plan consent without inventing image grants or replacement semantics', () => {
    const { preview: image } = fixture('figma')
    const preview: FigPluginExecutionPreview = {
      ...image,
      executionAssets: undefined,
      risk: 'low',
      plan: {
        ...image.plan,
        steps: [{ command: 'node.rename', targetId: 'exact-target', name: 'Renamed' }]
      },
      differences: [
        { targetId: 'exact-target', command: 'node.rename', before: 'Old', after: 'Renamed' }
      ]
    }
    const details = buildPlanExecutionApprovalDetails(
      figPluginExecutionPreviewSchema.parse(preview)
    )
    expect(details).toContain('Risk: low')
    expect(details).toContain(JSON.stringify(preview.differences, null, 2))
    expect(details).toContain('Approving grants one host document write for this exact plan.')
    expect(details).not.toContain('Exact execution image grants')
    expect(details).not.toContain('replaces ALL')
    expect(details).not.toContain('Image writes cannot')
  })
})

describe('durable accepted image retention consent', () => {
  it.each(['figma', 'photoshop'] as const)(
    'discloses exact original %s source retention separately from write permission',
    (host) => {
      const { preview, asset } = fixture(host)
      const details = buildVisualBaselineApprovalDetails(preview, {
        protocol: 1,
        executionId: preview.executionId,
        callId: preview.callId,
        state: 'completed',
        completed: 1,
        total: 1,
        effect: 'applied',
        updatedAt: now,
        visualEvidenceSha256: 'a'.repeat(64),
        visualEvidence: [
          {
            targetId: 'exact-target',
            before: { sha256: 'b'.repeat(64), width: 40, height: 30 },
            after: { sha256: 'c'.repeat(64), width: 40, height: 30 },
            changed: true
          }
        ]
      })
      for (const text of [
        'Exact original image files retained by accepting this checkpoint',
        asset.sha256,
        asset.mimeType,
        '234',
        '40',
        '30',
        'EXIF, location and color profiles',
        '8 MiB per source',
        '64 MiB total image storage',
        'up to 24 hours',
        'No sessions, tokens or write grants are saved',
        'new write approval',
        'not a full-document backup',
        'No image source bytes are sent to a model',
        'Automatic image visual correction remains unsupported'
      ])
        expect(details).toContain(text)
      expect(details).not.toContain('bytesBase64')
      expect(details).not.toContain('data:image')
      expect(details).toContain(
        host === 'figma'
          ? 'accepted single-image fill and scale mode'
          : 'accepted canonical pixels and placement'
      )
    }
  )

  it.each(['figma', 'photoshop'] as const)(
    'shows the immutable accepted %s image manifest, fresh grants and separate recovery boundary',
    (host) => {
      const { preview, asset } = fixture(host, 'FIT')
      const oldAssetId = 'a'.repeat(32)
      const manifest: FigPluginRecoveryImages = {
        version: 1,
        sourcePlanSha256: 'b'.repeat(64),
        assets: [
          {
            assetId: oldAssetId,
            sha256: asset.sha256,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
            width: asset.width,
            height: asset.height
          }
        ],
        targets: [
          host === 'figma'
            ? {
                command: 'image.fill',
                targetId: 'exact-target',
                assetId: oldAssetId,
                sha256: asset.sha256,
                scaleMode: 'FIT',
                acceptedEvidence: {
                  kind: 'figma-image-fill',
                  sourceSha256: asset.sha256,
                  nativeImageHash: 'historical-native-handle-not-authority',
                  fillsSha256: 'c'.repeat(64)
                }
              }
            : {
                command: 'image.pixels',
                targetId: 'exact-target',
                assetId: oldAssetId,
                sha256: asset.sha256,
                pixelEncoding: 'rgba8-srgb-zero-alpha-v1',
                acceptedEvidence: {
                  kind: 'photoshop-pixels',
                  sourceSha256: asset.sha256,
                  pixelSha256: 'c'.repeat(64),
                  width: asset.width,
                  height: asset.height,
                  bounds
                }
              }
        ],
        manifestSha256: '0'.repeat(64)
      }
      manifest.manifestSha256 = createHash('sha256')
        .update(recoveryImagesManifestContent(manifest))
        .digest('hex')
      const recovery = {
        baselineId: 'd'.repeat(32),
        sourceExecutionId: 'e'.repeat(32),
        requestId: preview.captureId,
        round: 1,
        maxCorrectionRounds: 3 as const,
        targetIds: ['exact-target'],
        images: {
          manifest,
          assetBindings: [{ sourceAssetId: oldAssetId, assetId: asset.assetId }]
        }
      }
      const parsed = figPluginExecutionPreviewSchema.parse({ ...preview, recovery })
      const details = buildPlanExecutionApprovalDetails(parsed)
      expect(details).toContain('Operation: restore accepted task properties (round 1/3)')
      expect(details).toContain(manifest.manifestSha256)
      expect(details).toContain(JSON.stringify(parsed.recovery!.images, null, 2))
      expect(details).toContain(
        'fresh current state remains the precondition and rollback baseline'
      )
      expect(details).toContain('readable only after this exact recovery action is claimed')
      expect(details).toContain('does not create local-preview access')
      expect(details).toContain('No model is called')
      expect(details).not.toContain('Other properties, images and resources are not restored.')
    }
  )
})
