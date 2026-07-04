import { ipcMain, MessagePortMain } from 'electron'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { ServerStreaming, ServerStreamingTransport } from '@shared/api/apiUtils/streaming'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import {
  serializeServiceError,
  type ServerStreamingServiceHandler,
  type UnaryServiceHandler,
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

type IpcServiceEvent = {
  sender?: { id?: unknown; getURL?: () => string | undefined }
  senderFrame?: { url?: unknown; parent?: unknown } | null
}

function createInvocationContext(
  methodName: string,
  event: IpcServiceEvent
): ServiceInvocationContext {
  const sender = event.sender
  const senderId = typeof sender?.id === 'number' ? sender.id : undefined
  const senderUrl = typeof sender?.getURL === 'function' ? sender.getURL() : undefined
  const frameUrl =
    typeof event.senderFrame?.url === 'string' && event.senderFrame.url.trim()
      ? event.senderFrame.url
      : undefined
  const isMainFrame = event.senderFrame ? event.senderFrame.parent === null : undefined
  return {
    methodName,
    ...(senderId !== undefined ? { senderId } : {}),
    ...(senderUrl ? { senderUrl } : {}),
    ...(frameUrl ? { frameUrl } : {}),
    ...(isMainFrame !== undefined ? { isMainFrame } : {})
  }
}

function registerUnary<REQ, RESP>(name: string, handler: UnaryServiceHandler<REQ, RESP>) {
  ipcMain.handle(name, async (event, req: REQ): Promise<RESP> => {
    // if (name !== 'svcPhotoshop.getRealtimeGenerationStatus') {
    //   console.log(name, 'req', req)
    // }
    const startTime = Date.now()
    return handler(req, createInvocationContext(name, event))
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
  handler: ServerStreamingServiceHandler<REQ, RESP>
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
    return cleanupPort(port, handler(req, resp, createInvocationContext(name, event)))
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
