import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { createInstance } from 'i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import type { FigPluginNativeImageGenerationDesktopProposal } from '@shared/figplugin/nativeImageGeneration'
import {
  FIGPLUGIN_IMAGE_GENERATION_OPTIONS,
  type FigPluginImageGenerationKey,
  type FigPluginImageGenerationOutput,
  type FigPluginImageGenerationState
} from '@shared/figplugin/imageGeneration'
import {
  FIGPLUGIN_ASSET_CHUNK_BYTES,
  type FigPluginSessionAsset
} from '@shared/figplugin/hostAssets'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import comfyStatus, { appendResults } from '@renderer/store/slices/comfyStatus'
import type { ProjectRecord } from '../MainPage/projectStore'
import PluginBridgeImageGeneration from './PluginBridgeImageGeneration'
import PluginBridgePanel from './PluginBridgePanel'

const mocks = vi.hoisted(() => ({
  center: {
    bridgeState: vi.fn<FigPluginCenterSvc['bridgeState']>(),
    nativeImageGenerationProposals: vi.fn<FigPluginCenterSvc['nativeImageGenerationProposals']>(),
    approveNativeImageGeneration: vi.fn<FigPluginCenterSvc['approveNativeImageGeneration']>(),
    cancelNativeImageGeneration: vi.fn<FigPluginCenterSvc['cancelNativeImageGeneration']>(),
    planState: vi.fn<FigPluginCenterSvc['planState']>(),
    generateSessionImage: vi.fn<FigPluginCenterSvc['generateSessionImage']>(),
    sessionImageGenerationState: vi.fn<FigPluginCenterSvc['sessionImageGenerationState']>(),
    acceptSessionImageGeneration: vi.fn<FigPluginCenterSvc['acceptSessionImageGeneration']>(),
    cancelSessionImageGeneration: vi.fn<FigPluginCenterSvc['cancelSessionImageGeneration']>(),
    chooseManagedSessionAsset: vi.fn<FigPluginCenterSvc['chooseManagedSessionAsset']>(),
    chooseSessionAsset: vi.fn<FigPluginCenterSvc['chooseSessionAsset']>(),
    sessionAssets: vi.fn<FigPluginCenterSvc['sessionAssets']>(),
    revokeSessionAsset: vi.fn<FigPluginCenterSvc['revokeSessionAsset']>(),
    revokeBridge: vi.fn<FigPluginCenterSvc['revokeBridge']>(),
    approveBridge: vi.fn<FigPluginCenterSvc['approveBridge']>(),
    approvePlanExecution: vi.fn<FigPluginCenterSvc['approvePlanExecution']>()
  },
  profiles: vi.fn(),
  projects: vi.fn<() => ProjectRecord[]>(),
  translate: vi.fn<(key: string, values?: Record<string, unknown>) => string>(),
  busy: vi.fn(),
  close: vi.fn()
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
vi.mock('@renderer/store', async () => {
  const { useDispatch, useSelector } = await import('react-redux')
  return { useAppDispatch: useDispatch, useAppSelector: useSelector }
})

const now = new Date('2026-10-26T00:00:00Z').getTime()
const key: FigPluginImageGenerationKey = {
  sessionId: '4'.repeat(32),
  pluginId: 'synthetic.plugin',
  projectId: 'project_1',
  requestId: '12345678123442348234123456789abc'
}
const project: ProjectRecord = {
  id: key.projectId,
  name: 'Synthetic project',
  createdAt: 1,
  updatedAt: 1,
  canvasStorageKey: 'synthetic',
  chatStorageScopePrefix: 'synthetic',
  defaultQAppKey: '',
  storageDirName: 'synthetic'
}
const plugin: FigPluginManagedSummary = {
  pluginId: key.pluginId,
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
  settings: { analysisProfileId: 'analysis-only', imageGenerationProfileId: 'image-only' }
}
const session = () => ({
  sessionId: key.sessionId,
  pluginId: key.pluginId,
  projectId: key.projectId,
  host: 'figma' as const,
  expiresAt: now + 300_000,
  activeCalls: 0
})
const proposal = (): FigPluginNativeImageGenerationDesktopProposal => ({
  ...key,
  requestId: 'b'.repeat(32),
  generationRequestId: key.requestId,
  proposalId: 'c'.repeat(32),
  payloadSha256: 'd'.repeat(64),
  host: 'figma',
  prompt: 'The exact native terrarium prompt',
  createdAt: now,
  expiresAt: now + 120_000
})
const proposalKey = () => ({
  proposalId: proposal().proposalId,
  payloadSha256: proposal().payloadSha256
})
const generated = (): FigPluginImageGenerationOutput => ({
  ...key,
  jobId: '5'.repeat(32),
  resultId: '6'.repeat(32),
  profileId: 'image-only',
  profileRevision: '7'.repeat(64),
  createdAt: now,
  expiresAt: now + 120_000,
  reference: {
    version: 1,
    kind: 'managed',
    relativePath: 'images/generated.png',
    sha256: 'a'.repeat(64),
    sizeBytes: 68,
    mimeType: 'image/png',
    originalFileName: 'generated.png'
  },
  localMediaUrl: 'local-media:///managed/images/generated.png',
  width: 32,
  height: 24
})
const state = (
  phase: FigPluginImageGenerationState['phase'] = 'generating'
): FigPluginImageGenerationState => ({
  ...key,
  jobId: generated().jobId,
  phase,
  createdAt: now,
  updatedAt: Date.now(),
  expiresAt: now + 120_000
})
const asset = (index: number): FigPluginSessionAsset => ({
  version: 1,
  kind: 'session-image-asset',
  purpose: 'local-preview',
  sessionId: key.sessionId,
  pluginId: key.pluginId,
  projectId: key.projectId,
  host: 'figma',
  assetId: String(index).repeat(32),
  sha256: 'a'.repeat(64),
  mimeType: 'image/png',
  sizeBytes: 68,
  width: 32,
  height: 24,
  chunkSize: FIGPLUGIN_ASSET_CHUNK_BYTES,
  chunkCount: 1,
  createdAt: now,
  expiresAt: now + 120_000
})
const t = (name: string, values?: Record<string, unknown>) =>
  mocks.translate(`figplugin.bridge.${name}`, values)
const button = (name: string) => screen.getByRole('button', { name: t(name) })
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(button(name))
  })
}
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const review = (prompt = '  A green terrarium  ') => {
  fireEvent.change(screen.getByLabelText(t('generationPrompt')), { target: { value: prompt } })
  fireEvent.click(screen.getByRole('checkbox', { name: t('generationReview') }))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const localize = async (locale: typeof en | typeof zh = en) => {
  const i18n = createInstance()
  await i18n.init({
    lng: 'test',
    fallbackLng: false,
    resources: { test: { translation: locale } },
    interpolation: { escapeValue: false }
  })
  mocks.translate.mockImplementation((name, values) =>
    i18n.t(name, { ...values, defaultValue: name })
  )
}
type Props = ComponentProps<typeof PluginBridgeImageGeneration>
const props = (): Props => ({
  session: session(),
  profileId: 'image-only',
  profileName: 'Synthetic image model',
  available: true,
  disabled: false,
  onBusyChange: mocks.busy,
  onClose: mocks.close
})
const mount = (overrides: Partial<Props> = {}) => {
  const store = configureStore({ reducer: { comfyStatus: comfyStatus.reducer } })
  let current = { ...props(), ...overrides }
  const tree = () => (
    <Provider store={store}>
      <PluginBridgeImageGeneration {...current} />
    </Provider>
  )
  const view = render(tree())
  return {
    ...view,
    store,
    rerender: (next: Partial<Props>) => {
      current = { ...current, ...next }
      view.rerender(tree())
    }
  }
}
const mountPanel = async (item = plugin) => {
  const store = configureStore({ reducer: { comfyStatus: comfyStatus.reducer } })
  const tree = (value: FigPluginManagedSummary) => (
    <Provider store={store}>
      <PluginBridgePanel items={[value]} />
    </Provider>
  )
  const view = render(tree(item))
  await click('refresh')
  return {
    ...view,
    store,
    rerender: (value: FigPluginManagedSummary) => view.rerender(tree(value))
  }
}
beforeAll(async () => {
  await import('./PluginBridgeManagedAssetPicker')
})
beforeEach(async () => {
  vi.resetAllMocks()
  mocks.center.nativeImageGenerationProposals.mockResolvedValue({ proposals: [] })
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abc')
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    })
  )
  mocks.projects.mockReturnValue([project])
  mocks.profiles.mockResolvedValue({
    profiles: [{ id: 'image-only', model_name: 'Synthetic image model' }]
  })
  mocks.center.bridgeState.mockResolvedValue({ sessions: [session()], previews: [] })
  mocks.center.planState.mockResolvedValue({
    previews: [],
    statuses: [],
    baselines: [],
    correctionAuthorizations: []
  })
  mocks.center.generateSessionImage.mockResolvedValue(generated())
  mocks.center.approveNativeImageGeneration.mockResolvedValue(generated())
  mocks.center.cancelNativeImageGeneration.mockResolvedValue({ completed: true })
  mocks.center.sessionImageGenerationState.mockResolvedValue(null)
  mocks.center.acceptSessionImageGeneration.mockResolvedValue({ completed: true })
  mocks.center.cancelSessionImageGeneration.mockResolvedValue({ completed: true })
  mocks.center.sessionAssets.mockResolvedValue({
    protocol: 1,
    purpose: 'local-preview',
    sessionId: key.sessionId,
    assets: []
  })
  mocks.center.revokeBridge.mockResolvedValue(undefined)
  mocks.center.revokeSessionAsset.mockResolvedValue(undefined)
  await localize()
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  expect(fetch).not.toHaveBeenCalled()
  for (const method of [
    'chooseManagedSessionAsset',
    'chooseSessionAsset',
    'approveBridge',
    'approvePlanExecution'
  ] as const)
    expect(mocks.center[method]).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('explicit Bridge image generation', () => {
  it.each([
    { locale: en, host: 'figma' },
    { locale: zh, host: 'photoshop' }
  ] as const)(
    'renders the $host consent boundary and accepts before registering the exact current-project output',
    async ({ locale, host }) => {
      await localize(locale)
      const acceptance = deferred<{ completed: boolean }>()
      mocks.center.acceptSessionImageGeneration.mockReturnValue(acceptance.promise)
      const view = mount({ session: { ...session(), host } })
      expect(button('generationSubmit')).toBeDisabled()
      expect(mocks.center.generateSessionImage).not.toHaveBeenCalled()
      expect(screen.getByText(t('generationHelp'))).toBeInTheDocument()
      expect(
        screen.getByText(JSON.stringify(FIGPLUGIN_IMAGE_GENERATION_OPTIONS, null, 2), {
          normalizer: (value) => value
        })
      ).toBeInTheDocument()
      review()
      expect(screen.getByLabelText(t('generationPromptPreview'))).toHaveTextContent(
        'A green terrarium'
      )
      await click('generationSubmit')
      expect(mocks.center.generateSessionImage).toHaveBeenCalledExactlyOnceWith({
        ...key,
        prompt: 'A green terrarium'
      })
      expect(mocks.center.acceptSessionImageGeneration).toHaveBeenCalledExactlyOnceWith({
        ...key,
        jobId: generated().jobId,
        resultId: generated().resultId,
        sha256: generated().reference.sha256
      })
      expect(view.store.getState().comfyStatus.results).toEqual([])
      expect(button('generationStop')).toBeEnabled()
      expect(button('generationClose')).toBeEnabled()
      mocks.center.sessionImageGenerationState.mockResolvedValue(state('accepted'))
      await tick(1000)
      expect(screen.queryByText(t('generationPhases.accepted'))).not.toBeInTheDocument()
      await act(async () => {
        acceptance.resolve({ completed: true })
      })
      expect(view.store.getState().comfyStatus.results).toEqual([
        {
          id: generated().resultId,
          promptId: generated().jobId,
          projectId: key.projectId,
          type: 'image',
          fileItem: {},
          objectUrl: generated().localMediaUrl,
          media: generated().reference,
          mimeType: 'image/png',
          sizeBytes: 68,
          sourceWidth: 32,
          sourceHeight: 24
        }
      ])
      expect(screen.getByText(t('generationAcceptedHelp'))).toBeInTheDocument()
      expect(
        screen.getByRole('img', { name: t('generationOutput', { id: generated().resultId }) })
      ).toHaveAttribute('src', generated().localMediaUrl)
      await click('generationClose')
      view.unmount()
      await act(async () => {})
      expect(mocks.center.cancelSessionImageGeneration).not.toHaveBeenCalled()
    }
  )

  it.each(['', '   ', 'x'.repeat(8193)])(
    'rejects an invalid prompt without dispatch (%#. case)',
    async (value) => {
      mount()
      fireEvent.change(screen.getByLabelText(t('generationPrompt')), { target: { value } })
      expect(screen.getByRole('checkbox', { name: t('generationReview') })).toBeDisabled()
      await click('generationSubmit')
      expect(mocks.center.generateSessionImage).not.toHaveBeenCalled()
    }
  )

  it('invalidates review after prompt or target changes, but not unrelated call telemetry', () => {
    const view = mount()
    review()
    expect(button('generationSubmit')).toBeEnabled()
    view.rerender({ session: { ...session(), activeCalls: 1 } })
    expect(button('generationSubmit')).toBeEnabled()
    fireEvent.change(screen.getByLabelText(t('generationPrompt')), {
      target: { value: 'Different prompt' }
    })
    expect(button('generationSubmit')).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: t('generationReview') }))
    view.rerender({ profileId: 'different-image' })
    expect(button('generationSubmit')).toBeDisabled()
  })

  it('keeps native decline grant-free and does not poll a settled request', async () => {
    mocks.center.generateSessionImage.mockResolvedValue(null)
    const view = mount()
    review()
    await click('generationSubmit')
    expect(screen.getByText(t('generationPhases.declined'))).toBeInTheDocument()
    expect(view.store.getState().comfyStatus.results).toEqual([])
    expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
    await tick(5000)
    expect(mocks.center.sessionImageGenerationState).not.toHaveBeenCalled()
  })

  it('requires a fresh review and request identity for each attempt', async () => {
    mocks.center.generateSessionImage.mockResolvedValue(null)
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('12345678-1234-4234-8234-123456789abc')
      .mockReturnValueOnce('abcdef01-2345-4678-9012-abcdef012345')
    mount()
    review()
    await click('generationSubmit')
    expect(button('generationSubmit')).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: t('generationReview') }))
    await click('generationSubmit')
    expect(
      mocks.center.generateSessionImage.mock.calls.map(([request]) => request.requestId)
    ).toEqual([key.requestId, 'abcdef01234546789012abcdef012345'])
    expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
  })

  it.each(['before-dispatch', 'before-output'] as const)(
    'checks the actual project store %s, without waiting for its change event',
    async (when) => {
      const pending = deferred<FigPluginImageGenerationOutput | null>()
      mocks.center.generateSessionImage.mockReturnValue(pending.promise)
      const view = mount()
      review()
      if (when === 'before-dispatch') mocks.projects.mockReturnValue([])
      await click('generationSubmit')
      if (when === 'before-output') mocks.projects.mockReturnValue([])
      await act(async () => {
        pending.resolve(generated())
      })
      expect(mocks.center.generateSessionImage).toHaveBeenCalledTimes(
        when === 'before-dispatch' ? 0 : 1
      )
      expect(mocks.center.cancelSessionImageGeneration).toHaveBeenCalledTimes(
        when === 'before-dispatch' ? 0 : 1
      )
      expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
      expect(view.store.getState().comfyStatus.results).toEqual([])
    }
  )

  it('polls once per second with one in flight and keeps Stop independent of stalled service work', async () => {
    const pending = deferred<FigPluginImageGenerationOutput | null>()
    const polling = deferred<FigPluginImageGenerationState | null>()
    mocks.center.generateSessionImage.mockReturnValue(pending.promise)
    mocks.center.sessionImageGenerationState.mockReturnValue(polling.promise)
    const view = mount()
    review()
    await click('generationSubmit')
    await tick(5000)
    expect(mocks.center.sessionImageGenerationState).toHaveBeenCalledExactlyOnceWith(key)
    view.rerender({ disabled: true })
    expect(button('generationStop')).toBeEnabled()
    await click('generationStop')
    expect(mocks.center.cancelSessionImageGeneration).toHaveBeenCalledExactlyOnceWith(key)
    await act(async () => {
      polling.resolve(state())
      pending.resolve(generated())
    })
    await tick(5000)
    expect(mocks.center.sessionImageGenerationState).toHaveBeenCalledTimes(1)
    expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
    expect(view.store.getState().comfyStatus.results).toEqual([])
  })

  it.each(['awaiting-approval', 'generating', 'materializing'] as const)(
    'shows the explicit %s phase',
    async (phase) => {
      mocks.center.generateSessionImage.mockReturnValue(new Promise(() => {}))
      mocks.center.sessionImageGenerationState.mockImplementation(async () => state(phase))
      mount()
      review()
      await click('generationSubmit')
      await tick(1000)
      expect(screen.getByText(t(`generationPhases.${phase}`))).toBeInTheDocument()
    }
  )

  it.each([
    'close',
    'unmount',
    'project',
    'plugin',
    'session',
    'host',
    'profile',
    'expiry',
    'unavailable'
  ] as const)(
    'cancels the exact unaccepted request on %s and ignores late output',
    async (change) => {
      const pending = deferred<FigPluginImageGenerationOutput | null>()
      mocks.center.generateSessionImage.mockReturnValue(pending.promise)
      const view = mount()
      review()
      await click('generationSubmit')
      if (change === 'close') await click('generationClose')
      else if (change === 'unmount') view.unmount()
      else if (change === 'project')
        view.rerender({ session: { ...session(), projectId: 'other-project' } })
      else if (change === 'plugin')
        view.rerender({ session: { ...session(), pluginId: 'other.plugin' } })
      else if (change === 'session')
        view.rerender({ session: { ...session(), sessionId: '8'.repeat(32) } })
      else if (change === 'host') view.rerender({ session: { ...session(), host: 'photoshop' } })
      else if (change === 'profile') view.rerender({ profileId: 'different-image' })
      else if (change === 'expiry') view.rerender({ session: { ...session(), expiresAt: now + 1 } })
      else view.rerender({ available: false })
      await act(async () => {
        pending.resolve(generated())
      })
      expect(mocks.center.cancelSessionImageGeneration).toHaveBeenCalledExactlyOnceWith(key)
      expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
      expect(view.store.getState().comfyStatus.results).toEqual([])
    }
  )

  it.each([120_000, 2000])(
    'cancels at the bounded request/session deadline (%s ms)',
    async (deadline) => {
      mocks.center.generateSessionImage.mockReturnValue(new Promise(() => {}))
      const view = mount({ session: { ...session(), expiresAt: now + deadline } })
      review()
      await click('generationSubmit')
      await tick(deadline)
      expect(mocks.center.cancelSessionImageGeneration).toHaveBeenCalledExactlyOnceWith(key)
      expect(button('generationStop')).toBeDisabled()
      expect(view.store.getState().comfyStatus.results).toEqual([])
    }
  )

  it.each([
    'session',
    'plugin',
    'project',
    'request',
    'profile',
    'url',
    'hash',
    'dimensions',
    'expired',
    'lifetime',
    'extra'
  ] as const)('rejects an invalid output %s before acceptance or registration', async (field) => {
    const value = generated()
    if (field === 'session') value.sessionId = '8'.repeat(32)
    if (field === 'plugin') value.pluginId = 'other.plugin'
    if (field === 'project') value.projectId = 'other-project'
    if (field === 'request') value.requestId = '8'.repeat(32)
    if (field === 'profile') value.profileId = 'analysis-only'
    if (field === 'url') value.localMediaUrl = 'https://private.invalid/source.png'
    if (field === 'hash') value.reference.sha256 = 'bad'
    if (field === 'dimensions') value.width = 0
    if (field === 'expired') {
      value.createdAt = now - 2000
      value.expiresAt = now - 1
    }
    if (field === 'lifetime') {
      value.createdAt = now + 1
      value.expiresAt = now + 120_001
    }
    if (field === 'extra') Object.assign(value, { rawImage: 'private-output' })
    mocks.center.generateSessionImage.mockResolvedValue(value)
    const view = mount()
    review()
    await click('generationSubmit')
    expect(mocks.center.cancelSessionImageGeneration).toHaveBeenCalledExactlyOnceWith(key)
    expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
    expect(view.store.getState().comfyStatus.results).toEqual([])
    expect(screen.getByText(t('generationFailed'))).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('private-output')
  })

  it.each(['scope', 'job', 'failed', 'throw'] as const)(
    'fails closed for invalid or failed status %s',
    async (kind) => {
      const pending = deferred<FigPluginImageGenerationOutput | null>()
      mocks.center.generateSessionImage.mockReturnValue(pending.promise)
      const invalid = state()
      if (kind === 'scope') invalid.projectId = 'other-project'
      if (kind === 'failed') invalid.phase = 'failed'
      if (kind === 'throw')
        mocks.center.sessionImageGenerationState.mockRejectedValue(new Error('private endpoint'))
      else mocks.center.sessionImageGenerationState.mockResolvedValue(invalid)
      const view = mount()
      review()
      await click('generationSubmit')
      await tick(1000)
      if (kind === 'job')
        mocks.center.sessionImageGenerationState.mockResolvedValue({
          ...state(),
          jobId: '9'.repeat(32)
        })
      await tick(1000)
      await act(async () => {
        pending.resolve(generated())
      })
      expect(mocks.center.cancelSessionImageGeneration).toHaveBeenCalledExactlyOnceWith(key)
      expect(view.store.getState().comfyStatus.results).toEqual([])
      expect(document.body).not.toHaveTextContent('private endpoint')
    }
  )

  it.each(['declined', 'throw', 'malformed'] as const)(
    'does not register without authoritative acceptance (%s)',
    async (kind) => {
      if (kind === 'throw')
        mocks.center.acceptSessionImageGeneration.mockRejectedValue(
          new Error('private acceptance detail')
        )
      else
        mocks.center.acceptSessionImageGeneration.mockResolvedValue(
          kind === 'declined'
            ? { completed: false }
            : ({ completed: true, extra: true } as { completed: boolean })
        )
      const view = mount()
      review()
      await click('generationSubmit')
      expect(view.store.getState().comfyStatus.results).toEqual([])
      expect(mocks.center.cancelSessionImageGeneration).toHaveBeenCalledExactlyOnceWith(key)
      expect(document.body).not.toHaveTextContent('private acceptance detail')
    }
  )

  it('does not append an acceptance that completes after Stop and does not issue a second cancellation', async () => {
    const acceptance = deferred<{ completed: boolean }>()
    mocks.center.acceptSessionImageGeneration.mockReturnValue(acceptance.promise)
    const view = mount()
    review()
    await click('generationSubmit')
    await click('generationStop')
    await act(async () => {
      acceptance.resolve({ completed: true })
    })
    expect(mocks.center.cancelSessionImageGeneration).toHaveBeenCalledExactlyOnceWith(key)
    expect(view.store.getState().comfyStatus.results).toEqual([])
  })

  it('does not append a receipt that expires during acceptance', async () => {
    const acceptance = deferred<{ completed: boolean }>()
    mocks.center.generateSessionImage.mockResolvedValue({ ...generated(), expiresAt: now + 500 })
    mocks.center.acceptSessionImageGeneration.mockReturnValue(acceptance.promise)
    const view = mount()
    review()
    await click('generationSubmit')
    await tick(600)
    await act(async () => {
      acceptance.resolve({ completed: true })
    })
    expect(view.store.getState().comfyStatus.results).toEqual([])
    expect(screen.getByText(t('generationFailed'))).toBeInTheDocument()
    expect(mocks.center.cancelSessionImageGeneration).not.toHaveBeenCalled()
  })

  it('accepts main admission latency without extending the renderer request deadline', async () => {
    const pending = deferred<FigPluginImageGenerationOutput | null>()
    mocks.center.generateSessionImage.mockReturnValue(pending.promise)
    const view = mount()
    review()
    await click('generationSubmit')
    await tick(10)
    mocks.center.sessionImageGenerationState.mockImplementation(async () => ({
      ...state(),
      createdAt: now + 10,
      expiresAt: now + 120_010
    }))
    await tick(1000)
    await act(async () => {
      pending.resolve({ ...generated(), createdAt: now + 10, expiresAt: now + 120_010 })
    })
    expect(mocks.center.acceptSessionImageGeneration).toHaveBeenCalledTimes(1)
    expect(view.store.getState().comfyStatus.results).toHaveLength(1)
    expect(mocks.center.cancelSessionImageGeneration).not.toHaveBeenCalled()
  })

  it('does not accept a duplicate result ID already registered in the shared result store', async () => {
    const view = mount()
    view.store.dispatch(
      appendResults([
        {
          id: generated().resultId,
          promptId: 'existing',
          projectId: key.projectId,
          type: 'image',
          objectUrl: generated().localMediaUrl,
          fileItem: {}
        }
      ])
    )
    review()
    await click('generationSubmit')
    expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
    expect(view.store.getState().comfyStatus.results).toHaveLength(1)
  })
})

