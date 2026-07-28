import type { ReactNode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus } from '@shared/api/svcAppUpdate'
import PanelUpdates from './PanelUpdates'

const settingsValue = {} as React.ComponentProps<typeof PanelUpdates>['settingsValue']

const mocks = vi.hoisted(() => ({
  apiValue: {} as unknown,
  getStatus: vi.fn(),
  watchStatus: vi.fn(),
  checkForUpdates: vi.fn(),
  getLauncherState: vi.fn(),
  saveLauncherSettings: vi.fn()
}))

const translations: Record<string, string> = {
  'about.update.page_title': 'Updates',
  'about.update.page_description': 'Manage updates.',
  'about.update.active_install': 'Active install',
  'about.update.channel_title': 'Channel',
  'about.update.release_feed_title': 'Release feed',
  'about.update.pinned_version_title': 'Pinned version',
  'about.update.mode_title': 'Update mode',
  'about.update.installed_versions_title': 'Installed versions on disk',
  'about.update.version_unknown': 'unknown',
  'about.update.detail_idle': 'Packaged builds can check GitHub Releases.',
  'about.update.detail_not_available': 'This app is up to date.',
  'about.update.detail_managed_by_launcher': 'Updates are managed by MagicPot Launcher.',
  'about.update.detail_unsupported': 'Auto-update is available only in packaged builds.',
  'about.update.action_check_now': 'Check now',
  'about.update.action_update': 'Update',
  'about.update.action_rollback': 'Rollback',
  'about.update.rollback_unavailable': 'Rollback unavailable.',
  'about.update.launcher_status': 'Launcher status',
  'about.update.actions_follow_status': 'Actions follow updater status.',
  'about.update.actions_launcher_managed': 'Launcher managed.',
  'about.update.actions_bridge_unavailable': 'Bridge unavailable.',
  'about.update.actions_packaged_only': 'Packaged only.',
  'about.update.state.idle': 'Ready',
  'about.update.state.managed_by_launcher': 'Managed by Launcher',
  'about.update.state.unsupported': 'Unavailable',
  'about.update.state.not_available': 'Up to date',
  'about.update.launcher.mode_manual': 'Manual',
  'about.update.launcher.mode_notify_short': 'Notify',
  'about.update.launcher.mode_auto_short': 'Auto',
  'about.update.launcher.channel_stable': 'Stable',
  'about.update.launcher.channel_beta': 'Beta',
  'about.update.launcher.channel_nightly': 'Nightly',
  'about.update.launcher.status_installed': 'Installed',
  'about.update.launcher.save': 'Save Launcher settings',
  'about.update.launcher.next_launch': 'Changes take effect on the next launch.',
  'about.update.launcher.bridge_unavailable': 'Launch from MagicPot Launcher.',
  'about.update.launcher.unmanaged': 'Unmanaged; launch from MagicPot Launcher.',
  'about.update.launcher.not_writable': 'Launcher settings are not writable.',
  'about.update.launcher.load_error': 'Could not load Launcher settings: {{error}}',
  'about.update.launcher.save_error': 'Could not save Launcher settings: {{error}}',
  'about.update.launcher.managed': 'Managed',
  'about.update.channel_description': 'Choose a channel.',
  'about.update.channel_stable_description': 'Tested releases.',
  'about.update.channel_beta_description': 'Preview releases.',
  'about.update.channel_nightly_description': 'Development builds.',
  'about.update.custom_mirror': 'Custom mirror',
  'about.update.repository': 'Repository',
  'about.update.release_feed_read_only': 'Read-only GitHub feed.',
  'about.update.custom_mirror_url': 'Custom mirror URL',
  'about.update.custom_mirror_unavailable': 'Custom mirrors unavailable.',
  'about.update.no_pin': 'No pin',
  'about.update.pinned_version_unavailable': 'Pinning unavailable.',
  'about.update.mode_description': 'Save mode and channel.',
  'about.update.mode_manual_description': 'Check only when requested.',
  'about.update.mode_notify_description': 'Notify on launch.',
  'about.update.mode_auto_description': 'Update on launch.',
  'about.update.active': 'Active',
  'about.update.only_active_known': 'Only active version known.'
}

const idleStatus: AppUpdateStatus = {
  state: 'idle',
  currentVersion: '1.0.0',
  provider: {
    type: 'github',
    owner: 'MagicPotTeam',
    repo: 'MagicPot-Terrarium',
    channel: 'latest'
  },
  supported: true,
  canCheck: true,
  canDownload: false,
  canInstall: false
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      let value = translations[key] ?? key
      for (const [optionKey, optionValue] of Object.entries(options ?? {})) {
        value = value.replace(`{{${optionKey}}}`, optionValue)
      }
      return value
    }
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({ api: () => mocks.apiValue }))
vi.mock('./components/SettingSection', () => ({
  default: ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  )
}))

