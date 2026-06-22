import { ipcMain, MessagePortMain } from 'electron'
import { Api } from '@shared/api'
import { ServerStreaming, ServerStreamingTransport } from '@shared/api/apiUtils/streaming'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import {
  serializeServiceError,
  withServerStreamingValidation,
  withServiceValidation
} from '@shared/api/apiUtils/serviceValidation'
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
      const transport: ServerStreamingTransport<void> = {
        error: serializeServiceError(error)
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
        registerUnary(
          fullMethodName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          withServiceValidation(methodApi as (req: any) => Promise<any>, {
            methodName: fullMethodName,
            request: methodDef.request,
            response: methodDef.response
          })
        )
      } else if (methodDef.type === 'serverStreaming') {
        registerServerStreaming(
          fullMethodName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          withServerStreamingValidation(methodApi as any, {
            methodName: fullMethodName,
            request: methodDef.request,
            data: methodDef.data
          })
        )
      }
    }
  }
}
