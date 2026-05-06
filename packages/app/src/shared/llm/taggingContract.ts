import type { OCRResult } from '@shared/api/svcLLMProxy'

export type NormalizedTaggingProviderFamily = 'tagger' | 'ocr' | 'vlm' | 'caption'

export type NormalizedTaggingProviderMetadata = {
  profileId?: string
  modelName?: string
  providerId?: string
  family?: NormalizedTaggingProviderFamily
}

export type NormalizedTaggingResult = {
  fileName?: string
  canvasItemId?: string
  tags: string[]
  tagsText: string
  caption: string
  score?: number
  warnings?: string[]
  provider?: NormalizedTaggingProviderMetadata
  ocrResult?: OCRResult
  raw?: Record<string, unknown>
}

type JsonRecord = Record<string, unknown>

const normalizeText = (value: unknown): string => String(value ?? '').trim()

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const extractJsonCandidate = (text: string): string => {
  const trimmed = text.trim()
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  const objectStart = trimmed.indexOf('{')
  const objectEnd = trimmed.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1)
  }

  const arrayStart = trimmed.indexOf('[')
  const arrayEnd = trimmed.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return trimmed.slice(arrayStart, arrayEnd + 1)
  }

  return trimmed
}

const normalizeTags = (value: unknown): { tags: string[]; tagsText: string } => {
  if (Array.isArray(value)) {
    const tags = value.map((entry) => normalizeText(entry)).filter(Boolean)
    return { tags, tagsText: tags.join(', ') }
  }

  if (typeof value === 'string') {
    const tags = value
      .split(',')
      .map((entry) => normalizeText(entry))
      .filter(Boolean)
    return { tags, tagsText: tags.join(', ') }
  }

  return { tags: [], tagsText: '' }
}

const normalizeWarnings = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()]
  }
  return []
}

const normalizeScore = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

const normalizeProvider = (value: unknown): NormalizedTaggingProviderMetadata | undefined => {
  if (!isRecord(value)) return undefined

  const profileId = normalizeText(value.profileId) || undefined
  const modelName = normalizeText(value.modelName) || undefined
  const providerId = normalizeText(value.providerId) || undefined
  const familyText = normalizeText(value.family)
  const family = ['tagger', 'ocr', 'vlm', 'caption'].includes(familyText)
    ? (familyText as NormalizedTaggingProviderFamily)
    : undefined

  return profileId || modelName || providerId || family
    ? {
        profileId,
        modelName,
        providerId,
        family
      }
    : undefined
}

const normalizeOcrResult = (value: unknown): OCRResult | undefined =>
  isRecord(value) ? (value as OCRResult) : undefined

const normalizeResultEntry = (entry: unknown): NormalizedTaggingResult | null => {
  if (!isRecord(entry)) return null

  const normalizedTags = normalizeTags(entry.tags ?? entry.tagsText ?? entry.tagText)
  const tagsText = normalizeText(entry.tagsText) || normalizedTags.tagsText
  const caption =
    normalizeText(entry.caption) || normalizeText(entry.description) || normalizeText(entry.summary)
  const warnings = normalizeWarnings(entry.warnings ?? entry.issues)
  const ocrResult = normalizeOcrResult(entry.ocrResult)

  if (!normalizedTags.tags.length && !tagsText && !caption && warnings.length === 0 && !ocrResult) {
    return null
  }

  return {
    fileName: normalizeText(entry.fileName) || undefined,
    canvasItemId: normalizeText(entry.canvasItemId ?? entry.itemId) || undefined,
    tags: normalizedTags.tags,
    tagsText,
    caption,
    score: normalizeScore(entry.score),
    warnings,
    provider: normalizeProvider(entry.provider),
    ...(ocrResult ? { ocrResult } : {}),
    raw: entry
  }
}

export const parseNormalizedTaggingResponse = (
  responseText: string
): { results: NormalizedTaggingResult[]; raw: unknown } | null => {
  const jsonCandidate = extractJsonCandidate(responseText)
  if (!jsonCandidate) return null

  try {
    const parsed = JSON.parse(jsonCandidate) as unknown
    let rawResults: unknown[] | null = null

    if (Array.isArray(parsed)) {
      rawResults = parsed
    } else if (isRecord(parsed)) {
      rawResults = Array.isArray(parsed.results) ? parsed.results : [parsed]
    }

    if (!rawResults) {
      return null
    }

    const results = rawResults
      .map((entry) => normalizeResultEntry(entry))
      .filter((entry): entry is NormalizedTaggingResult => Boolean(entry))

    return results.length > 0 ? { results, raw: parsed } : null
  } catch {
    return null
  }
}

export const buildNormalizedTaggingSidecarText = (
  result: Pick<NormalizedTaggingResult, 'tagsText' | 'caption' | 'ocrResult'>
): string =>
  normalizeText(result.tagsText) ||
  normalizeText(result.caption) ||
  normalizeText(result.ocrResult?.text)
