import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type WindowLike = { id: string }
type StartupPolicyLike = {
  automatedRun: boolean
  windowMode: string | undefined
}

const {
  appMock,
  browserWindowMock,
  setupReadyAppRuntimeMock,
  initializeMainProcessRuntimeMock,
  beforeShowMock,
  beforeQuitMock,
  createMainWindowMock,
  getAppStartupTestWindowPolicyMock,
  startQAppWatcherMock,
  stopQAppWatcherMock,
  initScreenshotManagerMock,
  cleanupScreenshotManagerMock,
  resolveStartupUserDataDirectoryMock,
  initializeAppUpdateManagerMock,
  isAppUpdateInstallInProgressMock
} = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const appMock = {
    setPath: vi.fn(),
    isPackaged: false,
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      listeners.set(event, handler)
      return appMock
    }),
    quit: vi.fn(),
    exit: vi.fn()
  }

  return {
    appMock,
    browserWindowMock: {
      getAllWindows: vi.fn<() => WindowLike[]>(() => [])
    },
    setupReadyAppRuntimeMock: vi.fn(() => Promise.resolve()),
    initializeMainProcessRuntimeMock: vi.fn(),
    beforeShowMock: vi.fn(() => Promise.resolve()),
    beforeQuitMock: vi.fn(() => Promise.resolve()),
    createMainWindowMock: vi.fn(),
    getAppStartupTestWindowPolicyMock: vi.fn<() => StartupPolicyLike>(() => ({
      automatedRun: false,
      windowMode: undefined
    })),
    startQAppWatcherMock: vi.fn(),
    stopQAppWatcherMock: vi.fn(),
    initScreenshotManagerMock: vi.fn(),
    cleanupScreenshotManagerMock: vi.fn(),
    resolveStartupUserDataDirectoryMock: vi.fn(() => ({
      path: '/test-user-data',
      source: 'default' as const
    })),
    initializeAppUpdateManagerMock: vi.fn(() => Promise.resolve()),
    isAppUpdateInstallInProgressMock: vi.fn(() => false)
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock
}))

vi.mock('./appRuntime', () => ({
  getAppStartupTestWindowPolicy: getAppStartupTestWindowPolicyMock,
  initializeMainProcessRuntime: initializeMainProcessRuntimeMock,
  setupReadyAppRuntime: setupReadyAppRuntimeMock
}))

vi.mock('./config/userDataDirectory', () => ({
  resolveStartupUserDataDirectory: resolveStartupUserDataDirectoryMock
}))

vi.mock('./lifeCycle', () => ({
  beforeShow: beforeShowMock,
  beforeQuit: beforeQuitMock
}))

vi.mock('./mainWindow', () => ({
  createMainWindow: createMainWindowMock
}))

vi.mock('./qApp/watcher', () => ({
  startQAppWatcher: startQAppWatcherMock,
  stopQAppWatcher: stopQAppWatcherMock
}))

vi.mock('./screenshot/screenshotManager', () => ({
  initScreenshotManager: initScreenshotManagerMock,
  cleanupScreenshotManager: cleanupScreenshotManagerMock
}))

vi.mock('./appUpdate/updateManager', () => ({
  initializeAppUpdateManager: initializeAppUpdateManagerMock,
  isAppUpdateInstallInProgress: isAppUpdateInstallInProgressMock
}))

vi.mock('./utils/loggingOverride', () => ({}))

async function loadModule() {
  vi.resetModules()
  await import('./index')
  await Promise.resolve()
  await Promise.resolve()
}

