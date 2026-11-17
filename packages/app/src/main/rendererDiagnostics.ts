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
/**
 * How long the user's choice to reload a hung renderer stays alive when its forced end is not
 * reported in time: an exit within this time (and before the renderer answers again or a page
 * loads) is still that reload, in the window and in the death record.
 */
export const HANG_RELOAD_REQUEST_TTL_MS = 10 * 60_000
/** How often an open recovery dialog checks whether the dead renderer came back by itself. */
export const RECOVERY_PROMPT_POLL_MS = 1_000

/** What the page brought up by a recovery reload is told about the death. */
type RecoveryNotice = Pick<RendererRecoveredEvent, 'reason' | 'exitCode'>
type RecoveryPrompt = {
  kind: RendererRecoveryPromptKind
  controller: AbortController
  poll: ReturnType<typeof setInterval> | null
}

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
 * An aborted dialog is closed by Electron as if cancelled; that is not the user's answer, so
 * onDecision is not called for it.
 */
function showRendererRecoveryPrompt(
  window: BrowserWindow,
  kind: RendererRecoveryPromptKind,
  onDecision: (reload: boolean) => void,
  onSettled: () => void,
  signal?: AbortSignal
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
        noLink: true,
        ...(signal ? { signal } : {})
      })
      .then(({ response }) => {
        if (signal?.aborted) return
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
  // The open recovery dialog of this window, if any (at most one at a time).
  let recoveryPrompt: RecoveryPrompt | null = null
  // The last recovery dialog the user answered with 取消 / Esc while the renderer stayed dead. The
  // frameless window then has no controls of its own, so the question is asked again the next time
  // the user comes back to the window (see 'focus' below).
  let declinedRecovery: {
    details: RenderProcessGoneDetails
    kind: RendererRecoveryPromptKind
    notice: RecoveryNotice
  } | null = null
  // 'focus' asks again only after the window lost the focus since that answer: the focus that comes
  // back when the dialog itself closes must not reopen it (no dialog loop).
  let blurredSinceDeclined = false

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
  // The notice keeps the reason of the first death of a recovery, e.g. 'unresponsive' when the
  // user asked to reload a hung window, also when that reload is retried from a dialog.
  const checkReloadLater = (details: RenderProcessGoneDetails, notice: RecoveryNotice) => {
    clearReloadCheck()
    reloadCheckTimer = setTimeout(() => {
      reloadCheckTimer = null
      if (isShuttingDown() || !isRendererDead()) return
      console.error('[App] Renderer recovery reload did not bring the window back', {
        reason: details.reason,
        exitCode: details.exitCode
      })
      promptForManualRecovery(window, details, 'reload-failed', notice)
    }, RELOAD_CHECK_DELAY_MS)
    reloadCheckTimer.unref?.()
  }
  /** Starts a recovery reload and remembers what the page it brings up is told. */
  const startRecoveryReload = (details: RenderProcessGoneDetails, notice: RecoveryNotice = details) => {
    declinedRecovery = null
    pendingRecoveryNotice = {
      reason: notice.reason,
      exitCode: notice.exitCode,
      diedAt: wallClockNow()
    }
    reloadWindow(window, details)
    checkReloadLater(details, { reason: notice.reason, exitCode: notice.exitCode })
  }
  const recoverRenderer = (_window: BrowserWindow, details: RenderProcessGoneDetails) => {
    startRecoveryReload(details)
  }
  /** Closes the open recovery dialog without an answer: its question no longer applies. */
  const withdrawRecoveryPrompt = () => {
    const prompt = recoveryPrompt
    if (!prompt) return
    recoveryPrompt = null
    if (prompt.poll) clearInterval(prompt.poll)
    prompt.controller.abort()
  }
  const promptForManualRecovery = (
    _window: BrowserWindow,
    details: RenderProcessGoneDetails,
    kind: RendererRecoveryPromptKind,
    notice: RecoveryNotice = details
  ) => {
    if (recoveryPrompt || isShuttingDown()) return
    const prompt: RecoveryPrompt = { kind, controller: new AbortController(), poll: null }
    recoveryPrompt = prompt
    const settle = () => {
      if (recoveryPrompt !== prompt) return
      if (prompt.poll) clearInterval(prompt.poll)
      recoveryPrompt = null
    }
    // A dead renderer that comes back by itself (e.g. a slow reload finally started) makes the
    // question moot: look once a second while the dialog is open.
    if (isRendererDead()) {
      prompt.poll = setInterval(() => {
        if (recoveryPrompt === prompt && !isRendererDead()) withdrawRecoveryPrompt()
      }, RECOVERY_PROMPT_POLL_MS)
      prompt.poll.unref?.()
    }
    showRendererRecoveryPrompt(
      window,
      kind,
      (reload) => {
        // Answered: this dialog is closed, so whatever follows may ask again.
        settle()
        // The answer can arrive long after the question: check again that nothing is closing.
        if (isShuttingDown()) return
        if (reload && kind === 'hang-not-ended' && !isRendererDead()) {
          // The renderer is still hung, and a hung renderer cannot process a reload: end it again
          // and wait for its exit as before.
          reloadHungRenderer()
        } else if (reload) {
          // (A 'hang-not-ended' renderer that is dead by now, its exit answered or not, gets the
          // reload the user asked for: ending a dead renderer again would never report an exit.)
          // Never reload a page that came back meanwhile (the 1 s look above may not have run yet).
          if (!isRendererDead()) return
          startRecoveryReload(details, notice)
        } else {
          declinedRecovery = { details, kind, notice }
          blurredSinceDeclined = false
        }
      },
      settle,
      prompt.controller.signal
    )
  }

  const recoverWithinBudget = (_window: BrowserWindow, details: RenderProcessGoneDetails) => {
    if (!isWindowUsable() || recoveryPrompt) return
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
    // The page is up: a dialog that asks whether to reload a dead window no longer applies.
    withdrawRecoveryPrompt()
    declinedRecovery = null
    dropHangReloadRequest()
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
  // Until when an exit of this renderer is the user's hang reload (also after the 5 s above, e.g.
  // while the 'hang-not-ended' dialog is open): cleared by the exit, by 'responsive', by a finished
  // load and when the window closes.
  let hangReloadRequestedUntil: number | null = null
  const isHangReloadRequested = () => hangReloadRequestedUntil !== null && now() <= hangReloadRequestedUntil
  const dropHangReloadRequest = () => {
    if (hangReloadRequestedUntil === null) return
    hangReloadRequestedUntil = null
    cancelExpectedRendererExit(webContentsId)
  }
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
    // The request (and its announcement to the death recorder) stays: an exit that is reported
    // late is still the reload the user asked for.
    if (isShuttingDown()) return
    console.error('[App] The unresponsive renderer did not exit; asking how to recover')
    promptForManualRecovery(
      window,
      { reason: 'unresponsive', exitCode: 0 } as unknown as RenderProcessGoneDetails,
      'hang-not-ended'
    )
  }
  const reloadHungRenderer = () => {
    if (hangTerminationTimer || isShuttingDown()) return
    console.warn('[App] Ending the unresponsive renderer to reload it, as the user chose')
    // A hung renderer cannot process a reload, so it is ended first. The page is loaded again
    // only when that exit is reported (see 'render-process-gone' below): a reload started while
    // the old process is still going away is cancelled by its exit and the window stays dead.
    hangReloadRequestedUntil = now() + HANG_RELOAD_REQUEST_TTL_MS
    expectRendererExit(webContentsId, 'reload-after-hang', HANG_RELOAD_REQUEST_TTL_MS)
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
      recoveryPrompt ||
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
          detail: '可以继续等待，或重新加载窗口。正在生成的回复会中断，不会自动重新发送；重新加载后请确认你最后发送的消息仍在对话中。',
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
    declinedRecovery = null
    if (hangTerminationTimer || isHangReloadRequested()) {
      // The forced end of a hung renderer the user chose to reload, also when it is reported after
      // the 5 s: not a new crash, so no dialog and no use of the crash budget. A 'hang-not-ended'
      // dialog still open is answered by this exit. Now that the old process is gone the reload can work.
      clearHangTermination()
      // Taken by the death recorder (app-level 'render-process-gone'); nothing to cancel here.
      hangReloadRequestedUntil = null
      withdrawRecoveryPrompt()
      console.warn('[App] Renderer process gone', {
        reason: details.reason,
        exitCode: details.exitCode,
        expected: 'reload-after-hang'
      })
      if (isShuttingDown()) return
      startRecoveryReload(details, { reason: 'unresponsive', exitCode: 0 })
      return
    }
    // The hung renderer died after the user's hang reload request had expired, while the question
    // whether to end it once more is still open: that question no longer applies, and keeping it
    // open would swallow this exit (an open dialog blocks every other answer). Close it, and let
    // the exit get its own answer below.
    if (recoveryPrompt?.kind === 'hang-not-ended') withdrawRecoveryPrompt()
    dropHangReloadRequest()
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
    withdrawRecoveryPrompt()
    declinedRecovery = null
    dropHangReloadRequest()
  })

  // A recovery dialog answered with 取消 leaves a dark frameless window without controls. Ask once
  // more each time the user comes back to it (focus after the window had lost the focus), as long
  // as the renderer is still dead and nothing else is being asked or done.
  window.on('blur', () => {
    if (declinedRecovery) blurredSinceDeclined = true
  })
  window.on('close', () => {
    // Closing (the unsaved-changes question may follow): the next focus is not a return.
    blurredSinceDeclined = false
  })
  window.on('focus', () => {
    const declined = declinedRecovery
    if (!declined || !blurredSinceDeclined) return
    blurredSinceDeclined = false
    if (
      recoveryPrompt ||
      unresponsivePrompt ||
      reloadCheckTimer ||
      hangTerminationTimer ||
      isShuttingDown() ||
      !isRendererDead()
    ) {
      return
    }
    console.warn('[App] The window still shows a dead renderer; asking again how to recover')
    promptForManualRecovery(window, declined.details, declined.kind, declined.notice)
  })

  window.webContents.on('unresponsive', () => {
    console.error('[App] Renderer became unresponsive')
    unresponsive = true
    if (!unresponsiveTimer && !unresponsivePrompt) {
      unresponsiveTimer = setTimeout(askAboutHang, UNRESPONSIVE_PROMPT_DELAY_MS)
    }
  })

  window.webContents.on('responsive', () => {
    // The hung renderer answers again after its forced end was not reported in time: the reload
    // it was to be ended for is moot, and so is the question whether to end it once more. (While
    // the forced end is still in flight its exit is expected and stays the user's reload.)
    if (!hangTerminationTimer && hangReloadRequestedUntil !== null) {
      dropHangReloadRequest()
      withdrawRecoveryPrompt()
    }
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
