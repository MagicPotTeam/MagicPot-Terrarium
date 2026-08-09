import { ServerStreaming } from './apiUtils/streaming'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import type {
  LauncherCommandReceipt,
  LauncherCommandResultV1,
  UpdateChannel,
  UpdateMode
} from '../appUpdate/launcherProtocol'

export type AppUpdateState =
  | 'idle'
  | 'managed-by-launcher'
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
export type LauncherCommandResultReq = { requestId: string }
export type LauncherVersionRemovalReq = { buildId: string }

export type InstalledLauncherVersion = {
  version: string
  buildId: string
  runtimeId: string
  installedAt: string
  /** Declared manifest size; this is not a live disk-usage measurement. */
  appBytes: number | null
  /** Declared manifest size; this is not a live disk-usage measurement. */
  runtimeBytes: number | null
  /** Sum of declared sizes, or null when either declaration is unavailable. */
  totalBytes: number | null
  health: 'healthy' | 'pending' | 'failed' | 'unknown'
  active: boolean
  rollback: boolean
  removable: boolean
  removalBlockedReason?: string
}

export type LauncherUpdateResultStatus =
  | 'manual'
  | 'disabled'
  | 'unavailable'
  | 'up-to-date'
  | 'available'
  | 'activated'
  | 'installed'
  | 'locked'
  | 'failed'

export type LauncherManagedState = {
  managed: boolean
  settingsWritable: boolean
  updateMode?: UpdateMode
  channel?: UpdateChannel
  launchStatus?: LauncherUpdateResultStatus
  launchVersion?: string
  activeBuildId?: string
  activeRuntimeId?: string
  previousBuildId?: string
  lastLauncherCommandResult?: LauncherCommandResultV1
  installedVersions?: InstalledLauncherVersion[]
  inventoryIssues?: string[]
  capabilities: {
    checkNow: boolean
    installLatest: boolean
    rollback: boolean
    removeVersion: boolean
  }
}

export type SaveLauncherSettingsReq = {
  updateMode: UpdateMode
  channel: UpdateChannel
}

export type AppUpdateSvc = {
  getStatus(req: AppUpdateReq): Promise<AppUpdateStatus>
  getLauncherState(req: AppUpdateReq): Promise<LauncherManagedState>
  getLauncherCommandResult(
    req: LauncherCommandResultReq
  ): Promise<LauncherCommandResultV1 | undefined>
  saveLauncherSettings(req: SaveLauncherSettingsReq): Promise<LauncherManagedState>
  checkLauncherNow(req: AppUpdateReq): Promise<LauncherCommandReceipt>
  requestLauncherUpdate(req: AppUpdateReq): Promise<LauncherCommandReceipt>
  requestLauncherRollback(req: AppUpdateReq): Promise<LauncherCommandReceipt>
  requestLauncherVersionRemoval(req: LauncherVersionRemovalReq): Promise<LauncherCommandReceipt>
  checkForUpdates(req: AppUpdateReq): Promise<AppUpdateStatus>
  downloadUpdate(req: AppUpdateReq): Promise<AppUpdateStatus>
  installUpdate(req: AppUpdateReq): Promise<AppUpdateStatus>
  watchStatus(req: AppUpdateReq, resp: ServerStreaming<AppUpdateStatus>): Promise<void>
}

export const appUpdateSvcDef: ServiceDefSheet<AppUpdateSvc> = {
  getStatus: {
    type: 'unary'
  },
  getLauncherState: {
    type: 'unary'
  },
  getLauncherCommandResult: {
    type: 'unary'
  },
  saveLauncherSettings: {
    type: 'unary'
  },
  checkLauncherNow: { type: 'unary' },
  requestLauncherUpdate: { type: 'unary' },
  requestLauncherRollback: { type: 'unary' },
  requestLauncherVersionRemoval: { type: 'unary' },
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
