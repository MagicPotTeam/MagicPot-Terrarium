/**
 * Electron 的 Shell API 在一些平台上在 Renderer 进程中调用会造成卡死
 * 这里单独包装一个服务，在 Main 进程中调用
 */

import { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServerStreaming } from './apiUtils/streaming'
import { ServiceValidationError } from './apiUtils/serviceValidation'

export type DownloadFileReq = {
  url: string
  outputDir: string
  filename: string
}

export type DownloadFileResp = {
  fullPath: string
  alreadyExists: boolean
}

export type DownloadFileProgressEvent =
  | {
      type: 'progress'
      downloadedBytes: number
      totalBytes?: number
      percent?: number
      bytesPerSecond: number
    }
  | {
      type: 'complete'
      result: DownloadFileResp
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

type NonEmptyStringKey<T extends string> = T

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireNonEmptyString = <T extends string>(
  value: unknown,
  field: NonEmptyStringKey<T>
): string => {
  if (typeof value === 'string' && value.trim()) {
    return value
  }
  throw new ServiceValidationError(`svcShell ${field}`, [
    {
      path: [field],
      message: 'Expected a non-empty string',
      code: 'invalid_type'
    }
  ])
}

const validateEnsureDirectoryReq = (value: unknown): EnsureDirectoryReq => {
  if (!isRecord(value)) {
    throw new ServiceValidationError('svcShell.ensureDirectory request')
  }
  return {
    path: requireNonEmptyString(value.path, 'path')
  }
}

const validateDownloadFileReq = (value: unknown): DownloadFileReq => {
  if (!isRecord(value)) {
    throw new ServiceValidationError('svcShell.downloadFile request')
  }
  return {
    url: requireNonEmptyString(value.url, 'url'),
    outputDir: requireNonEmptyString(value.outputDir, 'outputDir'),
    filename: requireNonEmptyString(value.filename, 'filename')
  }
}

const validateInstallGitRepositoryReq = (value: unknown): InstallGitRepositoryReq => {
  if (!isRecord(value)) {
    throw new ServiceValidationError('svcShell.installGitRepository request')
  }
  return {
    url: requireNonEmptyString(value.url, 'url'),
    outputDir: requireNonEmptyString(value.outputDir, 'outputDir'),
    directoryName: requireNonEmptyString(value.directoryName, 'directoryName')
  }
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
  downloadFileWithProgress(
    req: DownloadFileReq,
    resp: ServerStreaming<DownloadFileProgressEvent>
  ): Promise<void>
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
    type: 'unary',
    request: validateEnsureDirectoryReq
  },
  downloadFile: {
    type: 'unary',
    request: validateDownloadFileReq
  },
  downloadFileWithProgress: {
    type: 'serverStreaming',
    request: validateDownloadFileReq
  },
  installGitRepository: {
    type: 'unary',
    request: validateInstallGitRepositoryReq
  }
}
