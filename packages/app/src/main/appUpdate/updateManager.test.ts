import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SetupOptions = {
  isPackaged: boolean
  packageMode: 'pure' | 'embedded'
  exePath?: string
}

async function loadUpdateManager({
  isPackaged,
  packageMode,
  exePath = path.join('D:', 'MagicPot', 'MagicPot.exe')
}: SetupOptions) {
  vi.resetModules()

  const appMock = {
    isPackaged,
    getPath: vi.fn((name: string) => {
      if (name === 'exe') {
        return exePath
      }
      throw new Error(`Unexpected app.getPath(${name})`)
    }),
    getVersion: vi.fn(() => '9.9.9'),
    on: vi.fn()
  }
  const autoUpdaterMock = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    channel: '',
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    installDirectory: undefined as string | undefined
  }

  vi.doMock('electron', () => ({
    app: appMock
  }))
  vi.doMock('@shared/config/viteEnv', () => ({
    PACKAGE_MODE: packageMode,
    PACKAGE_VERSION: '1.2.3',
    UPDATE_PROVIDER_CHANNEL: 'latest',
    UPDATE_PROVIDER_OWNER: 'MagicPotTeam',
    UPDATE_PROVIDER_REPO: 'magicpot-open'
  }))
  vi.doMock('electron-updater', () => ({
    autoUpdater: autoUpdaterMock
  }))

  const module = await import('./updateManager')
  return { module, appMock, autoUpdaterMock }
}

describe('updateManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('stays unsupported in development even when the build mode is pure', async () => {
    const { module, autoUpdaterMock } = await loadUpdateManager({
      isPackaged: false,
      packageMode: 'pure'
    })

    await expect(module.initializeAppUpdateManager()).resolves.toMatchObject({
      state: 'unsupported',
      supported: false,
      canCheck: false
    })
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
  })

  it('supports embedded packaged builds by installing pure updates into the current app directory', async () => {
    const exePath = path.join('D:', 'MagicPot', 'magicpot', 'magicpot.exe')
    const { module, autoUpdaterMock } = await loadUpdateManager({
      isPackaged: true,
      packageMode: 'embedded',
      exePath
    })

    await expect(module.initializeAppUpdateManager()).resolves.toMatchObject({
      state: 'idle',
      supported: true,
      canCheck: true
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'MagicPotTeam',
      repo: 'magicpot-open',
      channel: 'latest'
    })
    if (process.platform === 'win32') {
      expect(autoUpdaterMock.installDirectory).toBe(path.dirname(exePath))
    }
  })

  it('configures electron-updater to read latest for pure packaged builds', async () => {
    const { module, appMock, autoUpdaterMock } = await loadUpdateManager({
      isPackaged: true,
      packageMode: 'pure'
    })

    await expect(module.initializeAppUpdateManager()).resolves.toMatchObject({
      state: 'idle',
      supported: true,
      canCheck: true
    })
    expect(autoUpdaterMock.autoDownload).toBe(false)
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
    expect(autoUpdaterMock.allowPrerelease).toBe(false)
    expect(autoUpdaterMock.channel).toBe('latest')
    if (process.platform === 'win32') {
      expect(autoUpdaterMock.installDirectory).toBe(path.join('D:', 'MagicPot'))
    }
    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'MagicPotTeam',
      repo: 'magicpot-open',
      channel: 'latest'
    })
    expect(appMock.on).toHaveBeenCalledWith('before-quit-for-update', expect.any(Function))
  })
})
