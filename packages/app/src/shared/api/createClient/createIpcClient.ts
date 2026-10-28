import { ipcRenderer } from 'electron'
import {
  ServerStreaming,
  ServerStreamingTransport,
  ServerStreamingError
} from '@shared/api/apiUtils/streaming'
import { ApiDefSheet } from '../apiUtils/serviceDefSheet'

function normalizeInvokeError(error: unknown): Error {
  const fallback =
    error instanceof Error
      ? error
      : new Error(typeof error === 'object' ? JSON.stringify(error) : String(error))

  const normalizedMessage = fallback.message
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
    .trim()

  if (!normalizedMessage || normalizedMessage === fallback.message) {
    return fallback
  }

  const normalizedError = new Error(normalizedMessage)
  normalizedError.name = fallback.name
  return normalizedError
}

function streamingRespToPort<T>(
  resp: ServerStreaming<T>
): [MessagePort, Promise<void>, (error: unknown) => void] {
  const channel = new MessageChannel()
  let rejectStream: ((error: unknown) => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void, closePort = true): void => {
      if (settled) return
      settled = true
      channel.port1.onmessage = null
      channel.port1.onmessageerror = null
      channel.port1.removeEventListener('close', handleClose)
      // Reject before closing: a synchronous close notification must not turn failure into success.
      settle()
      if (closePort) channel.port1.close()
    }
    const handleClose = (): void => finish(resolve, false)
    rejectStream = (error: unknown): void => {
      finish(() => reject(error))
    }
    channel.port1.onmessage = (event: { data: ServerStreamingTransport<T> }) => {
      if (settled) return
      try {
        if ('data' in event.data) {
          resp.onData(event.data.data)
        } else {
          const error = event.data.error
          finish(() => reject(error))
        }
      } catch (error) {
        finish(() => reject(error))
      }
    }
    channel.port1.onmessageerror = (event) => {
      if (settled) return
      let message = 'Unknown error'
      try {
        const rendered = event.data?.toString()
        if (typeof rendered === 'string' && rendered) message = rendered
      } catch {
        // A failed structured-clone payload may not have a usable string representation.
      }
      finish(() => reject({ message } as ServerStreamingError))
    }
    channel.port1.addEventListener('close', handleClose)
    resp.abortReceiver?.onAbort(() => {
      finish(resolve)
    })
  })

  return [channel.port2, promise, (error) => rejectStream?.(error)]
}

function invokeUnary<REQ, RESP>(name: string): (req: REQ) => Promise<RESP> {
  return async (req: REQ) => {
    // console.log(name, req)
    const startTime = Date.now()
    return ipcRenderer
      .invoke(name, req)
      .then((resp) => {
        // console.log(name, 'req', req, 'resp', resp, 'time', Date.now() - startTime)
        return resp
      })
      .catch((error) => {
        console.error(name, error)
        throw normalizeInvokeError(error)
      })
  }
}

function invokeServerStreaming<REQ, RESP>(
  name: string
): (req: REQ, resp: ServerStreaming<RESP>) => Promise<void> {
  return async (req: REQ, resp: ServerStreaming<RESP>) => {
    // console.log(name, req)
    const [port, promise, rejectStream] = streamingRespToPort(resp)
    try {
      ipcRenderer.postMessage(name, req, [port])
    } catch (error) {
      // A synchronous DataCloneError/channel failure must not leave the local
      // stream pending forever. Reject through the same terminal path used by
      // transport errors, then close the untransferred peer as well.
      rejectStream(error)
      port.close()
    }
    return promise
  }
}

/**
 * 创建 UI 端用的 Api 实例
 * 注意返回的必须为简单对象，不能是类实例
 * https://www.electronjs.org/zh/docs/latest/api/context-bridge#%E5%BA%94%E7%94%A8%E5%BC%80%E5%8F%91%E6%8E%A5%E5%8F%A3api
 *
 * @returns Api Instance
 */
export function createIpcClient<T extends object>(apiDef: ApiDefSheet<T>): T {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const result = {} as any

  // 遍历 apiDef 中的每个服务
  for (const [serviceName, serviceDef] of Object.entries(apiDef) as [string, object][]) {
    result[serviceName] = {}

    // 遍历每个服务中的方法定义
    for (const [methodName, methodDef] of Object.entries(serviceDef)) {
      const fullMethodName = `${serviceName}.${methodName}`

      // 根据方法类型调用对应的 invoke 函数
      if (methodDef.type === 'unary') {
        result[serviceName][methodName] = invokeUnary(fullMethodName)
      } else if (methodDef.type === 'serverStreaming') {
        result[serviceName][methodName] = invokeServerStreaming(fullMethodName)
      }
    }
  }

  return result
}
