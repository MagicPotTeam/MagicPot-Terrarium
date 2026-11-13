import { net } from 'electron'
import type { FetchImpl } from '@shared/llm/clients'
import { isProxy } from 'node:util/types'
import { ProviderRawWorkLifetime, type ProviderRawWorkRetainer } from '@shared/llm/providerRawWork'
import { captureManagedData, managedOwnValues } from '../magicAgentPlatform2/agents/managedRuntimeSnapshot'

const getElectronNetFetch = (): typeof net.fetch | null => {
  const candidate = (net as unknown as { fetch?: typeof net.fetch } | undefined)?.fetch
  return typeof candidate === 'function' ? candidate : null
}
export type ElectronIncomingMessageLike = {
  headers: Record<string, string | string[] | undefined>
  on: {
    (event: 'data', listener: (chunk: Buffer | string) => void): unknown
    (event: 'error', listener: (error: unknown) => void): unknown
  }
  pause?: () => void
  resume?: () => void
  once: {
    (event: 'aborted' | 'end', listener: () => void): unknown
    (event: 'error', listener: (error: unknown) => void): unknown
  }
  statusCode: number
  statusMessage: string
}
export type ElectronClientRequestLike = {
  abort: () => void
  end: (chunk?: string | Buffer) => unknown
  on: (event: 'error', listener: (error: unknown) => void) => unknown
  once: {
    (event: 'response', listener: (response: ElectronIncomingMessageLike) => void): unknown
    (event: 'abort' | 'close', listener: () => void): unknown
    (event: 'error', listener: (error: unknown) => void): unknown
  }
  setHeader: (name: string, value: string) => void
}
export type ElectronRequestFactory = (options: {
  method: string
  url: string
  redirect: 'follow' | 'error' | 'manual'
  credentials?: 'omit' | 'include'
  useSessionCookies?: boolean
}) => ElectronClientRequestLike

async function readRequestBody(request: Request): Promise<Buffer | null> {
  if (!request.body) return null
  const reader = request.body.getReader(), chunks: Buffer[] = []
  let size = 0, rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const cancel = () => {
    const reason = request.signal.reason || new DOMException('The operation was aborted.', 'AbortError')
    rejectAbort(reason)
    try { void reader.cancel(reason).catch(() => undefined) } catch { /* Do not wait on an abort-ignoring upload producer. */ }
  }
  request.signal.addEventListener('abort', cancel, { once: true })
  try {
    if (request.signal.aborted) cancel()
    for (;;) {
      const item = await Promise.race([reader.read(), aborted])
      request.signal.throwIfAborted()
      if (item.done) return Buffer.concat(chunks, size)
      if (!(item.value instanceof Uint8Array)) throw new TypeError('Electron request body stream must yield Uint8Array chunks.')
      const bytes = Buffer.from(item.value); size += bytes.length; chunks.push(bytes)
    }
  } catch (error) {
    try { void reader.cancel(error).catch(() => undefined) } catch { /* Preserve original rejection. */ }
    throw error
  } finally {
    request.signal.removeEventListener('abort', cancel)
    try { reader.releaseLock() } catch { /* A pending read/producer may still be cancelling. */ }
  }
}

type ManagedTransportPolicy = Readonly<{ retain: ProviderRawWorkRetainer; assertCurrent: () => void }>
/** Managed first-run has no upload producer: reject everything except already
 * prepared, bounded UTF-8 text before invoking Request or a provider factory. */
