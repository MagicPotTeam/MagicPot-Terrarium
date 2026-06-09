import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  registerMock,
  unregisterMock,
  unregisterAllMock,
  ipcOnMock,
  ipcHandleMock,
  ipcOnHandlers,
  ipcHandleHandlers,
  screenMock,
  appMock,
  desktopCapturerGetSourcesMock,
  browserWindowCtorMock,
  existsSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  unlinkSyncMock
} = vi.hoisted(() => {
  const ipcOnHandlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcHandleHandlers = new Map<string, (...args: unknown[]) => unknown>()

  return {
    registerMock: vi.fn(() => true),
    unregisterMock: vi.fn(),
    unregisterAllMock: vi.fn(),
    ipcOnMock: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcOnHandlers.set(channel, handler)
    }),
    ipcHandleMock: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandleHandlers.set(channel, handler)
    }),
    ipcOnHandlers,
    ipcHandleHandlers,
    screenMock: {
      getPrimaryDisplay: vi.fn(() => ({
        id: 1,
        scaleFactor: 1,
        size: { width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workAreaSize: { width: 1920, height: 1080 }
      })),
      getAllDisplays: vi.fn(() => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
      getCursorScreenPoint: vi.fn(() => ({ x: 100, y: 100 }))
    },
    appMock: {
      getPath: vi.fn((name: string) => {
        if (name === 'desktop') return 'C:/Users/test/Desktop'
        if (name === 'temp') return 'C:/Temp'
        throw new Error(`Unexpected app.getPath(${name})`)
      })
    },
    desktopCapturerGetSourcesMock: vi.fn(),
    browserWindowCtorMock: vi.fn(),
    existsSyncMock: vi.fn(() => true),
    mkdirSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    unlinkSyncMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  globalShortcut: {
    register: registerMock,
    unregister: unregisterMock,
    unregisterAll: unregisterAllMock
  },
  desktopCapturer: {
    getSources: desktopCapturerGetSourcesMock
  },
  screen: screenMock,
  BrowserWindow: browserWindowCtorMock,
  ipcMain: {
    on: ipcOnMock,
    handle: ipcHandleMock
  },
  nativeImage: {
    createFromPath: vi.fn(),
    createFromDataURL: vi.fn()
  },
  app: appMock
}))

vi.mock('fs', () => ({
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
  existsSync: existsSyncMock,
  unlinkSync: unlinkSyncMock
}))

function createMainWindowStub() {
  return {
    isDestroyed: vi.fn(() => false),
    focus: vi.fn(),
    webContents: {
      send: vi.fn()
    }
  }
}

function createAuxiliaryWindowStub() {
  let destroyed = false
  const onceHandlers = new Map<string, () => void>()
  const onHandlers = new Map<string, () => void>()

  return {
    setAlwaysOnTop: vi.fn(),
    once: vi.fn((event: string, handler: () => void) => {
      onceHandlers.set(event, handler)
    }),
    loadFile: vi.fn(async () => {
      onceHandlers.get('ready-to-show')?.()
    }),
    on: vi.fn((event: string, handler: () => void) => {
      onHandlers.set(event, handler)
    }),
    close: vi.fn(() => {
      destroyed = true
      onHandlers.get('closed')?.()
    }),
    isDestroyed: vi.fn(() => destroyed),
    hide: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(),
    focus: vi.fn(),
    setFocusable: vi.fn(),
    setSkipTaskbar: vi.fn(),
    isFocused: vi.fn(() => false),
    blur: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 400, height: 300 }))
  }
}

function createCapturedImageStub(resultDataUrl = 'data:image/png;base64,cropped-image') {
  const croppedImage = {
    toDataURL: vi.fn(() => resultDataUrl)
  }

  return {
    toPNG: vi.fn(() => Buffer.from('png')),
    crop: vi.fn(() => croppedImage)
  }
}

describe('screenshotManager init idempotency', () => {
  beforeEach(() => {
    vi.resetModules()
    registerMock.mockClear()
    unregisterMock.mockClear()
    unregisterAllMock.mockClear()
    ipcOnMock.mockClear()
    ipcHandleMock.mockClear()
    ipcOnHandlers.clear()
    ipcHandleHandlers.clear()
    desktopCapturerGetSourcesMock.mockReset()
    browserWindowCtorMock.mockReset()
    browserWindowCtorMock.mockImplementation(function MockBrowserWindow() {
      return createAuxiliaryWindowStub()
    })
    existsSyncMock.mockClear()
    existsSyncMock.mockReturnValue(true)
    mkdirSyncMock.mockClear()
    writeFileSyncMock.mockClear()
    unlinkSyncMock.mockClear()
  })

  afterEach(async () => {
    const mod = await import('./screenshotManager')
    mod.cleanupScreenshotManager()
  })

  it('does not re-register IPC handlers when initialized twice for the same window', async () => {
    const mod = await import('./screenshotManager')
    const windowStub = createMainWindowStub()

    mod.initScreenshotManager(windowStub as never)
    mod.initScreenshotManager(windowStub as never)

    expect(ipcOnMock).toHaveBeenCalledTimes(5)
    expect(ipcHandleMock).toHaveBeenCalledTimes(3)
    expect(registerMock).toHaveBeenCalledTimes(2)
    expect(unregisterMock).toHaveBeenCalledTimes(1)
  })

  it('cleans up old registrations before binding to a replacement window', async () => {
    const mod = await import('./screenshotManager')

    mod.initScreenshotManager(createMainWindowStub() as never)
    mod.initScreenshotManager(createMainWindowStub() as never)

    expect(unregisterAllMock).toHaveBeenCalledTimes(1)
    expect(registerMock).toHaveBeenCalledTimes(2)
  })

  it('routes screenshot region events only to the replacement window after rebinding', async () => {
    const mod = await import('./screenshotManager')
    const firstWindow = createMainWindowStub()
    const secondWindow = createMainWindowStub()
    const capturedImage = createCapturedImageStub('data:image/png;base64,second-window-image')

    desktopCapturerGetSourcesMock.mockResolvedValue([{ thumbnail: capturedImage }])

    mod.initScreenshotManager(firstWindow as never)
    mod.initScreenshotManager(secondWindow as never)

    const captureHandler = ipcHandleHandlers.get('screenshot:capture')
    const regionHandler = ipcOnHandlers.get('screenshot:region')

    expect(captureHandler).toBeTypeOf('function')
    expect(regionHandler).toBeTypeOf('function')

    await captureHandler?.()
    await regionHandler?.({}, { x: 10, y: 20, w: 30, h: 40 })

    expect(firstWindow.webContents.send).not.toHaveBeenCalled()
    expect(secondWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(secondWindow.webContents.send).toHaveBeenCalledWith(
      'canvas:add-image',
      'data:image/png;base64,second-window-image'
    )
  })

  it('does not register extra IPC handlers when a capture is started', async () => {
    const mod = await import('./screenshotManager')
    const windowStub = createMainWindowStub()
    const capturedImage = createCapturedImageStub()

    desktopCapturerGetSourcesMock.mockResolvedValue([{ thumbnail: capturedImage }])

    mod.initScreenshotManager(windowStub as never)

    const captureHandler = ipcHandleHandlers.get('screenshot:capture')

    expect(captureHandler).toBeTypeOf('function')
    expect(ipcHandleMock).toHaveBeenCalledTimes(3)

    await captureHandler?.()

    expect(ipcHandleMock).toHaveBeenCalledTimes(3)
  })
})
