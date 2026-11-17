import { app, BrowserWindow, ipcMain, nativeImage, screen, shell } from 'electron'
import * as fs from 'fs'
import { basename, extname, join } from 'path'
import { pathToFileURL } from 'url'
import icon from '../../../runtime-assets/resources/icon.png?asset'
import { isDev } from './config/buildEnv'
import { resolveTestArtifactPath } from './testUiPolicy'
import {
  getTestWindowPolicy,
  resolveConfiguredTestWindowPlacement,
  showWindowForTestPolicy
} from './testWindowRuntime'
import { attachRendererDiagnostics } from './rendererDiagnostics'
import { getAuthoritativeMainWindow, winController } from './winControls'
import { attachWindowStatePersistence, readWindowState, type WindowState } from './windowState'
import { normalizeAllowedExternalUrl } from './utils/externalUrl'
import { isTrustedRendererNavigation } from './utils/rendererNavigation'
import { authorizeScopedLocalMediaPath } from './localMediaAccess'
import { installInstalledCatalogReadBinding } from './magicAgentRuntime/installedCatalogReadBinding'
import { installStartupStorageReadBinding } from './storageMetadata/startupStorageReadBinding'
import { AGENT_PROCESS_JOB_LIMITS } from '@shared/api/agentThreadProcessJob'
import {
  registerMagicAgentTrustedRouteBinding,
  unregisterMagicAgentTrustedRouteBinding
} from './magicAgentRuntime/trustedRouteBinding'

type CanvasStartSystemDragPayload = {
  files: Array<{
    data: Uint8Array
    fileName: string
  }>
  iconDataUrl?: string
}

const testUiPolicy = getTestWindowPolicy()
let canvasStartSystemDragRegistered = false

/**
 * What the window shows while no page is painted: before the first paint, during a reload and
 * while a dead renderer is being replaced. It is the dark theme's background (renderer/src/theme.ts,
 * the app starts in dark mode), so a renderer death is a short dark frame instead of a white sheet.
 * The light theme choice lives in the renderer's storage and is not known here without a read.
 */
export const MAIN_WINDOW_BACKGROUND_COLOR = '#1a1a1a'

/**
 * Listener limit of the main window's WebContents. Its 'render-process-gone' / 'destroyed' /
 * 'did-start-navigation' listeners are bounded by design, not leaked: measured in the real app,
 * 10 'render-process-gone' listeners right after the start, unchanged after 2 more threads and 5
 * reloads; a running send adds a few (its IPC stream and its Agent thread interaction lease) and
 * removes them when it ends. Each retained Agent background process keeps its interaction lease
 * (three listeners, one of each) until the entry is removed, up to retainedGlobal entries for up to
 * 15 min after the process ended (api/agentThreadProcesses.ts). The limit is that bound plus room
 * for the fixed listeners and the running sends, so only a real leak (per reload or per request)
 * warns.
 */
export const MAIN_WINDOW_WEB_CONTENTS_MAX_LISTENERS = AGENT_PROCESS_JOB_LIMITS.retainedGlobal + 64

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
        tempPath: join(app.getPath('temp'), 'magicpot-local-media'),
        policy: testUiPolicy,
        segments: ['drag']
      })
      fs.mkdirSync(tempDir, { recursive: true })

      const filePaths = payload.files.map((file) => {
        const fileName = sanitizeDragFileName(file.fileName)
        const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const fullPath = join(tempDir, `${uniquePrefix}-${fileName}`)
        fs.writeFileSync(fullPath, Buffer.from(file.data))
        authorizeScopedLocalMediaPath(fullPath)
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

function resolveMainWindowRendererUrl(): string {
  if (isDev() && process.env['ELECTRON_RENDERER_URL']) {
    return process.env['ELECTRON_RENDERER_URL']
  }
  return pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
}

function loadWindowContent(window: BrowserWindow, rendererUrl: string): void {
  window.loadURL(rendererUrl)
}

export function createMainWindow(onCreated?: (window: BrowserWindow) => void): BrowserWindow {
  registerCanvasStartSystemDrag()

  const statePath = join(app.getPath('userData'), 'window-state.json')
  const { state, hasSavedState } = resolveInitialWindowState(statePath)

  const mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    show: false,
    backgroundColor: MAIN_WINDOW_BACKGROUND_COLOR,
    focusable: !testUiPolicy.noFocus,
    skipTaskbar: testUiPolicy.suppressTaskbar,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: !testUiPolicy.hideWindow,
      devTools: !app.isPackaged
    }
  })

  // Electron's forwarder, renderer diagnostics, both read admissions, one per open IPC stream, one per Agent thread interaction lease (scope bindings + running requests) and one per retained Agent background process.
  mainWindow.webContents.setMaxListeners(MAIN_WINDOW_WEB_CONTENTS_MAX_LISTENERS)

  const trustedRendererUrl = resolveMainWindowRendererUrl()
  const disposeCatalogBinding = installInstalledCatalogReadBinding(mainWindow, trustedRendererUrl, () => winController.getMainWindow())
  let disposeStorageBinding: (() => void) | undefined
  try {
    disposeStorageBinding = installStartupStorageReadBinding(mainWindow, trustedRendererUrl, getAuthoritativeMainWindow)
    onCreated?.(mainWindow)
    ;(mainWindow as BrowserWindow & { [key: symbol]: boolean | undefined })[
      Symbol.for('magicpot.testWindowRuntime.skipTaskbar')
    ] = testUiPolicy.suppressTaskbar ? true : undefined

    attachWindowStatePersistence(mainWindow, statePath)
    winController.registerWindow(mainWindow)
    const senderId = mainWindow.webContents.id
    registerMagicAgentTrustedRouteBinding(senderId, undefined, {
      trustedUrl: trustedRendererUrl,
      trustedWebContents: mainWindow.webContents
    })
    mainWindow.on('closed', () => {
      try { disposeStorageBinding?.() } finally {
        try { disposeCatalogBinding() } finally { unregisterMagicAgentTrustedRouteBinding(senderId) }
      }
    })

    mainWindow.on('ready-to-show', () => {
      if (!testUiPolicy.suppressTaskbar && hasSavedState && state.isMaximized) {
        mainWindow.maximize()
      }
      if (!testUiPolicy.hideWindow) {
        showWindowForTestPolicy(mainWindow)
      }
    })

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (isTrustedRendererNavigation(url, trustedRendererUrl)) {
        return
      }

      event.preventDefault()
      console.warn('[App] blocked untrusted renderer navigation:', url)
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      try {
        shell.openExternal(normalizeAllowedExternalUrl(details.url))
      } catch (error) {
        console.warn('[App] blocked unsafe external URL:', details.url, error)
      }
      return { action: 'deny' }
    })

    attachRendererDiagnostics(mainWindow)
    loadWindowContent(mainWindow, trustedRendererUrl)

    return mainWindow
  } catch (error) {
    try { disposeStorageBinding?.() } catch { /* Never skip the other independent owner. */ }
    try { disposeCatalogBinding() } catch { /* Preserve the original setup failure, never repair authority here. */ }
    throw error
  }
}
