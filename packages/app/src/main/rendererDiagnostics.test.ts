import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dialog } from 'electron'

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }))

import { markAppQuitting, markSessionEnding, resetAppQuittingForTests } from './appQuitState'
import { resetExpectedRendererExitsForTests, takeExpectedRendererExit } from './expectedRendererExits'
import {
  attachRendererDiagnostics,
  handleRendererProcessGone,
  resolveRendererGoneAction,
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
    id: number
    isDestroyed: ReturnType<typeof vi.fn>
    isCrashed: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    executeJavaScript: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    forcefullyCrashRenderer: ReturnType<typeof vi.fn>
  }
}

function createWindow(): TestWindow {
  return {
    on: vi.fn(),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 7,
      isDestroyed: vi.fn(() => false),
      isCrashed: vi.fn(() => false),
      on: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue(false),
      reload: vi.fn(),
      send: vi.fn(),
      forcefullyCrashRenderer: vi.fn()
    }
  }
}

function listenerOf(window: TestWindow, event: string) {
  return window.webContents.on.mock.calls.find(([name]) => name === event)?.[1]
}

describe('rendererDiagnostics render-process-gone recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetAppQuittingForTests()
  })

  it('marks OOM and crash exits as recoverable', () => {
    expect(shouldRecoverRendererProcess({ reason: 'oom', exitCode: 0 })).toBe(true)
    expect(shouldRecoverRendererProcess({ reason: 'crashed', exitCode: 1 })).toBe(true)
    expect(shouldRecoverRendererProcess({ reason: 'abnormal-exit', exitCode: 3 })).toBe(true)
    expect(shouldRecoverRendererProcess({ reason: 'killed', exitCode: 9 })).toBe(false)
    expect(shouldRecoverRendererProcess({ reason: 'clean-exit', exitCode: 0 })).toBe(false)
  })

  it.each([
    ['clean-exit', 'ignore'],
    ['oom', 'reload'],
    ['crashed', 'reload'],
    ['abnormal-exit', 'reload'],
    ['killed', 'prompt'],
    ['launch-failed', 'prompt'],
    ['integrity-failure', 'prompt'],
    ['memory-eviction', 'prompt'],
    ['a-reason-a-later-electron-adds', 'prompt']
  ] as const)('answers the exit reason %s with %s', (reason, action) => {
    expect(resolveRendererGoneAction({ reason, exitCode: 1 } as never)).toBe(action)
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

  // Updated for the recovery rules: this used to pin a silent return, which left a blank window.
  it('asks instead of reloading automatically for exits that something outside the page caused', () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    const promptRenderer = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const details = { reason: 'memory-eviction', exitCode: 0 }

    handleRendererProcessGone(window as never, details as never, { recoverRenderer, promptRenderer })

    expect(recoverRenderer).not.toHaveBeenCalled()
    expect(window.webContents.reload).not.toHaveBeenCalled()
    expect(promptRenderer).toHaveBeenCalledExactlyOnceWith(window, details, 'not-automatic')
  })

  it('does nothing for a clean exit', () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    const promptRenderer = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox).mockReset()

    handleRendererProcessGone(window as never, { reason: 'clean-exit', exitCode: 0 } as never, {
      recoverRenderer,
      promptRenderer
    })
    handleRendererProcessGone(window as never, { reason: 'clean-exit', exitCode: 0 } as never)

    expect(recoverRenderer).not.toHaveBeenCalled()
    expect(promptRenderer).not.toHaveBeenCalled()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(window.webContents.reload).not.toHaveBeenCalled()
  })

  it.each(['killed', 'launch-failed', 'integrity-failure', 'memory-eviction'] as const)(
    'shows the recovery dialog with Reload as the default for %s and reloads only when confirmed',
    async (reason) => {
      for (const response of [0, 1]) {
        const window = createWindow()
        // A dead renderer: a confirmed reload is only carried out while it is still dead.
        window.webContents.isCrashed.mockReturnValue(true)
        const recoverRenderer = vi.fn()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        vi.mocked(dialog.showMessageBox)
          .mockReset()
          .mockResolvedValue({ response, checkboxChecked: false })
        attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => 1000 })
        const listener = window.webContents.on.mock.calls.find(
          ([event]) => event === 'render-process-gone'
        )?.[1]
        const details = { reason, exitCode: 9 }

        listener({}, details)

        expect(recoverRenderer).not.toHaveBeenCalled()
        expect(dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(
          window,
          expect.objectContaining({
            message: '窗口的显示进程已意外停止。',
            buttons: ['重新加载', '取消'],
            defaultId: 0,
            cancelId: 1
          })
        )
        await Promise.resolve()
        await Promise.resolve()
        expect(recoverRenderer).toHaveBeenCalledTimes(response === 0 ? 1 : 0)
        if (response === 0) expect(recoverRenderer).toHaveBeenCalledWith(window, details)
      }
    }
  )

  it('uses the default dialog and guarded reload when the handler is called without window state', async () => {
    const window = createWindow()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockResolvedValue({ response: 0, checkboxChecked: false })

    handleRendererProcessGone(window as never, { reason: 'killed', exitCode: 9 } as never)

    expect(window.webContents.reload).not.toHaveBeenCalled()
    expect(dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      window,
      expect.objectContaining({ defaultId: 0, cancelId: 1 })
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it.each(['oom', 'crashed', 'abnormal-exit', 'killed', 'launch-failed', 'memory-eviction'] as const)(
    'never reloads or asks while the app is quitting: %s',
    (reason) => {
      const window = createWindow()
      const recoverRenderer = vi.fn()
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.spyOn(console, 'info').mockImplementation(() => undefined)
      vi.mocked(dialog.showMessageBox).mockReset()
      attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => 1000 })
      const listener = window.webContents.on.mock.calls.find(
        ([event]) => event === 'render-process-gone'
      )?.[1]

      markAppQuitting()
      listener({}, { reason, exitCode: 9 })

      expect(recoverRenderer).not.toHaveBeenCalled()
      expect(window.webContents.reload).not.toHaveBeenCalled()
      expect(dialog.showMessageBox).not.toHaveBeenCalled()
    }
  )

  it.each(['crashed', 'killed'] as const)(
    'never reloads or asks once the Windows session is ending: %s',
    (reason) => {
      const window = createWindow()
      const recoverRenderer = vi.fn()
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.spyOn(console, 'info').mockImplementation(() => undefined)
      vi.mocked(dialog.showMessageBox).mockReset()
      attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => 1000 })
      const sessionEnd = window.on.mock.calls.find(([event]) => event === 'session-end')?.[1]
      const listener = window.webContents.on.mock.calls.find(
        ([event]) => event === 'render-process-gone'
      )?.[1]
      expect(sessionEnd).toBeTypeOf('function')

      sessionEnd()
      listener({}, { reason, exitCode: 9 })

      expect(recoverRenderer).not.toHaveBeenCalled()
      expect(dialog.showMessageBox).not.toHaveBeenCalled()
    }
  )

  it('the handler on its own raises one dialog for a burst of exits, and asks again after an answer', async () => {
    const window = createWindow()
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

    for (let index = 0; index < 5; index += 1) {
      handleRendererProcessGone(window as never, { reason: 'killed', exitCode: 9 } as never)
    }
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    const answerFirstWindow = resolvePrompt
    // Another window is not held back by this one's open dialog.
    handleRendererProcessGone(createWindow() as never, { reason: 'killed', exitCode: 9 } as never)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)

    answerFirstWindow({ response: 1, checkboxChecked: false })
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
    handleRendererProcessGone(window as never, { reason: 'killed', exitCode: 9 } as never)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(3)
    expect(window.webContents.reload).not.toHaveBeenCalled()
  })

  it('the handler on its own also does nothing once the Windows session is ending', () => {
    const window = createWindow()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox).mockReset()
    markSessionEnding()

    handleRendererProcessGone(window as never, { reason: 'crashed', exitCode: 5 } as never)
    handleRendererProcessGone(window as never, { reason: 'killed', exitCode: 9 } as never)

    expect(window.webContents.reload).not.toHaveBeenCalled()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('the handler on its own also does nothing while the app is quitting', () => {
    const window = createWindow()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox).mockReset()
    markAppQuitting()

    handleRendererProcessGone(window as never, { reason: 'crashed', exitCode: 5 } as never)
    handleRendererProcessGone(window as never, { reason: 'killed', exitCode: 9 } as never)

    expect(window.webContents.reload).not.toHaveBeenCalled()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('drops a confirmed manual reload when the app started quitting while the dialog was open', async () => {
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
    listener({}, { reason: 'killed', exitCode: 9 })
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)

    markAppQuitting()
    resolvePrompt({ response: 0, checkboxChecked: false })
    await Promise.resolve()
    await Promise.resolve()

    expect(recoverRenderer).not.toHaveBeenCalled()
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
      window.webContents.isCrashed.mockReturnValue(true)
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

  // Updated for the recovery rules: 'killed' used to be ignored silently; it now asks once.
  it('does not spend the recoverable-crash budget for exits that are answered with the dialog', async () => {
    const window = createWindow()
    const recoverRenderer = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockResolvedValue({ response: 1, checkboxChecked: false })
    attachRendererDiagnostics(window as never, { recoverRenderer, monotonicNow: () => 1000 })
    const listener = window.webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone'
    )?.[1]
    for (let index = 0; index < 10; index += 1) listener({}, { reason: 'killed', exitCode: 9 })
    // One question for the whole burst, and no automatic reload.
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(recoverRenderer).not.toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    for (let index = 0; index < 3; index += 1) listener({}, { reason: 'crashed', exitCode: 1 })
    expect(recoverRenderer).toHaveBeenCalledTimes(3)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
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
      expect.objectContaining({
        message: '窗口多次意外退出，自动恢复已暂停。',
        buttons: ['重新加载', '取消'],
        // Reload is now the default button (was Cancel): Enter must bring a blank window back.
        defaultId: 0,
        cancelId: 1
      })
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

describe('rendererDiagnostics recovery notice', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetAppQuittingForTests()
  })

  it('sends one notice with reason, exit code and time to the page the recovery reload brings up', () => {
    const window = createWindow()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    attachRendererDiagnostics(window as never, { monotonicNow: () => 1000, wallClockNow: () => 1_700_000_000_000 })

    // An ordinary load (first start, or a reload the user asked for) says nothing.
    listenerOf(window, 'did-finish-load')()
    expect(window.webContents.send).not.toHaveBeenCalled()

    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).not.toHaveBeenCalled()

    listenerOf(window, 'did-finish-load')()
    listenerOf(window, 'did-finish-load')()

    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('app:renderer-recovered', {
      reason: 'crashed',
      exitCode: 5,
      diedAt: 1_700_000_000_000
    })
  })

  it('sends the notice after a reload confirmed in the dialog, and nothing when the dialog is declined', async () => {
    for (const response of [0, 1]) {
      const window = createWindow()
      window.webContents.isCrashed.mockReturnValue(true)
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.spyOn(console, 'info').mockImplementation(() => undefined)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.mocked(dialog.showMessageBox).mockReset().mockResolvedValue({ response, checkboxChecked: false })
      attachRendererDiagnostics(window as never, { monotonicNow: () => 1000, wallClockNow: () => 42 })

      listenerOf(window, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
      await Promise.resolve()
      await Promise.resolve()
      listenerOf(window, 'did-finish-load')()

      if (response === 0) {
        expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('app:renderer-recovered', {
          reason: 'killed',
          exitCode: 9,
          diedAt: 42
        })
      } else {
        expect(window.webContents.reload).not.toHaveBeenCalled()
        expect(window.webContents.send).not.toHaveBeenCalled()
      }
    }
  })

  it('drops a confirmed reload when the page came back while the dialog was open (no reload of a healthy page)', async () => {
    const window = createWindow()
    window.webContents.isCrashed.mockReturnValue(true)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let answer!: (response: number) => void
    vi.mocked(dialog.showMessageBox).mockReset().mockImplementation(
      () => new Promise((resolve) => (answer = (response) => resolve({ response, checkboxChecked: false })))
    )
    attachRendererDiagnostics(window as never)
    listenerOf(window, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
    window.webContents.isCrashed.mockReturnValue(false)
    answer(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(window.webContents.reload).not.toHaveBeenCalled()
  })

  it('reloads once per death up to the budget and asks on the fourth death within 60 s', () => {
    const window = createWindow()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox).mockReset().mockReturnValue(new Promise(() => undefined))
    let now = 0
    attachRendererDiagnostics(window as never, { monotonicNow: () => now })
    for (let death = 1; death <= 4; death += 1) {
      now += 5_000
      listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
      listenerOf(window, 'did-finish-load')()
      expect(window.webContents.reload).toHaveBeenCalledTimes(Math.min(death, 3))
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(death === 4 ? 1 : 0)
    }
    expect(window.webContents.send).toHaveBeenCalledTimes(3)
  })

  it('stops reloading silently when the page keeps dying slowly: six automatic reloads in ten minutes, then the dialog', async () => {
    const window = createWindow()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox).mockReset().mockResolvedValue({ response: 1, checkboxChecked: false })
    let now = 0
    attachRendererDiagnostics(window as never, { monotonicNow: () => now })
    // One death every 25 s never has three deaths inside 60 s.
    for (let death = 1; death <= 12; death += 1) {
      now += 25_000
      listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
      listenerOf(window, 'did-finish-load')()
      for (let index = 0; index < 6; index += 1) await Promise.resolve()
    }
    expect(window.webContents.reload).toHaveBeenCalledTimes(6)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(6)
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({ message: '窗口多次意外退出，自动恢复已暂停。', defaultId: 0 })
    )

    // Ten minutes after the first of the six, automatic recovery is available again.
    now = 25_000 + 10 * 60_000
    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(7)
  })
})

