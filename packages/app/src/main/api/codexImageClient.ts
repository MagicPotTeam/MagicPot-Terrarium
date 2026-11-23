import crypto from 'node:crypto'
import type { ChatAttachment, FetchImpl, LLMChatResult } from '@shared/llm'
import { validateProviderBaseUrl } from '@shared/llm/providerEndpointPolicy'
import {
  OpenAIRequestControl,
  OPENAI_IMAGE_DEADLINE_MS,
  OPENAI_IMAGE_JSON_MAX_BYTES,
  OPENAI_ERROR_MAX_BYTES
} from '@shared/llm/openaiRequestControl'
import { ensureCodexCliAuthTokens, forceRefreshCodexCliAuthTokens } from './codexOAuth'
import {
  createCodexOAuthGovernorIdentity,
  createCLIProxyGovernorIdentity,
  runWithCodexRequestGovernor
} from './codexRequestGovernor'

const CODEX_IMAGES_BASE = 'https://chatgpt.com/backend-api/codex'
const MAX_EDIT_IMAGES = 5
const MAX_EDIT_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_RESULT_IMAGE_BYTES = 64 * 1024 * 1024
const MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

/** Protocol selection is explicit: never infer Codex JSON from a public Images profile. */
export type CodexImageAuth =
  { mode: 'oauth' } | { mode: 'api-key'; baseUrl: string; apiKey: string }
export type CodexImageOptions = {
  transparentBackground?: boolean
  gif?: { frameCount?: number; frameDurationMs?: number }
  signal?: AbortSignal
}
type ClientOptions = {
  auth: CodexImageAuth
  /** Trusted caller capability; not a model-supplied option. */
  /** OpenAI-compatible /v1 Images uses multipart edits, not Codex JSON edits. */
  multipartEdits?: boolean
  enableGif?: boolean
  fetchImpl?: FetchImpl
  timeoutMs?: number
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))
const base64Bytes = (value: unknown, limit: number): number => {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(limit / 3) * 4
  ) {
    throw new Error('Codex image data is invalid or exceeds its byte limit.')
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const end = value.length - padding
  // A repeated-group regex over multi-MiB image payloads can overflow V8's stack.
  // Validate the alphabet in one bounded linear pass, without decoding/copying it.
  // This is a transport check, not raster decoding or managed-artifact acceptance.
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index)
    if (!(
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    )) {
      throw new Error('Codex image data is invalid.')
    }
  }
  const bytes = (value.length * 3) / 4 - padding
  if (!bytes || bytes > limit) {
    throw new Error('Codex image data is invalid or exceeds its byte limit.')
  }
  return bytes
}
// Some compatible gateways omit output_format. Inspect only a bounded header;
// the managed store still validates the full raster before publishing it.
function returnedFormat(value: string, declared: unknown): string {
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !Object.hasOwn(MIME, declared))
      throw new Error('Codex Images returned an unsupported output format.')
    return declared
  }
  const head = Buffer.from(value.slice(0, 16), 'base64')
  if (head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png'
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'jpeg'
  if (head.subarray(0, 4).equals(Buffer.from('RIFF')) && head.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'webp'
  if (head.subarray(0, 6).equals(Buffer.from('GIF87a')) || head.subarray(0, 6).equals(Buffer.from('GIF89a'))) return 'gif'
  throw new Error('Codex Images returned unrecognized raster bytes without an output format.')
}
const imageInput = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error('Codex image input must be an inline raster image or HTTPS URL.')
  }
  const data = /^data:image\/(png|jpeg|webp|gif);base64,([\s\S]*)$/u.exec(value)
  if (data) {
    base64Bytes(data[2], MAX_EDIT_IMAGE_BYTES)
    return value
  }
  try {
    const url = new URL(value)
    if (
      value.length <= 8192 &&
      url.protocol === 'https:' &&
      url.hostname &&
      !url.username &&
      !url.password &&
      !url.hash
    ) {
      return url.toString()
    }
  } catch {
    // Reject local paths, unparsed and non-HTTPS remote references.
  }
  throw new Error('Codex image input must be an inline raster image or HTTPS URL.')
}
const resolveAuth = (auth: CodexImageAuth): { baseUrl: string; apiKey?: string } => {
  if (!record(auth)) {
    throw new Error('An explicit Codex image authentication mode is required.')
  }
  if (auth.mode === 'oauth' && exactKeys(auth, ['mode'])) return { baseUrl: CODEX_IMAGES_BASE }
  if (
    auth.mode !== 'api-key' ||
    !exactKeys(auth, ['mode', 'baseUrl', 'apiKey']) ||
    typeof auth.apiKey !== 'string' ||
    !auth.apiKey.trim() ||
    /[\r\n]/u.test(auth.apiKey) ||
    typeof auth.baseUrl !== 'string'
  ) {
    throw new Error(
      'Codex custom image backend requires its own base URL and API key; OAuth fallback is disabled.'
    )
  }
  const baseUrl = validateProviderBaseUrl(auth.baseUrl).replace(/\/+$/u, '')
  const parsed = new URL(baseUrl)
  if (
    parsed.hostname.toLowerCase().replace(/\.$/u, '') === 'api.openai.com' ||
    /\/(responses|chat\/completions|images(?:\/(?:edits|generations))?)$/iu.test(
      decodeURIComponent(parsed.pathname)
    )
  ) {
    throw new Error(
      'Codex JSON Images requires a Codex backend base URL, not a public Images or Responses endpoint.'
    )
  }
  return { baseUrl, apiKey: auth.apiKey.trim() }
}

