import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import type { FigPluginBridgeDesktopState } from '@shared/figplugin/bridge'
import {
  figPluginExecutionPreviewSchema,
  type FigPluginExecutionDesktopState,
  type FigPluginExecutionPreview,
  type FigPluginExecutionStatus,
  type FigPluginVisualBaseline
} from '@shared/figplugin/execution'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import {
  executionAssetMetadata,
  type FigPluginExecutionAsset
} from '@shared/figplugin/hostExecutionAssets'
import type { HostContext, HostPlan } from '@shared/figplugin/hostPlan'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import type { ProjectRecord } from '../MainPage/projectStore'
import PluginBridgePanel from './PluginBridgePanel'

const mocks = vi.hoisted(() => ({
  center: {
    bridgeState: vi.fn<FigPluginCenterSvc['bridgeState']>(),
    nativeImageGenerationProposals: vi.fn<FigPluginCenterSvc['nativeImageGenerationProposals']>(),
    planState: vi.fn<FigPluginCenterSvc['planState']>(),
    approvePlanExecution: vi.fn<FigPluginCenterSvc['approvePlanExecution']>(),
    denyPlanExecution: vi.fn<FigPluginCenterSvc['denyPlanExecution']>(),
    cancelPlanExecution: vi.fn<FigPluginCenterSvc['cancelPlanExecution']>(),
    acceptVisualBaseline: vi.fn<FigPluginCenterSvc['acceptVisualBaseline']>(),
    authorizeVisualCorrection: vi.fn<FigPluginCenterSvc['authorizeVisualCorrection']>(),
    sessionAssets: vi.fn<FigPluginCenterSvc['sessionAssets']>(),
    revokeSessionAsset: vi.fn<FigPluginCenterSvc['revokeSessionAsset']>(),
    revokeBridge: vi.fn<FigPluginCenterSvc['revokeBridge']>(),
    approveBridge: vi.fn<FigPluginCenterSvc['approveBridge']>()
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
  getProjectById: (id: string) => mocks.projects().find((project) => project.id === id),
  PROJECTS_CHANGED_EVENT: 'app:projects-changed'
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.translate }) }))

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
  id: 'synthetic-project',
  name: 'Synthetic project',
  createdAt: 1,
  updatedAt: 1,
  canvasStorageKey: 'synthetic',
  chatStorageScopePrefix: 'synthetic',
  defaultQAppKey: '',
  storageDirName: 'synthetic'
}
const bounds = { left: -10, top: 20, right: 30, bottom: 50 }
const fixture = (
  host: 'figma' | 'photoshop' = 'figma',
  scaleMode: 'FILL' | 'FIT' = 'FILL',
  seed = 'a'
) => {
  const asset: FigPluginExecutionAsset = {
    version: 1,
    kind: 'execution-image-asset',
    purpose: 'host-plan-execution',
    sessionId: '4'.repeat(32),
    pluginId: plugin.pluginId,
    projectId: project.id,
    host,
    assetId: seed.repeat(32),
    sha256: seed.repeat(64),
    mimeType: 'image/png',
    sizeBytes: 234,
    width: 40,
    height: 30,
    chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
    chunkCount: 1,
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 119_000
  }
  const command = host === 'figma' ? 'image.fill' : 'image.pixels'
  const context: HostContext = {
    version: 1,
    host,
    documentId: 'exact-document',
    scopeId: 'exact-scope',
    captureId: '5'.repeat(32),
    selectedIds: [`exact-target-${seed}`],
    execution: {
      mode: 'native-write',
      adapterVersion: `synthetic-${host}-adapter`,
      supports: [command],
      rollback: 'verified-in-place',
      visualAudit: 'hash-only'
    },
    nodes: [
      {
        id: `exact-target-${seed}`,
        type: host === 'figma' ? 'RECTANGLE' : 'pixel',
        name: 'Synthetic target',
        parentId: null,
        ancestors: [],
        locked: false,
        visible: true,
        commands: [command],
        ...(host === 'figma'
          ? { imageFill: { status: 'available' as const, fingerprint: '6'.repeat(64) } }
          : {
              imagePixels: {
                status: 'available' as const,
                historyStateId: 7,
                bounds,
                width: 40,
                height: 30
              }
            })
      }
    ]
  }
  const plan: HostPlan = {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: context.captureId,
    steps: [
      host === 'figma'
        ? {
            command: 'image.fill',
            targetId: context.nodes[0].id,
            assetId: asset.assetId,
            sha256: asset.sha256,
            scaleMode
          }
        : {
            command: 'image.pixels',
            targetId: context.nodes[0].id,
            assetId: asset.assetId,
            sha256: asset.sha256
          }
    ]
  }
  const planned = createHostPlanningPreview(JSON.stringify(plan), context, [
    executionAssetMetadata(asset)
  ])
  return figPluginExecutionPreviewSchema.parse({
    protocol: 1,
    executionId: seed.repeat(32),
    callId: '7'.repeat(32),
    pluginId: plugin.pluginId,
    host,
    projectId: project.id,
    documentId: context.documentId,
    scopeId: context.scopeId,
    captureId: context.captureId,
    plan: planned.plan,
    executionAssets: [asset],
    planSha256: '8'.repeat(64),
    contextSha256: '9'.repeat(64),
    adapterVersion: planned.execution!.adapterVersion,
    rollback: planned.execution!.rollback,
    visualAudit: planned.execution!.visualAudit,
    risk: planned.risk,
    differences: planned.differences,
    state: 'awaiting-approval',
    requiresWriteApproval: true,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000
  })
}
const staticFixture = (): FigPluginExecutionPreview => {
  const image = fixture('figma', 'FILL', 'c')
  delete image.executionAssets
  return figPluginExecutionPreviewSchema.parse({
    ...image,
    risk: 'low',
    plan: {
      ...image.plan,
      steps: [{ command: 'node.rename', targetId: 'static-target', name: 'Renamed' }]
    },
    differences: [
      { targetId: 'static-target', command: 'node.rename', before: 'Old', after: 'Renamed' }
    ]
  })
}
const sessionAsset = (preview: FigPluginExecutionPreview): FigPluginSessionAsset => ({
  ...preview.executionAssets![0],
  kind: 'session-image-asset',
  purpose: 'local-preview'
})
const session = (
  preview: FigPluginExecutionPreview
): FigPluginBridgeDesktopState['sessions'][number] => ({
  sessionId: preview.executionAssets![0].sessionId,
  pluginId: preview.pluginId,
  projectId: preview.projectId,
  host: preview.host,
  expiresAt: Date.now() + 300_000,
  activeCalls: 0
})
const desktopState = (
  previews: FigPluginExecutionPreview[],
  statuses: FigPluginExecutionStatus[] = []
): FigPluginExecutionDesktopState => ({
  previews,
  statuses,
  baselines: [],
  correctionAuthorizations: []
})
const status = (preview: FigPluginExecutionPreview): FigPluginExecutionStatus => ({
  protocol: 1,
  executionId: preview.executionId,
  callId: preview.callId,
  state: preview.state,
  completed: preview.state === 'completed' ? 1 : 0,
  total: 1,
  effect: preview.state === 'completed' ? 'applied' : 'none',
  updatedAt: Date.now()
})
const visualStatus = (preview: FigPluginExecutionPreview): FigPluginExecutionStatus => ({
  ...status(preview),
  state: 'completed',
  completed: 1,
  effect: 'applied',
  visualEvidenceSha256: 'd'.repeat(64),
  visualEvidence: [
    {
      targetId: preview.plan.steps[0].targetId,
      before: { sha256: 'e'.repeat(64), width: 40, height: 30 },
      after: { sha256: 'f'.repeat(64), width: 40, height: 30 },
      changed: true
    }
  ]
})
const t = (key: string, values?: Record<string, unknown>) =>
  mocks.translate(`figplugin.bridge.${key}`, values)
