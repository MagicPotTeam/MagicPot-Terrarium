/**
 * OpenCode Zen model catalog with dynamic fetching, caching, and static fallback.
 * Adapted for AIEngineElectron.
 */

export const OPENCODE_ZEN_API_BASE_URL = 'https://opencode.ai/zen/v1'
export const OPENCODE_ZEN_DEFAULT_MODEL = 'claude-opus-4-6'

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
 * Users can use "opus" instead of "claude-opus-4-6", etc.
 */
export const OPENCODE_ZEN_MODEL_ALIASES: Record<string, string> = {
  // Claude
  opus: 'claude-opus-4-6',
  'opus-4.6': 'claude-opus-4-6',
  'opus-4.5': 'claude-opus-4-5',
  'opus-4': 'claude-opus-4-6',
  sonnet: 'claude-opus-4-6',
  'sonnet-4': 'claude-opus-4-6',
  haiku: 'claude-opus-4-6',
  'haiku-3.5': 'claude-opus-4-6',

  // GPT-5.x family
  gpt5: 'gpt-5.2',
  'gpt-5': 'gpt-5.2',
  'gpt-5.1': 'gpt-5.1',

  // Legacy GPT aliases
  gpt4: 'gpt-5.1',
  'gpt-4': 'gpt-5.1',
  'gpt-mini': 'gpt-5.1',
  o1: 'gpt-5.2',
  o3: 'gpt-5.2',
  'o3-mini': 'gpt-5.1',

  // Gemini
  gemini: 'gemini-3-pro',
  'gemini-pro': 'gemini-3-pro',
  'gemini-3': 'gemini-3-pro',
  flash: 'gemini-3-flash',
  'gemini-flash': 'gemini-3-flash',
  'gemini-2.5': 'gemini-3-pro',
  'gemini-2.5-pro': 'gemini-3-pro',
  'gemini-2.5-flash': 'gemini-3-flash',

  // GLM
  glm: 'glm-4.7',
  'glm-free': 'glm-4.7'
}

/**
 * Resolve a model alias to its full model ID.
 */
export function resolveOpencodeZenAlias(modelIdOrAlias: string): string {
  const normalized = modelIdOrAlias.toLowerCase().trim()
  return OPENCODE_ZEN_MODEL_ALIASES[normalized] ?? modelIdOrAlias
}

/**
 * OpenCode Zen routes models to specific API shapes by family.
 */
export function resolveOpencodeZenModelApi(modelId: string): ModelDefinitionConfig['api'] {
  const lower = modelId.toLowerCase()
  if (lower.startsWith('gpt-')) {
    return 'openai-responses'
  }
  if (lower.startsWith('claude-') || lower.startsWith('minimax-')) {
    return 'anthropic-messages'
  }
  if (lower.startsWith('gemini-')) {
    return 'google-generative-ai'
  }
  return 'openai-completions'
}

function supportsImageInput(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  if (lower.includes('glm') || lower.includes('minimax')) {
    return false
  }
  return true
}

const MODEL_COSTS: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'gemini-3-pro': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  'gpt-5.1': { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  'glm-4.7': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'gemini-3-flash': { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 }
}

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 1000000,
  'claude-opus-4-5': 200000,
  'gemini-3-pro': 1048576,
  'gpt-5.1': 400000,
  'glm-4.7': 204800,
  'gemini-3-flash': 1048576,
  'gpt-5.2': 400000
}

function getDefaultContextWindow(modelId: string): number {
  return MODEL_CONTEXT_WINDOWS[modelId] ?? 128000
}

const MODEL_MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-6': 128000,
  'claude-opus-4-5': 64000,
  'gemini-3-pro': 65536,
  'gpt-5.1': 128000,
  'glm-4.7': 131072,
  'gemini-3-flash': 65536,
  'gpt-5.2': 128000
}

function getDefaultMaxTokens(modelId: string): number {
  return MODEL_MAX_TOKENS[modelId] ?? 8192
}

const MODEL_NAMES: Record<string, string> = {
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-opus-4-5': 'Claude Opus 4.5',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.1': 'GPT-5.1',
  'glm-4.7': 'GLM-4.7',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gpt-5.2': 'GPT-5.2'
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
  return {
    id: modelId,
    name: formatModelName(modelId),
    api: resolveOpencodeZenModelApi(modelId),
    reasoning: true,
    input: supportsImageInput(modelId) ? ['text', 'image'] : ['text'],
    cost: MODEL_COSTS[modelId] ?? DEFAULT_COST,
    contextWindow: getDefaultContextWindow(modelId),
    maxTokens: getDefaultMaxTokens(modelId)
  }
}

export function getOpencodeZenStaticFallbackModels(): ModelDefinitionConfig[] {
  const modelIds = [
    'claude-opus-4-6',
    'claude-opus-4-5',
    'gemini-3-pro',
    'gpt-5.1',
    'glm-4.7',
    'gemini-3-flash',
    'gpt-5.2'
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
