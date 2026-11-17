// packages/app/src/preload/index.d.ts
import type { Api } from '@shared/api'
import type {
  AppDiagnosticsBridge,
  AppEventBridge,
  BuiltInPath,
  CanvasScreenshotBridge,
  WinBridge
} from '@shared/utils/utilWindow'

export type ElectronFileBridge = {
  getPathForFile(file: File): string
  authorizeLocalMediaFile(file: File): Promise<string>
  authorizeLocalMediaFileForImport(file: File, mimeType: string): Promise<string>
  authorizeDroppedLocalImage(canonicalUrl: string): Promise<string>
  resolveAuthorizedLocalMediaPath(filePath: string): Promise<string>
}

export type ProjectCanvasBenchmarkRuntimeBridge = Readonly<{
  enabled: boolean
  canvasImportTotalSize?: number
  sharedThumbnailCacheRoot?: string
}>

declare global {
  interface Window {
    appEvents?: AppEventBridge
    appDiagnostics?: AppDiagnosticsBridge
    canvasScreenshot?: CanvasScreenshotBridge
    electronFile?: ElectronFileBridge
    api: Api
    path: BuiltInPath
    win: WinBridge
    magicpotProjectCanvasBenchmarkRuntime?: ProjectCanvasBenchmarkRuntimeBridge
  }
}
export {}
