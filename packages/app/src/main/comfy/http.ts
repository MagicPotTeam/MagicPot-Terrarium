import { Config } from '@shared/config/config'
import { ComfyHistoryResp, FileItem, ObjectInfoMap } from '@shared/comfy/types'
import { getConfig } from '../config/config'
import { WebSocket } from 'ws'
import { CustomNodeInfo, FreeMemoryReq, PostPromptReq, PostPromptResp } from '@shared/api/svcComfy'
import { NewComfyPostError } from './error'
import { JsonDict } from '@shared/utils/utilTypes'
import { BuildEnv } from '@shared/config/buildEnv'
import { getBuildEnv } from '../config/buildEnv'
import { ConfigUtils } from '@shared/config/configUtils'
import path from 'path'
import { isIP, type LookupFunction } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent } from 'undici'
import { isUnsafeComfyAddress } from './networkPolicy'

export const COMFY_PROCESS_TRANSPORT_CLIENT_ID = `magicpot-main-${process.pid}`
export const DEFAULT_COMFY_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_COMFY_RESPONSE_MAX_BYTES = 32 * 1024 * 1024

const MAX_COMFY_REQUEST_TIMEOUT_MS = 120_000
const MAX_COMFY_RESPONSE_BYTES = 256 * 1024 * 1024
type ResolvedComfyAddress = Readonly<{ address: string; family: 4 | 6 }>
type ComfyRequestDeadline = Readonly<{ signal: AbortSignal; release: () => void }>

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 502, 503, 504])
const RETRYABLE_TRANSPORT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
])

type ComfyResponseResources = Readonly<{
  signal: AbortSignal
  dispatcher?: Agent
  releaseDeadline: () => void
}>

type ComfyHttpCliOptions = {
  clientId?: string
  /** Explicit endpoint for a registered ComfyUI instance. */
  origin?: string
  /** Whether the explicit endpoint should be treated as remote for cleanup policy. */
  remote?: boolean
  /** Extra attempts for transient idempotent requests. Defaults to three. */
  networkRetries?: number
  retryBaseDelayMs?: number
  requestTimeoutMs?: number
  responseMaxBytes?: number
  /** Optional additional trusted CA. Hostname verification and SNI remain enabled. */
  tlsCa?: string | Buffer
  resolveHostname?: (hostname: string) => Promise<readonly ResolvedComfyAddress[]>
}

function normalizeComfyHttpClientId(clientId: string | null | undefined): string {
  return String(clientId || '').trim()
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max
    ? Number(value)
    : fallback
}

class ComfyHttpPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComfyHttpPolicyError'
  }
}

class ComfyHttpResolutionError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(
      `ComfyUI hostname resolution failed: ${cause instanceof Error ? cause.message : String(cause)}`
    )
    this.name = 'ComfyHttpResolutionError'
    this.cause = cause
  }
}

class ComfyHttpBodyReadError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(
      `ComfyUI response body read failed: ${cause instanceof Error ? cause.message : String(cause)}`
    )
    this.name = 'ComfyHttpBodyReadError'
    this.cause = cause
  }
}

const errorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  return errorCode((error as { cause?: unknown }).cause)
}

const isComfyHttpPolicyError = (error: unknown): boolean => error instanceof ComfyHttpPolicyError
const isRetryableTransportError = (error: unknown): boolean =>
  RETRYABLE_TRANSPORT_CODES.has(errorCode(error) ?? '')

export function normalizeComfyHttpOrigin(value: string, allowPrivate = false): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    !/^https?:\/\/[^/?#\\]+\/?$/iu.test(value)
  ) {
    throw new ComfyHttpPolicyError('Invalid ComfyUI base URL')
  }
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new ComfyHttpPolicyError('Invalid ComfyUI base URL')
  }
  if (
    (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new ComfyHttpPolicyError('Invalid ComfyUI base URL')
  }
  const hostname = origin.hostname.startsWith('[') ? origin.hostname.slice(1, -1) : origin.hostname
  if (hostname.includes('%') || (!allowPrivate && isUnsafeComfyAddress(hostname))) {
    throw new ComfyHttpPolicyError('Unsafe ComfyUI destination')
  }
  return origin.href
}

/**
 * ComfyUI HTTP API 客户端
 */
