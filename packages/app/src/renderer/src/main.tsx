// packages/app/src/renderer/packages/app/src/main.tsx
import './utils/loggingOverride' // override console.log before anything else
import { installPerformanceMeasureGuard } from './utils/performanceMeasureGuard'
import './assets/main.css'
import './i18n'
import { Fragment, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CacheProvider } from '@emotion/react'
import createCache from '@emotion/cache'
import App from './App'
import { MessageProvider } from './hooks/useMessage'
import store from './store'
import { Provider as ReduxProvider } from 'react-redux'
import { ConfigProvider } from './hooks/useConfig'
import { ComfyEventProvider } from './hooks/useComfyEvent'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { theme } from './theme'
import type { ErrorInfo, ReactNode } from 'react'
import React from 'react'

const root = createRoot(document.getElementById('root') as HTMLElement)
let devReloadScheduled = false

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message}\n${error.stack || ''}`
  }

  return String(error || '')
}

function shouldForceDevReload(error: unknown): boolean {
  const errorText = getErrorText(error)
  return (
    errorText.includes('Should have a queue') ||
    errorText.includes('Invalid hook call') ||
    errorText.includes('Rendered more hooks than during the previous render') ||
    errorText.includes('Rendered fewer hooks than expected')
  )
}

function scheduleDevReload(reason: unknown): void {
  if (!import.meta.env.DEV || devReloadScheduled || !shouldForceDevReload(reason)) return

  devReloadScheduled = true
  console.warn('[renderer] Detected unstable Fast Refresh state, reloading renderer.', reason)
  window.setTimeout(() => {
    window.location.reload()
  }, 120)
}

installPerformanceMeasureGuard()

function forceStartupHomeRoute(): void {
  if (!store.getState().layout.startupRestorePending) {
    return
  }

  const hash = window.location.hash.trim()
  if (!hash || hash === '#/' || hash === '#') {
    return
  }

  window.history.replaceState(
    null,
    document.title,
    `${window.location.pathname}${window.location.search}#/`
  )
}

forceStartupHomeRoute()

const RootMode = import.meta.env.DEV ? Fragment : StrictMode

// emotion cache
const cache = createCache({ key: 'css', prepend: true })

type RootErrorBoundaryState = {
  error: Error | null
}

class RootErrorBoundary extends React.Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = {
    error: null
  }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[renderer] RootErrorBoundary caught an error', error, errorInfo)
    scheduleDevReload(error)
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#111',
          color: '#f5f5f5',
          padding: '24px',
          fontFamily: 'Consolas, monospace'
        }}
      >
        <h2 style={{ marginTop: 0 }}>Renderer crashed</h2>
        <p style={{ color: '#bbb' }}>The packaged app hit a frontend error during startup.</p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {this.state.error.stack || this.state.error.message}
        </pre>
      </div>
    )
  }
}

window.addEventListener('error', (event) => {
  console.error('[renderer] window error', event.error || event.message)
  scheduleDevReload(event.error || event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] unhandled rejection', event.reason)
  scheduleDevReload(event.reason)
})

root.render(
  <RootMode>
    <RootErrorBoundary>
      <CacheProvider value={cache}>
        <ThemeProvider theme={theme} defaultMode="dark">
          <CssBaseline />
          <ReduxProvider store={store}>
            <ConfigProvider>
              <MessageProvider>
                <ComfyEventProvider>
                  <App />
                </ComfyEventProvider>
              </MessageProvider>
            </ConfigProvider>
          </ReduxProvider>
        </ThemeProvider>
      </CacheProvider>
    </RootErrorBoundary>
  </RootMode>
)
