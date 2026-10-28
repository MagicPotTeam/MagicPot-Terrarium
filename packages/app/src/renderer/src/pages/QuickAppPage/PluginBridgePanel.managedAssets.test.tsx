import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { createInstance } from 'i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import type { FigPluginBridgeDesktopState } from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  type FigPluginAssetList,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import type { ResultItem, ResultItemImage } from '@shared/qApp/resultTypes'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import comfyStatus, {
  appendResults,
  clearResults,
  deleteResult
} from '@renderer/store/slices/comfyStatus'
import type { ProjectRecord } from '../MainPage/projectStore'
import PluginBridgePanel from './PluginBridgePanel'
import { managedOutputChoices } from './pluginBridgeManagedAssets'

const mocks = vi.hoisted(() => ({
  center: {
    bridgeState: vi.fn<FigPluginCenterSvc['bridgeState']>(),
    nativeImageGenerationProposals: vi.fn<FigPluginCenterSvc['nativeImageGenerationProposals']>(),
    planState: vi.fn<FigPluginCenterSvc['planState']>(),
    chooseSessionAsset: vi.fn<FigPluginCenterSvc['chooseSessionAsset']>(),
    chooseManagedSessionAsset: vi.fn<FigPluginCenterSvc['chooseManagedSessionAsset']>(),
    sessionAssets: vi.fn<FigPluginCenterSvc['sessionAssets']>(),
    revokeSessionAsset: vi.fn<FigPluginCenterSvc['revokeSessionAsset']>(),
    revokeBridge: vi.fn<FigPluginCenterSvc['revokeBridge']>(),
    approveBridge: vi.fn<FigPluginCenterSvc['approveBridge']>(),
    approvePlanExecution: vi.fn<FigPluginCenterSvc['approvePlanExecution']>()
  },
  profiles: vi.fn(),
  projects: vi.fn<() => ProjectRecord[]>(),
  translate: vi.fn<(key: string, values?: Record<string, unknown>) => string>()
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcFigPluginCenter: mocks.center, svcLLMProxy: { listProfiles: mocks.profiles } })
}))
vi.mock('../MainPage/projectStore', () => ({
  listProjects: mocks.projects,
  getProjectById: (id: string) => mocks.projects().find((item) => item.id === id),
  PROJECTS_CHANGED_EVENT: 'app:projects-changed'
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.translate }) }))
// Keep the real useComfyStatus hook and reducer, without creating the application singleton.
vi.mock('@renderer/store', async () => {
  const { useDispatch, useSelector } = await import('react-redux')
  return { useAppDispatch: useDispatch, useAppSelector: useSelector }
})

const plugin: FigPluginManagedSummary = {
  pluginId: 'synthetic.plugin',
  name: 'Synthetic plugin',
  version: '1.0.0',
  host: 'figma',
  generation: 7,
  capabilities: ['dialogue', 'asset-transfer'],
  manifestSha256: '1'.repeat(64),
  materialization: 'verified-package',
  signerFingerprint: '2'.repeat(64),
  artifactSha256: '3'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:43123',
  fileCount: 3,
  contentBytes: 1024,
  configured: true,
  ready: false,
  state: 'disabled',
  cleanupPending: false,
  settings: { analysisProfileId: 'synthetic-model' }
}
const project: ProjectRecord = {
  id: 'project_1',
  name: 'Synthetic project',
  createdAt: 1,
  updatedAt: 1,
  canvasStorageKey: 'synthetic',
  chatStorageScopePrefix: 'synthetic',
  defaultQAppKey: '',
  storageDirName: 'synthetic'
}
const output = (id = 'result-1'): ResultItemImage => ({
  id,
  promptId: 'task-1',
  projectId: project.id,
  type: 'image',
  objectUrl: 'local-media:///managed/images/source.png',
  fileItem: { filename: 'source.png', subfolder: '', type: 'output' },
  media: {
    version: 1,
    kind: 'managed',
    relativePath: 'images/source.png',
    sha256: 'a'.repeat(64),
    sizeBytes: 68,
    mimeType: 'image/png',
    originalFileName: 'source.png',
    mediaId: 'opaque-source',
    width: 40,
    height: 30,
    status: 'ready',
    originalUrl: 'https://invalid.example/not-forwarded.png',
    derivatives: [
      {
        maxEdge: 256,
        relativePath: 'derivatives/source.webp',
        mimeType: 'image/webp',
        sizeBytes: 30,
        width: 40,
        height: 30,
        sha256: 'b'.repeat(64)
      }
    ]
  },
  mimeType: 'image/png',
  sizeBytes: 68
})
const reference = () => ({
  version: 1 as const,
  kind: 'managed' as const,
  relativePath: 'images/source.png',
  sha256: 'a'.repeat(64),
  sizeBytes: 68,
  mimeType: 'image/png',
  originalFileName: 'source.png'
})
const session = (
  host: 'figma' | 'photoshop' = 'figma'
): FigPluginBridgeDesktopState['sessions'][number] => ({
  sessionId: '4'.repeat(32),
  pluginId: plugin.pluginId,
  projectId: project.id,
  host,
  expiresAt: Date.now() + 300_000,
  activeCalls: 0
})
const lease = (host: 'figma' | 'photoshop' = 'figma', id = '5'): FigPluginSessionAsset => ({
  version: 1,
  kind: 'session-image-asset',
  purpose: 'local-preview',
  sessionId: '4'.repeat(32),
  pluginId: plugin.pluginId,
  projectId: project.id,
  host,
  assetId: id.repeat(32),
  mimeType: 'image/png',
  sha256: 'a'.repeat(64),
  sizeBytes: 68,
  width: 40,
  height: 30,
  chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
  chunkCount: 1,
  createdAt: Date.now(),
  expiresAt: Date.now() + 120_000
})
const catalog = (assets: FigPluginSessionAsset[] = []): FigPluginAssetList => ({
  protocol: 1,
  purpose: 'local-preview',
  sessionId: '4'.repeat(32),
  assets
})
const t = (key: string, values?: Record<string, unknown>) =>
  mocks.translate(`figplugin.bridge.${key}`, values)