export class ComfyHttpCli {
  private clientId: string
  private configUtils: ConfigUtils
  private readonly configuredOrigin?: string
  private readonly remoteOverride?: boolean
  private readonly networkRetries: number
  private readonly retryBaseDelayMs: number
  private readonly requestTimeoutMs: number
  private readonly responseMaxBytes: number
  private readonly tlsCa?: string | Buffer
  private readonly resolveHostname: (hostname: string) => Promise<readonly ResolvedComfyAddress[]>
  private readonly responseResources = new WeakMap<Response, ComfyResponseResources>()
  constructor(
    private config: Config = getConfig(),
    private buildEnv: BuildEnv = getBuildEnv(),
    options: ComfyHttpCliOptions = {}
  ) {
    this.clientId =
      normalizeComfyHttpClientId(options.clientId) || COMFY_PROCESS_TRANSPORT_CLIENT_ID
    this.configuredOrigin = options.origin
    this.remoteOverride = options.remote ?? (options.origin === undefined ? undefined : true)
    this.networkRetries =
      Number.isSafeInteger(options.networkRetries) && Number(options.networkRetries) >= 0
        ? Math.min(3, Number(options.networkRetries))
        : 3
    this.retryBaseDelayMs =
      Number.isFinite(options.retryBaseDelayMs) && Number(options.retryBaseDelayMs) >= 0
        ? Number(options.retryBaseDelayMs)
        : 150
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      DEFAULT_COMFY_REQUEST_TIMEOUT_MS,
      MAX_COMFY_REQUEST_TIMEOUT_MS
    )
    this.responseMaxBytes = boundedInteger(
      options.responseMaxBytes,
      DEFAULT_COMFY_RESPONSE_MAX_BYTES,
      MAX_COMFY_RESPONSE_BYTES
    )
    this.tlsCa = options.tlsCa
    this.resolveHostname =
      options.resolveHostname ??
      (async (hostname) =>
        (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
          address,
          family: family as 4 | 6
        })))
    this.configUtils = new ConfigUtils(this.config, this.buildEnv, path)
  }

  private host(): string {
    return normalizeComfyHttpOrigin(
      this.configuredOrigin ?? this.configUtils.getComfyUIOrigin(),
      !this.isRemoteComfyUI()
    )
  }

  isRemoteComfyUI(): boolean {
    return this.remoteOverride ?? this.config.use_remote_comfyui === true
  }

  private async raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason
    return await new Promise<T>((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener('abort', onAbort)
      const onAbort = (): void => {
        cleanup()
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          cleanup()
          resolve(value)
        },
        (error) => {
          cleanup()
          reject(error)
        }
      )
    })
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      const timer = setTimeout(done, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        cleanup()
        reject(signal.reason)
      }
      function cleanup(): void {
        signal.removeEventListener('abort', onAbort)
      }
      function done(): void {
        cleanup()
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async resolveSafeRemoteAddress(
    url: string,
    signal?: AbortSignal
  ): Promise<ResolvedComfyAddress | undefined> {
    if (!this.isRemoteComfyUI()) return undefined
    const hostname = new URL(url).hostname.replace(/^\[|\]$/gu, '')
    if (isIP(hostname) !== 0) return undefined

    let addresses: readonly ResolvedComfyAddress[]
    try {
      addresses = signal
        ? await this.raceAbort(this.resolveHostname(hostname), signal)
        : await this.resolveHostname(hostname)
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new ComfyHttpResolutionError(error)
    }
    if (!addresses.length) throw new ComfyHttpPolicyError('ComfyUI hostname did not resolve')
    if (
      addresses.some(
        ({ address, family }) =>
          (family !== 4 && family !== 6) ||
          isIP(address) !== family ||
          isUnsafeComfyAddress(address)
      )
    ) {
      throw new ComfyHttpPolicyError('Unsafe ComfyUI DNS destination')
    }
    return addresses[0]
  }

  private createRequestDeadline(callerSignal?: AbortSignal): ComfyRequestDeadline {
    const timeoutController = new AbortController()
    const timeout = setTimeout(
      () =>
        timeoutController.abort(
          new Error(`ComfyUI response body timed out after ${this.requestTimeoutMs} ms`)
        ),
      this.requestTimeoutMs
    )
    let released = false
    return {
      signal: callerSignal
        ? AbortSignal.any([callerSignal, timeoutController.signal])
        : timeoutController.signal,
      release: () => {
        if (released) return
        released = true
        clearTimeout(timeout)
      }
    }
  }

  private retryDelay(response: Response, attempt: number): number {
    const limit = (value: number): number =>
      Number.isFinite(value) && value >= 0
        ? Math.min(value, this.requestTimeoutMs)
        : this.requestTimeoutMs
    const fallback = limit(this.retryBaseDelayMs * 2 ** attempt)
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter === null) return fallback
    if (/^\d+$/u.test(retryAfter)) return limit(Number(retryAfter) * 1_000)
    if (
      !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
        retryAfter
      )
    ) {
      return fallback
    }
    const retryAt = Date.parse(retryAfter)
    return Number.isFinite(retryAt) ? limit(Math.max(0, retryAt - Date.now())) : fallback
  }

  private async createPinnedRemoteDispatcher(
    url: string,
    signal?: AbortSignal
  ): Promise<Agent | undefined> {
    const selected = await this.resolveSafeRemoteAddress(url, signal)
    if (!selected) return undefined
    return new Agent({
      connect: {
        ...(this.tlsCa === undefined ? {} : { ca: this.tlsCa }),
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [selected])
            return
          }
          callback(null, selected.address, selected.family)
        }
      }
    })
  }

  private async settleCleanupUntilAbort(
    cleanup: Promise<unknown>,
    signal?: AbortSignal
  ): Promise<void> {
    if (!signal) {
      await cleanup.catch(() => undefined)
      return
    }
    if (signal.aborted) {
      void cleanup.catch(() => undefined)
      return
    }
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', finish)
        resolve()
      }
      signal.addEventListener('abort', finish, { once: true })
      cleanup.then(finish, finish)
    })
  }

  private async releaseResponse(response: Response, preserveDeadline = false): Promise<void> {
    const resources = this.responseResources.get(response)
    if (!resources) return
    this.responseResources.delete(response)
    try {
      await this.settleCleanupUntilAbort(
        resources.dispatcher?.destroy() ?? Promise.resolve(),
        resources.signal
      )
    } finally {
      if (!preserveDeadline) resources.releaseDeadline()
    }
  }

  private async cancelResponse(response: Response, preserveDeadline = false): Promise<void> {
    const resources = this.responseResources.get(response)
    let bodyCancellation: Promise<unknown>
    try {
      bodyCancellation = Promise.resolve(response.body?.cancel())
    } catch {
      bodyCancellation = Promise.resolve()
    }
    await Promise.all([
      this.settleCleanupUntilAbort(bodyCancellation, resources?.signal),
      this.releaseResponse(response, preserveDeadline)
    ])
  }

  private async request(
    url: string,
    init?: RequestInit,
    options: { retry?: boolean; deadline?: ComfyRequestDeadline } = {}
  ): Promise<Response> {
    let lastError: unknown
    const networkRetries = options.retry === false ? 0 : this.networkRetries
    const ownsDeadline = options.deadline === undefined
    const deadline = options.deadline ?? this.createRequestDeadline(init?.signal ?? undefined)
    const signal = deadline.signal
    let deadlineTransferred = false
    try {
      for (let attempt = 0; attempt <= networkRetries; attempt += 1) {
        if (signal.aborted) throw signal.reason
        let dispatcher: Agent | undefined
        let response: Response | undefined
        let responseTransferred = false
        let retryDelay = this.retryBaseDelayMs * 2 ** attempt
        try {
          // One deadline covers DNS, connect, headers, retry backoff, and—when this method owns
          // it—the response body after the successful response is transferred to the caller.
          dispatcher = await this.createPinnedRemoteDispatcher(url, signal)
          response = await this.raceAbort(
            fetch(url, {
              ...init,
              signal,
              redirect: 'manual',
              ...(dispatcher ? { dispatcher } : {})
            } as RequestInit),
            signal
          )
          this.responseResources.set(response, {
            signal,
            dispatcher,
            releaseDeadline: ownsDeadline ? deadline.release : () => undefined
          })
          responseTransferred = true
          dispatcher = undefined

          if (response.status >= 300 && response.status < 400) {
            await this.cancelResponse(response).catch(() => undefined)
            responseTransferred = false
            throw new ComfyHttpPolicyError('ComfyUI redirect rejected')
          }
          if (!RETRYABLE_HTTP_STATUSES.has(response.status) || attempt === networkRetries) {
            deadlineTransferred = ownsDeadline
            return response
          }
          retryDelay = this.retryDelay(response, attempt)
          try {
            await this.cancelResponse(response, true).catch(() => undefined)
          } finally {
            responseTransferred = false
          }
        } catch (error) {
          lastError = error
          if (responseTransferred && response) {
            responseTransferred = false
            await this.cancelResponse(response).catch(() => undefined)
          }
          if (
            signal.aborted ||
            isComfyHttpPolicyError(error) ||
            !isRetryableTransportError(error) ||
            attempt === networkRetries
          ) {
            throw error
          }
        } finally {
          if (!responseTransferred) await dispatcher?.destroy().catch(() => undefined)
        }
        await this.delay(retryDelay, signal)
      }
    } finally {
      if (ownsDeadline && !deadlineTransferred) deadline.release()
    }
    throw lastError instanceof Error ? lastError : new Error('ComfyUI network request failed')
  }

  private assertContentLength(response: Response): void {
    const header = response.headers.get('content-length')
    if (header === null) return
    if (!/^\d+$/u.test(header) || Number(header) > this.responseMaxBytes) {
      throw new Error(`ComfyUI response body exceeds the ${this.responseMaxBytes} byte limit`)
    }
  }

  private async boundResponseBody(
    response: Response,
    callerSignal?: AbortSignal
  ): Promise<Response> {
    try {
      this.assertContentLength(response)
    } catch (error) {
      await this.cancelResponse(response).catch(() => undefined)
      throw error
    }
    if (!response.body) {
      await this.releaseResponse(response)
      return response
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>
    try {
      reader = response.body.getReader()
    } catch (error) {
      await this.cancelResponse(response).catch(() => undefined)
      throw error
    }
    const deadlineSignal = this.responseResources.get(response)?.signal
    const cleanupSignal = callerSignal
      ? deadlineSignal
        ? AbortSignal.any([callerSignal, deadlineSignal])
        : callerSignal
      : deadlineSignal
    const maxBytes = this.responseMaxBytes
    let total = 0
    let settled = false
    let releasePromise: Promise<void> | undefined
    let currentController: ReadableStreamDefaultController<Uint8Array> | undefined
    const finish = (): Promise<void> => {
      if (!settled) {
        settled = true
        callerSignal?.removeEventListener('abort', abortBody)
        deadlineSignal?.removeEventListener('abort', abortBody)
        currentController = undefined
        releasePromise = this.releaseResponse(response)
      }
      return releasePromise ?? Promise.resolve()
    }
    const abortBody = (): void => {
      if (settled) return
      const reason =
        callerSignal?.reason ?? deadlineSignal?.reason ?? new DOMException('Aborted', 'AbortError')
      void reader.cancel(reason).catch(() => undefined)
      currentController?.error(reason)
      void finish()
    }
    callerSignal?.addEventListener('abort', abortBody, { once: true })
    deadlineSignal?.addEventListener('abort', abortBody, { once: true })
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        currentController = controller
        if (callerSignal?.aborted || deadlineSignal?.aborted) abortBody()
      },
      pull: async (controller) => {
        currentController = controller
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            await finish()
            return
          }
          total += value.byteLength
          if (total > maxBytes) {
            const error = new Error(`ComfyUI response body exceeds the ${maxBytes} byte limit`)
            controller.error(error)
            await Promise.all([
              this.settleCleanupUntilAbort(
                Promise.resolve().then(() => reader.cancel(error)),
                cleanupSignal
              ),
              finish()
            ])
            return
          }
          controller.enqueue(value)
        } catch (error) {
          if (!settled) controller.error(error)
          await finish()
        }
      },
      cancel: async (reason) => {
        await Promise.all([
          this.settleCleanupUntilAbort(
            Promise.resolve().then(() => reader.cancel(reason)),
            cleanupSignal
          ),
          finish()
        ])
      }
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }

  private async readBody(response: Response): Promise<Uint8Array> {
    try {
      try {
        this.assertContentLength(response)
      } catch (error) {
        await this.cancelResponse(response).catch(() => undefined)
        throw error
      }
      if (!response.body) return new Uint8Array()
      let reader: ReadableStreamDefaultReader<Uint8Array>
      try {
        reader = response.body.getReader()
      } catch (error) {
        await this.cancelResponse(response).catch(() => undefined)
        throw error
      }
      const deadlineSignal = this.responseResources.get(response)?.signal
      const chunks: Uint8Array[] = []
      let total = 0
      const readAll = (async () => {
        while (true) {
          let result: ReadableStreamReadResult<Uint8Array>
          try {
            result = await reader.read()
          } catch (error) {
            throw new ComfyHttpBodyReadError(error)
          }
          const { done, value } = result
          if (done) break
          total += value.byteLength
          if (total > this.responseMaxBytes) {
            const error = new Error(
              `ComfyUI response body exceeds the ${this.responseMaxBytes} byte limit`
            )
            throw error
          }
          chunks.push(value)
        }
      })()
      try {
        if (deadlineSignal) await this.raceAbort(readAll, deadlineSignal)
        else await readAll
      } catch (error) {
        await this.settleCleanupUntilAbort(
          Promise.resolve().then(() => reader.cancel(error)),
          deadlineSignal
        )
        throw error
      } finally {
        reader.releaseLock()
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    } finally {
      await this.releaseResponse(response)
    }
  }

  private async readJson<RESP>(response: Response): Promise<RESP> {
    const bytes = await this.readBody(response)
    return JSON.parse(new TextDecoder().decode(bytes)) as RESP
  }

  private async readText(response: Response): Promise<string> {
    return new TextDecoder().decode(await this.readBody(response))
  }

  private async requestBuffered<RESP>(
    path: string,
    consume: (response: Response) => Promise<RESP>,
    callerSignal?: AbortSignal
  ): Promise<RESP> {
    const url = new URL(path, this.host()).href
    const deadline = this.createRequestDeadline(callerSignal)
    let lastError: unknown
    try {
      for (let attempt = 0; attempt <= this.networkRetries; attempt += 1) {
        if (deadline.signal.aborted) throw deadline.signal.reason
        let retryDelay = this.retryBaseDelayMs * 2 ** attempt
        try {
          const response = await this.request(url, undefined, {
            retry: false,
            deadline
          })
          if (!response.ok) {
            const retryable = RETRYABLE_HTTP_STATUSES.has(response.status)
            retryDelay = this.retryDelay(response, attempt)
            await this.cancelResponse(response)
            if (!retryable || attempt === this.networkRetries) {
              throw new Error(`HTTP error! status: ${response.status}`)
            }
          } else {
            return await consume(response)
          }
        } catch (error) {
          lastError = error
          if (
            deadline.signal.aborted ||
            isComfyHttpPolicyError(error) ||
            !isRetryableTransportError(error) ||
            attempt === this.networkRetries
          ) {
            throw error
          }
        }
        await this.delay(retryDelay, deadline.signal)
      }
    } finally {
      deadline.release()
    }
    throw lastError instanceof Error ? lastError : new Error('ComfyUI network request failed')
  }

  private async get<RESP>(path: string, signal?: AbortSignal): Promise<RESP> {
    return this.requestBuffered(path, (response) => this.readJson<RESP>(response), signal)
  }

  private async getBinary(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.requestBuffered(path, (response) => this.readBody(response), signal)
  }

  private async throwPostError(response: Response): Promise<never> {
    let data: JsonDict
    try {
      data = JSON.parse(await this.readText(response)) as JsonDict
    } catch (error) {
      throw new Error(`HTTP error! status: ${response.status}, message: ${error}`)
    }
    throw NewComfyPostError(response.status, data)
  }

  private async post<REQ, RESP>(path: string, payload: REQ, signal?: AbortSignal): Promise<RESP> {
    const url = new URL(path, this.host()).href
    const response = await this.request(
      url,
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json'
        },
        signal
      },
      { retry: false }
    )
    if (!response.ok) {
      await this.throwPostError(response)
    }
    return this.readJson<RESP>(response)
  }

  private async postNoContent<REQ>(
    path: string,
    payload: REQ,
    signal?: AbortSignal
  ): Promise<void> {
    const url = new URL(path, this.host()).href
    const response = await this.request(
      url,
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json'
        },
        signal
      },
      { retry: false }
    )
    if (!response.ok) {
      await this.throwPostError(response)
    }
    try {
      this.assertContentLength(response)
    } finally {
      await this.cancelResponse(response)
    }
  }

  async installed(): Promise<Record<string, CustomNodeInfo>> {
    const response = await this.get('/customnode/installed')
    return response as Record<string, CustomNodeInfo>
  }

  async objectInfo(signal?: AbortSignal): Promise<ObjectInfoMap> {
    const response = await this.get('/object_info', signal)
    return response as ObjectInfoMap
  }

  async prompt(req: PostPromptReq, signal?: AbortSignal): Promise<PostPromptResp> {
    const response = await this.post(
      '/prompt',
      {
        prompt: req.prompt,
        client_id: req.client_id,
        extra_data: req.extra_data
      },
      signal
    )
    if (!response || typeof response !== 'object' || !('prompt_id' in response)) {
      throw new Error(`prompt_id is null: ${JSON.stringify(response)}`)
    }
    if (typeof response.prompt_id !== 'string') {
      throw new Error(`prompt_id is not a string: ${response.prompt_id}`)
    }
    return response as { prompt_id: string }
  }

  async history(promptId: string, signal?: AbortSignal): Promise<ComfyHistoryResp> {
    const response = await this.get(`/history/${promptId}`, signal)
    return response as ComfyHistoryResp
  }

  async historyAll(signal?: AbortSignal): Promise<ComfyHistoryResp> {
    const response = await this.get('/history', signal)
    return response as ComfyHistoryResp
  }

  async uploadImage(
    fileItem: FileItem,
    image: Uint8Array,
    signal?: AbortSignal
  ): Promise<FileItem> {
    if (!fileItem.filename) {
      throw new Error('filename is required')
    }
    const formData = new FormData()
    const blob = new Blob([image as BlobPart])
    // FormData 会自动生成 multipart boundary，但每个文件的 Content-Type 需要正确设置
    formData.append('image', blob, fileItem.filename)
    fileItem.type && formData.append('type', fileItem.type)
    fileItem.subfolder && formData.append('subfolder', fileItem.subfolder)

    const url = new URL('/upload/image', this.host()).href
    const response = await this.request(
      url,
      {
        method: 'POST',
        body: formData,
        signal
      },
      { retry: false }
    )
    if (!response.ok) {
      try {
        const data = await this.readText(response)
        throw new Error(`HTTP error! status: ${response.status}, message: ${data}`)
      } catch (error) {
        throw new Error(`HTTP error! status: ${response.status}, message: ${error}`)
      }
    }
    const data = await this.readJson<{ name?: string; subfolder?: string; type?: string }>(response)
    return {
      filename: data.name,
      subfolder: data.subfolder,
      type: data.type
    }
  }

  async uploadMask(
    fileItem: FileItem,
    mask: Uint8Array,
    original_ref: FileItem,
    signal?: AbortSignal
  ): Promise<FileItem> {
    if (!fileItem.filename) {
      throw new Error('filename is required')
    }
    const formData = new FormData()
    const blob = new Blob([mask as BlobPart])
    formData.append('image', blob, fileItem.filename)
    formData.append('original_ref', JSON.stringify(original_ref))
    fileItem.type && formData.append('type', fileItem.type)
    fileItem.subfolder && formData.append('subfolder', fileItem.subfolder)

    const url = new URL('/upload/mask', this.host()).href
    const response = await this.request(
      url,
      {
        method: 'POST',
        body: formData,
        signal
      },
      { retry: false }
    )
    if (!response.ok) {
      try {
        const data = await this.readText(response)
        throw new Error(`HTTP error! status: ${response.status}, message: ${data}`)
      } catch (error) {
        throw new Error(`HTTP error! status: ${response.status}, message: ${error}`)
      }
    }
    const data = await this.readJson<{ name?: string; subfolder?: string; type?: string }>(response)
    return {
      filename: data.name,
      subfolder: data.subfolder,
      type: data.type
    }
  }

  async view(meta: FileItem, signal?: AbortSignal): Promise<Uint8Array> {
    const params = new URLSearchParams({
      filename: meta.filename ?? '',
      subfolder: meta.subfolder ?? '',
      type: meta.type ?? ''
    })
    return await this.getBinary(`/view?${params.toString()}`, signal)
  }

  async viewResponse(meta: FileItem, signal?: AbortSignal): Promise<Response> {
    const params = new URLSearchParams({
      filename: meta.filename ?? '',
      subfolder: meta.subfolder ?? '',
      type: meta.type ?? ''
    })
    const response = await this.request(new URL(`/view?${params.toString()}`, this.host()).href, {
      signal
    })
    return this.boundResponseBody(response, signal)
  }

  connect(): WebSocket {
    const host = this.host()
    const urlObj = new URL(`/ws?clientId=${this.clientId}`, host)
    const schema = urlObj.protocol === 'https:' ? 'wss:' : 'ws:'
    urlObj.protocol = schema
    const url = urlObj.href
    let resolveLookup = true
    const rejectLookup: { current?: (error: unknown) => void } = {}
    let lookupPromise: Promise<ResolvedComfyAddress | undefined> | undefined
    const getLookupPromise = (): Promise<ResolvedComfyAddress | undefined> =>
      (lookupPromise ??= this.resolveSafeRemoteAddress(host).catch((error) => {
        rejectLookup.current?.(error)
        throw error
      }))
    const lookup: LookupFunction = (_hostname, options, callback) => {
      void getLookupPromise().then(
        (selected) => {
          if (!resolveLookup) return
          resolveLookup = false
          if (!selected) {
            callback(new Error('Pinned lookup requested without a remote hostname'), '', 0)
            return
          }
          if (options.all) {
            callback(null, [selected])
            return
          }
          callback(null, selected.address, selected.family)
        },
        (error) => {
          if (!resolveLookup) return
          resolveLookup = false
          callback(error instanceof Error ? error : new Error(String(error)), '', 0)
        }
      )
    }
    const ws = new WebSocket(url, {
      perMessageDeflate: true,
      followRedirects: false,
      handshakeTimeout: this.requestTimeoutMs,
      ...(this.tlsCa === undefined ? {} : { ca: this.tlsCa }),
      ...(this.isRemoteComfyUI() && isIP(urlObj.hostname.replace(/^\[|\]$/gu, '')) === 0
        ? { lookup }
        : {})
    })
    rejectLookup.current = (error) =>
      ws.emit('error', error instanceof Error ? error : new Error(String(error)))
    ws.once('close', () => {
      resolveLookup = false
    })
    return ws
  }

  /////////////////
  // 以下为 pysssss 相关接口
  // 可能作为付费，需拆分
  /////////////////
  async listImages(type: 'loras' | 'checkpoints'): Promise<Record<string, string>> {
    const response = await this.get(`/pysssss/images/${type}`)
    return response as Record<string, string>
  }

  async viewImage(name: string): Promise<Uint8Array> {
    name = encodeURIComponent(name)
    return await this.getBinary(`/pysssss/view/${name}`)
  }

  /**
   * 获取 ComfyUI 队列状态
   */
  async getQueue(signal?: AbortSignal): Promise<import('@shared/comfy/types').ComfyQueueResp> {
    const response = await this.get('/queue', signal)
    return response as import('@shared/comfy/types').ComfyQueueResp
  }

  /**
   * 取消队列中的任务（从等待队列中删除）
   * @param promptId 要取消的 prompt_id
   */
  async cancel(promptId: string, signal?: AbortSignal): Promise<void> {
    await this.postNoContent(
      '/queue',
      {
        delete: [promptId]
      },
      signal
    )
  }

  /**
   * 中断当前正在执行的任务
   */
  async interrupt(signal?: AbortSignal): Promise<void> {
    await this.postNoContent('/interrupt', {}, signal)
  }

  /**
   * Ask ComfyUI to unload cached models and release execution memory.
   */
  async freeMemory(req: FreeMemoryReq = {}, signal?: AbortSignal): Promise<void> {
    await this.postNoContent(
      '/free',
      {
        unload_models: req.unload_models ?? true,
        free_memory: req.free_memory ?? true
      },
      signal
    )
  }
}