describe('PanelUpdates', () => {
  beforeEach(() => {
    mocks.apiValue = {}
    mocks.getStatus.mockReset()
    mocks.watchStatus.mockReset()
    mocks.checkForUpdates.mockReset()
    mocks.getLauncherState.mockReset()
    mocks.saveLauncherSettings.mockReset()
  })

  it('renders the full read-only layout when the bridge is unavailable', () => {
    render(<PanelUpdates settingsValue={settingsValue} saveSettings={vi.fn()} />)

    for (const heading of [
      'Active install',
      'Channel',
      'Release feed',
      'Pinned version',
      'Update mode',
      'Installed versions on disk'
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
    }
    expect(screen.getByDisplayValue('MagicPotTeam/MagicPot-Terrarium')).toBeTruthy()
    const customMirrorInput = screen.getByLabelText('Custom mirror URL')
    expect(customMirrorInput).toBeDisabled()
    expect(
      customMirrorInput.closest('.MuiFormControl-root')?.querySelector('.MuiInputLabel-root')
    ).toBeNull()
    expect(screen.getAllByText('Launch from MagicPot Launcher.')).toHaveLength(2)
    expect(screen.getByTestId('channel-radio-group')).toHaveStyle({ flexDirection: 'column' })
    expect(screen.getByTestId('update-mode-radio-group')).toHaveStyle({ flexDirection: 'column' })

    const channelSection = screen.getByRole('heading', { name: 'Channel' }).closest('section')
    expect(channelSection).not.toBeNull()
    expect(within(channelSection!).getByRole('radio', { name: /Stable/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save Launcher settings' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Rollback' })).toBeDisabled()
  })

  it('renders the full layout but disables launcher controls when unmanaged', async () => {
    mocks.getStatus.mockResolvedValue(idleStatus)
    mocks.getLauncherState.mockResolvedValue({ managed: false, settingsWritable: false })
    mocks.apiValue = {
      svcAppUpdate: { getStatus: mocks.getStatus, getLauncherState: mocks.getLauncherState }
    }

    render(<PanelUpdates settingsValue={settingsValue} saveSettings={vi.fn()} />)

    expect(
      (await screen.findAllByText('Unmanaged; launch from MagicPot Launcher.')).length
    ).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Release feed' })).toBeTruthy()

    const channelSection = screen.getByRole('heading', { name: 'Channel' }).closest('section')
    expect(channelSection).not.toBeNull()
    expect(within(channelSection!).getByRole('radio', { name: /Stable/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save Launcher settings' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Check now' })).not.toBeDisabled()
  })

  it('loads and saves managed Launcher channel and mode settings', async () => {
    mocks.getStatus.mockResolvedValue({
      ...idleStatus,
      state: 'managed-by-launcher',
      supported: false,
      canCheck: false
    })
    mocks.getLauncherState.mockResolvedValue({
      managed: true,
      settingsWritable: true,
      updateMode: 'notify-on-launch',
      channel: 'beta',
      launchStatus: 'installed',
      launchVersion: '1.0.0',
      capabilities: { checkNow: true, installLatest: true, rollback: false }
    })
    mocks.saveLauncherSettings.mockResolvedValue({
      managed: true,
      settingsWritable: true,
      updateMode: 'notify-on-launch',
      channel: 'beta',
      capabilities: { checkNow: true, installLatest: true, rollback: false }
    })
    mocks.apiValue = {
      svcAppUpdate: {
        getStatus: mocks.getStatus,
        getLauncherState: mocks.getLauncherState,
        saveLauncherSettings: mocks.saveLauncherSettings
      }
    }

    render(<PanelUpdates settingsValue={settingsValue} saveSettings={vi.fn()} />)

    expect(await screen.findByText(/Installed/)).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('radio', { name: /Beta/ })).toBeChecked())
    expect(screen.getByRole('radio', { name: /Notify/ })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Save Launcher settings' }))

    await waitFor(() =>
      expect(mocks.saveLauncherSettings).toHaveBeenCalledWith({
        updateMode: 'notify-on-launch',
        channel: 'beta'
      })
    )
    expect(await screen.findByText('Changes take effect on the next launch.')).toBeTruthy()
  })

  it('tolerates managed state from an older bridge without capabilities', async () => {
    mocks.getStatus.mockResolvedValue({
      ...idleStatus,
      state: 'managed-by-launcher',
      supported: false,
      canCheck: false
    })
    mocks.getLauncherState.mockResolvedValue({
      managed: true,
      settingsWritable: true,
      updateMode: 'manual',
      channel: 'stable'
    })
    mocks.apiValue = {
      svcAppUpdate: {
        getStatus: mocks.getStatus,
        getLauncherState: mocks.getLauncherState,
        checkLauncherNow: vi.fn(),
        requestLauncherUpdate: vi.fn(),
        requestLauncherRollback: vi.fn()
      }
    }

    render(<PanelUpdates settingsValue={settingsValue} saveSettings={vi.fn()} />)

    await screen.findByText(/Launcher status.*Managed/)
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Rollback' })).toBeDisabled()
  })

  it('preserves standalone packaged check-for-updates behavior', async () => {
    mocks.getStatus.mockResolvedValue(idleStatus)
    mocks.getLauncherState.mockResolvedValue({ managed: false, settingsWritable: false })
    mocks.checkForUpdates.mockResolvedValue({ ...idleStatus, state: 'not-available' })
    mocks.apiValue = {
      svcAppUpdate: {
        getStatus: mocks.getStatus,
        getLauncherState: mocks.getLauncherState,
        checkForUpdates: mocks.checkForUpdates
      }
    }

    render(<PanelUpdates settingsValue={settingsValue} saveSettings={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(mocks.checkForUpdates).toHaveBeenCalledWith({}))
  })
})
