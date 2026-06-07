import type {
  ChatAttachment,
  ChatMessage,
  LLMCli,
  LLMChatParams,
  LLMChatResult,
  VideoGenerationCameraPreset,
  VideoGenerationOptions
} from './types'
import { normalizeLLMChatResult } from './types'
import { describeFetchFailure, type FetchImpl } from './clients'

const KLING_DEFAULT_BASE_URL = 'https://api-beijing.klingai.com'
const VOLCENGINE_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timeout)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })

const normalizeBaseUrl = (baseUrl: string, fallback: string): string =>
  (baseUrl.trim() || fallback).replace(/\/+$/, '')

export const normalizeKlingBaseUrl = (baseUrl: string): string =>
  normalizeBaseUrl(baseUrl, KLING_DEFAULT_BASE_URL)

export const normalizeVolcengineBaseUrl = (baseUrl: string): string =>
  normalizeBaseUrl(baseUrl, VOLCENGINE_DEFAULT_BASE_URL).replace(
    /\/contents\/generations\/tasks\/?$/i,
    ''
  )

const getDefaultFetchImpl = (): FetchImpl => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Fetch API is unavailable in this runtime.')
  }

  return globalThis.fetch.bind(globalThis) as FetchImpl
}

const getLatestUserMessage = (messages: ChatMessage[]): ChatMessage | undefined =>
  [...messages].reverse().find((message) => message.role === 'user')

const getLatestUserAttachments = (messages: ChatMessage[]): ChatAttachment[] => {
  const latestUserMessage = getLatestUserMessage(messages)
  return latestUserMessage?.attachments ?? []
}

const getPrompt = (messages: ChatMessage[], options: { allowEmpty?: boolean } = {}): string => {
  const latestUserMessage = getLatestUserMessage(messages)
  const prompt = latestUserMessage?.content.trim() || ''
  if (!prompt && !options.allowEmpty) {
    throw new Error('Video generation requires a non-empty prompt in the latest user message.')
  }
  return prompt
}

const getImageAttachments = (messages: ChatMessage[]): ChatAttachment[] => {
  return getLatestUserAttachments(messages).filter((attachment) => attachment.type === 'image')
}

const MAX_VIDEO_IMAGE_DATA_URL_BYTES = 10 * 1024 * 1024

const getBase64ByteLength = (base64: string): number => {
  const normalized = base64.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

const isSupportedDataImageUrl = (url: string): boolean => {
  const match = url.trim().match(/^data:image\/(?:png|jpe?g);base64,([a-z0-9+/=\s]+)$/i)
  return Boolean(match?.[1] && getBase64ByteLength(match[1]) <= MAX_VIDEO_IMAGE_DATA_URL_BYTES)
}

const IPV4_ADDRESS_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const getIpv4Octets = (hostname: string): number[] | undefined => {
  const match = hostname.match(IPV4_ADDRESS_PATTERN)
  if (!match) {
    return undefined
  }

  const octets = match.slice(1).map((part) => Number(part))
  return octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ? [] : octets
}

const isPrivateOrReservedIpv4 = (octets: readonly number[]): boolean => {
  if (octets.length !== 4) {
    return true
  }

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
  if (!ipv4Octets) {
    return hostname
  }
  if (ipv4Octets.length !== 4) {
    return undefined
  }

  const ipv4Words = [(ipv4Octets[0] << 8) | ipv4Octets[1], (ipv4Octets[2] << 8) | ipv4Octets[3]]
  return `${hostname.slice(0, lastColonIndex)}:${ipv4Words.map((word) => word.toString(16)).join(':')}`
}

const parseIpv6Hextet = (value: string): number | undefined => {
  if (!/^[\da-f]{1,4}$/i.test(value)) {
    return undefined
  }
  const parsed = Number.parseInt(value, 16)
  return Number.isFinite(parsed) ? parsed : undefined
}

const getIpv6Words = (hostname: string): number[] | undefined => {
  if (!hostname.includes(':')) {
    return undefined
  }

  const normalized = normalizeIpv6Hostname(hostname)
  if (!normalized) {
    return []
  }

  const halves = normalized.split('::')
  if (halves.length > 2) {
    return []
  }

  const parseHalf = (half: string): number[] | undefined => {
    if (!half) {
      return []
    }
    const words = half.split(':').map(parseIpv6Hextet)
    return words.some((word) => word == null) ? undefined : (words as number[])
  }

  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] ?? '')
  if (!left || !right) {
    return []
  }

  if (halves.length === 1) {
    return left.length === 8 ? left : []
  }

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
  if (words.length !== 8) {
    return true
  }

  const [first] = words
  const allZeroExceptLast = (lastWord: number): boolean =>
    words.slice(0, 7).every((word) => word === 0) && words[7] === lastWord
  const isIpv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  const isIpv4Compatible = words.slice(0, 6).every((word) => word === 0)

  if (words.every((word) => word === 0) || allZeroExceptLast(1)) {
    return true
  }
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

const isPrivateOrLocalHttpUrl = (url: URL): boolean => {
  const hostname = url.hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname === 'ip6-localhost' ||
    hostname === 'ip6-loopback' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localdomain')
  ) {
    return true
  }

  const ipv4Octets = getIpv4Octets(hostname)
  if (ipv4Octets) {
    return isPrivateOrReservedIpv4(ipv4Octets)
  }

  const ipv6Words = getIpv6Words(hostname)
  if (ipv6Words) {
    return isPrivateOrReservedIpv6(ipv6Words)
  }

  return false
}

const isSupportedPublicHttpUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false
    }
    return !isPrivateOrLocalHttpUrl(parsed)
  } catch {
    return false
  }
}

const isSupportedVolcengineAssetUrl = (url: string): boolean => /^asset:\/\/\S+$/i.test(url.trim())

const isSupportedImageUrl = (url: string, options: { allowAssetUrl?: boolean } = {}): boolean => {
  const trimmed = url.trim()
  if (!trimmed) {
    return false
  }

  if (/^data:image\//i.test(trimmed)) {
    return isSupportedDataImageUrl(trimmed)
  }

  if (options.allowAssetUrl && isSupportedVolcengineAssetUrl(trimmed)) {
    return true
  }

  return isSupportedPublicHttpUrl(trimmed)
}

