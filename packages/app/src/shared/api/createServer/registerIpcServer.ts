import { isTrustedProviderJsonBudgetError } from '../../llm/providerJsonBudget'
import { isProxy } from 'node:util/types'
import { ipcMain, MessagePortMain } from 'electron'
import { cancelInstalledCatalogPublication, finalizeInstalledCatalogPublication, INSTALLED_CATALOG_PUBLICATION_METHOD } from './installedCatalogPublication'
import { createIpcInvocationContext } from './ipcInvocationOrigin'
import type { ServiceInvocationContext } from '../apiUtils/serviceInvocation'
import { cancelStartupStoragePublication, finalizeStartupStoragePublication, STARTUP_STORAGE_PUBLICATION_METHOD } from './startupStoragePublication'
import { parseStartupStorageMetadataRequest, parseStartupStorageMetadataResponse, startupStorageMetadataUnavailable as storageUnavailable } from '../startupStorageMetadata'
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
import { IpcServiceError, type UnaryIpcResult } from '../apiUtils/unaryIpcResult'
import { omittedAgentToolFailure, readAgentToolFailurePayload } from '../agentThreadToolFailure'
import { ApiDefSheet, type UnaryServiceDef } from '../apiUtils/serviceDefSheet'

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
  options: { beforeClose?: () => void; isAborted?: () => boolean; isChatStream?: boolean } = {}
): Promise<void> {
  return handleResult
    .catch((error) => {
      // Once the renderer has disconnected, cancellation is the authoritative
      // terminal state. There is no consumer for a serialized error and
      // logging it only creates duplicate noise during normal navigation/close.
      if (options.isAborted?.()) return
      // A chat handler normally reports terminal errors as events. Any rejection
      // escaping that handler is a separate transport failure. Only a
      // helper-branded error may carry the reserved code; branding does not bind
      // that error to this request. Do not inspect unknown exceptions (they
      // could be proxies or have getters).
      const serializedError = options.isChatStream
        ? isTrustedProviderJsonBudgetError(error)
          ? { message: 'Provider request exceeds the size limit. Remove some attachments or send fewer images per message.', code: 'PROVIDER_JSON_BUDGET_EXCEEDED' }
          : { message: 'Unable to complete the chat request.', code: 'INTERNAL_ERROR' }
        : serializeServiceError(error)
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

/** This exact endpoint accepts ONLY its two known synchronous parser identities. Reject
 * unsupported validators before invocation: they cannot create a floating rejected Promise
 * or run transform/safeParse/error/then/constructor/species hooks. Generic validation stays
 * unchanged for all other methods; this is deliberately not a pluggable adapter. */
function hasCanonicalStartupStorageValidators(definition: UnaryServiceDef<unknown, unknown>): boolean {
  try {
    if (!definition || typeof definition !== 'object' || isProxy(definition)) return false
    const prototype = Object.getPrototypeOf(definition)
    if (prototype !== Object.prototype && prototype !== null) return false
    if (Object.getOwnPropertyDescriptor(definition, 'ipcResult')) return false
    const type = Object.getOwnPropertyDescriptor(definition, 'type')
    if (!type || !('value' in type) || type.value !== 'unary') return false
    const request = Object.getOwnPropertyDescriptor(definition, 'request'), response = Object.getOwnPropertyDescriptor(definition, 'response')
    return !!request && 'value' in request && request.value === parseStartupStorageMetadataRequest && !!response && 'value' in response && response.value === parseStartupStorageMetadataResponse
  } catch { return false }
}
type StorageValidationAttempt<T> = { ok: true; value: T } | { ok: false }
function tryParseStartupStorageValue<T>(value: unknown, parser: (value: unknown) => T): StorageValidationAttempt<T> {
  try {
    if (value && (typeof value === 'object' || typeof value === 'function') && isProxy(value)) return { ok: false }
    return { ok: true, value: parser(value) }
  } catch { return { ok: false } }
}

/** Raw transport branch for this exact method only. Other unary validation/error paths stay
 * unchanged. The bound MAIN handler is trusted: its awaited return may assimilate a thenable;
 * no arbitrary-handler no-hook guarantee is made. Only pinned synchronous parsers run here. */
function registerStartupStorageMetadataUnary(handler: UnaryServiceHandler<unknown, unknown>, definition: UnaryServiceDef<unknown, unknown>): void {
  ipcMain.handle(STARTUP_STORAGE_PUBLICATION_METHOD, (event, req: unknown) => {
    let invocation: ServiceInvocationContext | undefined
    try {
      if (!hasCanonicalStartupStorageValidators(definition)) return Promise.resolve(storageUnavailable)
      invocation = createIpcInvocationContext(STARTUP_STORAGE_PUBLICATION_METHOD, event)
      const request = tryParseStartupStorageValue(req, parseStartupStorageMetadataRequest)
      if (!request.ok) { cancelStartupStoragePublication(invocation); return Promise.resolve(storageUnavailable) }
      return Promise.resolve(handler(request.value, invocation))
        .then(value => {
          const response = tryParseStartupStorageValue(value, parseStartupStorageMetadataResponse)
          if (!response.ok) { cancelStartupStoragePublication(invocation); return storageUnavailable }
          return response.value
        })
        .catch(() => { cancelStartupStoragePublication(invocation); return storageUnavailable })
        .then(value => finalizeStartupStoragePublication(STARTUP_STORAGE_PUBLICATION_METHOD, invocation, value))
    } catch {
      cancelStartupStoragePublication(invocation)
      return Promise.resolve(storageUnavailable)
    }
  })
}

function registerUnary<REQ, RESP>(name: string, handler: UnaryServiceHandler<REQ, RESP>, ipcResult?: 'service-error') {
  ipcMain.handle(name, async (event, req: REQ): Promise<RESP | UnaryIpcResult<RESP>> => {
    // if (name !== 'svcPhotoshop.getRealtimeGenerationStatus') {
    //   console.log(name, 'req', req)
    // }
    const startTime = Date.now()
    const invocation = createIpcInvocationContext(name, event)
    return handler(req, invocation)
      .then((resp) => {
        // if (name !== 'svcPhotoshop.getRealtimeGenerationStatus') {
        //   console.log(name, 'req', req, 'resp', resp, 'time', Date.now() - startTime)
        // }
        return ipcResult === 'service-error' ? { ok: true as const, value: resp } : resp
      })
      .catch((error: unknown) => {
        cancelInstalledCatalogPublication(invocation)
        if (ipcResult !== 'service-error') {
          console.error(name, error)
          throw error
        }
        if (name === 'svcLLMProxy.chat' && isTrustedProviderJsonBudgetError(error)) {
          return { ok: false as const, error: { message: 'Provider request exceeds the size limit. Remove some attachments or send fewer images per message.', code: 'PROVIDER_JSON_BUDGET_EXCEEDED' } }
        }
        // Ordinary errors get no payload, including ServiceError and duck-typed
        // .payload. Do not stringify errors or invoke message/payload accessors.
        const own = (key: string): unknown => error && typeof error === 'object' && !isProxy(error)
          ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined
        const text = typeof error === 'string' ? error : own('message')
        const message = typeof text === 'string' && text.trim() ? text.trim().slice(0, 4096) : 'Unknown error'
        const code = own('code')
        const allowedCode = name === 'svcLLMProxy.chat' && code === 'PROVIDER_JSON_BUDGET_EXCEEDED' ? undefined : code
        const payload = error && typeof error === 'object' && !isProxy(error) && error instanceof IpcServiceError
          ? readAgentToolFailurePayload(own('payload')) ?? omittedAgentToolFailure() : undefined
        console.error(name, message)
        return { ok: false as const, error: { message, ...(typeof allowedCode === 'string' && allowedCode.length <= 256 ? { code: allowedCode } : {}), ...(payload ? { payload } : {}) } }
      })
      .then((resp) => {
        if (name !== INSTALLED_CATALOG_PUBLICATION_METHOD) return resp
        // This exact endpoint supports raw DTOs only. No userland await or cleanup follows finalization.
        if (ipcResult === 'service-error') {
          cancelInstalledCatalogPublication(invocation)
          return { ok: false as const, error: { message: 'Installed catalog publication unavailable.' } }
        }
        // The exact catalog method's public DTO includes this helper's static unavailable alternative.
        return finalizeInstalledCatalogPublication(name, invocation, resp) as RESP
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
      handleResult = Promise.resolve(handler(req, resp, createIpcInvocationContext(name, event)))
    } catch (error) {
      handleResult = Promise.reject(error)
    }
    return cleanupPort(port, handleResult, {
      isChatStream: name === 'svcLLMProxy.chatStream',
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

      // Dispatch the exact name BEFORE any method-definition property access. A malformed
      // MAIN definition must install a raw denying callback, never escape via a type getter
      // or select the generic/streaming path. API/service containers and handlers are trusted.
      if (fullMethodName === STARTUP_STORAGE_PUBLICATION_METHOD) {
        registerStartupStorageMetadataUnary(methodApi as UnaryServiceHandler<unknown, unknown>, methodDef as UnaryServiceDef<unknown, unknown>)
        continue
      }
      if (methodDef.type === 'unary') {
        registerUnary(
          fullMethodName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          withServiceValidation(methodApi as (req: any) => Promise<any>, {
            methodName: fullMethodName,
            request: methodDef.request,
            response: methodDef.response
          }),
          methodDef.ipcResult
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
