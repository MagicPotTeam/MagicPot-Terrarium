/**
 * Validate provider base URLs before a built-in client is allowed to issue
 * an outbound request.  API profiles are persisted configuration and can be
 * edited by a renderer, so URL parsing here is a security boundary rather
 * than a convenience normalizer.
 *
 * Local/private HTTP endpoints remain supported for Ollama, LAN gateways and
 * CLIProxyAPI.  Public HTTP is rejected because it would send provider
 * credentials and prompts without transport protection.  HTTPS endpoints may
 * be public, but embedded credentials, query strings and fragments are never
 * accepted as part of a base URL.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u

const isPrivateIpv4 = (hostname: string): boolean => {
  const match = IPV4.exec(hostname)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  // An invalid dotted-quad is not a private address.  URL parsing rejects it
  // at the endpoint boundary; keeping classification false avoids turning a
  // malformed public hostname into an implicit local-network exception.
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first, second] = parts
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19))
  )
}

const isPrivateIpv6 = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (!normalized.includes(':')) return false
  // URL.hostname preserves the brackets on some runtimes; these prefixes
  // cover loopback, link-local, unique-local and IPv4-mapped local addresses.
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7))
  return false
}

export const isPrivateOrLocalProviderHost = (hostname: string): boolean => {
  const normalized = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
  if (
    !normalized ||
    normalized === 'localhost' ||
    normalized === 'ip6-localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.localdomain')
  ) {
    return true
  }
  return isPrivateIpv4(normalized) || isPrivateIpv6(normalized)
}

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

/** Parse and validate a built-in provider URL, returning its canonical URL. */
export const validateProviderBaseUrl = (value: string): string => {
  const rawInput = String(value || '')
  if (hasControlCharacter(rawInput)) {
    throw new Error('Provider endpoint must be a non-empty URL.')
  }
  const raw = rawInput.trim()
  if (!raw) throw new Error('Provider endpoint must be a non-empty URL.')

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Provider endpoint must be an absolute HTTP(S) URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Provider endpoint must use HTTP or HTTPS.')
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error('Provider endpoint must not contain embedded credentials.')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Provider endpoint must not contain a query or fragment.')
  }
  if (parsed.protocol === 'http:' && !isPrivateOrLocalProviderHost(parsed.hostname)) {
    throw new Error('Public provider endpoints must use HTTPS.')
  }
  return parsed.toString().replace(/\/$/u, '')
}
