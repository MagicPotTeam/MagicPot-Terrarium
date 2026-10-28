import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import type { FigPluginBridgeDesktopState } from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  type FigPluginAssetList,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import type { ProjectRecord } from '../MainPage/projectStore'
import PluginBridgePanel from './PluginBridgePanel'

const mocks = vi.hoisted(() => ({
  center: {
    bridgeState: vi.fn<FigPluginCenterSvc['bridgeState']>(),
    nativeImageGenerationProposals: vi.fn<FigPluginCenterSvc['nativeImageGenerationProposals']>(),
    planState: vi.fn<FigPluginCenterSvc['planState']>(),
    chooseSessionAsset: vi.fn<FigPluginCenterSvc['chooseSessionAsset']>(),
    sessionAssets: vi.fn<FigPluginCenterSvc['sessionAssets']>(),
    revokeSessionAsset: vi.fn<FigPluginCenterSvc['revokeSessionAsset']>(),
    revokeBridge: vi.fn<FigPluginCenterSvc['revokeBridge']>()
  },
  profiles: vi.fn(),
  projects: vi.fn<() => ProjectRecord[]>()
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcFigPluginCenter: mocks.center, svcLLMProxy: { listProfiles: mocks.profiles } })
}))
vi.mock('../MainPage/projectStore', () => ({
  listProjects: mocks.projects,
  getProjectById: (id: string) => mocks.projects().find((project) => project.id === id),
  PROJECTS_CHANGED_EVENT: 'app:projects-changed'
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`
  })
}))

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
const session = (): FigPluginBridgeDesktopState['sessions'][number] => ({
  sessionId: '4'.repeat(32),
  pluginId: plugin.pluginId,
  projectId: project.id,
  host: plugin.host,
  expiresAt: Date.now() + 300_000,
  activeCalls: 0
})
const asset = (index = 5): FigPluginSessionAsset => ({
  version: 1,
  kind: 'session-image-asset',
  purpose: 'local-preview',
  sessionId: session().sessionId,
  pluginId: plugin.pluginId,
  projectId: project.id,
  host: plugin.host,
  assetId: index.toString(16).repeat(32),
  mimeType: 'image/png',
  sha256: 'a'.repeat(64),
  sizeBytes: 68,
  width: 1,
  height: 1,
  chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
  chunkCount: 1,
  createdAt: Date.now(),
  expiresAt: Date.now() + 120_000
})
const catalog = (assets = [asset()]): FigPluginAssetList => ({
  protocol: 1,
  purpose: 'local-preview',
  sessionId: session().sessionId,
  assets
})
const target = () => ({
  sessionId: session().sessionId,
  pluginId: plugin.pluginId,
  projectId: project.id
})
const button = (name: string) => screen.getByRole('button', { name: `figplugin.bridge.${name}` })
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(button(name))
  })
}
async function mount(items = [plugin]) {
  const mounted = render(<PluginBridgePanel items={items} />)
  await click('refresh')
  return mounted
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.center.nativeImageGenerationProposals.mockResolvedValue({ proposals: [] })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-01T00:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    })
  )
  mocks.projects.mockReturnValue([project])
  mocks.profiles.mockResolvedValue({ profiles: [] })
  mocks.center.bridgeState.mockResolvedValue({ sessions: [session()], previews: [] })
  mocks.center.planState.mockResolvedValue({
    previews: [],
    statuses: [],
    baselines: [],
    correctionAuthorizations: []
  })
  mocks.center.sessionAssets.mockImplementation(async () => catalog())
  mocks.center.chooseSessionAsset.mockImplementation(async () => asset())
  mocks.center.revokeSessionAsset.mockResolvedValue(undefined)
  mocks.center.revokeBridge.mockResolvedValue(undefined)
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  expect(fetch).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('active session local-preview image controls', () => {
  it('offers a real chooser, lists exact metadata and revokes only the selected grant', async () => {
    await mount()
    expect(screen.getByText('figplugin.bridge.assetsHelp')).toBeTruthy()
    await click('chooseAsset')
    expect(mocks.center.chooseSessionAsset).toHaveBeenCalledWith(target())
    expect(mocks.center.sessionAssets).toHaveBeenCalledWith(target())
    const card = screen.getByRole('article', {
      name: `figplugin.bridge.assetCard ${asset().assetId}`
    })
    expect(within(card).getByText(`figplugin.bridge.assetMetadata image/png 1 1 68`)).toBeTruthy()
    expect(within(card).getByText(`figplugin.bridge.assetHash ${asset().sha256}`)).toBeTruthy()
    expect(within(card).getByText(/figplugin.bridge.assetExpiry/)).toBeTruthy()
    await click('revokeAsset')
    expect(mocks.center.revokeSessionAsset).toHaveBeenCalledWith({
      ...target(),
      assetId: asset().assetId,
      sha256: asset().sha256
    })
    expect(
      screen.queryByRole('article', { name: `figplugin.bridge.assetCard ${asset().assetId}` })
    ).toBeNull()
    expect(screen.getByText('figplugin.bridge.assetRevoked')).toBeTruthy()
  })

  it('lists only when requested, without sending a path, image bytes or model request', async () => {
    await mount()
    expect(mocks.center.sessionAssets).not.toHaveBeenCalled()
    await click('listAssets')
    expect(mocks.center.sessionAssets).toHaveBeenCalledExactlyOnceWith(target())
    expect(mocks.center.chooseSessionAsset).not.toHaveBeenCalled()
    expect(screen.getByText(`figplugin.bridge.assetHash ${asset().sha256}`)).toBeTruthy()
  })

  it('treats chooser cancellation as no new grant', async () => {
    mocks.center.chooseSessionAsset.mockResolvedValue(null)
    await mount()
    await click('chooseAsset')
    expect(screen.getByText('figplugin.bridge.assetDeclined')).toBeTruthy()
    expect(mocks.center.sessionAssets).not.toHaveBeenCalled()
    expect(mocks.center.revokeSessionAsset).not.toHaveBeenCalled()
  })

  it('requires verified asset-transfer capability and an existing project', async () => {
    await mount([{ ...plugin, capabilities: ['dialogue'] }])
    expect((button('chooseAsset') as HTMLButtonElement).disabled).toBe(true)
    expect((button('listAssets') as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.center.chooseSessionAsset).not.toHaveBeenCalled()
  })

  it('enforces the visible four-image limit and removes expired grants', async () => {
    const images = [asset(5), asset(6), asset(7), asset(8)]
    mocks.center.sessionAssets.mockResolvedValue(catalog(images))
    await mount()
    await click('listAssets')
    expect((button('chooseAsset') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_001)
    })
    expect(screen.queryByText(`figplugin.bridge.assetHash ${asset().sha256}`)).toBeNull()
    expect((button('chooseAsset') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps image revoke reachable during pending consent and removes the late image grant', async () => {
    const late = deferred<FigPluginSessionAsset | null>()
    await mount()
    await click('listAssets')
    mocks.center.chooseSessionAsset.mockReturnValue(late.promise)
    await click('chooseAsset')
    expect((button('chooseAsset') as HTMLButtonElement).disabled).toBe(true)
    expect((button('revokeAsset') as HTMLButtonElement).disabled).toBe(false)
    await click('revokeAsset')
    const returned = asset(6)
    await act(async () => {
      late.resolve(returned)
    })
    expect(mocks.center.revokeSessionAsset).toHaveBeenLastCalledWith({
      ...target(),
      assetId: returned.assetId,
      sha256: returned.sha256
    })
    expect(
      screen.queryByRole('article', { name: `figplugin.bridge.assetCard ${returned.assetId}` })
    ).toBeNull()
    expect(screen.getByText('figplugin.bridge.assetRevoked')).toBeTruthy()
  })

  it('does not restore assets after package configuration changes during consent', async () => {
    const late = deferred<FigPluginSessionAsset | null>()
    const mounted = await mount()
    mocks.center.chooseSessionAsset.mockReturnValue(late.promise)
    await click('chooseAsset')
    mounted.rerender(<PluginBridgePanel items={[{ ...plugin, generation: 8 }]} />)
    await act(async () => {
      late.resolve(asset())
    })
    expect(mocks.center.revokeSessionAsset).toHaveBeenCalledWith({
      ...target(),
      assetId: asset().assetId,
      sha256: asset().sha256
    })
    expect(screen.queryByText(`figplugin.bridge.assetHash ${asset().sha256}`)).toBeNull()
  })

  it('cleans a late grant after unmount or project deletion without displaying it', async () => {
    const late = deferred<FigPluginSessionAsset | null>()
    const mounted = await mount()
    mocks.center.chooseSessionAsset.mockReturnValue(late.promise)
    await click('chooseAsset')
    mounted.unmount()
    await act(async () => {
      late.resolve(asset())
    })
    expect(mocks.center.revokeSessionAsset).toHaveBeenCalledWith({
      ...target(),
      assetId: asset().assetId,
      sha256: asset().sha256
    })
  })

  it('rejects a cross-project catalog and never renders its metadata', async () => {
    mocks.center.sessionAssets.mockResolvedValue(
      catalog([{ ...asset(), projectId: 'another_project' }])
    )
    await mount()
    await click('listAssets')
    expect(screen.getByText('figplugin.bridge.errors.INVALID_REQUEST')).toBeTruthy()
    expect(screen.queryByText(`figplugin.bridge.assetHash ${asset().sha256}`)).toBeNull()
  })

  it('revokes a well-formed but wrong-scope chooser reply instead of adopting it', async () => {
    const wrong = { ...asset(), projectId: 'another_project' }
    mocks.center.chooseSessionAsset.mockResolvedValue(wrong)
    await mount()
    await click('chooseAsset')
    expect(mocks.center.revokeSessionAsset).toHaveBeenCalledWith({
      ...target(),
      projectId: wrong.projectId,
      assetId: wrong.assetId,
      sha256: wrong.sha256
    })
    expect(screen.queryByText(`figplugin.bridge.assetHash ${asset().sha256}`)).toBeNull()
  })

  it('does not restore a stale image list after a scope refresh', async () => {
    const late = deferred<FigPluginAssetList>()
    const mounted = await mount()
    mocks.center.sessionAssets.mockReturnValue(late.promise)
    await click('listAssets')
    mounted.rerender(<PluginBridgePanel items={[{ ...plugin, generation: 8 }]} />)
    await act(async () => {
      late.resolve(catalog())
    })
    expect(screen.queryByText(`figplugin.bridge.assetHash ${asset().sha256}`)).toBeNull()
  })
})