const assertSupportedImageAttachment = (
  attachment: ChatAttachment,
  options: { allowAssetUrl?: boolean } = {}
): string => {
  const imageUrl = attachment.url.trim()
  if (!isSupportedImageUrl(imageUrl, options)) {
    throw new Error(
      'Video image-to-video generation requires a public http(s) image URL or a data:image base64 URL (PNG/JPEG, <=10MB)' +
        (options.allowAssetUrl ? ', or an official Volcengine asset:// image URL' : '') +
        '. Local file/blob/local-media URLs are not supported.'
    )
  }
  return imageUrl
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const getValueAtPath = (
  value: unknown,
  path: readonly (string | number)[]
): unknown | undefined => {
  let current = value
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) {
        return undefined
      }
      current = current[segment]
      continue
    }

    if (!isPlainObject(current)) {
      return undefined
    }
    current = current[segment]
  }

  return current
}

const getStringAtPath = (
  value: unknown,
  path: readonly (string | number)[]
): string | undefined => {
  const current = getValueAtPath(value, path)
  return typeof current === 'string' && current.trim() ? current.trim() : undefined
}

const getStringishAtPath = (
  value: unknown,
  path: readonly (string | number)[]
): string | undefined => {
  const current = getValueAtPath(value, path)
  if (typeof current === 'number' && Number.isFinite(current)) {
    return String(current)
  }
  return typeof current === 'string' && current.trim() ? current.trim() : undefined
}

const findFirstStringByKey = (
  value: unknown,
  keys: readonly string[],
  depth = 0,
  options: { requireUrlValue?: boolean } = {}
): string | undefined => {
  if (!value || depth > 8) {
    return undefined
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKey(item, keys, depth + 1, options)
      if (found) {
        return found
      }
    }
    return undefined
  }

  if (!isPlainObject(value)) {
    return undefined
  }

  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      const trimmed = candidate.trim()
      if (!options.requireUrlValue || /^https?:\/\//i.test(trimmed)) {
        return trimmed
      }
    }
  }

  for (const nestedValue of Object.values(value)) {
    const found = findFirstStringByKey(nestedValue, keys, depth + 1, options)
    if (found) {
      return found
    }
  }

  return undefined
}

const firstString = (...values: Array<string | undefined>): string | undefined =>
  values.find((value) => Boolean(value?.trim()))

const JWT_PATTERN = /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi
const API_KEY_ASSIGNMENT_PATTERN =
  /\b((?:access|secret|api)[_-]?key|authorization|token)\b(\s*[:=]\s*)(['"]?)(?!Bearer\b)[^'",\s}]+/gi
const API_KEY_JSON_PATTERN = /(["'](?:access|secret|api)[_-]?key["']\s*:\s*["'])[^"']+(["'])/gi
const QUERY_SECRET_PATTERN =
  /([?&](?:(?:access|secret|api)[_-]?key|authorization|token)=)[^&#\s]+/gi

const redactSensitiveValue = (value: string, sensitiveValues: readonly string[] = []): string => {
  let redacted = value
    .replace(/Bearer\s+[^\s,}]+/gi, 'Bearer [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(API_KEY_ASSIGNMENT_PATTERN, '$1$2$3[REDACTED]')
    .replace(API_KEY_JSON_PATTERN, '$1[REDACTED]$2')
    .replace(QUERY_SECRET_PATTERN, '$1[REDACTED]')

  for (const sensitiveValue of sensitiveValues) {
    const trimmed = sensitiveValue.trim()
    if (trimmed.length >= 4) {
      redacted = redacted.split(trimmed).join('[REDACTED]')
    }
  }

  return redacted
}

const getProviderErrorCode = (data: unknown): string | undefined =>
  firstString(
    getStringishAtPath(data, ['code']),
    getStringishAtPath(data, ['error', 'code']),
    getStringishAtPath(data, ['last_error', 'code']),
    getStringishAtPath(data, ['data', 'code']),
    getStringishAtPath(data, ['data', 'error', 'code']),
    getStringishAtPath(data, ['data', 'task_status_msg'])
  )

const getProviderErrorMessage = (data: unknown): string | undefined =>
  firstString(
    getStringAtPath(data, ['message']),
    getStringAtPath(data, ['error', 'message']),
    getStringAtPath(data, ['last_error', 'message']),
    getStringAtPath(data, ['data', 'message']),
    getStringAtPath(data, ['data', 'error', 'message']),
    getStringAtPath(data, ['data', 'task_status_msg']),
    getStringAtPath(data, ['data', 'status_message'])
  )

const getProviderRequestId = (data: unknown): string | undefined =>
  firstString(
    getStringAtPath(data, ['request_id']),
    getStringAtPath(data, ['requestId']),
    getStringAtPath(data, ['requestID']),
    getStringAtPath(data, ['data', 'request_id']),
    getStringAtPath(data, ['error', 'request_id'])
  )

const formatProviderResponseDetails = (
  data: unknown,
  fallbackMessage?: string,
  sensitiveValues: readonly string[] = []
): string => {
  const code = getProviderErrorCode(data)
  const message = firstString(getProviderErrorMessage(data), fallbackMessage)
  const requestId = getProviderRequestId(data)
  const parts = [
    code ? `code=${redactSensitiveValue(code, sensitiveValues)}` : undefined,
    message ? `message=${redactSensitiveValue(message, sensitiveValues)}` : undefined,
    requestId ? `request_id=${redactSensitiveValue(requestId, sensitiveValues)}` : undefined
  ].filter(Boolean)

  return parts.length ? parts.join(', ') : 'unknown provider error'
}

const getStatusText = (response: Response): string =>
  `${response.status} ${response.statusText}`.trim()

const readJsonResponse = async (
  response: Response,
  label: string,
  sensitiveValues: readonly string[] = []
): Promise<unknown> => {
  const text = await response.text()
  const trimmed = text.trim()
  if (!trimmed) {
    if (!response.ok) {
      throw new Error(`${label} API error: ${getStatusText(response)}`.trim())
    }
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    if (!response.ok) {
      throw new Error(
        `${label} API error: ${getStatusText(response)} ${redactSensitiveValue(text, sensitiveValues)}`.trim()
      )
    }
    throw new Error(
      `${label} API returned invalid JSON: ${redactSensitiveValue(text, sensitiveValues)}`
    )
  }

  if (!response.ok) {
    throw new Error(
      `${label} API error: ${getStatusText(response)} ${formatProviderResponseDetails(
        parsed,
        undefined,
        sensitiveValues
      )}`.trim()
    )
  }

  return parsed
}

const requestJson = async (
  fetchImpl: FetchImpl,
  label: string,
  endpoint: string,
  init: RequestInit,
  sensitiveValues: readonly string[] = []
): Promise<unknown> => {
  let response: Response
  try {
    response = await fetchImpl(endpoint, init)
  } catch (error) {
    throw new Error(
      `${label} request failed for ${redactSensitiveValue(endpoint, sensitiveValues)}: ${redactSensitiveValue(
        describeFetchFailure(error),
        sensitiveValues
      )}`
    )
  }
  return readJsonResponse(response, label, sensitiveValues)
}

const parseDataUrlBase64 = (url: string): string => {
  const match = url.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i)
  return match?.[1] || url
}

const isAllowedStringOption = <T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T => typeof value === 'string' && (allowed as readonly string[]).includes(value)

const getPositiveIntegerOption = (
  value: unknown,
  options: { min?: number; max?: number } = {}
): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined
  }
  if (options.min != null && value < options.min) {
    return undefined
  }
  if (options.max != null && value > options.max) {
    return undefined
  }
  return value
}

const getNumberOption = (
  value: unknown,
  options: { min?: number; max?: number } = {}
): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  if (options.min != null && value < options.min) {
    return undefined
  }
  if (options.max != null && value > options.max) {
    return undefined
  }
  return value
}

