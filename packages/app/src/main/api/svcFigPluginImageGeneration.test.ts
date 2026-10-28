import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { FIGPLUGIN_IMAGE_GENERATION_OPTIONS } from '@shared/figplugin/imageGeneration'
import type { FigPluginManagedList } from '@shared/figplugin/management'
import type { FigPluginAssetSelection } from '../figplugin/bridgeRuntime'
import type { FigPluginCenterStore } from '../figplugin/centerStore'
import type { FigPluginImageGenerationModel } from '../figplugin/imageGenerationCoordinator'
import type { ProviderImageOutputMaterializer } from '../figplugin/providerImageOutput'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { disposeFigPluginBridges, FigPluginCenterSvcImpl } from './svcFigPluginCenterImpl'

const native = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  getPath: vi.fn(),
  productionModel: vi.fn()
}))
vi.mock('./svcLLMProxyImpl', () => ({ LLMProxySvcImpl: native.productionModel }))
vi.mock('electron', () => ({
  app: { getPath: native.getPath },
  dialog: { showMessageBox: native.showMessageBox },
  nativeImage: {},
  clipboard: {},
  shell: {}
}))

const url = 'file:///app/index.html#/workshop/plugins'
const target = { sessionId: 'a'.repeat(32), pluginId: 'owned.figma', projectId: 'owned-project' }
const key = { ...target, requestId: 'b'.repeat(32) }
const request = () => ({ ...key, prompt: 'Generate a synthetic green square.' })
const approved = { response: 0, checkboxChecked: true }
const revision = 'd'.repeat(64)
type Bridge = Awaited<
  ReturnType<NonNullable<ConstructorParameters<typeof FigPluginCenterSvcImpl>[2]>>
>
const invocation = (
  method: string,
  patch: Partial<ServiceInvocationContext> = {}
): ServiceInvocationContext => ({
  methodName: `svcFigPluginCenter.${method}`,
  senderId: 42,
  senderUrl: url,
  frameUrl: url,
  isMainFrame: true,
  ...patch
})
const selection = (): FigPluginAssetSelection =>
  Object.freeze({
    target: Object.freeze({ ...target }),
    host: 'figma',
    bindingSha256: 'e'.repeat(64),
    expiresAt: Date.now() + 120_000,
    maxBytes: 65536
  })
const inventory = (): FigPluginManagedList => ({
  truncated: false,
  skippedRecords: 0,
  items: [
    {
      pluginId: target.pluginId,
      name: 'Synthetic generation fixture',
      version: '1.0.0',
      host: 'figma',
      generation: 1,
      capabilities: ['dialogue', 'asset-transfer', 'result-transfer'],
      manifestSha256: 'c'.repeat(64),
      materialization: 'verified-package',
      signerFingerprint: 'b'.repeat(64),
      artifactSha256: 'a'.repeat(64),
      bridgeOrigin: 'http://127.0.0.1:41234',
      fileCount: 1,
      contentBytes: 100,
      configured: true,
      ready: false,
      state: 'disabled',
      cleanupPending: false,
      settings: {
        analysisProfileId: 'analysis',
        backgroundRemovalProfileId: 'background',
        imageGenerationProfileId: 'image-only'
      }
    }
  ]
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  clearMagicAgentTrustedRouteBindingsForTest()
  native.getPath.mockImplementation(() => {
    throw new Error('No real app files')
  })
  native.showMessageBox.mockResolvedValue(approved)
})
afterEach(async () => {
  await disposeFigPluginBridges()
  clearMagicAgentTrustedRouteBindingsForTest()
  expect(native.getPath).not.toHaveBeenCalled()
  vi.useRealTimers()
})

