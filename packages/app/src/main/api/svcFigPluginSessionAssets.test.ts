import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { figPluginCenterSvcDef } from '@shared/api/svcFigPluginCenter'
import { validateServiceValue } from '@shared/api/apiUtils/serviceValidation'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_TTL_MS,
  type FigPluginDesktopAssetTarget,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import { FigPluginBridgeError, type FigPluginRuntimeBinding } from '@shared/figplugin/bridge'
import type { FigPluginAssetSelection } from '../figplugin/bridgeRuntime'
import type { SessionAssetMaterializer } from '../figplugin/hostAssetMaterialization'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { disposeFigPluginBridges, FigPluginCenterSvcImpl } from './svcFigPluginCenterImpl'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
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
const approved = { response: 0, checkboxChecked: true }
type Bridge = Awaited<
  ReturnType<NonNullable<ConstructorParameters<typeof FigPluginCenterSvcImpl>[2]>>
>
type Method =
  'chooseSessionAsset' | 'sessionAssets' | 'revokeSessionAsset' | 'createPairing' | 'revokeBridge'
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
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

let root: string
let filename: string
beforeEach(async () => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  clearMagicAgentTrustedRouteBindingsForTest()
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-assets-service-')))
  filename = path.join(root, 'synthetic.png')
  await fs.writeFile(filename, png)
  native.getPath.mockImplementation(() => {
    throw new Error('User data is forbidden in this fixture')
  })
  native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filename] })
  native.showMessageBox.mockResolvedValue(approved)
  native.createFromBuffer.mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 })
  })
})
afterEach(async () => {
  await disposeFigPluginBridges()
  clearMagicAgentTrustedRouteBindingsForTest()
  vi.useRealTimers()
  expect(native.getPath).not.toHaveBeenCalled()
  const absolute = path.resolve(root)
  if (absolute !== root || !path.basename(root).startsWith('figplugin-assets-service-'))
    throw new Error('Unexpected test cleanup root')
  await fs.rm(absolute, { recursive: true, force: true })
})

async function fixture(options: { productionMaterializer?: boolean } = {}) {
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
    listSessionAssets: vi.fn<Bridge['listSessionAssets']>().mockImplementation(async () => ({
      protocol: 1,
      purpose: 'local-preview',
      sessionId: target.sessionId,
      assets: [asset()]
    })),
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
  const materialize = vi
    .fn<SessionAssetMaterializer>()
    .mockImplementation(async (source, { check }) => {
      const bytes = await fs.readFile(source)
      check()
      return { mimeType: 'image/png', width: 1, height: 1, sha256, bytes }
    })
  const service = new FigPluginCenterSvcImpl(
    undefined,
    () => window as unknown as BrowserWindow,
    async () => bridge,
    undefined,
    undefined,
    undefined,
    options.productionMaterializer ? undefined : materialize
  )
  await service.createPairing(
    { pluginId: target.pluginId, expectedGeneration: 1, projectId: target.projectId },
    invocation('createPairing')
  )
  native.showMessageBox.mockClear()
  return { service, bridge, window, materialize, publicationSnapshots }
}

