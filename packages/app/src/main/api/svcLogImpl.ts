import {
  LogStreamResp,
  LogSvc,
  WatchAppLogsReq,
  WatchAppLogsResp,
  WatchComfyLogsReq,
  WatchComfyLogsResp
} from '@shared/api/svcLog'
import { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { addLogListener, LogEntry } from '../utils/loggingOverride'

const isComfyLog = (entry: LogEntry): boolean => entry.message.startsWith('[comfyui]')

const shouldSuppressTerminalLog = (entry: LogEntry): boolean => {
  // ComfyUI has a dedicated panel, so keep the shared terminal focused on app/runtime logs.
  if (isComfyLog(entry)) {
    return true
  }

  // Realtime Photoshop polling is too noisy to be useful in the shared terminal.
  if (entry.message.includes('svcPhotoshop.getRealtimeGenerationStatus')) {
    return true
  }

  return false
}

export class LogSvcImpl implements LogSvc {
  private streamLogs = async (
    resp: ServerStreaming<LogStreamResp>,
    shouldInclude: (entry: LogEntry) => boolean
  ): Promise<void> => {
    let stop = false

    const cleanup = addLogListener((entry: LogEntry) => {
      if (stop || !shouldInclude(entry)) {
        return
      }

      resp.onData({
        level: entry.level,
        message: entry.message,
        timestamp: entry.timestamp
      })
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

  watchAppLogs = async (
    _req: WatchAppLogsReq,
    resp: ServerStreaming<WatchAppLogsResp>
  ): Promise<void> => this.streamLogs(resp, (entry) => !shouldSuppressTerminalLog(entry))

  watchComfyLogs = async (
    _req: WatchComfyLogsReq,
    resp: ServerStreaming<WatchComfyLogsResp>
  ): Promise<void> => this.streamLogs(resp, isComfyLog)
}
