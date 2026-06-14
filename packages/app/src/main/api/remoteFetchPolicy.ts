import dns from 'node:dns/promises'
import type { LLMRemoteFetchReq } from '@shared/api/svcLLMProxy'
import type { Config } from '@shared/config/config'

export const MAX_REMOTE_FETCH_BODY_BYTES = 10 * 1024 * 1024
export const MAX_REMOTE_FETCH_RESPONSE_BYTES = 10 * 1024 * 1024

const MAX_REMOTE_FETCH_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_REMOTE_FETCH_TIMEOUT_MS = 5 * 60 * 1000
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i
const FORBIDDEN_REMOTE_FETCH_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])
const IPV4_ADDRESS_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

type RemoteFetchResolvedAddress = {
  address: string
  family: 4 | 6
}

export type ValidatedRemoteFetchRequest = {
  parsedUrl: URL
  headers: Record<string, string>
  timeoutMs: number
  resolvedAddress: RemoteFetchResolvedAddress
}

const getIpv4Octets = (hostname: string): number[] | undefined => {
  const match = hostname.match(IPV4_ADDRESS_PATTERN)
  if (!match) return undefined

  const octets = match.slice(1).map((part) => Number(part))
  return octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ? [] : octets
}

const isPrivateOrReservedIpv4 = (octets: readonly number[]): boolean => {
  if (octets.length !== 4) return true

  const [first, second, third] = octets
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  )
}

const normalizeIpv6Hostname = (hostname: string): string | undefined => {
  const lastColonIndex = hostname.lastIndexOf(':')
  const tail = lastColonIndex >= 0 ? hostname.slice(lastColonIndex + 1) : ''
  const ipv4Octets = getIpv4Octets(tail)
  if (!ipv4Octets) return hostname
  if (ipv4Octets.length !== 4) return undefined

  const ipv4Words = [(ipv4Octets[0] << 8) | ipv4Octets[1], (ipv4Octets[2] << 8) | ipv4Octets[3]]
  return `${hostname.slice(0, lastColonIndex)}:${ipv4Words.map((word) => word.toString(16)).join(':')}`
}

const parseIpv6Hextet = (value: string): number | undefined => {
  if (!/^[\da-f]{1,4}$/i.test(value)) return undefined
  const parsed = Number.parseInt(value, 16)
  return Number.isFinite(parsed) ? parsed : undefined
}

const getIpv6Words = (hostname: string): number[] | undefined => {
  if (!hostname.includes(':')) return undefined

  const normalized = normalizeIpv6Hostname(hostname)
  if (!normalized) return []

  const halves = normalized.split('::')
  if (halves.length > 2) return []

  const parseHalf = (half: string): number[] | undefined => {
    if (!half) return []
    const words = half.split(':').map(parseIpv6Hextet)
    return words.some((word) => word == null) ? undefined : (words as number[])
  }

  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] ?? '')
  if (!left || !right) return []

  if (halves.length === 1) return left.length === 8 ? left : []

  const missingWords = 8 - left.length - right.length
  return missingWords > 0 ? [...left, ...Array(missingWords).fill(0), ...right] : []
}

const getIpv4OctetsFromIpv6Words = (words: readonly number[]): number[] => [
  (words[6] >> 8) & 255,
  words[6] & 255,
  (words[7] >> 8) & 255,
  words[7] & 255
]

const isPrivateOrReservedIpv6 = (words: readonly number[]): boolean => {
  if (words.length !== 8) return true

  const [first] = words
  const allZeroExceptLast = (lastWord: number): boolean =>
    words.slice(0, 7).every((word) => word === 0) && words[7] === lastWord
  const isIpv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  const isIpv4Compatible = words.slice(0, 6).every((word) => word === 0)

  if (words.every((word) => word === 0) || allZeroExceptLast(1)) return true
  if (isIpv4Mapped || isIpv4Compatible) {
    return isPrivateOrReservedIpv4(getIpv4OctetsFromIpv6Words(words))
  }

  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && words[1] === 0x0db8)
  )
}

const normalizeRemoteFetchHostname = (hostname: string): string =>
  hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')

const isPrivateOrLocalRemoteFetchHost = (hostname: string): boolean => {
  const normalized = normalizeRemoteFetchHostname(hostname)
  if (
    !normalized ||
    normalized === 'localhost' ||
    normalized === 'ip6-localhost' ||
    normalized === 'ip6-loopback' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.localdomain')
  ) {
    return true
  }

  const ipv4Octets = getIpv4Octets(normalized)
  if (ipv4Octets) return isPrivateOrReservedIpv4(ipv4Octets)

  const ipv6Words = getIpv6Words(normalized)
  if (ipv6Words) return isPrivateOrReservedIpv6(ipv6Words)

  return false
}