describe('Desktop session image chooser authority', () => {
  it('uses the production transient ManagedMedia materializer with a mocked native decoder', async () => {
    const f = await fixture({ productionMaterializer: true })
    await expect(
      f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    ).resolves.toEqual(asset())
    expect(f.materialize).not.toHaveBeenCalled()
    expect(native.createFromBuffer).toHaveBeenCalledOnce()
    expect(f.publicationSnapshots).toEqual([png])
    expect(await fs.readFile(filename)).toEqual(png)
  })

  it('publishes only the captured bytes if the chosen file changes during consent', async () => {
    const f = await fixture({ productionMaterializer: true })
    const replacement = Buffer.from('later source contents')
    native.showMessageBox.mockImplementation(async () => {
      await fs.writeFile(filename, replacement)
      return approved
    })
    await f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    expect(f.publicationSnapshots).toEqual([png])
    expect(await fs.readFile(filename)).toEqual(replacement)
  })

  it('does not open a chooser without an authorized asset-transfer session', async () => {
    const f = await fixture()
    f.bridge.beginSessionAssetSelection.mockRejectedValue(new FigPluginBridgeError('UNAUTHORIZED'))
    await expect(
      f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(native.showOpenDialog).not.toHaveBeenCalled()
    expect(f.materialize).not.toHaveBeenCalled()
  })

  it('passes the signed lower payload ceiling to materialization and rejects an overbudget result before consent', async () => {
    const f = await fixture()
    f.bridge.beginSessionAssetSelection.mockResolvedValue({ ...selection(), maxBytes: 32 })
    await expect(
      f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.materialize).toHaveBeenCalledWith(filename, expect.objectContaining({ maxBytes: 32 }))
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
    const retained = await f.materialize.mock.results[0].value
    expect(retained.bytes.every((byte) => byte === 0)).toBe(true)
  })

  it('captures the binding before choosing and consents to exact immutable bytes without a path in IPC', async () => {
    const f = await fixture()
    const result = await f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    expect(result).toEqual(asset())
    expect(f.bridge.beginSessionAssetSelection.mock.invocationCallOrder[0]).toBeLessThan(
      native.showOpenDialog.mock.invocationCallOrder[0]
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
    expect(f.bridge.publishSessionAsset.mock.calls[0][1].bytes.every((byte) => byte === 0)).toBe(
      true
    )
    expect(native.showMessageBox).toHaveBeenCalledWith(
      f.window,
      expect.objectContaining({
        defaultId: 1,
        cancelId: 1,
        checkboxChecked: false,
        detail: expect.stringContaining(sha256)
      })
    )
    const details = native.showMessageBox.mock.calls[0][1].detail
    for (const value of [
      target.pluginId,
      target.projectId,
      target.sessionId,
      'local-preview',
      'No model upload',
      'no document-write',
      `${png.length} bytes`
    ])
      expect(details).toContain(value)
    expect(details).not.toContain(filename)
    expect(JSON.stringify(result)).not.toContain(filename)
    expect(JSON.stringify(result)).not.toContain('bytesBase64')
  })

  it.each(['chooseSessionAsset', 'sessionAssets', 'revokeSessionAsset'] as const)(
    'requires trusted main-frame workshop permission for %s',
    async (method) => {
      const f = await fixture()
      const request =
        method === 'revokeSessionAsset' ? { ...target, assetId: asset().assetId, sha256 } : target
      for (const context of [
        undefined,
        invocation(method, { senderId: 999 }),
        invocation(method, { isMainFrame: false }),
        invocation(method, { senderUrl: 'https://invalid.example' }),
        invocation(method, { methodName: 'svcOther.method' })
      ]) {
        await expect(f.service[method](request as never, context)).rejects.toMatchObject({
          code: 'PERMISSION_DENIED'
        })
      }
      expect(native.showOpenDialog).not.toHaveBeenCalled()
      expect(f.bridge.beginSessionAssetSelection).not.toHaveBeenCalled()
    }
  )

  it('rejects renderer path injection at the strict IPC schema and service boundary', async () => {
    const f = await fixture()
    const request = { ...target, sourcePath: filename }
    expect(() =>
      validateServiceValue(request, figPluginCenterSvcDef.chooseSessionAsset.request)
    ).toThrow()
    await expect(
      f.service.chooseSessionAsset(request, invocation('chooseSessionAsset'))
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(native.showOpenDialog).not.toHaveBeenCalled()
  })

  it.each(['chooser', 'consent', 'checkbox'] as const)(
    'does not publish when %s is cancelled',
    async (stage) => {
      const f = await fixture()
      if (stage === 'chooser')
        native.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
      if (stage === 'consent')
        native.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true })
      if (stage === 'checkbox')
        native.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
      await expect(
        f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
      ).resolves.toBeNull()
      expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
      if (stage === 'chooser') expect(f.materialize).not.toHaveBeenCalled()
      for (const result of f.materialize.mock.results) {
        const selected = await result.value
        expect(selected.bytes.every((byte) => byte === 0)).toBe(true)
      }
    }
  )

  it.each(['chooser', 'materialization', 'consent', 'publication'] as const)(
    'does not restore authority after same-URL navigation during %s',
    async (stage) => {
      const f = await fixture()
      const gate = deferred<void>()
      const entered = deferred<void>()
      if (stage === 'chooser')
        native.showOpenDialog.mockImplementation(async () => {
          entered.resolve()
          await gate.promise
          return { canceled: false, filePaths: [filename] }
        })
      if (stage === 'materialization')
        f.materialize.mockImplementation(async () => {
          entered.resolve()
          await gate.promise
          return { mimeType: 'image/png', width: 1, height: 1, sha256, bytes: Buffer.from(png) }
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
      const pending = f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
      await entered.promise
      f.window.webContents.emit('did-start-navigation')
      gate.resolve()
      await rejected
      if (stage === 'publication')
        expect(f.bridge.revokeSessionAsset).toHaveBeenCalledWith({
          ...target,
          assetId: asset().assetId,
          sha256
        })
      else expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
    }
  )

  it('does not return even a cancelled chooser result to a different live route', async () => {
    const f = await fixture()
    native.showOpenDialog.mockImplementation(async () => {
      f.window.webContents.getURL.mockReturnValue('file:///app/index.html#/chat')
      return { canceled: true, filePaths: [] }
    })
    await expect(
      f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.materialize).not.toHaveBeenCalled()
  })

  it('keeps revocation reachable while consent is pending and rejects the late approval', async () => {
    const f = await fixture()
    const modal = deferred<typeof approved>()
    const opened = deferred<void>()
    native.showMessageBox.mockImplementation(async () => {
      opened.resolve()
      return modal.promise
    })
    const pending = f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    await opened.promise
    await f.service.revokeSessionAsset(
      { ...target, assetId: asset().assetId, sha256 },
      invocation('revokeSessionAsset')
    )
    modal.resolve(approved)
    await rejected
    expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
  })

  it('honors plugin revocation pending chooser completion', async () => {
    const f = await fixture()
    const chooser = deferred<{ canceled: boolean; filePaths: string[] }>()
    const opened = deferred<void>()
    native.showOpenDialog.mockImplementation(() => {
      opened.resolve()
      return chooser.promise
    })
    const pending = f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    await opened.promise
    await f.service.revokeBridge({ pluginId: target.pluginId }, invocation('revokeBridge'))
    chooser.resolve({ canceled: false, filePaths: [filename] })
    await rejected
    expect(f.materialize).not.toHaveBeenCalled()
  })

  it('fails closed when configuration changes after consent and sanitizes source failures', async () => {
    const f = await fixture()
    f.bridge.publishSessionAsset.mockRejectedValue(
      new FigPluginBridgeError('CONFIGURATION_CHANGED')
    )
    await expect(
      f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    f.materialize.mockRejectedValue(new Error(`private source: ${filename}`))
    await expect(
      f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
    await f.service.chooseSessionAsset(target, invocation('chooseSessionAsset')).catch((error) => {
      expect(String(error)).not.toContain(filename)
    })
  })

  it('has a finite chooser deadline and ignores its late result', async () => {
    const f = await fixture()
    const chooser = deferred<{ canceled: boolean; filePaths: string[] }>()
    const opened = deferred<void>()
    native.showOpenDialog.mockImplementation(() => {
      opened.resolve()
      return chooser.promise
    })
    const pending = f.service.chooseSessionAsset(target, invocation('chooseSessionAsset'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await opened.promise
    await vi.advanceTimersByTimeAsync(FIGPLUGIN_ASSET_TTL_MS)
    await rejected
    chooser.resolve({ canceled: false, filePaths: [filename] })
    await Promise.resolve()
    expect(f.materialize).not.toHaveBeenCalled()
    expect(f.bridge.publishSessionAsset).not.toHaveBeenCalled()
  })

  it('lists only the exact target and rechecks navigation after the list await', async () => {
    const f = await fixture()
    await expect(
      f.service.sessionAssets(target, invocation('sessionAssets'))
    ).resolves.toMatchObject({ assets: [asset()] })
    f.bridge.listSessionAssets.mockImplementation(async () => {
      f.window.webContents.emit('did-start-navigation')
      return { protocol: 1, purpose: 'local-preview', sessionId: target.sessionId, assets: [] }
    })
    await expect(
      f.service.sessionAssets(target, invocation('sessionAssets'))
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
  })

  it('does not return a stale revoke response after navigation', async () => {
    const f = await fixture()
    f.bridge.revokeSessionAsset.mockImplementation(async () => {
      f.window.webContents.emit('did-start-navigation')
    })
    await expect(
      f.service.revokeSessionAsset(
        { ...target, assetId: asset().assetId, sha256 },
        invocation('revokeSessionAsset')
      )
    ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    expect(f.bridge.revokeSessionAsset).toHaveBeenCalledWith({
      ...target,
      assetId: asset().assetId,
      sha256
    })
  })

  it('rejects an invalid catalog without exposing its contents', async () => {
    const f = await fixture()
    f.bridge.listSessionAssets.mockResolvedValue({
      protocol: 1,
      purpose: 'local-preview',
      sessionId: target.sessionId,
      assets: [{ ...asset(), projectId: 'other' }]
    })
    await expect(
      f.service.sessionAssets(target, invocation('sessionAssets'))
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
