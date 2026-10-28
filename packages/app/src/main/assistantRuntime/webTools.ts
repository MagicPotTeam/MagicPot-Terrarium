import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import {
  MAX_REMOTE_FETCH_RESPONSE_BYTES,
  resolveRemoteFetchAddress,
  type RemoteFetchResolvedAddress
} from '../api/remoteFetchPolicy'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 30_000
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_FETCH_RESPONSE_BYTES = Math.min(MAX_REMOTE_FETCH_RESPONSE_BYTES, 4 * 1024 * 1024)
const MAX_FETCH_TEXT_CHARS = 24_000
const MAX_SEARCH_RESULTS = 8
const MAX_REDIRECTS = 3
const MAX_URL_LENGTH = 8_192
const MAX_REQUEST_ATTEMPTS = 2
const MAX_RETRY_DELAY_MS = 2_000
const USER_AGENT = 'MagicPot-Terrarium/1.0 (web search tool)'
const TEXT_CONTENT_TYPES = new Set([
  'application/atom+xml',
  'application/javascript',
  'application/ld+json',
  'application/rss+xml',
  'application/xhtml+xml',
  'application/xml',
  'application/yaml',
  'application/json',
  'text/css',
  'text/csv',
  'text/html',
  'text/javascript',
  'text/markdown',
  'text/plain',
  'text/xml'
])

export type WebSearchItem = {
  title: string
  url: string
  snippet: string
}

export type WebSearchResponse = {
  query: string
  results: WebSearchItem[]
  source: 'duckduckgo'
}

export type WebFetchResponse = {
  url: string
  finalUrl: string
  status: number
  contentType: string
  title?: string
  text: string
  truncated: boolean
}

type RequestResult = {
  status: number
  headers: Record<string, string>
  body: Buffer
  url: string
}

const asTimeout = (value: unknown, fallback = DEFAULT_TIMEOUT_MS): number => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, numeric))
}

const createWebAbortError = (reason?: unknown): Error => {
  const error =
    reason instanceof Error
      ? reason
      : new Error(typeof reason === 'string' ? reason : 'Web request aborted.')
  error.name = 'AbortError'
  return error
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  throw createWebAbortError(signal.reason)
}

const validatePublicUrl = (value: string): URL => {
  if (value.length > MAX_URL_LENGTH) throw new Error('Web URL is too long.')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Web URL must be absolute and use https.')
  }
  if (parsed.protocol !== 'https:') throw new Error('Web URL must use https.')
  if (parsed.username || parsed.password) throw new Error('Web URL must not include credentials.')
  if (parsed.hash) parsed.hash = ''
  if (!parsed.hostname) throw new Error('Web URL must include a host.')
  return parsed
}

const toHeaderRecord = (headers: IncomingMessage['headers']): Record<string, string> => {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) output[key.toLowerCase()] = value.join(', ')
    else if (value !== undefined) output[key.toLowerCase()] = String(value)
  }
  return output
}

const isRetryableWebStatus = (status: number): boolean =>
  status === 408 ||
  status === 425 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504

const isRetryableWebError = (error: unknown): boolean => {
  if (!(error instanceof Error) || error.name === 'AbortError') return false
  if (error.name === 'TimeoutError') return true
  const code = String((error as Error & { code?: unknown }).code || '').toUpperCase()
  return new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH']).has(code)
}

const parseRetryAfterMs = (headers: Record<string, string>): number => {
  const value = headers['retry-after']?.trim()
  if (!value) return 250
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1_000))
  }
  const dateMs = Date.parse(value) - Date.now()
  return Number.isFinite(dateMs) && dateMs > 0 ? Math.min(MAX_RETRY_DELAY_MS, dateMs) : 250
}

const waitForWebRetry = async (delayMs: number, signal?: AbortSignal): Promise<void> => {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createWebAbortError(signal?.reason))
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      Math.max(0, Math.min(MAX_RETRY_DELAY_MS, delayMs))
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
  throwIfAborted(signal)
}

