/**
 * OpenCode Zen model catalog with dynamic fetching, caching, and static fallback.
 *
 * OpenCode Zen is not one uniform wire protocol: each model family is exposed
 * through the endpoint shape recommended by OpenCode (OpenAI Responses,
 * Anthropic Messages, Google generateContent, or OpenAI-compatible Chat
 * Completions).  Keeping that routing table local lets MagicPot avoid the
 * common failure mode where every Zen model is sent to /chat/completions.
 */

export const OPENCODE_ZEN_API_BASE_URL = 'https://opencode.ai/zen/v1'
export const OPENCODE_ZEN_DEFAULT_MODEL = 'claude-opus-4-8'

export type ModelDefinitionConfig = {
  id: string
  name: string
  api: 'openai-responses' | 'anthropic-messages' | 'google-generative-ai' | 'openai-completions'
  reasoning: boolean
  input: ('text' | 'image')[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
}

// Cache for fetched models (1 hour TTL)
let cachedModels: ModelDefinitionConfig[] | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Model aliases for convenient shortcuts.
 * Users can use "opus" instead of "claude-opus-4-8", etc.
 */
export const OPENCODE_ZEN_MODEL_ALIASES: Record<string, string> = {
  // Claude
  opus: 'claude-opus-4-8',
  'opus-4.8': 'claude-opus-4-8',
  'opus-4.7': 'claude-opus-4-7',
  'opus-4.6': 'claude-opus-4-6',
  'opus-4.5': 'claude-opus-4-5',
  sonnet: 'claude-sonnet-4-6',
  'sonnet-4.6': 'claude-sonnet-4-6',
  'sonnet-4.5': 'claude-sonnet-4-5',
  haiku: 'claude-haiku-4-5',
  'haiku-4.5': 'claude-haiku-4-5',

  // GPT family
  gpt5: 'gpt-5.5',
  'gpt-5': 'gpt-5.5',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.3': 'gpt-5.3-codex',
  'gpt-5.2': 'gpt-5.2',
  'gpt-5.1': 'gpt-5.1',
  gpt4: 'gpt-5.4-mini',
  'gpt-4': 'gpt-5.4-mini',
  'gpt-mini': 'gpt-5.4-mini',
  o1: 'gpt-5.5',
  o3: 'gpt-5.5',
  codex: 'gpt-5.3-codex',
  'codex-spark': 'gpt-5.3-codex-spark',
  'codex-mini': 'gpt-5.1-codex-mini',

  // Gemini
  gemini: 'gemini-3.1-pro',
  'gemini-pro': 'gemini-3.1-pro',
  'gemini-3.1': 'gemini-3.1-pro',
  'gemini-3': 'gemini-3-flash',
  flash: 'gemini-3-flash',
  'gemini-flash': 'gemini-3-flash',

  // Other Zen families
  qwen: 'qwen3.7-plus',
  deepseek: 'deepseek-v4-pro',
  minimax: 'minimax-m2.7',
  glm: 'glm-5.1',
  kimi: 'kimi-k2.6',
  grok: 'grok-build-0.1',
  free: 'big-pickle'
}

const stripOpencodeProviderPrefix = (modelId: string): string =>
  modelId.trim().replace(/^opencode\//i, '')

/**
 * Resolve a model alias to its full model ID.
 */
export function resolveOpencodeZenAlias(modelIdOrAlias: string): string {
  const withoutProviderPrefix = stripOpencodeProviderPrefix(modelIdOrAlias)
  const normalized = withoutProviderPrefix.toLowerCase().trim()
  return OPENCODE_ZEN_MODEL_ALIASES[normalized] ?? withoutProviderPrefix
}

const OPENCODE_ZEN_OPENAI_RESPONSES_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-nano'
])

const OPENCODE_ZEN_ANTHROPIC_MESSAGES_MODELS = new Set([
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
  'claude-3-5-haiku',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.6-plus-free',
  'qwen3.5-plus'
])

const OPENCODE_ZEN_GEMINI_MODELS = new Set(['gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-3-flash'])

const OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'minimax-m2.7',
  'minimax-m2.5',
  'minimax-m3-free',
  'glm-5.1',
  'glm-5',
  'kimi-k2.5',
  'kimi-k2.6',
  'grok-build-0.1',
  'big-pickle',
  'mimo-v2.5-free',
  'north-mini-code-free',
  'nemotron-3-ultra-free',
  'deepseek-v4-flash-free'
])

/**
 * OpenCode Zen routes models to specific API shapes by family.
 */
export function resolveOpencodeZenModelApi(modelId: string): ModelDefinitionConfig['api'] {
  const lower = resolveOpencodeZenAlias(modelId).toLowerCase()
  if (OPENCODE_ZEN_OPENAI_RESPONSES_MODELS.has(lower) || lower.startsWith('gpt-')) {
    return 'openai-responses'
  }
  if (
    OPENCODE_ZEN_ANTHROPIC_MESSAGES_MODELS.has(lower) ||
    lower.startsWith('claude-') ||
    lower.startsWith('qwen3.')
  ) {
    return 'anthropic-messages'
  }
  if (OPENCODE_ZEN_GEMINI_MODELS.has(lower) || lower.startsWith('gemini-')) {
    return 'google-generative-ai'
  }
  if (OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS.has(lower)) {
    return 'openai-completions'
  }
  return 'openai-completions'
}

