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
import { createMainWindow } from './mainWindow'
import { startQAppWatcher, stopQAppWatcher } from './qApp/watcher'
import { cleanupScreenshotManager, initScreenshotManager } from './screenshot/screenshotManager'
import { initializeAppUpdateManager, isAppUpdateInstallInProgress } from './appUpdate/updateManager'

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

initializeMainProcessRuntime(() => mainWindow)

function createWindow(): void {
  const startupPolicy = getAppStartupTestWindowPolicy()
  if (!startupPolicy.automatedRun) {
    mainWindow = createMainWindow()
    return
  }

  if (!startupPolicy.windowMode) {
    throw new Error('Automated startup window policy is incomplete: missing window mode.')
  }

  mainWindow = createMainWindow()
}

function initializeWindowServices(): void {
  if (!mainWindow) {
    return
  }

  initScreenshotManager(mainWindow)
  console.log('[App] 截图管理器已启动')
  startQAppWatcher(mainWindow)
  console.log('[App] 快应用目录监视已启动')
  void initializeAppUpdateManager()
}

function openMainWindow(): void {
  createWindow()
  initializeWindowServices()
}

app.whenReady().then(async () => {
  await setupReadyAppRuntime()

  console.log('[App] 正在准备显示窗口...')
  try {
    await beforeShow()
    console.log('[App] beforeShow 完成')
    openMainWindow()
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
  console.log('[App] 应用即将退出...')
  if (isAppUpdateInstallInProgress()) {
    cleanupScreenshotManager()
    stopQAppWatcher()
    return
  }

  event.preventDefault()
  cleanupScreenshotManager()
  stopQAppWatcher()
  await beforeQuit()
  app.exit(0)
})