function captureManagedRequest(input: RequestInfo | URL, init: RequestInit | undefined): { request: Request; body: Buffer } {
  const values = managedOwnValues(init)
  if (typeof input !== 'string' || Reflect.ownKeys(values).some(key => !['method', 'headers', 'body', 'signal', 'redirect', 'credentials'].includes(String(key))) ||
      values.method !== 'POST' || values.redirect !== 'error' || values.credentials !== 'omit' || typeof values.body !== 'string' ||
      !values.body || Buffer.byteLength(values.body, 'utf8') > 64 * 1024 ||
      values.signal !== undefined && (isProxy(values.signal) || !(values.signal instanceof AbortSignal))) throw Error('Managed transport requires a prepared text POST body, redirect refusal and no cookies; upload producers are unsupported.')
  const headers = captureManagedData(values.headers ?? {}) as Record<string, string>
  if (Object.values(headers).some(value => typeof value !== 'string')) throw Error('Managed transport requires plain text headers.')
  return { request: new Request(input, { method: 'POST', headers, signal: values.signal as AbortSignal | undefined, redirect: 'error', credentials: 'omit' }), body: Buffer.from(values.body, 'utf8') }
}

/** MAIN-only synchronous arbitration around actual native request startup.
 * An admission failure before start rejects; after start, transport outcome wins:
 * do not abort or hide an in-flight response due to an admission failure.
 * Async return values are observed but cannot defer or undo startup.
 * This is a transport hook, not identity verification or an IPC capability. */
export type ElectronTransportAdmission = (start: () => void) => void

/** Existing ordinary main transport; no passive ownership unless the private
 * managed constructor is chosen. Not policy/owner/clean authority. */
export const createElectronRequestFetch = (electronRequest: ElectronRequestFactory, admission?: ElectronTransportAdmission): FetchImpl => createRequestFetch(electronRequest, undefined, admission)
/** Trusted Electron factory contract: throw means no request was created; a returned
 * request emits its final `close` after all transaction events, never before return.
 * Passive registration precedes factory dispatch; caller settlement is not close. */
export const createManagedElectronRequestFetch = (
  electronRequest: ElectronRequestFactory,
  retain: ProviderRawWorkRetainer,
  assertCurrent: () => void
): FetchImpl => createRequestFetch(electronRequest, { retain, assertCurrent })

