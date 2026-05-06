const FILENAME_QUERY_KEYS = [
  'filename',
  'fileName',
  'file',
  'name',
  'download',
  'attname',
  'response-content-disposition',
  'content-disposition',
  'key',
  'object',
  'objectKey',
  'path'
]

const decodeSafely = (value: string): string => {
  let decoded = String(value || '').trim()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, '%20'))
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }

  return decoded
}

const stripWrappingQuotes = (value: string): string => value.replace(/^['"]+|['"]+$/g, '').trim()

const getLastPathSegment = (value: string): string => {
  const normalized = String(value || '')
    .split('#')[0]
    .split('?')[0]
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || normalized
}

const normalizeCandidateFileName = (value: string): string =>
  stripWrappingQuotes(getLastPathSegment(decodeSafely(value)))

const hasExplicitExtension = (value: string): boolean =>
  /\.[a-z0-9]{1,12}$/i.test(normalizeCandidateFileName(value))

export const getFileNameHintFromContentDisposition = (value: string): string => {
  const decoded = decodeSafely(value)

  const starMatch = decoded.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)
  if (starMatch?.[1]) {
    const candidate = normalizeCandidateFileName(starMatch[1])
    if (hasExplicitExtension(candidate)) {
      return candidate
    }
  }

  const plainMatch = decoded.match(/filename\s*=\s*([^;]+)/i)
  if (plainMatch?.[1]) {
    const candidate = normalizeCandidateFileName(plainMatch[1])
    if (hasExplicitExtension(candidate)) {
      return candidate
    }
  }

  return ''
}

const extractHelpfulQueryFileName = (value: string): string => {
  const contentDispositionFileName = getFileNameHintFromContentDisposition(value)
  if (contentDispositionFileName) {
    return contentDispositionFileName
  }

  const candidate = normalizeCandidateFileName(value)
  return hasExplicitExtension(candidate) ? candidate : ''
}

export const getFileNameHintFromUrl = (url: string): string => {
  const normalizedUrl = String(url || '').trim()
  if (!normalizedUrl) return ''

  try {
    const parsedUrl = new URL(normalizedUrl)
    const pathCandidate = normalizeCandidateFileName(parsedUrl.pathname)
    if (hasExplicitExtension(pathCandidate)) {
      return pathCandidate
    }

    for (const queryKey of FILENAME_QUERY_KEYS) {
      const matchingValues = parsedUrl.searchParams.getAll(queryKey)
      for (const value of matchingValues) {
        const candidate = extractHelpfulQueryFileName(value)
        if (candidate) {
          return candidate
        }
      }
    }

    for (const [, value] of parsedUrl.searchParams.entries()) {
      const candidate = extractHelpfulQueryFileName(value)
      if (candidate) {
        return candidate
      }
    }
  } catch {
    return hasExplicitExtension(normalizedUrl) ? normalizeCandidateFileName(normalizedUrl) : ''
  }

  return ''
}
