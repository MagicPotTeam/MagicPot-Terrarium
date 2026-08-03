/**
 * Renderer-side LLM client wrappers.
 *
 * Core chat() implementations live in @shared/llm/clients.ts (single source of truth).
 * This file adds renderer-only features:
 *   - compressImage() (uses browser Canvas API)
 *   - generatePrompt() (single-shot prompt generation with image support)
 *   - defaultCliFromProfile / getLocalCliFromProfile / generatePromptWithFallback
 */

import { Config, LLMAPIProfile } from '@shared/config/config'
import {
  OpenAIAPICli as SharedOpenAIAPICli,
  GeminiAPICli as SharedGeminiAPICli,
  ClaudeAPICli as SharedClaudeAPICli,
  OllamaAPICli as SharedOllamaAPICli,
  convertImageToBase64,
  normalizeGeminiModelName,
  normalizeGeminiBaseUrl,
  normalizeClaudeBaseUrl,
  normalizeOllamaBaseUrl,
  isGeminiUrl,
  isClaudeUrl,
  isOllamaProfile,
  resolveProfileProvider,
  resolveProfileModelUse,
  isRunnableProfile
} from '@shared/llm'
import type {
  GeneratePromptParams,
  LLMChatParams,
  LLMChatResult,
  LLMCliWithPrompt
} from '@shared/llm'
import { api } from '@renderer/utils/windowUtils'
import { findQAppApiProfile, getConfiguredQAppApiProfiles } from '../qAppApiProfiles'

// Re-export shared types so existing imports from this file still work
export type { ChatAttachment, ChatMessage, GeneratePromptParams } from '@shared/llm'

// Re-export the interface under its original name for backwards compatibility
export type LLMCli = LLMCliWithPrompt

// ==================== Browser-only helper ====================

/**
 * Compress an image data URL using Canvas (browser-only).
 * Not available in Node.js / main process.
 */
async function compressImage(
  dataUrl: string,
  maxSize: number = 768,
  quality: number = 0.8
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img

      if (width > maxSize || height > maxSize) {
        const scale = Math.min(maxSize / width, maxSize / height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      ctx.drawImage(img, 0, 0, width, height)

      const compressedDataUrl = canvas.toDataURL('image/jpeg', quality)
      console.log(
        `[compressImage] Image compressed: ${Math.round(dataUrl.length / 1024)}KB -> ${Math.round(compressedDataUrl.length / 1024)}KB`
      )
      resolve(compressedDataUrl)
    }
    img.onerror = () => reject(new Error('Failed to load image for compression'))
    img.src = dataUrl
  })
}

// ==================== Renderer-side client wrappers ====================
// Extend shared clients with generatePrompt() (renderer-only feature)

export class OpenAIAPICli extends SharedOpenAIAPICli implements LLMCliWithPrompt {
  async generatePrompt(params: GeneratePromptParams): Promise<string> {
    const { prompt, systemPrompt, imageObjUrl } = params
    const endpoint = this.baseUrl.trim().replace(/\/$/, '')

    type Role = 'system' | 'user' | 'assistant'
    type TextMessage = { role: Role; content: string }
    type VisionContent =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    type VisionMessage = { role: 'user'; content: VisionContent[] }
    type ChatMessage = TextMessage | VisionMessage

    const messages: ChatMessage[] = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }

    if (imageObjUrl) {
      let finalImageUrl = imageObjUrl
      if (imageObjUrl.startsWith('data:')) {
        try {
          finalImageUrl = await compressImage(imageObjUrl, 2048, 0.85)
        } catch (e) {
          console.warn('[OpenAIAPICli] Image compression failed, using original:', e)
        }
      }

      const textContent = prompt.trim() || '请分析这张图片'
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: textContent },
          { type: 'image_url', image_url: { url: finalImageUrl } }
        ]
      })
    } else {
      messages.push({ role: 'user', content: prompt })
    }

    const requestBody = {
      model: this.modelName,
      messages,
      temperature: 0.7,
      stream: false
    }

    console.log('[OpenAIAPICli] Request:', {
      endpoint,
      model: this.modelName,
      hasImage: !!imageObjUrl,
      messageCount: messages.length
    })

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(requestBody)
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      console.error('[OpenAIAPICli] Error response:', {
        status: resp.status,
        statusText: resp.statusText,
        body: text
      })
      throw new Error(`OpenAI API error: ${resp.status} ${resp.statusText} ${text}`)
    }

    const data = await resp.json()
    console.log('[OpenAIAPICli] Response:', {
      hasChoices: !!data?.choices,
      choicesLength: data?.choices?.length,
      firstChoice: data?.choices?.[0]
    })

    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.content ??
      data?.message?.content ??
      data?.content

    if (Array.isArray(content) && content.length > 0) {
      const firstItem = content[0]
      if (firstItem && typeof firstItem === 'object') {
        const imageUrl = firstItem.url || firstItem.image_url?.url
        if (imageUrl && typeof imageUrl === 'string') {
          console.log('[OpenAIAPICli] Detected image generation response, returning image URL')
          return imageUrl
        }
      }
    }

    if (typeof content !== 'string' || !content) {
      console.error('[OpenAIAPICli] Invalid response format:', data)
      throw new Error(
        `OpenAI API returned empty or invalid content. Response: ${JSON.stringify(data)}`
      )
    }
    return content.trim()
  }
}

