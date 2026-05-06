import type { BrowserWindow } from 'electron'

export function attachRendererDiagnostics(window: BrowserWindow): void {
  window.webContents.on('did-start-loading', () => {
    console.info('[App] Renderer started loading')
  })

  window.webContents.on('did-finish-load', () => {
    console.info('[App] Renderer finished loading')
  })

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error('[App] Renderer failed to load', {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      })
    }
  )

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[App] Renderer process gone', details)
  })

  window.webContents.on('unresponsive', () => {
    console.error('[App] Renderer became unresponsive')
  })

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (
      (sourceId && sourceId.includes('electron-log_renderer')) ||
      (message && message.includes('[RendererConsole]'))
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

    const logStr = `[Renderer] ${message} (${shortSource}:${line})`
    if (level === 2) {
      console.warn(logStr)
    } else if (level >= 3) {
      console.error(logStr)
    } else {
      console.info(logStr)
    }
  })
}