const getTrimmedStringOption = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const parseJsonObjectOption = (
  value: unknown,
  label: string,
  provider = 'Kling'
): Record<string, unknown> | undefined => {
  if (value == null || (typeof value === 'string' && !value.trim())) {
    return undefined
  }

  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new Error(`${provider} ${label} must be valid JSON.`)
    }
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${provider} ${label} must be a JSON object.`)
  }
  return parsed
}

const parseJsonLikeOption = (value: unknown, label: string): unknown => {
  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (!/^[{[]/.test(trimmed)) {
    return trimmed
  }

  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    throw new Error(`Kling ${label} must be valid JSON.`)
  }
}

const assertJsonSerializableOption = <T>(value: T, label: string): T => {
  try {
    JSON.stringify(value)
  } catch {
    throw new Error(`Kling ${label} must be JSON-serializable.`)
  }
  return value
}

const KLING_ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const
const KLING_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const
const KLING_MODES = ['std', 'pro', '4k'] as const
const KLING_SOUNDS = ['on', 'off'] as const
const KLING_CAMERA_PRESETS = [
  'none',
  'down_back',
  'forward_up',
  'right_turn_forward',
  'left_turn_forward'
] as const
const KLING_SHOT_TYPES = ['single', 'multi'] as const
const KLING_CAMERA_SIMPLE_AXES = ['horizontal', 'vertical', 'pan', 'tilt', 'roll', 'zoom'] as const
const KLING_ADVANCED_JSON_FIELDS = [
  'multi_shot',
  'multi_prompt',
  'element_list',
  'voice_list',
  'static_mask',
  'dynamic_masks'
] as const
const SEEDANCE_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const
const SEEDANCE_RESOLUTIONS = ['480p', '720p', '1080p'] as const
const SEEDANCE_REFERENCE_ROLES = [
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio'
] as const
type SeedanceReferenceRole = (typeof SEEDANCE_REFERENCE_ROLES)[number]
type SeedanceReferenceMediaKind = 'image' | 'video' | 'audio'

const getKlingAspectRatio = (options?: VideoGenerationOptions): string => {
  const ratio = options?.aspectRatio
  return isAllowedStringOption(ratio, KLING_ASPECT_RATIOS) ? ratio : '16:9'
}

const getKlingDuration = (options?: VideoGenerationOptions): number | undefined => {
  const duration = options?.duration
  return KLING_DURATIONS.includes(duration as (typeof KLING_DURATIONS)[number])
    ? duration
    : undefined
}

const getKlingMode = (options?: VideoGenerationOptions): string | undefined => {
  const mode = options?.mode
  return isAllowedStringOption(mode, KLING_MODES) ? mode : undefined
}

const getKlingSound = (options?: VideoGenerationOptions): string | undefined => {
  const sound = options?.sound
  return isAllowedStringOption(sound, KLING_SOUNDS) ? sound : undefined
}

type VideoGenerationOptionsRecord = VideoGenerationOptions & Record<string, unknown>

type KlingRequestBuildContext = {
  action: 'text2video' | 'image2video'
  modelName: string
  body: Record<string, unknown>
  warnings: string[]
}

const getKlingCameraControl = (
  cameraPreset?: VideoGenerationCameraPreset,
  cameraOption?: unknown
): Record<string, unknown> | undefined => {
  const cameraObject = parseJsonObjectOption(cameraOption, 'camera_control')
  if (cameraObject) {
    const type = getTrimmedStringOption(cameraObject.type)
    if (type === 'simple') {
      const config = isPlainObject(cameraObject.config) ? cameraObject.config : cameraObject
      const simpleConfig: Record<string, number> = {}
      for (const axis of KLING_CAMERA_SIMPLE_AXES) {
        const amount = getNumberOption(config[axis], { min: -10, max: 10 })
        if (amount != null) {
          simpleConfig[axis] = amount
        }
      }
      if (!Object.keys(simpleConfig).length) {
        throw new Error(
          'Kling camera_control type "simple" requires at least one numeric six-axis value between -10 and 10.'
        )
      }
      return { type: 'simple', config: simpleConfig }
    }
    return cameraObject
  }

  if (!isAllowedStringOption(cameraPreset, KLING_CAMERA_PRESETS) || cameraPreset === 'none') {
    return undefined
  }
  return { type: cameraPreset }
}

const getKlingAdvancedOption = (
  options: VideoGenerationOptionsRecord | undefined,
  snakeKey: string
): unknown => {
  if (!options) {
    return undefined
  }
  if (Object.prototype.hasOwnProperty.call(options, snakeKey)) {
    return options[snakeKey]
  }

  const camelKey = snakeKey.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
  return options[camelKey]
}

const hasKlingAdvancedOption = (
  options: VideoGenerationOptionsRecord | undefined,
  snakeKey: string
): boolean => {
  if (!options) {
    return false
  }
  if (Object.prototype.hasOwnProperty.call(options, snakeKey)) {
    return true
  }

  const camelKey = snakeKey.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
  return Object.prototype.hasOwnProperty.call(options, camelKey)
}

const appendKlingCapabilityWarnings = (context: KlingRequestBuildContext): void => {
  const model = context.modelName.toLowerCase()
  const isV1Model =
    /kling-v?1(?:\D|$)/i.test(context.modelName) || /kling-1(?:\D|$)/i.test(context.modelName)
  const isV2Model =
    /kling-v?2(?:\D|$)/i.test(context.modelName) || /kling-2(?:\D|$)/i.test(context.modelName)
  const isV21Model = /2\.1|v?21|kling-?21/i.test(context.modelName)

  if (context.body.mode === '4k' && !isV21Model && !/4k/.test(model)) {
    context.warnings.push(
      'Kling 4k mode is normally available only on Kling 2.1/4k-capable models.'
    )
  }
  if (context.body.sound === 'on' && (isV1Model || context.action === 'image2video')) {
    context.warnings.push('Kling sound generation may be unsupported for this model or action.')
  }
  if (context.body.camera_control && context.action !== 'image2video') {
    context.warnings.push('Kling camera_control is intended for image-to-video requests.')
  }
  if (
    (context.body.static_mask || context.body.dynamic_masks) &&
    context.action !== 'image2video'
  ) {
    context.warnings.push('Kling motion brush mask fields require image-to-video input.')
  }
  if (context.body.multi_shot && context.body.shot_type !== 'multi') {
    context.warnings.push('Kling multi_shot is intended to be used with shot_type="multi".')
  }
  if (context.body.voice_list && !isV2Model && !isV21Model) {
    context.warnings.push('Kling voice_list support may require newer Kling models.')
  }
}

const applyKlingTypedOptions = (
  context: KlingRequestBuildContext,
  options?: VideoGenerationOptions
): void => {
  const optionRecord = options as VideoGenerationOptionsRecord | undefined
  const callbackUrl = getTrimmedStringOption(
    getKlingAdvancedOption(optionRecord, 'callback_url') ?? options?.callbackUrl
  )
  if (callbackUrl) {
    try {
      const parsed = new URL(callbackUrl)
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        isPrivateOrLocalHttpUrl(parsed)
      ) {
        throw new Error('unsupported URL')
      }
    } catch {
      throw new Error('Kling callback_url must be a valid public http(s) URL.')
    }
    context.body.callback_url = callbackUrl
  }

  const externalTaskId = getTrimmedStringOption(
    getKlingAdvancedOption(optionRecord, 'external_task_id') ?? options?.externalTaskId
  )
  if (externalTaskId) {
    context.body.external_task_id = externalTaskId
  }

  const shotType = getTrimmedStringOption(getKlingAdvancedOption(optionRecord, 'shot_type'))
  if (shotType) {
    if (!isAllowedStringOption(shotType, KLING_SHOT_TYPES)) {
      throw new Error('Kling shot_type must be one of: single, multi.')
    }
    context.body.shot_type = shotType
  }

  for (const field of KLING_ADVANCED_JSON_FIELDS) {
    if (!hasKlingAdvancedOption(optionRecord, field)) {
      continue
    }
    const rawValue = getKlingAdvancedOption(optionRecord, field)
    const value = parseJsonLikeOption(rawValue, field)
    if (value !== undefined) {
      context.body[field] = assertJsonSerializableOption(value, field)
    }
  }

  const cameraControl = getKlingCameraControl(
    options?.cameraPreset,
    getKlingAdvancedOption(optionRecord, 'camera_control') ??
      options?.cameraControl ??
      (options?.cameraSimpleControls
        ? { type: 'simple', config: options.cameraSimpleControls }
        : undefined)
  )
  if (cameraControl) {
    context.body.camera_control = assertJsonSerializableOption(cameraControl, 'camera_control')
  }

  appendKlingCapabilityWarnings(context)
}

const mergeKlingRequestBodyOptions = (
  context: KlingRequestBuildContext,
  options?: VideoGenerationOptions
): void => {
  const advancedJson = parseJsonObjectOption(options?.advancedJson, 'advancedJson')
  if (advancedJson) {
    Object.assign(context.body, advancedJson)
  }

  applyKlingTypedOptions(context, options)

  if (options?.requestOverride) {
    const requestOverride = parseJsonObjectOption(options.requestOverride, 'requestOverride')
    if (requestOverride) {
      Object.assign(context.body, requestOverride)
    }
  }
}

const getSeedanceRatio = (options?: VideoGenerationOptions, hasImage = false): string => {
  const ratio = options?.aspectRatio
  if (isAllowedStringOption(ratio, SEEDANCE_RATIOS)) {
    return ratio
  }
  return hasImage ? 'adaptive' : '16:9'
}

const getSeedanceReferenceRole = (
  role: unknown,
  index = 0,
  mediaKind: SeedanceReferenceMediaKind = 'image'
): SeedanceReferenceRole => {
  if (isAllowedStringOption(role, SEEDANCE_REFERENCE_ROLES)) {
    return role
  }
  if (mediaKind === 'video') {
    return 'reference_video'
  }
  if (mediaKind === 'audio') {
    return 'reference_audio'
  }
  return index === 0 ? 'first_frame' : 'reference_image'
}

const getUnknownOption = (options: VideoGenerationOptions | undefined, key: string): unknown => {
  if (!options || typeof options !== 'object') {
    return undefined
  }
  return (options as Record<string, unknown>)[key]
}

const getStringOption = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const getBooleanOption = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const getStringArrayOption = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim())
}

const base64UrlEncode = (value: string | Uint8Array): string => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')

  if (typeof btoa === 'function') {
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  }

  return Buffer.from(bytes).toString('base64url')
}

const signHmacSha256 = async (message: string, secret: string): Promise<Uint8Array> => {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.subtle) {
    throw new Error('Web Crypto API is unavailable for Kling JWT signing.')
  }

  const key = await cryptoApi.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await cryptoApi.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return new Uint8Array(signature)
}

export const createKlingJwt = async (accessKey: string, secretKey: string): Promise<string> => {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    iss: accessKey,
    exp: nowSeconds + 1800,
    nbf: nowSeconds - 5
  }
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`
  const signature = await signHmacSha256(signingInput, secretKey)
  return `${signingInput}.${base64UrlEncode(signature)}`
}

