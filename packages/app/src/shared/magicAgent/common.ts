export type MagicAgentPrimitive = string | number | boolean | null
export type MagicAgentJsonValue =
  | MagicAgentPrimitive
  | MagicAgentJsonValue[]
  | { [key: string]: MagicAgentJsonValue }

export type MagicAgentJsonObject = Record<string, MagicAgentJsonValue>
export type MagicAgentRecord = Record<string, unknown>

export type MagicAgentJsonSchema = MagicAgentRecord

export type MagicAgentValidationSeverity = 'error' | 'warning'

export type MagicAgentValidationIssue = {
  path: string
  message: string
  severity: MagicAgentValidationSeverity
}

export type MagicAgentValidationResult<T> =
  | {
      ok: true
      value: T
      issues: MagicAgentValidationIssue[]
    }
  | {
      ok: false
      issues: MagicAgentValidationIssue[]
    }

export type MagicAgentValidationOptions = {
  partial?: boolean
}

export type MagicAgentNormalizedEntity = {
  id: string
  title: string
  description?: string
  version?: string
  metadata?: MagicAgentRecord
}

export const MAGIC_AGENT_CONTRACT_VERSION = 1
export const MAGIC_AGENT_DEFAULT_VERSION = '1.0.0'

export const isPlainRecord = (value: unknown): value is MagicAgentRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const normalizeMagicAgentText = (value: unknown): string => String(value ?? '').trim()

export const normalizeMagicAgentOptionalText = (value: unknown): string | undefined => {
  const normalized = normalizeMagicAgentText(value)
  return normalized || undefined
}

export const normalizeMagicAgentId = (value: unknown, fallback = 'unknown'): string => {
  const normalized = normalizeMagicAgentText(value)
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._:/-]/g, '')
    .replace(/-{2,}/g, '-')
  return normalized || fallback
}

export const normalizeMagicAgentVersion = (value: unknown): string =>
  normalizeMagicAgentOptionalText(value) || MAGIC_AGENT_DEFAULT_VERSION

export const normalizeMagicAgentTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return [
    ...new Set(
      value
        .map((item) => normalizeMagicAgentOptionalText(item))
        .filter((item): item is string => Boolean(item))
    )
  ]
}

export const normalizeMagicAgentRecord = (value: unknown): MagicAgentRecord | undefined =>
  isPlainRecord(value) ? { ...value } : undefined

export const normalizeMagicAgentSchema = (value: unknown): MagicAgentJsonSchema | undefined =>
  normalizeMagicAgentRecord(value)

export const normalizeMagicAgentStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => normalizeMagicAgentOptionalText(item))
    .filter((item): item is string => Boolean(item))
}

export const normalizeMagicAgentUniqueStringArray = (value: unknown): string[] => [
  ...new Set(normalizeMagicAgentStringArray(value))
]

export const normalizeMagicAgentNumber = (
  value: unknown,
  fallback: number,
  options?: { min?: number; max?: number; integer?: boolean }
): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  const normalized = options?.integer ? Math.trunc(parsed) : parsed
  const min = Number.isFinite(options?.min) ? Number(options?.min) : undefined
  const max = Number.isFinite(options?.max) ? Number(options?.max) : undefined
  return Math.min(max ?? normalized, Math.max(min ?? normalized, normalized))
}

export const normalizeMagicAgentBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback

export const makeMagicAgentIssue = (
  path: string,
  message: string,
  severity: MagicAgentValidationSeverity = 'error'
): MagicAgentValidationIssue => ({ path, message, severity })

export const createMagicAgentValidationSuccess = <T>(
  value: T,
  issues: MagicAgentValidationIssue[] = []
): MagicAgentValidationResult<T> => ({ ok: true, value, issues })

export const createMagicAgentValidationFailure = <T = never>(
  issues: MagicAgentValidationIssue[]
): MagicAgentValidationResult<T> => ({ ok: false, issues })

export const createMagicAgentRequiredIssue = (
  path: string,
  label?: string
): MagicAgentValidationIssue =>
  makeMagicAgentIssue(path, `${label || path || 'value'} is required.`)

export const appendMagicAgentIssues = <T>(
  result: MagicAgentValidationResult<T>,
  issues: MagicAgentValidationIssue[]
): MagicAgentValidationResult<T> =>
  result.ok
    ? createMagicAgentValidationSuccess(result.value, [...result.issues, ...issues])
    : createMagicAgentValidationFailure([...result.issues, ...issues])

export const requiredMagicAgentText = (
  value: unknown,
  path: string,
  label?: string
): string | null => normalizeMagicAgentOptionalText(value) || null

export const validateMagicAgentRequiredText = (
  value: unknown,
  path: string,
  issues: MagicAgentValidationIssue[],
  label?: string
): string => {
  const normalized = requiredMagicAgentText(value, path, label)
  if (!normalized) {
    issues.push(createMagicAgentRequiredIssue(path, label))
    return ''
  }
  return normalized
}

export const validateMagicAgentRecord = (
  value: unknown,
  path: string,
  issues: MagicAgentValidationIssue[],
  label?: string
): MagicAgentRecord => {
  if (isPlainRecord(value)) {
    return value
  }

  issues.push(makeMagicAgentIssue(path, `${label || path || 'value'} must be an object.`))
  return {}
}

export const validateMagicAgentArray = <T>(
  value: unknown,
  path: string,
  issues: MagicAgentValidationIssue[],
  normalizeItem: (item: unknown, index: number, issues: MagicAgentValidationIssue[]) => T | null,
  options?: { required?: boolean; label?: string }
): T[] => {
  if (value == null) {
    if (options?.required) {
      issues.push(createMagicAgentRequiredIssue(path, options.label))
    }
    return []
  }

  if (!Array.isArray(value)) {
    issues.push(makeMagicAgentIssue(path, `${options?.label || path || 'value'} must be an array.`))
    return []
  }

  return value
    .map((item, index) => normalizeItem(item, index, issues))
    .filter((item): item is T => item !== null)
}

export const createMagicAgentValidationResult = <T>(
  value: T,
  issues: MagicAgentValidationIssue[]
): MagicAgentValidationResult<T> =>
  issues.some((issue) => issue.severity === 'error')
    ? createMagicAgentValidationFailure(issues)
    : createMagicAgentValidationSuccess(value, issues)