const fixture = async (paired = true, productionModel = false) => {
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: Object.assign(new EventEmitter(), {
      id: 42,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => url)
    })
  }
  registerMagicAgentTrustedRouteBinding(42, undefined, {
    trustedUrl: url,
    trustedWebContents: window.webContents
  })
  const binding = {
    pluginId: target.pluginId,
    projectId: target.projectId,
    host: 'figma' as const,
    generation: 1,
    artifactSha256: 'a'.repeat(64),
    signerFingerprint: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64),
    profileId: 'analysis',
    profileRevision: revision,
    bridgeOrigin: 'http://127.0.0.1:41234'
  }
  const bridge = {
    resolveBinding: vi.fn<Bridge['resolveBinding']>().mockResolvedValue(binding),
    createPairing: vi.fn<Bridge['createPairing']>().mockResolvedValue({
      pluginId: target.pluginId,
      host: 'figma',
      artifactSha256: binding.artifactSha256,
      bridgeOrigin: binding.bridgeOrigin,
      ticketId: 'f'.repeat(32),
      pairingSecret: 'f'.repeat(64),
      expiresAt: Date.now() + 120000
    }),
    desktopState: vi.fn<Bridge['desktopState']>().mockImplementation(() => ({
      sessions: [{ ...target, host: 'figma', expiresAt: 1_800_000_600_000, activeCalls: 0 }],
      previews: []
    })),
    beginSessionAssetSelection: vi
      .fn<Bridge['beginSessionAssetSelection']>()
      .mockImplementation(async () => selection()),
    isSessionAssetSelectionCurrent: vi
      .fn<NonNullable<Bridge['isSessionAssetSelectionCurrent']>>()
      .mockReturnValue(true),
    validateSessionAssetSelection: vi
      .fn<NonNullable<Bridge['validateSessionAssetSelection']>>()
      .mockResolvedValue(undefined),
    publishSessionAsset: vi.fn<Bridge['publishSessionAsset']>(),
    listSessionAssets: vi.fn<Bridge['listSessionAssets']>(),
    revokeSessionAsset: vi.fn<Bridge['revokeSessionAsset']>(),
    approve: vi.fn<Bridge['approve']>(),
    deny: vi.fn<Bridge['deny']>(),
    revokePlugin: vi.fn<Bridge['revokePlugin']>(),
    planState: vi.fn<Bridge['planState']>(),
    approvePlanExecution: vi.fn<Bridge['approvePlanExecution']>(),
    acceptVisualBaseline: vi.fn<Bridge['acceptVisualBaseline']>(),
    authorizeVisualCorrection: vi.fn<Bridge['authorizeVisualCorrection']>(),
    cancelVisualCorrectionAuthorization: vi.fn<Bridge['cancelVisualCorrectionAuthorization']>(),
    denyPlanExecution: vi.fn<Bridge['denyPlanExecution']>(),
    cancelPlanExecution: vi.fn<Bridge['cancelPlanExecution']>(),
    dispose: vi.fn<Bridge['dispose']>().mockResolvedValue(undefined)
  }
  const list = inventory()
  let invalidate!: (pluginId: string) => void
  const unsubscribeStore = vi.fn()
  const store = {
    listManaged: vi.fn().mockResolvedValue(list),
    onRuntimeInvalidated: vi.fn((listener: typeof invalidate) => {
      invalidate = listener
      return unsubscribeStore
    })
  }
  let profileChange!: () => void
  const unsubscribeProfile = vi.fn()
  const model = {
    listProfiles: vi.fn<FigPluginImageGenerationModel['listProfiles']>().mockResolvedValue({
      comparisonDestination: { kind: 'local' },
      profiles: [
        {
          id: 'image-only',
          model_name: 'Synthetic image model',
          provider: 'openai',
          model_use: 'image',
          api_mode: 'images',
          configurationRevision: revision
        }
      ]
    }),
    isProfileRevisionCurrent: vi
      .fn<FigPluginImageGenerationModel['isProfileRevisionCurrent']>()
      .mockReturnValue(true),
    onProfileConfigurationChanged: vi.fn((listener: () => void) => {
      profileChange = listener
      return unsubscribeProfile
    }),
    chat: vi
      .fn<FigPluginImageGenerationModel['chat']>()
      .mockResolvedValue({ content: '', imageUrl: 'synthetic-provider-result' }),
    cancelConversation: vi
      .fn<FigPluginImageGenerationModel['cancelConversation']>()
      .mockResolvedValue({ cancelled: true })
  }
  const makeModel = vi.fn(async () => model)
  const discard = vi.fn(async () => undefined)
  const materialize = vi
    .fn<ProviderImageOutputMaterializer>()
    .mockImplementation(async (_response, options) => {
      options.check()
      const relativePath = `user-output/figplugin-${options.runId}/originals/ff/${'f'.repeat(64)}.png`
      return {
        reference: {
          version: 1,
          kind: 'managed',
          relativePath,
          sha256: 'f'.repeat(64),
          sizeBytes: 70,
          mimeType: 'image/png',
          originalFileName: 'generated.png'
        },
        localMediaUrl: `local-media:///canonical/root/${relativePath}`,
        width: 1,
        height: 1,
        discard
      }
    })
  const service = new FigPluginCenterSvcImpl(
    store as unknown as FigPluginCenterStore,
    () => window as unknown as BrowserWindow,
    async () => bridge,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    productionModel ? undefined : makeModel,
    materialize
  )
  if (paired)
    await service.createPairing(
      { pluginId: target.pluginId, expectedGeneration: 1, projectId: target.projectId },
      invocation('createPairing')
    )
  native.showMessageBox.mockClear()
  const generate = (value = request()) =>
    service.generateSessionImage(value, invocation('generateSessionImage'))
  const state = () =>
    service.sessionImageGenerationState(key, invocation('sessionImageGenerationState'))
  return {
    window,
    bridge,
    store,
    list,
    model,
    makeModel,
    materialize,
    discard,
    service,
    generate,
    state,
    invalidate: (pluginId = target.pluginId) => invalidate(pluginId),
    profileChange: () => profileChange(),
    unsubscribeStore,
    unsubscribeProfile
  }
}

