import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import type { LLMListProfilesReq, LLMListProfilesResp } from '@shared/api/svcLLMProxy'
import type {
  FigPluginManagedList,
  FigPluginManagedSummary,
  FigPluginPackagePreview
} from '@shared/figplugin/management'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import WorkshopPluginsPage from './WorkshopPluginsPage'

const mocks = vi.hoisted(() => ({
  center: {
    execute: vi.fn<FigPluginCenterSvc['execute']>(),
    listPackages: vi.fn<FigPluginCenterSvc['listPackages']>(),
    choosePackage: vi.fn<FigPluginCenterSvc['choosePackage']>(),
    installPackage: vi.fn<FigPluginCenterSvc['installPackage']>(),
    configurePackage: vi.fn<FigPluginCenterSvc['configurePackage']>(),
    removePackage: vi.fn<FigPluginCenterSvc['removePackage']>(),
    copyPackagePath: vi.fn<FigPluginCenterSvc['copyPackagePath']>(),
    revealPackage: vi.fn<FigPluginCenterSvc['revealPackage']>(),
    discardPreview: vi.fn<FigPluginCenterSvc['discardPreview']>(),
    createPairing: vi.fn<FigPluginCenterSvc['createPairing']>(),
    bridgeState: vi.fn<FigPluginCenterSvc['bridgeState']>(),
    approveBridge: vi.fn<FigPluginCenterSvc['approveBridge']>(),
    denyBridge: vi.fn<FigPluginCenterSvc['denyBridge']>(),
    revokeBridge: vi.fn<FigPluginCenterSvc['revokeBridge']>(),
    planState: vi.fn<FigPluginCenterSvc['planState']>(),
    approvePlanExecution: vi.fn<FigPluginCenterSvc['approvePlanExecution']>(),
    acceptVisualBaseline: vi.fn<FigPluginCenterSvc['acceptVisualBaseline']>(),
    authorizeVisualCorrection: vi.fn<FigPluginCenterSvc['authorizeVisualCorrection']>(),
    cancelVisualCorrectionAuthorization:
      vi.fn<FigPluginCenterSvc['cancelVisualCorrectionAuthorization']>(),
    denyPlanExecution: vi.fn<FigPluginCenterSvc['denyPlanExecution']>(),
    cancelPlanExecution: vi.fn<FigPluginCenterSvc['cancelPlanExecution']>()
  } satisfies FigPluginCenterSvc,
  profiles: vi.fn<(req: LLMListProfilesReq) => Promise<LLMListProfilesResp>>()
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcFigPluginCenter: mocks.center, svcLLMProxy: { listProfiles: mocks.profiles } })
}))
vi.mock('./components/CustomWorkshopTabs', () => ({
  default: () => <nav data-testid="workshop-tabs" />
}))
vi.mock('../MainPage/projectStore', () => ({
  listProjects: () => [],
  getProjectById: () => undefined,
  PROJECTS_CHANGED_EVENT: 'app:projects-changed'
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`
  })
}))

const key = (name: string) => `figplugin.center.${name}`
const bridgeKey = (name: string) => `figplugin.bridge.${name}`
const button = (name: string) => screen.getByRole('button', { name: key(name) })
const summaryManifest = {
  schemaVersion: 1,
  id: 'example.plugin',
  name: 'Example Package',
  version: '1.2.3',
  host: 'figma'
}
const manifestSha256 = createHash('sha256')
  .update(canonicalFigPluginJson(summaryManifest))
  .digest('hex')
const refreshedManifestSha256 = createHash('sha256')
  .update(canonicalFigPluginJson({ ...summaryManifest, version: '1.2.4' }))
  .digest('hex')
const target: FigPluginManagedSummary = {
  pluginId: 'example.plugin',
  name: 'Example Package',
  version: '1.2.3',
  host: 'figma',
  generation: 7,
  capabilities: ['dialogue', 'background-removal', 'asset-transfer', 'result-transfer'],
  materialization: 'verified-package',
  signerFingerprint: 'b'.repeat(64),
  artifactSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:43123',
  manifestSha256,
  fileCount: 3,
  contentBytes: 1024,
  configured: true,
  ready: false,
  state: 'disabled',
  cleanupPending: false,
  settings: { analysisProfileId: 'missing-chat', backgroundRemovalProfileId: 'missing-image' }
}
const preview = (): FigPluginPackagePreview => ({
  receiptId: 'a'.repeat(48),
  expiresAt: Date.now() + 60_000,
  pluginId: target.pluginId,
  name: target.name,
  version: target.version,
  host: target.host,
  expectedGeneration: 7,
  capabilities: target.capabilities,
  signerFingerprint: 'b'.repeat(64),
  artifactSha256: 'c'.repeat(64),
  fileCount: 3,
  contentBytes: 1024,
  signatureVerified: true,
  publisherTrusted: false,
  executesInDesktop: false
})
const listing = (items: FigPluginManagedSummary[] = [target]): FigPluginManagedList => ({
  items,
  skippedRecords: 0,
  truncated: false
})
const completed = { completed: true, generation: 8, cleanupPending: false }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function mount() {
  const result = render(<WorkshopPluginsPage />)
  await waitFor(() => expect(button('choose')).toBeEnabled())
  return result
}
async function choose() {
  fireEvent.click(button('choose'))
  await screen.findByRole('dialog', { name: key('previewTitle') })
  await waitFor(() => expect(button('cancel')).toBeEnabled())
}
async function configure() {
  fireEvent.click(button('configure'))
  await screen.findByRole('dialog', { name: key('configureTitle') })
  await waitFor(() => expect(button('save')).toBeEnabled())
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected external request')
    })
  )
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abc')
  mocks.center.listPackages.mockResolvedValue(listing())
  mocks.center.choosePackage.mockImplementation(async () => preview())
  mocks.center.installPackage.mockResolvedValue(completed)
  mocks.center.configurePackage.mockResolvedValue(completed)
  mocks.center.removePackage.mockResolvedValue(completed)
  mocks.center.copyPackagePath.mockResolvedValue({ completed: true })
  mocks.center.revealPackage.mockResolvedValue({ completed: true })
  mocks.center.discardPreview.mockResolvedValue(undefined)
  mocks.center.planState.mockResolvedValue({
    previews: [],
    statuses: [],
    baselines: [],
    correctionAuthorizations: []
  })
  mocks.profiles.mockResolvedValue({
    profiles: [
      { id: 'chat-id', model_name: 'Chat candidate', model_use: 'chat' },
      { id: 'image-id', model_name: 'Image candidate', model_use: 'image' },
      { id: 'video-id', model_name: 'Video candidate', model_use: 'video' }
    ]
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorkshopPluginsPage', () => {
  it('loads the bounded authoritative list only; composes tabs and stays disconnected', async () => {
    await mount()
    expect(mocks.center.listPackages).toHaveBeenCalledWith({})
    expect(mocks.center.listPackages).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('workshop-tabs')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: target.name })).toBeInTheDocument()
    expect(screen.getByText('Manifest SHA-256')).toBeInTheDocument()
    expect(screen.getByText(manifestSha256)).toBeInTheDocument()
    expect(screen.getByText(key('notReady'))).toBeInTheDocument()
    expect(screen.getByText(key('hostDisconnected'))).toBeInTheDocument()
    expect(screen.getByText(bridgeKey('runtimeStatus'))).toBeInTheDocument()
    expect(screen.getByText(bridgeKey('hostStatus'))).toBeInTheDocument()
    expect(screen.getByText(bridgeKey('hostGuidance'))).toBeInTheDocument()
    expect(screen.getByRole('region', { name: bridgeKey('title') })).toBeInTheDocument()
    expect(
      screen.getByRole('option', {
        name: `${bridgeKey('pluginOption')} ${target.name} ${target.pluginId}`
      })
    ).toBeInTheDocument()
    for (const method of [
      'createPairing',
      'bridgeState',
      'approveBridge',
      'denyBridge',
      'revokeBridge'
    ] as const)
      expect(mocks.center[method]).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: bridgeKey('createTicket') })).toBeDisabled()
    expect(mocks.profiles).not.toHaveBeenCalled()
    expect(mocks.center.execute).not.toHaveBeenCalled()
    expect(mocks.center.installPackage).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('filters host and search locally and refreshes only on request', async () => {
    mocks.center.listPackages.mockResolvedValue(
      listing([
        target,
        { ...target, pluginId: 'example.photoshop', name: 'Other Package', host: 'photoshop' }
      ])
    )
    await mount()
    fireEvent.change(screen.getByLabelText(key('hostFilter')), { target: { value: 'photoshop' } })
    expect(screen.queryByRole('article', { name: target.name })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Other Package' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(key('search')), { target: { value: 'no match' } })
    expect(screen.getByText(key('noMatches'))).toBeInTheDocument()
    expect(within(screen.getByLabelText(bridgeKey('plugin'))).getAllByRole('option')).toHaveLength(
      3
    )
    expect(mocks.center.listPackages).toHaveBeenCalledTimes(1)
    fireEvent.click(button('refresh'))
    await waitFor(() => expect(mocks.center.listPackages).toHaveBeenCalledTimes(2))
    expect(mocks.center.listPackages).toHaveBeenLastCalledWith({})
  })

  it('shows a genuine empty state and never offers fake installed cards', async () => {
    mocks.center.listPackages.mockResolvedValue(listing([]))
    await mount()
    expect(screen.getByText(key('empty'))).toBeInTheDocument()
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: key('configure') })).not.toBeInTheDocument()
  })

  it('fails closed on corrupt or oversized listing responses without exposing errors', async () => {
    mocks.center.listPackages.mockResolvedValueOnce({
      items: [{ name: '<script>PRIVATE_FIXTURE_SECRET</script>' }]
    } as unknown as FigPluginManagedList)
    await mount()
    expect(screen.getByText(key('errors.UNKNOWN'))).toBeInTheDocument()
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    expect(document.body).not.toHaveTextContent('PRIVATE_FIXTURE_SECRET')
    mocks.center.listPackages.mockResolvedValue(listing(Array.from({ length: 257 }, () => target)))
    fireEvent.click(button('refresh'))
    await waitFor(() => expect(button('refresh')).toBeEnabled())
    expect(screen.queryAllByRole('article')).toHaveLength(0)
  })

  it('distinguishes metadata-only records and reports truncation, skips and pending cleanup', async () => {
    mocks.center.listPackages.mockResolvedValue({
      ...listing([{ ...target, materialization: 'metadata-only', cleanupPending: true }]),
      truncated: true,
      skippedRecords: 2
    })
    await mount()
    expect(screen.getByText(key('metadataOnly'))).toBeInTheDocument()
    expect(screen.getByText(key('cleanupPending'))).toBeInTheDocument()
    expect(screen.getByText(key('truncated'))).toBeInTheDocument()
    expect(screen.getByText(`${key('skipped')} 2`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: key('copyPath') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: key('reveal') })).not.toBeInTheDocument()
  })

  it('native chooser cancellation never persists or installs anything', async () => {
    mocks.center.choosePackage.mockResolvedValue(null)
    await mount()
    fireEvent.click(button('choose'))
    await waitFor(() => expect(button('choose')).toBeEnabled())
    expect(mocks.center.choosePackage).toHaveBeenCalledWith({})
    expect(mocks.center.installPackage).not.toHaveBeenCalled()
    expect(mocks.center.configurePackage).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reviews verified metadata as plain text with exact fingerprint, never executable HTML', async () => {
    mocks.center.choosePackage.mockResolvedValue({
      ...preview(),
      name: '<img src=x onerror=alert(1)>'
    })
    await mount()
    await choose()
    const dialog = within(screen.getByRole('dialog'))
    expect(
      dialog.getByText(`${key('packageName')} <img src=x onerror=alert(1)>`)
    ).toBeInTheDocument()
    expect(document.querySelector('img,script,iframe')).toBeNull()
    const fingerprint = dialog.getByText('b'.repeat(64))
    expect(fingerprint.tagName).toBe('CODE')
    expect(fingerprint).toHaveStyle({ fontFamily: 'monospace' })
    expect(dialog.getByText(`${key('content')} 1024 3`)).toBeInTheDocument()
    expect(dialog.getByText(key('signatureNotice'))).toBeInTheDocument()
    expect(dialog.getByText(key('noExecution'))).toBeInTheDocument()
    for (const capability of target.capabilities)
      expect(dialog.getByText(key(`capabilities.${capability}`))).toBeInTheDocument()
    expect(button('install')).toBeDisabled()
    expect(mocks.center.installPackage).not.toHaveBeenCalled()
  })

  it('rejects invalid preview flags and discards its valid receipt', async () => {
    mocks.center.choosePackage.mockResolvedValue({
      ...preview(),
      signatureVerified: false
    } as unknown as FigPluginPackagePreview)
    await mount()
    fireEvent.click(button('choose'))
    await screen.findByText(key('errors.INVALID_PACKAGE'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.center.discardPreview).toHaveBeenCalledWith({ receiptId: 'a'.repeat(48) })
    )
    expect(mocks.center.installPackage).not.toHaveBeenCalled()
  })

  it('expires a receipt on a timer, resets consent and requires reselecting', async () => {
    await mount()
    vi.useFakeTimers()
    mocks.center.choosePackage.mockResolvedValue({ ...preview(), expiresAt: Date.now() + 1000 })
    await act(async () => {
      fireEvent.click(button('choose'))
    })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(button('install')).toBeEnabled()
    await act(async () => {
      vi.advanceTimersByTime(1001)
    })
    expect(screen.getByText(key('expired'))).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(button('install')).toBeDisabled()
    expect(button('reselect')).toBeEnabled()
    fireEvent.click(button('install'))
    expect(mocks.center.installPackage).not.toHaveBeenCalled()
  })

  it('installs only after consent using receipt, UUID and CAS; prevents double clicks and refreshes', async () => {
    const install = deferred<typeof completed>()
    mocks.center.installPackage.mockReturnValue(install.promise)
    await mount()
    await choose()
    fireEvent.click(button('install'))
    expect(mocks.center.installPackage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    const installButton = button('install')
    act(() => {
      fireEvent.click(installButton)
      fireEvent.click(installButton)
    })
    expect(mocks.center.installPackage).toHaveBeenCalledTimes(1)
    expect(mocks.center.installPackage).toHaveBeenCalledWith({
      receiptId: 'a'.repeat(48),
      expectedGeneration: 7,
      idempotencyKey: '12345678-1234-4234-8234-123456789abc'
    })
    expect(button('cancel')).toBeDisabled()
    await act(async () => {
      install.resolve(completed)
    })
    expect(await screen.findByText(bridgeKey('packageFilesInstalled'))).toBeInTheDocument()
    expect(mocks.center.listPackages).toHaveBeenCalledTimes(2)
  })

  it('preserves review and a retry idempotency key on failure, and never reports a main cancellation as success', async () => {
    mocks.center.installPackage
      .mockRejectedValueOnce({ code: 'IO_ERROR', message: 'secret C:/fixture-data/key' })
      .mockResolvedValueOnce({ ...completed, completed: false })
    await mount()
    await choose()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(button('install'))
    await screen.findByText(key('errors.IO_ERROR'))
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(document.body).not.toHaveTextContent('private')
    fireEvent.click(button('install'))
    await screen.findByText(key('notCompleted'))
    expect(mocks.center.installPackage.mock.calls[0]).toEqual(
      mocks.center.installPackage.mock.calls[1]
    )
    expect(screen.queryByText(bridgeKey('packageFilesInstalled'))).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('recognizes only fixed Electron-serialized management messages and invalidates expired approval', async () => {
    mocks.center.installPackage.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'svcFigPluginCenter.installPackage': FigPluginManagementError: The package preview expired or belongs to another window. Select the package again."
      )
    )
    await mount()
    await choose()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(button('install'))
    await screen.findByText(key('errors.STALE_PREVIEW'))
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(button('install')).toBeDisabled()
    expect(document.body).not.toHaveTextContent('Error invoking remote method')
  })

  it('discards on cancel and unmount, including a late native chooser reply', async () => {
    const rendered = await mount()
    await choose()
    fireEvent.click(button('cancel'))
    await waitFor(() => expect(mocks.center.discardPreview).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await choose()
    rendered.unmount()
    await waitFor(() => expect(mocks.center.discardPreview).toHaveBeenCalledTimes(2))
    const late = deferred<FigPluginPackagePreview | null>()
    mocks.center.choosePackage.mockReturnValue(late.promise)
    const next = await mount()
    fireEvent.click(button('choose'))
    next.unmount()
    await act(async () => {
      late.resolve(preview())
    })
    expect(mocks.center.discardPreview).toHaveBeenCalledTimes(3)
    expect(mocks.center.installPackage).not.toHaveBeenCalled()
  })

  it('keeps a cleanup tombstone visible with an explicit retry but no configure/copy/reveal actions', async () => {
    mocks.center.listPackages.mockResolvedValueOnce(
      listing([
        {
          ...target,
          state: 'uninstalled',
          materialization: 'cleanup-pending',
          cleanupPending: true,
          configured: false,
          settings: {}
        }
      ])
    )
    await mount()
    expect(screen.getByText(key('removedPending'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: key('configure') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: key('copyPath') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: key('reveal') })).not.toBeInTheDocument()
    fireEvent.click(button('retryCleanup'))
    await screen.findByRole('dialog', { name: key('removeTitle') })
    expect(mocks.center.removePackage).not.toHaveBeenCalled()
  })

  it('loads only profile metadata on configure, separates candidates, retains unavailable IDs and sends IDs only', async () => {
    await mount()
    expect(mocks.center.listPackages).toHaveBeenCalledTimes(1)
    expect(mocks.profiles).not.toHaveBeenCalled()
    await configure()
    const analysis = screen.getByLabelText(key('analysisProfile'))
    const background = screen.getByLabelText(key('backgroundProfile'))
    expect(analysis).toHaveValue('missing-chat')
    expect(background).toHaveValue('missing-image')
    expect(
      within(analysis).queryByRole('option', { name: /Image candidate/ })
    ).not.toBeInTheDocument()
    expect(
      within(background).queryByRole('option', { name: /Chat candidate/ })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Video candidate/ })).not.toBeInTheDocument()
    fireEvent.change(analysis, { target: { value: 'chat-id' } })
    fireEvent.change(background, { target: { value: '' } })
    mocks.center.listPackages.mockResolvedValueOnce(
      listing([
        {
          ...target,
          generation: 8,
          manifestSha256: refreshedManifestSha256,
          settings: { analysisProfileId: 'chat-id' },
          ready: false,
          state: 'disabled'
        }
      ])
    )
    fireEvent.click(button('save'))
    await screen.findByText(bridgeKey('profileReferencesSaved'))
    expect(mocks.center.configurePackage).toHaveBeenCalledWith({
      pluginId: target.pluginId,
      expectedGeneration: 7,
      settings: { analysisProfileId: 'chat-id' }
    })
    expect(mocks.center.listPackages).toHaveBeenCalledTimes(2)
    expect(screen.getByText(refreshedManifestSha256)).toBeInTheDocument()
    expect(screen.getByText(key('notReady'))).toBeInTheDocument()
    expect(screen.getByText(key('hostDisconnected'))).toBeInTheDocument()
  })

  it('keeps offline references and failed save inputs without fallback or raw errors', async () => {
    mocks.profiles.mockRejectedValue(new Error('secret endpoint'))
    mocks.center.configurePackage
      .mockRejectedValueOnce(new Error('secret token'))
      .mockResolvedValueOnce({ ...completed, completed: false })
    await mount()
    await configure()
    expect(screen.getByText(key('profilesFailed'))).toBeInTheDocument()
    expect(screen.getByLabelText(key('analysisProfile'))).toHaveValue('missing-chat')
    fireEvent.change(screen.getByLabelText(key('backgroundProfile')), { target: { value: '' } })
    fireEvent.click(button('save'))
    await screen.findByText(key('errors.UNKNOWN'))
    expect(screen.getByLabelText(key('analysisProfile'))).toHaveValue('missing-chat')
    expect(screen.getByLabelText(key('backgroundProfile'))).toHaveValue('')
    expect(document.body).not.toHaveTextContent('secret endpoint')
    expect(document.body).not.toHaveTextContent('secret token')
    fireEvent.click(button('save'))
    await screen.findByText(key('notCompleted'))
    expect(screen.queryByText(bridgeKey('profileReferencesSaved'))).not.toBeInTheDocument()
    expect(mocks.center.configurePackage).toHaveBeenLastCalledWith({
      pluginId: target.pluginId,
      expectedGeneration: 7,
      settings: { analysisProfileId: 'missing-chat' }
    })
  })

  it('awaits main clipboard/reveal completion, sends no path and never falsely claims a copy', async () => {
    const copy = deferred<{ completed: boolean }>()
    mocks.center.copyPackagePath
      .mockReturnValueOnce(copy.promise)
      .mockResolvedValueOnce({ completed: true })
    await mount()
    fireEvent.click(button('copyPath'))
    expect(screen.queryByText(key('copyComplete'))).not.toBeInTheDocument()
    expect(button('reveal')).toBeDisabled()
    await act(async () => {
      copy.resolve({ completed: false })
    })
    expect(await screen.findByText(key('notCompleted'))).toBeInTheDocument()
    expect(screen.queryByText(key('copyComplete'))).not.toBeInTheDocument()
    fireEvent.click(button('copyPath'))
    await screen.findByText(key('copyComplete'))
    fireEvent.click(button('reveal'))
    await screen.findByText(key('revealComplete'))
    expect(mocks.center.copyPackagePath).toHaveBeenLastCalledWith({
      pluginId: target.pluginId,
      expectedGeneration: 7
    })
    expect(mocks.center.revealPackage).toHaveBeenCalledWith({
      pluginId: target.pluginId,
      expectedGeneration: 7
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('requires exact name and version for removal and respects both UI and main cancellation', async () => {
    mocks.center.removePackage
      .mockResolvedValueOnce({ ...completed, completed: false })
      .mockResolvedValueOnce({ ...completed, cleanupPending: true })
    await mount()
    fireEvent.click(button('remove'))
    expect(button('confirmRemove')).toBeDisabled()
    expect(screen.getByText(key('removeNotice'))).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(key('confirmName')), {
      target: { value: `${target.name} ` }
    })
    fireEvent.change(screen.getByLabelText(key('confirmVersion')), {
      target: { value: target.version }
    })
    expect(button('confirmRemove')).toBeDisabled()
    fireEvent.click(button('cancel'))
    expect(mocks.center.removePackage).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(button('remove'))
    fireEvent.change(screen.getByLabelText(key('confirmName')), { target: { value: target.name } })
    fireEvent.change(screen.getByLabelText(key('confirmVersion')), {
      target: { value: target.version }
    })
    fireEvent.click(button('confirmRemove'))
    await screen.findByText(key('notCompleted'))
    expect(screen.queryByText(key('removeComplete'))).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(mocks.center.removePackage).toHaveBeenCalledWith({
      pluginId: target.pluginId,
      expectedGeneration: 7,
      idempotencyKey: '12345678-1234-4234-8234-123456789abc'
    })
    fireEvent.click(button('confirmRemove'))
    await screen.findByText(key('cleanupPending'))
    expect(mocks.center.listPackages).toHaveBeenCalledTimes(3)
  })

  it('closes the previous review when the target filter changes and restores focus on cancellation', async () => {
    await mount()
    const chooser = button('choose')
    chooser.focus()
    await choose()
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
    fireEvent.click(button('cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(chooser).toHaveFocus())
    await choose()
    // A programmatic target change must not keep consent to the previous target alive.
    const host = document.querySelector('select[id$="-host"]')!
    fireEvent.change(host, { target: { value: 'photoshop' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.center.installPackage).not.toHaveBeenCalled()
  })

  it('suppresses stale mount responses in StrictMode', async () => {
    const stale = deferred<FigPluginManagedList>()
    mocks.center.listPackages.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(listing([]))
    render(
      <StrictMode>
        <WorkshopPluginsPage />
      </StrictMode>
    )
    await screen.findByText(key('empty'))
    await act(async () => {
      stale.resolve(listing())
    })
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getByText(key('empty'))).toBeInTheDocument()
  })
})
