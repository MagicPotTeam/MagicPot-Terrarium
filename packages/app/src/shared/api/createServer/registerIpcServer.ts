import { ipcMain, MessagePortMain } from 'electron'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { AbortReceiver, AbortSender } from '@shared/api/apiUtils/abortHandler'
import { ServerStreaming, ServerStreamingTransport } from '@shared/api/apiUtils/streaming'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import {
  serializeServiceError,
  type ServerStreamingServiceHandler,
  type UnaryServiceHandler,
  withServerStreamingValidation,
  withServiceValidation
} from '@shared/api/apiUtils/serviceValidation'
import { ApiDefSheet } from '../apiUtils/serviceDefSheet'

function portToStreamingResp<T>(
  port: MessagePortMain,
  abortReceiver: AbortReceiver,
  abortSender: AbortSender
): { response: ServerStreaming<T>; close: () => void } {
  let closed = false
  return {
    response: {
      onData: (data) => {
        // A handler may observe cancellation only between awaited operations and
        // emit one more event. Do not write to a renderer-owned port after the
        // stream has been aborted/disconnected.
        if (closed || abortReceiver.isAborted()) return
        try {
          port.postMessage({ data })
        } catch {
          // A disconnected renderer can race the MessagePort `close` event.
          // Convert that transport failure into cancellation instead of
          // throwing through an unrelated EventCenter/config save callback.
          closed = true
          try {
            abortSender.abort()
          } catch {
            // Abort callbacks are best-effort during transport teardown.
          }
        }
      }
    },
    close: () => {
      closed = true
    }
  }
}

function cleanupPort(
  port: MessagePortMain,
  handleResult: Promise<void>,
  options: { beforeClose?: () => void; isAborted?: () => boolean } = {}
): Promise<void> {
  return handleResult
    .catch((error) => {
      // Once the renderer has disconnected, cancellation is the authoritative
      // terminal state. There is no consumer for a serialized error and
      // logging it only creates duplicate noise during normal navigation/close.
      if (options.isAborted?.()) return
      const serializedError = serializeServiceError(error)
      console.error('cleanupPort error', serializedError)
      const transport: ServerStreamingTransport<void> = {
        error: serializedError
      }
      try {
        // The renderer may have already disconnected the transferred port. In
        // that case there is nowhere to deliver the terminal error; do not let
        // a second postMessage failure turn cleanup into an unhandled reject.
        port.postMessage(transport)
      } catch (postError) {
        console.error('cleanupPort transport error', serializeServiceError(postError))
      }
    })
    .finally(() => {
      options.beforeClose?.()
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
    if (!port) {
      // A malformed renderer message must not crash the main process before a
      // service handler has a chance to run. There is no transport available
      // for returning a structured error in this case.
      console.error(`${name}: missing MessagePort for server-streaming request`)
      return
    }
    const [abortSender, abortReceiver] = newAbortHandler()
    const { response: resp, close: closeResponse } = portToStreamingResp<RESP>(
      port,
      abortReceiver,
      abortSender
    )
    resp.abortReceiver = abortReceiver
    const abortStream = (): void => {
      if (!abortReceiver.isAborted()) abortSender.abort()
    }
    const abortOnNavigation = (
      details: { isMainFrame?: boolean; isSameDocument?: boolean },
      _url?: string,
      isInPlace?: boolean,
      isMainFrame?: boolean
    ): void => {
      const mainFrame = details.isMainFrame ?? isMainFrame
      const sameDocument = details.isSameDocument ?? isInPlace
      if (mainFrame === true && sameDocument === false) abortStream()
    }
    const sender = event.sender
    // A renderer reload can orphan its port before MessagePortMain reports close.
    sender?.on?.('did-start-navigation', abortOnNavigation)
    sender?.on?.('render-process-gone', abortStream)
    sender?.on?.('destroyed', abortStream)
    port.on('message', abortStream)
    port.on('close', abortStream)
    // MessagePortMain 需要 start 才能正常接收消息
    port.start()
    let handleResult: Promise<void>
    try {
      handleResult = Promise.resolve(handler(req, resp, createInvocationContext(name, event)))
    } catch (error) {
      handleResult = Promise.reject(error)
    }
    return cleanupPort(port, handleResult, {
      isAborted: () => abortReceiver.isAborted(),
      beforeClose: () => {
        closeResponse()
        port.removeListener?.('message', abortStream)
        port.removeListener?.('close', abortStream)
        sender?.removeListener?.('did-start-navigation', abortOnNavigation)
        sender?.removeListener?.('render-process-gone', abortStream)
        sender?.removeListener?.('destroyed', abortStream)
      }
    })
  })
}

export function registerIpcServer<T extends object>(apiDef: ApiDefSheet<T>, api: T): void {
  const apiServices = api as Record<string, object>
  for (const serviceName in apiDef) {
    const serviceDef = apiDef[serviceName]
    const serviceApi = apiServices[serviceName] as Record<string, (...args: never[]) => unknown>

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