describe('Desktop configured generation service ownership', () => {
  it('wires the default production factory to the immutable single-attempt model policy', async () => {
    const f = await fixture(true, true)
    native.productionModel.mockImplementation(function () {
      return f.model
    })
    await f.generate()
    expect(native.productionModel).toHaveBeenCalledExactlyOnceWith({ retryModelCapacity: false })
    expect(f.makeModel).not.toHaveBeenCalled()
    expect(f.model.listProfiles).toHaveBeenCalledOnce()
    expect(f.model.chat).toHaveBeenCalledOnce()
  })

  it('shows exact independent Cancel-default native consent and dispatches one fixed pinned text-only request without grants or writes', async () => {
    const f = await fixture()
    const output = await f.generate({
      ...request(),
      prompt: '  Generate a synthetic green square.  '
    })
    expect(output?.profileId).toBe('image-only')
    expect(f.makeModel).toHaveBeenCalledTimes(1)
    expect(f.model.listProfiles).toHaveBeenCalledExactlyOnceWith({
      comparisonRouting: 'configured',
      includeConfigurationRevision: true
    })
    const modal = native.showMessageBox.mock.calls[0][1]
    expect(modal).toMatchObject({
      defaultId: 1,
      cancelId: 1,
      checkboxChecked: false,
      signal: expect.any(AbortSignal)
    })
    for (const text of [
      target.pluginId,
      target.projectId,
      target.sessionId,
      'image-only',
      revision,
      'Synthetic image model',
      'images',
      '65536',
      request().prompt,
      JSON.stringify(FIGPLUGIN_IMAGE_GENERATION_OPTIONS),
      'without auth headers',
      'separately validate and accept',
      'Cancellation cannot undo'
    ])
      expect(modal.detail).toContain(text)
    expect(f.model.chat).toHaveBeenCalledTimes(1)
    expect(f.model.chat.mock.calls[0][0]).toEqual({
      messages: [{ role: 'user', content: request().prompt }],
      profileId: 'image-only',
      expectedProfileRevision: revision,
      comparisonRouting: 'configured',
      conversationId: expect.stringMatching(/^figplugin-image-/),
      cancellationId: expect.any(String),
      correlationId: expect.any(String),
      imageGenerationOptions: FIGPLUGIN_IMAGE_GENERATION_OPTIONS
    })
    expect(await f.state()).toMatchObject({ ...key, phase: 'awaiting-acceptance' })
    expect(f.bridge.validateSessionAssetSelection).toHaveBeenCalledTimes(4)
    expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
    expect(f.bridge.approve).not.toHaveBeenCalled()
    expect(f.bridge.approvePlanExecution).not.toHaveBeenCalled()
    expect(f.bridge.authorizeVisualCorrection).not.toHaveBeenCalled()
  })

  it.each([
    { response: 1, checkboxChecked: true },
    { response: 0, checkboxChecked: false }
  ])('does not dispatch for native refusal %j', async (approval) => {
    const f = await fixture()
    native.showMessageBox.mockResolvedValue(approval)
    expect(await f.generate()).toBeNull()
    expect(f.model.chat).not.toHaveBeenCalled()
    expect(f.materialize).not.toHaveBeenCalled()
    expect(await f.state()).toMatchObject({ phase: 'declined' })
  })

  it('refuses missing dedicated configuration instead of using analysis or background', async () => {
    const f = await fixture()
    delete f.list.items[0].settings.imageGenerationProfileId
    await expect(f.generate()).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    expect(f.makeModel).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
  })

  it('requires a live existing exact target and new controller authority helpers', async () => {
    const f = await fixture(false)
    await expect(f.generate()).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(f.store.listManaged).not.toHaveBeenCalled()
    expect(
      await f.service.sessionImageGenerationState(key, invocation('sessionImageGenerationState'))
    ).toBeNull()
    expect(
      await f.service.cancelSessionImageGeneration(key, invocation('cancelSessionImageGeneration'))
    ).toEqual({ completed: false })
  })

  it('fails closed for an injected controller without generation-only authority checks', async () => {
    const f = await fixture()
    delete (f.bridge as Partial<Bridge>).validateSessionAssetSelection
    await expect(f.generate()).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    expect(f.makeModel).not.toHaveBeenCalled()
    expect(f.store.listManaged).not.toHaveBeenCalled()
  })

  it.each(['gpt-image-synthetic', 'Synthetic image model'])(
    'discloses the actual Responses mainline and tool-model policy for %s',
    async (modelName) => {
      const f = await fixture()
      f.model.listProfiles.mockResolvedValue({
        profiles: [
          {
            id: 'image-only',
            model_name: modelName,
            model_use: 'image',
            provider: 'openai',
            api_mode: 'responses',
            configurationRevision: revision
          }
        ]
      })
      await f.generate()
      const detail = native.showMessageBox.mock.calls[0][1].detail
      expect(detail).toContain('Responses mainline model: gpt-5.4')
      expect(detail).toContain(`Configured model label: ${modelName}`)
      expect(detail).toContain(
        modelName.startsWith('gpt-image-')
          ? `Image-generation tool model: ${modelName}`
          : 'Image-generation tool model: provider default'
      )
      expect(detail).toContain('Responses declares only its built-in image-generation tool')
      expect(f.model.chat.mock.calls[0][0].imageGenerationOptions).not.toHaveProperty('model')
    }
  )

  it('rejects a wrong target session before reading configured profiles', async () => {
    const f = await fixture()
    await expect(f.generate({ ...request(), projectId: 'another-project' })).rejects.toMatchObject({
      code: 'EXPIRED'
    })
    expect(f.store.listManaged).not.toHaveBeenCalled()
  })

  it('cancels native consent independently and never dispatches when its dialog resolves late', async () => {
    const f = await fixture()
    const modal = deferred<typeof approved>()
    native.showMessageBox.mockReturnValue(modal.promise)
    const pending = f.generate().catch((error: unknown) => error)
    await vi.waitFor(() => expect(native.showMessageBox).toHaveBeenCalledTimes(1))
    expect(
      await f.service.cancelSessionImageGeneration(key, invocation('cancelSessionImageGeneration'))
    ).toEqual({ completed: true })
    expect(await pending).toMatchObject({ code: 'CANCELLED' })
    expect(native.showMessageBox.mock.calls[0][1].signal.aborted).toBe(true)
    modal.resolve(approved)
    await vi.waitFor(() => expect(f.model.chat).not.toHaveBeenCalled())
    expect(await f.state()).toMatchObject({ phase: 'cancelled', error: 'CANCELLED' })
  })

  it.each(['revoke', 'store-change', 'profile-change', 'navigation', 'destroyed'] as const)(
    'invalidates abort-ignoring in-flight Provider on %s',
    async (reason) => {
      const f = await fixture()
      const provider = deferred<{ content: string; imageUrl: string }>()
      f.model.chat.mockReturnValue(provider.promise)
      const pending = f.generate().catch((error: unknown) => error)
      await vi.waitFor(() => expect(f.model.chat).toHaveBeenCalledTimes(1))
      const dispatched = f.model.chat.mock.calls[0][0]
      if (reason === 'revoke')
        await f.service.revokeBridge({ pluginId: target.pluginId }, invocation('revokeBridge'))
      if (reason === 'store-change') f.invalidate()
      if (reason === 'profile-change') f.profileChange()
      if (reason === 'navigation') f.window.webContents.emit('did-start-navigation')
      if (reason === 'destroyed') f.window.webContents.emit('destroyed')
      expect(await pending).toMatchObject({ code: 'CONFIGURATION_CHANGED' })
      expect(f.model.cancelConversation).toHaveBeenCalledExactlyOnceWith({
        conversationId: dispatched.conversationId,
        cancellationId: dispatched.cancellationId
      })
      provider.resolve({ content: '', imageUrl: 'late' })
      await vi.waitFor(() => expect(f.model.chat).toHaveBeenCalledTimes(1))
      expect(f.materialize).not.toHaveBeenCalled()
      if (reason === 'navigation' || reason === 'destroyed') expect(await f.state()).toBeNull()
    }
  )

  it('accepts only exact result identifiers/hash, then keeps source through cancel, revoke, navigation and shutdown', async () => {
    const f = await fixture()
    const output = (await f.generate())!
    const acceptance = {
      ...key,
      jobId: output.jobId,
      resultId: output.resultId,
      sha256: output.reference.sha256
    }
    expect(
      await f.service.acceptSessionImageGeneration(
        { ...acceptance, sha256: '0'.repeat(64) },
        invocation('acceptSessionImageGeneration')
      )
    ).toEqual({ completed: false })
    expect(
      await f.service.acceptSessionImageGeneration(
        acceptance,
        invocation('acceptSessionImageGeneration')
      )
    ).toEqual({ completed: true })
    expect(await f.state()).toMatchObject({ phase: 'accepted' })
    expect(
      await f.service.cancelSessionImageGeneration(key, invocation('cancelSessionImageGeneration'))
    ).toEqual({ completed: false })
    await f.service.revokeBridge({ pluginId: target.pluginId }, invocation('revokeBridge'))
    f.window.webContents.emit('did-start-navigation')
    await disposeFigPluginBridges()
    expect(f.discard).not.toHaveBeenCalled()
    expect(f.unsubscribeProfile).toHaveBeenCalledOnce()
    expect(f.unsubscribeStore).toHaveBeenCalledOnce()
  })

  it('discards a pending unaccepted output on revoke and never grants local preview implicitly', async () => {
    const f = await fixture()
    await f.generate()
    await f.service.revokeBridge({ pluginId: target.pluginId }, invocation('revokeBridge'))
    await vi.waitFor(() => expect(f.discard).toHaveBeenCalledOnce())
    expect(await f.state()).toMatchObject({ phase: 'failed', error: 'CONFIGURATION_CHANGED' })
    expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
  })

  it('retains request replay tombstones and does not create another charged request', async () => {
    const f = await fixture()
    await f.generate()
    await f.service.cancelSessionImageGeneration(key, invocation('cancelSessionImageGeneration'))
    await expect(f.generate()).rejects.toMatchObject({ code: 'BUSY' })
    expect(f.model.chat).toHaveBeenCalledTimes(1)
  })

  it('does not expose raw prompt, Provider failure, response or source URL in state or sanitized errors', async () => {
    const f = await fixture()
    f.model.chat.mockRejectedValue(
      new Error('secret-provider-body https://credential.example/?token=secret')
    )
    await expect(f.generate()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    const text = JSON.stringify(await f.state())
    for (const value of ['secret', 'https:', request().prompt, 'image-only'])
      expect(text).not.toContain(value)
  })
})

describe.each([
  'generateSessionImage',
  'sessionImageGenerationState',
  'cancelSessionImageGeneration',
  'acceptSessionImageGeneration'
] as const)('%s trusted IPC', (method) => {
  it.each([
    { senderId: 99 },
    { senderUrl: 'https://untrusted.example/' },
    { frameUrl: 'https://untrusted.example/' },
    { isMainFrame: false },
    { methodName: 'svcFigPluginCenter.listPackages' }
  ])('rejects caller provenance %j before any generation work', async (patch) => {
    const f = await fixture()
    const value =
      method === 'generateSessionImage'
        ? request()
        : method === 'acceptSessionImageGeneration'
          ? { ...key, jobId: 'c'.repeat(32), resultId: 'd'.repeat(32), sha256: revision }
          : key
    await expect(
      f.service[method](value as never, invocation(method, patch))
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.makeModel).not.toHaveBeenCalled()
    expect(f.store.listManaged).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
  })
})
