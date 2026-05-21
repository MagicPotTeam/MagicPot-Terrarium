const INVALID_PROJECT_PATH_PUNCTUATION = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

const replaceInvalidProjectPathCharacters = (value: string): string => {
  let result = ''
  let lastWasReplacement = false

  for (const char of value) {
    const charCode = char.charCodeAt(0)
    const isInvalid = charCode <= 0x1f || INVALID_PROJECT_PATH_PUNCTUATION.has(char)
    if (isInvalid) {
      if (!lastWasReplacement) {
        result += '_'
        lastWasReplacement = true
      }
      continue
    }

    result += char
    lastWasReplacement = false
  }

  return result
}

const normalizeText = (value: unknown): string => String(value ?? '').trim()

export function prefixGeneratedRootDirName(value: string): string {
  const normalized = normalizeText(value)
  return normalized.startsWith('.') ? normalized : `.${normalized}`
}

export function unprefixGeneratedRootDirName(value: string): string {
  return normalizeText(value).replace(/^\.+/, '')
}

export function normalizeGeneratedRootDirName(value: string): string {
  const unprefixed = unprefixGeneratedRootDirName(value)
  return unprefixed ? prefixGeneratedRootDirName(unprefixed) : ''
}

export function sanitizeProjectPathPart(value: string, fallback: string): string {
  const normalized = normalizeText(value).replace(/\s+/g, ' ')
  const sanitized = replaceInvalidProjectPathCharacters(normalized)
  const compacted = sanitized
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')

  return compacted || fallback
}

export function buildProjectStorageDirName(projectName: string, projectId: string): string {
  const safeName = sanitizeProjectPathPart(projectName, 'project')
  const safeId = sanitizeProjectPathPart(projectId, 'project')
  return prefixGeneratedRootDirName(`${safeName}__${safeId}`)
}
