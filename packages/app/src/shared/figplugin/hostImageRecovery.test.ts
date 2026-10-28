import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  figPluginRecoveryImagesSchema,
  figPluginRecoveryExecutionImagesSchema,
  recoveryImagesManifestContent,
  validateRecoveryExecutionImages,
  validateRecoveryImagePlanBinding,
  type FigPluginRecoveryImages,
  type FigPluginRecoveryExecutionImages
} from './hostImageRecovery'
import {
  hostPlanSchema,
  stepValue,
  validateHostPlanExecution,
  validateHostPlanReadback,
  type HostContext,
  type HostPlan
} from './hostPlan'
import { createHostPlanningPreview } from './hostPlanPreview'
import { captureTaskRecoveryScope, prepareTaskRecoveryPlan } from './taskRecovery'
import { createHostAdapterLifecycle } from './hostAdapterLifecycle'
import { canonicalFigPluginJson } from './manifest'

function fixture(host: 'figma' | 'photoshop' = 'photoshop') {
  const source = {
    assetId: '1'.repeat(32),
    sha256: '2'.repeat(64),
    mimeType: 'image/png' as const,
    sizeBytes: 123,
    width: 2,
    height: 2
  }
  const oldPlan: HostPlan = {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: '3'.repeat(32),
    steps: [
      host === 'figma'
        ? {
            command: 'image.fill',
            targetId: 'node',
            assetId: source.assetId,
            sha256: source.sha256,
            scaleMode: 'FIT'
          }
        : {
            command: 'image.pixels',
            targetId: 'node',
            assetId: source.assetId,
            sha256: source.sha256
          },
      { command: 'node.rename', targetId: 'node', name: 'Accepted title' }
    ]
  }
  const acceptedEvidence =
    host === 'figma'
      ? {
          kind: 'figma-image-fill' as const,
          sourceSha256: source.sha256,
          nativeImageHash: 'old-native',
          fillsSha256: '4'.repeat(64)
        }
      : {
          kind: 'photoshop-pixels' as const,
          sourceSha256: source.sha256,
          pixelSha256: '5'.repeat(64),
          width: 2,
          height: 2,
          bounds: { left: -2, top: 4, right: 0, bottom: 6 }
        }
  const content = {
    version: 1,
    sourcePlanSha256: createHash('sha256').update(canonicalFigPluginJson(oldPlan)).digest('hex'),
    assets: [source],
    targets: [
      {
        ...oldPlan.steps[0],
        acceptedEvidence,
        ...(host === 'photoshop' ? { pixelEncoding: 'rgba8-srgb-zero-alpha-v1' } : {})
      }
    ]
  }
  const manifest = figPluginRecoveryImagesSchema.parse({
    ...content,
    manifestSha256: createHash('sha256').update(canonicalFigPluginJson(content)).digest('hex')
  })
  const images: FigPluginRecoveryExecutionImages = {
    manifest,
    assetBindings: [{ sourceAssetId: source.assetId, assetId: '6'.repeat(32) }]
  }
  const resources = [{ ...source, assetId: images.assetBindings[0].assetId, expiresAt: 1234567 }]
  const command = host === 'figma' ? 'image.fill' : 'image.pixels'
  const accepted: HostContext = {
    version: 1,
    host,
    documentId: 'document',
    scopeId: 'scope',
    captureId: oldPlan.captureId,
    recoveryIdentity: '7'.repeat(32),
    selectedIds: ['node'],
    execution: {
      mode: 'native-write',
      adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
      supports: [command, 'node.rename'],
      rollback: 'verified-in-place',
      visualAudit: 'hash-only'
    },
    nodes: [
      {
        id: 'node',
        type: host === 'figma' ? 'RECTANGLE' : 'pixel',
        parentId: null,
        ancestors: [],
        locked: false,
        visible: true,
        name: 'Accepted title',
        commands: [command, 'node.rename'],
        ...(host === 'figma'
          ? { imageFill: { status: 'available', fingerprint: '4'.repeat(64) } }
          : {
              imagePixels: {
                status: 'available',
                historyStateId: 99,
                width: 2,
                height: 2,
                bounds: { left: -2, top: 4, right: 0, bottom: 6 }
              }
            })
      }
    ]
  }
  const current = structuredClone(accepted)
  current.captureId = '8'.repeat(32)
  current.nodes[0].name = 'Later title'
  if (current.nodes[0].imagePixels?.status === 'available') {
    current.nodes[0].imagePixels = {
      status: 'available',
      historyStateId: 123,
      width: 3,
      height: 1,
      bounds: { left: 100, top: -5, right: 103, bottom: -4 }
    }
  }
  const scope = captureTaskRecoveryScope(oldPlan, accepted, [{ ...source, expiresAt: 1 }])
  const prepared = prepareTaskRecoveryPlan(oldPlan, scope, current, images)
  const readback = {
    version: 1,
    kind: 'host-plan-readback',
    host,
    documentId: current.documentId,
    scopeId: current.scopeId,
    captureId: current.captureId,
    steps: prepared.plan.steps.map((step) => ({
      command: step.command,
      targetId: step.targetId,
      observation: 'requested',
      value: stepValue(step),
      ...('sha256' in step ? { imageEvidence: structuredClone(acceptedEvidence) } : {})
    }))
  }
  return {
    oldPlan,
    accepted,
    current,
    source,
    scope,
    images,
    resources,
    prepared,
    readback,
    manifest
  }
}