const createVideoResult = (
  videoUrl: string,
  provider: string,
  taskId: string,
  metadata: Record<string, unknown>
): LLMChatResult => {
  const attachment: ChatAttachment = {
    type: 'video',
    url: videoUrl,
    mimeType: 'video/mp4',
    fileName: `${provider}-${taskId || 'video'}.mp4`
  }

  return normalizeLLMChatResult({
    content: '',
    attachments: [attachment],
    finishReason: 'stop',
    metadata
  })
}

const getKlingTaskId = (data: unknown): string | undefined =>
  firstString(
    getStringAtPath(data, ['data', 'task_id']),
    getStringAtPath(data, ['task_id']),
    getStringAtPath(data, ['id']),
    getStringAtPath(data, ['data', 'id'])
  )

const getKlingTaskStatus = (data: unknown): string =>
  String(
    firstString(
      getStringAtPath(data, ['data', 'task_status']),
      getStringAtPath(data, ['data', 'status']),
      getStringAtPath(data, ['task_status']),
      getStringAtPath(data, ['status'])
    ) || ''
  ).toLowerCase()

const getKlingFailureMessage = (data: unknown): string | undefined =>
  firstString(
    getStringAtPath(data, ['data', 'task_status_msg']),
    getStringAtPath(data, ['data', 'status_message']),
    getStringAtPath(data, ['data', 'message']),
    getStringAtPath(data, ['message']),
    getStringAtPath(data, ['error', 'message'])
  )