export class GeminiAPICli extends SharedGeminiAPICli implements LLMCliWithPrompt {
  private async convertImageToBase64Browser(imageUrl: string): Promise<string> {
    try {
      if (imageUrl.startsWith('data:')) {
        const base64Part = imageUrl.split(',')[1]
        if (base64Part) {
          return base64Part
        }
      }
      const resp = await fetch(imageUrl)
      const blob = await resp.blob()
      const arrayBuffer = await blob.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
      return base64
    } catch (err) {
      console.error('[GeminiAPICli] Failed to convert image to base64:', err)
      throw err
    }
  }

  async generatePrompt(params: GeneratePromptParams): Promise<string> {
    const { prompt, systemPrompt, imageObjUrl } = params
    let base = normalizeGeminiBaseUrl(this.baseUrl)
    const modelName = normalizeGeminiModelName(this.modelName)

    if (!base.includes('/v1') && !base.includes('/v1beta')) {
      base = base.replace(/\/$/, '') + '/v1beta'
    }

    const endpoint = `${base}/models/${modelName}:generateContent`

    type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string } }
    type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

    const contents: GeminiContent[] = []
    const parts: GeminiPart[] = []

    if (imageObjUrl) {
      try {
        const base64 = await this.convertImageToBase64Browser(imageObjUrl)
        let mimeType = 'image/jpeg'
        if (imageObjUrl.startsWith('data:')) {
          const mimeMatch = imageObjUrl.match(/data:([^;]+)/)
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
        if (prompt.trim()) {
          parts.push({ text: prompt })
        }
      } catch (err) {
        console.error('[GeminiAPICli] Failed to process image, using text only:', err)
        parts.push({ text: prompt || '请分析这张图片' })
      }
    } else {
      parts.push({ text: prompt })
    }

    contents.push({ role: 'user', parts })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestBody: Record<string, any> = {
      contents
    }

    if (systemPrompt) {
      requestBody.systemInstruction = {
        parts: [{ text: systemPrompt }]
      }
    }

    console.log('[GeminiAPICli] Request:', {
      endpoint,
      model: modelName,
      hasImage: !!imageObjUrl,
      hasSystemPrompt: !!systemPrompt
    })

    const url = new URL(endpoint)
    url.searchParams.set('key', this.apiKey)

    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      console.error('[GeminiAPICli] Error response:', {
        status: resp.status,
        statusText: resp.statusText,
        body: text
      })
      throw new Error(`Gemini API error: ${resp.status} ${resp.statusText} ${text}`)
    }

    const data = await resp.json()
    console.log('[GeminiAPICli] Response:', data)

    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text

    if (typeof content !== 'string' || !content) {
      console.error('[GeminiAPICli] Invalid response format:', data)
      throw new Error(
        `Gemini API returned empty or invalid content. Response: ${JSON.stringify(data)}`
      )
    }
    return content.trim()
  }
}

export class OllamaAPICli extends SharedOllamaAPICli implements LLMCliWithPrompt {
  async generatePrompt(params: GeneratePromptParams): Promise<string> {
    const { prompt, systemPrompt, imageObjUrl } = params
    const base = normalizeOllamaBaseUrl(this.baseUrl)
    const endpoint = `${base}/api/chat`

    type Role = 'system' | 'user' | 'assistant'
    type OllamaMessage = {
      role: Role
      content: string
      images?: string[]
    }

    const messages: OllamaMessage[] = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }

