import path from 'path'
import { app, type App } from 'electron'
import type { ProgressInfo, ReleaseNoteInfo, UpdateInfo } from 'builder-util-runtime'
import type { AppUpdater } from 'electron-updater'
import type { AppUpdateStatus } from '@shared/api/svcAppUpdate'
import {
  PACKAGE_MODE,
  PACKAGE_VERSION,
  UPDATE_PROVIDER_CHANNEL,
  UPDATE_PROVIDER_OWNER,
  UPDATE_PROVIDER_REPO
} from '@shared/config/viteEnv'

const UPDATE_PROVIDER = {
  type: 'github' as const,
  owner: UPDATE_PROVIDER_OWNER,
  repo: UPDATE_PROVIDER_REPO,
  channel: UPDATE_PROVIDER_CHANNEL
}

const isSupportedPackagedBuild = (): boolean =>
  app.isPackaged && (PACKAGE_MODE === 'pure' || PACKAGE_MODE === 'embedded')

function getCurrentInstallDirectory(): string {
  return path.dirname(app.getPath('exe'))
}

function pinNsisInstallDirectory(activeUpdater: AppUpdater): void {
  if (process.platform !== 'win32') {
    return
  }

  ;(activeUpdater as AppUpdater & { installDirectory?: string }).installDirectory =
    getCurrentInstallDirectory()
}

type UpdateListener = (status: AppUpdateStatus) => void

let updater: AppUpdater | null = null
let updaterInitPromise: Promise<AppUpdater | null> | null = null
let updateInstallInProgress = false
const listeners = new Set<UpdateListener>()

let status: AppUpdateStatus = {
  state: isSupportedPackagedBuild() ? 'idle' : 'unsupported',
  currentVersion: PACKAGE_VERSION || app.getVersion(),
  provider: UPDATE_PROVIDER,
  supported: isSupportedPackagedBuild(),
  canCheck: isSupportedPackagedBuild(),
  canDownload: false,
  canInstall: false
}

function emitStatus(nextStatus: AppUpdateStatus): AppUpdateStatus {
  const canCheck =
    nextStatus.supported && !['checking', 'downloading', 'installing'].includes(nextStatus.state)
  const canDownload = nextStatus.supported && nextStatus.state === 'available'
  const canInstall = nextStatus.supported && nextStatus.state === 'downloaded'

  status = {
    ...nextStatus,
    canCheck,
    canDownload,
    canInstall
  }

  for (const listener of listeners) {
    listener(status)
  }

  return status
}