describe('rendererDiagnostics recovery reload check', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(dialog.showMessageBox).mockReset().mockReturnValue(new Promise(() => undefined))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetAppQuittingForTests()
  })

  it('asks the user when the renderer is still dead ten seconds after a recovery reload', () => {
    const window = createWindow()
    attachRendererDiagnostics(window as never)
    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    // The reload was dropped: no load event, no further exit, the renderer stays dead.
    window.webContents.isCrashed.mockReturnValue(true)

    vi.advanceTimersByTime(9_999)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      window,
      expect.objectContaining({ message: '窗口重新加载后仍未恢复。', buttons: ['重新加载', '取消'], defaultId: 0 })
    )
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(120_000)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('stays silent when the page loaded, when the page is only slow, and when a later exit was answered', async () => {
    // Loaded: the reload worked.
    const loaded = createWindow()
    attachRendererDiagnostics(loaded as never)
    listenerOf(loaded, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    listenerOf(loaded, 'did-finish-load')()
    loaded.webContents.isCrashed.mockReturnValue(true)
    vi.advanceTimersByTime(60_000)

    // Slow: nothing loaded yet, but the renderer is alive.
    const slow = createWindow()
    attachRendererDiagnostics(slow as never)
    listenerOf(slow, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    vi.advanceTimersByTime(60_000)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()

    // A later exit that the user answered with Cancel is not asked about a second time.
    const declined = createWindow()
    vi.mocked(dialog.showMessageBox).mockReset().mockResolvedValue({ response: 1, checkboxChecked: false })
    attachRendererDiagnostics(declined as never)
    listenerOf(declined, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    vi.advanceTimersByTime(2_000)
    listenerOf(declined, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
    declined.webContents.isCrashed.mockReturnValue(true)
    vi.advanceTimersByTime(60_000)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(declined.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('never asks while the app is quitting or after the window closed', () => {
    const quitting = createWindow()
    attachRendererDiagnostics(quitting as never)
    listenerOf(quitting, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    quitting.webContents.isCrashed.mockReturnValue(true)
    markAppQuitting()
    vi.advanceTimersByTime(60_000)
    resetAppQuittingForTests()

    const closed = createWindow()
    attachRendererDiagnostics(closed as never)
    listenerOf(closed, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    closed.webContents.isCrashed.mockReturnValue(true)
    closed.on.mock.calls.find(([event]) => event === 'closed')?.[1]()
    vi.advanceTimersByTime(60_000)

    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })
})

describe('rendererDiagnostics unresponsive renderer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetAppQuittingForTests()
    resetExpectedRendererExitsForTests()
  })

  const flush = async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
  }

  it('waits 15 s, then offers wait / reload with Wait as the default', () => {
    const window = createWindow()
    vi.mocked(dialog.showMessageBox).mockReset().mockReturnValue(new Promise(() => undefined))
    attachRendererDiagnostics(window as never)

    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(14_999)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      window,
      expect.objectContaining({ buttons: ['等待', '重新加载'], defaultId: 0, cancelId: 0 })
    )
    expect(window.webContents.reload).not.toHaveBeenCalled()
  })

  it('asks nothing when the renderer recovers within 15 s, and closes an open question when it recovers later', async () => {
    const window = createWindow()
    let signal: AbortSignal | undefined
    vi.mocked(dialog.showMessageBox).mockReset().mockImplementation(((_window: unknown, options: { signal?: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => undefined)
    }) as never)
    attachRendererDiagnostics(window as never)

    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(10_000)
    listenerOf(window, 'responsive')()
    vi.advanceTimersByTime(60_000)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()

    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    listenerOf(window, 'responsive')()
    expect(signal?.aborted).toBe(true)
  })

  // Replaces a test that expected reload() in the same tick as the forced end. In the real app
  // that reload is cancelled by the exit of the old process and the window stays dead.
  it('on Reload ends the hung renderer and loads the page again only when its exit is reported', async () => {
    const window = createWindow()
    vi.mocked(dialog.showMessageBox).mockReset().mockResolvedValue({ response: 1, checkboxChecked: false })
    attachRendererDiagnostics(window as never, { wallClockNow: () => 77 })

    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    await flush()

    expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    // Not yet: the old process is still going away.
    expect(window.webContents.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(window.webContents.reload).not.toHaveBeenCalled()

    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(window.webContents.forcefullyCrashRenderer.mock.invocationCallOrder[0]).toBeLessThan(
      window.webContents.reload.mock.invocationCallOrder[0]
    )
    // The forced end is not a new crash: no second dialog.
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    listenerOf(window, 'did-finish-load')()
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('app:renderer-recovered', {
      reason: 'unresponsive',
      exitCode: 0,
      diedAt: 77
    })
    vi.advanceTimersByTime(60_000)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('announces the forced end to the death recorder as the user\'s reload', async () => {
    const window = createWindow()
    vi.mocked(dialog.showMessageBox).mockReset().mockResolvedValue({ response: 1, checkboxChecked: false })
    attachRendererDiagnostics(window as never)
    expect(takeExpectedRendererExit(window.webContents.id)).toBeUndefined()

    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    await flush()

    expect(takeExpectedRendererExit(window.webContents.id)).toBe('reload-after-hang')
  })

  it('does not spend the crash budget on the hang reload and answers a real crash of the reloaded page', async () => {
    const window = createWindow()
    vi.mocked(dialog.showMessageBox).mockReset().mockResolvedValue({ response: 1, checkboxChecked: false })
    let now = 1000
    attachRendererDiagnostics(window as never, { monotonicNow: () => now })

    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    await flush()
    listenerOf(window, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)

    // The reloaded page really crashes one second later, three times in a row: all are answered.
    for (let crash = 1; crash <= 3; crash += 1) {
      now += 1000
      listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
      expect(window.webContents.reload).toHaveBeenCalledTimes(1 + crash)
    }
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    now += 1000
    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(4)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('asks how to recover when the hung renderer does not exit within five seconds', async () => {
    const window = createWindow()
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    attachRendererDiagnostics(window as never, { wallClockNow: () => 88 })

    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    await flush()
    expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(4_999)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({ message: '未能结束没有响应的窗口进程。', buttons: ['重新加载', '取消'], defaultId: 0 })
    )
    // The announcement is withdrawn: a later exit is recorded as what it is.
    expect(takeExpectedRendererExit(window.webContents.id)).toBeUndefined()
    expect(window.webContents.reload).not.toHaveBeenCalled()

    // The user confirms: the reload is tried, with the notice for the page it brings up.
    await flush()
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    listenerOf(window, 'did-finish-load')()
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('app:renderer-recovered', {
      reason: 'unresponsive',
      exitCode: 0,
      diedAt: 88
    })
  })

  it('treats an exit after the five seconds as an ordinary death, not as the hang reload', async () => {
    const window = createWindow()
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockResolvedValue({ response: 1, checkboxChecked: false })
    attachRendererDiagnostics(window as never)

    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    await flush()
    vi.advanceTimersByTime(5_000)
    await flush()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)

    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    listenerOf(window, 'did-finish-load')()
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(
      'app:renderer-recovered',
      expect.objectContaining({ reason: 'crashed', exitCode: 5 })
    )
  })

  it('asks at once when the hung renderer cannot be ended, and does nothing when the app quits meanwhile', async () => {
    const window = createWindow()
    window.webContents.forcefullyCrashRenderer.mockImplementation(() => {
      throw new Error('synthetic')
    })
    vi.mocked(dialog.showMessageBox)
      .mockReset()
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockReturnValue(new Promise(() => undefined))
    attachRendererDiagnostics(window as never)
    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    await flush()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(window.webContents.reload).not.toHaveBeenCalled()

    const quitting = createWindow()
    vi.mocked(dialog.showMessageBox).mockReset().mockResolvedValue({ response: 1, checkboxChecked: false })
    attachRendererDiagnostics(quitting as never)
    listenerOf(quitting, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    await flush()
    expect(quitting.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    markAppQuitting()
    listenerOf(quitting, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    vi.advanceTimersByTime(60_000)
    expect(quitting.webContents.reload).not.toHaveBeenCalled()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('asks again after another 15 s when the user chose to wait and it is still hung', async () => {
    const window = createWindow()
    vi.mocked(dialog.showMessageBox).mockReset().mockResolvedValue({ response: 0, checkboxChecked: false })
    attachRendererDiagnostics(window as never)

    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    await flush()
    expect(window.webContents.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(15_000)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('never asks while the app is quitting', () => {
    const window = createWindow()
    vi.mocked(dialog.showMessageBox).mockReset()
    attachRendererDiagnostics(window as never)
    listenerOf(window, 'unresponsive')()
    markAppQuitting()
    vi.advanceTimersByTime(30_000)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })
})

describe('rendererDiagnostics dead window after a declined recovery dialog', () => {
  type Answer = { resolve: (response: number) => void; signal?: AbortSignal; message?: string }
  let answers: Answer[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    answers = []
    vi.mocked(dialog.showMessageBox).mockReset().mockImplementation(((
      _window: unknown,
      options: { signal?: AbortSignal; message?: string }
    ) =>
      new Promise((resolve) => {
        const answer: Answer = {
          resolve: (response) => resolve({ response, checkboxChecked: false }),
          signal: options.signal,
          message: options.message
        }
        answers.push(answer)
        // Like Electron: an aborted dialog closes as if cancelled (cancelId 1 for recovery dialogs).
        options.signal?.addEventListener('abort', () => answer.resolve(1))
      })) as never)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetAppQuittingForTests()
    resetExpectedRendererExitsForTests()
  })

  const flush = async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  }
  const windowListener = (window: TestWindow, event: string) => {
    const listener = window.on.mock.calls.find(([name]) => name === event)?.[1]
    return () => listener?.()
  }
  const deadWindow = () => {
    const window = createWindow()
    window.webContents.isCrashed.mockReturnValue(true)
    attachRendererDiagnostics(window as never, { wallClockNow: () => 5 })
    return {
      window,
      blur: windowListener(window, 'blur'),
      focus: windowListener(window, 'focus'),
      close: windowListener(window, 'close'),
      closed: windowListener(window, 'closed')
    }
  }

  it('asks once more when the user comes back to the dead window, and Reload then brings it back', async () => {
    const { window, blur, focus } = deadWindow()
    listenerOf(window, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
    expect(answers).toHaveLength(1)
    answers[0].resolve(1)
    await flush()

    // The focus that comes back when the dialog closes is not a return: no loop.
    focus()
    focus()
    expect(answers).toHaveLength(1)

    blur()
    focus()
    expect(answers).toHaveLength(2)
    expect(answers[1].message).toBe('窗口的显示进程已意外停止。')
    // While that dialog is open nothing else is asked.
    blur()
    focus()
    expect(answers).toHaveLength(2)

    answers[1].resolve(0)
    await flush()
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    window.webContents.isCrashed.mockReturnValue(false)
    listenerOf(window, 'did-finish-load')()
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('app:renderer-recovered', {
      reason: 'killed',
      exitCode: 9,
      diedAt: 5
    })
    blur()
    focus()
    expect(answers).toHaveLength(2)
  })

  it('asks at most once per return, also when every answer is Cancel', async () => {
    const { window, blur, focus } = deadWindow()
    listenerOf(window, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
    for (let round = 1; round <= 3; round += 1) {
      answers.at(-1)!.resolve(1)
      await flush()
      // The closing dialog hands the focus back several times: still no new question.
      for (let index = 0; index < 5; index += 1) focus()
      expect(answers).toHaveLength(round)
      blur()
      focus()
      expect(answers).toHaveLength(round + 1)
    }
    expect(window.webContents.reload).not.toHaveBeenCalled()
  })

  it('does not ask on focus while quitting, after a close request, once closed, or when the renderer is alive again', async () => {
    const quitting = deadWindow()
    listenerOf(quitting.window, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
    answers[0].resolve(1)
    await flush()
    markAppQuitting()
    quitting.blur()
    quitting.focus()
    resetAppQuittingForTests()
    expect(answers).toHaveLength(1)

    const closing = deadWindow()
    listenerOf(closing.window, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
    answers[1].resolve(1)
    await flush()
    closing.blur()
    closing.close()
    closing.focus()
    expect(answers).toHaveLength(2)
    closing.closed()
    closing.window.isDestroyed.mockReturnValue(true)
    closing.blur()
    closing.focus()
    expect(answers).toHaveLength(2)

    const alive = deadWindow()
    listenerOf(alive.window, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
    answers[2].resolve(1)
    await flush()
    alive.window.webContents.isCrashed.mockReturnValue(false)
    alive.blur()
    alive.focus()
    expect(answers).toHaveLength(3)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(3)
  })

  it('does not ask on focus while an automatic reload is still being checked', () => {
    const { window, blur, focus } = deadWindow()
    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    blur()
    focus()
    expect(answers).toHaveLength(0)
  })

  it('withdraws the "did not recover" dialog when the page loads after the check, without a second reload', async () => {
    const { window, blur, focus } = deadWindow()
    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    vi.advanceTimersByTime(10_000)
    expect(answers).toHaveLength(1)
    expect(answers[0].message).toBe('窗口重新加载后仍未恢复。')
    expect(answers[0].signal?.aborted).toBe(false)

    // The slow reload finally comes up.
    window.webContents.isCrashed.mockReturnValue(false)
    listenerOf(window, 'did-finish-load')()
    expect(answers[0].signal?.aborted).toBe(true)
    await flush()
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledTimes(1)
    // The withdrawn dialog is not an answer: nothing is asked again later.
    blur()
    focus()
    vi.advanceTimersByTime(60_000)
    expect(answers).toHaveLength(1)
  })

  it('withdraws the recovery dialog when the renderer is no longer dead, before the page has loaded', async () => {
    const { window } = deadWindow()
    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    vi.advanceTimersByTime(10_000)
    expect(answers).toHaveLength(1)
    vi.advanceTimersByTime(5_000)
    expect(answers[0].signal?.aborted).toBe(false)
    window.webContents.isCrashed.mockReturnValue(false)
    vi.advanceTimersByTime(1_000)
    expect(answers[0].signal?.aborted).toBe(true)
    await flush()
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    // A new death after that gets its own answer.
    window.webContents.isCrashed.mockReturnValue(true)
    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(2)
  })

  it('stops looking once the window is closed', () => {
    const { window, closed } = deadWindow()
    listenerOf(window, 'render-process-gone')({}, { reason: 'killed', exitCode: 9 })
    expect(vi.getTimerCount()).toBe(1)
    closed()
    expect(answers[0].signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the reason "unresponsive" when a hang reload has to be retried from the dialog', async () => {
    const window = createWindow()
    attachRendererDiagnostics(window as never, { wallClockNow: () => 66 })
    listenerOf(window, 'unresponsive')()
    vi.advanceTimersByTime(15_000)
    answers[0].resolve(1)
    await flush()
    expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    window.webContents.isCrashed.mockReturnValue(true)
    listenerOf(window, 'render-process-gone')({}, { reason: 'crashed', exitCode: 5 })
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10_000)
    expect(answers[1].message).toBe('窗口重新加载后仍未恢复。')
    answers[1].resolve(0)
    await flush()
    expect(window.webContents.reload).toHaveBeenCalledTimes(2)
    window.webContents.isCrashed.mockReturnValue(false)
    listenerOf(window, 'did-finish-load')()
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('app:renderer-recovered', {
      reason: 'unresponsive',
      exitCode: 0,
      diedAt: 66
    })
  })
})
