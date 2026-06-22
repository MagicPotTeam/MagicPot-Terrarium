import { JsonDict } from '@shared/utils/utilTypes'
import { AbortReceiver } from './abortHandler'

export type ServerStreamingError = {
  message: string
  code?: string
  payload?: JsonDict
}

export function isServerStreamingError(error: unknown): error is ServerStreamingError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as ServerStreamingError).message === 'string'
  )
}

/**
 * 服务端流式响应
 */
export type ServerStreaming<T> = {
  onData: (data: T) => void
  abortReceiver?: AbortReceiver
}

/**
 * 传输层类型，用于在传输层处理错误转换为可读的错误信息
 * 返回 data 或 error 之一，不能同时返回
 */
export type ServerStreamingTransport<T> =
  | {
      data: T
    }
  | {
      error: ServerStreamingError
    }