const createRequestFetch = (electronRequest: ElectronRequestFactory, managed?: ManagedTransportPolicy, admission?: ElectronTransportAdmission): FetchImpl =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const prepared = managed ? captureManagedRequest(input, init) : undefined
    const request = prepared?.request ?? new Request(input, init)
    request.signal.throwIfAborted()
    // A redirect can start a second HTTP request after End, outside this synchronous admission.
    // Restricted callers must opt into refusal; leave ordinary (non-admitted) fetch unchanged.
    if (admission && request.redirect !== 'error') throw new Error('Admitted transport requires redirect refusal.')
    const body = prepared ? prepared.body : await readRequestBody(request)
    if (request.signal.aborted) {
      throw request.signal.reason || new DOMException('The operation was aborted.', 'AbortError')
    }
    // Reserve passive transaction ownership before the factory can synchronously
    // reenter abort/close. Sealed below, but released ONLY by actual last close.
    managed?.assertCurrent()
    const lifetime = managed ? new ProviderRawWorkLifetime(managed.retain) : undefined
    let releaseClose!: () => void
    if (lifetime) lifetime.track(new Promise<void>(resolve => { releaseClose = resolve }))
    try {
    return await new Promise<Response>((resolve, reject) => {
      let admissionActive = true, started = false
      const start = (): void => {
      if (!admissionActive || started) throw new Error('Transport admission must start synchronously exactly once.')
      started = true
      let clientRequest: ElectronClientRequestLike
      try {
        managed?.assertCurrent(); request.signal.throwIfAborted()
        clientRequest = electronRequest({
        method: request.method,
        url: request.url,
        redirect:
          request.redirect === 'manual'
            ? 'manual'
            : request.redirect === 'error'
              ? 'error'
              : 'follow',
        // Electron's same-origin mode requires an origin; retain legacy defaults otherwise.
        ...(request.credentials === 'omit'
          ? { credentials: 'omit' as const, useSessionCookies: false }
          : request.credentials === 'include'
            ? { credentials: 'include' as const }
            : {})
      })
      } catch (error) {
        // The trusted factory threw without creating a request, or final admission
        // refused before invocation. No native transaction requires a close.
        releaseClose?.()
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      let closed = false
      let settled = false
      let requestAborted = false
      let responseEnded = false
      let closeQuarantined = false
      let abortInProgress = false
      let abortConfirmed = false
      let closeQualification: boolean | undefined
      let abortResponseStream: ((reason: unknown) => void) | null = null
      const cleanup = (): void => request.signal.removeEventListener('abort', handleAbort)
      const abortClientRequest = (): void => {
        if (requestAborted || closed) return
        requestAborted = true // Reentrancy guard, NOT evidence that abort succeeded.
        if (!lifetime) { clientRequest.abort(); return }
        abortInProgress = true
        try { clientRequest.abort(); abortConfirmed = true }
        catch { closeQuarantined = true /* An abort throw cannot qualify any close. */ }
        finally {
          abortInProgress = false
          if (closeQualification !== undefined) {
            // A close emitted inside abort waits for its successful return. Never
            // use an abort event emitted by that call if the call later throws.
            if (!closeQuarantined && abortConfirmed) closeQualification = true
            finishManagedClose()
          }
        }
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const failRequest = (error: unknown): void => {
        if (settled && !abortResponseStream) return
        abortResponseStream?.(error)
        fail(error)
        abortClientRequest()
      }
      const handleAbort = (): void => {
        const reason =
          request.signal.reason || new DOMException('The operation was aborted.', 'AbortError')
        failRequest(reason)
      }
      function finishManagedClose(): void {
        if (closeQuarantined) return
        if (!closeQualification) {
          closeQuarantined = true
          failRequest(new Error('Electron transaction close violated its required last-event contract; native ownership remains quarantined.'))
          return
        }
        closed = true
        try {
          if (!settled || abortResponseStream) failRequest(new Error('Electron transaction closed before its response completed.'))
          releaseClose()
        } catch {
          // Unexpected trusted callback failure cannot fabricate completed cleanup.
          // Keep the positive close-tail proof unresolved, not timeout-unlocked.
          closeQuarantined = true
        }
      }
      try {
      if (lifetime) clientRequest.once('close', () => {
        // Snapshot before failure/abort callouts: upload/Writable close alone is
        // not native transaction proof. If abort is on-stack, its return must be
        // observed before the reentrant close can qualify. A throw poisons it.
        closeQualification = responseEnded || abortConfirmed
        if (!abortInProgress) finishManagedClose()
      })
      // Keep error listeners installed so late errors after cancellation remain harmless.
      clientRequest.on('error', failRequest)
      clientRequest.once('abort', () => {
        requestAborted = true
        if (!abortInProgress) abortConfirmed = true
        failRequest(new DOMException('The operation was aborted.', 'AbortError'))
      })
      clientRequest.once('response', (incoming) => {
        let streamFinished = false
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
        const finishStream = (reason?: unknown): void => {
          if (streamFinished) return
          streamFinished = true
          abortResponseStream = null
          cleanup()
          if (!streamController) return
          if (reason === undefined) {
            streamController.close()
          } else {
            streamController.error(reason instanceof Error ? reason : new Error(String(reason)))
          }
        }
        incoming.on('error', failRequest)
        incoming.once('aborted', () =>
          failRequest(new Error('Electron network response was aborted.'))
        )
        incoming.once('end', () => { responseEnded = true; finishStream() })
        if (settled) {
          finishStream()
          abortClientRequest()
          return
        }
        abortResponseStream = (reason) => finishStream(reason)
        try {
          const headers = new Headers()
          for (const [name, values] of Object.entries(incoming.headers)) {
            for (const value of typeof values === 'string' ? [values] : (values ?? [])) {
              headers.append(name, value)
            }
          }
          const hasNullBody =
            request.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode)
          const responseStream = hasNullBody
            ? null
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  streamController = controller
                  incoming.on('data', (chunk: Buffer | string) => {
                    if (streamFinished) return
                    controller.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
                    if (controller.desiredSize != null && controller.desiredSize <= 0)
                      incoming.pause?.()
                  })
                },
                pull() {
                  if (!streamFinished) incoming.resume?.()
                },
                cancel() {
                  if (streamFinished) return
                  streamFinished = true
                  abortResponseStream = null
                  cleanup()
                  abortClientRequest()
                }
              })
          const response = new Response(responseStream, {
            status: incoming.statusCode,
            statusText: incoming.statusMessage,
            headers
          })
          Object.defineProperty(response, 'url', { configurable: true, value: request.url })
          settled = true
          resolve(response)
          if (hasNullBody) {
            // Do not read or drain a body Fetch cannot expose, even if the peer keeps sending.
            finishStream()
            abortClientRequest()
          }
        } catch (error) {
          failRequest(error)
        }
      })
      request.signal.addEventListener('abort', handleAbort, { once: true })
      if (request.signal.aborted) {
        handleAbort()
        return
      }
      request.headers.forEach((value, name) => {
        if (request.signal.aborted || settled || name.toLowerCase() === 'content-length') return
        clientRequest.setHeader(name, value)
      })
      if (!request.signal.aborted && !settled) clientRequest.end(body || undefined)
      } catch (error) {
        failRequest(error)
      }
      }
      try {
        if (admission) {
          // Observe even a wrongly async admission, without awaiting it or granting
          // a later start. Once started, its failures cannot revoke native work.
          const result: unknown = admission(start)
          if (result && (typeof result === 'object' || typeof result === 'function'))
            void Promise.resolve(result).catch(() => undefined)
        } else start()
        if (!started) reject(new Error('Transport admission did not synchronously start the request.'))
      } catch (error) {
        if (!started) reject(error)
      } finally { admissionActive = false }
    })
    } finally { lifetime?.seal() }
  }) as FetchImpl

