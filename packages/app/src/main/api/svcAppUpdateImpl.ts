import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import type {
  AppUpdateReq,
  AppUpdateStatus,
  AppUpdateSvc,
  LauncherCommandResultReq,
  LauncherManagedState,
  LauncherVersionRemovalReq,
  SaveLauncherSettingsReq
} from '@shared/api/svcAppUpdate'
import {
  addAppUpdateStatusListener,
  checkForAppUpdates,
  downloadAppUpdate,
  getAppUpdateStatus,
  installAppUpdate
} from '../appUpdate/updateManager'
import {
  getLauncherManagedState,
  saveLauncherManagedSettings
} from '../appUpdate/launcherManagedState'
import { readLauncherCommandResult, writeLauncherCommand } from '../appUpdate/launcherCommand'

export class AppUpdateSvcImpl implements AppUpdateSvc {
  getStatus = async (_req: AppUpdateReq): Promise<AppUpdateStatus> => getAppUpdateStatus()

  getLauncherState = async (_req: AppUpdateReq): Promise<LauncherManagedState> =>
    getLauncherManagedState()

  getLauncherCommandResult = async (req: LauncherCommandResultReq) =>
    readLauncherCommandResult(req.requestId)

  saveLauncherSettings = async (req: SaveLauncherSettingsReq): Promise<LauncherManagedState> =>
    saveLauncherManagedSettings(req)

  checkLauncherNow = async (_req: AppUpdateReq) => writeLauncherCommand('check-now')
  requestLauncherUpdate = async (_req: AppUpdateReq) => writeLauncherCommand('install-latest')
  requestLauncherRollback = async (_req: AppUpdateReq) => writeLauncherCommand('rollback')
  requestLauncherVersionRemoval = async (req: LauncherVersionRemovalReq) =>
    writeLauncherCommand('remove-version', {}, req.buildId)

  checkForUpdates = async (_req: AppUpdateReq): Promise<AppUpdateStatus> => checkForAppUpdates()

  downloadUpdate = async (_req: AppUpdateReq): Promise<AppUpdateStatus> => downloadAppUpdate()

  installUpdate = async (_req: AppUpdateReq): Promise<AppUpdateStatus> => installAppUpdate()

  watchStatus = async (
    _req: AppUpdateReq,
    resp: ServerStreaming<AppUpdateStatus>
  ): Promise<void> => {
    let stop = false
    let cleanup: (() => void) | undefined
    let resolveWait: (() => void) | undefined
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (stop) return
      stop = true
      cleanup?.()
      cleanup = undefined
      if (waitTimer !== undefined) {
        clearTimeout(waitTimer)
        waitTimer = undefined
      }
      resolveWait?.()
      resolveWait = undefined
    }

    cleanup = addAppUpdateStatusListener((status) => {
      if (!stop) {
        resp.onData(status)
      }
    })
    // Abort handlers are delivered as soon as the transferred MessagePort is
    // closed. Keep the timer only as a fallback for direct/test callers that
    // expose an `isAborted` check without a live abort callback.
    resp.abortReceiver?.onAbort(finish)

    while (!stop) {
      if (resp.abortReceiver?.isAborted()) {
        finish()
        break
      }
      await new Promise<void>((resolve) => {
        resolveWait = resolve
        waitTimer = setTimeout(() => {
          waitTimer = undefined
          resolveWait = undefined
          resolve()
        }, 1000)
      })
    }

    finish()
  }
}