const button = (key: string) => screen.getByRole('button', { name: t(key) })
const image = (id = 'result-1') =>
  screen.getByRole('img', { name: t('managedThumbnail', { result: id }) })
const radio = (id = 'result-1') =>
  screen.getByRole('radio', { name: t('managedOutputIdentity', { result: id, task: 'task-1' }) })
const click = async (key: string) => {
  await act(async () => {
    fireEvent.click(button(key))
  })
}
const load = (id = 'result-1', width = 40, height = 30) => {
  const element = image(id)
  Object.defineProperty(element, 'naturalWidth', { configurable: true, value: width })
  Object.defineProperty(element, 'naturalHeight', { configurable: true, value: height })
  fireEvent.load(element)
}
const choose = async (id = 'result-1') => {
  await act(async () => {
    load(id)
    fireEvent.click(radio(id))
  })
}
const localize = async (locale: typeof en | typeof zh = en) => {
  const i18n = createInstance()
  await i18n.init({
    lng: 'test',
    fallbackLng: false,
    resources: { test: { translation: locale } },
    interpolation: { escapeValue: false }
  })
  mocks.translate.mockImplementation((key, values) => i18n.t(key, { ...values, defaultValue: key }))
}
async function mount(results: ResultItem[] = [output()], host: 'figma' | 'photoshop' = 'figma') {
  const store = configureStore({ reducer: { comfyStatus: comfyStatus.reducer } })
  store.dispatch(appendResults(results))
  mocks.center.bridgeState.mockResolvedValue({ sessions: [session(host)], previews: [] })
  const view = render(
    <Provider store={store}>
      <PluginBridgePanel items={[{ ...plugin, host }]} />
    </Provider>
  )
  await click('refresh')
  const rerender = (item: FigPluginManagedSummary) =>
    view.rerender(
      <Provider store={store}>
        <PluginBridgePanel items={[item]} />
      </Provider>
    )
  return { ...view, store, rerender }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeAll(async () => {
  await import('./PluginBridgeManagedAssetPicker')
})
beforeEach(async () => {
  vi.resetAllMocks()
  mocks.center.nativeImageGenerationProposals.mockResolvedValue({ proposals: [] })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    })
  )
  mocks.projects.mockReturnValue([project])
  mocks.profiles.mockResolvedValue({ profiles: [] })
  mocks.center.planState.mockResolvedValue({
    previews: [],
    statuses: [],
    baselines: [],
    correctionAuthorizations: []
  })
  mocks.center.chooseManagedSessionAsset.mockResolvedValue(null)
  mocks.center.sessionAssets.mockResolvedValue(catalog())
  mocks.center.revokeSessionAsset.mockResolvedValue(undefined)
  mocks.center.revokeBridge.mockResolvedValue(undefined)
  await localize()
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  expect(fetch).not.toHaveBeenCalled()
  expect(mocks.center.chooseSessionAsset).not.toHaveBeenCalled()
  expect(mocks.center.approveBridge).not.toHaveBeenCalled()
  expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('explicit managed output to temporary Bridge preview', () => {
  it.each([
    { locale: en, language: 'en', host: 'figma' },
    { locale: zh, language: 'zh', host: 'photoshop' }
  ] as const)(
    'shows current $language/$host results only after opening and sends the seven-field reference after selection/load/share',
    async ({ locale, host }) => {
      await localize(locale)
      const granted = lease(host)
      mocks.center.chooseManagedSessionAsset.mockResolvedValue(granted)
      mocks.center.sessionAssets.mockResolvedValue(catalog([granted]))
      const { store } = await mount([output()], host)
      expect(screen.queryByRole('img')).toBeNull()
      expect(mocks.center.chooseManagedSessionAsset).not.toHaveBeenCalled()
      await click('chooseManagedAsset')
      expect(image()).toHaveAttribute('src', output().objectUrl)
      expect(screen.getByText(locale.figplugin.bridge.managedPickerHelp)).toBeVisible()
      expect(
        screen.getByText(
          t('managedPickerTarget', {
            plugin: plugin.pluginId,
            host,
            project: project.id,
            session: session().sessionId
          })
        )
      ).toBeVisible()
      expect(
        screen.getByText(t('managedOutputMetadata', { mime: 'image/png', bytes: 68 }))
      ).toBeVisible()
      expect(screen.getByText(t('assetHash', { hash: 'a'.repeat(64) }))).toBeVisible()
      expect(radio()).not.toBeChecked()
      expect(button('shareManagedPreview')).toBeDisabled()
      fireEvent.click(radio())
      expect(button('shareManagedPreview')).toBeDisabled()
      load()
      expect(button('shareManagedPreview')).toBeEnabled()
      expect(mocks.center.chooseManagedSessionAsset).not.toHaveBeenCalled()
      await click('shareManagedPreview')
      expect(mocks.center.chooseManagedSessionAsset).toHaveBeenCalledExactlyOnceWith({
        sessionId: session().sessionId,
        pluginId: plugin.pluginId,
        projectId: project.id,
        source: { kind: 'managed-media', reference: reference() }
      })
      expect(screen.queryByRole('region', { name: t('managedPickerTitle') })).toBeNull()
      expect(
        screen.getByRole('article', { name: t('assetCard', { id: granted.assetId }) })
      ).toBeVisible()
      expect(screen.getByText(locale.figplugin.bridge.assetAdded)).toBeVisible()
      expect(document.body).not.toHaveTextContent('figplugin.bridge.')
      // The accepted lease is an independent snapshot, not a live result-ownership grant.
      act(() => {
        store.dispatch(deleteResult('result-1'))
      })
      expect(mocks.center.revokeSessionAsset).not.toHaveBeenCalled()
    }
  )

  it('renders only matching-project managed local images, never blob/remote/path or ambiguous rows', async () => {
    const missingProject = output('missing-project')
    delete missingProject.projectId
    const blob = output('blob')
    blob.objectUrl = 'blob:synthetic'
    const remote = output('remote')
    remote.objectUrl = 'https://invalid.example/image.png'
    const path = output('path')
    path.objectUrl = 'C:/fixture-local/image.png'
    const wrongPath = output('wrong-path')
    wrongPath.objectUrl = 'local-media:///managed/images/other.png'
    const unsupported = output('gif')
    unsupported.media!.mimeType = 'image/gif'
    const missing = output('missing')
    missing.media!.status = 'missing'
    const noReference = output('no-reference')
    delete noReference.media
    await mount([
      output(),
      missingProject,
      { ...output('other-project'), projectId: 'other' },
      blob,
      remote,
      path,
      wrongPath,
      unsupported,
      missing,
      noReference,
      output('duplicate'),
      output('duplicate')
    ])
    await click('chooseManagedAsset')
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(image()).toHaveAttribute('src', output().objectUrl)
    expect(mocks.center.chooseManagedSessionAsset).not.toHaveBeenCalled()
  })

  it.each(['error', 'zero dimensions', 'oversized'] as const)(
    'refuses sharing after a thumbnail %s',
    async (mode) => {
      await mount()
      await click('chooseManagedAsset')
      fireEvent.click(radio())
      if (mode === 'error') fireEvent.error(image())
      else load('result-1', mode === 'zero dimensions' ? 0 : 4097, 30)
      expect(radio()).not.toBeChecked()
      expect(radio()).toBeDisabled()
      expect(button('shareManagedPreview')).toBeDisabled()
      await click('shareManagedPreview')
      expect(screen.getByText(en.figplugin.bridge.managedThumbnailFailed)).toBeVisible()
      expect(mocks.center.chooseManagedSessionAsset).not.toHaveBeenCalled()
    }
  )

  it.each(['deleted', 'same-id replacement', 'changed media', 'changed project'] as const)(
    'invalidates a %s source during native consent despite the global pending lock',
    async (change) => {
      const { store } = await mount()
      await click('chooseManagedAsset')
      await choose()
      const pending = deferred<FigPluginSessionAsset | null>()
      mocks.center.chooseManagedSessionAsset.mockReturnValueOnce(pending.promise)
      await click('shareManagedPreview')
      const oldImage = image()
      act(() => {
        store.dispatch(clearResults())
        if (change !== 'deleted') {
          const changed = output()
          if (change === 'changed media') changed.media!.sha256 = 'b'.repeat(64)
          if (change === 'changed project') changed.projectId = 'other'
          store.dispatch(appendResults([changed]))
        }
      })
      fireEvent.load(oldImage)
      expect(button('shareManagedPreview')).toBeDisabled()
      for (const item of screen.queryAllByRole('radio')) expect(item).not.toBeChecked()
      const granted = lease()
      await act(async () => {
        pending.resolve(granted)
      })
      expect(mocks.center.revokeSessionAsset).toHaveBeenCalledExactlyOnceWith({
        sessionId: granted.sessionId,
        pluginId: granted.pluginId,
        projectId: granted.projectId,
        assetId: granted.assetId,
        sha256: granted.sha256
      })
      expect(
        screen.queryByRole('article', { name: t('assetCard', { id: granted.assetId }) })
      ).toBeNull()
      expect(screen.queryByText(en.figplugin.bridge.assetAdded)).toBeNull()
      expect(mocks.center.sessionAssets).not.toHaveBeenCalled()
    }
  )

  it.each([
    'close',
    'unmount',
    'revoke',
    'session expiry',
    'project deletion',
    'plugin generation',
    'capability loss'
  ] as const)(
    'revokes a late lease after %s without presenting it as a completed share',
    async (change) => {
      const view = await mount()
      await click('chooseManagedAsset')
      await choose()
      const pending = deferred<FigPluginSessionAsset | null>()
      mocks.center.chooseManagedSessionAsset.mockReturnValueOnce(pending.promise)
      await click('shareManagedPreview')
      if (change === 'close') await click('closeManagedPicker')
      if (change === 'unmount') view.unmount()
      if (change === 'revoke') await click('revoke')
      if (change === 'session expiry')
        await act(async () => {
          await vi.advanceTimersByTimeAsync(300_001)
        })
      if (change === 'project deletion')
        act(() => {
          mocks.projects.mockReturnValue([])
          window.dispatchEvent(new Event('app:projects-changed'))
        })
      if (change === 'plugin generation')
        view.rerender({ ...plugin, generation: plugin.generation + 1 })
      if (change === 'capability loss') view.rerender({ ...plugin, capabilities: ['dialogue'] })
      const granted = lease()
      await act(async () => {
        pending.resolve(granted)
      })
      expect(mocks.center.revokeSessionAsset).toHaveBeenCalledExactlyOnceWith({
        sessionId: granted.sessionId,
        pluginId: granted.pluginId,
        projectId: granted.projectId,
        assetId: granted.assetId,
        sha256: granted.sha256
      })
      expect(screen.queryByText(en.figplugin.bridge.assetAdded)).toBeNull()
      expect(mocks.center.sessionAssets).not.toHaveBeenCalled()
    }
  )

  it('discards a lease when the source disappears during the post-consent catalog refresh', async () => {
    const { store } = await mount()
    const granted = lease(),
      pending = deferred<FigPluginAssetList>()
    mocks.center.chooseManagedSessionAsset.mockResolvedValue(granted)
    mocks.center.sessionAssets.mockReturnValueOnce(pending.promise)
    await click('chooseManagedAsset')
    await choose()
    await click('shareManagedPreview')
    expect(mocks.center.sessionAssets).toHaveBeenCalledTimes(1)
    act(() => {
      store.dispatch(deleteResult('result-1'))
    })
    await act(async () => {
      pending.resolve(catalog([granted]))
    })
    expect(mocks.center.revokeSessionAsset).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('article', { name: t('assetCard', { id: granted.assetId }) })
    ).toBeNull()
    expect(screen.queryByText(en.figplugin.bridge.assetAdded)).toBeNull()
  })

  it('keeps a declined native confirmation grant-free', async () => {
    await mount()
    await click('chooseManagedAsset')
    await choose()
    await click('shareManagedPreview')
    expect(screen.getByText(en.figplugin.bridge.assetDeclined)).toBeVisible()
    expect(mocks.center.sessionAssets).not.toHaveBeenCalled()
    expect(mocks.center.revokeSessionAsset).not.toHaveBeenCalled()
  })

  it('enforces session quota on the open picker and on its entry point', async () => {
    await mount()
    await click('chooseManagedAsset')
    await choose()
    mocks.center.sessionAssets.mockResolvedValue(
      catalog(['5', '6', '7', '8'].map((id) => lease('figma', id)))
    )
    await click('listAssets')
    expect(button('chooseManagedAsset')).toBeDisabled()
    expect(button('shareManagedPreview')).toBeDisabled()
    await click('shareManagedPreview')
    expect(mocks.center.chooseManagedSessionAsset).not.toHaveBeenCalled()
  })

  it('invalidates selection when the target binding changes, not for unrelated call telemetry', async () => {
    await mount()
    await click('chooseManagedAsset')
    await choose()
    mocks.center.bridgeState.mockResolvedValue({
      sessions: [{ ...session(), activeCalls: 1 }],
      previews: []
    })
    await click('refresh')
    expect(radio()).toBeChecked()
    mocks.center.bridgeState.mockResolvedValue({
      sessions: [{ ...session(), expiresAt: session().expiresAt + 1000 }],
      previews: []
    })
    await click('refresh')
    expect(radio()).not.toBeChecked()
    expect(button('shareManagedPreview')).toBeDisabled()
    expect(mocks.center.chooseManagedSessionAsset).not.toHaveBeenCalled()
  })

  it('does not announce an expired lease after a stalled catalog refresh', async () => {
    await mount()
    const granted = lease(),
      pending = deferred<FigPluginAssetList>()
    mocks.center.chooseManagedSessionAsset.mockResolvedValue(granted)
    mocks.center.sessionAssets.mockReturnValueOnce(pending.promise)
    await click('chooseManagedAsset')
    await choose()
    await click('shareManagedPreview')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
      pending.resolve(catalog([granted]))
    })
    expect(mocks.center.revokeSessionAsset).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('article', { name: t('assetCard', { id: granted.assetId }) })
    ).toBeNull()
    expect(screen.queryByText(en.figplugin.bridge.assetAdded)).toBeNull()
  })

  it.each(['hash', 'mime', 'bytes'] as const)(
    'rejects a returned lease with changed %s',
    async (field) => {
      const granted = lease()
      if (field === 'hash') granted.sha256 = 'b'.repeat(64)
      if (field === 'mime') granted.mimeType = 'image/jpeg'
      if (field === 'bytes') granted.sizeBytes += 1
      mocks.center.chooseManagedSessionAsset.mockResolvedValue(granted)
      await mount()
      await click('chooseManagedAsset')
      await choose()
      await click('shareManagedPreview')
      expect(mocks.center.revokeSessionAsset).toHaveBeenCalledTimes(1)
      expect(mocks.center.sessionAssets).not.toHaveBeenCalled()
      expect(screen.queryByText(en.figplugin.bridge.assetAdded)).toBeNull()
    }
  )
})

