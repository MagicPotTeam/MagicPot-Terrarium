import { afterEach, describe, expect, it, vi } from 'vitest'
import { dialog } from 'electron'

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }))

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
  on: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  webContents: {
    isDestroyed: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    executeJavaScript: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
  }
}

function createWindow(): TestWindow {
  return {
    on: vi.fn(),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue(false),
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

  it('does not mistake an unresponsive event for a crash or reload a live window', () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    attachRendererDiagnostics(window as never, { recoverRenderer })
    const listener = window.webContents.on.mock.calls.find(
      ([event]) => event === 'unresponsive'
    )?.[1]
    expect(listener).toBeTypeOf('function')
    listener()
    expect(recoverRenderer).not.toHaveBeenCalled()
    expect(window.webContents.reload).not.toHaveBeenCalled()
  })

  it('limits automatic recovery to three attempts per minute and shows only one prompt while pending', async () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    let resolvePrompt!: (result: { response: number; checkboxChecked: boolean }) => void
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePrompt = resolve
          })
      )
    let now = 1000
    attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => now })
    const listener = (name: string) =>
      window.webContents.on.mock.calls.find(([event]) => event === name)?.[1]
    const details: RendererGoneDetails = { reason: 'oom', exitCode: 137 }
    listener('render-process-gone')({}, details)
    listener('did-start-loading')()
    listener('did-finish-load')()
    now += 100
    listener('render-process-gone')({}, details)
    listener('render-process-gone')({}, details)
    listener('render-process-gone')({}, details)
    listener('render-process-gone')({}, details)
    expect(recoverRenderer).toHaveBeenCalledTimes(3)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(
      errorSpy.mock.calls.filter(([message]) => message === '[App] Renderer process gone')
    ).toHaveLength(5)
    expect(errorSpy).toHaveBeenCalledWith('[App] Renderer process gone', details)
    resolvePrompt({ response: 1, checkboxChecked: false })
    await Promise.resolve()
    await Promise.resolve()
    expect(recoverRenderer).toHaveBeenCalledTimes(3)
  })

  it('expires attempts after a full minute and does not let a backward clock grant extra attempts', async () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockResolvedValue({ response: 1, checkboxChecked: false })
    let now = 10_000
    attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => now })
    const listener = window.webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone'
    )?.[1]
    const details: RendererGoneDetails = { reason: 'crashed', exitCode: 7 }
    listener({}, details)
    now = 9000
    listener({}, details)
    listener({}, details)
    listener({}, details)
    expect(recoverRenderer).toHaveBeenCalledTimes(3)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    now = 69_999
    listener({}, details)
    expect(recoverRenderer).toHaveBeenCalledTimes(3)
    await Promise.resolve()
    await Promise.resolve()
    now = 70_000
    listener({}, details)
    expect(recoverRenderer).toHaveBeenCalledTimes(4)
  })

  it.each(['alive', 'window-destroyed', 'webcontents-destroyed'] as const)(
    'only honors manual reload while the owner is alive: %s',
    async (state) => {
      const window = createWindow()
      const recoverRenderer = vi.fn()
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      let resolvePrompt!: (result: { response: number; checkboxChecked: boolean }) => void
      vi.mocked(dialog.showMessageBox)
        .mockReset()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolvePrompt = resolve
            })
        )
      attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => 1000 })
      const listener = window.webContents.on.mock.calls.find(
        ([event]) => event === 'render-process-gone'
      )?.[1]
      const details: RendererGoneDetails = { reason: 'oom', exitCode: 137 }
      for (let index = 0; index < 4; index += 1) listener({}, details)
      expect(recoverRenderer).toHaveBeenCalledTimes(3)
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
      if (state === 'window-destroyed') window.isDestroyed.mockReturnValue(true)
      if (state === 'webcontents-destroyed') window.webContents.isDestroyed.mockReturnValue(true)
      resolvePrompt({ response: 0, checkboxChecked: false })
      await Promise.resolve()
      await Promise.resolve()
      expect(recoverRenderer).toHaveBeenCalledTimes(state === 'alive' ? 4 : 3)
    }
  )

  it('does not spend the recoverable-crash budget for unrelated exit reasons', () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox).mockReset()
    attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => 1000 })
    const listener = window.webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone'
    )?.[1]
    for (let index = 0; index < 10; index += 1) listener({}, { reason: 'killed', exitCode: 9 })
    for (let index = 0; index < 3; index += 1) listener({}, { reason: 'crashed', exitCode: 1 })
    expect(recoverRenderer).toHaveBeenCalledTimes(3)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('does not automatically reload while manual recovery is pending even if the window expires', async () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let resolvePrompt!: (result: { response: number; checkboxChecked: boolean }) => void
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePrompt = resolve
          })
      )
    let now = 1000
    attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => now })
    const listener = window.webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone'
    )?.[1]
    const details: RendererGoneDetails = { reason: 'crashed', exitCode: 7 }
    for (let index = 0; index < 4; index += 1) listener({}, details)
    expect(recoverRenderer).toHaveBeenCalledTimes(3)
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ buttons: ['重新加载', '取消'], defaultId: 1, cancelId: 1 })
    )
    now = 61_000
    listener({}, details)
    expect(recoverRenderer).toHaveBeenCalledTimes(3)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    resolvePrompt({ response: 1, checkboxChecked: false })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    listener({}, details)
    expect(recoverRenderer).toHaveBeenCalledTimes(4)
  })

  it('handles a native prompt rejection and preserves the existing recovery cap', async () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockRejectedValueOnce(new Error('native dialog failed'))
      .mockResolvedValue({ response: 1, checkboxChecked: false })
    attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => 1000 })
    const listener = window.webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone'
    )?.[1]
    const details: RendererGoneDetails = { reason: 'oom', exitCode: 137 }
    for (let index = 0; index < 4; index += 1) listener({}, details)
    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[App] Failed to show renderer recovery prompt')
    )
    await Promise.resolve()
    await Promise.resolve()
    listener({}, details)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(recoverRenderer).toHaveBeenCalledTimes(3)
  })

  it('maintains independent attempt budgets per window', () => {
    const first = createWindow()
    const second = createWindow()
    const recoverRenderer = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockResolvedValue({ response: 1, checkboxChecked: false })
    attachRendererDiagnostics(first as never, { recoverRenderer, monotonicNow: () => 1000 })
    attachRendererDiagnostics(second as never, { recoverRenderer, monotonicNow: () => 1000 })
    const firstGone = first.webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone'
    )?.[1]
    const secondGone = second.webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone'
    )?.[1]
    const details: RendererGoneDetails = { reason: 'oom', exitCode: 137 }
    for (let index = 0; index < 4; index += 1) firstGone({}, details)
    secondGone({}, details)
    expect(recoverRenderer.mock.calls.filter(([owner]) => owner === first)).toHaveLength(3)
    expect(recoverRenderer.mock.calls.filter(([owner]) => owner === second)).toHaveLength(1)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('keeps renderer console severity, source shortening and truncation', () => {
    const window = createWindow()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    attachRendererDiagnostics(window as never)
    const listener = window.webContents.on.mock.calls.find(
      ([event]) => event === 'console-message'
    )?.[1]
    listener({}, 3, 'x'.repeat(2001), 9, 'file:///private/path/index.js')
    expect(error).toHaveBeenCalledWith(
      `[Renderer] ${'x'.repeat(2000)}… [truncated 1 chars] (index.js:9)`
    )
  })

  it('does not recursively forward renderer diagnostic console echoes', () => {
    const window = createWindow()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    attachRendererDiagnostics(window as never)

    const consoleListener = window.webContents.on.mock.calls.find(
      ([event]) => event === 'console-message'
    )?.[1]

    expect(consoleListener).toBeTypeOf('function')
    consoleListener?.({}, 3, '[Renderer] echoed diagnostic line', 123, 'index.js')
    consoleListener?.({}, 3, '13:34:44.770 › [Renderer] timestamp-prefixed echo', 124, 'index.js')

    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('[Renderer] echoed'))
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[Renderer] echoed'))
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('[Renderer] echoed'))
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('timestamp-prefixed echo'))
  })
})
