/**
 * Shared LLM API Client implementations — used by both main process and renderer process.
 *
 * These classes were previously duplicated in:
 *   - packages/app/src/renderer/.../api/LLM.ts (OpenAIAPICli, GeminiAPICli, ClaudeAPICli, OllamaAPICli)
 *   - packages/app/src/main/api/svcLLMProxyImpl.ts (OpenAIAPICli, GeminiAPICli, ClaudeAPICli)
 *
 * Now unified here as the single source of truth for all chat() implementations.
 * Renderer-only features (generatePrompt, compressImage) remain in the renderer LLM.ts.
 */

import type { LLMModelUse } from '@shared/config/config'
import {
  type LLMCli,
  type LLMChatParams,
  type LLMChatResult,
  normalizeLLMChatResult
} from './types'
import {
  buildDefaultOpenAIResponsesInclude,
  buildOpenAIResponsesInput,
  buildDefaultOpenAIWebSearchTool,
  buildOpenAIImageGenerationTool,
  serializeOpenAIResponsesOutput,
  shouldUseOpenAIImageGeneration
} from './openaiResponses'
import { buildOpenAIFileSearchTool, createOpenAIFileSearchSession } from './openaiFileSearch'
import { normalizeReasoningEffort, resolveChatProfileCapabilities } from './profileCapabilities'
import {
  OPENCODE_ZEN_API_BASE_URL,
  resolveOpencodeZenAlias,
  resolveOpencodeZenModelApi
} from './opencodeZenModels'

type OpenAIServiceTier = 'auto' | 'default' | 'flex' | 'priority'
type OpenAIClientApiMode = 'auto' | 'responses' | 'chat-completions'
type OpenAIClientOptions = {
  modelUse?: LLMModelUse
  serviceTier?: OpenAIServiceTier
  fetchImpl?: FetchImpl
  apiMode?: OpenAIClientApiMode
  enableHostedTools?: boolean
  extraHeaders?: Record<string, string>
}
type GeminiAuthMode = 'query-key' | 'bearer' | 'x-goog-api-key'
type GeminiClientOptions = {
  fetchImpl?: FetchImpl
  authMode?: GeminiAuthMode
  extraHeaders?: Record<string, string>
}
type ClaudeClientOptions = {
  fetchImpl?: FetchImpl
  authAsBearer?: boolean
  extraHeaders?: Record<string, string>
  maxTokens?: number
}

export type FetchImpl = typeof fetch

const getDefaultFetchImpl = (): FetchImpl => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Fetch API is unavailable in this runtime.')
  }

  return globalThis.fetch.bind(globalThis) as FetchImpl
}

const normalizeErrorText = (value: unknown): string =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')

const normalizeTokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const normalizeProviderTokenUsage = (payload: unknown): LLMChatResult['usage'] | undefined => {
  const record =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined
  const rawUsage =
    record?.usage && typeof record.usage === 'object'
      ? (record.usage as Record<string, unknown>)
      : record?.usageMetadata && typeof record.usageMetadata === 'object'
        ? (record.usageMetadata as Record<string, unknown>)
        : record
  const promptTokens = normalizeTokenCount(
    rawUsage?.promptTokens ??
      rawUsage?.prompt_tokens ??
      rawUsage?.inputTokens ??
      rawUsage?.input_tokens ??
      rawUsage?.promptTokenCount ??
      rawUsage?.prompt_eval_count
  )
  const completionTokens = normalizeTokenCount(
    rawUsage?.completionTokens ??
      rawUsage?.completion_tokens ??
      rawUsage?.outputTokens ??
      rawUsage?.output_tokens ??
      rawUsage?.candidatesTokenCount ??
      rawUsage?.eval_count
  )
  const totalTokens = normalizeTokenCount(
    rawUsage?.totalTokens ?? rawUsage?.total_tokens ?? rawUsage?.totalTokenCount
  )

  return promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
    ? {
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {})
      }
    : undefined
}

