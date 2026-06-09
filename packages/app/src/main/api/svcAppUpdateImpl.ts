import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import type { AppUpdateReq, AppUpdateStatus, AppUpdateSvc } from '@shared/api/svcAppUpdate'
import {
  addAppUpdateStatusListener,
  checkForAppUpdates,
  downloadAppUpdate,
  getAppUpdateStatus,
  installAppUpdate
} from '../appUpdate/updateManager'

export class AppUpdateSvcImpl implements AppUpdateSvc {
  getStatus = async (_req: AppUpdateReq): Promise<AppUpdateStatus> => getAppUpdateStatus()

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
