import type { ModelCatalogOption } from '@shared/llm/modelCatalog'

export type { ModelCatalogOption }

export type CodexModelProfileSelection = {
  profileId: string
  modelName: string
}

// Model choices come from discovery or a saved selection, never a bundled model ID.
export const DEFAULT_CODEX_MODEL_NAME = ''
export const CODEX_MODEL_PROFILE_ID_MARKER = 'codex-model'

export const FALLBACK_CODEX_MODEL_NAMES: readonly string[] = []

export const SUPPORTED_CODEX_MODEL_NAMES = FALLBACK_CODEX_MODEL_NAMES

type BuildCodexModelCatalogOptions = {
  currentModelName?: string | null
  discoveredModelNames?: readonly (string | ModelCatalogOption | null | undefined)[]
  observedModelNames?: readonly (string | ModelCatalogOption | null | undefined)[]
  fallbackModelNames?: readonly string[]
}

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

  return {
    label: normalizeCatalogValue(value.label) || normalizedValue,
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
    const key = option.value
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

export function buildCodexModelCatalog(
  options: BuildCodexModelCatalogOptions = {}
): ModelCatalogOption[] {
  return dedupeOptions([
    ...toOptions(options.currentModelName ? [options.currentModelName] : []),
    ...toOptions(options.discoveredModelNames ?? []),
    ...toOptions(options.observedModelNames ?? []),
    ...toOptions(options.fallbackModelNames ?? FALLBACK_CODEX_MODEL_NAMES)
  ])
}

export function normalizeCodexModelName(modelName: string): string {
  return normalizeCatalogValue(modelName)
}

export function buildCodexModelProfileId(profileId: string, modelName: string): string {
  const normalizedProfileId = profileId.trim()
  const normalizedModelName = normalizeCodexModelName(modelName)
  if (!normalizedModelName) return normalizedProfileId
  return `${normalizedProfileId}::${CODEX_MODEL_PROFILE_ID_MARKER}::${encodeURIComponent(
    normalizedModelName
  )}`
}

export function parseCodexModelProfileId(
  profileId: string | null | undefined
): CodexModelProfileSelection | null {
  const segments = String(profileId || '').split('::')
  if (segments.length !== 3 || segments[1] !== CODEX_MODEL_PROFILE_ID_MARKER) {
    return null
  }

  const baseProfileId = segments[0]?.trim()
  const encodedModelName = segments[2]?.trim()
  if (!baseProfileId || !encodedModelName) {
    return null
  }

  let modelName = encodedModelName
  try {
    modelName = decodeURIComponent(encodedModelName)
  } catch {
    modelName = encodedModelName
  }

  const normalizedModelName = normalizeCodexModelName(modelName)
  if (!normalizedModelName) return null
  return {
    profileId: baseProfileId,
    modelName: normalizedModelName
  }
}
