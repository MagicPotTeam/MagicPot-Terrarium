import { dialog, type BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import { performance } from 'node:perf_hooks'

type RendererDiagnosticsOptions = {
  recoverRenderer?: (window: BrowserWindow, details: RenderProcessGoneDetails) => void
  monotonicNow?: () => number
}

const RECOVERABLE_RENDERER_GONE_REASONS = new Set(['oom', 'crashed'])
const RECOVERY_WINDOW_MS = 60_000
const MAX_AUTOMATIC_RECOVERIES = 3

export function shouldRecoverRendererProcess(details: RenderProcessGoneDetails): boolean {
  return RECOVERABLE_RENDERER_GONE_REASONS.has(details.reason)
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

  if (!shouldRecoverRendererProcess(details)) {
    return
  }

  const recoverRenderer = options.recoverRenderer ?? reloadRenderer
  recoverRenderer(window, details)
}

export function attachRendererDiagnostics(
  window: BrowserWindow,
  options: RendererDiagnosticsOptions = {}
): void {
  const now = options.monotonicNow ?? (() => performance.now())
  const recoverRenderer = options.recoverRenderer ?? reloadRenderer
  let lastObservedTime = 0
  let automaticRecoveryTimes: number[] = []
  let recoveryPromptPending = false

  const canUseWindow = () => !window.isDestroyed() && !window.webContents.isDestroyed()
  const promptForManualRecovery = (details: RenderProcessGoneDetails) => {
    if (recoveryPromptPending || !canUseWindow()) return
    recoveryPromptPending = true
    try {
      void dialog
        .showMessageBox(window, {
          type: 'error',
          title: '窗口恢复',
          message: '窗口多次意外退出，自动恢复已暂停。',
          detail: '未保存的更改可能无法恢复。是否尝试重新加载窗口？',
          buttons: ['重新加载', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
        .then(({ response }) => {
          if (response === 0 && canUseWindow()) recoverRenderer(window, details)
        })
        .catch(() => {
          console.error('[App] Failed to show renderer recovery prompt')
        })
        .finally(() => {
          recoveryPromptPending = false
        })
    } catch {
      recoveryPromptPending = false
      console.error('[App] Failed to show renderer recovery prompt')
    }
  }

  const recoverWithinBudget = (_window: BrowserWindow, details: RenderProcessGoneDetails) => {
    if (!canUseWindow() || recoveryPromptPending) return
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
      promptForManualRecovery(details)
      return
    }
    automaticRecoveryTimes.push(lastObservedTime)
    recoverRenderer(window, details)
  }

  window.webContents.on('did-start-loading', () => {
    console.info('[App] Renderer started loading')
  })

  window.webContents.on('did-finish-load', () => {
    console.info('[App] Renderer finished loading')
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

  window.webContents.on('render-process-gone', (_event, details) => {
    handleRendererProcessGone(window, details, { recoverRenderer: recoverWithinBudget })
  })

  window.webContents.on('unresponsive', () => {
    console.error('[App] Renderer became unresponsive')
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