const collectFetchFailureFragments = (error: unknown, fragments: Set<string>, depth = 0): void => {
  if (!error || depth > 6) {
    return
  }

  if (typeof AggregateError !== 'undefined' && error instanceof AggregateError) {
    for (const nestedError of error.errors) {
      collectFetchFailureFragments(nestedError, fragments, depth + 1)
    }
  }

  if (error instanceof Error) {
    const code =
      typeof (error as NodeJS.ErrnoException).code === 'string'
        ? String((error as NodeJS.ErrnoException).code).trim()
        : ''
    const message = normalizeErrorText(error.message)

    if (message && message.toLowerCase() !== 'fetch failed') {
      fragments.add(
        code && !message.toLowerCase().includes(code.toLowerCase()) ? `${code} ${message}` : message
      )
    } else if (code) {
      fragments.add(code)
    }

    const cause = (error as Error & { cause?: unknown }).cause
    if (cause) {
      collectFetchFailureFragments(cause, fragments, depth + 1)
    }
    return
  }

  const fallback = normalizeErrorText(error)
  if (fallback && fallback.toLowerCase() !== 'fetch failed') {
    fragments.add(fallback)
  }
}

export function describeFetchFailure(error: unknown): string {
  const fragments = new Set<string>()
  collectFetchFailureFragments(error, fragments)

  if (fragments.size > 0) {
    const detail = [...fragments].join(' | ')
    if (/198\.18\.\d+\.\d+/.test(detail)) {
      return `${detail} The connection target resolved to a 198.18.x.x Fake-IP address. If you use Clash/V2Ray/TUN/Fake-IP mode, route this app through that proxy or use a directly reachable model endpoint.`
    }
    return detail
  }

  if (error instanceof Error) {
    const message = normalizeErrorText(error.message)
    return message || 'fetch failed'
  }

  return normalizeErrorText(error) || 'fetch failed'
}

const sanitizeEndpointForMessage = (endpoint: string): string => {
  try {
    const parsed = new URL(endpoint)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return endpoint
  }
}

const buildFetchFailureError = (label: string, endpoint: string, error: unknown): Error => {
  const detail = describeFetchFailure(error)
  const sanitizedEndpoint = sanitizeEndpointForMessage(endpoint)
  return new Error(
    detail && detail.toLowerCase() !== 'fetch failed'
      ? `${label} request failed for ${sanitizedEndpoint}: ${detail}`
      : `${label} request failed for ${sanitizedEndpoint}`
  )
}

// ==================== Helper: convertImageToBase64 ====================

/**
 * Convert an image URL (data URL or remote URL) to raw base64 string.
 * Works in both Node.js and browser environments because it uses the
 * Fetch API (available in Node 18+ and all modern browsers).
 */
export async function convertImageToBase64(
  imageUrl: string,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = getDefaultFetchImpl()
): Promise<string> {
  if (imageUrl.startsWith('data:')) {
    const base64Part = imageUrl.split(',')[1]
    if (base64Part) {
      return base64Part
    }
  }
  const resp = await fetchImpl(imageUrl, { signal })
  const blob = await resp.blob()
  const arrayBuffer = await blob.arrayBuffer()
  // Buffer is available in both Node.js and Electron renderer
  const base64 = Buffer.from(arrayBuffer).toString('base64')
  return base64
}

export function normalizeGeminiModelName(modelName: string): string {
  const trimmed = modelName.trim()
  if (!trimmed) return trimmed

  const withoutPrefix = trimmed.replace(/^models\//i, '')
  return withoutPrefix.toLowerCase()
}

export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/chat\/completions\/?$/i, '')
    .replace(/\/responses\/?$/i, '')
    .replace(/\/$/, '')
}

const isOfficialOpenAIBaseUrl = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(normalizeOpenAIBaseUrl(baseUrl))
    return parsed.protocol === 'https:' && parsed.hostname === 'api.openai.com'
  } catch {
    return false
  }
}

export function normalizeGeminiBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/models\/[^/?#:]+(?::generateContent)?\/?$/i, '')
    .replace(/\/openai\/?$/i, '')
    .replace(/\/$/, '')
}

