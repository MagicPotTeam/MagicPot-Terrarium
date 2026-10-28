import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import type { HostPlan } from '@shared/figplugin/hostPlan'
import { readExecutionAsset } from '@shared/figplugin/hostExecutionAssetClient'
import { encodeContextPng } from '@shared/figplugin/pixelAuditRuntime'
import type { FigPluginManagedAssetReference } from '@shared/figplugin/managedSessionAsset'
import { disposeFigPluginBridges, FigPluginCenterSvcImpl } from '../api/svcFigPluginCenterImpl'
import { importManagedMedia } from '../llmProxy/managedMediaStore'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { FigPluginBridgeController } from './bridgeController'
import type { startFigPluginBridgeServer } from './bridgeServer'
import type { FigPluginRuntimeDescriptor } from './centerStore'

const native = vi.hoisted(() => ({
  getMediaDir: vi.fn(),
  showMessageBox: vi.fn(),
  showOpenDialog: vi.fn(),
  createFromBuffer: vi.fn(),
  getPath: vi.fn()
}))
vi.mock('../llmProxy/chatMediaDir', () => ({ getChatMediaDir: native.getMediaDir }))
vi.mock('electron', () => ({
  app: { getPath: native.getPath },
  dialog: { showMessageBox: native.showMessageBox, showOpenDialog: native.showOpenDialog },
  nativeImage: { createFromBuffer: native.createFromBuffer },
  clipboard: {},
  shell: {}
}))