/** Isolated client seam only. Not registered as a tool, route or IPC service yet.
 * Reuses existing auth, bounded cancellation/deadline and duplicate governor.
 * No automatic capacity/transport retry; OAuth 401 permits one refresh/resend only.
 */
export class CodexImageClient {
  constructor(private readonly options: ClientOptions) {}

  async generate(prompt: string, options: CodexImageOptions = {}): Promise<LLMChatResult> {
    return this.request('generations', prompt, undefined, options)
  }

  async edit(
    prompt: string,
    images: readonly string[],
    options: CodexImageOptions = {}
  ): Promise<LLMChatResult> {
    options.signal?.throwIfAborted()
    if (!Array.isArray(images) || images.length < 1 || images.length > MAX_EDIT_IMAGES) {
      throw new Error('Codex image edit takes 1 to 5 images.')
    }
    return this.request('edits', prompt, Array.from(images, imageInput), options)
  }

  private async request(
    operation: 'generations' | 'edits',
    prompt: string,
    images: string[] | undefined,
    options: CodexImageOptions
  ): Promise<LLMChatResult> {
    const signal = options.signal
    signal?.throwIfAborted()
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('Codex image prompt is required.')
    }
    if (
      options.transparentBackground !== undefined &&
      typeof options.transparentBackground !== 'boolean'
    ) {
      throw new Error('transparentBackground must be a boolean.')
    }
    const auth = resolveAuth(this.options.auth)
    const body: Record<string, unknown> = {
      ...(images ? { images: images.map((image_url) => ({ image_url })) } : {}),
      prompt: prompt.trim(),
      background: options.transparentBackground ? 'transparent' : 'opaque',
      model: 'gpt-image-2',
      quality: 'auto',
      size: 'auto'
    }
    if (options.gif !== undefined) {
      if (this.options.enableGif !== true) {
        throw new Error('GIF output is not enabled for Codex Images.')
      }
      if (!record(options.gif) || !exactKeys(options.gif, ['frameCount', 'frameDurationMs'])) {
        throw new Error('Invalid Codex GIF controls.')
      }
      body.output_format = 'gif'
      for (const [key, field, low, high] of [
        ['frameCount', 'frame_count', 2, 16],
        ['frameDurationMs', 'frame_duration_ms', 20, 2000]
      ] as const) {
        const value = options.gif[key]
        if (value !== undefined) {
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < low ||
            value > high
          ) {
            throw new Error(`gif.${key} must be a whole number from ${low} to ${high}.`)
          }
          body[field] = value
        }
      }
    }
    // Detach before the first await; the serialized body is also reused on 401.
    const serializedBody = JSON.stringify(body)
    if (Buffer.byteLength(serializedBody, 'utf8') > OPENAI_IMAGE_JSON_MAX_BYTES) {
      throw new Error('Codex image request exceeds its byte limit.')
    }
    const endpoint = `${auth.baseUrl}/images/${operation}`
    const control = new OpenAIRequestControl(
      this.options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      signal,
      this.options.timeoutMs ?? OPENAI_IMAGE_DEADLINE_MS
    )
    const diagnostic: { phase: 'request' | 'receive' | 'decode' } = { phase: 'request' }
    let httpStatus: number | undefined
    let traceId: string | undefined
    try {
      control.check()
      let session = auth.apiKey ? undefined : await control.wait(ensureCodexCliAuthTokens())
      control.check()
      const credentials = new Set<string>()
      const retainCredentials = (): void => {
        for (const secret of [
          auth.apiKey,
          session?.accessToken,
          session?.refreshToken,
          session?.idToken
        ]) {
          if (secret) credentials.add(secret)
        }
      }
      retainCredentials()
      const redact = (text: string): string => {
        for (const secret of credentials) text = text.split(secret).join('[redacted]')
        return text
      }
      const identity = auth.apiKey
        ? createCLIProxyGovernorIdentity(auth.apiKey)
        : createCodexOAuthGovernorIdentity(session?.accountId)
      return await runWithCodexRequestGovernor(
        { identity, endpoint, fingerprint: body },
        async () => {
          control.check()
          const requestId = crypto.randomUUID()
          traceId = requestId
          let wireBody: BodyInit = serializedBody
          if (images && this.options.multipartEdits) {
            const form = new FormData()
            for (const [key, value] of Object.entries(body)) {
              if (key !== 'images') form.append(key, String(value))
            }
            for (const [index, image] of images.entries()) {
              // MAIN supplies preflighted inline pixels; never download an arbitrary URL.
              const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/u.exec(image)
              if (!match) throw new Error('Images API edits require inline PNG/JPEG/WebP inputs.')
              const blob = new Blob([Uint8Array.from(Buffer.from(match[2], 'base64'))], { type: match[1] })
              form.append(images.length === 1 ? 'image' : 'image[]', blob, `input-${index + 1}.${match[1] === 'image/jpeg' ? 'jpg' : match[1].slice(6)}`)
            }
            wireBody = form
          }
          const send = () =>
            control.fetch(endpoint, {
              method: 'POST',
              redirect: 'error',
              headers: {
                ...(typeof wireBody === 'string' ? { 'Content-Type': 'application/json' } : {}),
                Authorization: `Bearer ${auth.apiKey ?? session!.accessToken}`,
                'Idempotency-Key': requestId,
                ...(!auth.apiKey && session?.accountId
                  ? { 'chatgpt-account-id': session.accountId }
                  : {})
              },
              body: wireBody
            })
          let response = await send()
          if (response.status === 401 && !auth.apiKey) {
            // Caller cancellation must not wait for body cleanup or OAuth refresh.
            // Shared auth refresh can outlive this caller; no later image dispatch is allowed.
            try {
              void response.body?.cancel().catch(() => undefined)
            } catch {
              // Preserve response status.
            }
            control.check()
            session = await control.wait(forceRefreshCodexCliAuthTokens())
            retainCredentials()
            control.check()
            response = await send()
          }
          httpStatus = response.status
          if (!response.ok) {
            let payload: unknown
            try {
              payload = JSON.parse(await control.text(response, OPENAI_ERROR_MAX_BYTES, true))
            } catch {
              control.check()
            }
            const detail = record(payload)
              ? ((record(payload.error) ? payload.error.message : undefined) ?? payload.detail)
              : undefined
            // Bounded provider text is still untrusted; redact known credentials before truncating.
            const message = typeof detail === 'string' ? redact(detail).slice(0, 1024) : ''
            const rawId = response.headers.get('x-codex-imagegen-request-id')
            const id = rawId ? redact(rawId).slice(0, 200) : undefined
            throw Object.assign(
              new Error(
                `Codex image ${operation === 'edits' ? 'edit' : 'generation'} failed (HTTP ${response.status})${message ? `: ${message}` : ''}${id && /^[\w.-]{1,200}$/u.test(id) ? ` [imagegen request ${id}]` : ''}`
              ),
              { statusCode: response.status, retryBlocked: true }
            )
          }
          diagnostic.phase = 'receive'
          const data = await control.json(response, OPENAI_IMAGE_JSON_MAX_BYTES)
          diagnostic.phase = 'decode'
          control.check()
          if (
            !record(data) ||
            !Array.isArray(data.data) ||
            !data.data.length ||
            data.data.length > 16
          ) {
            throw new Error('Codex Images returned no image or an invalid image list.')
          }
          const attachments: ChatAttachment[] = data.data.map((item) => {
            if (!record(item)) throw new Error('Codex Images returned an invalid image.')
            const sizeBytes = base64Bytes(item.b64_json, MAX_RESULT_IMAGE_BYTES)
            const format = returnedFormat(item.b64_json as string, data.output_format)
            if ((format === 'gif') !== (body.output_format === 'gif')) throw new Error('Codex Images returned an unexpected animation format.')
            const mimeType = MIME[format]
            return {
              type: 'image',
              url: `data:${mimeType};base64,${item.b64_json}`,
              mimeType,
              sizeBytes,
              ...(typeof item.generation_id === 'string' && item.generation_id.length <= 512
                ? { metadata: { generationId: item.generation_id } }
                : {})
            }
          })
          control.check()
          return { content: '', finishReason: 'stop', imageUrl: attachments[0].url, attachments }
        }
      )
    } catch (error) {
      // Never turn a possibly charged/unknown outcome into an automatic capacity retry.
      if (error instanceof Error && error !== signal?.reason) {
        Object.assign(error, { retryBlocked: true, imageFailureStage: diagnostic.phase === 'receive' && error instanceof SyntaxError ? 'decode' : diagnostic.phase,
          imageHttpStatus: httpStatus, imageClientRequestId: traceId })
      }
      throw error
    } finally {
      control.dispose()
    }
  }
}
