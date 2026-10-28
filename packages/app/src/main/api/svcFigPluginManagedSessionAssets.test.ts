import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { validateServiceValue } from '@shared/api/apiUtils/serviceValidation'
import { figPluginCenterSvcDef } from '@shared/api/svcFigPluginCenter'
import { FigPluginBridgeError, type FigPluginRuntimeBinding } from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_TTL_MS,
  type FigPluginDesktopAssetTarget,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import type {
  FigPluginDesktopManagedAssetRequest,
  FigPluginManagedAssetReference
} from '@shared/figplugin/managedSessionAsset'
import type { FigPluginAssetSelection } from '../figplugin/bridgeRuntime'
import type {
  ManagedSessionAssetMaterializer,
  MaterializedSessionAsset,
  SessionAssetMaterializer
} from '../figplugin/hostAssetMaterialization'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { disposeFigPluginBridges, FigPluginCenterSvcImpl } from './svcFigPluginCenterImpl'

const native = vi.hoisted(() => ({
  getPath: vi.fn(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  createFromBuffer: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: native.getPath },
  dialog: { showOpenDialog: native.showOpenDialog, showMessageBox: native.showMessageBox },
  nativeImage: { createFromBuffer: native.createFromBuffer },
  clipboard: {},
  shell: {}
}))

