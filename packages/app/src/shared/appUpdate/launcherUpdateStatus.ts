import type { UpdateChannel } from './launcherProtocol'

export type LauncherUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'up-to-date'
  | 'error'

export interface LauncherActiveVersion {
  version: string
  buildId: string
  runtimeId: string
}

export interface LauncherTargetRelease {
  channel: UpdateChannel
  version: string
  buildId: string
  runtimeId: string
  publishedAt: string
  releaseNotesUrl: string
}

export interface LauncherUpdateStatus {
  phase: LauncherUpdatePhase
  active?: LauncherActiveVersion
  target?: LauncherTargetRelease
  message?: string
  updatedAt: string
}
