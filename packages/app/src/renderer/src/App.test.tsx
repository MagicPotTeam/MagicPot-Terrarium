import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'

const appTestState = vi.hoisted(() => ({
  buildMode: 'embedded' as 'embedded' | 'pure',
  embeddedDefaults: {
    comfyuiDir: 'C:/MagicPot/comfy/ComfyUI',
    pythonCmd: 'C:/MagicPot/comfy/python.exe',
    comfyuiArgs: ['--listen'] as string[]
  },
  commandAvailable: true,
  autoStartComfyPortDetect: vi.fn(),
  startComfyUI: vi.fn(),
  setPid: vi.fn(),
  setIsRunning: vi.fn(),
  setIsManaged: vi.fn()
}))

const bridgeMounts = vi.hoisted(() => ({
  comfyExecutionActivityBridge: 0,
  comfyLogBridge: 0,
  managedComfyProcessBridge: 0,
  autoStartComfyPortDetect: appTestState.autoStartComfyPortDetect,
  startComfyUI: appTestState.startComfyUI,
  setPid: appTestState.setPid,
  setIsRunning: appTestState.setIsRunning,
  setIsManaged: appTestState.setIsManaged,
  connectWs: vi.fn()
}))

vi.mock('./components/CanvasProjectDropBridge', () => ({
  default: () => null
}))

vi.mock('./components/Layout', () => ({
  default: () => <div data-testid="app-shell">App shell</div>
}))

vi.mock('./utils/dndManager', () => ({
  getAppDndManager: () => ({})
}))

