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

const isComfyLog = (entry: LogEntry): boolean =>
  entry.message.trimStart().toLowerCase().startsWith('[comfyui')

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

    cleanup = addLogListener((entry: LogEntry) => {
      if (stop || !shouldInclude(entry)) {
        return
      }

      try {
        resp.onData({
          level: entry.level,
          message: entry.message,
          timestamp: entry.timestamp
        })
      } catch (error) {
        // A closed MessagePort can throw synchronously while replaying history
        // or delivering a live entry. Stop waiting immediately; rethrow so the
        // logging hub removes this broken listener as well.
        finish()
        throw error
      }
    })
    // Message-port aborts are delivered immediately in the normal IPC path.
    // Keep the polling fallback for lightweight test/direct callers that only
    // expose isAborted(), but do not leave a closed stream subscribed for 1s.
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

  watchAppLogs = async (
    _req: WatchAppLogsReq,
    resp: ServerStreaming<WatchAppLogsResp>
  ): Promise<void> => this.streamLogs(resp, (entry) => !shouldSuppressTerminalLog(entry))

  watchComfyLogs = async (
    _req: WatchComfyLogsReq,
    resp: ServerStreaming<WatchComfyLogsResp>
  ): Promise<void> => this.streamLogs(resp, isComfyLog)
}