describe('main process startup window opening', () => {
  beforeEach(() => {
    createMainWindowMock.mockReset()
    createMainWindowMock
      .mockReturnValueOnce({ id: 'fallback-window' })
      .mockReturnValueOnce({ id: 'initial-window' })
      .mockReturnValueOnce({ id: 'activate-window' })
    setupReadyAppRuntimeMock.mockClear()
    initializeMainProcessRuntimeMock.mockClear()
    beforeShowMock.mockReset()
    beforeShowMock.mockResolvedValue(undefined)
    beforeQuitMock.mockClear()
    startQAppWatcherMock.mockClear()
    stopQAppWatcherMock.mockClear()
    initScreenshotManagerMock.mockClear()
    cleanupScreenshotManagerMock.mockClear()
    initializeAppUpdateManagerMock.mockClear()
    isAppUpdateInstallInProgressMock.mockReset().mockReturnValue(false)
    appMock.setPath.mockClear()
    appMock.whenReady.mockClear()
    appMock.on.mockClear()
    appMock.quit.mockClear()
    appMock.exit.mockClear()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    getAppStartupTestWindowPolicyMock.mockReset().mockReturnValue({
      automatedRun: false,
      windowMode: undefined
    })
    resolveStartupUserDataDirectoryMock.mockClear()
    resolveStartupUserDataDirectoryMock.mockReturnValue({
      path: '/test-user-data',
      source: 'default'
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses the same open path when beforeShow falls back to window creation in interactive mode', async () => {
    const fallbackWindow = { id: 'fallback-window' }
    getAppStartupTestWindowPolicyMock.mockReturnValue({
      automatedRun: false,
      windowMode: undefined
    })
    createMainWindowMock.mockReset()
    createMainWindowMock.mockReturnValue(fallbackWindow)
    beforeShowMock.mockRejectedValueOnce(new Error('beforeShow failed'))

    await loadModule()

    expect(createMainWindowMock).toHaveBeenCalledTimes(1)
    expect(initScreenshotManagerMock).toHaveBeenCalledTimes(1)
    expect(startQAppWatcherMock).toHaveBeenCalledTimes(1)
    expect(initializeAppUpdateManagerMock).toHaveBeenCalledTimes(1)
    expect(initScreenshotManagerMock).toHaveBeenCalledWith(fallbackWindow)
    expect(startQAppWatcherMock).toHaveBeenCalledWith(fallbackWindow)
  })

  it('uses the same open path when macOS activate recreates the window in interactive mode', async () => {
    getAppStartupTestWindowPolicyMock.mockReturnValue({
      automatedRun: false,
      windowMode: undefined
    })
    const initialWindow = { id: 'initial-window' }
    const activateWindow = { id: 'activate-window' }
    createMainWindowMock.mockReset()
    createMainWindowMock.mockReturnValueOnce(initialWindow).mockReturnValueOnce(activateWindow)

    await loadModule()

    const activateHandler = appMock.on.mock.calls.find(([event]) => event === 'activate')?.[1] as
      | (() => void)
      | undefined

    expect(activateHandler).toBeTypeOf('function')

    browserWindowMock.getAllWindows.mockReturnValueOnce([])
    activateHandler?.()

    expect(createMainWindowMock).toHaveBeenCalledTimes(2)
    expect(initScreenshotManagerMock).toHaveBeenNthCalledWith(1, initialWindow)
    expect(initScreenshotManagerMock).toHaveBeenNthCalledWith(2, activateWindow)
    expect(startQAppWatcherMock).toHaveBeenNthCalledWith(1, initialWindow)
    expect(startQAppWatcherMock).toHaveBeenNthCalledWith(2, activateWindow)
  })

  it('does nothing on macOS activate when a window already exists in interactive mode', async () => {
    getAppStartupTestWindowPolicyMock.mockReturnValue({
      automatedRun: false,
      windowMode: undefined
    })
    const initialWindow = { id: 'initial-window' }
    createMainWindowMock.mockReset()
    createMainWindowMock.mockReturnValue(initialWindow)

    await loadModule()

    const activateHandler = appMock.on.mock.calls.find(([event]) => event === 'activate')?.[1] as
      | (() => void)
      | undefined

    expect(activateHandler).toBeTypeOf('function')

    browserWindowMock.getAllWindows.mockReturnValueOnce([initialWindow] as never)
    activateHandler?.()

    expect(createMainWindowMock).toHaveBeenCalledTimes(1)
    expect(initScreenshotManagerMock).toHaveBeenCalledTimes(1)
    expect(startQAppWatcherMock).toHaveBeenCalledTimes(1)
    expect(initScreenshotManagerMock).toHaveBeenCalledWith(initialWindow)
    expect(startQAppWatcherMock).toHaveBeenCalledWith(initialWindow)
  })

  it('creates window with automated startup mode', async () => {
    getAppStartupTestWindowPolicyMock.mockReturnValue({
      automatedRun: true,
      windowMode: 'offscreen'
    })
    const automatedWindow = { id: 'automated-window' }
    createMainWindowMock.mockReset()
    createMainWindowMock.mockReturnValue(automatedWindow)

    await loadModule()

    expect(createMainWindowMock).toHaveBeenCalledTimes(1)
    expect(initScreenshotManagerMock).toHaveBeenCalledWith(automatedWindow)
    expect(startQAppWatcherMock).toHaveBeenCalledWith(automatedWindow)
  })

  it('does not intercept quit when an update install is in progress', async () => {
    isAppUpdateInstallInProgressMock.mockReturnValue(true)
    await loadModule()

    const beforeQuitHandler = appMock.on.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    const event = { preventDefault: vi.fn() }

    expect(beforeQuitHandler).toBeTypeOf('function')
    await beforeQuitHandler?.(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(beforeQuitMock).not.toHaveBeenCalled()
    expect(cleanupScreenshotManagerMock).toHaveBeenCalled()
    expect(stopQAppWatcherMock).toHaveBeenCalled()
  })
})