const getKlingBusinessCode = (data: unknown): string | undefined => {
  if (!isPlainObject(data)) {
    return undefined
  }

  const code = data.code
  if (typeof code === 'number' && Number.isFinite(code)) {
    return String(code)
  }
  if (typeof code === 'string') {
    return code.trim()
  }
  return undefined
}

const isKlingBusinessSuccessCode = (code: string | undefined): boolean =>
  code === undefined || code === '0'

const assertKlingBusinessSuccess = (
  data: unknown,
  operation: string,
  sensitiveValues: readonly string[]
): void => {
  const code = getKlingBusinessCode(data)
  if (isKlingBusinessSuccessCode(code)) {
    return
  }

  throw new Error(
    `Kling ${operation} API error: ${formatProviderResponseDetails(
      data,
      undefined,
      sensitiveValues
    )}`
  )
}

const getKlingVideoUrl = (data: unknown): string | undefined =>
  firstString(
    getStringAtPath(data, ['data', 'task_result', 'videos', 0, 'url']),
    getStringAtPath(data, ['task_result', 'videos', 0, 'url']),
    getStringAtPath(data, ['data', 'videos', 0, 'url']),
    findFirstStringByKey(data, ['video_url', 'videoUrl'], 0, { requireUrlValue: true })
  )

const isKlingTerminalSuccess = (status: string): boolean =>
  ['succeed', 'succeeded', 'success', 'completed', 'done'].includes(status)

const isKlingTerminalFailure = (status: string): boolean =>
  ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)

export class KlingVideoAPICli implements LLMCli {
  constructor(
    private readonly accessKey: string,
    private readonly secretKey: string,
    private readonly baseUrl: string,
    private readonly modelName: string,
    private readonly fetchImpl?: FetchImpl,
    private readonly pollOptions: { intervalMs?: number; timeoutMs?: number } = {}
  ) {}

  private getFetchImpl(): FetchImpl {
    return this.fetchImpl ?? getDefaultFetchImpl()
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    const imageAttachments = getImageAttachments(params.messages)
    const imageAttachment = imageAttachments[0]
    const imageTailAttachment = imageAttachments[1]
    const prompt = getPrompt(params.messages, { allowEmpty: Boolean(imageAttachment) })
    const imageUrl = imageAttachment ? assertSupportedImageAttachment(imageAttachment) : undefined
    const imageTailUrl = imageTailAttachment
      ? assertSupportedImageAttachment(imageTailAttachment)
      : undefined
    const videoOptions = params.videoGenerationOptions
    const action = imageUrl ? 'image2video' : 'text2video'
    const base = normalizeKlingBaseUrl(this.baseUrl)
    const token = await createKlingJwt(this.accessKey, this.secretKey)
    const endpoint = `${base}/v1/videos/${action}`
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
    const body: Record<string, unknown> = {
      model_name: this.modelName
    }
    if (prompt) {
      body.prompt = prompt
    }

    if (imageUrl) {
      body.image = parseDataUrlBase64(imageUrl)
      if (imageTailUrl) {
        body.image_tail = parseDataUrlBase64(imageTailUrl)
      }
    } else {
      body.aspect_ratio = getKlingAspectRatio(videoOptions)
    }

    const duration = getKlingDuration(videoOptions)
    if (duration != null) {
      body.duration = duration
    }
    const negativePrompt = videoOptions?.negativePrompt?.trim()
    if (negativePrompt) {
      body.negative_prompt = negativePrompt
    }
    const cfgScale = getNumberOption(videoOptions?.cfgScale, { min: 0, max: 1 })
    if (cfgScale != null) {
      body.cfg_scale = cfgScale
    }
    const mode = getKlingMode(videoOptions)
    if (mode) {
      body.mode = mode
    }
    const sound = getKlingSound(videoOptions)
    if (sound) {
      body.sound = sound
    }
    if (typeof videoOptions?.watermark === 'boolean') {
      body.watermark_info = { enabled: videoOptions.watermark }
    }
    const warnings: string[] = []
    mergeKlingRequestBodyOptions(
      {
        action,
        modelName: this.modelName,
        body,
        warnings
      },
      videoOptions
    )

    const fetchImpl = this.getFetchImpl()
    const sensitiveValues = [this.accessKey, this.secretKey, token]
    const created = await requestJson(
      fetchImpl,
      'Kling',
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: params.signal
      },
      sensitiveValues
    )
    assertKlingBusinessSuccess(created, 'create task', sensitiveValues)
    const taskId = getKlingTaskId(created)
    if (!taskId) {
      throw new Error(
        `Kling API did not return a task id: ${formatProviderResponseDetails(
          created,
          undefined,
          sensitiveValues
        )}`
      )
    }

