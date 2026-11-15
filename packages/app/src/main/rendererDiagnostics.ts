import { dialog, type BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { performance } from 'node:perf_hooks'
import { isAppQuitting, isSessionEnding, markSessionEnding } from './appQuitState'
import { cancelExpectedRendererExit, expectRendererExit } from './expectedRendererExits'
import {
  RENDERER_RECOVERED_CHANNEL,
  type RendererRecoveredEvent
} from '@shared/utils/rendererRecoveryEvent'

/** Why the recovery dialog is shown instead of an automatic reload. */
export type RendererRecoveryPromptKind =
  | 'not-automatic'
  | 'budget-exhausted'
  /** A recovery reload was started but the window still shows a dead renderer. */
  | 'reload-failed'
  /** The user chose to reload a hung renderer, but the renderer could not be ended. */
  | 'hang-not-ended'

export type RendererGoneAction = 'ignore' | 'reload' | 'prompt'

type RendererDiagnosticsOptions = {
  recoverRenderer?: (window: BrowserWindow, details: RenderProcessGoneDetails) => void
  promptRenderer?: (
    window: BrowserWindow,
    details: RenderProcessGoneDetails,
    kind: RendererRecoveryPromptKind
  ) => void
  /** True while the app is quitting or the window is going away: nothing may be recovered then. */
  isShuttingDown?: () => boolean
  monotonicNow?: () => number
  wallClockNow?: () => number
}

// Exits that are safe to answer with an automatic reload (within the budget below).
// 'oom' is how Windows reports a V8 out-of-memory death, Linux reports the same death as
// 'crashed' (exit code 5), and 'abnormal-exit' is a non-zero exit of the renderer itself.
const AUTOMATIC_RELOAD_REASONS = new Set(['oom', 'crashed', 'abnormal-exit'])
const RECOVERY_WINDOW_MS = 60_000
const MAX_AUTOMATIC_RECOVERIES = 3
// A second, longer budget: deaths that come more than 20 s apart never exhaust the one above,
// so a page that dies again and again (e.g. it runs out of memory on every load of a large
// conversation) would be reloaded for ever without a word.
const LONG_RECOVERY_WINDOW_MS = 10 * 60_000
const MAX_AUTOMATIC_RECOVERIES_LONG = 6
/** How long the forced end of a hung renderer may take before the user is asked instead. */
export const HANG_TERMINATION_TIMEOUT_MS = 5_000
/** When a recovery reload is checked: a renderer that is still dead then needs the dialog. */
export const RELOAD_CHECK_DELAY_MS = 10_000
/** How long a renderer may be unresponsive before the user is offered wait / reload. */
export const UNRESPONSIVE_PROMPT_DELAY_MS = 15_000

/** True when the exit may be answered with an automatic reload. */
export function shouldRecoverRendererProcess(details: RenderProcessGoneDetails): boolean {
  return AUTOMATIC_RELOAD_REASONS.has(details.reason)
}

/**
 * Every exit except a clean one needs an answer, otherwise the window stays blank:
 * - 'oom' / 'crashed' / 'abnormal-exit': reload automatically (budgeted);
 * - 'killed' / 'launch-failed' / 'integrity-failure' / 'memory-eviction' and any reason a later
 *   Electron adds: ask first, because something outside the page ended the process and an
 *   automatic reload could fight it or fail the same way again.
 */
export function resolveRendererGoneAction(details: RenderProcessGoneDetails): RendererGoneAction {
  if (details.reason === 'clean-exit') return 'ignore'
  return shouldRecoverRendererProcess(details) ? 'reload' : 'prompt'
}

function canUseWindow(window: BrowserWindow): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed()
}

/** The confirmed quit, an update install or a Windows session end: every exit is expected then. */
const isAppShuttingDown = (): boolean => isAppQuitting() || isSessionEnding()

