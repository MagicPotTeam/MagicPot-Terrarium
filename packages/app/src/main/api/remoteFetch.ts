import https from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { LLMRemoteFetchReq, LLMRemoteFetchResp } from '@shared/api/svcLLMProxy'
import type { Config } from '@shared/config/config'
import {
  MAX_REMOTE_FETCH_RESPONSE_BYTES,
  resolveRemoteFetchAddress,
  validateRemoteFetchRequest,
  type RemoteFetchResolvedAddress
} from './remoteFetchPolicy'

const retryableCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'])
const timeoutError = () =>
  Object.assign(new Error('Remote request timed out.'), { name: 'TimeoutError' })
const ignoreLateError = () => undefined

// Node can emit a queued error after destroy(). Keep only a stateless error sink until close.
const dispose = (stream: ClientRequest | IncomingMessage, closed = false): void => {
  if (!closed) {
    stream.on('error', ignoreLateError)
    stream.once('close', () => stream.removeListener('error', ignoreLateError))
  }
  if (!stream.destroyed) stream.destroy()
}

export const remoteFetch = async (
  req: LLMRemoteFetchReq,
  config: Config,
  signal?: AbortSignal
): Promise<LLMRemoteFetchResp> => {
  const started = performance.now()
  const { parsedUrl, headers, timeoutMs } = validateRemoteFetchRequest(req, config)
  const deadline = started + timeoutMs

  return new Promise((resolve, reject) => {
    let settled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stopAttempt: () => void = () => undefined
    let attempts = 0
    let resolvedAddress: RemoteFetchResolvedAddress

    const finish = (error?: Error, value?: LLMRemoteFetchResp) => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      clearTimeout(retryTimer)
      signal?.removeEventListener('abort', onAbort)
      stopAttempt()
      if (error) reject(error)
      else resolve(value!)
    }
    const onAbort = () =>
      finish(Object.assign(new Error('Remote request aborted.'), { name: 'AbortError' }))
    const active = () => {
      if (settled) return false
      if (signal?.aborted) onAbort()
      else if (performance.now() >= deadline) finish(timeoutError())
      return !settled
    }
    const deadlineTimer = setTimeout(
      () => finish(timeoutError()),
      Math.max(0, deadline - performance.now())
    )
    signal?.addEventListener('abort', onAbort, { once: true })

    const startAttempt = () => {
      retryTimer = undefined
      if (!active()) return
      attempts++
      let done = false
      let request: ClientRequest | undefined
      let response: IncomingMessage | undefined
      let requestClosed = false
      let responseClosed = false
      let chunks: Buffer[] = []
      let receivedBytes = 0
      let expectedBytes: number | undefined

      const stop = () => {
        if (done) return
        done = true
        chunks = []
        if (response) {
          response.removeListener('data', onData)
          response.removeListener('end', onEnd)
          response.removeListener('error', onResponseError)
          response.removeListener('aborted', onAborted)
          response.removeListener('close', onResponseClose)
          dispose(response, responseClosed)
        }
        if (request) {
          request.removeListener('response', onResponse)
          request.removeListener('error', onRequestError)
          request.removeListener('timeout', onTimeout)
          request.removeListener('close', onRequestClose)
          dispose(request, requestClosed)
        }
      }
      stopAttempt = stop
      const onTimeout = () => {
        if (!done) finish(timeoutError())
      }
      const onRequestError = (error: NodeJS.ErrnoException) => {
        if (done || !active()) return
        // No idempotency contract exists for POST. Never replay it, even before headers.
        if (
          req.method === 'GET' &&
          !response &&
          attempts < 3 &&
          retryableCodes.has(error.code || '')
        ) {
          stop()
          retryTimer = setTimeout(startAttempt, 1000 * attempts)
        } else {
          finish(error)
        }
      }
      const onRequestClose = () => {
        requestClosed = true
        if (!done && !response) finish(new Error('Remote request closed before a response.'))
      }
      const onResponseError = (error: Error) => {
        if (!done && active()) finish(error)
      }
      const onAborted = () => onResponseError(new Error('Remote response was aborted.'))
      const onResponseClose = () => {
        responseClosed = true
        if (!done) onResponseError(new Error('Remote response closed prematurely.'))
      }
      const onData = (chunk: Buffer) => {
        if (done || !active()) return
        receivedBytes += chunk.length
        if (receivedBytes > MAX_REMOTE_FETCH_RESPONSE_BYTES) {
          finish(new Error('Remote response is too large.'))
          return
        }
        chunks.push(chunk)
      }
      const onEnd = () => {
        if (done || !active() || !response) return
        if (
          !response.complete ||
          (expectedBytes !== undefined && receivedBytes !== expectedBytes)
        ) {
          finish(new Error('Remote response body is incomplete (content length mismatch).'))
          return
        }
        finish(undefined, {
          status: response.statusCode || 500,
          statusText: response.statusMessage || '',
          body: Buffer.concat(chunks, receivedBytes).toString('utf8')
        })
      }
      const onResponse = (incoming: IncomingMessage) => {
        if (done || settled) {
          dispose(incoming)
          return
        }
        response = incoming
        if (!active()) return
        // Preserve raw HTTP failures and 3xx for compatibility; Node HTTPS never follows redirects.
        response.on('error', onResponseError)
        response.on('aborted', onAborted)
        response.on('close', onResponseClose)
        const contentLength = response.headers['content-length']
        if (contentLength !== undefined) {
          const size = Number(contentLength)
          if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(size)) {
            finish(new Error('Remote response has an invalid content length.'))
            return
          }
          if (size > MAX_REMOTE_FETCH_RESPONSE_BYTES) {
            finish(new Error('Remote response is too large.'))
            return
          }
          // 304 may advertise the size of the cached representation without sending a body.
          if (response.statusCode !== 304) expectedBytes = size
        }
        response.on('data', onData)
        response.on('end', onEnd)
      }

      try {
        request = https.request(
          {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: req.method,
            headers,
            agent: false,
            // An explicit family keeps Node from asking the pinned lookup for an address array.
            family: resolvedAddress.family,
            lookup: (_hostname, _options, callback) => {
              callback(null, resolvedAddress.address, resolvedAddress.family)
            }
          },
          onResponse
        )
        if (done) {
          dispose(request)
          return
        }
        request.on('error', onRequestError)
        request.on('timeout', onTimeout)
        request.on('close', onRequestClose)
        if (!active()) return
        if (req.body) request.write(req.body)
        if (!done && active()) request.end()
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }

    if (!active()) return
    // lookup() itself is not cancellable. Detach the operation from its eventual result,
    // and consume late rejection without opening a request after completion/cancellation.
    void resolveRemoteFetchAddress(parsedUrl.hostname).then(
      (address) => {
        if (!active()) return
        resolvedAddress = address
        startAttempt()
      },
      (error) => {
        if (active()) finish(error)
      }
    )
  })
}
