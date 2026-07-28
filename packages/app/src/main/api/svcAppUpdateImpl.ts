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
    const cleanup = addAppUpdateStatusListener((status) => {
      if (!stop) {
        resp.onData(status)
      }
    })

    while (!stop) {
      if (resp.abortReceiver?.isAborted()) {
        stop = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    cleanup()
  }
}