const requestOnce = async (
  url: URL,
  options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number; accept?: string },
  address: RemoteFetchResolvedAddress
): Promise<RequestResult> => {
  // Check before installing listeners so an already-cancelled request cannot
  // leave a timer or abort listener behind when the Promise executor exits.
  throwIfAborted(options.signal)
  return new Promise((resolve, reject) => {
    let settled = false
    let received = 0
    const chunks: Buffer[] = []
    let response: IncomingMessage | undefined
    let request: ReturnType<typeof https.request> | undefined
    const timeout = setTimeout(
      () => finish(Object.assign(new Error('Web request timed out.'), { name: 'TimeoutError' })),
      options.timeoutMs
    )
    const cleanup = () => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      // Keep error listeners attached until the destroyed streams finish
      // reporting. Removing them before destroy() can turn a late socket/body
      // error into an uncaught exception; the settled guard makes repeats no-op.
      response?.removeAllListeners('data')
      response?.removeAllListeners('aborted')
      response?.removeAllListeners('end')
      request?.removeAllListeners('timeout')
    }
    const finish = (error?: Error, value?: RequestResult) => {
      if (settled) return
      settled = true
      // Stop an in-flight response body as well as its request when a
      // timeout, cancellation, or size limit settles the operation early.
      // Destroy before removing listeners so stream errors remain observed.
      if (error && response && !response.destroyed && !response.complete) {
        response.destroy()
      }
      cleanup()
      if (request && !request.destroyed) request.destroy()
      if (error) reject(error)
      else resolve(value!)
    }
    const onAbort = () => finish(createWebAbortError(options.signal?.reason))
    try {
      request = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname || '/'}${url.search}`,
          method: 'GET',
          headers: {
            accept:
              options.accept ||
              'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'accept-encoding': 'identity',
            'user-agent': USER_AGENT
          },
          agent: false,
          family: address.family,
          lookup: (_hostname, _lookupOptions, callback) =>
            callback(null, address.address, address.family)
        },
        (incoming) => {
          response = incoming
          // Cancellation/timeout may settle the request before headers arrive.
          // Drain that late response with an error sink and destroy it rather
          // than leaving a body stream alive after the caller has returned.
          if (settled) {
            incoming.once('error', () => undefined)
            if (!incoming.destroyed) incoming.destroy()
            return
          }
          // Install the error/termination listeners before any synchronous
          // size check can destroy the response. A content-length rejection
          // still destroys the body, whose late error must be observed.
          incoming.once('error', (error) =>
            finish(error instanceof Error ? error : new Error(String(error)))
          )
          incoming.once('aborted', () => finish(new Error('Web response was aborted.')))
          incoming.once('end', () => {
            if (settled) return
            finish(undefined, {
              status: incoming.statusCode || 500,
              headers: toHeaderRecord(incoming.headers),
              body: Buffer.concat(chunks, received),
              url: url.toString()
            })
          })
          incoming.on('data', (chunk: Buffer) => {
            if (settled) return
            received += chunk.length
            if (received > options.maxBytes) {
              finish(new Error('Web response is too large.'))
              return
            }
            chunks.push(Buffer.from(chunk))
          })
          const contentLength = Number(incoming.headers['content-length'] || 0)
          if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
            finish(new Error('Web response is too large.'))
            return
          }
        }
      )
      // A custom/mock transport can invoke its response callback synchronously
      // before https.request returns. Ensure that a request allocated after a
      // terminal callback is destroyed with an error sink instead of being
      // allowed to open a socket after the operation already settled.
      if (settled) {
        request.once('error', () => undefined)
        if (!request.destroyed) request.destroy()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // AbortSignal does not replay an already-fired event to a newly attached
      // listener, so check once more after the request is allocated.
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      request.once('error', (error) =>
        finish(error instanceof Error ? error : new Error(String(error)))
      )
      request.once('timeout', () =>
        finish(Object.assign(new Error('Web request timed out.'), { name: 'TimeoutError' }))
      )
      request.end()
    } catch (error) {
      // https.request may reject synchronously (for example when a mocked or
      // custom transport rejects its options). Route that path through finish
      // so timers and abort listeners are released just like async failures.
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

const requestPublic = async (
  initialUrl: URL,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes: number; accept?: string }
): Promise<RequestResult> => {
  const timeoutMs = asTimeout(options.timeoutMs)
  let url = initialUrl
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    throwIfAborted(options.signal)
    let attempt = 1
    let result: RequestResult
    for (;;) {
      throwIfAborted(options.signal)
      try {
        // Resolve on every attempt so a transient DNS failure can recover while
        // each retry still receives the same private-address validation.
        const address = await resolveRemoteFetchAddress(url.hostname, {
          signal: options.signal,
          timeoutMs
        })
        result = await requestOnce(url, { ...options, timeoutMs }, address)
      } catch (error) {
        if (attempt >= MAX_REQUEST_ATTEMPTS || !isRetryableWebError(error)) throw error
        attempt += 1
        await waitForWebRetry(250 * attempt, options.signal)
        continue
      }
      if (attempt < MAX_REQUEST_ATTEMPTS && isRetryableWebStatus(result.status)) {
        attempt += 1
        await waitForWebRetry(parseRetryAfterMs(result.headers), options.signal)
        continue
      }
      break
    }
    if (result.status >= 300 && result.status < 400) {
      const location = result.headers.location
      if (!location)
        throw new Error(`Web request returned redirect ${result.status} without a location.`)
      if (redirect === MAX_REDIRECTS) throw new Error('Web request exceeded redirect limit.')
      url = validatePublicUrl(new URL(location, url).toString())
      continue
    }
    return result
  }
  throw new Error('Web request failed.')
}

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, digits) =>
      String.fromCodePoint(Math.min(0x10ffff, Number(digits)))
    )
    .replace(/&#x([\da-f]+);/gi, (_match, digits) =>
      String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(digits, 16)))
    )

const stripHtml = (value: string): string =>
  decodeHtmlEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()

const isTextContentType = (contentType: string): boolean => {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() || ''
  return normalized.startsWith('text/') || TEXT_CONTENT_TYPES.has(normalized)
}

const decodeUrl = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/&amp;/g, '&'))
  } catch {
    return value
  }
}

const normalizeSearchResultUrl = (value: string): string => {
  let parsed = validatePublicUrl(value)
  // DuckDuckGo's HTML endpoint wraps targets in /l/?uddg=... redirects.
  // Expose the target URL as the citation while still validating it with the
  // same HTTPS/SSRF checks when it is later fetched.
  if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
    const target = parsed.searchParams.get('uddg')
    if (target) parsed = validatePublicUrl(target)
  }
  return parsed.toString()
}

const parseDuckDuckGoHtml = (html: string, maxResults: number): WebSearchItem[] => {
  const results: WebSearchItem[] = []
  const seen = new Set<string>()
  const pattern =
    /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) && results.length < maxResults) {
    let url = decodeUrl(match[1])
    try {
      if (url.startsWith('//')) url = `https:${url}`
      url = normalizeSearchResultUrl(url)
    } catch {
      continue
    }
    if (seen.has(url)) continue
    const title = stripHtml(match[2])
    const following = html.slice(pattern.lastIndex, pattern.lastIndex + 3000)
    const snippetMatch = following.match(
      /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\//i
    )
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''
    if (!title) continue
    seen.add(url)
    results.push({ title, url, snippet })
  }
  return results
}

const parseDuckDuckGoJson = (payload: string, maxResults: number): WebSearchItem[] => {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return []
  }
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const results: WebSearchItem[] = []
  const add = (title: unknown, url: unknown, snippet: unknown) => {
    if (results.length >= maxResults || typeof title !== 'string' || typeof url !== 'string') return
    try {
      const normalizedUrl = normalizeSearchResultUrl(url)
      if (results.some((item) => item.url === normalizedUrl)) return
      results.push({
        title: stripHtml(title),
        url: normalizedUrl,
        snippet: stripHtml(String(snippet || ''))
      })
    } catch {
      // Ignore malformed third-party result URLs.
    }
  }
  add(record.Heading, record.AbstractURL, record.AbstractText)
  const topics = Array.isArray(record.RelatedTopics) ? record.RelatedTopics : []
  for (const topic of topics) {
    if (!topic || typeof topic !== 'object') continue
    const item = topic as Record<string, unknown>
    if (Array.isArray(item.Topics)) {
      for (const nested of item.Topics) {
        if (!nested || typeof nested !== 'object') continue
        const nestedRecord = nested as Record<string, unknown>
        add(nestedRecord.Text, nestedRecord.FirstURL, nestedRecord.Text)
      }
    } else {
      add(item.Text, item.FirstURL, item.Text)
    }
  }
  return results
}

export const webSearch = async (
  query: string,
  options: { maxResults?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<WebSearchResponse> => {
  const normalizedQuery = String(query || '').trim()
  if (!normalizedQuery) throw new Error('web_search requires a non-empty query.')
  if (normalizedQuery.length > 512) throw new Error('web_search query is too long.')
  const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.trunc(options.maxResults || 5)))
  const encoded = encodeURIComponent(normalizedQuery)
  const apiUrl = validatePublicUrl(
    `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`
  )
  const api = await requestPublic(apiUrl, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: MAX_SEARCH_RESPONSE_BYTES,
    accept: 'application/json,text/plain;q=0.8,*/*;q=0.5'
  })
  let results = parseDuckDuckGoJson(api.body.toString('utf8'), maxResults)
  if (!results.length) {
    const htmlUrl = validatePublicUrl(`https://html.duckduckgo.com/html/?q=${encoded}`)
    const html = await requestPublic(htmlUrl, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxBytes: MAX_SEARCH_RESPONSE_BYTES,
      accept: 'text/html,*/*;q=0.5'
    })
    results = parseDuckDuckGoHtml(html.body.toString('utf8'), maxResults)
  }
  return { query: normalizedQuery, source: 'duckduckgo', results }
}