describe('native proposal image-generation review', () => {
  const approve = async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: t('generationReview') }))
    await click('generationSubmit')
  }

  it('keeps the prompt immutable and approves only the exact main proposal key', async () => {
    const pending = deferred<FigPluginImageGenerationOutput | null>()
    mocks.center.approveNativeImageGeneration.mockReturnValue(pending.promise)
    const view = mount({ proposal: proposal() })
    expect(screen.getByLabelText(t('generationPrompt'))).toHaveAttribute('readonly')
    expect(screen.getByLabelText(t('generationPrompt'))).toHaveValue(proposal().prompt)
    expect(button('generationSubmit')).toBeDisabled()
    expect(mocks.center.approveNativeImageGeneration).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(t('generationPrompt')), {
      target: { value: 'Altered prompt' }
    })
    expect(screen.getByLabelText(t('generationPrompt'))).toHaveValue(proposal().prompt)
    await approve()
    await tick(1000)
    expect(mocks.center.approveNativeImageGeneration).toHaveBeenCalledExactlyOnceWith(proposalKey())
    expect(mocks.center.sessionImageGenerationState).toHaveBeenCalledExactlyOnceWith(key)
    expect(mocks.center.generateSessionImage).not.toHaveBeenCalled()
    expect(crypto.randomUUID).not.toHaveBeenCalled()
    await act(async () => pending.resolve(generated()))
    expect(mocks.center.acceptSessionImageGeneration).toHaveBeenCalledExactlyOnceWith({
      ...key,
      jobId: generated().jobId,
      resultId: generated().resultId,
      sha256: generated().reference.sha256
    })
    expect(view.store.getState().comfyStatus.results).toHaveLength(1)
    expect(button('generationSubmit')).toBeDisabled()
    expect(mocks.center.cancelNativeImageGeneration).not.toHaveBeenCalled()
  })

  it.each(['generationProposalDecline', 'generationClose'])(
    'cancels an unstarted proposal using %s without adopting a job',
    async (action) => {
      mount({ proposal: proposal(), disabled: true })
      await click(action)
      expect(mocks.center.cancelNativeImageGeneration).toHaveBeenCalledExactlyOnceWith(
        proposalKey()
      )
      expect(mocks.center.approveNativeImageGeneration).not.toHaveBeenCalled()
      expect(mocks.center.cancelSessionImageGeneration).not.toHaveBeenCalled()
    }
  )

  it.each(['declined', 'failed', 'wrong-request', 'late-deadline'] as const)(
    'does not retry or accept a %s proposal result',
    async (fault) => {
      if (fault === 'declined') mocks.center.approveNativeImageGeneration.mockResolvedValue(null)
      else if (fault === 'failed')
        mocks.center.approveNativeImageGeneration.mockRejectedValue(new Error('Synthetic failure'))
      else
        mocks.center.approveNativeImageGeneration.mockResolvedValue({
          ...generated(),
          ...(fault === 'wrong-request'
            ? { requestId: 'e'.repeat(32) }
            : { expiresAt: now + 120_001 })
        })
      const view = mount({ proposal: proposal() })
      await approve()
      await click('generationSubmit')
      expect(mocks.center.approveNativeImageGeneration).toHaveBeenCalledTimes(1)
      expect(mocks.center.generateSessionImage).not.toHaveBeenCalled()
      expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
      expect(view.store.getState().comfyStatus.results).toEqual([])
      expect(button('generationSubmit')).toBeDisabled()
    }
  )

  it.each(['stop', 'close', 'unmount', 'expiry', 'profile', 'bad-status'] as const)(
    'cancels the proposal, not an arbitrary job, on %s',
    async (reason) => {
      const pending = deferred<FigPluginImageGenerationOutput | null>()
      mocks.center.approveNativeImageGeneration.mockReturnValue(pending.promise)
      const view = mount({ proposal: proposal() })
      await approve()
      if (reason === 'stop') await click('generationStop')
      else if (reason === 'close') await click('generationClose')
      else if (reason === 'unmount') view.unmount()
      else if (reason === 'expiry') await tick(120_000)
      else if (reason === 'profile') view.rerender({ profileId: 'changed-image' })
      else {
        mocks.center.sessionImageGenerationState.mockResolvedValue({
          ...state(),
          requestId: 'e'.repeat(32)
        })
        await tick(1000)
      }
      await act(async () => pending.resolve(generated()))
      expect(mocks.center.cancelNativeImageGeneration).toHaveBeenCalledExactlyOnceWith(
        proposalKey()
      )
      expect(mocks.center.cancelSessionImageGeneration).not.toHaveBeenCalled()
      expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
      expect(view.store.getState().comfyStatus.results).toEqual([])
    }
  )

  it('retains the proposal cancellation lane until result acceptance completes', async () => {
    const accepted = deferred<{ completed: boolean }>()
    mocks.center.acceptSessionImageGeneration.mockReturnValue(accepted.promise)
    const view = mount({ proposal: proposal() })
    await approve()
    expect(button('generationStop')).toBeEnabled()
    await click('generationStop')
    await act(async () => accepted.resolve({ completed: true }))
    expect(mocks.center.cancelNativeImageGeneration).toHaveBeenCalledExactlyOnceWith(proposalKey())
    expect(view.store.getState().comfyStatus.results).toEqual([])
  })

  it('shows queued native requests without automatic adoption and retains an adopted preview when the queue clears', async () => {
    const pending = deferred<FigPluginImageGenerationOutput | null>()
    mocks.center.nativeImageGenerationProposals.mockResolvedValue({ proposals: [proposal()] })
    mocks.center.approveNativeImageGeneration.mockReturnValue(pending.promise)
    const view = await mountPanel()
    expect(
      screen.getByRole('article', {
        name: t('generationProposalCard', { id: proposal().proposalId })
      })
    ).toBeInTheDocument()
    expect(mocks.center.approveNativeImageGeneration).not.toHaveBeenCalled()
    await click('enableMonitor')
    await click('generationProposalOpen')
    expect(screen.getByLabelText(t('generationPrompt'))).toHaveValue(proposal().prompt)
    await approve()
    mocks.center.nativeImageGenerationProposals.mockResolvedValue({ proposals: [] })
    await tick(2000)
    expect(screen.getByLabelText(t('generationPrompt'))).toHaveValue(proposal().prompt)
    expect(button('generationStop')).toBeEnabled()
    await act(async () => pending.resolve(generated()))
    expect(view.store.getState().comfyStatus.results).toHaveLength(1)
    expect(mocks.center.approveNativeImageGeneration).toHaveBeenCalledExactlyOnceWith(proposalKey())
  })

  it('declines a queued proposal without opening generation or using the ordinary review approval', async () => {
    mocks.center.nativeImageGenerationProposals.mockResolvedValue({ proposals: [proposal()] })
    await mountPanel()
    await click('generationProposalDecline')
    expect(mocks.center.cancelNativeImageGeneration).toHaveBeenCalledExactlyOnceWith(proposalKey())
    expect(mocks.center.approveNativeImageGeneration).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(t('generationPrompt'))).not.toBeInTheDocument()
  })

  it.each(['duplicate', 'prompt-normalization', 'foreign-session', 'future'] as const)(
    'rejects a %s Desktop proposal feed',
    async (fault) => {
      const value = proposal()
      if (fault === 'prompt-normalization') value.prompt = ' ' + value.prompt
      if (fault === 'foreign-session') value.sessionId = 'e'.repeat(32)
      if (fault === 'future') {
        value.createdAt += 1
        value.expiresAt += 1
      }
      mocks.center.nativeImageGenerationProposals.mockResolvedValue({
        proposals: fault === 'duplicate' ? [value, value] : [value]
      })
      await mountPanel()
      expect(
        screen.queryByRole('button', { name: t('generationProposalOpen') })
      ).not.toBeInTheDocument()
      expect(mocks.center.approveNativeImageGeneration).not.toHaveBeenCalled()
    }
  )
})

