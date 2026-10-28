import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Config } from '@shared/config/config'
import type { LLMChatReq, LLMChatResp, LLMListProfilesResp } from '@shared/api/svcLLMProxy'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import {
  PROJECT_COMPARISON_CHAT_PATH,
  PROJECT_COMPARISON_PROFILES_PATH,
  PROJECT_COMPARISON_PROTOCOL,
  projectComparisonChatRequestSchema,
  projectComparisonChatResponseSchema,
  projectComparisonErrorSchema,
  projectComparisonProfilesResponseSchema
} from '@shared/projectComparisonProtocol'

const RECEIPT_TTL_MS = 10 * 60 * 1000
const MAX_RECEIPTS = 512
const METADATA_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 120_000
const MAX_ERROR_BODY_BYTES = 4 * 1024

// Only errors constructed here may cross the boundary. Even a ServiceError thrown by
// the network implementation can contain credentials, response bodies or request URLs.
class RemoteComparisonError extends ServiceError {}
const failure = (code: string, message: string, status?: number): RemoteComparisonError =>
  new RemoteComparisonError(message, {
    code,
    ...(status === undefined ? {} : { payload: { status } })
  })
const changed = (): RemoteComparisonError =>
  failure('PROFILE_CONFIGURATION_CHANGED', 'Model configuration changed; review and confirm again.')
const invalidProtocol = (): RemoteComparisonError =>
  failure('PROTOCOL_ERROR', 'Invalid remote project comparison response.')
const unsupported = (): RemoteComparisonError =>
  failure('PROTOCOL_UNSUPPORTED', 'Remote project comparison protocol is unsupported.')
const invalidRequest = (): RemoteComparisonError =>
  failure('VALIDATION_ERROR', 'Invalid project comparison request.')
const cancelled = (): RemoteComparisonError =>
  failure('CANCELLED', 'Remote project comparison request cancelled.')
const timedOut = (status?: number): RemoteComparisonError =>
  failure('TIMEOUT', 'Remote project comparison request timed out.', status)

const errorForCode = (code: string, status?: number): RemoteComparisonError => {
  switch (code) {
    case 'PROFILE_CONFIGURATION_CHANGED':
      return changed()
    case 'PROTOCOL_UNSUPPORTED':
      return unsupported()
    case 'TIMEOUT':
      return timedOut(status)
    case 'CANCELLED':
      return cancelled()
    case 'AUTH':
      return failure('AUTH', 'Remote project comparison authentication failed.', status)
    case 'VALIDATION_ERROR':
      return invalidRequest()
    case 'REMOTE_UPSTREAM_FAILED':
      return failure('REMOTE_UPSTREAM_FAILED', 'Remote project comparison upstream failed.', status)
    case 'PAYLOAD_TOO_LARGE':
      return failure('PAYLOAD_TOO_LARGE', 'Remote project comparison request is too large.', status)
    default:
      return failure(
        'REMOTE_HTTP_ERROR',
        `Remote project comparison request failed (HTTP ${status}).`,
        status
      )
  }
}