const RECOVERY_PROMPT_MESSAGES: Record<RendererRecoveryPromptKind, string> = {
  'not-automatic': '窗口的显示进程已意外停止。',
  'budget-exhausted': '窗口多次意外退出，自动恢复已暂停。',
  'reload-failed': '窗口重新加载后仍未恢复。',
  'hang-not-ended': '未能结束没有响应的窗口进程。'
}

/**
 * The recovery dialog. Reload is the default button: after a renderer death the window shows
 * nothing, so pressing Enter must bring the app back. Returns false when it could not be shown.
 */
function showRendererRecoveryPrompt(
  window: BrowserWindow,
  kind: RendererRecoveryPromptKind,
  onDecision: (reload: boolean) => void,
  onSettled: () => void
): boolean {
  try {
    void dialog
      .showMessageBox(window, {
        type: 'error',
        title: '窗口恢复',
        message: RECOVERY_PROMPT_MESSAGES[kind],
        detail: '未保存的更改可能无法恢复。是否尝试重新加载窗口？',
        buttons: ['重新加载', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      .then(({ response }) => {
        onDecision(response === 0)
      })
      .catch(() => {
        console.error('[App] Failed to show renderer recovery prompt')
      })
      .finally(onSettled)
    return true
  } catch {
    console.error('[App] Failed to show renderer recovery prompt')
    onSettled()
    return false
  }
}

function reloadRenderer(window: BrowserWindow, details: RenderProcessGoneDetails): void {
  if (window.isDestroyed()) {
    console.warn('[App] Renderer recovery skipped because the window is already destroyed')
    return
  }

  if (window.webContents.isDestroyed()) {
    console.warn('[App] Renderer recovery skipped because webContents is already destroyed')
    return
  }

  console.warn('[App] Renderer exited unexpectedly; reloading the window to recover', {
    reason: details.reason,
    exitCode: details.exitCode
  })

  try {
    window.webContents.reload()
  } catch {
    console.error('[App] Renderer recovery reload failed')
  }
}

export function handleRendererProcessGone(
  window: BrowserWindow,
  details: RenderProcessGoneDetails,
  options: RendererDiagnosticsOptions = {}
): void {
  console.error('[App] Renderer process gone', {
    reason: details.reason,
    exitCode: details.exitCode
  })

  const action = resolveRendererGoneAction(details)
  if (action === 'ignore') {
    return
  }

  // A renderer that goes away while the app quits or its window closes is expected:
  // reloading it or raising a dialog would fight the shutdown.
  if ((options.isShuttingDown ?? isAppShuttingDown)()) {
    console.info('[App] Renderer recovery skipped because the app or the window is closing')
    return
  }

  if (action === 'prompt') {
    const promptRenderer = options.promptRenderer ?? promptForReloadOnce
    promptRenderer(window, details, 'not-automatic')
    return
  }

  const recoverRenderer = options.recoverRenderer ?? reloadRenderer
  recoverRenderer(window, details)
}

// Windows whose fallback dialog (below) is open: a burst of exits must raise one dialog, not a stack.
const fallbackPromptPending = new WeakSet<BrowserWindow>()

/** Fallback for callers without per-window state: ask once, reload when confirmed. */
function promptForReloadOnce(
  window: BrowserWindow,
  details: RenderProcessGoneDetails,
  kind: RendererRecoveryPromptKind
): void {
  if (!canUseWindow(window) || fallbackPromptPending.has(window)) return
  fallbackPromptPending.add(window)
  showRendererRecoveryPrompt(
    window,
    kind,
    (reload) => {
      if (reload && canUseWindow(window) && !isAppShuttingDown()) reloadRenderer(window, details)
    },
    () => {
      fallbackPromptPending.delete(window)
    }
  )
}

export function attachRendererDiagnostics(
  window: BrowserWindow,
  options: RendererDiagnosticsOptions = {}
): void {
  const now = options.monotonicNow ?? (() => performance.now())
  const wallClockNow = options.wallClockNow ?? (() => Date.now())
  const reloadWindow = options.recoverRenderer ?? reloadRenderer
  // Read once: the id is still needed when the window may already be gone.
  const webContentsId = window.webContents.id
  // Set when a recovery reload was started; sent once to the page that the reload brings up.
  let pendingRecoveryNotice: RendererRecoveredEvent | null = null
  let lastObservedTime = 0
  let automaticRecoveryTimes: number[] = []
  let recoveryPromptPending = false

  const isWindowUsable = () => canUseWindow(window)
  const isShuttingDown = () =>
    isAppShuttingDown() || options.isShuttingDown?.() === true || !isWindowUsable()
  const isRendererDead = () => {
    try {
      return typeof window.webContents.isCrashed === 'function' && window.webContents.isCrashed()
    } catch {
      return false
    }
  }

  // A reload can be dropped without any event (for example when the process it was started in
  // goes away). The window then keeps showing a dead renderer and nothing else would ever act:
  // look once, a little later, and ask the user if that is the case.
  let reloadCheckTimer: ReturnType<typeof setTimeout> | null = null
  const clearReloadCheck = () => {
    if (reloadCheckTimer) clearTimeout(reloadCheckTimer)
    reloadCheckTimer = null
  }
  const checkReloadLater = (details: RenderProcessGoneDetails) => {
    clearReloadCheck()
    reloadCheckTimer = setTimeout(() => {
      reloadCheckTimer = null
      if (isShuttingDown() || !isRendererDead()) return
      console.error('[App] Renderer recovery reload did not bring the window back', {
        reason: details.reason,
        exitCode: details.exitCode
      })
      promptForManualRecovery(window, details, 'reload-failed')
    }, RELOAD_CHECK_DELAY_MS)
    reloadCheckTimer.unref?.()
  }
  /** Starts a recovery reload and remembers what the page it brings up is told. */
  const startRecoveryReload = (
    details: RenderProcessGoneDetails,
    notice: Pick<RendererRecoveredEvent, 'reason' | 'exitCode'> = details
  ) => {
    pendingRecoveryNotice = {
      reason: notice.reason,
      exitCode: notice.exitCode,
      diedAt: wallClockNow()
    }
    reloadWindow(window, details)
    checkReloadLater(details)
  }
  const recoverRenderer = (_window: BrowserWindow, details: RenderProcessGoneDetails) => {
    startRecoveryReload(details)
  }
  const promptForManualRecovery = (
    _window: BrowserWindow,
    details: RenderProcessGoneDetails,
    kind: RendererRecoveryPromptKind
  ) => {
    if (recoveryPromptPending || isShuttingDown()) return
    recoveryPromptPending = true
    showRendererRecoveryPrompt(
      window,
      kind,
      (reload) => {
        // The answer can arrive long after the question: check again that nothing is closing.
        if (reload && !isShuttingDown()) recoverRenderer(window, details)
      },
      () => {
        recoveryPromptPending = false
      }
    )
  }

  const recoverWithinBudget = (_window: BrowserWindow, details: RenderProcessGoneDetails) => {
    if (!isWindowUsable() || recoveryPromptPending) return
    const observedTime = now()
    // A faulty/backward clock must not make previous attempts disappear early.
    lastObservedTime = Math.max(
      lastObservedTime,
      Number.isFinite(observedTime) ? observedTime : lastObservedTime
    )
    automaticRecoveryTimes = automaticRecoveryTimes.filter(
      (attemptTime) => lastObservedTime - attemptTime < LONG_RECOVERY_WINDOW_MS
    )
    const recentRecoveries = automaticRecoveryTimes.filter(
      (attemptTime) => lastObservedTime - attemptTime < RECOVERY_WINDOW_MS
    ).length
    if (
      recentRecoveries >= MAX_AUTOMATIC_RECOVERIES ||
      automaticRecoveryTimes.length >= MAX_AUTOMATIC_RECOVERIES_LONG
    ) {
      console.error('[App] Renderer automatic recovery limit reached', {
        reason: details.reason,
        exitCode: details.exitCode
      })
      promptForManualRecovery(window, details, 'budget-exhausted')
      return
    }
    automaticRecoveryTimes.push(lastObservedTime)
    recoverRenderer(window, details)
  }

  // Windows only: the user is logging off or shutting the PC down. The OS then ends every
  // process of the app; that must not be answered with a reload or a dialog.
  window.on('session-end', () => {
    markSessionEnding()
  })

  window.webContents.on('did-start-loading', () => {
    console.info('[App] Renderer started loading')
  })

  window.webContents.on('did-finish-load', () => {
    console.info('[App] Renderer finished loading')
    clearReloadCheck()
    const notice = pendingRecoveryNotice
    if (!notice || !isWindowUsable()) return
    pendingRecoveryNotice = null
    // Tells the page why it was restarted. The preload keeps it until the app shell listens;
    // nothing is resent: the interrupted reply stays interrupted.
    try {
      window.webContents.send(RENDERER_RECOVERED_CHANNEL, notice)
    } catch {
      console.error('[App] Failed to send the renderer recovery notice')
    }
  })

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      console.error('[App] Renderer failed to load', {
        errorCode,
        isMainFrame
      })
    }
  )

  // A hung renderer: wait 15 s (long synchronous work often recovers), then offer wait / reload.
  let unresponsive = false
  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null
  let unresponsivePrompt: AbortController | null = null
  // Set while the forced end of a hung renderer (the user chose Reload) has not been reported yet.
  let hangTerminationTimer: ReturnType<typeof setTimeout> | null = null
  const clearUnresponsiveTimer = () => {
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer)
    unresponsiveTimer = null
  }
  const clearHangTermination = () => {
    if (hangTerminationTimer) clearTimeout(hangTerminationTimer)
    hangTerminationTimer = null
  }
  const hangTerminationFailed = () => {
    clearHangTermination()
    cancelExpectedRendererExit(webContentsId)
    if (isShuttingDown()) return
    console.error('[App] The unresponsive renderer did not exit; asking how to recover')
    promptForManualRecovery(
      window,
      { reason: 'unresponsive', exitCode: 0 } as unknown as RenderProcessGoneDetails,
      'hang-not-ended'
    )
  }
  const reloadHungRenderer = () => {
    if (hangTerminationTimer) return
    console.warn('[App] Ending the unresponsive renderer to reload it, as the user chose')
    // A hung renderer cannot process a reload, so it is ended first. The page is loaded again
    // only when that exit is reported (see 'render-process-gone' below): a reload started while
    // the old process is still going away is cancelled by its exit and the window stays dead.
    expectRendererExit(webContentsId, 'reload-after-hang', HANG_TERMINATION_TIMEOUT_MS)
    hangTerminationTimer = setTimeout(hangTerminationFailed, HANG_TERMINATION_TIMEOUT_MS)
    hangTerminationTimer.unref?.()
    try {
      window.webContents.forcefullyCrashRenderer()
    } catch {
      hangTerminationFailed()
    }
  }
  const askAboutHang = () => {
    unresponsiveTimer = null
    if (
      !unresponsive ||
      unresponsivePrompt ||
      recoveryPromptPending ||
      hangTerminationTimer ||
      isShuttingDown()
    ) {
      return
    }
    const prompt = new AbortController()
    unresponsivePrompt = prompt
    try {
      void dialog
        .showMessageBox(window, {
          type: 'warning',
          title: '窗口没有响应',
          message: '窗口已超过 15 秒没有响应。',
          detail: '可以继续等待，或重新加载窗口。正在生成的回复会中断，不会自动重新发送；草稿会保留。',
          buttons: ['等待', '重新加载'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          signal: prompt.signal
        })
        .then(({ response }) => {
          if (prompt.signal.aborted || isShuttingDown() || !unresponsive) return
          if (response === 1) reloadHungRenderer()
          else unresponsiveTimer = setTimeout(askAboutHang, UNRESPONSIVE_PROMPT_DELAY_MS)
        })
        .catch(() => {
          console.error('[App] Failed to show the unresponsive renderer prompt')
        })
        .finally(() => {
          if (unresponsivePrompt === prompt) unresponsivePrompt = null
        })
    } catch {
      unresponsivePrompt = null
      console.error('[App] Failed to show the unresponsive renderer prompt')
    }
  }

  window.webContents.on('render-process-gone', (_event, details) => {
    unresponsive = false
    clearUnresponsiveTimer()
    unresponsivePrompt?.abort()
    unresponsivePrompt = null
    // Whatever was being checked belongs to the process before this exit; this exit gets its own answer.
    clearReloadCheck()
    if (hangTerminationTimer) {
      // The forced end of a hung renderer the user chose to reload: not a new crash, so no dialog
      // and no use of the crash budget. Now that the old process is gone the reload can work.
      clearHangTermination()
      console.warn('[App] Renderer process gone', {
        reason: details.reason,
        exitCode: details.exitCode,
        expected: 'reload-after-hang'
      })
      if (isShuttingDown()) return
      startRecoveryReload(details, { reason: 'unresponsive', exitCode: 0 })
      return
    }
    handleRendererProcessGone(window, details, {
      recoverRenderer: recoverWithinBudget,
      promptRenderer: promptForManualRecovery,
      isShuttingDown
    })
  })

  window.on('closed', () => {
    clearUnresponsiveTimer()
    clearHangTermination()
    clearReloadCheck()
  })

  window.webContents.on('unresponsive', () => {
    console.error('[App] Renderer became unresponsive')
    unresponsive = true
    if (!unresponsiveTimer && !unresponsivePrompt) {
      unresponsiveTimer = setTimeout(askAboutHang, UNRESPONSIVE_PROMPT_DELAY_MS)
    }
  })

  window.webContents.on('responsive', () => {
    if (!unresponsive) return
    console.info('[App] Renderer became responsive again')
    unresponsive = false
    clearUnresponsiveTimer()
    // The question is moot now: close it.
    unresponsivePrompt?.abort()
    unresponsivePrompt = null
  })

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (
      (sourceId && sourceId.includes('electron-log_renderer')) ||
      (message && message.includes('[RendererConsole]')) ||
      // Avoid recursively forwarding diagnostic lines that this handler emits below.
      // Electron/log sinks can echo main-process lines back through webContents
      // console-message, often prefixed with a timestamp. Re-forwarding those lines
      // creates exponentially nested `[Renderer] ...` payloads and bloats benchmark
      // memory while adding no signal.
      (message && message.includes('[Renderer]'))
    ) {
      return
    }

    let shortSource = sourceId || 'unknown'
    if (sourceId) {
      try {
        const url = new URL(sourceId)
        const fileName = url.pathname.split('/').pop()
        shortSource = fileName || url.pathname
      } catch {
        shortSource = sourceId.split('/').pop() || sourceId
      }
    }

    const normalizedMessage = typeof message === 'string' ? message : String(message ?? '')
    const maxMessageLength = 2000
    const renderedMessage =
      normalizedMessage.length > maxMessageLength
        ? `${normalizedMessage.slice(0, maxMessageLength)}… [truncated ${normalizedMessage.length - maxMessageLength} chars]`
        : normalizedMessage
    const logStr = `[Renderer] ${renderedMessage} (${shortSource}:${line})`
    if (level === 2) {
      console.warn(logStr)
    } else if (level >= 3) {
      console.error(logStr)
    } else {
      console.info(logStr)
    }
  })
}
