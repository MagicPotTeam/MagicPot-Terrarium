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

export class MainProcessQAppLLMProxyCli implements LLMCliWithPrompt {
  constructor(private readonly profileId: string) {}

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
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
    const mimeType = params.imageObjUrl ? inferImageMimeType(params.imageObjUrl) : undefined
    const result = await this.chat({
      messages: [
        {
          role: 'user',
          content: params.prompt,
          ...(params.imageObjUrl
            ? {
                attachments: [
                  {
                    type: 'image',
                    url: params.imageObjUrl,
                    ...(mimeType ? { mimeType } : {})
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
      return new OllamaAPICli(profile.api_key || '', profile.base_url, profile.model_name)
    case 'gemini':
      return new GeminiAPICli(profile.api_key, profile.base_url, profile.model_name)
    case 'claude':
      return new ClaudeAPICli(profile.api_key, profile.base_url, profile.model_name)
    case 'kling':
    case 'volcengine':
      return new MainProcessQAppLLMProxyCli(profile.id)
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
