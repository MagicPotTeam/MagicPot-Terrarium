import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TextDecoder } from 'node:util'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import {
  PROJECT_COMPARISON_CHAT_PATH,
  PROJECT_COMPARISON_ERROR_MESSAGES,
  PROJECT_COMPARISON_PROFILES_PATH,
  PROJECT_COMPARISON_PROTOCOL,
  projectComparisonChatRequestSchema,
  projectComparisonChatResponseSchema,
  projectComparisonErrorCodeSchema,
  projectComparisonErrorSchema,
  projectComparisonProfilesResponseSchema
} from '@shared/projectComparisonProtocol'

const MAX_BODY_BYTES = 48 * 1024
const MAX_TIMEOUT_MS = 120_000
const errors = {
  VALIDATION_ERROR: [400, PROJECT_COMPARISON_ERROR_MESSAGES.VALIDATION_ERROR],
  PAYLOAD_TOO_LARGE: [413, PROJECT_COMPARISON_ERROR_MESSAGES.PAYLOAD_TOO_LARGE],
  PROFILE_CONFIGURATION_CHANGED: [
    409,
    PROJECT_COMPARISON_ERROR_MESSAGES.PROFILE_CONFIGURATION_CHANGED
  ],
  PROTOCOL_UNSUPPORTED: [501, PROJECT_COMPARISON_ERROR_MESSAGES.PROTOCOL_UNSUPPORTED],
  REMOTE_UPSTREAM_FAILED: [502, PROJECT_COMPARISON_ERROR_MESSAGES.REMOTE_UPSTREAM_FAILED],
  TIMEOUT: [504, PROJECT_COMPARISON_ERROR_MESSAGES.TIMEOUT],
  CANCELLED: [499, PROJECT_COMPARISON_ERROR_MESSAGES.CANCELLED],
  AUTH: [401, PROJECT_COMPARISON_ERROR_MESSAGES.AUTH]
} as const

type ErrorCode = keyof typeof errors

class ComparisonHttpError extends Error {
  constructor(readonly code: ErrorCode) {
    super(errors[code][1])
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorCode(error: unknown): ErrorCode {
  if (error instanceof ComparisonHttpError) return error.code
  if (isRecord(error)) {
    const parsedCode = projectComparisonErrorCodeSchema.safeParse(error.code)
    if (parsedCode.success) return parsedCode.data
    // UpstreamHttpError uses statusCode, whereas other HTTP adapters use status.
    const status = typeof error.statusCode === 'number' ? error.statusCode : error.status
    if (status === 504) return 'TIMEOUT'
    if (status === 502) return 'REMOTE_UPSTREAM_FAILED'
    if (status === 499) return 'CANCELLED'
  }
  return 'REMOTE_UPSTREAM_FAILED'
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const length = req.headers['content-length']
    let expectedBytes: number | undefined
    if (length !== undefined) {
      if (typeof length !== 'string' || !/^\d+$/.test(length)) {
        reject(new ComparisonHttpError('VALIDATION_ERROR'))
        return
      }
      expectedBytes = Number(length)
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_BODY_BYTES) {
        reject(new ComparisonHttpError('PAYLOAD_TOO_LARGE'))
        return
      }
    }

    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: unknown) => {
      cleanup()
      req.pause()
      chunks.length = 0
      reject(error)
    }
    const onData = (chunk: Buffer) => {
      // The parent must leave the body untouched: counting decoded strings is not a byte cap.
      if (!Buffer.isBuffer(chunk)) {
        fail(new ComparisonHttpError('VALIDATION_ERROR'))
        return
      }
      bytes += chunk.byteLength
      if (bytes > MAX_BODY_BYTES) {
        fail(new ComparisonHttpError('PAYLOAD_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      try {
        if (expectedBytes !== undefined && expectedBytes !== bytes) throw new Error()
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))
        resolve(JSON.parse(text))
      } catch {
        reject(new ComparisonHttpError('VALIDATION_ERROR'))
      }
    }
    const onError = () => fail(new ComparisonHttpError('VALIDATION_ERROR'))
    const onAbort = () => fail(signal.reason)

    if (signal.aborted) {
      onAbort()
      return
    }
    if (req.readableEnded) {
      fail(new ComparisonHttpError('VALIDATION_ERROR'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
  })
}

function projectProfiles(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.profiles) || value.profiles.length > 256) {
    throw new ComparisonHttpError('PROTOCOL_UNSUPPORTED')
  }
  const profiles = value.profiles.map((profile: unknown) => {
    if (!isRecord(profile)) throw new ComparisonHttpError('PROTOCOL_UNSUPPORTED')
    return {
      id: profile.id,
      model_name: profile.model_name,
      configurationRevision: profile.configurationRevision,
      model_use: profile.model_use,
      // The internal deployment name is cloud; protocol v1 calls it api.
      deployment: profile.deployment === 'cloud' ? 'api' : profile.deployment,
      context_budget_tokens: profile.context_budget_tokens,
      context_window_tokens: profile.context_window_tokens
    }
  })
  const parsed = projectComparisonProfilesResponseSchema.safeParse({
    protocol: PROJECT_COMPARISON_PROTOCOL,
    profiles
  })
  // In particular, never hide profiles lacking revision support behind an empty success.
  if (!parsed.success) throw new ComparisonHttpError('PROTOCOL_UNSUPPORTED')
  return parsed.data
}