function destination(config: Config): { origin: string; configuredOrigin: string; token: string } {
  const invalid = (): RemoteComparisonError =>
    failure('INVALID_REMOTE_CONFIGURATION', 'Invalid remote project comparison configuration.')
  const origin = config?.remote_llm_server_config?.server_origin
  const token = config?.remote_llm_server_config?.access_token
  if (
    config?.use_remote_llm !== true ||
    typeof origin !== 'string' ||
    origin.length > 2048 ||
    /[\s\p{Cc}\p{Cf}]/u.test(origin) ||
    typeof token !== 'string' ||
    token.length > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(token)
  )
    throw invalid()

  // Validate the spelling before URL canonicalization can erase paths, userinfo,
  // backslashes, percent escapes or non-literal IPv4 spellings such as 127.1.
  const match = /^https?:\/\/(\[[0-9a-f:.]+\]|[^/?#@\\:%]+)(?::[0-9]+)?\/?$/i.exec(origin)
  if (!match) throw invalid()
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw invalid()
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw invalid()
  const host = match[1].toLowerCase()
  const ipv4 = isIP(host) === 4 ? host.split('.').map(Number) : undefined
  const ipv6Loopback =
    host.startsWith('[') && isIP(host.slice(1, -1)) === 6 && url.hostname === '[::1]'
  const loopback = host === 'localhost' || ipv4?.[0] === 127 || ipv6Loopback
  const privateIpv4 =
    ipv4 &&
    (ipv4[0] === 10 ||
      (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168))
  if (url.protocol === 'http:' && !loopback && !privateIpv4) throw invalid()
  if ((!loopback || token.length > 0) && !token.trim()) throw invalid()
  return { origin: url.origin, configuredOrigin: origin, token }
}

type Destination = ReturnType<typeof destination>
type Receipt = {
  profileId: string
  remoteRevision: string
  binding: Buffer
  expiresAt: number
}
type Options = {
  now?: () => number
  metadataTimeoutMs?: number
  requestTimeoutMs?: number
}

const timeoutLimit = (value: number | undefined, maximum: number): number =>
  value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(value, maximum)) : maximum

export class RemoteProjectComparisonClient {
  private readonly key = randomBytes(32)
  private readonly receipts = new Map<string, Receipt>()
  private readonly now: () => number
  private lastNow = -Infinity
  private readonly metadataTimeoutMs: number
  private readonly requestTimeoutMs: number

  constructor(
    private readonly fetchImpl: typeof globalThis.fetch,
    options: Options = {}
  ) {
    this.now = options.now ?? (() => performance.now())
    this.metadataTimeoutMs = timeoutLimit(options.metadataTimeoutMs, METADATA_TIMEOUT_MS)
    this.requestTimeoutMs = timeoutLimit(options.requestTimeoutMs, REQUEST_TIMEOUT_MS)
  }

  private clock(): number {
    const now = this.now()
    if (!Number.isFinite(now)) {
      this.receipts.clear()
      throw changed()
    }
    this.lastNow = Math.max(this.lastNow, now)
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt <= this.lastNow) this.receipts.delete(id)
    }
    return this.lastNow
  }

  private binding(endpoint: Destination): Buffer {
    return createHmac('sha256', this.key)
      .update(JSON.stringify([true, endpoint.configuredOrigin, endpoint.token]))
      .digest()
  }

  async list(config: Config, signal?: AbortSignal): Promise<LLMListProfilesResp> {
    const endpoint = destination(config)
    const metadata = await this.request(
      endpoint,
      PROJECT_COMPARISON_PROFILES_PATH,
      undefined,
      1024 * 1024,
      this.metadataTimeoutMs,
      (value) => {
        const parsed = projectComparisonProfilesResponseSchema.safeParse(value)
        if (!parsed.success) throw invalidProtocol()
        const ids = new Set(parsed.data.profiles.map((profile) => profile.id))
        if (ids.size !== parsed.data.profiles.length) throw invalidProtocol()
        return parsed.data
      },
      signal
    )
    const now = this.clock()
    const binding = this.binding(endpoint)
    const profiles: LLMListProfilesResp['profiles'] = metadata.profiles.map((profile) => {
      let receiptId: string
      do {
        receiptId = randomBytes(32).toString('hex')
      } while (this.receipts.has(receiptId))
      this.receipts.set(receiptId, {
        profileId: profile.id,
        remoteRevision: profile.configurationRevision,
        binding,
        expiresAt: now + RECEIPT_TTL_MS
      })
      while (this.receipts.size > MAX_RECEIPTS) {
        const oldest = this.receipts.keys().next().value
        if (oldest !== undefined) this.receipts.delete(oldest)
      }
      const modelUse = profile.model_use
      return {
        id: profile.id,
        model_name: profile.model_name,
        configurationRevision: receiptId,
        ...(profile.deployment
          ? { deployment: profile.deployment === 'api' ? 'cloud' : 'local' }
          : {}),
        ...(modelUse && modelUse !== 'default' && modelUse !== 'coding' && modelUse !== 'reasoning'
          ? { model_use: modelUse }
          : {}),
        ...(profile.context_budget_tokens === undefined
          ? {}
          : { context_budget_tokens: profile.context_budget_tokens }),
        ...(profile.context_window_tokens === undefined
          ? {}
          : { context_window_tokens: profile.context_window_tokens })
      }
    })
    const result = {
      profiles,
      comparisonDestination: { kind: 'remote' as const, origin: endpoint.origin }
    }
    return result
  }

  async chat(config: Config, req: LLMChatReq, signal?: AbortSignal): Promise<LLMChatResp> {
    let endpoint: Destination
    try {
      endpoint = destination(config)
    } catch {
      throw changed()
    }
    this.clock()
    const id = req?.expectedProfileRevision
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw changed()
    const receipt = this.receipts.get(id)
    if (
      !receipt ||
      receipt.profileId !== req.profileId ||
      !timingSafeEqual(receipt.binding, this.binding(endpoint))
    )
      throw changed()

    // comparisonRouting is an IPC dispatch hint, never an authority for this client.
    const allowed = new Set([
      'messages',
      'profileId',
      'expectedProfileRevision',
      'profileScope',
      'temperature',
      'maxOutputTokens',
      'comparisonRouting',
      'correlationId'
    ])
    if (
      Object.entries(req).some(([key, value]) => value !== undefined && !allowed.has(key)) ||
      (req.profileScope !== undefined && req.profileScope !== 'agent') ||
      !Array.isArray(req.messages) ||
      req.messages.length < 2 ||
      req.messages.length > 4 ||
      req.messages.some(
        (message) =>
          !message ||
          typeof message !== 'object' ||
          Object.entries(message).some(
            ([key, value]) => value !== undefined && key !== 'role' && key !== 'content'
          )
      )
    )
      throw invalidRequest()
    // Include defaults before the protocol measures the encoded request budget.
    const parsed = projectComparisonChatRequestSchema.safeParse({
      protocol: PROJECT_COMPARISON_PROTOCOL,
      profileId: receipt.profileId,
      expectedProfileRevision: receipt.remoteRevision,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      messages: req.messages.map(({ role, content }) => ({ role, content })),
      temperature: req.temperature === undefined ? 0.2 : req.temperature,
      maxOutputTokens: req.maxOutputTokens === undefined ? 1200 : req.maxOutputTokens
    })
    if (!parsed.success) throw invalidRequest()
    // Access order is LRU; using a receipt does not extend its consent lifetime.
    this.receipts.delete(id)
    this.receipts.set(id, receipt)
    const response = await this.request(
      endpoint,
      PROJECT_COMPARISON_CHAT_PATH,
      JSON.stringify(parsed.data),
      128 * 1024,
      this.requestTimeoutMs,
      (value) => {
        const result = projectComparisonChatResponseSchema.safeParse(value)
        if (!result.success) throw invalidProtocol()
        return result.data
      },
      signal
    )
    return {
      content: response.result.content,
      ...(response.result.finishReason ? { finishReason: response.result.finishReason } : {}),
      ...(response.result.usage ? { usage: response.result.usage } : {})
    }
  }

  private async request<T>(
    endpoint: Destination,
    path: string,
    body: string | undefined,
    limit: number,
    timeoutMs: number,
    parse: (value: unknown) => T,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) throw cancelled()
    const controller = new AbortController()
    const started = performance.now()
    const checkDeadline = (): void => {
      if (performance.now() - started >= timeoutMs) throw timedOut()
    }
    let response: Response | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let bodyCancelled = false
    const cancelBody = (): void => {
      if (bodyCancelled || !response) return
      bodyCancelled = true
      try {
        // Cancellation itself must not hold the deadline open.
        void (reader ? reader.cancel() : response.body?.cancel())?.catch(() => {})
      } catch {
        // A broken/closed transport is already being discarded.
      }
    }
    let rejectAbort: (error: RemoteComparisonError) => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject
    })
    const stop = (error: RemoteComparisonError): void => {
      rejectAbort(error)
      controller.abort()
      cancelBody()
    }
    const onAbort = (): void => stop(cancelled())
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => stop(timedOut()), timeoutMs)
    try {
      const work = async (): Promise<T> => {
        response = await this.fetchImpl(`${endpoint.origin}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {})
          },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal
        })
        if (controller.signal.aborted) {
          cancelBody()
          throw cancelled()
        }
        checkDeadline()
        if (response.redirected) throw invalidProtocol()
        const status = response.status
        if (status !== 200) {
          if (!Number.isInteger(status) || status < 100 || status > 599) throw invalidProtocol()
          // Error envelopes are optional.  When present, consume only the tiny
          // fixed schema and retain its allowlisted classification; never use
          // arbitrary remote text as a local error message.
          let remoteCode: string | undefined
          const contentType = response.headers
            .get('content-type')
            ?.split(';')[0]
            .trim()
            .toLowerCase()
          const length = response.headers.get('content-length')
          if (
            contentType === 'application/json' &&
            (length === null ||
              (/^\d+$/.test(length) &&
                Number.isSafeInteger(Number(length)) &&
                Number(length) <= MAX_ERROR_BODY_BYTES)) &&
            response.body
          ) {
            reader = response.body.getReader()
            const decoder = new TextDecoder('utf-8', { fatal: true })
            let bytes = 0
            let text = ''
            try {
              while (true) {
                if (controller.signal.aborted) throw cancelled()
                checkDeadline()
                const chunk = await reader.read()
                checkDeadline()
                if (chunk.done) break
                if (!(chunk.value instanceof Uint8Array)) throw new Error()
                bytes += chunk.value.byteLength
                if (bytes > MAX_ERROR_BODY_BYTES) break
                text += decoder.decode(chunk.value, { stream: true })
              }
              if (bytes <= MAX_ERROR_BODY_BYTES) {
                text += decoder.decode()
                const parsed = projectComparisonErrorSchema.safeParse(JSON.parse(text))
                if (parsed.success) remoteCode = parsed.data.code
              }
            } catch (error) {
              if (error instanceof RemoteComparisonError) throw error
              if (controller.signal.aborted) throw cancelled()
              // Malformed/partial error bodies intentionally fall back to HTTP.
            }
          }
          if (remoteCode !== undefined) throw errorForCode(remoteCode, status)
          throw errorForCode(
            status === 504
              ? 'TIMEOUT'
              : status === 502
                ? 'REMOTE_UPSTREAM_FAILED'
                : status === 499
                  ? 'CANCELLED'
                  : status === 401 || status === 403
                    ? 'AUTH'
                    : status === 409
                      ? 'PROFILE_CONFIGURATION_CHANGED'
                      : status === 404 || status === 501
                        ? 'PROTOCOL_UNSUPPORTED'
                        : 'REMOTE_HTTP_ERROR',
            status
          )
        }
        if (
          response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
          'application/json'
        )
          throw invalidProtocol()
        const length = response.headers.get('content-length')
        if (
          length !== null &&
          (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)
        )
          throw invalidProtocol()
        if (!response.body) throw invalidProtocol()
        reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let bytes = 0
        let text = ''
        let value: unknown
        try {
          while (true) {
            if (controller.signal.aborted) throw cancelled()
            // A stream of immediately resolved/empty chunks must not starve the timer.
            checkDeadline()
            const chunk = await reader.read()
            checkDeadline()
            if (chunk.done) break
            if (!(chunk.value instanceof Uint8Array)) throw invalidProtocol()
            bytes += chunk.value.byteLength
            if (bytes > limit) throw invalidProtocol()
            text += decoder.decode(chunk.value, { stream: true })
          }
          text += decoder.decode()
          value = JSON.parse(text)
        } catch (error) {
          throw error instanceof RemoteComparisonError ? error : invalidProtocol()
        }
        if (
          !value ||
          typeof value !== 'object' ||
          !('protocol' in value) ||
          value.protocol !== PROJECT_COMPARISON_PROTOCOL
        )
          throw unsupported()
        return parse(value)
      }
      const result = await Promise.race([work(), aborted])
      checkDeadline()
      return result
    } catch (error) {
      cancelBody()
      controller.abort()
      throw error instanceof RemoteComparisonError
        ? error
        : failure('REMOTE_REQUEST_FAILED', 'Remote project comparison request failed.')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try {
        reader?.releaseLock()
      } catch {
        // A transport ignoring cancellation may still have a pending read.
      }
    }
  }
}
