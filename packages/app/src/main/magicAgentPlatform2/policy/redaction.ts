import {
  digestPolicyRequest,
  type PolicyJsonValue,
  type PolicyRequest
} from '../../../shared/magicAgentPlatform2'

const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'proxyauthorization',
  'auth',
  'cookie',
  'setcookie',
  'credential',
  'privatekey',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'xapitoken',
  'awsaccesskeyid',
  'awssecretaccesskey'
])

export type RedactedPolicyRequest = Readonly<{
  request: PolicyRequest
  requestDigest: string
  redactedPaths: readonly string[]
}>

export function redactPolicyRequestForAudit(request: PolicyRequest): RedactedPolicyRequest {
  const paths: string[] = []
  const visit = (value: PolicyJsonValue, path: string): PolicyJsonValue => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}[${index}]`))
    if (value !== null && typeof value === 'object') {
      const result: Record<string, PolicyJsonValue> = {}
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key
        if (isSensitiveKey(key)) {
          result[key] = '[REDACTED]'
          paths.push(childPath)
        } else result[key] = visit(child, childPath)
      }
      return result
    }
    return typeof value === 'string' ? redactSecretCredentialText(value) : value
  }
  const redacted = visit(request as unknown as PolicyJsonValue, '') as PolicyRequest
  paths.sort()
  return deepFreeze({
    request: redacted,
    requestDigest: digestPolicyRequest(request),
    redactedPaths: paths
  })
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitiveKey(value: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(value))
}

export function redactSecretCredentialText(value: string): string {
  let result = redactAuthentication(value)
  result = result.replace(
    /(^|[\s;,])((?:password|passwd|pwd|token|api[_-]?key|access[_-]?token|client[_-]?secret|proxy-authorization)\s*=\s*)([^\s;&,]+)/gi,
    '$1$2[REDACTED]'
  )
  return result.replace(
    /(?:jdbc:postgresql|https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi,
    redactUrlToken
  )
}

function redactUrlToken(token: string): string {
  const trailing = /[),.;!?]+$/.exec(token)?.[0] ?? ''
  const raw = trailing ? token.slice(0, -trailing.length) : token
  const jdbcPrefix = /^jdbc:/i.test(raw) ? raw.slice(0, 5) : ''
  const urlText = jdbcPrefix ? raw.slice(5) : raw
  try {
    const url = new URL(urlText)
    if (url.password) url.password = '[REDACTED]'
    for (const key of Array.from(url.searchParams.keys()))
      if (isSensitiveKey(key)) url.searchParams.set(key, '[REDACTED]')
    return `${jdbcPrefix}${url.toString().replace(/%5BREDACTED%5D(?=@)/gi, '[REDACTED]')}${trailing}`
  } catch {
    return token
  }
}

function redactAuthentication(value: string): string {
  let result = value.replace(
    /(\b(?:Authorization|Proxy-Authorization)\s*:\s*)(Bearer|Basic)\s+([^\s,;]+)/gi,
    '$1$2 [REDACTED]'
  )
  result = result.replace(/(\b(?:Cookie|Set-Cookie)\s*:\s*)([^\r\n]*)/gi, '$1[REDACTED]')
  const trimmed = result.trim()
  const match = /^(Bearer|Basic)\s+([^\s,;]+)([\s\S]*)$/i.exec(trimmed)
  if (!match || (!looksLikeCredential(match[2]) && !/^[,;]/.test(match[3]))) return result
  const leading = result.slice(0, result.length - result.trimStart().length)
  const trailing = result.slice(result.trimEnd().length)
  return `${leading}${match[1]} [REDACTED]${match[3]}${trailing}`
}

function looksLikeCredential(value: string): boolean {
  return value.length >= 12 || /[._-]/.test(value)
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
    Object.freeze(value)
  }
  return value
}
