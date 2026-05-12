import { win32 as pathWin32 } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockDisplay = {
  id: number
  workArea: {
    x: number
    y: number
    width: number
    height: number
  }
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
  size: {
    width: number
    height: number
  }
  scaleFactor: number
}

type MockWindow = {
  isDestroyed: ReturnType<typeof vi.fn>
  getBounds: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  setFocusable: ReturnType<typeof vi.fn>
  setSkipTaskbar: ReturnType<typeof vi.fn>
  isFocused: ReturnType<typeof vi.fn>
  blur: ReturnType<typeof vi.fn>
}

let displays: MockDisplay[] = [
  {
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1
  }
]

const appMock = {
  getPath: vi.fn((name: string) => {
    if (name === 'desktop') {
      return 'C:/Users/test/Desktop'
    }
    if (name === 'temp') {
      return 'C:/Temp'
    }
    throw new Error(`Unexpected app.getPath(${name})`)
  })
}

vi.mock('electron', () => ({
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn()
  },
  desktopCapturer: {
    getSources: vi.fn()
  },
  screen: {
    getAllDisplays: vi.fn(() => displays),
    getPrimaryDisplay: vi.fn(() => displays[0]),
    getCursorScreenPoint: vi.fn(() => ({ x: 320, y: 240 }))
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn()
  },
  nativeImage: {},
  app: appMock
}))

const ORIGINAL_ENV = {
  MAGICPOT_TEST_AUTOMATED_RUN: process.env['MAGICPOT_TEST_AUTOMATED_RUN'],
  MAGICPOT_TEST_DESKTOP_PATH: process.env['MAGICPOT_TEST_DESKTOP_PATH'],
  MAGICPOT_TEST_UI_MODE: process.env['MAGICPOT_TEST_UI_MODE'],
  MAGICPOT_TEST_WINDOW_MODE: process.env['MAGICPOT_TEST_WINDOW_MODE'],
  MAGICPOT_TEST_NO_FOCUS: process.env['MAGICPOT_TEST_NO_FOCUS'],
  RUN_ELECTRON_STARTUP_SMOKE: process.env['RUN_ELECTRON_STARTUP_SMOKE']
}

async function loadModule() {
  vi.resetModules()
  return import('./screenshotManager')
}

function createMockWindow(options?: {
  bounds?: { x: number; y: number; width: number; height: number }
  focused?: boolean
  showInactiveThrows?: boolean
}): MockWindow {
  let focused = options?.focused ?? false
  let bounds = options?.bounds ?? { x: 0, y: 0, width: 1200, height: 800 }

  return {
    isDestroyed: vi.fn(() => false),
    getBounds: vi.fn(() => bounds),
    setBounds: vi.fn((nextBounds: { x: number; y: number; width: number; height: number }) => {
      bounds = nextBounds
    }),
    hide: vi.fn(),
    showInactive: vi.fn(() => {
      if (options?.showInactiveThrows) {
        throw new Error('showInactive unavailable')
      }
    }),
    show: vi.fn(),
    setFocusable: vi.fn(),
    setSkipTaskbar: vi.fn(),
    isFocused: vi.fn(() => focused),
    blur: vi.fn(() => {
      focused = false
    })
  }
}

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()

  displays = [
    {
      id: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      size: { width: 1920, height: 1080 },
      scaleFactor: 1
    }
  ]

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }

  appMock.getPath.mockClear()
  vi.clearAllMocks()
})

beforeEach(() => {
  vi.useFakeTimers()
})

describe('resolveScreenshotTempDir', () => {
  it('uses desktop Codex-Junk/MagicPot/<run-id> during automated test runs', async () => {
    const { resolveScreenshotTempDir } = await loadModule()

    expect(
      resolveScreenshotTempDir({
        desktopPath: 'C:/Users/test/Desktop',
        tempPath: 'C:/Temp',
        automatedTestRun: true,
        runId: 'run-123'
      })
    ).toBe(
      pathWin32.join('C:/Users/test/Desktop', 'Codex-Junk', 'MagicPot', 'run-123', 'screenshot')
    )
  })

  it('uses the system temp directory outside automated runs', async () => {
    const { resolveScreenshotTempDir } = await loadModule()

    expect(
      resolveScreenshotTempDir({
        desktopPath: 'C:/Users/test/Desktop',
        tempPath: 'C:/Temp',
        automatedTestRun: false
      })
    ).toBe(pathWin32.join('C:/Temp', 'screenshot'))
  })
})

describe('resolveAutomatedGuiWindowBounds', () => {
  it('prefers a secondary display for automated GUI windows when available', async () => {
    const { resolveAutomatedGuiWindowBounds } = await loadModule()

    expect(
      resolveAutomatedGuiWindowBounds({
        width: 1200,
        height: 800,
        displays: [
          { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
          { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }
        ],
        primaryDisplayId: 1,
        preferSecondaryDisplay: true,
        forceOffscreen: true
      })
    ).toEqual({
      x: 2600,
      y: 320,
      width: 1200,
      height: 800
    })
  })

  it('moves windows outside the union of all visible displays when forced offscreen', async () => {
    const { resolveAutomatedGuiWindowBounds } = await loadModule()

    expect(
      resolveAutomatedGuiWindowBounds({
        width: 800,
        height: 600,
        displays: [
          { id: 1, workArea: { x: -1600, y: 0, width: 1600, height: 900 } },
          { id: 2, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
        ],
        primaryDisplayId: 2,
        preferSecondaryDisplay: false,
        forceOffscreen: true
      })
    ).toEqual({
      x: 2040,
      y: 120,
      width: 800,
      height: 600
    })
  })

  it('returns null when no automation placement override is requested', async () => {
    const { resolveAutomatedGuiWindowBounds } = await loadModule()

    expect(
      resolveAutomatedGuiWindowBounds({
        width: 800,
        height: 600,
        displays,
        primaryDisplayId: 1,
        preferSecondaryDisplay: false,
        forceOffscreen: false
      })
    ).toBeNull()
  })
})

describe('showWindowNonIntrusively', () => {
  it('relocates automated screenshot windows to the secondary display before showing them', async () => {
    displays = [
      {
        id: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 1
      },
      {
        id: 2,
        workArea: { x: 1920, y: 0, width: 2560, height: 1440 },
        bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
        size: { width: 2560, height: 1440 },
        scaleFactor: 1
      }
    ]
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_UI_MODE'] = 'secondary-or-offscreen'
    process.env['MAGICPOT_TEST_NO_FOCUS'] = '1'

    const { showWindowNonIntrusively } = await loadModule()
    const window = createMockWindow({
      bounds: { x: 2200, y: 120, width: 1200, height: 800 }
    })

    showWindowNonIntrusively(window as never)

    expect(window.setBounds).toHaveBeenCalledWith({
      x: 2600,
      y: 320,
      width: 1200,
      height: 800
    })
    expect(window.showInactive).toHaveBeenCalledTimes(1)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('hides automated screenshot windows when showInactive is unavailable', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_UI_MODE'] = 'offscreen'
    process.env['MAGICPOT_TEST_NO_FOCUS'] = '1'

    const { showWindowNonIntrusively } = await loadModule()
    const window = createMockWindow({
      bounds: { x: 100, y: 100, width: 1200, height: 800 },
      showInactiveThrows: true
    })

    showWindowNonIntrusively(window as never)

    expect(window.setBounds).toHaveBeenCalledWith({
      x: 2040,
      y: 120,
      width: 1200,
      height: 800
    })
    expect(window.showInactive).toHaveBeenCalledTimes(1)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledTimes(1)
  })
})
