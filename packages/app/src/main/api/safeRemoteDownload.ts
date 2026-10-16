import https from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { resolveRemoteFetchAddress } from './remoteFetchPolicy'

export const DEFAULT_REMOTE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024
export const DEFAULT_REMOTE_DOWNLOAD_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REDIRECTS = 5
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])

type SafeRemoteDownloadOptions = {
  allowedContentTypes: readonly string[]
  headers?: Readonly<Record<string, string>>
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  errorLabel?: string
  signal?: AbortSignal
}

export type SafeRemoteDownloadResult = {
  buffer: Buffer
  contentType: string
  finalUrl: URL
}

type DownloadResponse =
  { kind: 'redirect'; url: URL } | { kind: 'result'; result: SafeRemoteDownloadResult }

const createNamedError = (name: string, message: string): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

const getAbortReason = (signal?: AbortSignal): Error => {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string' && reason.trim()) {
    return createNamedError('AbortError', reason)
  }
  return createNamedError('AbortError', 'The operation was aborted.')
}

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

const normalizeContentType = (value: string | undefined): string =>
  value?.split(';')[0]?.trim().toLowerCase() || ''

const validateUrl = (value: string): URL => {
  const url = new URL(value)
  if (url.protocol !== 'https:') {
    throw new Error('Remote download URL must use https.')
  }
  if (url.username || url.password || url.hash) {
    throw new Error('Remote download URL must not include credentials or a fragment.')
  }
  return url
}

const contentTypeAllowed = (contentType: string, allowed: readonly string[]): boolean =>
  allowed.some((value) => {
    const normalized = value.trim().toLowerCase()
    return normalized.endsWith('/')
      ? contentType.startsWith(normalized)
      : contentType === normalized
  })

const closeResponse = (response: IncomingMessage | null): void => {
  if (!response) return
  if (typeof response.destroy === 'function' && !response.destroyed) {
    response.destroy()
    return
  }
  response.resume()
}