describe('generation entry in the real Bridge panel', () => {
  it('opens lazily and makes an accepted result available to the existing picker without automatic sharing', async () => {
    const view = await mountPanel()
    expect(screen.queryByLabelText(t('generationPrompt'))).not.toBeInTheDocument()
    expect(mocks.center.generateSessionImage).not.toHaveBeenCalled()
    await click('generateImage')
    review()
    await click('generationSubmit')
    expect(view.store.getState().comfyStatus.results).toHaveLength(1)
    await click('chooseManagedAsset')
    expect(screen.queryByLabelText(t('generationPrompt'))).not.toBeInTheDocument()
    expect(
      screen.getByRole('radio', {
        name: t('managedOutputIdentity', { result: generated().resultId, task: generated().jobId })
      })
    ).not.toBeChecked()
    expect(mocks.center.acceptSessionImageGeneration).toHaveBeenCalledTimes(1)
    expect(mocks.center.chooseManagedSessionAsset).not.toHaveBeenCalled()
  })

  it.each(['missing-profile', 'capability', 'quota'] as const)(
    'disables the entry for %s without falling back',
    async (reason) => {
      const item =
        reason === 'missing-profile'
          ? {
              ...plugin,
              settings: {
                analysisProfileId: 'analysis-only',
                backgroundRemovalProfileId: 'background-only'
              }
            }
          : reason === 'capability'
            ? { ...plugin, capabilities: ['dialogue'] as FigPluginManagedSummary['capabilities'] }
            : plugin
      await mountPanel(item)
      if (reason === 'quota') {
        mocks.center.sessionAssets.mockResolvedValue({
          protocol: 1,
          purpose: 'local-preview',
          sessionId: key.sessionId,
          assets: [asset(1), asset(2), asset(3), asset(4)]
        })
        await click('listAssets')
      }
      expect(button('generateImage')).toBeDisabled()
      expect(mocks.center.generateSessionImage).not.toHaveBeenCalled()
    }
  )

  it.each(['revoke', 'configuration', 'project-deletion', 'unmount'] as const)(
    'cancels pending generation on panel %s despite the global pending lock',
    async (change) => {
      const pending = deferred<FigPluginImageGenerationOutput | null>()
      mocks.center.generateSessionImage.mockReturnValue(pending.promise)
      const view = await mountPanel()
      await click('generateImage')
      review()
      await click('generationSubmit')
      expect(button('refresh')).toBeDisabled()
      expect(button('generationStop')).toBeEnabled()
      if (change === 'revoke') await click('revoke')
      else if (change === 'configuration')
        view.rerender({
          ...plugin,
          settings: { ...plugin.settings, imageGenerationProfileId: 'different-image' }
        })
      else if (change === 'project-deletion') {
        mocks.projects.mockReturnValue([])
        await act(async () => {
          window.dispatchEvent(new Event('app:projects-changed'))
        })
      } else view.unmount()
      await act(async () => {
        pending.resolve(generated())
      })
      expect(mocks.center.cancelSessionImageGeneration).toHaveBeenCalledExactlyOnceWith(key)
      expect(mocks.center.acceptSessionImageGeneration).not.toHaveBeenCalled()
      expect(view.store.getState().comfyStatus.results).toEqual([])
    }
  )
})
