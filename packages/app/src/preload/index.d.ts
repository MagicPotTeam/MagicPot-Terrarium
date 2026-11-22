// packages/app/src/preload/index.d.ts
import type { Api } from '@shared/api'
import type {
  AppDiagnosticsBridge,
  AppEventBridge,
  BuiltInPath,
  CanvasScreenshotBridge,
  WinBridge
} from '@shared/utils/utilWindow'

/**
 * A one-use grant from main: the canonical path and its size when granted. bytesOnly: a file
 * on a network path (mapped drive) that main reads once for the page instead (`path` is then
 * the dropped path).
 */
export type LocalMediaImportGrant = { path: string; sizeBytes: number; bytesOnly?: true }
/**
 * main's answer for a picked file: the canonical path, or why there is none: no answer in
 * time, a network path main imports only as bytes (mapped drive), or any other refusal.
 */
export type LocalMediaFileImportAnswer =
  | { path: string }
  | { refused: 'timeout' | 'network' | 'denied' }

export type ElectronFileBridge = {
  getPathForFile(file: File): string
  authorizeLocalMediaFile(file: File): Promise<string>
  authorizeLocalMediaFileForImport(file: File, mimeType: string): Promise<LocalMediaFileImportAnswer>
  authorizeDroppedLocalImage(canonicalUrl: string): Promise<string>
  authorizeDroppedLocalImageForImport(
    canonicalUrl: string,
    mimeType: string
  ): Promise<LocalMediaImportGrant | null>
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