    const result = await this.pollTask(
      fetchImpl,
      `${endpoint}/${encodeURIComponent(taskId)}`,
      headers,
      sensitiveValues,
      params.signal
    )
    const videoUrl = getKlingVideoUrl(result)
    if (!videoUrl) {
      throw new Error(
        `Kling task ${taskId} succeeded but did not return a video URL: ${formatProviderResponseDetails(
          result,
          undefined,
          sensitiveValues
        )}`
      )
    }

    return createVideoResult(videoUrl, 'kling', taskId, {
      provider: 'kling',
      taskId,
      action,
      response: result,
      warnings
    })
  }

  private async pollTask(
    fetchImpl: FetchImpl,
    endpoint: string,
    headers: Record<string, string>,
    sensitiveValues: readonly string[],
    signal?: AbortSignal
  ): Promise<unknown> {
    const intervalMs = this.pollOptions.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const timeoutMs = this.pollOptions.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    const startedAt = Date.now()

    while (Date.now() - startedAt <= timeoutMs) {
      const data = await requestJson(
        fetchImpl,
        'Kling',
        endpoint,
        {
          method: 'GET',
          headers,
          signal
        },
        sensitiveValues
      )
      assertKlingBusinessSuccess(data, 'poll task', sensitiveValues)
      const status = getKlingTaskStatus(data)
      if (isKlingTerminalSuccess(status)) {
        return data
      }
      if (isKlingTerminalFailure(status)) {
        throw new Error(
          `Kling task failed: ${formatProviderResponseDetails(
            data,
            getKlingFailureMessage(data) || status,
            sensitiveValues
          )}`
        )
      }
      await sleep(intervalMs, signal)
    }

    throw new Error('Kling task polling timed out.')
  }
}

const getVolcengineTaskId = (data: unknown): string | undefined =>
  firstString(
    getStringAtPath(data, ['id']),
    getStringAtPath(data, ['data', 'id']),
    getStringAtPath(data, ['task_id']),
    getStringAtPath(data, ['data', 'task_id'])
  )

const getVolcengineStatus = (data: unknown): string =>
  String(
    firstString(
      getStringAtPath(data, ['status']),
      getStringAtPath(data, ['data', 'status']),
      getStringAtPath(data, ['task_status']),
      getStringAtPath(data, ['data', 'task_status'])
    ) || ''
  ).toLowerCase()

const getVolcengineFailureMessage = (data: unknown): string | undefined =>
  firstString(
    getStringAtPath(data, ['error', 'message']),
    getStringAtPath(data, ['last_error', 'message']),
    getStringAtPath(data, ['data', 'error', 'message']),
    getStringAtPath(data, ['message'])
  )

const getVolcengineVideoUrl = (data: unknown): string | undefined => {
  const videoUrl = firstString(
    getStringAtPath(data, ['content', 'video_url']),
    getStringAtPath(data, ['content', 'videoUrl']),
    getStringAtPath(data, ['content', 'result_url']),
    getStringAtPath(data, ['content', 'resultUrl']),
    getStringAtPath(data, ['data', 'content', 'video_url']),
    getStringAtPath(data, ['data', 'content', 'videoUrl']),
    getStringAtPath(data, ['data', 'content', 'result_url']),
    getStringAtPath(data, ['data', 'content', 'resultUrl']),
    getStringAtPath(data, ['output', 'video_url']),
    getStringAtPath(data, ['output', 'videoUrl']),
    getStringAtPath(data, ['output', 'result_url']),
    getStringAtPath(data, ['output', 'resultUrl']),
    getStringAtPath(data, ['data', 'output', 'video_url']),
    getStringAtPath(data, ['data', 'output', 'videoUrl']),
    getStringAtPath(data, ['data', 'output', 'result_url']),
    getStringAtPath(data, ['data', 'output', 'resultUrl']),
    getStringAtPath(data, ['result_url']),
    getStringAtPath(data, ['resultUrl']),
    getStringAtPath(data, ['data', 'result_url']),
    getStringAtPath(data, ['data', 'resultUrl']),
    findFirstStringByKey(data, ['result_url', 'resultUrl', 'video_url', 'videoUrl'], 0, {
      requireUrlValue: true
    })
  )
  return videoUrl && isSupportedPublicHttpUrl(videoUrl) ? videoUrl : undefined
}

const isVolcengineTerminalSuccess = (status: string): boolean =>
  ['succeeded', 'succeed', 'success', 'completed', 'done'].includes(status)

const isVolcengineTerminalFailure = (status: string): boolean =>
  ['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired', 'expire'].includes(status)

