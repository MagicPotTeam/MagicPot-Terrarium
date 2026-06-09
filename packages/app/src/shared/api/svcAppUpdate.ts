import { ServerStreaming } from './apiUtils/streaming'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type AppUpdateState =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export type AppUpdateProgress = {
  percent?: number
  transferredBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
}

export type AppUpdateProvider = {
  type: 'github'
  owner: string
  repo: string
  channel: string
}

export type AppUpdateStatus = {
  state: AppUpdateState
  currentVersion: string
  latestVersion?: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
  progress?: AppUpdateProgress
  errorMessage?: string
  provider: AppUpdateProvider
  supported: boolean
  canCheck: boolean
  canDownload: boolean
  canInstall: boolean
  checkedAt?: number
  downloadedAt?: number
}

export type AppUpdateReq = Record<string, never>

export type AppUpdateSvc = {
  getStatus(req: AppUpdateReq): Promise<AppUpdateStatus>
  checkForUpdates(req: AppUpdateReq): Promise<AppUpdateStatus>
  downloadUpdate(req: AppUpdateReq): Promise<AppUpdateStatus>
  installUpdate(req: AppUpdateReq): Promise<AppUpdateStatus>
  watchStatus(req: AppUpdateReq, resp: ServerStreaming<AppUpdateStatus>): Promise<void>
}

export const appUpdateSvcDef: ServiceDefSheet<AppUpdateSvc> = {
  getStatus: {
    type: 'unary'
  },
  checkForUpdates: {
    type: 'unary'
  },
  downloadUpdate: {
    type: 'unary'
  },
  installUpdate: {
    type: 'unary'
  },
  watchStatus: {
    type: 'serverStreaming'
  }
}
