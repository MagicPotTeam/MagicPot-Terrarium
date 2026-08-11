// packages/app/src/main/index.ts
import './utils/loggingOverride'
import fs from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import {
  getAppStartupTestWindowPolicy,
  initializeMainProcessRuntime,
  setupReadyAppRuntime
} from './appRuntime'
import { resolveStartupUserDataDirectory } from './config/userDataDirectory'
import { beforeQuit, beforeShow } from './lifeCycle'
import { runMagicAgentApprovalSmoke } from './magicAgentPlatform2/productionRuntime'
import { createMainWindow } from './mainWindow'
import { startQAppWatcher, stopQAppWatcher } from './qApp/watcher'
import { cleanupScreenshotManager, initScreenshotManager } from './screenshot/screenshotManager'
import { confirmLauncherHealth, startLauncherSmokeTest } from './appUpdate/appLauncherBridge'
import { initializeAppUpdateManager, isAppUpdateInstallInProgress } from './appUpdate/updateManager'
import { winController } from './winControls'
import { flushLocalMediaAccessGrants } from './localMediaAccess'

const startupUserData = resolveStartupUserDataDirectory()
fs.mkdirSync(startupUserData.path, { recursive: true })
app.setPath('userData', startupUserData.path)

function setPortableAppPath(name: string, targetPath: string): void {
  try {
    fs.mkdirSync(targetPath, { recursive: true })
    app.setPath(name, targetPath)
  } catch (error) {
    console.warn(`[App] Failed to set portable ${name} path:`, error)
  }
}

setPortableAppPath('sessionData', path.join(startupUserData.path, 'sessionData'))
setPortableAppPath('logs', path.join(startupUserData.path, 'logs'))
setPortableAppPath('crashDumps', path.join(startupUserData.path, 'crashDumps'))
const portableTempPath = path.join(startupUserData.path, 'runtime', 'temp')
setPortableAppPath('temp', portableTempPath)
process.env.TEMP = portableTempPath
process.env.TMP = portableTempPath
process.env.TMPDIR = portableTempPath

if (startupUserData.source === 'env') {
  console.log(`[App] Using env userData: ${startupUserData.path}`)
} else if (startupUserData.source === 'persisted') {
  console.log(`[App] Using configured userData: ${startupUserData.path}`)
} else if (!app.isPackaged) {
  console.log(`[App] Development userData: ${startupUserData.path}`)
} else {
  console.log(`[App] Production userData: ${startupUserData.path}`)
}

let mainWindow: BrowserWindow | null = null
const launcherSmokeTest = startLauncherSmokeTest({ app })

if (!launcherSmokeTest) initializeMainProcessRuntime(() => mainWindow)

function createWindow(onCreated: (window: BrowserWindow) => void): BrowserWindow {
  const startupPolicy = getAppStartupTestWindowPolicy()
  if (startupPolicy.automatedRun && !startupPolicy.windowMode) {
    throw new Error('Automated startup window policy is incomplete: missing window mode.')
  }

  return createMainWindow(onCreated)
}

async function initializeWindowServices(window: BrowserWindow): Promise<void> {
  initScreenshotManager(window)
  console.log('[App] 截图管理器已启动')
  startQAppWatcher(window)
  console.log('[App] 快应用目录监视已启动')
  await initializeAppUpdateManager()
}

function nextEventTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function confirmHealthyStartup(
  window: BrowserWindow,
  servicesReady: Promise<void>
): Promise<void> {
  if (typeof window.once !== 'function' || typeof window.webContents?.once !== 'function') return

  let failed = false
  let markReady = (): void => undefined
  const rendererReady = new Promise<void>((resolve) => {
    markReady = resolve
  })
  const fail = (): void => {
    failed = true
  }
  const didFailLoad = (_event: unknown, ...args: unknown[]): void => {
    const isMainFrame = args[3]
    if (isMainFrame !== false) fail()
  }

  window.once('ready-to-show', markReady)
  window.webContents.once('did-finish-load', markReady)
  window.once('closed', fail)
  window.webContents.once('render-process-gone', fail)
  window.webContents.once('did-fail-load', didFailLoad)

  try {
    await Promise.all([rendererReady, servicesReady])
    await nextEventTurn()
    if (!failed && !window.isDestroyed()) await confirmLauncherHealth({ app })
  } catch (error) {
    console.error('[App] Startup did not become healthy:', error)
  } finally {
    window.removeListener('closed', fail)
    window.webContents.removeListener('render-process-gone', fail)
    window.webContents.removeListener('did-fail-load', didFailLoad)
  }
}

function openMainWindow(): void {
  let servicesReady: Promise<void> | undefined
  const window = createWindow((createdWindow) => {
    mainWindow = createdWindow
    servicesReady = initializeWindowServices(createdWindow)
    void confirmHealthyStartup(createdWindow, servicesReady)
  })
  mainWindow = window
  if (!servicesReady) {
    servicesReady = initializeWindowServices(window)
    void confirmHealthyStartup(window, servicesReady)
  }
}

if (!launcherSmokeTest)
  app.whenReady().then(async () => {
    await setupReadyAppRuntime()

    console.log('[App] 正在准备显示窗口...')
    try {
      await beforeShow()
      console.log('[App] beforeShow 完成')
      openMainWindow()
      const approvalSmokeMarker = process.env['MAGICPOT_APPROVAL_SMOKE_MARKER']?.trim()
      if (approvalSmokeMarker && process.env['MAGICPOT_APPROVAL_SMOKE'] === '1') {
        void runMagicAgentApprovalSmoke(approvalSmokeMarker).catch((error) => {
          console.error('MagicAgent approval smoke failed:', error)
          // Keep the smoke-only app alive so the harness can read the durable failure marker.
          // The harness owns shutdown for this explicitly environment-gated path.
        })
      }
      console.log('[App] createWindow 已调用')
    } catch (error) {
      console.error('[App] beforeShow 或 createWindow 出错:', error)
      openMainWindow()
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        openMainWindow()
      }
    })
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async (event) => {
  flushLocalMediaAccessGrants()
  console.log('[App] 应用即将退出...')
  if (isAppUpdateInstallInProgress()) {
    cleanupScreenshotManager()
    stopQAppWatcher()
    return
  }

  event.preventDefault()
  if (!(await winController.confirmAppQuit())) return
  cleanupScreenshotManager()
  stopQAppWatcher()
  await beforeQuit()
  app.exit(0)
})
