/**
 * Electron 的 Shell API 在一些平台上在 Renderer 进程中调用会造成卡死
 * 这里单独包装一个服务，在 Main 进程中调用
 */

import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type DownloadFileReq = {
  url: string
  outputDir: string
  filename: string
}

export type DownloadFileResp = {
  fullPath: string
  alreadyExists: boolean
}

export type EnsureDirectoryReq = {
  path: string
}

export type EnsureDirectoryResp = {
  path: string
}

export type InstallGitRepositoryReq = {
  url: string
  outputDir: string
  directoryName: string
}

export type InstallGitRepositoryResp = {
  targetDir: string
  alreadyExists: boolean
}

export type ShellSvc = {
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  getHomeDir(): Promise<string>
  fileExists(path: string): Promise<boolean>
  fileExistsBatch(paths: string[]): Promise<boolean[]>
  ensureDirectory(req: EnsureDirectoryReq): Promise<EnsureDirectoryResp>
  downloadFile(req: DownloadFileReq): Promise<DownloadFileResp>
  installGitRepository(req: InstallGitRepositoryReq): Promise<InstallGitRepositoryResp>
}

export const shellSvcDef: ServiceDefSheet<ShellSvc> = {
  openPath: {
    type: 'unary'
  },
  showItemInFolder: {
    type: 'unary'
  },
  openExternal: {
    type: 'unary'
  },
  getHomeDir: {
    type: 'unary'
  },
  fileExists: {
    type: 'unary'
  },
  fileExistsBatch: {
    type: 'unary'
  },
  ensureDirectory: {
    type: 'unary'
  },
  downloadFile: {
    type: 'unary'
  },
  installGitRepository: {
    type: 'unary'
  }
}
