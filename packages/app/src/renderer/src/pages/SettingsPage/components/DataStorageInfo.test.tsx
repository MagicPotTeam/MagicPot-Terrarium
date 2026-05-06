import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DataStorageInfo from './DataStorageInfo'

const getUserDataDirectoryStateMock = vi.fn()
const setUserDataDirectoryMock = vi.fn()
const openPathMock = vi.fn()
const showOpenDialogMock = vi.fn()
const showMessageBoxMock = vi.fn()

const translations: Record<string, string> = {
  'environment.data_directory.loading': 'Loading data directory...',
  'environment.data_directory.load_failed': 'Failed to load the data directory state.',
  'environment.data_directory.unavailable': 'No data directory information is available.',
  'environment.data_directory.info':
    'The data directory stores local config, QApps, skills, checks, chat workspaces, and other runtime data. Only empty directories or existing Magic Pot data directories are allowed to avoid mixing unrelated files into app data.',
  'environment.data_directory.env_override':
    'The current directory is forced by the `MAGICPOT_USER_DATA_DIR` environment variable. Remove that environment variable before changing it here.',
  'environment.data_directory.card_title': 'Data directory',
  'environment.data_directory.status_default': 'Default',
  'environment.data_directory.status_custom': 'Custom',
  'environment.data_directory.status_env_override': 'Environment override',
  'environment.data_directory.status_applying': 'Applying',
  'environment.data_directory.current_directory': 'Current directory',
  'environment.data_directory.default_directory': 'Default directory',
  'environment.data_directory.restart_hint':
    'The app restarts after you switch directories. If the target directory is empty, the next launch migrates the current data. If the target already contains Magic Pot data, the app switches directly to it.',
  'environment.data_directory.choose': 'Choose directory',
  'environment.data_directory.open_current': 'Open current directory',
  'environment.data_directory.use_default': 'Use default',
  'environment.data_directory.update_failed': 'Failed to update the data directory.',
  'environment.data_directory.dialog_title': 'Change data directory',
  'environment.data_directory.dialog_message': 'This change requires an app restart.',
  'environment.data_directory.dialog_confirm': 'Restart now',
  'environment.data_directory.dialog_cancel': 'Cancel',
  'environment.data_directory.dialog_choose_title': 'Choose a data directory',
  'environment.data_directory.dialog_detail_custom':
    'New data directory:\n{{targetPath}}\n\nIf the directory is empty, Magic Pot will migrate the current data after restart. If it already contains Magic Pot data, the app will switch to it directly.',
  'environment.data_directory.dialog_detail_default':
    'Magic Pot will return to the default data directory:\n{{targetPath}}\n\nIf the default directory is empty, the app will migrate the current data after restart.'
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
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
  api: () => ({
    svcState: {
      getUserDataDirectoryState: getUserDataDirectoryStateMock,
      setUserDataDirectory: setUserDataDirectoryMock
    },
    svcShell: {
      openPath: openPathMock
    },
    svcDialog: {
      showOpenDialog: showOpenDialogMock,
      showMessageBox: showMessageBoxMock
    }
  })
}))

describe('DataStorageInfo', () => {
  beforeEach(() => {
    getUserDataDirectoryStateMock.mockReset()
    setUserDataDirectoryMock.mockReset()
    openPathMock.mockReset()
    showOpenDialogMock.mockReset()
    showMessageBoxMock.mockReset()

    getUserDataDirectoryStateMock.mockResolvedValue({
      state: {
        currentPath: 'C:/MagicPot/data',
        defaultPath: 'C:/MagicPot/default-data',
        isCustom: true,
        source: 'persisted'
      }
    })
  })

  it('renders the current and default data directories', async () => {
    render(<DataStorageInfo />)

    expect(await screen.findByText('Data directory')).toBeTruthy()
    expect(screen.getByText('Current directory')).toBeTruthy()
    expect(screen.getByText('C:/MagicPot/data')).toBeTruthy()
    expect(screen.getByText('Default directory')).toBeTruthy()
    expect(screen.getByText('C:/MagicPot/default-data')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose directory' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use default' })).toBeTruthy()
  })

  it('opens the current directory', async () => {
    render(<DataStorageInfo />)

    await userEvent.click(await screen.findByRole('button', { name: 'Open current directory' }))
    expect(openPathMock).toHaveBeenCalledWith('C:/MagicPot/data')
  })

  it('switches to a user-selected directory after confirmation', async () => {
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['D:/MagicPotData']
    })
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    setUserDataDirectoryMock.mockResolvedValue({ restartRequired: true })

    render(<DataStorageInfo />)

    await userEvent.click(await screen.findByRole('button', { name: 'Choose directory' }))

    await waitFor(() => {
      expect(showOpenDialogMock).toHaveBeenCalledTimes(1)
      expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
      expect(setUserDataDirectoryMock).toHaveBeenCalledWith({ path: 'D:/MagicPotData' })
    })
  })
})