export function normalizeClaudeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/v1\/messages\/?$/i, '')
    .replace(/\/v1\/?$/i, '')
    .replace(/\/$/, '')
}

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/api\/(?:chat|generate)\/?$/i, '')
    .replace(/\/$/, '')
}

// ==================== OpenAI-compatible API Client ====================

export class OpenAIAPICli implements LLMCli {
  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    protected readonly options?: OpenAIClientOptions
  ) {}

  private getFetchImpl(): FetchImpl {
    return this.options?.fetchImpl ?? getDefaultFetchImpl()
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    const base = normalizeOpenAIBaseUrl(this.baseUrl)
    const apiMode = this.options?.apiMode || 'auto'
    if (apiMode === 'responses' || (apiMode === 'auto' && isOfficialOpenAIBaseUrl(base))) {
      return this.chatViaResponsesApi(params, base)
    }

    return this.chatViaChatCompletions(params, base)
  }

  private async chatViaResponsesApi(params: LLMChatParams, base: string): Promise<LLMChatResult> {
    let fileSearchSession: Awaited<ReturnType<typeof createOpenAIFileSearchSession>> | null = null
    const requestBody: Record<string, unknown> = {
      model: this.modelName,
      input: buildOpenAIResponsesInput(params.messages),
      instructions: params.systemPrompt?.trim() || 'You are a helpful assistant.',
      store: false
    }
    if (params.maxOutputTokens) {
      requestBody.max_output_tokens = params.maxOutputTokens
    }
    const reasoningEffort = normalizeReasoningEffort(
      params.reasoningEffort,
      resolveChatProfileCapabilities({ model_name: this.modelName }).reasoningEfforts
    )

    const useImageGeneration = shouldUseOpenAIImageGeneration({
      messages: params.messages,
      modelUse: this.options?.modelUse,
      imageGenerationOptions: params.imageGenerationOptions
    })

    if (useImageGeneration) {
      requestBody.tools = [
        buildOpenAIImageGenerationTool({
          messages: params.messages,
          imageGenerationOptions: params.imageGenerationOptions
        })
      ]
      requestBody.tool_choice = {
        type: 'image_generation'
      }
    } else if (this.options?.enableHostedTools ?? isOfficialOpenAIBaseUrl(base)) {
      fileSearchSession = await createOpenAIFileSearchSession({
        apiKey: this.apiKey,
        baseUrl: base,
        messages: params.messages,
        signal: params.signal
      })

      requestBody.tools = [
        ...(fileSearchSession?.vectorStoreIds?.length
          ? [buildOpenAIFileSearchTool(fileSearchSession.vectorStoreIds)]
          : []),
        buildDefaultOpenAIWebSearchTool()
      ]
      requestBody.include = buildDefaultOpenAIResponsesInclude({
        includeFileSearchResults: Boolean(fileSearchSession?.vectorStoreIds?.length)
      })
    }

    if (reasoningEffort) {
      requestBody.reasoning = {
        effort: reasoningEffort
      }
    }

    if (this.options?.serviceTier) {
      requestBody.service_tier = this.options.serviceTier
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.options?.extraHeaders || {})
    }
    if (this.apiKey.trim() && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    try {
      const resp = await this.getFetchImpl()(`${base}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: params.signal
      })

      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`OpenAI API error: ${resp.status} ${resp.statusText} ${text}`)
      }

      const data = await resp.json()
      const serialized = serializeOpenAIResponsesOutput(data)
      if (!serialized) {
        throw new Error(
          `OpenAI Responses API returned empty or invalid content. Response: ${JSON.stringify(data)}`
        )
      }

      const result = normalizeLLMChatResult(serialized)
      const usage = normalizeProviderTokenUsage(data)
      return {
        ...result,
        ...(usage ? { usage } : {})
      }
    } catch (error) {
      throw buildFetchFailureError('OpenAI API', `${base}/responses`, error)
    } finally {
      if (fileSearchSession) {
        await fileSearchSession.cleanup()
      }
    }
  }

  private async chatViaChatCompletions(
    params: LLMChatParams,
    base: string
  ): Promise<LLMChatResult> {
    const { messages, systemPrompt, signal } = params
    const endpoint = `${base}/chat/completions`

    type Role = 'system' | 'user' | 'assistant'
    type TextMessage = { role: Role; content: string }
    type VisionContent =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    type VisionMessage = { role: 'user'; content: VisionContent[] }
    type APIMessage = TextMessage | VisionMessage

    const apiMessages: APIMessage[] = []
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt })
    }

    for (const msg of messages) {
      if (msg.attachments && msg.attachments.length > 0) {
        const imageAttachments = msg.attachments.filter((a) => a.type === 'image')
        if (imageAttachments.length > 0 && msg.role === 'user') {
          const content: VisionContent[] = []
          const textContent = msg.content.trim() || '请分析这张图片'
          content.push({ type: 'text', text: textContent })
          for (const attachment of imageAttachments) {
            content.push({
              type: 'image_url',
              image_url: { url: attachment.url }
            })
          }
          apiMessages.push({ role: 'user', content })
        } else {
          apiMessages.push({ role: msg.role, content: msg.content })
        }
      } else {
        apiMessages.push({ role: msg.role, content: msg.content })
      }
    }

    const requestBody: Record<string, unknown> = {
      model: this.modelName,
      messages: apiMessages,
      temperature: 0.7,
      stream: false
    }
    if (params.maxOutputTokens) {
      requestBody.max_tokens = params.maxOutputTokens
    }
    if (this.options?.serviceTier && isOfficialOpenAIBaseUrl(base)) {
      requestBody.service_tier = this.options.serviceTier
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.options?.extraHeaders || {})
    }
    if (this.apiKey.trim() && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    let resp: Response
    try {
      resp = await this.getFetchImpl()(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal
      })
    } catch (error) {
      throw buildFetchFailureError('OpenAI API', endpoint, error)
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`OpenAI API error: ${resp.status} ${resp.statusText} ${text}`)
    }

    const data = await resp.json()
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.content ??
      data?.message?.content ??
      data?.content

    // Handle image generation model responses (content may be an array of image URLs)
    if (Array.isArray(content) && content.length > 0) {
      const firstItem = content[0]
      if (firstItem && typeof firstItem === 'object') {
        const imageUrl = firstItem.url || firstItem.image_url?.url
        if (imageUrl && typeof imageUrl === 'string') {
          console.log('[OpenAIAPICli] Detected image generation response, returning image URL')
          const usage = normalizeProviderTokenUsage(data)
          return {
            ...normalizeLLMChatResult(imageUrl),
            ...(usage ? { usage } : {})
          }
        }
      }
    }

    if (typeof content !== 'string' || !content) {
      throw new Error(
        `OpenAI API returned empty or invalid content. Response: ${JSON.stringify(data)}`
      )
    }
    const usage = normalizeProviderTokenUsage(data)
    return normalizeLLMChatResult({
      content: content.trim(),
      ...(usage ? { usage } : {})
    })
  }
}

// ==================== Gemini API Client ====================

const normalizeGeminiClientOptions = (
  fetchImplOrOptions?: FetchImpl | GeminiClientOptions
): GeminiClientOptions =>
  typeof fetchImplOrOptions === 'function'
    ? { fetchImpl: fetchImplOrOptions }
    : fetchImplOrOptions || {}

export class GeminiAPICli implements LLMCli {
  protected readonly options: GeminiClientOptions

  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    fetchImplOrOptions?: FetchImpl | GeminiClientOptions
  ) {
    this.options = normalizeGeminiClientOptions(fetchImplOrOptions)
  }

  protected getNormalizedModelName(): string {
    return normalizeGeminiModelName(this.modelName)
  }

  private getFetchImpl(): FetchImpl {
    return this.options.fetchImpl ?? getDefaultFetchImpl()
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    const { messages, systemPrompt, signal } = params
    let base = normalizeGeminiBaseUrl(this.baseUrl)

    // Ensure base URL has API version. OpenCode Zen already includes /v1.
    if (!base.includes('/v1') && !base.includes('/v1beta')) {
      base = base.replace(/\/$/, '') + '/v1beta'
    }

    const modelName = this.getNormalizedModelName()
    const endpoint = `${base}/models/${modelName}:generateContent`

    type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string } }
    type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

    const contents: GeminiContent[] = []

    for (const msg of messages) {
      const parts: GeminiPart[] = []

      // Process image attachments
      if (msg.attachments && msg.attachments.length > 0) {
        const imageAttachments = msg.attachments.filter((a) => a.type === 'image')
        for (const attachment of imageAttachments) {
          try {
            const base64 = await convertImageToBase64(attachment.url, signal, this.getFetchImpl())
            let mimeType = attachment.mimeType || 'image/jpeg'
            if (attachment.url.startsWith('data:')) {
              const mimeMatch = attachment.url.match(/data:([^;]+)/)
              if (mimeMatch) {
                mimeType = mimeMatch[1]
              }
            }
            parts.push({
              inlineData: {
                mimeType,
                data: base64
              }
            })
          } catch (err) {
            console.error('[GeminiAPICli] Failed to process image attachment:', err)
          }
        }
      }

      // Add text content
      if (msg.content.trim()) {
        parts.push({ text: msg.content })
      }

      if (parts.length > 0) {
        const role = msg.role === 'assistant' ? 'model' : 'user'
        contents.push({ role, parts })
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestBody: Record<string, any> = {
      contents
    }
    if (params.maxOutputTokens) {
      requestBody.generationConfig = {
        ...(requestBody.generationConfig || {}),
        maxOutputTokens: params.maxOutputTokens
      }
    }

    if (systemPrompt) {
      requestBody.systemInstruction = {
        parts: [{ text: systemPrompt }]
      }
    }

    const url = new URL(endpoint)
    const authMode = this.options.authMode || 'query-key'
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.options.extraHeaders || {})
    }
    if (authMode === 'bearer') {
      if (this.apiKey.trim() && !headers.Authorization) {
        headers.Authorization = `Bearer ${this.apiKey}`
      }
    } else if (authMode === 'x-goog-api-key') {
      if (this.apiKey.trim() && !headers['x-goog-api-key']) {
        headers['x-goog-api-key'] = this.apiKey
      }
    } else {
      url.searchParams.set('key', this.apiKey)
    }

    let resp: Response
    try {
      resp = await this.getFetchImpl()(url.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal
      })
    } catch (error) {
      throw buildFetchFailureError('Gemini API', url.toString(), error)
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Gemini API error: ${resp.status} ${resp.statusText} ${text}`)
    }

    const data = await resp.json()
    const content = data?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')

    if (typeof content !== 'string' || !content) {
      throw new Error(
        `Gemini API returned empty or invalid content. Response: ${JSON.stringify(data)}`
      )
    }
    const usage = normalizeProviderTokenUsage(data)
    return normalizeLLMChatResult({
      content: content.trim(),
      ...(usage ? { usage } : {})
    })
  }
}