const url = 'file:///app/index.html#/workshop/plugins'
const root = path.resolve('D:/owned-managed-output-integration/user/.chat_media')
const network = vi.fn(() => {
  throw new Error('No Provider or network in this fixture')
})
const invocation = (method: string): ServiceInvocationContext => ({
  methodName: `svcFigPluginCenter.${method}`,
  senderId: 42,
  senderUrl: url,
  frameUrl: url,
  isMainFrame: true
})
beforeEach(async () => {
  vi.resetAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
  await fs.mkdir(root, { recursive: true })
  native.getMediaDir.mockReturnValue(root)
  native.getPath.mockImplementation(() => {
    throw new Error('No real app files')
  })
  native.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true })
  native.createFromBuffer.mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 })
  })
  vi.stubGlobal('fetch', network)
})
afterEach(async () => {
  await disposeFigPluginBridges()
  clearMagicAgentTrustedRouteBindingsForTest()
  expect(native.getPath).not.toHaveBeenCalled()
  expect(native.showOpenDialog).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

describe.each(['figma', 'photoshop'] as const)('%s owned managed output integration', (host) => {
  it('reuses the exact app-owned original through real service, Controller and Runtime without another file chooser or implicit write', async () => {
    const bytes = encodeContextPng(1, 1, new Uint8Array([12, 34, 56, 255]), 4)!
    const imported = await importManagedMedia(
      root,
      {
        bytes,
        mimeType: 'image/png',
        originalFileName: 'owned-output.png',
        provenance: { source: 'synthetic completed image output' },
        maxBytes: 65536
      },
      { authorizedRoot: root }
    )
    const source: FigPluginManagedAssetReference = {
      version: 1,
      kind: 'managed',
      relativePath: imported.reference.relativePath,
      sha256: imported.reference.sha256!,
      sizeBytes: imported.reference.sizeBytes!,
      mimeType: 'image/png',
      originalFileName: 'owned-output.png'
    }
    const descriptor: FigPluginRuntimeDescriptor = {
      pluginId: `owned.output.${host}`,
      host,
      generation: 1,
      artifactSha256: 'a'.repeat(64),
      signerFingerprint: 'b'.repeat(64),
      manifestSha256: 'c'.repeat(64),
      bridgeOrigin: 'http://127.0.0.1:41234',
      profileId: 'metadata-only',
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
            id: descriptor.profileId,
            model_name: 'Synthetic metadata model',
            model_use: 'chat',
            is_vision_model: false,
            configurationRevision: 'd'.repeat(64),
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
    const window = {
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), {
        id: 42,
        isDestroyed: () => false,
        getURL: () => url
      })
    }
    registerMagicAgentTrustedRouteBinding(42, undefined, {
      trustedUrl: url,
      trustedWebContents: window.webContents
    })
    const service = new FigPluginCenterSvcImpl(
      undefined,
      () => window as unknown as BrowserWindow,
      async () => controller
    )
    const ticket = await service.createPairing(
      {
        pluginId: descriptor.pluginId,
        expectedGeneration: descriptor.generation,
        projectId: 'owned-project'
      },
      invocation('createPairing')
    )
    if (!ticket) throw new Error('Expected paired fixture')
    const session = await runtime.redeem({
      protocol: 1,
      ticketId: ticket.ticketId,
      pairingSecret: ticket.pairingSecret,
      pluginId: descriptor.pluginId,
      host,
      artifactSha256: descriptor.artifactSha256,
      clientNonce: 'e'.repeat(32)
    })
    const target = {
      sessionId: session.sessionId,
      pluginId: descriptor.pluginId,
      projectId: 'owned-project'
    }
    const asset = await service.chooseManagedSessionAsset(
      {
        ...target,
        source: { kind: 'managed-media', reference: source }
      },
      invocation('chooseManagedSessionAsset')
    )
    if (!asset) throw new Error('Expected independently approved local-preview asset')
    expect(asset.sha256).toBe(source.sha256)
    expect(asset.purpose).toBe('local-preview')
    expect(controller.planState().previews).toEqual([])
    expect(model.chat).not.toHaveBeenCalled()
    expect(native.showMessageBox.mock.calls.at(-1)![1].detail).toContain(
      'source project are not attested'
    )
    const nodeId = host === 'figma' ? '1:2' : '42'
    const command = host === 'figma' ? 'image.fill' : 'image.pixels'
    const plan: HostPlan = {
      schemaVersion: 2,
      kind: 'host-plan',
      captureId: 'f'.repeat(32),
      steps: [
        host === 'figma'
          ? {
              command: 'image.fill',
              targetId: nodeId,
              assetId: asset.assetId,
              sha256: asset.sha256,
              scaleMode: 'FIT'
            }
          : {
              command: 'image.pixels',
              targetId: nodeId,
              assetId: asset.assetId,
              sha256: asset.sha256
            }
      ]
    }
    model.chat.mockResolvedValueOnce({ content: JSON.stringify(plan), finishReason: 'stop' })
    const prepared = await runtime.prepare(session.sessionId, session.sessionToken, {
      protocol: 1,
      sequence: 1,
      requestId: 'owned-output-planning',
      featureId: 'plan-preview',
      prompt: 'Use the explicitly selected image on the selected target.',
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
      assetReferences: [{ assetId: asset.assetId, sha256: asset.sha256 }],
      hostContext: {
        version: 1,
        host,
        documentId: '7',
        scopeId: '7',
        captureId: 'f'.repeat(32),
        selectedIds: [nodeId],
        execution: {
          mode: 'native-write',
          adapterVersion: host === 'figma' ? 'figma-native-1' : 'photoshop-uxp-native-1',
          supports: [command],
          rollback: 'verified-in-place',
          visualAudit: 'unavailable'
        },
        nodes: [
          {
            id: nodeId,
            type: host === 'figma' ? 'RECTANGLE' : 'pixel',
            name: 'Target',
            parentId: '7',
            ancestors: [],
            locked: false,
            visible: true,
            commands: [command],
            ...(host === 'figma'
              ? { imageFill: { status: 'available', fingerprint: '1'.repeat(64) } }
              : {
                  imagePixels: {
                    status: 'available',
                    historyStateId: 7,
                    bounds: { left: 0, top: 0, right: 1, bottom: 1 },
                    width: 1,
                    height: 1
                  }
                })
          }
        ]
      }
    })
    const call = controller.desktopState().previews[0]
    expect(model.chat).not.toHaveBeenCalled()
    await service.approveBridge(
      { callId: prepared.callId, payloadSha256: call.payloadSha256 },
      invocation('approveBridge')
    )
    await vi.waitFor(() => expect(controller.planState().previews).toHaveLength(1))
    const execution = controller.planState().previews[0]
    expect(execution.plan).toEqual(plan)
    expect(execution.state).toBe('awaiting-approval')
    expect(
      await runtime.claimPlan(session.sessionId, session.sessionToken, {
        protocol: 1,
        callId: prepared.callId
      })
    ).toMatchObject({ status: 'pending' })
    expect(JSON.stringify(model.chat.mock.calls[0][0].messages)).not.toMatch(
      /bytesBase64|local-media:|relativePath|data:image|owned-output.png/
    )
    await service.approvePlanExecution(
      { executionId: execution.executionId, planSha256: execution.planSha256 },
      invocation('approvePlanExecution')
    )
    const claimed = await runtime.claimPlan(session.sessionId, session.sessionToken, {
      protocol: 1,
      callId: prepared.callId
    })
    if (claimed.status !== 'ready') throw new Error('Expected separately approved image claim')
    // A published grant owns its bytes independently; source deletion is not remote recall.
    await fs.unlink(imported.absolutePath)
    const downloaded = await readExecutionAsset(claimed.intent.executionAssets![0], {
      identity: { ...target, host },
      intent: claimed.intent,
      readChunk: (request) =>
        runtime.planAssetChunk(session.sessionId, session.sessionToken, request),
      sha256: (value) => createHash('sha256').update(value).digest('hex')
    })
    expect(Buffer.from(downloaded)).toEqual(Buffer.from(bytes))
    expect(model.chat).toHaveBeenCalledOnce()
    await service.revokeSessionAsset(
      { ...target, assetId: asset.assetId, sha256: asset.sha256 },
      invocation('revokeSessionAsset')
    )
    await expect(
      readExecutionAsset(claimed.intent.executionAssets![0], {
        identity: { ...target, host },
        intent: claimed.intent,
        readChunk: (request) =>
          runtime.planAssetChunk(session.sessionId, session.sessionToken, request),
        sha256: (value) => createHash('sha256').update(value).digest('hex')
      })
    ).rejects.toBeDefined()
    expect(controller.planState().previews[0].state).toBe('cancelled')
  })
})
