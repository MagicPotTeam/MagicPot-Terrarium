// packages/app/src/preload/index.ts
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { newApiIpc } from './apiIpc'
import pkgPath from 'path'
import type { AppEventBridge, BuiltInPath, CanvasScreenshotBridge } from '@shared/utils/utilWindow'
import type { Api } from '@shared/api'
import { winBridge } from './winBridge'

// 渲染进程的自定义 API
const api: Api = newApiIpc()
const path: BuiltInPath = pkgPath as unknown as BuiltInPath
const electronFile = {
  getPathForFile(file: unknown): string {
    try {
      return (webUtils.getPathForFile as (target: unknown) => string)(file) || ''
    } catch {
      return ''
    }
  },
  authorizeLocalMediaFile(file: unknown): string {
    try {
      const filePath = (webUtils.getPathForFile as (target: unknown) => string)(file) || ''
      return authorizeLocalMediaFilePath(filePath) ? filePath : ''
    } catch {
      return ''
    }
  },
  async resolveAuthorizedLocalMediaPath(filePath: string): Promise<string> {
    try {
      return (await ipcRenderer.invoke('local-media:resolve-scoped-path', filePath)) || ''
    } catch {
      return ''
    }
  }
}

type ProjectCanvasBenchmarkRuntimeBridge = Readonly<{
  enabled: boolean
  canvasImportTotalSize?: number
  sharedThumbnailCacheRoot?: string
}>

function isTruthyEnvValue(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(`${value || ''}`.trim())
}

function readNonNegativeIntegerEnv(name: string): number | undefined {
  const value = Number.parseInt(`${process.env[name] || ''}`, 10)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function readNonEmptyStringEnv(name: string): string | undefined {
  const value = `${process.env[name] || ''}`.trim()
  return value ? value : undefined
}

function createProjectCanvasBenchmarkRuntime(): ProjectCanvasBenchmarkRuntimeBridge {
  const enabled = isTruthyEnvValue(process.env['MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK'])
  if (!enabled) {
    return Object.freeze({ enabled: false })
  }

  const canvasImportTotalSize = readNonNegativeIntegerEnv(
    'MAGICPOT_REAL_BOARD_CANVAS_IMPORT_TOTAL_SIZE'
  )
  const sharedThumbnailCacheRoot = readNonEmptyStringEnv(
    'MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT'
  )

  return Object.freeze({
    enabled: true,
    ...(canvasImportTotalSize !== undefined ? { canvasImportTotalSize } : {}),
    ...(sharedThumbnailCacheRoot !== undefined ? { sharedThumbnailCacheRoot } : {})
  })
}

const projectCanvasBenchmarkRuntime = createProjectCanvasBenchmarkRuntime()
const canvasScreenshot: CanvasScreenshotBridge = {
  capture: () => ipcRenderer.invoke('screenshot:capture'),
  getShortcut: () => ipcRenderer.invoke('screenshot:getShortcut'),
  setShortcut: (accelerator, reservedShortcuts) =>
    ipcRenderer.invoke('screenshot:setShortcut', accelerator, reservedShortcuts),
  selectRegion: (region) => ipcRenderer.send('screenshot:region', region),
  cancelSelection: () => ipcRenderer.send('screenshot:cancel'),
  setFloatingOpacity: (windowId, opacity) =>
    ipcRenderer.send('floating:opacity', windowId, opacity),
  closeFloatingWindow: (windowId) => ipcRenderer.send('floating:close', windowId),
  sendFloatingToCanvas: (windowId) => ipcRenderer.send('floating:to-canvas', windowId),
  onAddImage: (cb) => {
    const listener = (_event: unknown, dataUrl: string) => cb(dataUrl)
    ipcRenderer.on('canvas:add-image', listener)
    return () => ipcRenderer.removeListener('canvas:add-image', listener)
  }
}

function subscribeToMainEvent(channel: 'app:close-tab' | 'qapp:dir-changed', cb: () => void) {
  const listener = () => cb()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const appEvents: AppEventBridge = {
  onCloseActiveTab: (cb) => subscribeToMainEvent('app:close-tab', cb),
  onQAppDirectoryChanged: (cb) => subscribeToMainEvent('qapp:dir-changed', cb)
}

function authorizeLocalMediaFilePath(filePath: string): boolean {
  if (!filePath) return false
  try {
    // The picker/drag File object is validated in preload with webUtils, so the renderer
    // cannot manufacture an arbitrary absolute path for this capability.
    return ipcRenderer.sendSync('local-media:authorize-picker-path', filePath) === true
  } catch {
    return false
  }
}

function defineImmutableMainWorldValue(name: string, value: unknown): void {
  Object.defineProperty(window, name, {
    value,
    enumerable: true,
    configurable: false,
    writable: false
  })
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('canvasScreenshot', canvasScreenshot)
    contextBridge.exposeInMainWorld('appEvents', appEvents)
    contextBridge.exposeInMainWorld('electronFile', electronFile)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('path', path)
    contextBridge.exposeInMainWorld('win', winBridge)
    contextBridge.exposeInMainWorld(
      'magicpotProjectCanvasBenchmarkRuntime',
      projectCanvasBenchmarkRuntime
    )
  } catch (error) {
    console.error('[preload] exposeInMainWorld error:', error)
  }
} else {
  // 非隔离环境降级：直接挂到 window（开发/特殊配置下使用）
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- screenshot bridge is injected at runtime
  // @ts-ignore
  window.canvasScreenshot = canvasScreenshot
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- named app event bridge is injected at runtime
  // @ts-ignore
  window.appEvents = appEvents
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Electron file bridge is injected at runtime
  // @ts-ignore
  window.electronFile = electronFile
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- 自定义 API 运行时注入到 window
  // @ts-ignore
  window.api = api
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- path polyfill 暴露到 window
  // @ts-ignore
  window.path = path
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- winBridge 暴露给 TitleBar 控制窗口
  // @ts-ignore
  window.win = winBridge
  defineImmutableMainWorldValue(
    'magicpotProjectCanvasBenchmarkRuntime',
    projectCanvasBenchmarkRuntime
  )
}
