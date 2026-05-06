// packages/app/src/preload/index.d.ts
import type { ElectronAPI } from '@electron-toolkit/preload'
import type { Api } from '@shared/api'
import type { BuiltInPath, WinBridge } from '@shared/utils/utilWindow'

export type ElectronFileBridge = {
  getPathForFile(file: File): string
}

declare global {
  interface Window {
    electron: ElectronAPI
    electronFile?: ElectronFileBridge
    api: Api
    path: BuiltInPath
    win: WinBridge
  }
}
export {}
