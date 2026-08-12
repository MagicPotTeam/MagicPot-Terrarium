import path from 'node:path'
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
  isAppUpdateInstallInProgressMock,
  startLauncherSmokeTestMock,
  confirmLauncherHealthMock,
  flushLocalMediaAccessGrantsMock,
  registerLocalMediaFileIntakeIpcMock,
  cleanupSubProcessesMock
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
      path: path.resolve('test-user-data'),
      source: 'default' as const
    })),
    initializeAppUpdateManagerMock: vi.fn(() => Promise.resolve()),
    isAppUpdateInstallInProgressMock: vi.fn(() => false),
    startLauncherSmokeTestMock: vi.fn(() => false),
    confirmLauncherHealthMock: vi.fn(() => Promise.resolve(false)),
    flushLocalMediaAccessGrantsMock: vi.fn(),
    registerLocalMediaFileIntakeIpcMock: vi.fn(),
    cleanupSubProcessesMock: vi.fn(() => Promise.resolve())
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

vi.mock('./localMediaAccess', () => ({
  flushLocalMediaAccessGrants: flushLocalMediaAccessGrantsMock
}))
vi.mock('./localMediaFileIntakeIpc', () => ({
  registerLocalMediaFileIntakeIpc: registerLocalMediaFileIntakeIpcMock
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

vi.mock('./appUpdate/appLauncherBridge', () => ({
  startLauncherSmokeTest: startLauncherSmokeTestMock,
  confirmLauncherHealth: confirmLauncherHealthMock
}))

vi.mock('./appUpdate/updateManager', () => ({
  initializeAppUpdateManager: initializeAppUpdateManagerMock,
  isAppUpdateInstallInProgress: isAppUpdateInstallInProgressMock
}))

vi.mock('./subprocess/subprocess', () => ({
  cleanupSubProcesses: cleanupSubProcessesMock
}))

vi.mock('./utils/loggingOverride', () => ({}))

function createWindow(id: string) {
  const windowListeners = new Map<string, (...args: unknown[]) => void>()
  const webListeners = new Map<string, (...args: unknown[]) => void>()
  return {
    id,
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      windowListeners.set(event, handler)
    }),
    removeListener: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents: {
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        webListeners.set(event, handler)
      }),
      removeListener: vi.fn()
    },
    emitWindow: (event: string, ...args: unknown[]) => windowListeners.get(event)?.(...args),
    emitWeb: (event: string, ...args: unknown[]) => webListeners.get(event)?.(...args)
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await Promise.resolve()
}

async function loadModule() {
  vi.resetModules()
  await import('./index')
  await Promise.resolve()
  await Promise.resolve()
}