const TRUSTED_URL = 'file:///app/index.html#/workshop/plugins'
const target: FigPluginDesktopAssetTarget = {
  sessionId: '1'.repeat(32),
  pluginId: 'synthetic.figma',
  projectId: 'synthetic_project'
}
const binding: FigPluginRuntimeBinding = {
  pluginId: target.pluginId,
  projectId: target.projectId,
  host: 'figma',
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  profileId: 'synthetic-model',
  profileRevision: 'd'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:43123'
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const sha256 = createHash('sha256').update(png).digest('hex')
const reference = (): FigPluginManagedAssetReference => ({
  version: 1,
  kind: 'managed',
  relativePath: 'user-output/synthetic/generated.png',
  sha256,
  sizeBytes: png.length,
  mimeType: 'image/png',
  originalFileName: 'generated.png'
})
const request = (): FigPluginDesktopManagedAssetRequest => ({
  ...target,
  source: { kind: 'managed-media', reference: reference() }
})
const approved = { response: 0, checkboxChecked: true }
type Bridge = Awaited<
  ReturnType<NonNullable<ConstructorParameters<typeof FigPluginCenterSvcImpl>[2]>>
>
type Method =
  | 'chooseManagedSessionAsset'
  | 'chooseSessionAsset'
  | 'revokeSessionAsset'
  | 'createPairing'
  | 'revokeBridge'
const invocation = (
  method: Method,
  changes: Partial<ServiceInvocationContext> = {}
): ServiceInvocationContext => ({
  methodName: `svcFigPluginCenter.${method}`,
  senderId: 42,
  senderUrl: TRUSTED_URL,
  frameUrl: TRUSTED_URL,
  isMainFrame: true,
  ...changes
})
const selection = (): FigPluginAssetSelection =>
  Object.freeze({
    target: Object.freeze({ ...target }),
    host: 'figma',
    bindingSha256: 'e'.repeat(64),
    maxBytes: FIGPLUGIN_ASSET_MAX_BYTES,
    expiresAt: Date.now() + FIGPLUGIN_ASSET_TTL_MS
  })
const asset = (): FigPluginSessionAsset => ({
  version: 1,
  kind: 'session-image-asset',
  purpose: 'local-preview',
  ...target,
  host: 'figma',
  assetId: '2'.repeat(32),
  mimeType: 'image/png',
  sha256,
  sizeBytes: png.length,
  width: 1,
  height: 1,
  chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
  chunkCount: 1,
  createdAt: Date.now(),
  expiresAt: Date.now() + FIGPLUGIN_ASSET_TTL_MS
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const retainedBuffers: Uint8Array[] = []
const forbiddenEffects: ReturnType<typeof vi.fn>[] = []
const materialized = (): MaterializedSessionAsset => {
  const bytes = Buffer.from(png)
  retainedBuffers.push(bytes)
  return { mimeType: 'image/png', width: 1, height: 1, sha256, bytes }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  clearMagicAgentTrustedRouteBindingsForTest()
  native.getPath.mockImplementation(() => {
    throw new Error('User directories forbidden in injected service fixture')
  })
  native.showOpenDialog.mockImplementation(() => {
    throw new Error('File chooser forbidden for a managed source')
  })
  native.showMessageBox.mockResolvedValue(approved)
  native.createFromBuffer.mockImplementation(() => {
    throw new Error('Decoder belongs to the separate materializer suite')
  })
})
afterEach(async () => {
  await disposeFigPluginBridges()
  clearMagicAgentTrustedRouteBindingsForTest()
  vi.useRealTimers()
  expect(native.getPath).not.toHaveBeenCalled()
  expect(native.showOpenDialog).not.toHaveBeenCalled()
  expect(native.createFromBuffer).not.toHaveBeenCalled()
  for (const effect of forbiddenEffects.splice(0)) expect(effect).not.toHaveBeenCalled()
  for (const bytes of retainedBuffers.splice(0))
    expect(bytes.every((byte) => byte === 0)).toBe(true)
})

const fixture = async (paired = true) => {
  const publicationSnapshots: Buffer[] = []
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: Object.assign(new EventEmitter(), {
      id: 42,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => TRUSTED_URL)
    })
  }
  registerMagicAgentTrustedRouteBinding(42, undefined, {
    trustedUrl: TRUSTED_URL,
    trustedWebContents: window.webContents
  })
  const bridge = {
    resolveBinding: vi.fn<Bridge['resolveBinding']>().mockResolvedValue(binding),
    createPairing: vi.fn<Bridge['createPairing']>().mockResolvedValue({
      ticketId: '3'.repeat(32),
      pairingSecret: 'f'.repeat(64),
      expiresAt: Date.now() + FIGPLUGIN_ASSET_TTL_MS,
      pluginId: target.pluginId,
      host: binding.host,
      bridgeOrigin: binding.bridgeOrigin,
      artifactSha256: binding.artifactSha256
    }),
    desktopState: vi.fn<Bridge['desktopState']>().mockReturnValue({ sessions: [], previews: [] }),
    approve: vi.fn<Bridge['approve']>(),
    deny: vi.fn<Bridge['deny']>(),
    revokePlugin: vi.fn<Bridge['revokePlugin']>(),
    beginSessionAssetSelection: vi
      .fn<Bridge['beginSessionAssetSelection']>()
      .mockImplementation(async () => selection()),
    publishSessionAsset: vi
      .fn<Bridge['publishSessionAsset']>()
      .mockImplementation(async (_selection, input) => {
        publicationSnapshots.push(Buffer.from(input.bytes))
        return asset()
      }),
    listSessionAssets: vi.fn<Bridge['listSessionAssets']>(),
    revokeSessionAsset: vi.fn<Bridge['revokeSessionAsset']>().mockResolvedValue(undefined),
    planState: vi.fn<Bridge['planState']>(),
    approvePlanExecution: vi.fn<Bridge['approvePlanExecution']>(),
    acceptVisualBaseline: vi.fn<Bridge['acceptVisualBaseline']>(),
    authorizeVisualCorrection: vi.fn<Bridge['authorizeVisualCorrection']>(),
    cancelVisualCorrectionAuthorization: vi.fn<Bridge['cancelVisualCorrectionAuthorization']>(),
    denyPlanExecution: vi.fn<Bridge['denyPlanExecution']>(),
    cancelPlanExecution: vi.fn<Bridge['cancelPlanExecution']>(),
    dispose: vi.fn<Bridge['dispose']>().mockResolvedValue(undefined)
  }
  const fileMaterializer = vi
    .fn<SessionAssetMaterializer>()
    .mockRejectedValue(new Error('File materializer forbidden'))
  const materialize = vi
    .fn<ManagedSessionAssetMaterializer>()
    .mockImplementation(async (_reference, { check }) => {
      check()
      return materialized()
    })
  forbiddenEffects.push(
    fileMaterializer,
    bridge.approve,
    bridge.approvePlanExecution,
    bridge.authorizeVisualCorrection
  )
  const service = new FigPluginCenterSvcImpl(
    undefined,
    () => window as unknown as BrowserWindow,
    async () => bridge,
    undefined,
    undefined,
    undefined,
    fileMaterializer,
    materialize
  )
  if (paired) {
    await service.createPairing(
      { pluginId: target.pluginId, expectedGeneration: 1, projectId: target.projectId },
      invocation('createPairing')
    )
  }
  native.showMessageBox.mockClear()
  const choose = (value = request()) =>
    service.chooseManagedSessionAsset(value, invocation('chooseManagedSessionAsset'))
  return { service, bridge, window, materialize, publicationSnapshots, choose }
}

