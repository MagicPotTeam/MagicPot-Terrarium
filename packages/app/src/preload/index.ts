// packages/app/src/preload/index.ts
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { newApiIpc } from './apiIpc'
import pkgPath from 'path'
import type {
  AppDiagnosticsBridge,
  AppEventBridge,
  BuiltInPath,
  CanvasScreenshotBridge
} from '@shared/utils/utilWindow'
import type { Api } from '@shared/api'
import { winBridge } from './winBridge'
import {
  createExternalImageDropAuthorization,
  type DroppedLocalImageImportGrant
} from './externalImageDropLease'
import {
  parseRendererRecoveredEvent,
  RENDERER_RECOVERED_CHANNEL,
  type RendererRecoveredEvent
} from '@shared/utils/rendererRecoveryEvent'
import {
  CHAT_SEND_STAGE_CHANNEL,
  parseChatSendStageBreadcrumb,
  withJsHeapNumbers
} from '@shared/utils/chatSendStageBreadcrumb'

// 渲染进程的自定义 API
const api: Api = newApiIpc()
const path: BuiltInPath = pkgPath as unknown as BuiltInPath
const droppedLocalImages = createExternalImageDropAuthorization({
  target: typeof window === 'undefined' ? undefined : window,
  authorizePath: authorizeLocalMediaFilePath,
  authorizeImportPath: async (filePath, mimeType, dropId) => {
    const answer = await requestLocalMediaImportGrant(filePath, mimeType, dropId)
    if (answer && 'path' in answer) return answer
    // A mapped network drive: main read-granted the file once; the page reads it as bytes.
    if (answer?.refused === 'network' && answer.sizeBytes !== undefined)
      return { path: filePath, sizeBytes: answer.sizeBytes, bytesOnly: true }
    return null
  }
})
const electronFile = {
  getPathForFile(file: unknown): string {
    try {
      return (webUtils.getPathForFile as (target: unknown) => string)(file) || ''
    } catch {
      return ''
    }
  },
  async authorizeLocalMediaFile(file: unknown): Promise<string> {
    try {
      const filePath = (webUtils.getPathForFile as (target: unknown) => string)(file) || ''
      return (await authorizeLocalMediaFilePath(filePath)) ? filePath : ''
    } catch {
      return ''
    }
  },
  /**
   * One-use, in-memory import grant for a File the user picked or dropped: main records it
   * only for a type it imports and a path it would import, and returns the canonical path
   * ('' otherwise). The path comes only from webUtils.getPathForFile of a real File, never
   * from a string the page passes.
   */
  async authorizeLocalMediaFileForImport(
    file: unknown,
    mimeType: unknown
  ): Promise<LocalMediaFileImportAnswer> {
    try {
      const filePath = (webUtils.getPathForFile as (target: unknown) => string)(file) || ''
      if (!filePath || typeof mimeType !== 'string') return { refused: 'denied' }
      const answer = await requestLocalMediaImportGrant(filePath, mimeType)
      if (!answer) return { refused: 'denied' }
      return 'path' in answer ? { path: answer.path } : { refused: answer.refused }
    } catch {
      return { refused: 'denied' }
    }
  },
  authorizeDroppedLocalImage(canonicalUrl: string): Promise<string> {
    return droppedLocalImages.authorizeDroppedLocalImage(canonicalUrl)
  },
  /**
   * One-use, in-memory import grant for a file URL of the current trusted drop (the private
   * drop lease decides which URLs qualify): main's canonical path and size, or null. No
   * persisted grant is recorded and no bytes reach the page.
   */
  authorizeDroppedLocalImageForImport(
    canonicalUrl: string,
    mimeType: string
  ): Promise<DroppedLocalImageImportGrant | null> {
    return droppedLocalImages.authorizeDroppedLocalImageForImport(canonicalUrl, mimeType)
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

// The recovery notice is sent on did-finish-load, which can come before the app shell has
// subscribed. Listen from the start of this page and keep the event for the first subscriber.
let undeliveredRendererRecovery: RendererRecoveredEvent | null = null
const rendererRecoveryListeners = new Set<(event: RendererRecoveredEvent) => void>()
ipcRenderer.on(RENDERER_RECOVERED_CHANNEL, (_event, payload: unknown) => {
  const recovery = parseRendererRecoveredEvent(payload)
  if (!recovery) return
  if (rendererRecoveryListeners.size === 0) {
    undeliveredRendererRecovery = recovery
    return
  }
  for (const listener of rendererRecoveryListeners) listener(recovery)
})

function subscribeToRendererRecovery(cb: (event: RendererRecoveredEvent) => void): () => void {
  rendererRecoveryListeners.add(cb)
  const pending = undeliveredRendererRecovery
  undeliveredRendererRecovery = null
  if (pending) cb(pending)
  return () => {
    rendererRecoveryListeners.delete(cb)
  }
}

const appEvents: AppEventBridge = {
  onCloseActiveTab: (cb) => subscribeToMainEvent('app:close-tab', cb),
  onQAppDirectoryChanged: (cb) => subscribeToMainEvent('qapp:dir-changed', cb),
  onRendererRecovered: subscribeToRendererRecovery
}

const BYTES_PER_KB = 1024

// The JS heap of this renderer, from V8 itself (Electron reports it in KB). The page is not asked:
// its performance.memory is quantised and cached, and stayed at 26 MB during a real out-of-memory
// death. Reading the statistics allocates nothing in the heap beyond one small object.
function readJsHeapNumbers(): { usedJSHeapSize: number; jsHeapSizeLimit: number } | null {
  try {
    const statistics = typeof process.getHeapStatistics === 'function' ? process.getHeapStatistics() : null
    if (!statistics) return null
    return {
      usedJSHeapSize: Math.round(statistics.usedHeapSize * BYTES_PER_KB),
      jsHeapSizeLimit: Math.round(statistics.heapSizeLimit * BYTES_PER_KB)
    }
  } catch {
    return null
  }
}

// Fire-and-forget: one small breadcrumb per chat send stage. The page supplies counts and sizes
// only; the JS heap size is added here.
const appDiagnostics: AppDiagnosticsBridge = {
  reportChatSendStage: (breadcrumb) => {
    const checked = parseChatSendStageBreadcrumb(breadcrumb)
    if (checked) ipcRenderer.send(CHAT_SEND_STAGE_CHANNEL, withJsHeapNumbers(checked, readJsHeapNumbers()))
  }
}

async function authorizeLocalMediaFilePath(filePath: string): Promise<boolean> {
  if (!filePath) return false
  try {
    // Paths come only from native File objects or the private trusted-drop lease.
    return (await ipcRenderer.invoke('local-media:authorize-picker-path', filePath)) === true
  } catch {
    return false
  }
}

/**
 * The picked file's one-use import grant: main's canonical path, or why there is none (no
 * answer in time, a network path main imports only as bytes, or any other refusal).
 */
type LocalMediaFileImportAnswer = { path: string } | { refused: 'timeout' | 'network' | 'denied' }
type LocalMediaImportGrantRefusal =
  { refused: 'timeout' } | { refused: 'network'; sizeBytes?: number }

/** Main's one-use import grant for a path the preload itself obtained, or why not, or null. */
async function requestLocalMediaImportGrant(
  filePath: string,
  mimeType: string,
  dropId?: string
): Promise<DroppedLocalImageImportGrant | LocalMediaImportGrantRefusal | null> {
  if (!filePath) return null
  try {
    const granted: unknown = await ipcRenderer.invoke(
      'local-media:authorize-import-path',
      filePath,
      mimeType,
      ...(dropId ? [dropId] : [])
    )
    const refusal = (granted as { refused?: unknown } | null)?.refused
    if (refusal === 'timeout') return { refused: 'timeout' }
    if (refusal === 'network') {
      const sizeBytes = (granted as { sizeBytes?: unknown }).sizeBytes
      return Number.isSafeInteger(sizeBytes) && (sizeBytes as number) >= 0
        ? { refused: 'network', sizeBytes: sizeBytes as number }
        : { refused: 'network' }
    }
    const candidate = granted as Partial<DroppedLocalImageImportGrant> | null
    return candidate &&
      typeof candidate.path === 'string' &&
      candidate.path &&
      Number.isSafeInteger(candidate.sizeBytes) &&
      (candidate.sizeBytes as number) >= 0
      ? { path: candidate.path, sizeBytes: candidate.sizeBytes as number }
      : null
  } catch {
    return null
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
    contextBridge.exposeInMainWorld('appDiagnostics', appDiagnostics)
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
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- diagnostics bridge is injected at runtime
  // @ts-ignore
  window.appDiagnostics = appDiagnostics
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
