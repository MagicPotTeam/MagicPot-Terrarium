import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus } from '@shared/api/svcAppUpdate'
import { DEFAULT_CONFIG } from '@shared/config/config'
import PanelAbout from './PanelAbout'

const mocks = vi.hoisted(() => ({
  apiValue: {} as unknown,
  getStatus: vi.fn(),
  watchStatus: vi.fn(),
  checkForUpdates: vi.fn()
}))

const translations: Record<string, string> = {
  'about.title_app': 'Magic Pot AI Launcher',
  'about.description_app': 'Description',
  'about.version_label': 'Version',
  'about.developer_label': 'Developer',
  'about.license_label': 'License',
  'about.source_code_label': 'Source Code',
  'about.license_text_label': 'License Text',
  'about.license_text_action': 'Open project LICENSE',
  'about.warranty_label': 'Warranty',
  'about.warranty_text': 'No warranty',
  'about.developer_name': 'MagicPotTeam',
  'about.license_name': 'AGPL-3.0',
  'about.update.title': 'GitHub Updates',
  'about.update.version_unknown': 'unknown',
  'about.update.detail_idle': 'Packaged builds can check GitHub Releases.',
  'about.update.detail_not_available': 'This app is up to date.',
  'about.update.detail_unsupported': 'Auto-update is available only in packaged builds.',
  'about.update.action_check': 'Check for updates',
  'about.update.action_download': 'Download update',
  'about.update.action_install': 'Restart and install',
  'about.update.state.idle': 'Ready',
  'about.update.state.unsupported': 'Unavailable',
  'about.update.state.not_available': 'Up to date'
}

const idleStatus: AppUpdateStatus = {
  state: 'idle',
  currentVersion: '1.0.0',
  provider: {
    type: 'github',
    owner: 'MagicPotTeam',
    repo: 'magicpot-open',
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
      if (options) {
        for (const [optionKey, optionValue] of Object.entries(options)) {
          value = value.replace(`{{${optionKey}}}`, optionValue)
        }
      }
      return value
    }
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => mocks.apiValue
}))

vi.mock('./components/SettingSection', () => ({
  default: ({ children }: { children: ReactNode }) => <section>{children}</section>
}))

vi.mock('@renderer/components/ExternalLInk', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  )
}))

describe('PanelAbout', () => {
  beforeEach(() => {
    mocks.apiValue = {}
    mocks.getStatus.mockReset()
    mocks.watchStatus.mockReset()
    mocks.checkForUpdates.mockReset()
  })

  it('renders an unsupported updater state when the bridge service is missing', () => {
    render(<PanelAbout settingsValue={DEFAULT_CONFIG} saveSettings={vi.fn()} />)

    expect(screen.getByText('GitHub Updates')).toBeTruthy()
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.getByText('Auto-update is available only in packaged builds.')).toBeTruthy()
  })

  it('checks for updates through the optional bridge service', async () => {
    mocks.getStatus.mockResolvedValue(idleStatus)
    mocks.watchStatus.mockResolvedValue(undefined)
    mocks.checkForUpdates.mockResolvedValue({
      ...idleStatus,
      state: 'not-available',
      canCheck: true
    })
    mocks.apiValue = {
      svcAppUpdate: {
        getStatus: mocks.getStatus,
        watchStatus: mocks.watchStatus,
        checkForUpdates: mocks.checkForUpdates
      }
    }

    render(<PanelAbout settingsValue={DEFAULT_CONFIG} saveSettings={vi.fn()} />)

    expect(await screen.findByText('Ready')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }))

    await waitFor(() => {
      expect(mocks.checkForUpdates).toHaveBeenCalledWith({})
      expect(screen.getByText('Up to date')).toBeTruthy()
    })
  })
})
