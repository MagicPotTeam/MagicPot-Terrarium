import { ipcMain, MessagePortMain } from 'electron'
import { Api } from '@shared/api'
import {
  isServerStreamingError,
  ServerStreaming,
  ServerStreamingError,
  ServerStreamingTransport
} from '@shared/api/apiUtils/streaming'
import { isJsonDict } from '@shared/utils/utilTypes'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { ApiType } from '../apiUtils/serviceDefSheet'
import { ApiDefSheet } from '../apiUtils/serviceDefSheet'

function portToStreamingResp<T>(port: MessagePortMain): ServerStreaming<T> {
  return {
    onData: (data) => {
      port.postMessage({ data })
    }
  }
}

function cleanupPort(port: MessagePortMain, handleResult: Promise<void>): Promise<void> {
  return handleResult
    .catch((error) => {
      console.error('cleanupPort error', error)
      const transportError: ServerStreamingError = {
        message:
          error instanceof Error
            ? error.message
            : isServerStreamingError(error)
              ? error.message
              : error.toString() || 'Unknown error'
      }
      const transport: ServerStreamingTransport<void> = {
        error: transportError
      }
      if (isJsonDict(error) && !(error instanceof Error)) {
        transport.error.payload = error
      }
      port.postMessage(transport)
    })
    .finally(() => {
      port.close()
    })
}

function registerUnary<REQ, RESP>(name: string, handler: (req: REQ) => Promise<RESP>) {
  ipcMain.handle(name, async (_event, req: REQ): Promise<RESP> => {
    // if (name !== 'svcPhotoshop.getRealtimeGenerationStatus') {
    //   console.log(name, 'req', req)
    // }
    const startTime = Date.now()
    return handler(req)
      .then((resp) => {
        // if (name !== 'svcPhotoshop.getRealtimeGenerationStatus') {
        //   console.log(name, 'req', req, 'resp', resp, 'time', Date.now() - startTime)
        // }
        return resp
      })
      .catch((error) => {
        console.error(name, error)
        throw error
      })
  })
}

function registerServerStreaming<REQ, RESP>(
  name: string,
  handler: (req: REQ, resp: ServerStreaming<RESP>) => Promise<void>
) {
  ipcMain.on(name, (event, req: REQ) => {
    const port = event.ports[0]
    const resp = portToStreamingResp<RESP>(port)
    const [abortSender, abortReceiver] = newAbortHandler()
    resp.abortReceiver = abortReceiver
    port.on('message', () => {
      abortSender.abort()
    })
    port.on('close', () => {
      abortSender.abort()
    })
    // MessagePortMain 需要 start 才能正常接收消息
    port.start()
    return cleanupPort(port, handler(req, resp))
  })
}

export function registerIpcServer<T extends ApiType>(apiDef: ApiDefSheet<T>, api: T): void {
  for (const serviceName in apiDef) {
    const serviceDef = apiDef[serviceName]
    const serviceApi = api[serviceName]

    for (const methodName in serviceDef) {
      const methodDef = serviceDef[methodName]
      const fullMethodName = `${serviceName}.${methodName}`
      const methodApi = serviceApi[methodName].bind(serviceApi)

      if (methodDef.type === 'unary') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerUnary(fullMethodName, methodApi as (req: any) => Promise<any>)
      } else if (methodDef.type === 'serverStreaming') {
        registerServerStreaming(fullMethodName, methodApi)
      }
    }
  }
}