// ==================== Claude API Client ====================

const normalizeClaudeClientOptions = (
  fetchImplOrOptions?: FetchImpl | ClaudeClientOptions
): ClaudeClientOptions =>
  typeof fetchImplOrOptions === 'function'
    ? { fetchImpl: fetchImplOrOptions }
    : fetchImplOrOptions || {}

const isBearerClaudeEndpoint = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(baseUrl.trim())
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()
    return (
      (hostname === 'api.kimi.com' && pathname.includes('/coding')) ||
      (hostname === 'open.bigmodel.cn' && pathname.includes('/api/anthropic'))
    )
  } catch {
    return false
  }
}

export class ClaudeAPICli implements LLMCli {
  protected readonly options: ClaudeClientOptions

  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    fetchImplOrOptions?: FetchImpl | ClaudeClientOptions
  ) {
    this.options = normalizeClaudeClientOptions(fetchImplOrOptions)
  }

  private getFetchImpl(): FetchImpl {
    return this.options.fetchImpl ?? getDefaultFetchImpl()
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    const { messages, systemPrompt, signal } = params
    const base = normalizeClaudeBaseUrl(this.baseUrl)
    const endpoint = `${base}/v1/messages`

    type ContentBlock =
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

    type ClaudeMessage = {
      role: 'user' | 'assistant'
      content: string | ContentBlock[]
    }

    const claudeMessages: ClaudeMessage[] = []

    for (const msg of messages) {
      // Skip system messages (handled as a separate parameter in Claude API)
      if (msg.role === 'system') continue

      if (msg.attachments && msg.attachments.length > 0) {
        const imageAttachments = msg.attachments.filter((a) => a.type === 'image')
        if (imageAttachments.length > 0 && msg.role === 'user') {
          const content: ContentBlock[] = []

          for (const attachment of imageAttachments) {
            try {
              const base64 = await convertImageToBase64(attachment.url, signal, this.getFetchImpl())
              let mediaType = attachment.mimeType || 'image/jpeg'
              if (attachment.url.startsWith('data:')) {
                const mimeMatch = attachment.url.match(/data:([^;]+)/)
                if (mimeMatch) {
                  mediaType = mimeMatch[1]
                }
              }
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64
                }
              })
            } catch (err) {
              console.error('[ClaudeAPICli] Failed to process image attachment:', err)
            }
          }

          if (msg.content.trim()) {
            content.push({ type: 'text', text: msg.content })
          }

          claudeMessages.push({
            role: msg.role as 'user' | 'assistant',
            content
          })
        } else {
          claudeMessages.push({
            role: msg.role as 'user' | 'assistant',
            content: msg.content
          })
        }
      } else {
        claudeMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        })
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestBody: Record<string, any> = {
      model: this.modelName,
      max_tokens: params.maxOutputTokens || this.options.maxTokens || 4096,
      messages: claudeMessages
    }

    if (systemPrompt) {
      requestBody.system = systemPrompt
    }

    const authAsBearer = this.options.authAsBearer ?? isBearerClaudeEndpoint(base)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(this.options.extraHeaders || {})
    }
    if (this.apiKey.trim()) {
      if (authAsBearer) {
        headers.Authorization = headers.Authorization || `Bearer ${this.apiKey}`
      } else {
        headers['x-api-key'] = headers['x-api-key'] || this.apiKey
      }
    }

    let resp: Response
    try {
      resp = await this.getFetchImpl()(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal
      })
    } catch (error) {
      throw buildFetchFailureError('Claude API', endpoint, error)
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Claude API error: ${resp.status} ${resp.statusText} ${text}`)
    }

    const data = await resp.json()
    const contentText = Array.isArray(data?.content)
      ? data.content
          .map((block: { text?: unknown }) => (typeof block?.text === 'string' ? block.text : ''))
          .join('')
      : undefined

    if (typeof contentText !== 'string' || !contentText) {
      throw new Error(
        `Claude API returned empty or invalid content. Response: ${JSON.stringify(data)}`
      )
    }
    const usage = normalizeProviderTokenUsage(data)
    return normalizeLLMChatResult({
      content: contentText.trim(),
      ...(usage ? { usage } : {})
    })
  }
}

// ==================== OpenCode Zen API Client ====================

export class OpencodeZenAPICli implements LLMCli {
  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    protected readonly options?: { fetchImpl?: FetchImpl }
  ) {}

  private getBaseUrl(): string {
    const trimmed = normalizeOpenAIBaseUrl(this.baseUrl || OPENCODE_ZEN_API_BASE_URL)
      .replace(/\/messages\/?$/i, '')
      .replace(/\/models\/[^/?#:]+(?::generateContent)?\/?$/i, '')
      .replace(/\/$/, '')
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

    try {
      const parsed = new URL(normalized)
      if (parsed.hostname.toLowerCase() !== 'opencode.ai') {
        return normalized
      }

      const pathname = parsed.pathname.replace(/\/+$/g, '') || '/zen/v1'
      if (pathname === '/zen') {
        return `${parsed.origin}/zen/v1`
      }
      const versionMatch = pathname.match(
        /^(\/zen\/v\d+)(?:\/(?:responses|messages|chat\/completions))?$/i
      )
      if (versionMatch) {
        return `${parsed.origin}${versionMatch[1]}`
      }
    } catch {
      // Fall back to the string normalization above.
    }

    return normalized
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    const modelName = resolveOpencodeZenAlias(this.modelName)
    const baseUrl = this.getBaseUrl()
    const modelApi = resolveOpencodeZenModelApi(modelName)

    switch (modelApi) {
      case 'openai-responses':
        return new OpenAIAPICli(this.apiKey, baseUrl, modelName, {
          apiMode: 'responses',
          enableHostedTools: false,
          fetchImpl: this.options?.fetchImpl
        }).chat(params)
      case 'anthropic-messages':
        return new ClaudeAPICli(this.apiKey, baseUrl, modelName, {
          authAsBearer: false,
          fetchImpl: this.options?.fetchImpl
        }).chat(params)
      case 'google-generative-ai':
        return new GeminiAPICli(this.apiKey, baseUrl, modelName, {
          authMode: 'x-goog-api-key',
          fetchImpl: this.options?.fetchImpl
        }).chat(params)
      case 'openai-completions':
      default:
        return new OpenAIAPICli(this.apiKey, baseUrl, modelName, {
          apiMode: 'chat-completions',
          fetchImpl: this.options?.fetchImpl
        }).chat(params)
    }
  }
}

// ==================== Ollama API Client ====================

export class OllamaAPICli implements LLMCli {
  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    protected readonly fetchImpl: FetchImpl = getDefaultFetchImpl()
  ) {}

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    const { messages, systemPrompt, signal } = params
    const base = normalizeOllamaBaseUrl(this.baseUrl)
    const endpoint = `${base}/api/chat`

    type Role = 'system' | 'user' | 'assistant'
    type OllamaMessage = {
      role: Role
      content: string
      images?: string[]
    }

    const ollamaMessages: OllamaMessage[] = []
    if (systemPrompt) {
      ollamaMessages.push({ role: 'system', content: systemPrompt })
    }

    for (const msg of messages) {
      const ollamaMsg: OllamaMessage = { role: msg.role, content: msg.content }

      // Handle image attachments for Ollama
      if (msg.attachments && msg.attachments.length > 0) {
        const imageAttachments = msg.attachments.filter((a) => a.type === 'image')
        if (imageAttachments.length > 0) {
          ollamaMsg.images = []
          for (const attachment of imageAttachments) {
            try {
              const base64 = await convertImageToBase64(attachment.url, signal, this.fetchImpl)
              ollamaMsg.images.push(base64)
            } catch (err) {
              console.error('[OllamaAPICli] Failed to process image attachment:', err)
            }
          }
        }
      }

      ollamaMessages.push(ollamaMsg)
    }

    const requestBody = {
      model: this.modelName,
      messages: ollamaMessages,
      stream: false,
      ...(params.maxOutputTokens ? { options: { num_predict: params.maxOutputTokens } } : {})
    }

    let resp: Response
    try {
      resp = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal
      })
    } catch (error) {
      throw buildFetchFailureError('Ollama API', endpoint, error)
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Ollama API error: ${resp.status} ${resp.statusText} ${text}`)
    }

    const data = await resp.json()
    const content = data?.message?.content

    if (typeof content !== 'string' || !content) {
      throw new Error(
        `Ollama API returned empty or invalid content. Response: ${JSON.stringify(data)}`
      )
    }
    const usage = normalizeProviderTokenUsage(data)
    return normalizeLLMChatResult({
      content: content.trim(),
      ...(usage ? { usage } : {})
    })
  }
}