const button = (key: string) => screen.getByRole('button', { name: t(key) })
const card = (preview: FigPluginExecutionPreview) =>
  screen.getByRole('article', { name: t('nativeWrite', { id: preview.executionId }) })
const approve = (preview: FigPluginExecutionPreview) =>
  within(card(preview)).getByRole('button', { name: t('approveWriteOnce') })
const review = (preview: FigPluginExecutionPreview) =>
  within(card(preview)).getByRole('checkbox', {
    name: t(preview.executionAssets ? 'reviewImageWrite' : 'reviewWrite')
  })
const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element)
  })
}
const refresh = () => click(button('refresh'))
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
const mount = async (preview = fixture(), other: FigPluginExecutionPreview[] = []) => {
  mocks.center.bridgeState.mockResolvedValue({
    sessions: preview.executionAssets ? [session(preview)] : [],
    previews: []
  })
  mocks.center.planState.mockResolvedValue(desktopState([preview, ...other]))
  const view = render(<PluginBridgePanel items={[{ ...plugin, host: preview.host }]} />)
  await refresh()
  return view
}
const showAsset = async (preview: FigPluginExecutionPreview) => {
  mocks.center.sessionAssets.mockResolvedValue({
    protocol: 1,
    purpose: 'local-preview',
    sessionId: session(preview).sessionId,
    assets: [sessionAsset(preview)]
  })
  await click(button('listAssets'))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

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
  mocks.center.approvePlanExecution.mockResolvedValue({ completed: true })
  mocks.center.denyPlanExecution.mockResolvedValue(undefined)
  mocks.center.revokeSessionAsset.mockResolvedValue(undefined)
  mocks.center.revokeBridge.mockResolvedValue(undefined)
  await localize()
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  expect(fetch).not.toHaveBeenCalled()
  expect(mocks.center.approveBridge).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('rendered independent native IMAGE WRITE approval', () => {
  it.each([
    { language: 'en', locale: en, host: 'figma', mode: 'FILL' },
    { language: 'zh', locale: zh, host: 'figma', mode: 'FIT' },
    { language: 'en', locale: en, host: 'photoshop', mode: 'FILL' },
    { language: 'zh', locale: zh, host: 'photoshop', mode: 'FILL' }
  ] as const)(
    'renders exact $language $host $mode grants and sends only the reviewed execution/hash',
    async ({ locale, host, mode }) => {
      await localize(locale)
      const preview = fixture(host, mode)
      await mount(preview)
      const ui = within(card(preview))
      expect(ui.getByText(t('risk', { risk: 'high' }))).toBeVisible()
      for (const value of [
        preview.executionId,
        preview.callId,
        preview.documentId,
        preview.scopeId,
        preview.captureId,
        preview.adapterVersion,
        String(preview.createdAt),
        String(preview.expiresAt),
        '60000'
      ]) {
        expect(card(preview)).toHaveTextContent(value)
      }
      expect(ui.getByText(t('planHash', { hash: preview.planSha256 }))).toBeVisible()
      expect(ui.getByText(t('contextHash', { hash: preview.contextSha256 }))).toBeVisible()
      expect(
        JSON.parse(ui.getByLabelText(locale.figplugin.bridge.executionAssets).textContent!)
      ).toEqual(preview.executionAssets)
      expect(
        JSON.parse(ui.getByLabelText(locale.figplugin.bridge.differences).textContent!)
      ).toEqual(preview.differences)
      expect(ui.getByText(locale.figplugin.bridge.executionAssetsHelp)).toBeVisible()
      expect(ui.getByText(locale.figplugin.bridge.imageWriteRecoveryBoundary)).toBeVisible()
      expect(
        ui.getByText(
          host === 'figma'
            ? locale.figplugin.bridge.imageFillWriteHelp
            : locale.figplugin.bridge.imagePixelsWriteHelp
        )
      ).toBeVisible()
      expect(
        ui.queryByText(
          host === 'figma'
            ? locale.figplugin.bridge.imagePixelsWriteHelp
            : locale.figplugin.bridge.imageFillWriteHelp
        )
      ).toBeNull()
      if (locale === en) {
        for (const text of [
          'separate write approval',
          'EXIF, location and color profiles is not stripped',
          'does not upload image pixels to a model',
          'cannot recall bytes already read',
          'write approval does not save a checkpoint',
          'Separately accepting the result',
          'Automatic image visual correction remains unsupported',
          'not a full-document backup'
        ])
          expect(card(preview)).toHaveTextContent(text)
        for (const text of host === 'figma'
          ? [
              'replace ALL fills',
              'Node position and size stay unchanged',
              'only still-owned fills',
              'does not overwrite later user edits'
            ]
          : [
              'replace ALL pixels of the existing target layer',
              'not just a region',
              'match the rectangle exactly; no scaling',
              'Transparent borders',
              'RGB/sRGB/8-bit',
              '128 MiB',
              'canonical RGBA, not hidden RGB or raw storage identity',
              'still-owned native history transaction',
              'preserves foreign history'
            ]) {
          expect(card(preview)).toHaveTextContent(text)
        }
      }
      if (host === 'figma')
        expect(ui.getByLabelText(locale.figplugin.bridge.differences)).toHaveTextContent(
          `"scaleMode": "${mode}"`
        )
      else
        expect(preview.differences[0].before).toEqual({
          historyStateId: 7,
          bounds,
          width: 40,
          height: 30
        })
      expect(document.body).not.toHaveTextContent('figplugin.bridge.')
      expect(document.querySelector('img, iframe')).toBeNull()
      expect(approve(preview)).toBeDisabled()
      expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
      await click(review(preview))
      expect(approve(preview)).toBeEnabled()
      await click(approve(preview))
      expect(mocks.center.approvePlanExecution).toHaveBeenCalledExactlyOnceWith({
        executionId: preview.executionId,
        planSha256: preview.planSha256
      })
      expect(review(preview)).not.toBeChecked()
    }
  )

  it.each(['metadata', 'target', 'mode', 'hash', 'session', 'expiry'] as const)(
    'invalidates review when %s changes, even with a reused server hash',
    async (field) => {
      const preview = fixture()
      await mount(preview)
      await click(review(preview))
      const changed = structuredClone(preview)
      if (field === 'metadata') {
        changed.executionAssets![0].width = 41
        changed.executionAssets![0].mimeType = 'image/webp'
        changed.executionAssets![0].sizeBytes = 235
      }
      if (field === 'target') {
        changed.plan.steps[0].targetId = 'different-target'
        changed.differences[0].targetId = 'different-target'
      }
      if (field === 'mode' && changed.plan.steps[0].command === 'image.fill') {
        changed.plan.steps[0].scaleMode = 'FIT'
        changed.differences[0].after = {
          ...(changed.differences[0].after as object),
          scaleMode: 'FIT'
        }
      }
      if (field === 'hash') changed.planSha256 = 'b'.repeat(64)
      if (field === 'session') changed.executionAssets![0].sessionId = 'b'.repeat(32)
      if (field === 'expiry') changed.executionAssets![0].expiresAt -= 1
      mocks.center.planState.mockResolvedValue(desktopState([changed]))
      await refresh()
      expect(review(changed)).not.toBeChecked()
      expect(approve(changed)).toBeDisabled()
      expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
    }
  )

  it.each(['cancelled', 'denied', 'expired', 'failed', 'completed'] as const)(
    'never leaves a refreshed %s write actionable',
    async (state) => {
      const preview = fixture()
      await mount(preview)
      await click(review(preview))
      const terminal = { ...preview, state }
      mocks.center.planState.mockResolvedValue(desktopState([terminal], [status(terminal)]))
      await refresh()
      expect(review(terminal)).toBeDisabled()
      expect(review(terminal)).not.toBeChecked()
      expect(approve(terminal)).toBeDisabled()
      const deny = within(card(terminal)).getByRole('button', { name: t('deny') })
      expect(deny).toBeDisabled()
      await click(deny)
      expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
      expect(mocks.center.denyPlanExecution).not.toHaveBeenCalled()
    }
  )

  it('removes a reviewed expired image write without another poll or native approval', async () => {
    const preview = fixture()
    await mount(preview)
    await click(review(preview))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(
      screen.queryByRole('article', { name: t('nativeWrite', { id: preview.executionId }) })
    ).toBeNull()
    expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
  })

  it.each(['approved', 'claimed', 'executing', 'readback'] as const)(
    'retains the existing deny action for a nonterminal %s ordinary plan',
    async (state) => {
      const preview = { ...staticFixture(), state }
      await mount(preview)
      expect(approve(preview)).toBeDisabled()
      const deny = within(card(preview)).getByRole('button', { name: t('deny') })
      expect(deny).toBeEnabled()
      await click(deny)
      expect(mocks.center.denyPlanExecution).toHaveBeenCalledExactlyOnceWith({
        executionId: preview.executionId
      })
      expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
    }
  )

  it('rejects a local-preview purpose masquerading as a write grant', async () => {
    const preview = fixture()
    await mount(preview)
    await click(review(preview))
    const invalid = { ...preview, executionAssets: [sessionAsset(preview)] }
    mocks.center.planState.mockResolvedValue(
      desktopState([invalid as unknown as FigPluginExecutionPreview])
    )
    await refresh()
    expect(
      screen.queryByRole('article', { name: t('nativeWrite', { id: preview.executionId }) })
    ).toBeNull()
    expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
  })

  it('refreshes after source revocation and preserves unrelated image and ordinary-plan reviews', async () => {
    const preview = fixture(),
      other = fixture('figma', 'FIT', 'b'),
      ordinary = staticFixture()
    // Selecting the same bytes twice creates distinct grants; revocation is not hash-only.
    other.executionAssets![0].sha256 = preview.executionAssets![0].sha256
    const otherStep = other.plan.steps[0]
    if (otherStep.command === 'image.fill') otherStep.sha256 = other.executionAssets![0].sha256
    other.differences[0].after = {
      ...(other.differences[0].after as object),
      sha256: other.executionAssets![0].sha256
    }
    await mount(preview, [other, ordinary])
    await showAsset(preview)
    for (const item of [preview, other, ordinary]) await click(review(item))
    const revoked = deferred<void>(),
      refreshed = deferred<FigPluginExecutionDesktopState>()
    mocks.center.revokeSessionAsset.mockReturnValueOnce(revoked.promise)
    mocks.center.planState.mockReturnValueOnce(refreshed.promise)
    await click(button('revokeAsset'))
    expect(approve(preview)).toBeDisabled()
    expect(review(preview)).not.toBeChecked()
    expect(review(other)).toBeChecked()
    expect(review(ordinary)).toBeChecked()
    await act(async () => {
      revoked.resolve()
      await Promise.resolve()
    })
    expect(mocks.center.planState).toHaveBeenCalledTimes(2)
    expect(approve(other)).toBeDisabled()
    const terminal = { ...preview, state: 'cancelled' as const }
    await act(async () => {
      refreshed.resolve(desktopState([terminal, other, ordinary], [status(terminal)]))
    })
    expect(approve(terminal)).toBeDisabled()
    expect(review(terminal)).not.toBeChecked()
    expect(approve(other)).toBeEnabled()
    expect(approve(ordinary)).toBeEnabled()
    expect(mocks.center.revokeSessionAsset).toHaveBeenCalledExactlyOnceWith({
      sessionId: session(preview).sessionId,
      pluginId: preview.pluginId,
      projectId: preview.projectId,
      assetId: preview.executionAssets![0].assetId,
      sha256: preview.executionAssets![0].sha256
    })
    expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
  })

  it('does not claim failed revocation succeeded, but drops only the affected prior review', async () => {
    const preview = fixture(),
      other = fixture('figma', 'FIT', 'b')
    await mount(preview, [other])
    await showAsset(preview)
    for (const item of [preview, other]) await click(review(item))
    mocks.center.revokeSessionAsset.mockRejectedValueOnce(new Error('Synthetic revocation failure'))
    await click(button('revokeAsset'))
    expect(screen.queryByText(en.figplugin.bridge.assetRevoked)).toBeNull()
    expect(button('revokeAsset')).toBeEnabled()
    expect(review(preview)).not.toBeChecked()
    expect(review(preview)).toBeEnabled()
    expect(approve(preview)).toBeDisabled()
    expect(approve(other)).toBeEnabled()
    expect(mocks.center.planState).toHaveBeenCalledTimes(1)
    expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
  })

  it('does not resurrect a successfully revoked card when the authoritative refresh fails', async () => {
    const preview = fixture(),
      other = fixture('figma', 'FIT', 'b')
    await mount(preview, [other])
    await showAsset(preview)
    for (const item of [preview, other]) await click(review(item))
    mocks.center.planState.mockRejectedValueOnce(new Error('Synthetic refresh failure'))
    await click(button('revokeAsset'))
    expect(
      screen.queryByRole('article', { name: t('nativeWrite', { id: preview.executionId }) })
    ).toBeNull()
    expect(approve(other)).toBeEnabled()
    expect(mocks.center.approvePlanExecution).not.toHaveBeenCalled()
  })

  it('ignores a late native approval reply after source revocation', async () => {
    const preview = fixture()
    await mount(preview)
    await showAsset(preview)
    const approval = deferred<{ completed: boolean }>()
    mocks.center.approvePlanExecution.mockReturnValueOnce(approval.promise)
    await click(review(preview))
    await click(approve(preview))
    const terminal = { ...preview, state: 'cancelled' as const }
    mocks.center.planState.mockResolvedValue(desktopState([terminal], [status(terminal)]))
    expect(button('revokeAsset')).toBeEnabled()
    await click(button('revokeAsset'))
    await act(async () => {
      approval.resolve({ completed: true })
    })
    expect(screen.queryByText(en.figplugin.bridge.planApprovalAccepted)).toBeNull()
    expect(approve(terminal)).toBeDisabled()
    expect(mocks.center.approvePlanExecution).toHaveBeenCalledTimes(1)
  })

  it.each(['figma', 'photoshop'] as const)(
    'offers independently reviewed checkpoint retention but never automatic correction for a completed %s image write',
    async (host) => {
      const preview = { ...fixture(host), state: 'completed' as const }
      await mount(preview)
      const evidence = visualStatus(preview)
      mocks.center.planState.mockResolvedValue(desktopState([preview], [evidence]))
      await refresh()
      expect(button('acceptVisualBaseline')).toBeDisabled()
      expect(screen.getByText(t('imageCheckpointRetention'))).toBeVisible()
      expect(screen.queryByRole('checkbox', { name: t('reviewVisualBaseline') })).toBeNull()
      await click(screen.getByRole('checkbox', { name: t('reviewImageBaseline') }))
      expect(button('acceptVisualBaseline')).toBeEnabled()
      const baseline: FigPluginVisualBaseline = {
        protocol: 1,
        baselineId: '1'.repeat(32),
        sourceExecutionId: '2'.repeat(32),
        pluginId: preview.pluginId,
        host,
        projectId: preview.projectId,
        documentId: preview.documentId,
        scopeId: preview.scopeId,
        captureId: preview.captureId,
        planSha256: preview.planSha256,
        contextSha256: preview.contextSha256,
        visualEvidenceSha256: '3'.repeat(64),
        adapterVersion: preview.adapterVersion,
        targets: [
          { targetId: preview.plan.steps[0].targetId, accepted: evidence.visualEvidence![0].before }
        ],
        acceptedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        correctionRoundsUsed: 0,
        maxCorrectionRounds: 3
      }
      evidence.visualBaselineComparison = {
        protocol: 1,
        baselineId: baseline.baselineId,
        executionId: preview.executionId,
        baselineEvidenceSha256: baseline.visualEvidenceSha256,
        visualEvidenceSha256: evidence.visualEvidenceSha256!,
        comparedAt: Date.now(),
        targets: [
          {
            targetId: preview.plan.steps[0].targetId,
            baseline: evidence.visualEvidence![0].before,
            current: evidence.visualEvidence![0].after,
            changed: true
          }
        ],
        changedCount: 1,
        exactMatch: false
      }
      mocks.center.planState.mockResolvedValue({
        ...desktopState([preview], [evidence]),
        baselines: [baseline]
      })
      await refresh()
      expect(screen.queryByRole('button', { name: t('authorizeVisualCorrection') })).toBeNull()
      expect(screen.queryByRole('checkbox', { name: t('reviewVisualCorrection') })).toBeNull()
      expect(mocks.center.acceptVisualBaseline).not.toHaveBeenCalled()
      expect(mocks.center.authorizeVisualCorrection).not.toHaveBeenCalled()
    }
  )

  it('retains ordinary static-plan approval, denial and checkpoint eligibility', async () => {
    const preview = staticFixture()
    await mount(preview)
    expect(within(card(preview)).queryByLabelText(en.figplugin.bridge.executionAssets)).toBeNull()
    expect(
      within(card(preview)).queryByText(en.figplugin.bridge.imageWriteRecoveryBoundary)
    ).toBeNull()
    await click(review(preview))
    await click(approve(preview))
    expect(mocks.center.approvePlanExecution).toHaveBeenCalledExactlyOnceWith({
      executionId: preview.executionId,
      planSha256: preview.planSha256
    })
    await click(within(card(preview)).getByRole('button', { name: t('deny') }))
    expect(mocks.center.denyPlanExecution).toHaveBeenCalledExactlyOnceWith({
      executionId: preview.executionId
    })
    const completed = { ...preview, state: 'completed' as const }
    mocks.center.planState.mockResolvedValue(desktopState([completed], [visualStatus(completed)]))
    await refresh()
    expect(button('acceptVisualBaseline')).toBeDisabled()
    await click(screen.getByRole('checkbox', { name: t('reviewVisualBaseline') }))
    expect(button('acceptVisualBaseline')).toBeEnabled()
  })
})
