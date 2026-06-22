const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

export function normalizeAllowedExternalUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('External URL is required')
  }

  const parsed = new URL(trimmed)
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`)
  }

  return parsed.href
}

export function isAllowedExternalUrl(value: string): boolean {
  try {
    normalizeAllowedExternalUrl(value)
    return true
  } catch {
    return false
  }
}
