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

const decodePercentOnce = (value: string): string | null => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

const hasUnsafeFileNameCharacters = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

const stripWrappingQuotes = (value: string): string => value.replace(/^['"]|['"]$/g, '').trim()

const getLastPathSegment = (value: string, { stripUrlSuffix = false } = {}): string => {
  let normalized = String(value || '').trim()
  if (stripUrlSuffix) {
    normalized = normalized.split('#')[0].split('?')[0]
  }
  if (!normalized || normalized.endsWith('/') || normalized.endsWith('\\')) return ''
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || ''
}

const normalizeDecodedFileName = (value: string): string => {
  const decoded = decodePercentOnce(value)
  if (decoded === null) return ''
  const candidate = getLastPathSegment(decoded)
  return hasUnsafeFileNameCharacters(candidate) ? '' : stripWrappingQuotes(candidate)
}

const normalizePathFileName = (value: string, stripUrlSuffix = false): string => {
  const rawCandidate = getLastPathSegment(value, { stripUrlSuffix })
  if (!rawCandidate) return ''
  return normalizeDecodedFileName(rawCandidate)
}

const normalizeQueryFileName = (value: string): string => {
  const candidate = getLastPathSegment(value)
  return hasUnsafeFileNameCharacters(candidate) ? '' : stripWrappingQuotes(candidate)
}

const hasExplicitExtension = (value: string): boolean => /\.[a-z0-9]{1,12}$/i.test(value)

const parseContentDispositionParameters = (value: string): Map<string, string> => {
  const parameters = new Map<string, string>()
  let index = value.indexOf(';')
  if (index < 0) return parameters

  while (index < value.length) {
    index += 1
    while (/\s/.test(value[index] || '')) index += 1
    const nameStart = index
    while (index < value.length && value[index] !== '=' && value[index] !== ';') index += 1
    if (value[index] !== '=') {
      while (index < value.length && value[index] !== ';') index += 1
      continue
    }
    const name = value.slice(nameStart, index).trim().toLowerCase()
    index += 1
    while (/\s/.test(value[index] || '')) index += 1

    let parameterValue = ''
    if (value[index] === '"') {
      index += 1
      let closed = false
      while (index < value.length) {
        const character = value[index++]
        if (character === '\\' && index < value.length) {
          parameterValue += value[index++]
        } else if (character === '"') {
          closed = true
          break
        } else {
          parameterValue += character
        }
      }
      if (!closed) continue
      while (index < value.length && value[index] !== ';') index += 1
    } else {
      const valueStart = index
      while (index < value.length && value[index] !== ';') index += 1
      parameterValue = value.slice(valueStart, index).trim()
    }

    if (name && !parameters.has(name)) parameters.set(name, parameterValue)
  }

  return parameters
}

const normalizeExtendedFileName = (value: string): string => {
  const match = value.match(/^([^']*)'[^']*'(.*)$/)
  if (!match || !/^utf-8$/i.test(match[1])) return ''
  const decoded = decodePercentOnce(match[2])
  if (decoded === null) return ''
  return normalizeQueryFileName(decoded)
}

const normalizeCandidateFileName = (value: string): string => normalizeQueryFileName(value)

export const getFileNameHintFromContentDisposition = (value: string): string => {
  if (!value || hasUnsafeFileNameCharacters(value)) return ''
  const parameters = parseContentDispositionParameters(value)
  const extended = parameters.get('filename*')
  if (extended) {
    const candidate = normalizeExtendedFileName(extended)
    if (hasExplicitExtension(candidate)) return candidate
  }

  const plain = parameters.get('filename')
  if (plain) {
    const candidate = normalizeQueryFileName(plain)
    if (hasExplicitExtension(candidate)) return candidate
  }

  return ''
}

const extractHelpfulQueryFileName = (value: string): string => {
  const contentDispositionFileName = getFileNameHintFromContentDisposition(value)
  if (contentDispositionFileName) {
    return contentDispositionFileName
  }

  if (/^\s*(?:attachment|inline)\s*(?:;|$)/i.test(value)) return ''
  const candidate = normalizeCandidateFileName(value)
  return hasExplicitExtension(candidate) ? candidate : ''
}

export const getFileNameHintFromUrl = (url: string): string => {
  const normalizedUrl = String(url || '').trim()
  if (/^[A-Za-z]:[\\/]/.test(normalizedUrl)) {
    const localPathCandidate = normalizeQueryFileName(normalizedUrl)
    return hasExplicitExtension(localPathCandidate) ? localPathCandidate : ''
  }

  try {
    const parsedUrl = new URL(normalizedUrl)
    const pathCandidate = normalizePathFileName(parsedUrl.pathname)
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
    const isWindowsPath = /^[A-Za-z]:[\\/]/.test(normalizedUrl)
    const fallback = isWindowsPath
      ? normalizeQueryFileName(normalizedUrl)
      : normalizePathFileName(normalizedUrl, true)
    return hasExplicitExtension(fallback) ? fallback : ''
  }

  return ''
}
