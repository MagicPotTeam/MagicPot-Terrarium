import { dialog, type BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { performance } from 'node:perf_hooks'
import { isAppQuitting } from './appQuitState'
import {
  RENDERER_RECOVERED_CHANNEL,
  type RendererRecoveredEvent
} from '@shared/utils/rendererRecoveryEvent'

/** Why the recovery dialog is shown instead of an automatic reload. */
export type RendererRecoveryPromptKind = 'not-automatic' | 'budget-exhausted'

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
        message:
          kind === 'budget-exhausted'
            ? '窗口多次意外退出，自动恢复已暂停。'
            : '窗口的显示进程已意外停止。',
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
  if (options.isShuttingDown?.()) {
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

/** Fallback for callers without per-window state: ask once, reload when confirmed. */
function promptForReloadOnce(
  window: BrowserWindow,
  details: RenderProcessGoneDetails,
  kind: RendererRecoveryPromptKind
): void {
  if (!canUseWindow(window)) return
  showRendererRecoveryPrompt(
    window,
    kind,
    (reload) => {
      if (reload && canUseWindow(window) && !isAppQuitting()) reloadRenderer(window, details)
    },
    () => undefined
  )
}

export function attachRendererDiagnostics(
  window: BrowserWindow,
  options: RendererDiagnosticsOptions = {}
): void {
  const now = options.monotonicNow ?? (() => performance.now())
  const wallClockNow = options.wallClockNow ?? (() => Date.now())
  const reloadWindow = options.recoverRenderer ?? reloadRenderer
  // Set when a recovery reload was started; sent once to the page that the reload brings up.
  let pendingRecoveryNotice: RendererRecoveredEvent | null = null
  const recoverRenderer = (_window: BrowserWindow, details: RenderProcessGoneDetails) => {
    pendingRecoveryNotice = {
      reason: details.reason,
      exitCode: details.exitCode,
      diedAt: wallClockNow()
    }
    reloadWindow(window, details)
  }
  let lastObservedTime = 0
  let automaticRecoveryTimes: number[] = []
  let recoveryPromptPending = false
  let sessionEnding = false

  const isWindowUsable = () => canUseWindow(window)
  const isShuttingDown = () =>
    sessionEnding || isAppQuitting() || options.isShuttingDown?.() === true || !isWindowUsable()
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
      (attemptTime) => lastObservedTime - attemptTime < RECOVERY_WINDOW_MS
    )
    if (automaticRecoveryTimes.length >= MAX_AUTOMATIC_RECOVERIES) {
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
    sessionEnding = true
  })

  window.webContents.on('did-start-loading', () => {
    console.info('[App] Renderer started loading')
  })

  window.webContents.on('did-finish-load', () => {
    console.info('[App] Renderer finished loading')
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
  // Until when an exit of the renderer is the forced end of a hang the user chose to reload.
  let expectHangTerminationUntil = -Infinity
  const clearUnresponsiveTimer = () => {
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer)
    unresponsiveTimer = null
  }
  const reloadHungRenderer = () => {
    pendingRecoveryNotice = { reason: 'unresponsive', exitCode: 0, diedAt: wallClockNow() }
    expectHangTerminationUntil = now() + 10_000
    console.warn('[App] Reloading the unresponsive renderer as the user chose')
    try {
      // A hung renderer cannot process a reload; end it first, then load the page again.
      window.webContents.forcefullyCrashRenderer()
      window.webContents.reload()
    } catch {
      console.error('[App] Renderer recovery reload failed')
    }
  }
  const askAboutHang = () => {
    unresponsiveTimer = null
    if (!unresponsive || unresponsivePrompt || recoveryPromptPending || isShuttingDown()) return
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
    if (now() <= expectHangTerminationUntil) {
      // The user chose to reload a hung renderer: this exit is that reload, already handled.
      expectHangTerminationUntil = -Infinity
      console.error('[App] Renderer process gone', { reason: details.reason, exitCode: details.exitCode, expected: 'reload-after-hang' })
      return
    }
    handleRendererProcessGone(window, details, {
      recoverRenderer: recoverWithinBudget,
      promptRenderer: promptForManualRecovery,
      isShuttingDown
    })
  })

  window.on('closed', clearUnresponsiveTimer)

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
