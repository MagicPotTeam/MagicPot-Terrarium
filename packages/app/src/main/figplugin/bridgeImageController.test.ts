import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import type {
  FigPluginBridgePrepareRequest,
  FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import { planningAssetMetadata } from '@shared/figplugin/hostPlanningAssets'
import { encodeContextPng } from '@shared/figplugin/pixelAuditRuntime'
import type { HostPlan } from '@shared/figplugin/hostPlan'
import { FigPluginBridgeController } from './bridgeController'
import type { startFigPluginBridgeServer } from './bridgeServer'
import type { FigPluginRuntimeDescriptor } from './centerStore'

type Host = FigPluginRuntimeBinding['host']
const clock = 1_800_000_000_000
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(clock)
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const settle = () => vi.advanceTimersByTimeAsync(0)

async function fixture(host: Host) {
  const binding: FigPluginRuntimeBinding = {
    pluginId: `owned.image.${host}`,
    host,
    generation: 1,
    artifactSha256: 'a'.repeat(64),
    signerFingerprint: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64),
    bridgeOrigin: 'http://127.0.0.1:41234',
    projectId: 'owned-image-project',
    profileId: 'metadata-only',
    profileRevision: 'd'.repeat(64)
  }
  const descriptor: FigPluginRuntimeDescriptor = {
    ...binding,
    capabilities: ['dialogue', 'asset-transfer', 'result-transfer'],
    limits: {
      maxPayloadBytes: 65536,
      maxResultBytes: 32768,
      maxConfigBytes: 1024,
      maxCallTimeoutMs: 30000,
      maxConcurrentCalls: 1
    }
  }
  let runtime!: Parameters<typeof startFigPluginBridgeServer>[0]['runtime']
  const model = {
    listProfiles: vi.fn<LLMProxySvc['listProfiles']>().mockResolvedValue({
      profiles: [
        {
          id: binding.profileId,
          model_name: 'Synthetic metadata-only model',
          model_use: 'chat',
          is_vision_model: false,
          configurationRevision: binding.profileRevision,
          context_budget_tokens: 16000
        }
      ]
    }),
    chat: vi.fn<LLMProxySvc['chat']>(),
    cancelConversation: vi
      .fn<LLMProxySvc['cancelConversation']>()
      .mockResolvedValue({ cancelled: true }),
    isProfileRevisionCurrent: () => true,
    onProfileConfigurationChanged: () => () => undefined
  }
  const controller = new FigPluginBridgeController(
    {
      getRuntimeDescriptor: vi.fn().mockResolvedValue(descriptor),
      onRuntimeInvalidated: () => () => undefined
    },
    model,
    {
      startServer: async (options) => {
        runtime = options.runtime
        return { origin: options.origin, close: async () => undefined }
      }
    }
  )
  cleanups.push(() => controller.dispose())
  const resolved = await controller.resolveBinding(
    { pluginId: binding.pluginId, expectedGeneration: binding.generation },
    binding.projectId
  )
  const ticket = await controller.createPairing(resolved)
  const session = await runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: binding.pluginId,
    host,
    artifactSha256: binding.artifactSha256,
    clientNonce: 'e'.repeat(32)
  })
  const target = {
    sessionId: session.sessionId,
    pluginId: binding.pluginId,
    projectId: binding.projectId
  }
  const publish = async (red: number) => {
    const bytes = encodeContextPng(1, 1, new Uint8Array([red, 0, 0, 255]), 4)
    if (!bytes) throw new Error('Synthetic image encoding failed')
    return controller.publishSessionAsset(await controller.beginSessionAssetSelection(target), {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes
    })
  }
  const selected = await publish(10)
  const unselected = await publish(20)
  const command = host === 'figma' ? 'image.fill' : 'image.pixels'
  const nodeId = host === 'figma' ? '1:2' : '42'
  const input: FigPluginBridgePrepareRequest = {
    protocol: 1,
    sequence: 1,
    requestId: 'image-controller',
    featureId: 'plan-preview',
    prompt: 'Use the selected resource on this selected target only.',
    context: {
      selectionRevision: 'f'.repeat(32),
      nodes: [
        {
          id: nodeId,
          type: host === 'figma' ? 'RECTANGLE' : 'pixel',
          name: 'Target',
          locked: false
        }
      ]
    },
    assetReferences: [{ assetId: selected.assetId, sha256: selected.sha256 }],
    hostContext: {
      version: 1,
      host,
      documentId: host === 'figma' ? 'doc' : '7',
      scopeId: host === 'figma' ? 'page' : '7',
      captureId: 'f'.repeat(32),
      selectedIds: [nodeId],
      execution: {
        mode: 'native-write',
        adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
        supports: [command, 'node.rename'],
        rollback: 'verified-in-place',
        visualAudit: 'unavailable'
      },
      nodes: [
        {
          id: nodeId,
          type: host === 'figma' ? 'RECTANGLE' : 'pixel',
          name: 'Target',
          parentId: host === 'figma' ? 'page' : '7',
          ancestors: [],
          locked: false,
          visible: true,
          commands: [command, 'node.rename'],
          ...(host === 'figma'
            ? { imageFill: { status: 'available', fingerprint: '1'.repeat(64) } }
            : {
                imagePixels: {
                  status: 'available',
                  historyStateId: 7,
                  bounds: { left: -3, top: 4, right: -2, bottom: 5 },
                  width: 1,
                  height: 1
                }
              })
        }
      ]
    }
  }
  const plan: HostPlan = {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: input.hostContext!.captureId,
    steps: [
      host === 'figma'
        ? {
            command: 'image.fill',
            targetId: nodeId,
            assetId: selected.assetId,
            sha256: selected.sha256,
            scaleMode: 'FIT'
          }
        : {
            command: 'image.pixels',
            targetId: nodeId,
            assetId: selected.assetId,
            sha256: selected.sha256
          }
    ]
  }
  const run = async (
    proposal: unknown = plan,
    change: Partial<FigPluginBridgePrepareRequest> = {}
  ) => {
    model.chat.mockResolvedValueOnce({ content: JSON.stringify(proposal), finishReason: 'stop' })
    const receipt = await runtime.prepare(session.sessionId, session.sessionToken, {
      ...input,
      ...change
    })
    const preview = controller.desktopState().previews[0]
    expect(model.chat).not.toHaveBeenCalled()
    await controller.approve(receipt.callId, preview.payloadSha256)
    await settle()
    return {
      receipt,
      preview,
      status: await runtime.status(session.sessionId, session.sessionToken, receipt.callId)
    }
  }
  return { controller, runtime, model, input, plan, selected, unselected, session, run }
}

