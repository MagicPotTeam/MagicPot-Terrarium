// packages/app/src/preload/index.d.ts
import type { ElectronAPI } from '@electron-toolkit/preload'
import type { Api } from '@shared/api'
import type { BuiltInPath, WinBridge } from '@shared/utils/utilWindow'

export type ElectronFileBridge = {
  getPathForFile(file: File): string
}

export type ProjectCanvasBenchmarkRuntimeBridge = Readonly<{
  enabled: boolean
  canvasImportTotalSize?: number
  sharedThumbnailCacheRoot?: string
}>

declare global {
  interface Window {
    electron: ElectronAPI
    electronFile?: ElectronFileBridge
    api: Api
    path: BuiltInPath
    win: WinBridge
    magicpotProjectCanvasBenchmarkRuntime?: ProjectCanvasBenchmarkRuntimeBridge
  }
}
export {}
