import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachRendererDiagnostics,
  handleRendererProcessGone,
  shouldRecoverRendererProcess
} from './rendererDiagnostics'

type RendererGoneDetails = {
  exitCode: number
  reason:
    | 'clean-exit'
    | 'abnormal-exit'
    | 'killed'
    | 'crashed'
    | 'oom'
    | 'launch-failed'
    | 'integrity-failure'
    | 'memory-eviction'
}

type TestWindow = {
  isDestroyed: ReturnType<typeof vi.fn>
  webContents: {
    isDestroyed: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
  }
}

function createWindow(): TestWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      reload: vi.fn()
    }
  }
}

describe('rendererDiagnostics render-process-gone recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks OOM and crash exits as recoverable', () => {
    expect(shouldRecoverRendererProcess({ reason: 'oom', exitCode: 0 })).toBe(true)
    expect(shouldRecoverRendererProcess({ reason: 'crashed', exitCode: 1 })).toBe(true)
    expect(shouldRecoverRendererProcess({ reason: 'killed', exitCode: 9 })).toBe(false)
    expect(shouldRecoverRendererProcess({ reason: 'clean-exit', exitCode: 0 })).toBe(false)
  })

  it('logs root-cause details before invoking the recovery path for OOM exits', () => {
    const window = createWindow()
    const details: RendererGoneDetails = { reason: 'oom', exitCode: 137 }
    const recoverRenderer = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    handleRendererProcessGone(window as never, details as never, { recoverRenderer })

    expect(errorSpy).toHaveBeenCalledWith('[App] Renderer process gone', details)
    expect(recoverRenderer).toHaveBeenCalledWith(window, details)
    expect(errorSpy.mock.invocationCallOrder[0]).toBeLessThan(
      recoverRenderer.mock.invocationCallOrder[0]
    )
  })

  it('uses guarded window reload recovery for crash exits', () => {
    const window = createWindow()
    const details: RendererGoneDetails = { reason: 'crashed', exitCode: 1 }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    handleRendererProcessGone(window as never, details as never)

    expect(warnSpy).toHaveBeenCalledWith(
      '[App] Renderer exited unexpectedly; reloading the window to recover',
      {
        reason: 'crashed',
        exitCode: 1
      }
    )
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('does not recover non-crash renderer exits', () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    handleRendererProcessGone(
      window as never,
      { reason: 'memory-eviction', exitCode: 0 } as never,
      { recoverRenderer }
    )

    expect(recoverRenderer).not.toHaveBeenCalled()
    expect(window.webContents.reload).not.toHaveBeenCalled()
  })

  it('wires render-process-gone events through the recovery handler options', () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    const details: RendererGoneDetails = { reason: 'oom', exitCode: 137 }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    attachRendererDiagnostics(window as never, { recoverRenderer })

    const rendererGoneListener = window.webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone'
    )?.[1]

    expect(rendererGoneListener).toBeTypeOf('function')
    rendererGoneListener?.({}, details)

    expect(recoverRenderer).toHaveBeenCalledWith(window, details)
  })
})