const getSeedanceAttachmentKind = (
  attachment: ChatAttachment
): SeedanceReferenceMediaKind | undefined => {
  const attachmentType = String(attachment.type).toLowerCase()
  const mimeType = attachment.mimeType?.trim().toLowerCase() || ''
  const fileName = attachment.fileName?.trim().toLowerCase() || ''
  const urlPath = attachment.url.trim().split(/[?#]/, 1)[0].toLowerCase()

  if (
    attachmentType === 'image' ||
    mimeType.startsWith('image/') ||
    /\.(?:png|jpe?g)$/i.test(fileName) ||
    /^data:image\//i.test(attachment.url) ||
    /\.(?:png|jpe?g)$/i.test(urlPath)
  ) {
    return 'image'
  }

  if (
    attachmentType === 'video' ||
    mimeType.startsWith('video/') ||
    /\.(?:mp4|m4v|mov|webm|mpeg|mpg)$/i.test(fileName) ||
    /\.(?:mp4|m4v|mov|webm|mpeg|mpg)$/i.test(urlPath)
  ) {
    return 'video'
  }

  if (
    attachmentType === 'audio' ||
    mimeType.startsWith('audio/') ||
    /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/i.test(fileName) ||
    /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/i.test(urlPath)
  ) {
    return 'audio'
  }

  return undefined
}

type SeedanceReferenceAttachment = {
  attachment: ChatAttachment
  attachmentIndex: number
  mediaIndex: number
  mediaKind: SeedanceReferenceMediaKind
}

const getSeedanceReferenceAttachments = (
  messages: ChatMessage[]
): SeedanceReferenceAttachment[] => {
  const mediaIndexes: Record<SeedanceReferenceMediaKind, number> = {
    image: 0,
    video: 0,
    audio: 0
  }
  const references: SeedanceReferenceAttachment[] = []

  for (const [attachmentIndex, attachment] of getLatestUserAttachments(messages).entries()) {
    const mediaKind = getSeedanceAttachmentKind(attachment)
    if (!mediaKind) {
      continue
    }
    references.push({
      attachment,
      attachmentIndex,
      mediaIndex: mediaIndexes[mediaKind],
      mediaKind
    })
    mediaIndexes[mediaKind] += 1
  }

  return references
}

const isSupportedSeedanceMediaUrl = (
  url: string,
  mediaKind: SeedanceReferenceMediaKind
): boolean => {
  const trimmed = url.trim()
  if (!trimmed) {
    return false
  }
  if (mediaKind === 'image') {
    return isSupportedImageUrl(trimmed, { allowAssetUrl: true })
  }
  return isSupportedVolcengineAssetUrl(trimmed) || isSupportedPublicHttpUrl(trimmed)
}

const getSeedanceMediaUrlError = (mediaKind: SeedanceReferenceMediaKind): string => {
  if (mediaKind === 'image') {
    return 'Video image-to-video generation requires a public http(s) image URL or a data:image base64 URL (PNG/JPEG, <=10MB), or an official Volcengine asset:// image URL. Local file/blob/local-media URLs are not supported.'
  }
  return `Volcengine Seedance ${mediaKind} references require a public http(s) ${mediaKind} URL or an official Volcengine asset:// ${mediaKind} URL. Local file/blob/local-media URLs are not supported.`
}

const assertSupportedSeedanceMediaAttachment = (
  attachment: ChatAttachment,
  mediaKind: SeedanceReferenceMediaKind
): string => {
  const mediaUrl = attachment.url.trim()
  if (!isSupportedSeedanceMediaUrl(mediaUrl, mediaKind)) {
    throw new Error(getSeedanceMediaUrlError(mediaKind))
  }
  return mediaUrl
}

const getAttachmentUnknownOption = (attachment: ChatAttachment, key: string): unknown =>
  (attachment as unknown as Record<string, unknown>)[key]

const firstDefined = (...values: unknown[]): unknown => values.find((value) => value !== undefined)

const getSeedanceReferenceRoleForAttachment = (
  options: VideoGenerationOptions | undefined,
  attachment: ChatAttachment,
  mediaKind: SeedanceReferenceMediaKind,
  mediaIndex: number,
  attachmentIndex: number
): SeedanceReferenceRole => {
  const kindRole = getUnknownOption(options, `${mediaKind}ReferenceRole`)
  const kindRoles = getStringArrayOption(getUnknownOption(options, `${mediaKind}ReferenceRoles`))
  const allRoles = getStringArrayOption(getUnknownOption(options, 'referenceRoles'))
  const role = firstDefined(
    getAttachmentUnknownOption(attachment, 'referenceRole'),
    kindRoles[mediaIndex],
    allRoles[attachmentIndex],
    kindRole,
    mediaKind === 'image' ? getUnknownOption(options, 'referenceRole') : undefined
  )
  return getSeedanceReferenceRole(role, mediaIndex, mediaKind)
}

const createSeedanceContentEntry = (
  mediaKind: SeedanceReferenceMediaKind,
  url: string,
  role: SeedanceReferenceRole
): Record<string, unknown> => {
  if (mediaKind === 'image') {
    return { type: 'image_url', image_url: { url }, role }
  }
  if (mediaKind === 'video') {
    return { type: 'video_url', video_url: { url }, role }
  }
  return { type: 'audio_url', audio_url: { url }, role }
}

const parseSeedanceAdvancedJson = (
  options: VideoGenerationOptions | undefined
): Record<string, unknown> | undefined => {
  const merged: Record<string, unknown> = {}
  const advancedJson = parseJsonObjectOption(
    options?.advancedJson,
    'advanced JSON',
    'Volcengine Seedance'
  )
  if (advancedJson) {
    Object.assign(merged, advancedJson)
  }

  const requestOverride = parseJsonObjectOption(
    options?.requestOverride,
    'requestOverride',
    'Volcengine Seedance'
  )
  if (requestOverride) {
    Object.assign(merged, requestOverride)
  }

  return Object.keys(merged).length ? merged : undefined
}

const mergeSeedanceAdvancedRequestBody = (
  requestBody: Record<string, unknown>,
  advancedRequestBody: Record<string, unknown> | undefined
): void => {
  if (advancedRequestBody) {
    Object.assign(requestBody, advancedRequestBody)
  }
}

const getSeedanceDuration = (options: VideoGenerationOptions | undefined): number => {
  const duration = getUnknownOption(options, 'duration')
  if (
    duration === -1 ||
    (typeof duration === 'string' && /^(?:adaptive|auto)$/i.test(duration.trim()))
  ) {
    return -1
  }
  return getPositiveIntegerOption(duration, { min: 2, max: 12 }) ?? 5
}

const getSeedanceFrames = (options: VideoGenerationOptions | undefined): number | undefined => {
  const frames = getPositiveIntegerOption(options?.frames, { min: 29, max: 289 })
  if (frames == null) {
    return undefined
  }
  return (frames - 25) % 4 === 0 ? frames : undefined
}

export class VolcengineSeedanceAPICli implements LLMCli {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly modelName: string,
    private readonly fetchImpl?: FetchImpl,
    private readonly pollOptions: { intervalMs?: number; timeoutMs?: number } = {}
  ) {}

  private getFetchImpl(): FetchImpl {
    return this.fetchImpl ?? getDefaultFetchImpl()
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    const videoOptions = params.videoGenerationOptions
    const advancedRequestBody = parseSeedanceAdvancedJson(videoOptions)
    const referenceAttachments = getSeedanceReferenceAttachments(params.messages)
    const firstMediaError = getLatestUserAttachments(params.messages).reduce<string | undefined>(
      (message, attachment) => {
        if (message) {
          return message
        }
        if (getSeedanceAttachmentKind(attachment)) {
          return undefined
        }
        const mimeType = attachment.mimeType?.trim().toLowerCase() || ''
        if (mimeType.startsWith('video/')) {
          return getSeedanceMediaUrlError('video')
        }
        if (mimeType.startsWith('audio/')) {
          return getSeedanceMediaUrlError('audio')
        }
        return undefined
      },
      undefined
    )
    const hasAdvancedContent =
      Array.isArray(advancedRequestBody?.content) && advancedRequestBody.content.length > 0
    const prompt = getPrompt(params.messages, {
      allowEmpty: referenceAttachments.length > 0 || hasAdvancedContent || Boolean(firstMediaError)
    })
    if (firstMediaError) {
      throw new Error(firstMediaError)
    }
    const base = normalizeVolcengineBaseUrl(this.baseUrl)
    const endpoint = `${base}/contents/generations/tasks`
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    }
    const content: Array<Record<string, unknown>> = []
    if (prompt) {
      content.push({ type: 'text', text: prompt })
    }

    for (const reference of referenceAttachments) {
      const mediaUrl = assertSupportedSeedanceMediaAttachment(
        reference.attachment,
        reference.mediaKind
      )
      const role = getSeedanceReferenceRoleForAttachment(
        videoOptions,
        reference.attachment,
        reference.mediaKind,
        reference.mediaIndex,
        reference.attachmentIndex
      )
      content.push(createSeedanceContentEntry(reference.mediaKind, mediaUrl, role))
    }

    const hasImageReference = referenceAttachments.some(
      (reference) => reference.mediaKind === 'image'
    )
    const requestBody: Record<string, unknown> = {
      model: this.modelName,
      content,
      ratio: getSeedanceRatio(videoOptions, hasImageReference),
      duration: getSeedanceDuration(videoOptions),
      watermark: videoOptions?.watermark ?? false
    }
    if (isAllowedStringOption(videoOptions?.resolution, SEEDANCE_RESOLUTIONS)) {
      requestBody.resolution = videoOptions.resolution
    }
    const frames = getSeedanceFrames(videoOptions)
    if (frames != null) {
      requestBody.frames = frames
    }
    if (typeof videoOptions?.generateAudio === 'boolean') {
      requestBody.generate_audio = videoOptions.generateAudio
    }
    if (typeof videoOptions?.returnLastFrame === 'boolean') {
      requestBody.return_last_frame = videoOptions.returnLastFrame
    }
    const callbackUrl = getTrimmedStringOption(videoOptions?.callbackUrl)
    if (callbackUrl) {
      try {
        const parsed = new URL(callbackUrl)
        if (
          (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
          isPrivateOrLocalHttpUrl(parsed)
        ) {
          throw new Error('unsupported URL')
        }
      } catch {
        throw new Error('Volcengine Seedance callback_url must be a valid public http(s) URL.')
      }
      requestBody.callback_url = callbackUrl
    }
    mergeSeedanceAdvancedRequestBody(requestBody, advancedRequestBody)

    const fetchImpl = this.getFetchImpl()
    const sensitiveValues = [this.apiKey]
    const created = await requestJson(
      fetchImpl,
      'Volcengine Seedance',
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: params.signal
      },
      sensitiveValues
    )
    const taskId = getVolcengineTaskId(created)
    if (!taskId) {
      throw new Error(
        `Volcengine Seedance API did not return a task id: ${formatProviderResponseDetails(
          created,
          undefined,
          sensitiveValues
        )}`
      )
    }

    const result = await this.pollTask(
      fetchImpl,
      `${endpoint}/${encodeURIComponent(taskId)}`,
      { Authorization: `Bearer ${this.apiKey}` },
      sensitiveValues,
      params.signal
    )
    const videoUrl = getVolcengineVideoUrl(result)
    if (!videoUrl) {
      throw new Error(
        `Volcengine Seedance task ${taskId} succeeded but did not return a video URL: ${formatProviderResponseDetails(
          result,
          undefined,
          sensitiveValues
        )}`
      )
    }

    return createVideoResult(videoUrl, 'seedance', taskId, {
      provider: 'volcengine',
      taskId,
      response: result
    })
  }

  private async pollTask(
    fetchImpl: FetchImpl,
    endpoint: string,
    headers: Record<string, string>,
    sensitiveValues: readonly string[],
    signal?: AbortSignal
  ): Promise<unknown> {
    const intervalMs = this.pollOptions.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const timeoutMs = this.pollOptions.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    const startedAt = Date.now()

    while (Date.now() - startedAt <= timeoutMs) {
      const data = await requestJson(
        fetchImpl,
        'Volcengine Seedance',
        endpoint,
        {
          method: 'GET',
          headers,
          signal
        },
        sensitiveValues
      )
      const status = getVolcengineStatus(data)
      if (isVolcengineTerminalSuccess(status)) {
        return data
      }
      if (isVolcengineTerminalFailure(status)) {
        throw new Error(
          `Volcengine Seedance task failed: ${formatProviderResponseDetails(
            data,
            getVolcengineFailureMessage(data) || status,
            sensitiveValues
          )}`
        )
      }
      await sleep(intervalMs, signal)
    }

    throw new Error('Volcengine Seedance task polling timed out.')
  }
}