describe.each(['figma', 'photoshop'] as const)('%s image Controller governance', (host) => {
  it('turns exact approved metadata into a separately approved high-risk image plan, without sending source pixels', async () => {
    const f = await fixture(host)
    const { status, preview } = await f.run()
    expect(status).toMatchObject({ status: 'completed' })
    const outgoing = f.model.chat.mock.calls[0][0]
    expect(outgoing.messages).toHaveLength(1)
    expect(outgoing.messages[0]).not.toHaveProperty('attachments')
    expect(JSON.parse(outgoing.messages[0].content as string).assetCatalog).toEqual(
      preview.assetCatalog
    )
    expect(preview.assetCatalog!.assets).toEqual([planningAssetMetadata(f.selected)])
    expect(outgoing.systemPrompt).toContain('source image pixels are NOT included')
    expect(JSON.stringify(outgoing.structuredOutput)).toContain(
      host === 'figma' ? 'image.fill' : 'image.pixels'
    )
    expect(JSON.stringify(outgoing.messages)).not.toContain(f.unselected.assetId)
    expect(JSON.stringify(outgoing.messages)).not.toMatch(
      /bytesBase64|data:image|file:\/\/\/|chunkCount/
    )
    const [execution] = f.controller.planState().previews
    expect(execution).toMatchObject({
      plan: f.plan,
      state: 'awaiting-approval',
      risk: 'high',
      requiresWriteApproval: true
    })
    expect(execution.executionAssets).toHaveLength(1)
    expect(execution.executionAssets![0]).toMatchObject({
      ...planningAssetMetadata(f.selected),
      purpose: 'host-plan-execution',
      sessionId: f.session.sessionId
    })
    const rawStatus = await f.runtime.planStatus(f.session.sessionId, f.session.sessionToken, {
      protocol: 1,
      callId: execution.callId
    })
    expect(rawStatus).not.toHaveProperty('intent')
    await expect(
      f.controller.approvePlanExecution(execution.executionId, '0'.repeat(64))
    ).rejects.toBeDefined()
    await f.controller.approvePlanExecution(execution.executionId, execution.planSha256)
    expect(f.controller.planState().previews[0].state).toBe('approved')
    expect(f.model.chat).toHaveBeenCalledOnce()
  })

  it.each(['unselected', 'wrong-hash', 'no-catalog', 'wrong-host', 'out-of-scope'] as const)(
    'rejects %s image proposals at the actual model-result boundary',
    async (variant) => {
      const f = await fixture(host)
      const proposal = structuredClone(f.plan)
      const step = proposal.steps[0] as Record<string, unknown>
      let change: Partial<FigPluginBridgePrepareRequest> = {}
      if (variant === 'unselected')
        Object.assign(step, { assetId: f.unselected.assetId, sha256: f.unselected.sha256 })
      if (variant === 'wrong-hash')
        step.sha256 = createHash('sha256').update('different bytes').digest('hex')
      if (variant === 'no-catalog') change = { assetReferences: undefined }
      if (variant === 'wrong-host') {
        step.command = host === 'figma' ? 'image.pixels' : 'image.fill'
        if (host === 'photoshop') step.scaleMode = 'FILL'
        else delete step.scaleMode
      }
      if (variant === 'out-of-scope') step.targetId = f.selected.assetId
      const { status } = await f.run(proposal, change)
      expect(status).toMatchObject({ status: 'failed', errorCode: 'UPSTREAM_FAILED' })
      expect(f.model.chat).toHaveBeenCalledOnce()
      expect(f.controller.planState().previews).toEqual([])
    }
  )

  it('does not borrow metadata as native image capability', async () => {
    const f = await fixture(host)
    const context = structuredClone(f.input.hostContext!)
    context.nodes[0].commands = ['node.rename']
    context.execution!.supports = ['node.rename']
    const { status } = await f.run(f.plan, { hostContext: context })
    expect(status).toMatchObject({ status: 'failed' })
    expect(f.controller.planState().previews).toEqual([])
  })
})

it('refuses Photoshop source dimensions that do not match its captured approved rectangle', async () => {
  const f = await fixture('photoshop')
  const context = structuredClone(f.input.hostContext!)
  context.nodes[0].imagePixels = {
    status: 'available',
    historyStateId: 7,
    bounds: { left: -3, top: 4, right: -1, bottom: 5 },
    width: 2,
    height: 1
  }
  const { status } = await f.run(f.plan, { hostContext: context })
  expect(status).toMatchObject({ status: 'failed' })
  expect(f.controller.planState().previews).toEqual([])
})