function supportsImageInput(modelId: string): boolean {
  const lower = resolveOpencodeZenAlias(modelId).toLowerCase()
  if (lower.startsWith('gpt-') || lower.startsWith('claude-') || lower.startsWith('gemini-')) {
    return true
  }
  return false
}

const MODEL_COSTS: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  'gpt-5.1': { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gemini-3.1-pro': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  'gemini-3-flash': { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  'qwen3.7-max': { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
  'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
  'qwen3.6-plus': { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
  'qwen3.5-plus': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  'deepseek-v4-pro': { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  'minimax-m2.7': { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
  'minimax-m2.5': { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
  'glm-5.1': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  'glm-5': { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  'kimi-k2.5': { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  'kimi-k2.6': { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 }
}

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.5': 272000,
  'gpt-5.4': 272000,
  'gpt-5.3-codex': 400000,
  'gpt-5.2': 400000,
  'gpt-5.1': 400000,
  'claude-opus-4-8': 1000000,
  'claude-opus-4-7': 1000000,
  'claude-opus-4-6': 1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-haiku-4-5': 200000,
  'gemini-3.1-pro': 1048576,
  'gemini-3-flash': 1048576,
  'qwen3.7-max': 1000000,
  'qwen3.7-plus': 1000000,
  'qwen3.6-plus': 1000000,
  'qwen3.5-plus': 1000000,
  'deepseek-v4-pro': 128000,
  'minimax-m2.7': 204800,
  'glm-5.1': 204800,
  'kimi-k2.6': 262144
}

function getDefaultContextWindow(modelId: string): number {
  return MODEL_CONTEXT_WINDOWS[modelId] ?? 128000
}

const MODEL_MAX_TOKENS: Record<string, number> = {
  'gpt-5.5': 128000,
  'gpt-5.4': 128000,
  'gpt-5.3-codex': 128000,
  'gpt-5.2': 128000,
  'gpt-5.1': 128000,
  'claude-opus-4-8': 128000,
  'claude-opus-4-7': 128000,
  'claude-opus-4-6': 128000,
  'claude-sonnet-4-6': 64000,
  'claude-haiku-4-5': 64000,
  'gemini-3.1-pro': 65536,
  'gemini-3-flash': 65536,
  'qwen3.7-max': 32768,
  'qwen3.7-plus': 32768,
  'qwen3.6-plus': 32768,
  'qwen3.5-plus': 32768,
  'glm-5.1': 131072,
  'kimi-k2.6': 32768
}

function getDefaultMaxTokens(modelId: string): number {
  return MODEL_MAX_TOKENS[modelId] ?? 8192
}

const MODEL_NAMES: Record<string, string> = {
  'gpt-5.5': 'GPT 5.5',
  'gpt-5.4': 'GPT 5.4',
  'gpt-5.3-codex': 'GPT 5.3 Codex',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'gemini-3.1-pro': 'Gemini 3.1 Pro',
  'gemini-3-flash': 'Gemini 3 Flash',
  'qwen3.7-max': 'Qwen3.7 Max',
  'qwen3.7-plus': 'Qwen3.7 Plus',
  'qwen3.6-plus': 'Qwen3.6 Plus',
  'qwen3.6-plus-free': 'Qwen3.6 Plus Free',
  'qwen3.5-plus': 'Qwen3.5 Plus',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'minimax-m2.7': 'MiniMax M2.7',
  'minimax-m2.5': 'MiniMax M2.5',
  'minimax-m3-free': 'MiniMax M3 Free',
  'glm-5.1': 'GLM 5.1',
  'kimi-k2.6': 'Kimi K2.6'
}

function formatModelName(modelId: string): string {
  if (MODEL_NAMES[modelId]) {
    return MODEL_NAMES[modelId]
  }
  return modelId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function buildModelDefinition(modelId: string): ModelDefinitionConfig {
  const resolvedModelId = resolveOpencodeZenAlias(modelId)
  return {
    id: resolvedModelId,
    name: formatModelName(resolvedModelId),
    api: resolveOpencodeZenModelApi(resolvedModelId),
    reasoning: true,
    input: supportsImageInput(resolvedModelId) ? ['text', 'image'] : ['text'],
    cost: MODEL_COSTS[resolvedModelId] ?? DEFAULT_COST,
    contextWindow: getDefaultContextWindow(resolvedModelId),
    maxTokens: getDefaultMaxTokens(resolvedModelId)
  }
}

export function getOpencodeZenStaticFallbackModels(): ModelDefinitionConfig[] {
  const modelIds = [
    ...OPENCODE_ZEN_OPENAI_RESPONSES_MODELS,
    ...OPENCODE_ZEN_ANTHROPIC_MESSAGES_MODELS,
    ...OPENCODE_ZEN_GEMINI_MODELS,
    ...OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS
  ]
  return modelIds.map(buildModelDefinition)
}

interface ZenModelsResponse {
  data: Array<{ id: string; object: 'model' }>
}

export async function fetchOpencodeZenModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  const now = Date.now()
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels
  }
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }
    const response = await fetch(`${OPENCODE_ZEN_API_BASE_URL}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`)
    }
    const data = (await response.json()) as ZenModelsResponse
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid response format from /models endpoint')
    }
    const models = data.data.map((model) => buildModelDefinition(model.id))
    cachedModels = models
    cacheTimestamp = now
    return models
  } catch (error) {
    console.warn(`[opencode-zen] Failed to fetch models, using static fallback: ${String(error)}`)
    return getOpencodeZenStaticFallbackModels()
  }
}
