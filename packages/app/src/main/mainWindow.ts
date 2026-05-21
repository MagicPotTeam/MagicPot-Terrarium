import { app, BrowserWindow, ipcMain, nativeImage, screen, shell } from 'electron'
import * as fs from 'fs'
import { basename, extname, join } from 'path'
import icon from '../../../runtime-assets/resources/icon.png?asset'
import { isDev } from './config/buildEnv'
import { resolveTestArtifactPath } from './testUiPolicy'
import {
  getTestWindowPolicy,
  resolveConfiguredTestWindowPlacement,
  showWindowForTestPolicy
} from './testWindowRuntime'
import { attachRendererDiagnostics } from './rendererDiagnostics'
import { winController } from './winControls'
import { attachWindowStatePersistence, readWindowState, type WindowState } from './windowState'

type CanvasStartSystemDragPayload = {
  files: Array<{
    data: Uint8Array
    fileName: string
  }>
  iconDataUrl?: string
}

const testUiPolicy = getTestWindowPolicy()
let canvasStartSystemDragRegistered = false

function sanitizeDragFileName(fileName: string): string {
  const trimmed = (fileName || '').trim()
  const baseName = [...basename(trimmed || 'canvas-selection.png')]
    .map((char) => {
      const code = char.charCodeAt(0)
      return code <= 0x1f || '<>:"/\\|?*'.includes(char) ? '_' : char
    })
    .join('')

  if (!baseName) {
    return 'canvas-selection.png'
  }
  if (extname(baseName)) {
    return baseName
  }
  return `${baseName}.png`
}

function registerCanvasStartSystemDrag(): void {
  if (canvasStartSystemDragRegistered) {
    return
  }

  ipcMain.handle(
    'canvas:start-system-drag',
    async (event, payload: CanvasStartSystemDragPayload): Promise<{ filePath: string }> => {
      const tempDir = resolveTestArtifactPath({
        desktopPath: app.getPath('desktop'),
        tempPath: app.getPath('temp'),
        policy: testUiPolicy,
        segments: ['drag']
      })
      fs.mkdirSync(tempDir, { recursive: true })

      const filePaths = payload.files.map((file) => {
        const fileName = sanitizeDragFileName(file.fileName)
        const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const fullPath = join(tempDir, `${uniquePrefix}-${fileName}`)
        fs.writeFileSync(fullPath, Buffer.from(file.data))
        return fullPath
      })

      const dragIcon =
        payload.iconDataUrl && payload.iconDataUrl.startsWith('data:')
          ? nativeImage.createFromDataURL(payload.iconDataUrl)
          : nativeImage.createFromPath(icon)

      event.sender.startDrag({
        file: filePaths[0],
        files: filePaths,
        icon: dragIcon.isEmpty() ? nativeImage.createFromPath(icon) : dragIcon
      })

      return { filePath: filePaths[0] }
    }
  )

  canvasStartSystemDragRegistered = true
}

function resolveInitialWindowState(statePath: string): {
  state: WindowState
  hasSavedState: boolean
} {
  const { state, hasSavedState } = readWindowState(statePath)

  if (state.x === undefined || state.y === undefined) {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize
    state.x = Math.max(0, Math.floor((screenWidth - state.width) / 2))
    state.y = Math.max(0, screenHeight - state.height)
  }

  const testWindowPlacement = resolveConfiguredTestWindowPlacement(state.width, state.height)
  if (testWindowPlacement) {
    state.x = testWindowPlacement.x
    state.y = testWindowPlacement.y
  }

  return { state, hasSavedState }
}

function loadWindowContent(window: BrowserWindow): void {
  if (isDev() && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
    return
  }

  window.loadFile(join(__dirname, '../renderer/index.html'))
}

export function createMainWindow(): BrowserWindow {
  registerCanvasStartSystemDrag()

  const statePath = join(app.getPath('userData'), 'window-state.json')
  const { state, hasSavedState } = resolveInitialWindowState(statePath)

  const mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    show: false,
    focusable: !testUiPolicy.noFocus,
    skipTaskbar: testUiPolicy.suppressTaskbar,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true,
      devTools: !app.isPackaged
    }
  })

  attachWindowStatePersistence(mainWindow, statePath)
  winController.registerWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    if (!testUiPolicy.suppressTaskbar && hasSavedState && state.isMaximized) {
      mainWindow.maximize()
    }
    if (!testUiPolicy.hideWindow) {
      showWindowForTestPolicy(mainWindow)
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  attachRendererDiagnostics(mainWindow)
  loadWindowContent(mainWindow)

  return mainWindow
}