describe('durable accepted image contracts', () => {
  it.each(['figma', 'photoshop'] as const)(
    'remaps %s source IDs without treating old leases or metadata as unchanged proof',
    (host) => {
      const f = fixture(host)
      expect(f.prepared.unchanged).toBe(false)
      expect(f.prepared.plan.captureId).toBe(f.current.captureId)
      expect(f.prepared.plan.steps[0]).toMatchObject({ assetId: f.resources[0].assetId })
      expect(f.oldPlan.steps[0]).toMatchObject({ assetId: f.source.assetId })
      expect(() => validateRecoveryImagePlanBinding(f.prepared.plan, f.images)).not.toThrow()
      expect(() => validateRecoveryImagePlanBinding(f.oldPlan, f.images)).toThrow(
        'IMAGE_RECOVERY_UNBOUND'
      )
      expect(recoveryImagesManifestContent(f.manifest)).not.toContain('manifestSha256')
      expect(
        createHash('sha256').update(recoveryImagesManifestContent(f.manifest)).digest('hex')
      ).toBe(f.manifest.manifestSha256)
      expect(prepareTaskRecoveryPlan(f.oldPlan, f.scope, f.accepted, f.images).unchanged).toBe(
        false
      )
    }
  )

  it('keeps desired accepted placement separate from fresh stale-check and rollback context', () => {
    const f = fixture()
    expect(() => validateHostPlanExecution(f.prepared.plan, f.current, f.resources)).toThrow(
      'IMAGE_RESOURCE_DIMENSIONS'
    )
    expect(() =>
      validateHostPlanExecution(f.prepared.plan, f.current, f.resources, f.images)
    ).not.toThrow()
    expect(
      validateHostPlanReadback(f.prepared.plan, f.current, f.readback, f.resources, f.images)
    ).toEqual(f.readback)
    expect(f.current.nodes[0].imagePixels).toMatchObject({
      historyStateId: 123,
      width: 3,
      height: 1
    })
    const preview = createHostPlanningPreview(
      JSON.stringify(f.prepared.plan),
      f.current,
      f.resources,
      f.images
    )
    expect(preview.differences[0]).toMatchObject({
      before: { width: 3, height: 1 },
      after: { acceptedPixels: { width: 2, height: 2 } }
    })
    expect(
      hostPlanSchema.safeParse({
        ...f.prepared.plan,
        steps: [{ ...f.prepared.plan.steps[0], placement: f.manifest.targets[0].acceptedEvidence }]
      }).success
    ).toBe(false)
  })

  it.each(['pixelSha256', 'bounds'] as const)(
    'rejects requested Photoshop evidence with nonaccepted %s',
    (field) => {
      const f = fixture()
      const evidence = f.readback.steps[0].imageEvidence
      if (evidence?.kind !== 'photoshop-pixels') throw new Error('Expected Photoshop evidence')
      if (field === 'pixelSha256') evidence.pixelSha256 = 'a'.repeat(64)
      else evidence.bounds = { left: 0, top: 0, right: 2, bottom: 2 }
      expect(() =>
        validateHostPlanReadback(f.prepared.plan, f.current, f.readback, f.resources, f.images)
      ).toThrow('INVALID_READBACK')
    }
  )

  it('recreates Figma native handles while retaining accepted source and scale authority', () => {
    const f = fixture('figma')
    const evidence = f.readback.steps[0].imageEvidence
    if (evidence?.kind !== 'figma-image-fill') throw new Error('Expected Figma evidence')
    evidence.nativeImageHash = 'new-native-handle'
    evidence.fillsSha256 = 'b'.repeat(64)
    expect(() =>
      validateHostPlanReadback(f.prepared.plan, f.current, f.readback, f.resources, f.images)
    ).not.toThrow()
    const bad = structuredClone(f.prepared.plan)
    if (bad.steps[0].command !== 'image.fill') throw new Error('Expected image fill')
    bad.steps[0].scaleMode = 'FILL'
    expect(() => validateRecoveryImagePlanBinding(bad, f.images)).toThrow('IMAGE_RECOVERY_UNBOUND')
  })

  it.each([
    (value: FigPluginRecoveryImages) => {
      value.assets[0].sha256 = 'a'.repeat(64)
    },
    (value: FigPluginRecoveryImages) => {
      value.targets[0].acceptedEvidence.sourceSha256 = 'a'.repeat(64)
    },
    (value: FigPluginRecoveryImages) => {
      value.assets.push({ ...value.assets[0] })
    },
    (value: FigPluginRecoveryImages) => {
      value.targets.push({ ...value.targets[0] })
    },
    (value: FigPluginRecoveryImages) => {
      value.assets[0].width = 3
    },
    (value: FigPluginRecoveryImages) => {
      value.assets[0].sizeBytes = 8 * 1024 * 1024 + 1
    }
  ])('rejects malformed, duplicate or cross-bound accepted manifests', (mutate) => {
    const value = fixture().manifest
    mutate(value)
    expect(figPluginRecoveryImagesSchema.safeParse(value).success).toBe(false)
  })

  it('rejects stale IDs, duplicate remaps, extra authority and mutable recovery descriptors', () => {
    const { images } = fixture()
    const checked = validateRecoveryExecutionImages(images)
    expect(Object.isFrozen(checked.manifest.targets[0].acceptedEvidence)).toBe(true)
    expect(() => {
      checked.assetBindings[0].assetId = 'f'.repeat(32)
    }).toThrow()
    for (const assetBindings of [
      [{ ...images.assetBindings[0], assetId: images.manifest.assets[0].assetId }],
      [images.assetBindings[0], images.assetBindings[0]],
      [{ ...images.assetBindings[0], sourceAssetId: 'e'.repeat(32) }]
    ])
      expect(
        figPluginRecoveryExecutionImagesSchema.safeParse({ ...images, assetBindings }).success
      ).toBe(false)
    expect(
      figPluginRecoveryExecutionImagesSchema.safeParse({ ...images, grant: 'local-preview' })
        .success
    ).toBe(false)
  })

  it('passes a separately captured immutable recovery binding through lifecycle validation and native readback', async () => {
    const f = fixture()
    const prepare = vi.fn(({ imageRecovery }) => {
      expect(Object.isFrozen(imageRecovery.manifest.targets[0].acceptedEvidence.bounds)).toBe(true)
    })
    const validate = vi.fn()
    const lifecycle = createHostAdapterLifecycle({
      host: 'photoshop',
      adapterVersion: 'photoshop-uxp-native-1',
      captureContext: () => f.current,
      validatePlan: validate,
      prepareResources: prepare,
      execute: () => {
        const target = f.images.manifest.targets[0]
        if (target.command === 'image.pixels') target.acceptedEvidence.pixelSha256 = 'f'.repeat(64)
        return { effect: 'applied' }
      },
      readback: () => f.readback
    })
    const result = await lifecycle.run({
      runId: 'recovery',
      plan: f.prepared.plan,
      context: f.current,
      resources: f.resources,
      imageRecovery: f.images
    })
    expect(result.status).toBe('completed')
    expect(prepare).toHaveBeenCalledOnce()
    expect(validate.mock.calls[0][3]).toMatchObject({
      manifest: { manifestSha256: f.manifest.manifestSha256 }
    })
  })
})