function releaseNotesToText(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (!notes) {
    return undefined
  }

  if (typeof notes === 'string') {
    return notes
  }

  return notes
    .map((note: ReleaseNoteInfo) => [note.version, note.note].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
}

function updateInfoToStatusFields(
  info: UpdateInfo
): Pick<AppUpdateStatus, 'latestVersion' | 'releaseName' | 'releaseDate' | 'releaseNotes'> {
  return {
    latestVersion: info.version,
    releaseName: info.releaseName || undefined,
    releaseDate: info.releaseDate,
    releaseNotes: releaseNotesToText(info.releaseNotes)
  }
}

function progressToStatusFields(progress: ProgressInfo): AppUpdateStatus['progress'] {
  return {
    percent: progress.percent,
    transferredBytes: progress.transferred,
    totalBytes: progress.total,
    bytesPerSecond: progress.bytesPerSecond
  }
}

function setUnsupportedStatus(): AppUpdateStatus {
  return emitStatus({
    ...status,
    state: 'unsupported',
    supported: false,
    errorMessage: undefined
  })
}

async function getUpdater(): Promise<AppUpdater | null> {
  if (!isSupportedPackagedBuild()) {
    return null
  }

  if (updater) {
    return updater
  }

  if (updaterInitPromise) {
    return updaterInitPromise
  }

  updaterInitPromise = import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.allowPrerelease = false
      autoUpdater.channel = UPDATE_PROVIDER.channel
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: UPDATE_PROVIDER.owner,
        repo: UPDATE_PROVIDER.repo,
        channel: UPDATE_PROVIDER.channel
      })
      pinNsisInstallDirectory(autoUpdater)

      autoUpdater.on('checking-for-update', () => {
        emitStatus({
          ...status,
          state: 'checking',
          supported: true,
          errorMessage: undefined
        })
      })

      autoUpdater.on('update-available', (info) => {
        emitStatus({
          ...status,
          ...updateInfoToStatusFields(info),
          state: 'available',
          supported: true,
          checkedAt: Date.now(),
          errorMessage: undefined
        })
      })

      autoUpdater.on('update-not-available', (info) => {
        emitStatus({
          ...status,
          ...updateInfoToStatusFields(info),
          state: 'not-available',
          supported: true,
          checkedAt: Date.now(),
          errorMessage: undefined
        })
      })

      autoUpdater.on('download-progress', (progress) => {
        emitStatus({
          ...status,
          state: 'downloading',
          supported: true,
          progress: progressToStatusFields(progress),
          errorMessage: undefined
        })
      })

      autoUpdater.on('update-downloaded', (event) => {
        emitStatus({
          ...status,
          ...updateInfoToStatusFields(event),
          state: 'downloaded',
          supported: true,
          progress: undefined,
          downloadedAt: Date.now(),
          errorMessage: undefined
        })
      })

      autoUpdater.on('error', (error) => {
        emitStatus({
          ...status,
          state: 'error',
          supported: true,
          errorMessage: error.message || String(error)
        })
      })
      ;(
        app as App & {
          on(event: 'before-quit-for-update', listener: () => void): App
        }
      ).on('before-quit-for-update', () => {
        updateInstallInProgress = true
      })

      updater = autoUpdater
      emitStatus({
        ...status,
        state: 'idle',
        supported: true,
        errorMessage: undefined
      })
      return autoUpdater
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      emitStatus({
        ...status,
        state: 'error',
        supported: true,
        errorMessage: message
      })
      return null
    })

  return updaterInitPromise
}

export function getAppUpdateStatus(): AppUpdateStatus {
  if (!isSupportedPackagedBuild()) {
    return {
      ...status,
      state: 'unsupported',
      supported: false,
      canCheck: false,
      canDownload: false,
      canInstall: false
    }
  }

  return status
}

export function addAppUpdateStatusListener(listener: UpdateListener): () => void {
  listeners.add(listener)
  listener(getAppUpdateStatus())
  return () => {
    listeners.delete(listener)
  }
}

export async function initializeAppUpdateManager(): Promise<AppUpdateStatus> {
  if (!isSupportedPackagedBuild()) {
    return setUnsupportedStatus()
  }

  await getUpdater()
  return getAppUpdateStatus()
}

export async function checkForAppUpdates(): Promise<AppUpdateStatus> {
  const activeUpdater = await getUpdater()
  if (!activeUpdater) {
    return setUnsupportedStatus()
  }

  try {
    await activeUpdater.checkForUpdates()
  } catch (error) {
    emitStatus({
      ...status,
      state: 'error',
      supported: true,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
  }

  return getAppUpdateStatus()
}

export async function downloadAppUpdate(): Promise<AppUpdateStatus> {
  const activeUpdater = await getUpdater()
  if (!activeUpdater) {
    return setUnsupportedStatus()
  }

  try {
    emitStatus({
      ...status,
      state: 'downloading',
      supported: true,
      errorMessage: undefined
    })
    await activeUpdater.downloadUpdate()
  } catch (error) {
    emitStatus({
      ...status,
      state: 'error',
      supported: true,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
  }

  return getAppUpdateStatus()
}

export async function installAppUpdate(): Promise<AppUpdateStatus> {
  const activeUpdater = await getUpdater()
  if (!activeUpdater) {
    return setUnsupportedStatus()
  }

  updateInstallInProgress = true
  emitStatus({
    ...status,
    state: 'installing',
    supported: true,
    errorMessage: undefined
  })
  setTimeout(() => activeUpdater.quitAndInstall(false, true), 100)
  return getAppUpdateStatus()
}

export function isAppUpdateInstallInProgress(): boolean {
  return updateInstallInProgress
}
