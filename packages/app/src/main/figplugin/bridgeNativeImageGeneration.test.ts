import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { vol } from 'memfs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import { readSessionAsset } from '@shared/figplugin/hostAssetClient'
import { FIGPLUGIN_IMAGE_GENERATION_OPTIONS } from '@shared/figplugin/imageGeneration'
import type { FigPluginImageGenerationOutput } from '@shared/figplugin/imageGeneration'
import { figPluginManagedListSchema, type FigPluginManagedList } from '@shared/figplugin/management'
import { encodeContextPng } from '@shared/figplugin/pixelAuditRuntime'
import { disposeFigPluginBridges, FigPluginCenterSvcImpl } from '../api/svcFigPluginCenterImpl'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { FigPluginBridgeController } from './bridgeController'
import type { startFigPluginBridgeServer } from './bridgeServer'
import type { FigPluginCenterStore, FigPluginRuntimeDescriptor } from './centerStore'
import type { FigPluginImageGenerationModel } from './imageGenerationCoordinator'
import {
  materializeProviderImageOutput,
  type MaterializedProviderImageOutput,
  type ProviderImageOutputMaterializer
} from './providerImageOutput'

const boundary = vi.hoisted(() => ({
  getMediaDir: vi.fn(),
  showMessageBox: vi.fn(),
  showOpenDialog: vi.fn(),
  createFromBuffer: vi.fn(),
  getPath: vi.fn(),
  download: vi.fn()
}))
vi.mock('../llmProxy/chatMediaDir', () => ({ getChatMediaDir: boundary.getMediaDir }))
vi.mock('../api/safeRemoteDownload', () => ({ safeRemoteDownload: boundary.download }))
vi.mock('electron', () => ({
  app: { getPath: boundary.getPath },
  dialog: { showMessageBox: boundary.showMessageBox, showOpenDialog: boundary.showOpenDialog },
  nativeImage: { createFromBuffer: boundary.createFromBuffer },
  clipboard: {},
  shell: {}
}))

const desktopUrl = 'file:///app/index.html#/workshop/plugins'
const root = path.resolve('owned-generation-chain-fixture', 'userData', '.chat_media')
const revision = 'd'.repeat(64)
const imageRevision = '7'.repeat(64)
const bytes = Buffer.from(encodeContextPng(1, 1, new Uint8Array([12, 34, 56, 255]), 4)!)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
const outputUrl = 'https://images.example.com/generated.png?opaque=do-not-persist'
const network = vi.fn(() => {
  throw new Error('No live Provider or network in this fixture')
})
const invocation = (method: string): ServiceInvocationContext => ({
  methodName: `svcFigPluginCenter.${method}`,
  senderId: 42,
  senderUrl: desktopUrl,
  frameUrl: desktopUrl,
  isMainFrame: true
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const storedPath = (output: FigPluginImageGenerationOutput) =>
  path.join(root, ...output.reference.relativePath.split('/'))

beforeEach(async () => {
  vi.resetAllMocks()
  vol.reset()
  clearMagicAgentTrustedRouteBindingsForTest()
  await fs.mkdir(root, { recursive: true })
  boundary.getMediaDir.mockReturnValue(root)
  boundary.getPath.mockImplementation(() => {
    throw new Error('No real app files')
  })
  boundary.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true })
  boundary.createFromBuffer.mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 })
  })
  boundary.download.mockImplementation(async () => ({
    buffer: Buffer.from(bytes),
    contentType: 'image/png',
    finalUrl: new URL('https://cdn.example.com/generated.png')
  }))
  vi.stubGlobal('fetch', network)
})
afterEach(async () => {
  await disposeFigPluginBridges()
  clearMagicAgentTrustedRouteBindingsForTest()
  expect(boundary.getPath).not.toHaveBeenCalled()
  expect(boundary.showOpenDialog).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  vol.reset()
})