    let images: string[] | undefined
    if (imageObjUrl) {
      try {
        const resp = await fetch(imageObjUrl)
        const blob = await resp.blob()
        const arrayBuffer = await blob.arrayBuffer()
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
        images = [base64]
      } catch (err) {
        images = undefined
      }
    }

    messages.push({ role: 'user', content: prompt, images })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.modelName,
        messages,
        stream: false,
        options: {
          temperature: 0.7
        }
      })
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Ollama API error: ${resp.status} ${resp.statusText} ${text}`)
    }

    const data = await resp.json()
    const content = data?.message?.content ?? data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content) {
      throw new Error('Ollama API returned empty content')
    }
    return content.trim()
  }
}

export class ClaudeAPICli extends SharedClaudeAPICli implements LLMCliWithPrompt {
  private async convertImageToBase64Browser(imageUrl: string): Promise<string> {
    try {
      if (imageUrl.startsWith('data:')) {
        const base64Part = imageUrl.split(',')[1]
        if (base64Part) {
          return base64Part
        }
      }
      const resp = await fetch(imageUrl)
      const blob = await resp.blob()
      const arrayBuffer = await blob.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
      return base64
    } catch (err) {
      console.error('[ClaudeAPICli] Failed to convert image to base64:', err)
      throw err
    }
  }

  async generatePrompt(params: GeneratePromptParams): Promise<string> {
    const { prompt, systemPrompt, imageObjUrl } = params
    const base = normalizeClaudeBaseUrl(this.baseUrl)
    const endpoint = `${base}/v1/messages`

    type ContentBlock =
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

    const content: ContentBlock[] = []

    if (imageObjUrl) {
      try {
        const base64 = await this.convertImageToBase64Browser(imageObjUrl)
        let mediaType = 'image/jpeg'
        if (imageObjUrl.startsWith('data:')) {
          const mimeMatch = imageObjUrl.match(/data:([^;]+)/)
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
        if (prompt.trim()) {
          content.push({ type: 'text', text: prompt })
        }
      } catch (err) {
        console.error('[ClaudeAPICli] Failed to process image, using text only:', err)
        content.push({ type: 'text', text: prompt || '请分析这张图片' })
      }
    } else {
      content.push({ type: 'text', text: prompt })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestBody: Record<string, any> = {
      model: this.modelName,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content
        }
      ]
    }

    if (systemPrompt) {
      requestBody.system = systemPrompt
    }

    console.log('[ClaudeAPICli] Request:', {
      endpoint,
      model: this.modelName,
      hasImage: !!imageObjUrl,
      hasSystemPrompt: !!systemPrompt
    })

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      console.error('[ClaudeAPICli] Error response:', {
        status: resp.status,
        statusText: resp.statusText,
        body: text
      })
      throw new Error(`Claude API error: ${resp.status} ${resp.statusText} ${text}`)
    }

    const data = await resp.json()
    console.log('[ClaudeAPICli] Response:', data)

    const content_text = data?.content?.[0]?.text

    if (typeof content_text !== 'string' || !content_text) {
      console.error('[ClaudeAPICli] Invalid response format:', data)
      throw new Error(
        `Claude API returned empty or invalid content. Response: ${JSON.stringify(data)}`
      )
    }
    return content_text.trim()
  }
}

// ==================== Profile helper functions ====================

const inferImageMimeType = (imageUrl: string): string | undefined => {
  const match = imageUrl.match(/^data:([^;,]+)[;,]/i)
  return match?.[1]
}

const MAX_REQUEST_IMAGE_BYTES = 25 * 1024 * 1024
const STRICT_RASTER_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/
const SUPPORTED_RASTER_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const QAPP_INLINE_IMAGE_POLICY_MARKER = 'qapp-renderer-materialized-v1'
const MAX_PROVIDER_ACCESSIBLE_URL_LENGTH = 8 * 1024
const RASTER_SIGNATURE_BYTES = 12
const BASE64_PART_LENGTH = 16 * 1024
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const imageLimitError = (): Error =>
  new Error(
    `Attachment transport error: image exceeds the ${MAX_REQUEST_IMAGE_BYTES}-byte request attachment limit.`
  )

class IncrementalRasterBase64Encoder {
  private readonly base64Parts: string[] = []
  private currentPart = ''
  private readonly carry: number[] = []
  private readonly signaturePrefix: number[] = []
  private rawByteLength = 0

  push(bytes: Uint8Array): void {
    if (this.rawByteLength + bytes.byteLength > MAX_REQUEST_IMAGE_BYTES) throw imageLimitError()
    this.rawByteLength += bytes.byteLength

    for (
      let index = 0;
      index < bytes.length && this.signaturePrefix.length < RASTER_SIGNATURE_BYTES;
      index += 1
    ) {
      this.signaturePrefix.push(bytes[index])
    }

    let offset = 0
    while (this.carry.length < 3 && offset < bytes.length) this.carry.push(bytes[offset++])
    if (this.carry.length === 3) {
      this.appendTriple(this.carry[0], this.carry[1], this.carry[2])
      this.carry.length = 0
    }

    const completeEnd = offset + Math.floor((bytes.length - offset) / 3) * 3
    for (; offset < completeEnd; offset += 3) {
      this.appendTriple(bytes[offset], bytes[offset + 1], bytes[offset + 2])
    }
    for (; offset < bytes.length; offset += 1) this.carry.push(bytes[offset])
  }

  finish(declaredSize: number | undefined, declaredMimeType: string): string {
    if (declaredSize !== undefined && this.rawByteLength !== declaredSize) {
      throw new Error('Attachment transport error: image response content length mismatch.')
    }
    if (this.rawByteLength === 0) throw new Error('Attachment transport error: image is empty.')

    if (this.carry.length === 1) {
      const first = this.carry[0]
      this.appendCharacters(
        BASE64_ALPHABET[first >> 2] + BASE64_ALPHABET[(first & 0x03) << 4] + '=='
      )
    } else if (this.carry.length === 2) {
      const [first, second] = this.carry
      this.appendCharacters(
        BASE64_ALPHABET[first >> 2] +
          BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)] +
          BASE64_ALPHABET[(second & 0x0f) << 2] +
          '='
      )
    }
    if (this.currentPart) this.base64Parts.push(this.currentPart)

    const canonicalMimeType = assertRasterImageBytes(
      Uint8Array.from(this.signaturePrefix),
      declaredMimeType
    )
    return `data:${canonicalMimeType};base64,${this.base64Parts.join('')}`
  }

  private appendTriple(first: number, second: number, third: number): void {
    this.appendCharacters(
      BASE64_ALPHABET[first >> 2] +
        BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)] +
        BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] +
        BASE64_ALPHABET[third & 0x3f]
    )
  }

  private appendCharacters(value: string): void {
    this.currentPart += value
    if (this.currentPart.length >= BASE64_PART_LENGTH) {
      this.base64Parts.push(this.currentPart)
      this.currentPart = ''
    }
  }
}

const inferRasterMimeTypeFromBytes = (bytes: Uint8Array): string | undefined => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (
    bytes.length >= 6 &&
    (String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF87a' ||
      String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF89a')
  ) {
    return 'image/gif'
  }
  return undefined
}

const assertRasterImageBytes = (bytes: Uint8Array, declaredMimeType: string): string => {
  if (bytes.byteLength === 0) {
    throw new Error('Attachment transport error: image is empty.')
  }
  const canonicalMimeType = inferRasterMimeTypeFromBytes(bytes)
  if (!canonicalMimeType) {
    throw new Error('Attachment transport error: image bytes are not a supported raster image.')
  }
  if (canonicalMimeType !== declaredMimeType) {
    throw new Error(
      `Attachment transport error: image MIME mismatch (${declaredMimeType} header, ${canonicalMimeType} bytes).`
    )
  }
  return canonicalMimeType
}

const canonicalizeRequestImageDataUrl = (url: string): string => {
  const match = STRICT_RASTER_DATA_URL.exec(url)
  if (!match || match[2].length % 4 !== 0) {
    throw new Error(
      'Attachment transport error: expected a canonical PNG, JPEG, WebP, or GIF data URL.'
    )
  }

  let binary: string
  try {
    binary = atob(match[2])
  } catch {
    throw new Error(
      'Attachment transport error: expected a canonical PNG, JPEG, WebP, or GIF data URL.'
    )
  }
  if (binary.length > MAX_REQUEST_IMAGE_BYTES) throw imageLimitError()
  const canonicalBase64 = btoa(binary)
  if (canonicalBase64 !== match[2]) {
    throw new Error(
      'Attachment transport error: expected a canonical PNG, JPEG, WebP, or GIF data URL.'
    )
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const mimeType = assertRasterImageBytes(bytes, match[1])
  return `data:${mimeType};base64,${canonicalBase64}`
}

const materializeRequestImageDataUrl = async (imageUrl: string): Promise<string> => {
  const controller = new AbortController()
  try {
    const response = await fetch(imageUrl, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`Attachment transport error: image fetch failed with ${response.status}.`)
    }
    const mimeType = response.headers.get('content-type')?.toLowerCase().split(';', 1)[0].trim()
    if (!mimeType || !SUPPORTED_RASTER_MIME_TYPES.has(mimeType)) {
      throw new Error('Attachment transport error: fetched attachment is not a supported image.')
    }

    const contentLengthHeader = response.headers.get('content-length')
    const declaredSize = contentLengthHeader === null ? undefined : Number(contentLengthHeader)
    if (declaredSize !== undefined && (!Number.isFinite(declaredSize) || declaredSize < 0)) {
      throw new Error('Attachment transport error: image response has an invalid content length.')
    }
    if (declaredSize !== undefined && declaredSize > MAX_REQUEST_IMAGE_BYTES) {
      throw imageLimitError()
    }

    const encoder = new IncrementalRasterBase64Encoder()
    const reader = response.body?.getReader()
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          try {
            encoder.push(value)
          } catch (error) {
            await reader.cancel().catch(() => undefined)
            controller.abort()
            throw error
          }
        }
      } finally {
        reader.releaseLock()
      }
    } else {
      if (declaredSize === undefined) {
        throw new Error(
          'Attachment transport error: image response requires a bounded content length.'
        )
      }
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_REQUEST_IMAGE_BYTES) throw imageLimitError()
      encoder.push(new Uint8Array(buffer))
    }

    return encoder.finish(declaredSize, mimeType)
  } finally {
    controller.abort()
  }
}

const isPrivateOrLocalProviderHost = (hostname: string): boolean => {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (
    !normalized ||
    normalized === 'localhost' ||
    normalized === 'ip6-localhost' ||
    normalized === 'ip6-loopback' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.localdomain')
  ) {
    return true
  }

  const ipv4Match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number)
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
    const [first, second, third] = octets
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    )
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    /^f[cd][0-9a-f]{2}:/i.test(normalized) ||
    /^fe[89ab][0-9a-f]:/i.test(normalized) ||
    /^ff[0-9a-f]{2}:/i.test(normalized) ||
    /^::ffff:(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(normalized)
  )
}

const assertProviderAccessibleVideoUrl = (value: string): void => {
  if (!value || value.length > MAX_PROVIDER_ACCESSIBLE_URL_LENGTH) {
    throw new Error(
      `Video attachment transport error: image URL must be non-empty and at most ${MAX_PROVIDER_ACCESSIBLE_URL_LENGTH} characters.`
    )
  }
  try {
    const parsed = new URL(value)
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      isPrivateOrLocalProviderHost(parsed.hostname)
    ) {
      throw new Error('unsafe')
    }
  } catch {
    throw new Error(
      'Video attachment transport error: dedicated video routes require a public HTTPS image URL without credentials; data, blob, file, local-media, localhost, and private-network URLs are not supported.'
    )
  }
}

export class MainProcessQAppLLMProxyCli implements LLMCliWithPrompt {
  private readonly profileId: string
  private readonly requiresInlineRequestImage: boolean
  private readonly isVideoProfile: boolean

  constructor(profile: LLMAPIProfile) {
    this.profileId = profile.id
    const provider = resolveProfileProvider(profile)
    this.isVideoProfile = resolveProfileModelUse(profile) === 'video'
    this.requiresInlineRequestImage =
      !this.isVideoProfile &&
      (provider === 'gemini' || provider === 'claude' || provider === 'ollama')
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    if (this.isVideoProfile) {
      for (const attachment of params.messages.flatMap((message) => message.attachments || [])) {
        if (attachment.type === 'image') assertProviderAccessibleVideoUrl(attachment.url)
      }
    }
    const result = await api().svcLLMProxy.chat({
      messages: params.messages,
      systemPrompt: params.systemPrompt,
      reasoningEffort: params.reasoningEffort,
      profileId: this.profileId,
      profileScope: 'qapp',
      sessionUrl: params.sessionUrl,
      conversationId: params.conversationId
    })

    if (params.onDelta && result.content) {
      params.onDelta({
        type: 'text-delta',
        delta: result.content
      })
    }

    return result
  }

  async generatePrompt(params: GeneratePromptParams): Promise<string> {
    let imageUrl = params.imageObjUrl
    if (imageUrl && this.requiresInlineRequestImage) {
      if (imageUrl.startsWith('data:')) {
        imageUrl = canonicalizeRequestImageDataUrl(imageUrl)
      } else {
        imageUrl = await materializeRequestImageDataUrl(imageUrl)
      }
    }

    const mimeType = imageUrl ? inferImageMimeType(imageUrl) : undefined
    const result = await this.chat({
      messages: [
        {
          role: 'user',
          content: params.prompt,
          ...(imageUrl
            ? {
                attachments: [
                  {
                    type: 'image',
                    url: imageUrl,
                    ...(mimeType ? { mimeType } : {}),
                    ...(this.requiresInlineRequestImage
                      ? {
                          metadata: {
                            internalTransport: QAPP_INLINE_IMAGE_POLICY_MARKER
                          }
                        }
                      : {})
                  }
                ]
              }
            : {})
        }
      ],
      systemPrompt: params.systemPrompt
    })

    const content = result.content || result.imageUrl || result.attachments?.[0]?.url || ''
    if (!content.trim()) {
      throw new Error('LLM API returned empty content.')
    }
    return content.trim()
  }
}

export const cliFromProfile = (profile: LLMAPIProfile): LLMCli | undefined => {
  if (!isRunnableProfile(profile)) {
    return undefined
  }

  switch (resolveProfileProvider(profile)) {
    case 'ollama':
    case 'gemini':
    case 'claude':
    case 'kling':
    case 'volcengine':
      return new MainProcessQAppLLMProxyCli(profile)
    case 'openai':
    default:
      return new OpenAIAPICli(profile.api_key, profile.base_url, profile.model_name, {
        modelUse: resolveProfileModelUse(profile)
      })
  }
}

export const defaultCliFromProfile = (
  config: Config,
  needVision?: boolean,
  profileId?: string
): LLMCli | undefined => {
  const validApiProfiles = getConfiguredQAppApiProfiles(config)

  console.log('[defaultCliFromProfile] Searching for profile:', {
    needVision,
    profileId,
    totalProfiles: validApiProfiles.length,
    validProfiles: validApiProfiles.length,
    profiles: validApiProfiles.map((p) => ({
      name: p.model_name,
      model: p.model_name,
      id: p.id,
      isVision: p.is_vision_model
    }))
  })

  const apiProfile = findQAppApiProfile(config, {
    needVisionModel: needVision,
    profileId
  })

  if (!apiProfile && needVision) {
    console.warn(
      '[defaultCliFromProfile] No vision model found. Available profiles:',
      validApiProfiles.map((p) => ({
        name: p.model_name,
        model: p.model_name,
        isVision: p.is_vision_model
      }))
    )
  }

  if (!apiProfile) {
    return undefined
  }

  console.log('[defaultCliFromProfile] Selected profile:', {
    name: apiProfile.model_name,
    model: apiProfile.model_name,
    baseUrl: apiProfile.base_url,
    isOllama: apiProfile.is_ollama
  })

  return cliFromProfile(apiProfile)
}

/**
 * 获取本地 LLM 客户端（忽略远程模式设置）
 */
export const getLocalCliFromProfile = (
  config: Config,
  needVision?: boolean
): LLMCli | undefined => {
  const apiProfile = findQAppApiProfile(config, {
    needVisionModel: needVision
  })

  if (!apiProfile) {
    return undefined
  }

  return cliFromProfile(apiProfile)
}

/**
 * 生成提示词（使用配置的 LLM API）
 *
 * @param config 应用配置
 * @param params generatePrompt 参数
 * @param needVision 是否需要视觉模型
 * @param forceUseAPI 保留参数（不再有作用，始终使用API）
 * @returns 生成的提示词
 */
export const generatePromptWithFallback = async (
  config: Config,
  params: GeneratePromptParams,
  needVision?: boolean,
  forceUseAPI?: boolean // 保留参数以保持兼容性
): Promise<string> => {
  console.log('[generatePromptWithFallback] 使用 LLM API 客户端')

  const primaryCli = defaultCliFromProfile(config, needVision)
  if (!primaryCli) {
    throw new Error('没有可用的 LLM API 配置')
  }

  return primaryCli.generatePrompt(params)
}