describe('main process startup window opening', () => {
  beforeEach(async () => {
    await settle()
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
    flushLocalMediaAccessGrantsMock.mockClear()
    registerLocalMediaFileIntakeIpcMock.mockClear()
    startQAppWatcherMock.mockClear()
    stopQAppWatcherMock.mockClear()
    initScreenshotManagerMock.mockClear()
    cleanupScreenshotManagerMock.mockClear()
    initializeAppUpdateManagerMock.mockClear()
    isAppUpdateInstallInProgressMock.mockReset().mockReturnValue(false)
    startLauncherSmokeTestMock.mockReset().mockReturnValue(false)
    confirmLauncherHealthMock.mockReset().mockResolvedValue(false)
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
      path: path.resolve('test-user-data'),
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

    expect(registerLocalMediaFileIntakeIpcMock).toHaveBeenCalledTimes(1)
    const getRegisteredMainWindow = registerLocalMediaFileIntakeIpcMock.mock.calls[0]?.[0]
    expect(getRegisteredMainWindow()).toBe(fallbackWindow)

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
      (() => void) | undefined

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
      (() => void) | undefined

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

  it('confirms launcher health only after renderer readiness, services, and a stable event turn', async () => {
    const window = createWindow('healthy-window')
    let finishUpdateInitialization = (): void => undefined
    initializeAppUpdateManagerMock.mockReturnValue(
      new Promise<void>((resolve) => {
        finishUpdateInitialization = resolve
      })
    )
    createMainWindowMock.mockReset().mockReturnValue(window)

    await loadModule()
    expect(confirmLauncherHealthMock).not.toHaveBeenCalled()

    window.emitWeb('did-finish-load')
    await Promise.resolve()
    expect(confirmLauncherHealthMock).not.toHaveBeenCalled()

    finishUpdateInitialization()
    await Promise.resolve()
    expect(confirmLauncherHealthMock).not.toHaveBeenCalled()

    await settle()
    await settle()
    expect(confirmLauncherHealthMock).toHaveBeenCalledTimes(1)
  })

  it('confirms health when readiness fires before createMainWindow returns', async () => {
    const window = createWindow('synchronously-ready-window')
    createMainWindowMock
      .mockReset()
      .mockImplementation((onCreated?: (created: unknown) => void) => {
        onCreated?.(window)
        window.emitWeb('did-finish-load')
        return window
      })

    await loadModule()
    await settle()
    await settle()

    expect(confirmLauncherHealthMock).toHaveBeenCalledTimes(1)
  })

  it('does not confirm launcher health when failure fires before createMainWindow returns', async () => {
    const window = createWindow('synchronously-failed-window')
    createMainWindowMock
      .mockReset()
      .mockImplementation((onCreated?: (created: unknown) => void) => {
        onCreated?.(window)
        window.emitWeb('did-fail-load', {}, -1, 'failed', 'file:///index.html', true)
        window.emitWeb('did-finish-load')
        return window
      })

    await loadModule()
    await settle()

    expect(confirmLauncherHealthMock).not.toHaveBeenCalled()
  })

  it('does not confirm launcher health when the renderer crashes during startup', async () => {
    const window = createWindow('crashed-window')
    createMainWindowMock.mockReset().mockReturnValue(window)

    await loadModule()
    window.emitWeb('render-process-gone')
    window.emitWindow('ready-to-show')
    await settle()

    expect(confirmLauncherHealthMock).not.toHaveBeenCalled()
  })

  it('waits for update cleanup once before allowing the final quit', async () => {
    isAppUpdateInstallInProgressMock.mockReturnValue(true)
    let finishCleanup: (() => void) | undefined
    cleanupSubProcessesMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishCleanup = resolve))
    )
    await loadModule()

    const beforeQuitHandler = appMock.on.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    const firstEvent = { preventDefault: vi.fn() }
    const repeatedEvent = { preventDefault: vi.fn() }

    const firstQuit = beforeQuitHandler?.(firstEvent)
    const repeatedQuit = beforeQuitHandler?.(repeatedEvent)

    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(repeatedEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(cleanupSubProcessesMock).toHaveBeenCalledTimes(1)
    expect(appMock.quit).not.toHaveBeenCalled()

    finishCleanup?.()
    await firstQuit
    await repeatedQuit

    expect(appMock.quit).toHaveBeenCalledTimes(1)
    const finalEvent = { preventDefault: vi.fn() }
    await beforeQuitHandler?.(finalEvent)
    expect(finalEvent.preventDefault).not.toHaveBeenCalled()
    expect(cleanupSubProcessesMock).toHaveBeenCalledTimes(1)
  })

  it('intercepts update quit until subprocess cleanup completes', async () => {
    isAppUpdateInstallInProgressMock.mockReturnValue(true)
    await loadModule()

    const beforeQuitHandler = appMock.on.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as ((event: { preventDefault: () => void }) => Promise<void>) | undefined
    const event = { preventDefault: vi.fn() }

    expect(beforeQuitHandler).toBeTypeOf('function')
    await beforeQuitHandler?.(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(flushLocalMediaAccessGrantsMock).toHaveBeenCalledTimes(1)
    expect(beforeQuitMock).not.toHaveBeenCalled()
    expect(cleanupSubProcessesMock).toHaveBeenCalledTimes(1)
    expect(appMock.quit).toHaveBeenCalledTimes(1)
    expect(cleanupScreenshotManagerMock).toHaveBeenCalled()
    expect(stopQAppWatcherMock).toHaveBeenCalled()
  })
})