async function fixture(host: 'figma' | 'photoshop', source: 'data-url' | 'https' = 'data-url') {
  const descriptor: FigPluginRuntimeDescriptor = {
    pluginId: `owned.generate.${host}`,
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
  const inventory: FigPluginManagedList = {
    truncated: false,
    skippedRecords: 0,
    items: [
      {
        pluginId: descriptor.pluginId,
        host: descriptor.host,
        generation: descriptor.generation,
        artifactSha256: descriptor.artifactSha256,
        signerFingerprint: descriptor.signerFingerprint,
        manifestSha256: descriptor.manifestSha256,
        bridgeOrigin: descriptor.bridgeOrigin,
        capabilities: ['dialogue', 'asset-transfer', 'result-transfer'],
        name: 'Owned generated image fixture',
        version: '1.0.0',
        materialization: 'verified-package',
        fileCount: 1,
        contentBytes: 100,
        configured: true,
        ready: false,
        state: 'disabled',
        cleanupPending: false,
        settings: {
          analysisProfileId: 'metadata-only',
          backgroundRemovalProfileId: 'background',
          imageGenerationProfileId: 'image-only'
        }
      }
    ]
  }
  expect(figPluginManagedListSchema.parse(inventory)).toEqual(inventory)
  const invalidations = new Set<(pluginId: string) => void>()
  const store = {
    listManaged: vi.fn().mockResolvedValue(inventory),
    getRuntimeDescriptor: vi.fn().mockImplementation(async () => structuredClone(descriptor)),
    onRuntimeInvalidated: (listener: (pluginId: string) => void) => {
      invalidations.add(listener)
      return () => {
        invalidations.delete(listener)
      }
    }
  }
  let runtime!: Parameters<typeof startFigPluginBridgeServer>[0]['runtime']
  const planningModel = {
    listProfiles: vi.fn<LLMProxySvc['listProfiles']>().mockResolvedValue({
      profiles: [
        {
          id: 'metadata-only',
          model_name: 'Synthetic metadata model',
          model_use: 'chat',
          is_vision_model: false,
          configurationRevision: revision,
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
  const controller = new FigPluginBridgeController(store, planningModel, {
    startServer: async (options) => {
      runtime = options.runtime
      return { origin: options.origin, close: async () => undefined }
    }
  })
  const profileChanges = new Set<() => void>()
  const generationModel = {
    listProfiles: vi.fn<FigPluginImageGenerationModel['listProfiles']>().mockResolvedValue({
      comparisonDestination: { kind: 'local' },
      profiles: [
        {
          id: 'image-only',
          model_name: 'Synthetic image-only model',
          provider: 'openai',
          model_use: 'image',
          api_mode: 'images',
          configurationRevision: imageRevision
        }
      ]
    }),
    chat: vi.fn<FigPluginImageGenerationModel['chat']>().mockImplementation(async () => ({
      content: 'Generated a synthetic pixel.',
      imageUrl: source === 'data-url' ? dataUrl : outputUrl,
      attachments: [
        { type: 'image', url: source === 'data-url' ? dataUrl : outputUrl, mimeType: 'image/png' }
      ]
    })),
    cancelConversation: vi
      .fn<FigPluginImageGenerationModel['cancelConversation']>()
      .mockResolvedValue({ cancelled: true }),
    isProfileRevisionCurrent: vi.fn(() => true),
    onProfileConfigurationChanged: (listener: () => void) => {
      profileChanges.add(listener)
      return () => {
        profileChanges.delete(listener)
      }
    }
  }
  const window = {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), {
      id: 42,
      isDestroyed: () => false,
      getURL: () => desktopUrl
    })
  }
  registerMagicAgentTrustedRouteBinding(42, undefined, {
    trustedUrl: desktopUrl,
    trustedWebContents: window.webContents
  })
  let afterMaterialize: ((output: MaterializedProviderImageOutput) => Promise<void>) | undefined
  const materialize = vi
    .fn<ProviderImageOutputMaterializer>()
    .mockImplementation(async (...args) => {
      const output = await materializeProviderImageOutput(...args)
      await afterMaterialize?.(output)
      return output
    })
  const service = new FigPluginCenterSvcImpl(
    store as unknown as FigPluginCenterStore,
    () => window as unknown as BrowserWindow,
    async () => controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => generationModel,
    materialize
  )
  const ticket = await service.createPairing(
    {
      pluginId: descriptor.pluginId,
      expectedGeneration: descriptor.generation,
      projectId: 'owned-generated-project'
    },
    invocation('createPairing')
  )
  if (!ticket) throw new Error('Expected synthetic pairing')
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
    projectId: 'owned-generated-project'
  }
  const key = { ...target, requestId: 'f'.repeat(32) }
  const request = { ...key, prompt: 'Generate exactly one synthetic green square.' }
  boundary.showMessageBox.mockClear()
  const accept = (output: FigPluginImageGenerationOutput) =>
    service.acceptSessionImageGeneration(
      {
        ...target,
        requestId: output.requestId,
        jobId: output.jobId,
        resultId: output.resultId,
        sha256: output.reference.sha256
      },
      invocation('acceptSessionImageGeneration')
    )
  return {
    service,
    controller,
    runtime,
    window,
    store,
    descriptor,
    generationModel,
    planningModel,
    materialize,
    session,
    target,
    key,
    request,
    accept,
    generate: () => service.generateSessionImage(request, invocation('generateSessionImage')),
    onMaterialized: (listener: NonNullable<typeof afterMaterialize>) => {
      afterMaterialize = listener
    },
    invalidate: () => {
      for (const listener of invalidations) listener(descriptor.pluginId)
    },
    changeProfile: () => {
      for (const listener of profileChanges) listener()
    }
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
const propose = async (f: Fixture) => {
  const input = {
    protocol: 1 as const,
    requestId: '1'.repeat(32),
    sequence: 1,
    prompt: 'Generate exactly one synthetic green square.'
  }
  const receipt = await f.runtime.prepareImageGeneration(
    f.session.sessionId,
    f.session.sessionToken,
    input
  )
  const { proposals } = await f.service.nativeImageGenerationProposals(
    {},
    invocation('nativeImageGenerationProposals')
  )
  const proposal = proposals.find((item) => item.proposalId === receipt.proposalId)!
  expect(proposal).toBeDefined()
  const desktopKey = {
    proposalId: proposal.proposalId,
    payloadSha256: proposal.payloadSha256
  }
  const nativeKey = {
    protocol: 1 as const,
    requestId: input.requestId,
    proposalId: receipt.proposalId
  }
  return {
    input,
    receipt,
    proposal,
    desktopKey,
    nativeKey,
    start: () =>
      f.service.approveNativeImageGeneration(
        desktopKey,
        invocation('approveNativeImageGeneration')
      ),
    status: () =>
      f.runtime.imageGenerationStatus(f.session.sessionId, f.session.sessionToken, nativeKey),
    cancel: () =>
      f.runtime.cancelImageGeneration(f.session.sessionId, f.session.sessionToken, nativeKey)
  }
}

describe.each(['figma', 'photoshop'] as const)(
  '%s native proposal to accepted managed output',
  (host) => {
    it('binds the exact proposal to one real job, then separately approves image sharing', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      expect(f.generationModel.chat).not.toHaveBeenCalled()
      expect(boundary.showMessageBox).not.toHaveBeenCalled()
      expect(p.proposal.generationRequestId).not.toBe(p.input.requestId)
      const output = await p.start()
      if (!output) throw new Error('Expected owned output')
      expect(output).toMatchObject({ ...f.target, requestId: p.proposal.generationRequestId })
      expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
      const wire = f.generationModel.chat.mock.calls[0][0]
      expect(wire).toMatchObject({
        messages: [{ role: 'user', content: p.input.prompt }],
        profileId: 'image-only',
        expectedProfileRevision: imageRevision,
        imageGenerationOptions: FIGPLUGIN_IMAGE_GENERATION_OPTIONS
      })
      expect(wire.messages[0]).not.toHaveProperty('attachments')
      const consent = boundary.showMessageBox.mock.calls[0][1]
      for (const exact of [p.proposal.proposalId, p.input.requestId, p.proposal.payloadSha256])
        expect(consent.detail).toContain(exact)
      const status = await p.status()
      expect(status.phase).toBe('awaiting-acceptance')
      for (const forbidden of [
        'prompt',
        'reference',
        'localMediaUrl',
        'jobId',
        'generationRequestId'
      ])
        expect(status).not.toHaveProperty(forbidden)
      expect((await f.controller.listSessionAssets(f.target)).assets).toEqual([])
      expect(f.controller.planState().previews).toEqual([])
      expect(await f.accept(output)).toEqual({ completed: true })
      expect((await p.status()).phase).toBe('accepted')
      expect(await fs.readFile(storedPath(output))).toEqual(bytes)
      expect((await f.controller.listSessionAssets(f.target)).assets).toEqual([])
      const asset = await f.service.chooseManagedSessionAsset(
        { ...f.target, source: { kind: 'managed-media', reference: output.reference } },
        invocation('chooseManagedSessionAsset')
      )
      if (!asset) throw new Error('Expected independent sharing approval')
      expect(boundary.showMessageBox).toHaveBeenCalledTimes(2)
      expect(boundary.showMessageBox.mock.calls[1][1].detail).toContain(
        'No model upload and no document-write permission'
      )
      const downloaded = await readSessionAsset(asset, {
        identity: { ...f.target, host },
        readChunk: (request) =>
          f.runtime.assetChunk(f.session.sessionId, f.session.sessionToken, request),
        sha256: (value) => createHash('sha256').update(value).digest('hex')
      })
      expect(Buffer.from(downloaded)).toEqual(bytes)
      expect(f.planningModel.chat).not.toHaveBeenCalled()
      expect(f.controller.planState().previews).toEqual([])
      expect(
        await f.runtime.prepareImageGeneration(f.session.sessionId, f.session.sessionToken, p.input)
      ).toEqual(p.receipt)
      await expect(p.start()).rejects.toBeDefined()
      expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
    })

    it('denies prompt overrides and wrong hashes without consuming the exact proposal', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      await expect(
        f.service.approveNativeImageGeneration(
          { ...p.desktopKey, prompt: 'Injected prompt' } as never,
          invocation('approveNativeImageGeneration')
        )
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      await expect(
        f.service.approveNativeImageGeneration(
          { ...p.desktopKey, payloadSha256: '0'.repeat(64) },
          invocation('approveNativeImageGeneration')
        )
      ).rejects.toBeDefined()
      expect(f.generationModel.chat).not.toHaveBeenCalled()
      expect(await p.start()).not.toBeNull()
      expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
    })

    it('declines native consent and never dispatches or re-adopts the charged job', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      boundary.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      expect(await p.start()).toBeNull()
      expect((await p.status()).phase).toBe('declined')
      expect(f.generationModel.chat).not.toHaveBeenCalled()
      await expect(p.start()).rejects.toBeDefined()
      expect(f.materialize).not.toHaveBeenCalled()
    })

    it('cancels a queued proposal independently of the generation lane', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      expect(
        await f.service.cancelNativeImageGeneration(
          p.desktopKey,
          invocation('cancelNativeImageGeneration')
        )
      ).toEqual({ completed: true })
      expect((await p.status()).phase).toBe('cancelled')
      await expect(p.start()).rejects.toBeDefined()
      expect(f.generationModel.chat).not.toHaveBeenCalled()
      expect(boundary.showMessageBox).not.toHaveBeenCalled()
    })

    it('does not let duplicate Desktop approval replace a pending native consent', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      const confirmation = deferred<{ response: number; checkboxChecked: boolean }>()
      boundary.showMessageBox.mockImplementationOnce(() => confirmation.promise)
      const pending = p.start()
      await vi.waitFor(() => expect(boundary.showMessageBox).toHaveBeenCalledTimes(1))
      await expect(p.start()).rejects.toBeDefined()
      confirmation.resolve({ response: 0, checkboxChecked: true })
      expect(await pending).not.toBeNull()
      expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
      expect((await p.status()).phase).toBe('awaiting-acceptance')
    })

    it('closes native ownership while consent is pending, so late approval cannot dispatch', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      const confirmation = deferred<{ response: number; checkboxChecked: boolean }>()
      boundary.showMessageBox.mockImplementationOnce(() => confirmation.promise)
      const pending = p.start()
      const rejected = expect(pending).rejects.toBeDefined()
      await vi.waitFor(() => expect(boundary.showMessageBox).toHaveBeenCalledTimes(1))
      f.runtime.closeSession(f.session.sessionId, f.session.sessionToken)
      await rejected
      confirmation.resolve({ response: 0, checkboxChecked: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(f.generationModel.chat).not.toHaveBeenCalled()
    })

    it('stops an abort-ignoring Provider promptly and never admits or materializes its late result', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      const provider = deferred<{ content: string; imageUrl: string }>()
      f.generationModel.chat.mockImplementationOnce(() => provider.promise)
      const pending = p.start()
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
      await vi.waitFor(() => expect(f.generationModel.chat).toHaveBeenCalledTimes(1))
      await p.cancel()
      await rejected
      expect((await p.status()).phase).toBe('cancelled')
      expect(f.generationModel.cancelConversation).toHaveBeenCalledTimes(1)
      await expect(p.start()).rejects.toBeDefined()
      provider.resolve({ content: '', imageUrl: dataUrl })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(f.materialize).not.toHaveBeenCalled()
      expect((await f.controller.listSessionAssets(f.target)).assets).toEqual([])
    })

    it('retains the native abort fence after output return until authoritative acceptance', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      const output = await p.start()
      if (!output) throw new Error('Expected owned output')
      await p.cancel()
      expect((await p.status()).phase).toBe('cancelled')
      expect(await f.accept(output)).toEqual({ completed: false })
      await vi.waitFor(async () =>
        expect(await fs.stat(storedPath(output)).catch(() => null)).toBeNull()
      )
    })

    it('preserves transferred ownership against late native cancel and Desktop navigation', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      const output = await p.start()
      if (!output) throw new Error('Expected owned output')
      expect(await f.accept(output)).toEqual({ completed: true })
      await p.cancel()
      expect((await p.status()).phase).toBe('accepted')
      f.window.webContents.emit('did-start-navigation')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(await fs.readFile(storedPath(output))).toEqual(bytes)
    })

    it('records a sanitized terminal failure after one Provider error without retry', async () => {
      const f = await fixture(host)
      const p = await propose(f)
      f.generationModel.chat.mockRejectedValueOnce(new Error('secret prompt URL credential'))
      await expect(p.start()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
      const status = await p.status()
      expect(status).toMatchObject({ phase: 'failed', error: 'UPSTREAM_FAILED' })
      expect(JSON.stringify(status)).not.toContain('secret')
      expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
      await expect(p.start()).rejects.toBeDefined()
      expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
    })
  }
)

describe.each([
  'nativeImageGenerationProposals',
  'approveNativeImageGeneration',
  'cancelNativeImageGeneration'
] as const)('%s trusted renderer boundary', (method) => {
  it.each([
    { senderId: 99 },
    { senderUrl: 'https://untrusted.example/' },
    { frameUrl: 'https://untrusted.example/' },
    { isMainFrame: false },
    { methodName: 'svcFigPluginCenter.listPackages' }
  ])('rejects forged provenance before touching the proposal %j', async (patch) => {
    const f = await fixture('figma')
    const p = await propose(f)
    await expect(
      f.service[method](
        (method === 'nativeImageGenerationProposals' ? {} : p.desktopKey) as never,
        { ...invocation(method), ...patch }
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.generationModel.chat).not.toHaveBeenCalled()
    expect((await p.status()).phase).toBe('awaiting-approval')
  })
})
