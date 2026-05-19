import type { LLMDeployment, LLMModelUse, LLMProvider } from '@shared/config/config'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'

export type ModelCatalogOption = {
  label: string
  value: string
}

const OPENAI_MODEL_NAMES = [
  'gpt-5.5',
  'gpt-5.4-pro',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-4o',
  'gpt-4o-mini'
] as const

const CLAUDE_MODEL_NAMES = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const

const GEMINI_MODEL_NAMES = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash'
] as const

const OLLAMA_CHAT_MODEL_NAMES = [
  'llama3.2',
  'qwen2.5:14b',
  'deepseek-r1:14b',
  'gemma3:12b'
] as const

const OLLAMA_VISION_MODEL_NAMES = [
  'qwen2.5vl:7b',
  'llava:13b',
  'minicpm-v:8b',
  'internvl3:8b'
] as const

const normalizeCatalogValue = (value: string): string => value.trim()

const toOption = (
  value: string | ModelCatalogOption | null | undefined
): ModelCatalogOption | null => {
  if (typeof value === 'string') {
    const normalizedValue = normalizeCatalogValue(value)
    return normalizedValue ? { label: normalizedValue, value: normalizedValue } : null
  }

  if (!value) {
    return null
  }

  const normalizedValue = normalizeCatalogValue(value.value)
  if (!normalizedValue) {
    return null
  }

  const normalizedLabel = normalizeCatalogValue(value.label)
  return {
    label: normalizedLabel || normalizedValue,
    value: normalizedValue
  }
}

const toOptions = (
  values: readonly (string | ModelCatalogOption | null | undefined)[]
): ModelCatalogOption[] =>
  values
    .map((value) => toOption(value))
    .filter((option): option is ModelCatalogOption => Boolean(option))

const dedupeOptions = (options: ModelCatalogOption[]): ModelCatalogOption[] => {
  const seen = new Set<string>()
  return options.filter((option) => {
    const key = option.value.toLowerCase()
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

export function getSuggestedModelCatalog(options: {
  authMode?: string
  deployment: LLMDeployment
  modelUse: LLMModelUse
  provider: LLMProvider
  codexCurrentModelName?: string | null
  codexDiscoveredModelNames?: readonly (string | ModelCatalogOption | null | undefined)[]
  codexObservedModelNames?: readonly (string | ModelCatalogOption | null | undefined)[]
}): ModelCatalogOption[] {
  for (const extension of sharedHostExtensionApiV1.llmProfiles) {
    const catalog = extension.buildModelCatalog?.({
      authMode: options.authMode,
      deployment: options.deployment,
      modelUse: options.modelUse,
      provider: options.provider,
      currentModelName: options.codexCurrentModelName,
      discoveredModelNames: options.codexDiscoveredModelNames,
      observedModelNames: options.codexObservedModelNames
    })
    if (catalog) {
      return catalog
    }
  }

  if (options.provider === 'openai') {
    return toOptions(OPENAI_MODEL_NAMES)
  }

  if (options.provider === 'claude') {
    return toOptions(CLAUDE_MODEL_NAMES)
  }

  if (options.provider === 'gemini') {
    return toOptions(GEMINI_MODEL_NAMES)
  }

  if (options.provider === 'ollama') {
    const ollamaOptions =
      options.modelUse === 'agent' ||
      options.modelUse === 'multimodal' ||
      options.modelUse === 'vision' ||
      options.modelUse === 'ocr'
        ? [...OLLAMA_VISION_MODEL_NAMES, ...OLLAMA_CHAT_MODEL_NAMES]
        : OLLAMA_CHAT_MODEL_NAMES
    return dedupeOptions(toOptions(ollamaOptions))
  }

  if (options.deployment === 'local') {
    return toOptions(OLLAMA_CHAT_MODEL_NAMES)
  }

  return []
}
