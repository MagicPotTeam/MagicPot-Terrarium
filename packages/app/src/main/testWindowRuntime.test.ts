import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockDisplay = {
  id: number
  workArea: {
    x: number
    y: number
    width: number
    height: number
  }
}

let displays: MockDisplay[] = [
  {
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }
  }
]

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  screen: {
    getAllDisplays: vi.fn(() => displays),
    getPrimaryDisplay: vi.fn(() => displays[0])
  }
}))

const ORIGINAL_ENV = {
  MAGICPOT_TEST_AUTOMATED_RUN: process.env['MAGICPOT_TEST_AUTOMATED_RUN'],
  MAGICPOT_TEST_UI_MODE: process.env['MAGICPOT_TEST_UI_MODE'],
  MAGICPOT_TEST_WINDOW_MODE: process.env['MAGICPOT_TEST_WINDOW_MODE'],
  MAGICPOT_TEST_NO_FOCUS: process.env['MAGICPOT_TEST_NO_FOCUS'],
  RUN_ELECTRON_STARTUP_SMOKE: process.env['RUN_ELECTRON_STARTUP_SMOKE']
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

function createMockWindow(options?: {
  bounds?: { x: number; y: number; width: number; height: number }
  focused?: boolean
  showInactiveThrows?: boolean
}): MockWindow {
  let focused = options?.focused ?? true
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

async function importRuntimeModule() {
  vi.resetModules()
  return import('./testWindowRuntime')
}

afterEach(() => {
  vi.useRealTimers()
  displays = [
    {
      id: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    }
  ]

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
})

beforeEach(() => {
  vi.useFakeTimers()
})

describe('testWindowRuntime', () => {
  it('hides windows immediately when hidden mode is active', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_UI_MODE'] = 'hidden'
    delete process.env['MAGICPOT_TEST_WINDOW_MODE']
    delete process.env['RUN_ELECTRON_STARTUP_SMOKE']

    const { showWindowForTestPolicy } = await importRuntimeModule()
    const window = createMockWindow()

    showWindowForTestPolicy(window as never)

    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
  })

  it('shows inactive windows and enforces no-focus and taskbar suppression during automated runs', async () => {
    displays = [
      {
        id: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 }
      },
      {
        id: 2,
        workArea: { x: 1920, y: 0, width: 2560, height: 1440 }
      }
    ]

    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_UI_MODE'] = 'secondary-or-offscreen'
    process.env['MAGICPOT_TEST_NO_FOCUS'] = '1'
    delete process.env['MAGICPOT_TEST_WINDOW_MODE']
    delete process.env['RUN_ELECTRON_STARTUP_SMOKE']

    const { readAppliedTestWindowSkipTaskbarState, showWindowForTestPolicy } =
      await importRuntimeModule()
    const window = createMockWindow({
      bounds: { x: 2200, y: 120, width: 1200, height: 800 },
      focused: true
    })

    showWindowForTestPolicy(window as never)

    expect(window.setBounds).toHaveBeenCalledWith({
      x: 2600,
      y: 320,
      width: 1200,
      height: 800
    })
    expect(window.showInactive).toHaveBeenCalledTimes(1)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.setFocusable).toHaveBeenCalledWith(false)
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true)
    expect(readAppliedTestWindowSkipTaskbarState(window as never)).toBe(true)

    vi.runAllTimers()

    expect(window.blur).toHaveBeenCalledTimes(1)
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('stays hidden when showInactive is unavailable during automated runs', async () => {
    displays = [
      {
        id: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 }
      },
      {
        id: 2,
        workArea: { x: 1920, y: 0, width: 2560, height: 1440 }
      }
    ]

    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_UI_MODE'] = 'secondary-or-offscreen'
    process.env['MAGICPOT_TEST_NO_FOCUS'] = '1'
    delete process.env['MAGICPOT_TEST_WINDOW_MODE']
    delete process.env['RUN_ELECTRON_STARTUP_SMOKE']

    const { showWindowForTestPolicy } = await importRuntimeModule()
    const window = createMockWindow({
      bounds: { x: 2200, y: 120, width: 1200, height: 800 },
      focused: false,
      showInactiveThrows: true
    })

    showWindowForTestPolicy(window as never)

    expect(window.showInactive).toHaveBeenCalledTimes(1)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(window.setFocusable).toHaveBeenCalledWith(false)
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true)
  })

  it('moves automated windows off-screen before showing them even when they start on the primary display', async () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_UI_MODE'] = 'secondary-or-offscreen'
    process.env['MAGICPOT_TEST_NO_FOCUS'] = '1'
    delete process.env['MAGICPOT_TEST_WINDOW_MODE']
    delete process.env['RUN_ELECTRON_STARTUP_SMOKE']

    const { showWindowForTestPolicy } = await importRuntimeModule()
    const window = createMockWindow({
      bounds: { x: 100, y: 100, width: 1200, height: 800 },
      focused: false
    })

    showWindowForTestPolicy(window as never)

    expect(window.setBounds).toHaveBeenCalledWith({
      x: 2040,
      y: 120,
      width: 1200,
      height: 800
    })
    expect(window.showInactive).toHaveBeenCalledTimes(1)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })
})
