import type { OCRResult } from '@shared/api/svcLLMProxy'
import type { TargetScheme } from '@shared/targetScheme'

import { extractMimeTypeFromSourceUrl } from './canvasImageMetadata'
import { guardCanvasTargetTextForUi } from './canvasTargetTextGuard'
import { createTimestampedSecureId } from './secureId'

const DEFAULT_CANVAS_TARGET_TASK =
  'Work on the selected MagicPot canvas region against the provided local target scheme and user intent. Coordinate the candidate models as needed, keep outputs grounded in the canvas context, and avoid destructive or auto-fix actions unless the user explicitly requests them.'

export function createCanvasTargetId(prefix: string): string {
  return createTimestampedSecureId(prefix)
}

function stripCodeFences(value: string): string {
  return value
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
}

function extractFirstJsonObjectText(value: string): string | null {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }

    if (char !== '}') continue
    if (depth === 0) continue
    depth -= 1
    if (depth === 0 && start >= 0) {
      return value.slice(start, index + 1)
    }
  }

  return null
}

export function parseJsonObjectFromPossiblyWrappedText<T>(value: string): T {
  const stripped = stripCodeFences(value)
  try {
    return JSON.parse(stripped) as T
  } catch (directParseError) {
    const objectText = extractFirstJsonObjectText(stripped)
    if (!objectText) {
      throw directParseError
    }
    return JSON.parse(objectText) as T
  }
}

export function truncateText(value: string | undefined, maxLength = 400): string | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

export function sanitizeCanvasTargetOcrResult(
  ocrResult: OCRResult | undefined
): OCRResult | undefined {
  if (!ocrResult?.text) {
    return ocrResult
  }

  const guardedText = guardCanvasTargetTextForUi(ocrResult.text, {
    kind: 'response'
  })
  if (!guardedText || guardedText === ocrResult.text) {
    return ocrResult
  }

  return {
    ...ocrResult,
    text: guardedText
  }
}

function formatPromptByteSize(sizeBytes?: number): string | undefined {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return undefined
  }
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${Math.round((sizeBytes / 1024) * 10) / 10} KB`
  return `${Math.round((sizeBytes / (1024 * 1024)) * 10) / 10} MB`
}

export function summarizeSourceForPrompt(options: {
  sourceUrl?: string
  fileName?: string
  mimeType?: string
  sizeBytes?: number
}): string | undefined {
  const normalizedSourceUrl = options.sourceUrl?.trim()
  if (!normalizedSourceUrl) return undefined

  const resourceKind = inferResourceKind(normalizedSourceUrl) || 'resource'
  const resolvedFileName =
    normalizeNonEmptyString(options.fileName) ??
    normalizeNonEmptyString(extractFileNameFromSourceUrl(normalizedSourceUrl))
  const resolvedMimeType =
    normalizeNonEmptyString(options.mimeType) ??
    normalizeNonEmptyString(extractMimeTypeFromSourceUrl(normalizedSourceUrl))
  const parts = [
    `kind=${resourceKind}`,
    resolvedFileName ? `name=${resolvedFileName}` : null,
    resolvedMimeType ? `mime=${resolvedMimeType}` : null,
    formatPromptByteSize(options.sizeBytes)
      ? `size=${formatPromptByteSize(options.sizeBytes)}`
      : null
  ].filter(Boolean)

  return `source(${parts.join(', ')})`
}

export function sanitizePromptValue(
  value: unknown,
  options?: {
    maxStringLength?: number
    maxArrayLength?: number
    maxObjectEntries?: number
  }
): unknown {
  const maxStringLength = options?.maxStringLength ?? 280
  const maxArrayLength = options?.maxArrayLength ?? 16
  const maxObjectEntries = options?.maxObjectEntries ?? 24

  if (typeof value === 'string') {
    if (value.startsWith('data:') || value.startsWith('blob:')) {
      return summarizeSourceForPrompt({ sourceUrl: value }) || truncateText(value, maxStringLength)
    }
    return truncateText(value, maxStringLength)
  }

  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, maxArrayLength)
      .map((entry) => sanitizePromptValue(entry, options))
    if (value.length > maxArrayLength) {
      sanitized.push(`[+${value.length - maxArrayLength} more entries]`)
    }
    return sanitized
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const sanitizedEntries = entries
      .slice(0, maxObjectEntries)
      .map(([key, entryValue]) => [key, sanitizePromptValue(entryValue, options)] as const)

    if (entries.length > maxObjectEntries) {
      sanitizedEntries.push(['__truncatedEntryCount', entries.length - maxObjectEntries] as const)
    }

    return Object.fromEntries(sanitizedEntries)
  }

  return value
}

export function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function buildAspectRatio(width: unknown, height: unknown): number | null {
  const normalizedWidth = normalizeFiniteNumber(width)
  const normalizedHeight = normalizeFiniteNumber(height)
  if (
    normalizedWidth == null ||
    normalizedHeight == null ||
    normalizedWidth <= 0 ||
    normalizedHeight <= 0
  ) {
    return null
  }
  return Math.round((normalizedWidth / normalizedHeight) * 1000) / 1000
}

export function extractFileNameFromSourceUrl(sourceUrl?: string): string | undefined {
  if (!sourceUrl) return undefined
  if (sourceUrl.startsWith('data:') || sourceUrl.startsWith('blob:')) return undefined

  try {
    const parsed = new URL(sourceUrl)
    const fileName = parsed.pathname.split('/').pop()?.trim()
    return fileName || undefined
  } catch {
    const fileName = sourceUrl.split(/[\\/]/).pop()?.trim()
    return fileName || undefined
  }
}

export function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export function inferResourceKind(sourceUrl?: string): string | null {
  const normalized = sourceUrl?.trim()
  if (!normalized) return null
  if (normalized.startsWith('data:')) return 'data-url'
  if (normalized.startsWith('blob:')) return 'blob-url'
  if (/^https?:\/\//i.test(normalized)) return 'remote-url'
  if (
    /^[a-zA-Z]:[\\/]/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('/')
  ) {
    return 'local-path'
  }
  if (normalized.startsWith('./') || normalized.startsWith('../')) return 'relative-path'
  return 'unknown'
}

export function buildCanvasTargetTask(scheme: TargetScheme): string {
  const schemeDescription = scheme.description.trim()
  const schemeHint = schemeDescription ? ` Scheme focus: ${schemeDescription}` : ''
  return `${DEFAULT_CANVAS_TARGET_TASK}${schemeHint}`
}
