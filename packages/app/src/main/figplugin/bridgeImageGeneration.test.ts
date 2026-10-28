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
        ...key,
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

describe.each(['figma', 'photoshop'] as const)('%s generated output full path', (host) => {
  it.each(['data-url', 'https'] as const)(
    'generates from %s, accepts, separately confirms sharing, and reads exact session bytes',
    async (source) => {
      const f = await fixture(host, source)
      const output = await f.generate()
      if (!output) throw new Error('Expected generated owned output')
      expect(output).toMatchObject({
        profileId: 'image-only',
        profileRevision: imageRevision,
        width: 1,
        height: 1,
        reference: { sha256, mimeType: 'image/png', sizeBytes: bytes.length }
      })
      expect(output).not.toHaveProperty('discard')
      expect(f.materialize).toHaveBeenCalledTimes(1)
      expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
      expect(f.generationModel.chat.mock.calls[0][0]).toMatchObject({
        messages: [{ role: 'user', content: f.request.prompt }],
        profileId: 'image-only',
        expectedProfileRevision: imageRevision,
        imageGenerationOptions: FIGPLUGIN_IMAGE_GENERATION_OPTIONS
      })
      expect(f.generationModel.chat.mock.calls[0][0].messages[0]).not.toHaveProperty('attachments')
      expect(f.planningModel.chat).not.toHaveBeenCalled()
      expect(f.controller.planState().previews).toEqual([])
      expect(
        (
          await f.runtime.assetList(f.session.sessionId, f.session.sessionToken, {
            protocol: 1,
            purpose: 'local-preview'
          })
        ).assets
      ).toEqual([])
      const generationConsent = boundary.showMessageBox.mock.calls[0][1]
      expect(generationConsent).toMatchObject({ defaultId: 1, cancelId: 1, checkboxChecked: false })
      for (const exact of [
        f.request.prompt,
        f.target.pluginId,
        f.target.projectId,
        imageRevision,
        'image-only',
        '65536'
      ])
        expect(generationConsent.detail).toContain(exact)
      expect(await fs.readFile(storedPath(output))).toEqual(bytes)
      if (source === 'https') {
        expect(boundary.download).toHaveBeenCalledTimes(1)
        expect(boundary.download.mock.calls[0][1]).toMatchObject({
          maxBytes: 65536,
          maxRedirects: 3,
          allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp'],
          signal: expect.any(AbortSignal)
        })
        expect(boundary.download.mock.calls[0][1]).not.toHaveProperty('headers')
        expect(JSON.stringify(vol.toJSON())).not.toContain('do-not-persist')
      } else expect(boundary.download).not.toHaveBeenCalled()

      const acceptedReference = structuredClone(output.reference)
      output.reference.sha256 = '0'.repeat(64)
      expect(await f.accept(output)).toEqual({ completed: false })
      output.reference = acceptedReference
      expect(await f.accept(output)).toEqual({ completed: true })
      expect(await f.accept(output)).toEqual({ completed: true })
      expect(
        await f.service.cancelSessionImageGeneration(
          f.key,
          invocation('cancelSessionImageGeneration')
        )
      ).toEqual({ completed: false })
      expect(await fs.readFile(storedPath(output))).toEqual(bytes)

      const sharing = deferred<{ response: number; checkboxChecked: boolean }>()
      boundary.showMessageBox.mockImplementationOnce(async () => sharing.promise)
      const share = f.service.chooseManagedSessionAsset(
        {
          ...f.target,
          source: { kind: 'managed-media', reference: output.reference }
        },
        invocation('chooseManagedSessionAsset')
      )
      await vi.waitFor(() => expect(boundary.showMessageBox).toHaveBeenCalledTimes(2))
      expect((await f.controller.listSessionAssets(f.target)).assets).toEqual([])
      const shareConsent = boundary.showMessageBox.mock.calls[1][1]
      expect(shareConsent.detail).toContain(`Image SHA-256: ${sha256}`)
      expect(shareConsent.detail).toContain('1 x 1')
      expect(shareConsent.detail).toContain('No model upload and no document-write permission')
      sharing.resolve({ response: 0, checkboxChecked: true })
      const asset = await share
      if (!asset) throw new Error('Expected independently approved shared image')
      expect(asset).toMatchObject({ ...f.target, host, sha256, purpose: 'local-preview' })
      const catalog = await f.runtime.assetList(f.session.sessionId, f.session.sessionToken, {
        protocol: 1,
        purpose: 'local-preview'
      })
      expect(catalog.assets).toEqual([asset])
      const downloaded = await readSessionAsset(asset, {
        identity: { ...f.target, host },
        readChunk: (request) =>
          f.runtime.assetChunk(f.session.sessionId, f.session.sessionToken, request),
        sha256: (value) => createHash('sha256').update(value).digest('hex')
      })
      expect(Buffer.from(downloaded)).toEqual(bytes)
      expect(f.planningModel.chat).not.toHaveBeenCalled()
      expect(f.controller.planState().previews).toEqual([])
      await f.service.revokeSessionAsset(
        { ...f.target, assetId: asset.assetId, sha256 },
        invocation('revokeSessionAsset')
      )
      expect(await fs.readFile(storedPath(output))).toEqual(bytes)
      await expect(
        readSessionAsset(asset, {
          identity: { ...f.target, host },
          readChunk: (request) =>
            f.runtime.assetChunk(f.session.sessionId, f.session.sessionToken, request),
          sha256: (value) => createHash('sha256').update(value).digest('hex')
        })
      ).rejects.toBeDefined()
    }
  )

  it('keeps accepted originals when the Desktop document navigates and the Bridge is revoked', async () => {
    const f = await fixture(host)
    const output = await f.generate()
    if (!output) throw new Error('Expected output')
    expect(await f.accept(output)).toEqual({ completed: true })
    f.window.webContents.emit('did-start-navigation')
    await vi.waitFor(() => expect(() => f.controller.desktopState()).toThrow())
    expect(await fs.readFile(storedPath(output))).toEqual(bytes)
    expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
  })

  it('cleans a real generated original delivered after cancellation while holding admission', async () => {
    const f = await fixture(host, 'https')
    const entered = deferred<MaterializedProviderImageOutput>()
    const release = deferred<void>()
    f.onMaterialized(async (output) => {
      entered.resolve(output)
      await release.promise
    })
    const pending = f.generate().catch((error) => error)
    const materialized = await entered.promise
    const original = path.join(root, ...materialized.reference.relativePath.split('/'))
    expect(await fs.readFile(original)).toEqual(bytes)
    expect(
      await f.service.cancelSessionImageGeneration(
        f.key,
        invocation('cancelSessionImageGeneration')
      )
    ).toEqual({ completed: true })
    expect(await pending).toMatchObject({ code: 'CANCELLED' })
    await expect(
      f.service.generateSessionImage(
        { ...f.request, requestId: '8'.repeat(32) },
        invocation('generateSessionImage')
      )
    ).rejects.toMatchObject({ code: 'BUSY' })
    expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
    release.resolve()
    await vi.waitFor(async () =>
      expect(
        await fs.lstat(original).then(
          () => true,
          () => false
        )
      ).toBe(false)
    )
    const scope = path.join(root, ...materialized.reference.relativePath.split('/').slice(0, 2))
    expect(
      await fs.lstat(scope).then(
        () => true,
        () => false
      )
    ).toBe(false)
    expect((await f.controller.listSessionAssets(f.target)).assets).toEqual([])
  })

  it('rejects copied selection receipts and signed package mutation before any charged generation', async () => {
    const f = await fixture(host)
    const receipt = await f.controller.beginSessionAssetSelection(f.target)
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.target)).toBe(true)
    const copied = structuredClone(receipt)
    expect(f.controller.isSessionAssetSelectionCurrent(copied)).toBe(false)
    await expect(f.controller.validateSessionAssetSelection(copied)).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    expect(Reflect.set(receipt, 'maxBytes', 999999)).toBe(false)
    expect(Reflect.set(receipt.target, 'projectId', 'foreign-project')).toBe(false)
    await f.controller.validateSessionAssetSelection(receipt)
    f.descriptor.artifactSha256 = '9'.repeat(64)
    await expect(f.generate()).rejects.toBeDefined()
    expect(f.generationModel.chat).not.toHaveBeenCalled()
    expect(f.materialize).not.toHaveBeenCalled()
    expect(boundary.showMessageBox).not.toHaveBeenCalled()
  })

  it('revokes an unaccepted real output when its signed package is invalidated', async () => {
    const f = await fixture(host)
    const receipt = await f.controller.beginSessionAssetSelection(f.target)
    const output = await f.generate()
    if (!output) throw new Error('Expected output')
    f.invalidate()
    expect(f.controller.isSessionAssetSelectionCurrent(receipt)).toBe(false)
    expect(await f.accept(output)).toEqual({ completed: false })
    await vi.waitFor(async () =>
      expect(
        await fs.lstat(storedPath(output)).then(
          () => true,
          () => false
        )
      ).toBe(false)
    )
    expect(f.generationModel.chat).toHaveBeenCalledTimes(1)
  })
})