export const webFetch = async (
  rawUrl: string,
  options: { timeoutMs?: number; signal?: AbortSignal; maxChars?: number } = {}
): Promise<WebFetchResponse> => {
  const normalizedUrl = String(rawUrl || '').trim()
  if (!normalizedUrl) throw new Error('web_fetch requires a URL.')
  if (normalizedUrl.length > 4096) throw new Error('web_fetch URL is too long.')
  const url = validatePublicUrl(normalizedUrl)
  const result = await requestPublic(url, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: MAX_FETCH_RESPONSE_BYTES
  })
  if (result.status < 200 || result.status >= 300)
    throw new Error(`Web fetch returned HTTP ${result.status}.`)
  const contentType = result.headers['content-type'] || 'application/octet-stream'
  const raw = result.body.toString('utf8')
  const isHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType) || /<html\b/i.test(raw)
  if (!isTextContentType(contentType) && !isHtml) {
    throw new Error(`Web fetch does not support binary content type: ${contentType}.`)
  }
  const titleMatch = isHtml ? raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) : null
  const text = isHtml ? stripHtml(raw) : raw.replace(/\s+/g, ' ').trim()
  const maxChars = Math.max(
    1_000,
    Math.min(MAX_FETCH_TEXT_CHARS, Math.trunc(options.maxChars || 12_000))
  )
  return {
    url: url.toString(),
    finalUrl: result.url,
    status: result.status,
    contentType,
    ...(titleMatch ? { title: stripHtml(titleMatch[1]).slice(0, 500) } : {}),
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars
  }
}
