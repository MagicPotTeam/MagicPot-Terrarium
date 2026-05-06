import { app, BrowserWindow, Menu, net, protocol, session } from 'electron'
import { electronApp } from '@electron-toolkit/utils'
import { getTestWindowPolicy } from './testWindowRuntime'
import { type TestUiPolicy } from './testUiPolicy'
import { normalizeLocalFilePath, toFileUrl } from './utils/localFileUrl'

const silentErrorCodes = [
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNREFUSED'
]
const blockedDomains = ['*://*.xgoi.cc/*', '*://xgoi.cc/*']

export function getAppStartupTestWindowPolicy(): TestUiPolicy {
  return getTestWindowPolicy()
}

function createQuitHandler(signal: 'SIGINT' | 'SIGTERM') {
  return () => {
    console.log(`[App] 收到 ${signal} 信号`)
    app.quit()
  }
}

function logSilentNetworkError(error: NodeJS.ErrnoException | null | undefined): boolean {
  if (!error?.code || !silentErrorCodes.includes(error.code)) {
    return false
  }

  console.warn(`[App] 网络错误（已静默处理）: ${error.code}`)
  return true
}

function registerWebContentsPolicies(getMainWindow: () => BrowserWindow | null): void {
  app.on('web-contents-created', (_event, webContents) => {
    if (app.isPackaged) {
      webContents.on('devtools-opened', () => {
        webContents.closeDevTools()
      })
      webContents.on('context-menu', (event) => {
        event.preventDefault()
      })
    }

    webContents.on('before-input-event', (event, input) => {
      if (app.isPackaged && input.type === 'keyDown') {
        const isDevToolsShortcut =
          input.key === 'F12' ||
          (input.control && input.shift && ['i', 'c', 'j'].includes(input.key.toLowerCase()))
        if (isDevToolsShortcut) {
          event.preventDefault()
          return
        }
      }

      if (
        input.type === 'keyDown' &&
        (input.control || input.meta) &&
        input.key.toLowerCase() === 'w'
      ) {
        event.preventDefault()
        const mainWindow = getMainWindow()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:close-tab')
        }
      }
    })
  })
}

function registerProcessErrorHandlers(): void {
  process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
    if (logSilentNetworkError(error)) {
      return
    }
    console.error('[App] 未捕获异常:', error)
  })

  process.on('unhandledRejection', (reason: unknown) => {
    const error = reason as NodeJS.ErrnoException | null | undefined
    if (logSilentNetworkError(error)) {
      return
    }
    console.error('[App] 未处理的 Promise 拒绝:', reason)
  })
}

function registerLocalMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'local-media',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true
      }
    }
  ])
}

async function handleLocalMediaRequest(request: Request): Promise<Response> {
  try {
    const fileUrl = toFileUrl(normalizeLocalFilePath(request.url))
    return net.fetch(fileUrl)
  } catch (error) {
    console.error('[App] local-media: 处理失败:', error)
    return new Response('Internal error', { status: 500 })
  }
}

function configureDefaultSession(): void {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: blockedDomains },
    (details, callback) => {
      console.log(`[App] 已拦截访问 ${details.url}`)
      callback({ cancel: true })
    }
  )
}

export function initializeMainProcessRuntime(getMainWindow: () => BrowserWindow | null): void {
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
  app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process')
  app.commandLine.appendSwitch('disable-site-isolation-trials')

  registerProcessErrorHandlers()
  registerLocalMediaScheme()
  registerWebContentsPolicies(getMainWindow)
}

export async function setupReadyAppRuntime(): Promise<void> {
  protocol.handle('local-media', handleLocalMediaRequest)
  console.log('[App] local-media:// 协议已注册')

  Menu.setApplicationMenu(null)
  electronApp.setAppUserModelId('com.electron')

  process.on('SIGINT', createQuitHandler('SIGINT'))
  process.on('SIGTERM', createQuitHandler('SIGTERM'))

  configureDefaultSession()
}
