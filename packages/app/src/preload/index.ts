// packages/app/src/preload/index.ts
import { contextBridge, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { newApiIpc } from './apiIpc'
import pkgPath from 'path'
import type { BuiltInPath } from '@shared/utils/utilWindow'
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
    contextBridge.exposeInMainWorld('electron', electronAPI)
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
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- electronAPI 在运行时由 electron-toolkit 注入
  // @ts-ignore
  window.electron = electronAPI
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
