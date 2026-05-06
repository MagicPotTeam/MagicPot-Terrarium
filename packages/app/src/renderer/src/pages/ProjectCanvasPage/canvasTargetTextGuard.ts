const DEFAULT_CANVAS_TARGET_RESPONSE_PREVIEW_CHARS = 60_000
const DEFAULT_CANVAS_TARGET_ERROR_PREVIEW_CHARS = 12_000
const DEFAULT_CANVAS_TARGET_GARBAGE_DETECTION_MIN_CHARS = 60_000
const DEFAULT_CANVAS_TARGET_EMERGENCY_RESPONSE_CHARS = 4_000_000
const DEFAULT_CANVAS_TARGET_GARBAGE_SAMPLE_CHARS = 120_000

type CanvasTargetTextKind = 'response' | 'error'

type GuardCanvasTargetTextOptions = {
  kind?: CanvasTargetTextKind
  maxLength?: number
  emergencyLength?: number
}

function countRegexMatches(value: string, regex: RegExp): number {
  let count = 0
  let match: RegExpExecArray | null = null
  const workingRegex = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
  )
  while ((match = workingRegex.exec(value)) !== null) {
    count += 1
  }
  return count
}

function getLongestRepeatedCharacterRun(value: string): number {
  let longest = 0
  let current = 0
  let previous = ''

  for (const char of value) {
    if (char === previous) {
      current += 1
    } else {
      previous = char
      current = 1
    }
    if (current > longest) {
      longest = current
    }
  }

  return longest
}

function findSuspiciousLongToken(value: string): string | null {
  let longest = ''
  let current = ''

  for (const char of value) {
    if (/\s/.test(char)) {
      if (current.length > longest.length) {
        longest = current
      }
      current = ''
      continue
    }
    current += char
  }

  if (current.length > longest.length) {
    longest = current
  }

  if (longest.length < 24_000) {
    return null
  }

  return /^[A-Za-z0-9+/=_-]+$/.test(longest) ? longest : null
}

function getRepeatedLineStats(value: string): {
  totalLines: number
  repeatedLines: number
  uniqueRatio: number
  topLineRepeatCount: number
} {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return {
      totalLines: 0,
      repeatedLines: 0,
      uniqueRatio: 1,
      topLineRepeatCount: 0
    }
  }

  const counts = new Map<string, number>()
  for (const line of lines) {
    counts.set(line, (counts.get(line) || 0) + 1)
  }

  let repeatedLines = 0
  let topLineRepeatCount = 0
  counts.forEach((count) => {
    if (count > 1) {
      repeatedLines += count
    }
    if (count > topLineRepeatCount) {
      topLineRepeatCount = count
    }
  })

  return {
    totalLines: lines.length,
    repeatedLines,
    uniqueRatio: counts.size / lines.length,
    topLineRepeatCount
  }
}

function buildCanvasTargetTruncationNotice(
  normalized: string,
  maxLength: number,
  kind: CanvasTargetTextKind,
  reason: string
): string {
  const kindLabel = kind === 'error' ? 'error output' : 'model output'
  return [
    normalized.slice(0, maxLength),
    '',
    `[MagicPot truncated ${normalized.length - maxLength} extra characters from this ${kindLabel} ${reason} to keep the canvas check UI responsive.]`
  ].join('\n')
}

export function looksLikeCanvasTargetGarbageText(value: string | undefined): boolean {
  const normalized = value?.trim()
  if (!normalized || normalized.length < DEFAULT_CANVAS_TARGET_GARBAGE_DETECTION_MIN_CHARS) {
    return false
  }

  const sample = normalized.slice(0, DEFAULT_CANVAS_TARGET_GARBAGE_SAMPLE_CHARS)
  const longestRepeatedCharacterRun = getLongestRepeatedCharacterRun(sample)
  if (longestRepeatedCharacterRun >= 4096) {
    return true
  }

  const suspiciousLongToken = findSuspiciousLongToken(sample)
  if (suspiciousLongToken) {
    return true
  }

  const repeatedLineStats = getRepeatedLineStats(sample)
  if (
    repeatedLineStats.totalLines >= 80 &&
    repeatedLineStats.uniqueRatio <= 0.35 &&
    repeatedLineStats.topLineRepeatCount >= 12
  ) {
    return true
  }

  const suspiciousErrorMarkerCount = countRegexMatches(
    sample,
    /\b(error|exception|traceback|stack trace|bad request|request failed|api error)\b|{"error"|错误|报错/gi
  )
  if (
    suspiciousErrorMarkerCount >= 18 &&
    repeatedLineStats.repeatedLines >= 20 &&
    repeatedLineStats.uniqueRatio <= 0.6
  ) {
    return true
  }

  return false
}

export function guardCanvasTargetTextForUi(
  value: string | undefined,
  options?: GuardCanvasTargetTextOptions
): string | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined

  const kind = options?.kind ?? 'response'
  const maxLength =
    options?.maxLength ??
    (kind === 'error'
      ? DEFAULT_CANVAS_TARGET_ERROR_PREVIEW_CHARS
      : DEFAULT_CANVAS_TARGET_RESPONSE_PREVIEW_CHARS)

  if (kind === 'error') {
    if (normalized.length <= maxLength) {
      return normalized
    }
    const reason = looksLikeCanvasTargetGarbageText(normalized)
      ? 'because it looks like repeated garbage or error text,'
      : 'because the error payload is unexpectedly large,'
    return buildCanvasTargetTruncationNotice(normalized, maxLength, kind, reason)
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  const emergencyLength = options?.emergencyLength ?? DEFAULT_CANVAS_TARGET_EMERGENCY_RESPONSE_CHARS
  if (normalized.length > emergencyLength) {
    return buildCanvasTargetTruncationNotice(
      normalized,
      maxLength,
      kind,
      'because it exceeded the emergency safe-render limit,'
    )
  }

  if (looksLikeCanvasTargetGarbageText(normalized)) {
    return buildCanvasTargetTruncationNotice(
      normalized,
      maxLength,
      kind,
      'because it looks like repeated garbage or error text,'
    )
  }

  return normalized
}