export const createMainProcessManagedElectronFetch = (
  retain: ProviderRawWorkRetainer,
  assertCurrent: () => void
): FetchImpl => {
  // This exact installed runtime has been observed emitting ClientRequest close
  // on upload finish, followed by native callbacks. Never dispatch managed work
  // whose final-close ownership contract is known false. Other versions are NOT
  // certified by this narrow exclusion; no private stream/loader mutation or
  // ordinary/net.fetch fallback may turn it into a positive native witness.
  if (process.versions.electron === '42.11.16') throw Error('Managed text transport is unavailable on Electron 42.11.16: native last-close contract is incompatible.')
  const request = (net as unknown as { request?: typeof net.request } | undefined)?.request
  if (typeof request !== 'function') throw Error('Managed text transport requires Electron native request transaction support; no ordinary fetch fallback.')
  return createManagedElectronRequestFetch(
    options => request.call(net, options) as unknown as ElectronClientRequestLike,
    retain,
    assertCurrent
  )
}

const createMainProcessElectronRequestFetch = (): FetchImpl | null => {
  const electronRequest = (net as unknown as { request?: typeof net.request } | undefined)?.request
  if (typeof electronRequest !== 'function') return null
  return createElectronRequestFetch(
    (options) => electronRequest.call(net, options) as unknown as ElectronClientRequestLike
  )
}
export const createMainProcessElectronFetch = (): FetchImpl | null => {
  const electronFetch = getElectronNetFetch()
  const electronRequestFetch = createMainProcessElectronRequestFetch()
  if (!electronFetch && !electronRequestFetch) return null
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(
      init?.method || (input instanceof Request ? input.method : 'GET')
    ).toUpperCase()
    const hasBody = init?.body != null || (input instanceof Request && input.body != null)
    if (hasBody && method !== 'GET' && method !== 'HEAD' && electronRequestFetch) {
      return electronRequestFetch(input, init)
    }
    if (electronFetch) {
      return electronFetch(
        input instanceof URL ? input.toString() : (input as unknown as string | Request),
        init as Parameters<typeof electronFetch>[1]
      )
    }
    return electronRequestFetch!(input, init)
  }) as FetchImpl
}