function projectResult(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.content !== 'string' ||
    !value.content.trim() ||
    [
      'error',
      'attachments',
      'imageUrl',
      'ocrResult',
      'toolCalls',
      'tool_calls',
      'toolCall',
      'function_call'
    ].some((key) => value[key] !== undefined) ||
    (value.usage !== undefined && !isRecord(value.usage))
  ) {
    throw new ComparisonHttpError('REMOTE_UPSTREAM_FAILED')
  }
  const usage = value.usage as Record<string, unknown> | undefined
  const parsed = projectComparisonChatResponseSchema.safeParse({
    protocol: PROJECT_COMPARISON_PROTOCOL,
    result: {
      content: value.content,
      finishReason: value.finishReason,
      ...(usage === undefined
        ? {}
        : {
            usage: {
              promptTokens: usage.promptTokens,
              inputTextTokens: usage.inputTextTokens,
              inputImageTokens: usage.inputImageTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens
            }
          })
    }
  })
  if (!parsed.success) throw new ComparisonHttpError('REMOTE_UPSTREAM_FAILED')
  return parsed.data
}

/**
 * Precondition: the parent routes only the comparison paths AFTER its existing proxy
 * access authentication, and has not consumed or decoded the request body. This is
 * not a standalone public/authentication endpoint; concurrency remains parent-owned.
 * timeoutMs is an internal testing override and can only shorten the total deadline.
 */
export async function handleProjectComparisonHttp(
  req: IncomingMessage,
  res: ServerResponse,
  service: Pick<LLMProxySvc, 'listProfiles' | 'chat'>,
  options: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(MAX_TIMEOUT_MS, options.timeoutMs))
      : MAX_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const controller = new AbortController()
  let disconnected = false
  let rejectStopped!: (error: ComparisonHttpError) => void
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject
  })
  const stop = (code: ErrorCode) => {
    if (controller.signal.aborted) return
    const error = new ComparisonHttpError(code)
    // Reject the race first: abort-aware providers can synchronously reject on abort.
    rejectStopped(error)
    controller.abort(error)
  }
  const onDisconnect = () => {
    disconnected = true
    stop('REMOTE_UPSTREAM_FAILED')
  }
  const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs)
  req.once('aborted', onDisconnect)
  res.once('close', onDisconnect)

  const checkDeadline = () => {
    if (Date.now() >= deadline) stop('TIMEOUT')
    if (controller.signal.aborted) throw controller.signal.reason
  }
  const send = (status: number, value: unknown) => {
    if (disconnected || req.aborted || res.destroyed || res.writableEnded) return
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    if (status === 200) res.setHeader('X-MagicPot-Project-Comparison', '1')
    // Reject incomplete/oversized uploads without draining unbounded bytes or resetting
    // the socket before the peer has received the fixed error response.
    if (!req.complete) res.shouldKeepAlive = false
    res.statusCode = status
    res.end(JSON.stringify(value))
  }
  const work = async () => {
    checkDeadline()
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      throw new ComparisonHttpError('VALIDATION_ERROR')
    }
    let pathname: string
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.origin !== 'http://localhost') throw new Error()
      pathname = url.pathname
    } catch {
      throw new ComparisonHttpError('VALIDATION_ERROR')
    }
    if (req.method === 'GET' && pathname === PROJECT_COMPARISON_PROFILES_PATH) {
      const request = { includeConfigurationRevision: true, comparisonRouting: 'local' as const }
      return projectProfiles(await service.listProfiles(request))
    }
    if (req.method !== 'POST' || pathname !== PROJECT_COMPARISON_CHAT_PATH) {
      throw new ComparisonHttpError('VALIDATION_ERROR')
    }
    const parsed = projectComparisonChatRequestSchema.safeParse(
      await readBody(req, controller.signal)
    )
    if (!parsed.success) throw new ComparisonHttpError('VALIDATION_ERROR')
    checkDeadline()
    const {
      profileId,
      expectedProfileRevision,
      correlationId,
      messages,
      temperature,
      maxOutputTokens
    } = parsed.data
    const request = {
      profileId,
      expectedProfileRevision,
      ...(correlationId ? { correlationId } : {}),
      messages,
      temperature,
      maxOutputTokens,
      profileScope: 'agent' as const,
      comparisonRouting: 'local' as const,
      conversationId: `remote-comparison-${randomUUID()}`
    }
    return projectResult(await service.chat(request, { signal: controller.signal }))
  }

  try {
    if (req.aborted || res.destroyed) onDisconnect()
    // A provider may ignore its AbortSignal. The handler must still settle and release
    // the parent's concurrency slot on a deadline or disconnected client.
    const response = await Promise.race([stopped, work()])
    checkDeadline()
    send(200, response)
  } catch (error) {
    const code = errorCode(error)
    // Build the response through the shared strict schema so no provider
    // message, payload, or URL can cross this boundary.
    const errorResponse = projectComparisonErrorSchema.parse({
      code,
      message: errors[code][1]
    })
    send(errors[code][0], errorResponse)
  } finally {
    clearTimeout(timer)
    req.off('aborted', onDisconnect)
    res.off('close', onDisconnect)
  }
}
