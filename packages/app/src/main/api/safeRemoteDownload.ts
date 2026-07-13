import https from 'node:https'
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
}

export type SafeRemoteDownloadResult = {
  buffer: Buffer
  contentType: string
  finalUrl: URL
}

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
  allowed.some((value) =>
    value.endsWith('/') ? contentType.startsWith(value) : contentType === value.toLowerCase()
  )

export const safeRemoteDownload = async (
  sourceUrl: string,
  options: SafeRemoteDownloadOptions
): Promise<SafeRemoteDownloadResult> => {
  const maxBytes = options.maxBytes ?? DEFAULT_REMOTE_DOWNLOAD_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_DOWNLOAD_TIMEOUT_MS
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const errorLabel = options.errorLabel ?? 'remote resource'

  const requestUrl = async (url: URL, redirects: number): Promise<SafeRemoteDownloadResult> => {
    const resolvedAddress = await resolveRemoteFetchAddress(url.hostname)

    return new Promise((resolve, reject) => {
      let settled = false
      const finishReject = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }

      const request = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            ...options.headers,
            Accept: options.allowedContentTypes.join(', ')
          },
          servername: url.hostname,
          lookup: (_hostname, _options, callback) => {
            callback(null, resolvedAddress.address, resolvedAddress.family)
          }
        },
        (response) => {
          const status = response.statusCode ?? 500
          const location = response.headers.location
          if (REDIRECT_STATUS_CODES.has(status)) {
            response.resume()
            if (!location) {
              finishReject(new Error(`Failed to download ${errorLabel}: redirect has no location.`))
              return
            }
            if (redirects >= maxRedirects) {
              finishReject(new Error(`Failed to download ${errorLabel}: too many redirects.`))
              return
            }

            let redirectUrl: URL
            try {
              redirectUrl = validateUrl(new URL(location, url).toString())
            } catch (error) {
              finishReject(error instanceof Error ? error : new Error(String(error)))
              return
            }
            void requestUrl(redirectUrl, redirects + 1).then(resolve, finishReject)
            return
          }

          if (status < 200 || status >= 300) {
            response.resume()
            finishReject(
              new Error(
                `Failed to download ${errorLabel}: ${status} ${response.statusMessage || ''}`.trim()
              )
            )
            return
          }

          const contentType = normalizeContentType(response.headers['content-type'])
          if (!contentType || !contentTypeAllowed(contentType, options.allowedContentTypes)) {
            response.resume()
            finishReject(new Error(`Failed to download ${errorLabel}: unsupported content type.`))
            return
          }

          const contentLength = Number(response.headers['content-length'])
          if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            response.resume()
            finishReject(new Error(`Failed to download ${errorLabel}: response is too large.`))
            return
          }

          const chunks: Buffer[] = []
          let receivedBytes = 0
          response.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length
            if (receivedBytes > maxBytes) {
              request.destroy(new Error(`Failed to download ${errorLabel}: response is too large.`))
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            if (settled) return
            settled = true
            resolve({ buffer: Buffer.concat(chunks, receivedBytes), contentType, finalUrl: url })
          })
          response.on('error', finishReject)
        }
      )

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Failed to download ${errorLabel}: request timed out.`))
      })
      request.on('error', finishReject)
      request.end()
    })
  }

  return requestUrl(validateUrl(sourceUrl), 0)
}
