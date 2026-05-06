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

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('electronFile', electronFile)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('path', path)
    contextBridge.exposeInMainWorld('win', winBridge)
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
}