const normalizeConfiguredRemoteFetchUrl = (value: string | undefined): string | null => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password || parsed.hash) return null
    return parsed.toString()
  } catch {
    return null
  }
}

const getAllowedRemoteFetchUrls = (config: Config): Set<string> => {
  const urls = new Set<string>()
  for (const skill of config.llm_config.customSkills || []) {
    if (skill.type !== 'agent') continue
    const normalized = normalizeConfiguredRemoteFetchUrl(skill.apiAddress)
    if (normalized) urls.add(normalized)
  }
  return urls
}

const assertRemoteFetchUrlIsConfigured = (parsedUrl: URL, config: Config): void => {
  const normalizedUrl = normalizeConfiguredRemoteFetchUrl(parsedUrl.toString())
  if (!normalizedUrl || !getAllowedRemoteFetchUrls(config).has(normalizedUrl)) {
    throw new Error('Remote fetch URL must match a configured external agent skill endpoint.')
  }
}

const resolveRemoteFetchAddress = async (hostname: string): Promise<RemoteFetchResolvedAddress> => {
  const normalizedHostname = normalizeRemoteFetchHostname(hostname)
  if (isPrivateOrLocalRemoteFetchHost(normalizedHostname)) {
    throw new Error('Remote fetch URL must target a public host.')
  }

  const directIpv4Octets = getIpv4Octets(normalizedHostname)
  if (directIpv4Octets) {
    return { address: normalizedHostname, family: 4 }
  }

  const directIpv6Words = getIpv6Words(normalizedHostname)
  if (directIpv6Words) {
    return { address: normalizedHostname, family: 6 }
  }

  const resolved = await dns.lookup(normalizedHostname, { all: true, verbatim: false })
  if (!resolved.length) {
    throw new Error('Remote fetch URL host could not be resolved.')
  }

  const privateAddress = resolved.find((entry) => isPrivateOrLocalRemoteFetchHost(entry.address))
  if (privateAddress) {
    throw new Error('Remote fetch URL resolved to a private or local address.')
  }

  const first = resolved[0]
  return { address: first.address, family: first.family === 6 ? 6 : 4 }
}

const sanitizeRemoteFetchHeaders = (
  headers: Record<string, string> | undefined
): Record<string, string> => {
  const sanitized: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = rawName.trim()
    const normalizedName = name.toLowerCase()
    const value = String(rawValue)
    if (!name || !HTTP_HEADER_NAME_PATTERN.test(name) || name.startsWith(':')) {
      throw new Error('Remote fetch request contains an invalid header name.')
    }
    if (FORBIDDEN_REMOTE_FETCH_HEADERS.has(normalizedName)) {
      throw new Error(`Remote fetch request cannot override the ${name} header.`)
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error('Remote fetch request headers must not contain line breaks.')
    }
    sanitized[name] = value
  }
  return sanitized
}

export const parseAndValidateRemoteFetchRequest = async (
  req: LLMRemoteFetchReq,
  config: Config
): Promise<ValidatedRemoteFetchRequest> => {
  const parsedUrl = new URL(req.url)
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Remote fetch URL must use https.')
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Remote fetch URL must not include embedded credentials.')
  }
  if (parsedUrl.hash) {
    throw new Error('Remote fetch URL must not include a fragment.')
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    throw new Error('Remote fetch method must be GET or POST.')
  }
  if (req.body && Buffer.byteLength(req.body, 'utf8') > MAX_REMOTE_FETCH_BODY_BYTES) {
    throw new Error('Remote fetch request body is too large.')
  }

  const headers = sanitizeRemoteFetchHeaders(req.headers)
  assertRemoteFetchUrlIsConfigured(parsedUrl, config)

  const timeoutMs = Math.min(
    Math.max(
      Number.isFinite(req.timeoutMs || 0)
        ? req.timeoutMs || DEFAULT_REMOTE_FETCH_TIMEOUT_MS
        : DEFAULT_REMOTE_FETCH_TIMEOUT_MS,
      1000
    ),
    MAX_REMOTE_FETCH_TIMEOUT_MS
  )
  const resolvedAddress = await resolveRemoteFetchAddress(parsedUrl.hostname)
  return { parsedUrl, headers, timeoutMs, resolvedAddress }
}
