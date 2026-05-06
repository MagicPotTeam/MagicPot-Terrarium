import { ServerStreaming } from './apiUtils/streaming'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export interface WatchAppLogsReq {}
export interface WatchComfyLogsReq {}

export interface LogStreamResp {
  level: string
  message: string
  timestamp: number
}

export type WatchAppLogsResp = LogStreamResp
export type WatchComfyLogsResp = LogStreamResp

export type LogSvc = {
  watchAppLogs(req: WatchAppLogsReq, resp: ServerStreaming<WatchAppLogsResp>): Promise<void>
  watchComfyLogs(req: WatchComfyLogsReq, resp: ServerStreaming<WatchComfyLogsResp>): Promise<void>
}

export const logSvcDef: ServiceDefSheet<LogSvc> = {
  watchAppLogs: {
    type: 'serverStreaming'
  },
  watchComfyLogs: {
    type: 'serverStreaming'
  }
}
