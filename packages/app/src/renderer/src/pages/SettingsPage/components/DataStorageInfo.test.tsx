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
  'environment.data_directory.loading': 'Loading global storage root...',
  'environment.data_directory.load_failed': 'Failed to load the global storage root.',
  'environment.data_directory.unavailable': 'No global storage root information is available.',
  'environment.data_directory.info':
    'Choose one global storage root. Magic Pot keeps internal app data in Data, project canvases and source assets in Projects, and automatic exports in AutoSave.',
  'environment.data_directory.env_override':
    'The current storage location is forced by MAGICPOT_STORAGE_ROOT or the legacy MAGICPOT_USER_DATA_DIR environment variable. Remove the override before changing it here.',
  'environment.data_directory.card_title': 'Global storage root',
  'environment.data_directory.status_default': 'Default',
  'environment.data_directory.status_custom': 'Custom',
  'environment.data_directory.status_env_override': 'Environment override',
  'environment.data_directory.status_applying': 'Applying',
  'environment.data_directory.current_directory': 'Current storage root',
  'environment.data_directory.default_directory': 'Default storage root',
  'environment.data_directory.data_subdirectory': 'App data',
  'environment.data_directory.projects_subdirectory': 'Projects',
  'environment.data_directory.autosave_subdirectory': 'Automatic exports',
  'environment.data_directory.legacy_layout': 'Legacy layout',
  'environment.data_directory.restart_hint':
    'Changing the root restarts the app. Magic Pot derives Data, Projects, and AutoSave automatically and migrates app data into an empty target.',
  'environment.data_directory.choose': 'Choose storage root',
  'environment.data_directory.open_current': 'Open storage root',
  'environment.data_directory.use_default': 'Use default root',
  'environment.data_directory.update_failed': 'Failed to update the global storage root.',
  'environment.data_directory.dialog_title': 'Change global storage root',
  'environment.data_directory.dialog_message': 'This change requires an app restart.',
  'environment.data_directory.dialog_confirm': 'Restart now',
  'environment.data_directory.dialog_cancel': 'Cancel',
  'environment.data_directory.dialog_choose_title': 'Choose a global storage root',
  'environment.data_directory.dialog_detail_custom':
    'New global storage root:\n{{targetPath}}\n\nMagic Pot will use Data, Projects, and AutoSave below this directory. Existing app data is copied when the target Data directory is empty.',
  'environment.data_directory.dialog_detail_default':
    'Magic Pot will return to the default global storage root:\n{{targetPath}}\n\nData, Projects, and AutoSave are derived automatically.'
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
        currentPath: 'C:/MagicPot/Data',
        defaultPath: 'C:/DefaultMagicPot/Data',
        storageRoot: 'C:/MagicPot',
        defaultStorageRoot: 'C:/DefaultMagicPot',
        projectRoot: 'C:/MagicPot/Projects',
        autoSaveRoot: 'C:/MagicPot/AutoSave',
        isCustom: true,
        source: 'persisted',
        legacyLayout: false
      }
    })
  })

  it('renders the current and default data directories', async () => {
    render(<DataStorageInfo />)

    expect(await screen.findByText('Global storage root')).toBeTruthy()
    expect(screen.getByText('Current storage root')).toBeTruthy()
    expect(screen.getByText('C:/MagicPot')).toBeTruthy()
    expect(screen.getByText('C:/MagicPot/Data')).toBeTruthy()
    expect(screen.getByText('C:/MagicPot/Projects')).toBeTruthy()
    expect(screen.getByText('C:/MagicPot/AutoSave')).toBeTruthy()
    expect(screen.getByText('Default storage root')).toBeTruthy()
    expect(screen.getByText('C:/DefaultMagicPot')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose storage root' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use default root' })).toBeTruthy()
  })

  it('opens the current directory', async () => {
    render(<DataStorageInfo />)

    await userEvent.click(await screen.findByRole('button', { name: 'Open storage root' }))
    expect(openPathMock).toHaveBeenCalledWith('C:/MagicPot')
  })

  it('switches to a user-selected directory after confirmation', async () => {
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['D:/MagicPotData']
    })
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    setUserDataDirectoryMock.mockResolvedValue({ restartRequired: true })

    render(<DataStorageInfo />)

    await userEvent.click(await screen.findByRole('button', { name: 'Choose storage root' }))

    await waitFor(() => {
      expect(showOpenDialogMock).toHaveBeenCalledTimes(1)
      expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
      expect(setUserDataDirectoryMock).toHaveBeenCalledWith({ path: 'D:/MagicPotData' })
    })
  })
})