vi.mock('react-dnd', () => ({
  DndProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('react-router-dom', () => ({
  HashRouter: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('./hooks/useComfyEvent', () => ({
  useComfyEventCallback: () => {
    bridgeMounts.comfyExecutionActivityBridge += 1
    bridgeMounts.connectWs()
  }
}))

vi.mock('./components/ComfyLogBridge', () => ({
  default: () => {
    bridgeMounts.comfyLogBridge += 1
    return null
  }
}))

vi.mock('./components/ManagedComfyProcessBridge', () => ({
  default: () => {
    bridgeMounts.managedComfyProcessBridge += 1
    return null
  }
}))

vi.mock('./hooks/useConfig', () => ({
  useConfig: () => ({
    isReady: true,
    config: { use_remote_comfyui: false },
    buildEnv: {
      env: { buildMode: appTestState.buildMode },
      embeddedDefaults: appTestState.embeddedDefaults
    },
    configUtils: {
      isComfyUICommandAvailable: () => appTestState.commandAvailable
    }
  })
}))

vi.mock('./store/hooks/comfyProcess', () => ({
  useComfyProcess: () => ({
    state: {
      isRunning: false,
      isManaged: false
    },
    setPid: bridgeMounts.setPid,
    setIsRunning: bridgeMounts.setIsRunning,
    setIsManaged: bridgeMounts.setIsManaged,
    addOutput: vi.fn()
  })
}))

vi.mock('./utils/windowUtils', () => ({
  api: () => ({
    svcHyper: {
      comfyPortDetect: bridgeMounts.autoStartComfyPortDetect,
      startComfyUI: bridgeMounts.startComfyUI
    }
  })
}))

describe('App startup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    bridgeMounts.comfyExecutionActivityBridge = 0
    bridgeMounts.comfyLogBridge = 0
    bridgeMounts.managedComfyProcessBridge = 0
    appTestState.buildMode = 'embedded'
    appTestState.embeddedDefaults = {
      comfyuiDir: 'C:/MagicPot/comfy/ComfyUI',
      pythonCmd: 'C:/MagicPot/comfy/python.exe',
      comfyuiArgs: ['--listen']
    }
    appTestState.commandAvailable = true
    bridgeMounts.autoStartComfyPortDetect.mockReset().mockResolvedValue({ pid: 123 })
    bridgeMounts.startComfyUI.mockReset()
    bridgeMounts.setPid.mockReset()
    bridgeMounts.setIsRunning.mockReset()
    bridgeMounts.setIsManaged.mockReset()
    bridgeMounts.connectWs.mockReset()
    Reflect.deleteProperty(window, 'requestIdleCallback')
    Reflect.deleteProperty(window, 'cancelIdleCallback')
  })

  it('renders the app shell before mounting nonessential Comfy startup bridges', async () => {
    render(<App />)

    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
    expect(bridgeMounts.comfyExecutionActivityBridge).toBe(0)
    expect(bridgeMounts.comfyLogBridge).toBe(0)
    expect(bridgeMounts.managedComfyProcessBridge).toBe(0)
    expect(bridgeMounts.autoStartComfyPortDetect).not.toHaveBeenCalled()
    expect(bridgeMounts.connectWs).not.toHaveBeenCalled()

    await act(async () => {
      vi.runOnlyPendingTimers()
    })

    expect(bridgeMounts.comfyExecutionActivityBridge).toBe(1)
    expect(bridgeMounts.comfyLogBridge).toBe(1)
    expect(bridgeMounts.managedComfyProcessBridge).toBe(1)
    expect(bridgeMounts.autoStartComfyPortDetect).toHaveBeenCalledTimes(1)
  })

  it('uses requestIdleCallback when available before starting Comfy bridge work', async () => {
    let idleCallback: (() => void) | undefined
    const requestIdleCallback = vi.fn((callback: () => void) => {
      idleCallback = callback
      return 1
    })
    const cancelIdleCallback = vi.fn()
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: requestIdleCallback
    })
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      value: cancelIdleCallback
    })

    render(<App />)

    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
    expect(requestIdleCallback).toHaveBeenCalledTimes(1)
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1500 })
    expect(bridgeMounts.comfyLogBridge).toBe(0)

    await act(async () => {
      idleCallback?.()
    })

    expect(bridgeMounts.comfyExecutionActivityBridge).toBe(1)
    expect(bridgeMounts.comfyLogBridge).toBe(1)
    expect(bridgeMounts.managedComfyProcessBridge).toBe(1)
    expect(bridgeMounts.autoStartComfyPortDetect).toHaveBeenCalledTimes(1)
    expect(cancelIdleCallback).not.toHaveBeenCalled()
  })

  it('does not auto-start ComfyUI in Pure builds', async () => {
    appTestState.buildMode = 'pure'
    render(<App />)

    await act(async () => {
      vi.runOnlyPendingTimers()
    })

    expect(bridgeMounts.managedComfyProcessBridge).toBe(1)
    expect(bridgeMounts.autoStartComfyPortDetect).not.toHaveBeenCalled()
    expect(bridgeMounts.startComfyUI).not.toHaveBeenCalled()
  })

  it('does not auto-start when the Embedded runtime is unavailable', async () => {
    appTestState.embeddedDefaults = { comfyuiDir: '', pythonCmd: '', comfyuiArgs: [] }
    render(<App />)

    await act(async () => {
      vi.runOnlyPendingTimers()
    })

    expect(bridgeMounts.managedComfyProcessBridge).toBe(1)
    expect(bridgeMounts.autoStartComfyPortDetect).not.toHaveBeenCalled()
    expect(bridgeMounts.startComfyUI).not.toHaveBeenCalled()
  })

  it('mounts Comfy bridge work after a bounded timeout when idle callback does not fire', async () => {
    const requestIdleCallback = vi.fn(() => 7)
    const cancelIdleCallback = vi.fn()
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: requestIdleCallback
    })
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      value: cancelIdleCallback
    })

    render(<App />)

    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
    expect(bridgeMounts.comfyLogBridge).toBe(0)

    await act(async () => {
      vi.advanceTimersByTime(1499)
    })
    expect(bridgeMounts.comfyLogBridge).toBe(0)

    await act(async () => {
      vi.advanceTimersByTime(1)
    })

    expect(cancelIdleCallback).toHaveBeenCalledWith(7)
    expect(bridgeMounts.comfyExecutionActivityBridge).toBe(1)
    expect(bridgeMounts.comfyLogBridge).toBe(1)
    expect(bridgeMounts.managedComfyProcessBridge).toBe(1)
    expect(bridgeMounts.autoStartComfyPortDetect).toHaveBeenCalledTimes(1)
  })
})