describe('Desktop managed source creates a new explicit local-preview grant', () => {
  it('captures the exact target, materializes a strict reference and requires independent unchecked native consent', async () => {
    const f = await fixture()
    const result = await f.choose()
    expect(result).toEqual(asset())
    expect(f.bridge.beginSessionAssetSelection).toHaveBeenCalledExactlyOnceWith(target)
    expect(f.materialize).toHaveBeenCalledExactlyOnceWith(
      reference(),
      expect.objectContaining({
        maxBytes: FIGPLUGIN_ASSET_MAX_BYTES,
        check: expect.any(Function),
        signal: expect.any(AbortSignal)
      })
    )
    expect(Object.isFrozen(f.materialize.mock.calls[0][0])).toBe(true)
    expect(f.bridge.beginSessionAssetSelection.mock.invocationCallOrder[0]).toBeLessThan(
      f.materialize.mock.invocationCallOrder[0]
    )
    expect(f.materialize.mock.invocationCallOrder[0]).toBeLessThan(
      native.showMessageBox.mock.invocationCallOrder[0]
    )
    expect(f.bridge.publishSessionAsset.mock.calls[0][0]).toBe(
      await f.bridge.beginSessionAssetSelection.mock.results[0].value
    )
    expect(Object.keys(f.bridge.publishSessionAsset.mock.calls[0][1]).sort()).toEqual([
      'bytes',
      'height',
      'mimeType',
      'width'
    ])
    expect(f.publicationSnapshots).toEqual([png])
    expect(native.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      f.window,
      expect.objectContaining({
        defaultId: 1,
        cancelId: 1,
        checkboxChecked: false,
        detail: expect.stringContaining(sha256)
      })
    )
    const details = native.showMessageBox.mock.calls[0][1].detail
    for (const text of [
      target.pluginId,
      target.sessionId,
      target.projectId,
      'local-preview',
      'No model upload',
      'no document-write',
      `${png.length} bytes`,
      selection().bindingSha256
    ])
      expect(details).toContain(text)
    expect(details).toContain('generating task and source project are not attested')
    expect(details).toContain('deleting the source does not recall the published copy')
    for (const text of [
      reference().relativePath,
      'bytesBase64',
      'completed-task',
      'owner verified'
    ]) {
      expect(details).not.toContain(text)
      expect(JSON.stringify(result)).not.toContain(text)
    }
    expect(result).not.toHaveProperty('source')
    expect(result).not.toHaveProperty('reference')
  })

  it('does not reuse a prior local preview consent for a second publication', async () => {
    const f = await fixture()
    expect(await f.choose()).toEqual(asset())
    native.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    expect(await f.choose()).toBeNull()
    expect(native.showMessageBox).toHaveBeenCalledTimes(2)
    expect(f.bridge.publishSessionAsset).toHaveBeenCalledOnce()
  })

  it('detaches caller reference and target mutations while native consent is pending', async () => {
    const f = await fixture()
    const value = request()
    native.showMessageBox.mockImplementation(async () => {
      value.projectId = 'foreign-project'
      value.source.reference.sha256 = '0'.repeat(64)
      value.source.reference.relativePath = 'other/generated.png'
      return approved
    })
    expect(await f.choose(value)).toEqual(asset())
    expect(f.materialize.mock.calls[0][0]).toEqual(reference())
    expect(f.bridge.beginSessionAssetSelection).toHaveBeenCalledWith(target)
    expect(f.publicationSnapshots).toEqual([png])
  })

  it('requires an existing session grant before materialization or native consent', async () => {
    const f = await fixture(false)
    await expect(f.choose()).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(f.materialize).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
  })

  it('does not treat an existing managed reference as session permission', async () => {
    const f = await fixture()
    f.bridge.beginSessionAssetSelection.mockRejectedValue(new FigPluginBridgeError('UNAUTHORIZED'))
    await expect(f.choose()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(f.materialize).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
  })

  it('requires trusted main-frame workshop authority even with a syntactically valid managed source', async () => {
    const f = await fixture()
    for (const context of [
      undefined,
      invocation('chooseManagedSessionAsset', { senderId: 999 }),
      invocation('chooseManagedSessionAsset', { isMainFrame: false }),
      invocation('chooseManagedSessionAsset', { senderUrl: 'https://invalid.example' }),
      invocation('chooseManagedSessionAsset', { frameUrl: 'https://invalid.example' }),
      invocation('chooseManagedSessionAsset', { methodName: 'svcOther.method' })
    ])
      await expect(f.service.chooseManagedSessionAsset(request(), context)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED'
      })
    f.window.webContents.getURL.mockReturnValue('file:///app/index.html#/chat')
    await expect(f.choose()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.materialize).not.toHaveBeenCalled()
    expect(f.bridge.beginSessionAssetSelection).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects injected source paths, ownership claims and unsanitized MediaReferences at IPC and service boundaries', async () => {
    const f = await fixture()
    for (const value of [
      { ...request(), sourcePath: 'C:\\PRIVATE-SOURCE.png' },
      { ...request(), owner: 'generated-task' },
      { ...request(), source: { ...request().source, approved: true } },
      { ...request(), source: { kind: 'file', path: 'C:\\PRIVATE-SOURCE.png' } },
      ...[
        { originalUrl: 'https://example.invalid/PRIVATE-SOURCE.png' },
        { mediaId: 'media-id' },
        { derivatives: [] },
        { completed: true },
        { owner: 'generated-task' },
        { relativePath: '../PRIVATE-SOURCE.png' }
      ].map((extra) => ({
        ...request(),
        source: { kind: 'managed-media', reference: { ...reference(), ...extra } }
      }))
    ]) {
      expect(() =>
        validateServiceValue(value, figPluginCenterSvcDef.chooseManagedSessionAsset.request)
      ).toThrow()
      const error = await f.service
        .chooseManagedSessionAsset(
          value as FigPluginDesktopManagedAssetRequest,
          invocation('chooseManagedSessionAsset')
        )
        .catch((failure) => failure)
      expect(error).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(String(error)).not.toContain('PRIVATE-')
    }
    expect(f.materialize).not.toHaveBeenCalled()
    expect(f.bridge.beginSessionAssetSelection).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
  })

  it('refuses a declared source above the signed lower ceiling before materialization or consent', async () => {
    const f = await fixture()
    f.bridge.beginSessionAssetSelection.mockResolvedValue({ ...selection(), maxBytes: 32 })
    await expect(f.choose()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.materialize).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
  })

  it('passes the exact signed lower ceiling when the original source fits it', async () => {
    const f = await fixture()
    f.bridge.beginSessionAssetSelection.mockResolvedValue({ ...selection(), maxBytes: png.length })
    expect(await f.choose()).toEqual(asset())
    expect(f.materialize).toHaveBeenCalledWith(
      reference(),
      expect.objectContaining({ maxBytes: png.length })
    )
  })

  it.each(['sha256', 'mimeType', 'sizeBytes'] as const)(
    'erases materialized bytes that disagree with the selected reference %s before consent',
    async (field) => {
      const f = await fixture()
      f.materialize.mockImplementation(async () => {
        const value = materialized()
        if (field === 'sha256') value.sha256 = '0'.repeat(64)
        if (field === 'mimeType') value.mimeType = 'image/jpeg'
        if (field === 'sizeBytes') {
          value.bytes.fill(0)
          value.bytes = Buffer.concat([png, Buffer.from([0])])
          retainedBuffers.push(value.bytes)
        }
        return value
      })
      await expect(f.choose()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(native.showMessageBox).not.toHaveBeenCalled()
      expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
    }
  )

  it.each([
    { response: 1, checkboxChecked: true },
    { response: 0, checkboxChecked: false },
    { response: 0 }
  ])(
    'does not publish without both affirmative consent and checked acknowledgement: %j',
    async (response) => {
      const f = await fixture()
      native.showMessageBox.mockResolvedValue(response)
      expect(await f.choose()).toBeNull()
      expect(f.materialize).toHaveBeenCalledOnce()
      expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
    }
  )

  it.each(['materialization', 'consent', 'publication'] as const)(
    'rejects same-URL navigation during %s and revokes only a late published receipt',
    async (stage) => {
      const f = await fixture()
      const gate = deferred<void>()
      const entered = deferred<void>()
      if (stage === 'materialization')
        f.materialize.mockImplementation(async () => {
          entered.resolve()
          await gate.promise
          return materialized()
        })
      if (stage === 'consent')
        native.showMessageBox.mockImplementation(async () => {
          entered.resolve()
          await gate.promise
          return approved
        })
      if (stage === 'publication')
        f.bridge.publishSessionAsset.mockImplementation(async () => {
          entered.resolve()
          await gate.promise
          return asset()
        })
      const pending = f.choose()
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
      await entered.promise
      f.window.webContents.emit('did-start-navigation')
      gate.resolve()
      await rejected
      if (stage === 'publication')
        expect(f.bridge.revokeSessionAsset).toHaveBeenCalledExactlyOnceWith({
          ...target,
          assetId: asset().assetId,
          sha256
        })
      else expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
    }
  )

  it.each(['session-asset', 'plugin'] as const)(
    'keeps %s revocation reachable during native consent and rejects the late approval',
    async (revocation) => {
      const f = await fixture()
      const modal = deferred<typeof approved>()
      const opened = deferred<void>()
      native.showMessageBox.mockImplementation(() => {
        opened.resolve()
        return modal.promise
      })
      const pending = f.choose()
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
      await opened.promise
      if (revocation === 'plugin')
        await f.service.revokeBridge({ pluginId: target.pluginId }, invocation('revokeBridge'))
      else
        await f.service.revokeSessionAsset(
          { ...target, assetId: asset().assetId, sha256 },
          invocation('revokeSessionAsset')
        )
      modal.resolve(approved)
      await rejected
      expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
    }
  )

  it('shares the exclusive chooser lane without blocking explicit revocation', async () => {
    const f = await fixture()
    const modal = deferred<typeof approved>()
    const opened = deferred<void>()
    native.showMessageBox.mockImplementation(() => {
      opened.resolve()
      return modal.promise
    })
    const pending = f.choose()
    await opened.promise
    await expect(f.choose()).rejects.toMatchObject({ code: 'BUSY' })
    await expect(
      f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    ).rejects.toMatchObject({ code: 'BUSY' })
    modal.resolve({ response: 1, checkboxChecked: true })
    expect(await pending).toBeNull()
    expect(f.materialize).toHaveBeenCalledOnce()
  })

  it.each(['materialization', 'consent', 'publication'] as const)(
    'times out %s, aborts materialization authority and scrubs/revokes any late completion',
    async (stage) => {
      const f = await fixture()
      const gate = deferred<void>()
      const entered = deferred<void>()
      if (stage === 'materialization')
        f.materialize.mockImplementation(async () => {
          entered.resolve()
          await gate.promise
          return materialized()
        })
      if (stage === 'consent')
        native.showMessageBox.mockImplementation(async () => {
          entered.resolve()
          await gate.promise
          return approved
        })
      if (stage === 'publication')
        f.bridge.publishSessionAsset.mockImplementation(async () => {
          entered.resolve()
          await gate.promise
          return asset()
        })
      const pending = f.choose()
      const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
      await entered.promise
      await vi.advanceTimersByTimeAsync(FIGPLUGIN_ASSET_TTL_MS)
      await rejected
      expect(f.materialize.mock.calls[0][1].signal.aborted).toBe(true)
      expect(() => f.materialize.mock.calls[0][1].check()).toThrow()
      gate.resolve()
      await vi.waitFor(() => {
        expect(retainedBuffers).toHaveLength(1)
        for (const bytes of retainedBuffers) expect(bytes.every((byte) => byte === 0)).toBe(true)
        if (stage === 'publication')
          expect(f.bridge.revokeSessionAsset).toHaveBeenCalledExactlyOnceWith({
            ...target,
            assetId: asset().assetId,
            sha256
          })
        else expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
      })
    }
  )

  it('does not return a cancelled consent after the trusted page has changed', async () => {
    const f = await fixture()
    native.showMessageBox.mockImplementation(async () => {
      f.window.webContents.getURL.mockReturnValue('file:///app/index.html#/chat')
      return { response: 1, checkboxChecked: false }
    })
    await expect(f.choose()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
  })

  it.each([
    { sessionId: '9'.repeat(32) },
    { pluginId: 'foreign.figma' },
    { projectId: 'foreign-project' },
    { host: 'photoshop' },
    { sha256: '0'.repeat(64) },
    { sizeBytes: png.length + 1 },
    { mimeType: 'image/jpeg' },
    { width: 2 },
    { height: 2 },
    { expiresAt: 1_800_000_000_000 }
  ])(
    'rejects a substituted or expired publication receipt and revokes the new grant: %j',
    async (patch) => {
      const f = await fixture()
      const published = { ...asset(), ...patch } as FigPluginSessionAsset
      f.bridge.publishSessionAsset.mockResolvedValue(published)
      await expect(f.choose()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(f.bridge.revokeSessionAsset).toHaveBeenCalledExactlyOnceWith({
        ...target,
        assetId: published.assetId,
        sha256: published.sha256
      })
    }
  )

  it('sanitizes source failure and does not publish across a changed binding', async () => {
    const f = await fixture()
    f.materialize.mockRejectedValueOnce(
      new Error('C:\\PRIVATE-SOURCE.png https://invalid.example/provider-key')
    )
    const failed = await f.choose().catch((error) => error)
    expect(failed).toMatchObject({ code: 'IO_ERROR' })
    expect(String(failed)).not.toMatch(/PRIVATE-|provider-key|https:/)
    expect(native.showMessageBox).not.toHaveBeenCalled()
    f.bridge.publishSessionAsset.mockRejectedValue(
      new FigPluginBridgeError('CONFIGURATION_CHANGED')
    )
    await expect(f.choose()).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    expect(f.publicationSnapshots).toEqual([])
  })
})