describe('managed output candidate projection', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)(
    'accepts canonical %s and strips unrelated reference metadata',
    (mimeType) => {
      const item = output()
      item.media!.mimeType = mimeType
      const [choice] = managedOutputChoices([item], project.id)
      expect(choice.reference).toEqual({ ...reference(), mimeType })
      expect(Object.keys(choice.reference)).toHaveLength(7)
    }
  )

  it.each([
    'uppercase hash',
    'uppercase mime',
    'oversized bytes',
    'encoded path',
    'URL credentials',
    'URL query',
    'URL fragment',
    'missing metadata',
    'project asset',
    'pending'
  ] as const)('rejects %s without trying another transport', (field) => {
    const item = output()
    if (field === 'uppercase hash') item.media!.sha256 = 'A'.repeat(64)
    if (field === 'uppercase mime') item.media!.mimeType = 'IMAGE/PNG'
    if (field === 'oversized bytes') item.media!.sizeBytes = 8 * 1024 * 1024 + 1
    if (field === 'encoded path') item.media!.relativePath = 'images/%73ource.png'
    if (field === 'URL credentials')
      item.objectUrl = 'local-media://user:password@host/managed/images/source.png'
    if (field === 'URL query') item.objectUrl += '?secret=1'
    if (field === 'URL fragment') item.objectUrl += '#secret'
    if (field === 'missing metadata') delete item.media!.sha256
    if (field === 'project asset') item.media!.kind = 'project-asset'
    if (field === 'pending') item.media!.status = 'pending'
    expect(managedOutputChoices([item], project.id)).toEqual([])
  })
})
