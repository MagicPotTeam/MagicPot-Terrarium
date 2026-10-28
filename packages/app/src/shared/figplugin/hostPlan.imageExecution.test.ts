import { describe, expect, it, vi } from 'vitest'
import {
  createHostPlanReadback,
  hostContextSchema,
  hostPlanReadbackSchema,
  nodeValue,
  normalizeHostPlan,
  parseHostPlan,
  stepValue,
  validateHostPlan,
  validateHostPlanExecution,
  validateHostPlanReadback,
  type HostContext,
  type HostPlan
} from './hostPlan'
import { createHostPlanningPreview } from './hostPlanPreview'
import { reviewPlanningResult, validateHostPlan as validateClientPlan } from './hostPlanningClient'
import { createHostAdapterLifecycle } from './hostAdapterLifecycle'
import { captureTaskRecoveryScope, prepareTaskRecoveryPlan } from './taskRecovery'
import type { FigPluginPlanningAssetMetadata } from './hostPlanningAssets'

const asset: FigPluginPlanningAssetMetadata = {
  assetId: 'a'.repeat(32),
  sha256: 'b'.repeat(64),
  mimeType: 'image/png',
  sizeBytes: 10,
  width: 40,
  height: 30,
  expiresAt: 200000
}
const bounds = { left: -10, top: 20, right: 30, bottom: 50 }
const fixture = (host: HostContext['host'] = 'figma') => {
  const command = host === 'figma' ? ('image.fill' as const) : ('image.pixels' as const)
  const context: HostContext = {
    version: 1,
    host,
    documentId: 'document',
    scopeId: 'scope',
    captureId: 'c'.repeat(32),
    selectedIds: ['node'],
    execution: {
      mode: 'native-write',
      adapterVersion: 'fixture',
      supports: [command, 'node.rename'],
      rollback: 'verified-in-place',
      visualAudit: 'hash-only'
    },
    nodes: [
      {
        id: 'node',
        type: host === 'figma' ? 'RECTANGLE' : 'pixel',
        name: 'Before',
        parentId: null,
        ancestors: [],
        locked: false,
        visible: true,
        commands: [command, 'node.rename'],
        ...(host === 'figma'
          ? { imageFill: { status: 'available' as const, fingerprint: 'd'.repeat(64) } }
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
            command,
            targetId: 'node',
            assetId: asset.assetId,
            sha256: asset.sha256,
            scaleMode: 'FIT'
          }
        : { command, targetId: 'node', assetId: asset.assetId, sha256: asset.sha256 }
    ]
  } as HostPlan
  const readback = {
    version: 1,
    kind: 'host-plan-readback',
    host,
    documentId: context.documentId,
    scopeId: context.scopeId,
    captureId: context.captureId,
    steps: [
      {
        targetId: 'node',
        command,
        observation: 'requested',
        value: stepValue(plan.steps[0]),
        imageEvidence:
          host === 'figma'
            ? {
                kind: 'figma-image-fill',
                sourceSha256: asset.sha256,
                nativeImageHash: 'native-image',
                fillsSha256: 'e'.repeat(64)
              }
            : {
                kind: 'photoshop-pixels',
                sourceSha256: asset.sha256,
                pixelSha256: 'e'.repeat(64),
                width: 40,
                height: 30,
                bounds
              }
      }
    ]
  }
  return { context, plan, readback }
}

describe('bound native image plan contracts', () => {
  it.each(['figma', 'photoshop'] as const)(
    'requires reviewed metadata at every %s validation boundary',
    (host) => {
      const { context, plan, readback } = fixture(host)
      const preview = createHostPlanningPreview(JSON.stringify(plan), context, [asset])
      expect(preview.risk).toBe('high')
      const boundaries = [
        (resources?: FigPluginPlanningAssetMetadata[]) =>
          parseHostPlan(JSON.stringify(plan), context, resources),
        (resources?: FigPluginPlanningAssetMetadata[]) =>
          normalizeHostPlan(plan, context, resources),
        (resources?: FigPluginPlanningAssetMetadata[]) =>
          validateHostPlan(plan, context, resources),
        (resources?: FigPluginPlanningAssetMetadata[]) =>
          validateHostPlanExecution(plan, context, resources),
        (resources?: FigPluginPlanningAssetMetadata[]) =>
          validateClientPlan(plan, context, resources),
        (resources?: FigPluginPlanningAssetMetadata[]) =>
          createHostPlanningPreview(JSON.stringify(plan), context, resources),
        (resources?: FigPluginPlanningAssetMetadata[]) =>
          reviewPlanningResult(JSON.stringify(preview), context, resources),
        (resources?: FigPluginPlanningAssetMetadata[]) =>
          createHostPlanReadback(context, context, plan, resources),
        (resources?: FigPluginPlanningAssetMetadata[]) =>
          validateHostPlanReadback(plan, context, readback, resources)
      ]
      for (const validate of boundaries) {
        expect(() => validate()).toThrow('IMAGE_RESOURCE_UNBOUND')
        expect(() => validate([{ ...asset, sha256: 'f'.repeat(64) }])).toThrow(
          'IMAGE_RESOURCE_UNBOUND'
        )
        expect(() => validate([asset])).not.toThrow()
      }
      expect(createHostPlanReadback(context, context, plan, [asset]).steps[0]).toEqual({
        targetId: 'node',
        command: plan.steps[0].command,
        observation: 'unknown'
      })
    }
  )

  it('does not infer host capability, selected scope, or permission from metadata', () => {
    const { context, plan } = fixture()
    context.nodes[0].commands = ['node.rename']
    expect(() => validateHostPlan(plan, context, [asset])).toThrow('UNSUPPORTED_COMMAND')
    context.nodes[0].commands = ['image.fill']
    context.nodes[0].locked = true
    expect(() => validateHostPlan(plan, context, [asset])).toThrow('LOCKED_TARGET')
    context.nodes[0].locked = false
    context.nodes.push({ ...context.nodes[0], id: 'another' })
    context.selectedIds = ['another']
    expect(() => validateHostPlan(plan, context, [asset])).toThrow('OUT_OF_SCOPE')
  })

  it.each(['figma', 'photoshop'] as const)(
    'refuses wrong-host and unavailable %s image descriptors',
    (host) => {
      const { context } = fixture(host)
      const foreign = structuredClone(context)
      foreign.host = host === 'figma' ? 'photoshop' : 'figma'
      expect(hostContextSchema.safeParse(foreign).success).toBe(false)
      const unavailable = structuredClone(context)
      if (host === 'figma') unavailable.nodes[0].imageFill = { status: 'unavailable' }
      else unavailable.nodes[0].imagePixels = { status: 'unavailable' }
      expect(hostContextSchema.safeParse(unavailable).success).toBe(false)
      unavailable.nodes[0].commands = ['node.rename']
      expect(hostContextSchema.safeParse(unavailable).success).toBe(true)
      expect(hostContextSchema.safeParse({ ...context, resources: [asset] }).success).toBe(false)
    }
  )

  it('requires exact resource dimensions and bounded integral pixel placement', () => {
    const { context, plan } = fixture('photoshop')
    expect(() => validateHostPlan(plan, context, [{ ...asset, width: 41 }])).toThrow(
      'IMAGE_RESOURCE_DIMENSIONS'
    )
    for (const pixels of [
      { ...context.nodes[0].imagePixels, width: 41 },
      { ...context.nodes[0].imagePixels, historyStateId: Number.MAX_SAFE_INTEGER + 1 },
      { ...context.nodes[0].imagePixels, bounds: { ...bounds, left: -10.5 } },
      { ...context.nodes[0].imagePixels, bounds: { ...bounds, left: -10000001 } }
    ]) {
      expect(
        hostContextSchema.safeParse({
          ...context,
          nodes: [{ ...context.nodes[0], imagePixels: pixels }]
        }).success
      ).toBe(false)
    }
  })

  it('rejects URLs, paths, extra properties, duplicate metadata and excessive resource counts', () => {
    const { context, plan } = fixture()
    for (const extra of [
      { url: 'https://example.test/image.png' },
      { pathname: 'C:/image.png' },
      { confirmed: true }
    ]) {
      expect(() =>
        parseHostPlan(
          JSON.stringify({ ...plan, steps: [{ ...plan.steps[0], ...extra }] }),
          context,
          [asset]
        )
      ).toThrow()
      expect(() => validateHostPlan(plan, context, [{ ...asset, ...extra }])).toThrow()
    }
    expect(() => validateHostPlan(plan, context, [asset, asset])).toThrow()
    expect(() =>
      validateHostPlan(
        plan,
        context,
        Array.from({ length: 5 }, (_, i) => ({ ...asset, assetId: String(i).repeat(32) }))
      )
    ).toThrow()
    expect(() =>
      parseHostPlan(
        JSON.stringify({ ...plan, steps: [{ ...plan.steps[0], scaleMode: 'CROP' }] }),
        context,
        [asset]
      )
    ).toThrow()
  })

  it.each(['figma', 'photoshop'] as const)(
    'requires native requested %s evidence without treating its hashes as proof of execution',
    (host) => {
      const { context, plan, readback } = fixture(host)
      expect(validateHostPlanReadback(plan, context, readback, [asset]).steps[0].observation).toBe(
        'requested'
      )
      const row = readback.steps[0]
      for (const imageEvidence of [
        undefined,
        { ...row.imageEvidence, sourceSha256: 'f'.repeat(64) },
        { ...row.imageEvidence, unexpected: true }
      ]) {
        expect(() =>
          validateHostPlanReadback(
            plan,
            context,
            { ...readback, steps: [{ ...row, imageEvidence }] },
            [asset]
          )
        ).toThrow()
      }
      expect(() =>
        validateHostPlanReadback(
          plan,
          context,
          {
            ...readback,
            steps: [{ ...row, value: { ...(row.value as object), sha256: 'f'.repeat(64) } }]
          },
          [asset]
        )
      ).toThrow()
      const original = {
        targetId: 'node',
        command: row.command,
        observation: 'original',
        value: nodeValue(context.nodes[0], row.command)
      }
      expect(() =>
        validateHostPlanReadback(plan, context, { ...readback, steps: [original] }, [asset])
      ).not.toThrow()
      expect(() =>
        validateHostPlanReadback(
          plan,
          context,
          { ...readback, steps: [{ ...original, imageEvidence: row.imageEvidence }] },
          [asset]
        )
      ).toThrow()
      expect(() =>
        validateHostPlanReadback(
          plan,
          context,
          {
            ...readback,
            steps: [
              {
                targetId: 'node',
                command: row.command,
                observation: 'unknown',
                imageEvidence: row.imageEvidence
              }
            ]
          },
          [asset]
        )
      ).toThrow()
    }
  )

  it('binds Photoshop evidence to approved full-layer dimensions and bounds', () => {
    const { context, plan, readback } = fixture('photoshop')
    const row = readback.steps[0]
    for (const imageEvidence of [
      { ...row.imageEvidence, width: 39 },
      { ...row.imageEvidence, bounds: { ...bounds, left: -9, right: 31 } },
      {
        kind: 'figma-image-fill',
        sourceSha256: asset.sha256,
        nativeImageHash: 'x',
        fillsSha256: 'e'.repeat(64)
      }
    ])
      expect(() =>
        validateHostPlanReadback(
          plan,
          context,
          { ...readback, steps: [{ ...row, imageEvidence }] },
          [asset]
        )
      ).toThrow()
  })

  it('rejects evidence on non-image commands and empty or overlong native image identifiers', () => {
    const { readback } = fixture()
    const row = readback.steps[0]
    expect(
      hostPlanReadbackSchema.safeParse({
        ...readback,
        steps: [{ ...row, command: 'node.rename', value: 'After' }]
      }).success
    ).toBe(false)
    for (const nativeImageHash of ['', ' '.repeat(10), 'x'.repeat(257)])
      expect(
        hostPlanReadbackSchema.safeParse({
          ...readback,
          steps: [{ ...row, imageEvidence: { ...row.imageEvidence, nativeImageHash } }]
        }).success
      ).toBe(false)
  })

  it('passes immutable resources through lifecycle validation and readback; absent resources stop before prepare', async () => {
    const { context, plan, readback } = fixture()
    const prepare = vi.fn(() => ({ decoded: true }))
    const resources = [structuredClone(asset)]
    const lifecycle = createHostAdapterLifecycle({
      host: 'figma',
      adapterVersion: 'fixture',
      captureContext: () => context,
      validatePlan: (_plan, _context, metadata) => {
        expect(metadata?.[0].sha256).toBe(asset.sha256)
      },
      prepareResources: prepare,
      execute: () => {
        resources[0].sha256 = 'f'.repeat(64)
        return { effect: 'applied' }
      },
      readback: () => readback
    })
    expect((await lifecycle.run({ runId: 'missing', plan, context })).status).toBe('failed')
    expect(prepare).not.toHaveBeenCalled()
    expect((await lifecycle.run({ runId: 'image', plan, context, resources })).status).toBe(
      'completed'
    )
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('refuses property-only task checkpoint recovery for image plans', () => {
    const { context, plan } = fixture()
    context.recoveryIdentity = 'f'.repeat(32)
    expect(() => captureTaskRecoveryScope(plan, context)).toThrow('IMAGE_RESOURCE_UNBOUND')
    const scope = captureTaskRecoveryScope(plan, context, [asset])
    expect(() => prepareTaskRecoveryPlan(plan, scope, context)).toThrow('IMAGE_RECOVERY_UNBOUND')
  })

  it('leaves non-image behavior and missing-resource compatibility unchanged', () => {
    const { context, plan } = fixture()
    plan.steps = [{ command: 'node.rename', targetId: 'node', name: 'After' }]
    const preview = createHostPlanningPreview(JSON.stringify(plan), context)
    expect(preview.risk).toBe('low')
    expect(reviewPlanningResult(JSON.stringify(preview), context)).toContain('PLAN READY')
    expect(createHostPlanReadback(context, context, plan).steps[0].observation).toBe('original')
  })
})
