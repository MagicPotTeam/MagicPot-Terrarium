import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import type { FigPluginBridgePreview } from '@shared/figplugin/bridge'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import type { ProjectRecord } from '../MainPage/projectStore'
import PluginBridgePanel from './PluginBridgePanel'

const mocks = vi.hoisted(() => ({
  center: {
    bridgeState: vi.fn<FigPluginCenterSvc['bridgeState']>(),
    nativeImageGenerationProposals: vi.fn<FigPluginCenterSvc['nativeImageGenerationProposals']>(),
    planState: vi.fn<FigPluginCenterSvc['planState']>(),
    approveBridge: vi.fn<FigPluginCenterSvc['approveBridge']>(),
    denyBridge: vi.fn<FigPluginCenterSvc['denyBridge']>(),
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
  useTranslation: () => ({ t: (key: string) => key })
}))

const plugin: FigPluginManagedSummary = {
  pluginId: 'synthetic.plugin',
  name: 'Synthetic plugin',
  version: '1.0.0',
  host: 'figma',
  generation: 1,
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
const preview = (host: 'figma' | 'photoshop' = 'figma'): FigPluginBridgePreview => ({
  callId: '4'.repeat(32),
  pluginId: plugin.pluginId,
  host,
  projectId: project.id,
  profileId: 'synthetic-model',
  profileRevision: '5'.repeat(64),
  context: {
    selectionRevision: '6'.repeat(32),
    nodes: [{ id: 'target', type: 'FRAME', name: 'Selected', locked: false }]
  },
  prompt: 'Plan for the selected target; image content is not shared.',
  expiresAt: Date.now() + 60_000,
  payloadSha256: '7'.repeat(64),
  estimatedInputTokens: 250,
  featureId: 'plan-preview',
  hostContext: {
    version: 1,
    host,
    documentId: 'document',
    scopeId: 'scope',
    captureId: '6'.repeat(32),
    nodes: [
      {
        id: 'target',
        type: 'FRAME',
        name: 'Selected',
        parentId: 'scope',
        ancestors: [],
        locked: false,
        visible: true,
        commands: ['node.rename']
      }
    ]
  },
  assetReferences: [{ assetId: '8'.repeat(32), sha256: '9'.repeat(64) }],
  assetCatalog: {
    version: 1,
    kind: 'planning-asset-catalog',
    purpose: 'model-planning-metadata',
    sessionId: 'a'.repeat(32),
    pluginId: plugin.pluginId,
    projectId: project.id,
    host,
    assets: [
      {
        assetId: '8'.repeat(32),
        sha256: '9'.repeat(64),
        mimeType: 'image/png',
        sizeBytes: 68,
        width: 1,
        height: 1,
        expiresAt: Date.now() + 120_000
      }
    ]
  }
})
const button = (key: string) => screen.getByRole('button', { name: `figplugin.bridge.${key}` })
const click = async (key: string) => {
  await act(async () => {
    fireEvent.click(button(key))
  })
}
const mount = async (call = preview()) => {
  mocks.center.bridgeState.mockResolvedValue({ sessions: [], previews: [call] })
  render(<PluginBridgePanel items={[{ ...plugin, host: call.host }]} />)
  await click('refresh')
}

beforeEach(() => {
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
  mocks.center.approveBridge.mockResolvedValue({ completed: true })
  mocks.center.revokeBridge.mockResolvedValue(undefined)
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  expect(fetch).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('exact selected metadata model review', () => {
  it.each(['figma', 'photoshop'] as const)(
    'shows the full %s catalog and requires explicit fresh review',
    async (host) => {
      const call = preview(host)
      await mount(call)
      expect(
        JSON.parse(screen.getByLabelText('figplugin.bridge.planningAssets').textContent!)
      ).toEqual(call.assetCatalog)
      expect(screen.getByText('figplugin.bridge.planningAssetsHelp')).toBeTruthy()
      expect(document.querySelector('img')).toBeNull()
      expect(button('approveOnce')).toBeDisabled()
      expect(mocks.center.approveBridge).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('checkbox'))
      await click('approveOnce')
      expect(mocks.center.approveBridge).toHaveBeenCalledExactlyOnceWith({
        callId: call.callId,
        payloadSha256: call.payloadSha256
      })
    }
  )

  it('invalidates reviewed consent if any catalog field changes even under the same payload hash', async () => {
    const call = preview()
    await mount(call)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(button('approveOnce')).toBeEnabled()
    const changed = structuredClone(call)
    changed.assetCatalog!.assets[0].width = 2
    mocks.center.bridgeState.mockResolvedValue({ sessions: [], previews: [changed] })
    await click('refresh')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(button('approveOnce')).toBeDisabled()
    expect(mocks.center.approveBridge).not.toHaveBeenCalled()
  })

  it('does not display or infer a catalog when no references were selected', async () => {
    const call = preview()
    delete call.assetReferences
    delete call.assetCatalog
    await mount(call)
    expect(screen.queryByLabelText('figplugin.bridge.planningAssets')).toBeNull()
    expect(screen.queryByText('figplugin.bridge.planningAssetsHelp')).toBeNull()
  })

  it('rejects an injected catalog that does not match the selected references', async () => {
    const call = preview()
    call.assetCatalog!.assets[0].sha256 = 'b'.repeat(64)
    await mount(call)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(mocks.center.approveBridge).not.toHaveBeenCalled()
  })

  it('removes expired approval and never keeps the reviewed grant alive', async () => {
    await mount()
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001)
    })
    expect(screen.queryByLabelText('figplugin.bridge.planningAssets')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(mocks.center.approveBridge).not.toHaveBeenCalled()
  })
})