export const safeRemoteDownload = async (
  sourceUrl: string,
  options: SafeRemoteDownloadOptions
): Promise<SafeRemoteDownloadResult> => {
  const maxBytes =
    Number.isFinite(options.maxBytes) && (options.maxBytes as number) >= 0
      ? (options.maxBytes as number)
      : DEFAULT_REMOTE_DOWNLOAD_MAX_BYTES
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? (options.timeoutMs as number)
      : DEFAULT_REMOTE_DOWNLOAD_TIMEOUT_MS
  const maxRedirects =
    Number.isInteger(options.maxRedirects) && (options.maxRedirects as number) >= 0
      ? (options.maxRedirects as number)
      : DEFAULT_MAX_REDIRECTS
  const errorLabel = options.errorLabel ?? 'remote resource'
  const initialUrl = validateUrl(sourceUrl)

  if (options.signal?.aborted) {
    throw getAbortReason(options.signal)
  }

  const deadlineAt = Date.now() + timeoutMs
  const timeoutError = (): Error =>
    createNamedError('TimeoutError', `Failed to download ${errorLabel}: request timed out.`)

  return new Promise<SafeRemoteDownloadResult>((resolve, reject) => {
    let settled = false
    let currentRequest: ClientRequest | null = null
    let currentResponse: IncomingMessage | null = null
    let cancelCurrent: ((reason: Error) => void) | null = null
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
      options.signal?.removeEventListener('abort', onCallerAbort)
    }

    const finishResolve = (result: SafeRemoteDownloadResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const finishReject = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const abortOperation = (reason: Error): void => {
      if (settled) return
      cancelCurrent?.(reason)
      finishReject(reason)
    }

    const onCallerAbort = (): void => {
      abortOperation(getAbortReason(options.signal))
    }

    const failIfExpired = (): boolean => {
      if (settled) return true
      if (Date.now() < deadlineAt) return false
      abortOperation(timeoutError())
      return true
    }

    const performRequest = (
      url: URL,
      resolvedAddress: { address: string; family: 4 | 6 },
      redirects: number
    ): Promise<DownloadResponse> =>
      new Promise<DownloadResponse>((resolveRequest, rejectRequest) => {
        let response: IncomingMessage | null = null
        let localSettled = false
        let responseEnded = false
        let declaredContentLength: number | undefined

        const removeListeners = (): void => {
          request.removeListener('error', onRequestError)
          response?.removeListener('error', onResponseError)
          response?.removeListener('aborted', onResponseAborted)
          response?.removeListener('close', onResponseClose)
        }

        const destroyTransport = (): void => {
          closeResponse(response)
          try {
            request.destroy()
          } catch {
            // The request may already have closed while the response was rejected.
          }
        }

        const finishRequestReject = (error: unknown): void => {
          if (localSettled) return
          localSettled = true
          destroyTransport()
          removeListeners()
          if (cancelCurrent === cancelRequest) cancelCurrent = null
          if (currentRequest === request) currentRequest = null
          if (currentResponse === response) currentResponse = null
          rejectRequest(normalizeError(error))
        }

        const finishRequestResolve = (value: DownloadResponse, close = false): void => {
          if (localSettled) return
          localSettled = true
          if (close) destroyTransport()
          removeListeners()
          if (cancelCurrent === cancelRequest) cancelCurrent = null
          if (currentRequest === request) currentRequest = null
          if (currentResponse === response) currentResponse = null
          resolveRequest(value)
        }

        const cancelRequest = (reason: Error): void => {
          finishRequestReject(reason)
        }

        const onRequestError = (error: unknown): void => {
          finishRequestReject(error)
        }

        const onResponseError = (error: unknown): void => {
          finishRequestReject(error)
        }

        const onResponseAborted = (): void => {
          finishRequestReject(new Error(`Failed to download ${errorLabel}: response was aborted.`))
        }

        const onResponseClose = (): void => {
          if (!responseEnded) {
            finishRequestReject(
              new Error(`Failed to download ${errorLabel}: response closed early.`)
            )
          }
        }

        const headers =
          url.origin === initialUrl.origin
            ? {
                ...options.headers,
                Accept: options.allowedContentTypes.join(', ')
              }
            : { Accept: options.allowedContentTypes.join(', ') }

        const request = https.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers,
            servername: url.hostname,
            lookup: (_hostname, _options, callback) => {
              callback(null, resolvedAddress.address, resolvedAddress.family)
            }
          },
          (incomingResponse) => {
            response = incomingResponse
            currentResponse = response
            response.on('error', onResponseError)
            response.on('aborted', onResponseAborted)
            response.on('close', onResponseClose)

            const status = response.statusCode ?? 500
            const location = response.headers.location
            if (REDIRECT_STATUS_CODES.has(status)) {
              if (typeof location !== 'string' || !location) {
                finishRequestReject(
                  new Error(`Failed to download ${errorLabel}: redirect has no location.`)
                )
                return
              }
              if (redirects >= maxRedirects) {
                finishRequestReject(
                  new Error(`Failed to download ${errorLabel}: too many redirects.`)
                )
                return
              }

              let redirectUrl: URL
              try {
                redirectUrl = validateUrl(new URL(location, url).toString())
              } catch (error) {
                finishRequestReject(normalizeError(error))
                return
              }

              finishRequestResolve({ kind: 'redirect', url: redirectUrl }, true)
              return
            }

            if (status < 200 || status >= 300) {
              finishRequestReject(
                new Error(
                  `Failed to download ${errorLabel}: ${status} ${response.statusMessage || ''}`.trim()
                )
              )
              return
            }

            const contentType = normalizeContentType(response.headers['content-type'])
            if (!contentType || !contentTypeAllowed(contentType, options.allowedContentTypes)) {
              finishRequestReject(
                new Error(`Failed to download ${errorLabel}: unsupported content type.`)
              )
              return
            }

            const rawContentLength = response.headers['content-length']
            if (rawContentLength !== undefined) {
              if (!/^\d+$/.test(rawContentLength)) {
                finishRequestReject(
                  new Error(`Failed to download ${errorLabel}: invalid content length.`)
                )
                return
              }
              const contentLength = Number(rawContentLength)
              if (!Number.isSafeInteger(contentLength)) {
                finishRequestReject(
                  new Error(`Failed to download ${errorLabel}: invalid content length.`)
                )
                return
              }
              if (contentLength > maxBytes) {
                finishRequestReject(
                  new Error(`Failed to download ${errorLabel}: response is too large.`)
                )
                return
              }
              declaredContentLength = contentLength
            }

            const chunks: Buffer[] = []
            let receivedBytes = 0
            response.on('data', (chunk: Buffer | Uint8Array | string) => {
              if (localSettled) return
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              receivedBytes += buffer.byteLength
              if (receivedBytes > maxBytes) {
                finishRequestReject(
                  new Error(`Failed to download ${errorLabel}: response is too large.`)
                )
                return
              }
              chunks.push(buffer)
            })
            response.on('end', () => {
              if (localSettled) return
              responseEnded = true
              if (declaredContentLength !== undefined && receivedBytes !== declaredContentLength) {
                finishRequestReject(
                  new Error(`Failed to download ${errorLabel}: content length mismatch.`)
                )
                return
              }
              finishRequestResolve({
                kind: 'result',
                result: {
                  buffer: Buffer.concat(chunks, receivedBytes),
                  contentType,
                  finalUrl: url
                }
              })
            })
          }
        )

        currentRequest = request
        request.on('error', onRequestError)
        cancelCurrent = cancelRequest
        const remainingMs = Math.max(1, deadlineAt - Date.now())
        if (typeof request.setTimeout === 'function') {
          request.setTimeout(remainingMs, () => abortOperation(timeoutError()))
        }
        if (settled) {
          cancelRequest(getAbortReason(options.signal))
          return
        }
        request.end()
      })

    const run = async (): Promise<void> => {
      let url = initialUrl
      for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        if (settled || failIfExpired()) return

        let resolvedAddress: { address: string; family: 4 | 6 }
        try {
          resolvedAddress = await resolveRemoteFetchAddress(url.hostname)
        } catch (error) {
          if (!settled) finishReject(normalizeError(error))
          return
        }
        if (settled || failIfExpired()) return

        try {
          const response = await performRequest(url, resolvedAddress, redirects)
          if (settled) return
          if (response.kind === 'result') {
            finishResolve(response.result)
            return
          }
          url = response.url
        } catch (error) {
          if (!settled) finishReject(normalizeError(error))
          return
        }
      }

      if (!settled) {
        finishReject(new Error(`Failed to download ${errorLabel}: too many redirects.`))
      }
    }

    timeoutId = setTimeout(() => abortOperation(timeoutError()), timeoutMs)
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (options.signal?.aborted) {
      onCallerAbort()
      return
    }

    void run().catch((error) => {
      if (!settled) finishReject(normalizeError(error))
    })
  })
}
