import type {
  ChatMessage,
  LLMImageHistoryPolicy,
  OpenAIImageGenerationAction,
  OpenAIImageGenerationOptions
} from './types'

export const IMAGE_REQUEST_CONTRACT_VERSION = 1 as const
export const IMAGE_REQUEST_CONTRACT_SCHEMA = 'magicpot.image-request.v1' as const

export const IMAGE_REQUEST_MIN_TIMEOUT_MS = 1_000
export const IMAGE_REQUEST_MAX_TIMEOUT_MS = 15 * 60 * 1_000
export const IMAGE_REQUEST_MAX_OPAQUE_REF_LENGTH = 128

/** Provider-facing image operation. `continue` means history/continuation-driven editing. */
export type ImageRequestAction = OpenAIImageGenerationAction | 'continue'

/** Wire-safe opaque references. URLs, paths, session handles, and credentials are forbidden. */
export type ImageHistoryContinuationRefs = {
  historyRef?: string
  continuationRef?: string
}

export type ImageRequestLimits = {
  maxImages: number
  maxBytesPerImage: number
  maxTotalBytes: number
  maxRequestBodyBytes: number
}

/**
 * Non-sensitive image request metadata shared by UI, proxy, and provider clients.
 * Do not put prompts, URLs, file paths, tokens, source labels, or attachment bytes here.
 */
export type ImageRequestPermission = {
  images: boolean
  externalFetch: boolean
}

/** The only control data allowed on the IPC wire. Cancellation remains local. */
export type ImageRequestWireControl = {
  timeoutMs?: number
}

/** Backward-compatible name for the IPC-safe control shape; never includes AbortSignal. */
export type ImageRequestControl = ImageRequestWireControl

/** Local-only control context; never serialize this type as an ImageRequestContract. */
export type ImageRequestLocalControl = {
  signal?: AbortSignal
  timeoutMs?: number
}

export type ImageRequestUsage = {
  inputImages?: number
  inputBytes?: number
  outputImages?: number
  outputBytes?: number
  providerUsage?: Record<string, number>
}

export type ImageRequestError = {
  code: string
  message: string
  retryable?: boolean
  status?: number
}

export type ImageRequestContract = {
  version: typeof IMAGE_REQUEST_CONTRACT_VERSION
  schema: typeof IMAGE_REQUEST_CONTRACT_SCHEMA
  requestId: string
  taskId: string
  action: ImageRequestAction
  history: ImageHistoryContinuationRefs
  imageHistoryPolicy?: LLMImageHistoryPolicy
  limits: ImageRequestLimits
  permission: ImageRequestPermission
  control?: ImageRequestWireControl
  usage?: ImageRequestUsage
  error?: ImageRequestError
}

export type ImageRequestContractInput = {
  requestId: string
  taskId: string
  messages: readonly ChatMessage[]
  imageGenerationOptions?: OpenAIImageGenerationOptions
  imageHistoryPolicy?: LLMImageHistoryPolicy
  history?: ImageHistoryContinuationRefs
  limits: ImageRequestLimits
  permission: ImageRequestPermission
  control?: ImageRequestWireControl
}

export type ImageRequestImageDescriptor = {
  id?: string
  sizeBytes?: number
}

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ACTIONS = new Set<ImageRequestAction>(['auto', 'generate', 'edit', 'continue'])
const HISTORY_KEYS = new Set(['historyRef', 'continuationRef'])
const CONTRACT_KEYS = new Set([
  'version',
  'schema',
  'requestId',
  'taskId',
  'action',
  'history',
  'imageHistoryPolicy',
  'limits',
  'permission',
  'control',
  'usage',
  'error'
])
const LIMIT_KEYS = new Set([
  'maxImages',
  'maxBytesPerImage',
  'maxTotalBytes',
  'maxRequestBodyBytes'
])
const PERMISSION_KEYS = new Set(['images', 'externalFetch'])
const CONTROL_KEYS = new Set(['timeoutMs'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const assertOnlyKeys: (
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string
) => void = (value, allowed, label): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}.`)
  }
}

const assertOpaqueRef: (value: unknown, label: string) => void = (value, label): void => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > IMAGE_REQUEST_MAX_OPAQUE_REF_LENGTH ||
    !OPAQUE_REF_PATTERN.test(value) ||
    /^(?:https?|file|data|blob):/i.test(value)
  ) {
    throw new Error(`${label} must be a bounded opaque reference.`)
  }
}

const assertRequestId: (value: unknown, label: string) => void = (value, label): void => {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded request identifier.`)
  }
}

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const assertLimits: (limits: unknown) => asserts limits is ImageRequestLimits = (limits): void => {
  if (!isRecord(limits)) throw new Error('Image request limits are required.')
  assertOnlyKeys(limits, LIMIT_KEYS, 'Image request limits')
  const maxImages = limits.maxImages
  const maxBytesPerImage = limits.maxBytesPerImage
  const maxTotalBytes = limits.maxTotalBytes
  const maxRequestBodyBytes = limits.maxRequestBodyBytes
  if (
    !isFiniteNonNegativeInteger(maxImages) ||
    !isFiniteNonNegativeInteger(maxBytesPerImage) ||
    !isFiniteNonNegativeInteger(maxTotalBytes) ||
    !isFiniteNonNegativeInteger(maxRequestBodyBytes)
  ) {
    throw new Error('Image request limits must be finite non-negative integers.')
  }
  if (maxBytesPerImage > maxTotalBytes) {
    throw new Error('Per-image byte limit cannot exceed the aggregate byte limit.')
  }
  if (maxTotalBytes > maxRequestBodyBytes) {
    throw new Error('Aggregate image bytes cannot exceed the request body limit.')
  }
}

const assertPermission: (permission: unknown) => asserts permission is ImageRequestPermission = (
  permission
): void => {
  if (!isRecord(permission)) throw new Error('Image request permission is required.')
  assertOnlyKeys(permission, PERMISSION_KEYS, 'Image request permission')
  if (typeof permission.images !== 'boolean' || typeof permission.externalFetch !== 'boolean') {
    throw new Error('Image request permissions must be boolean values.')
  }
}

const assertWireControl: (control: unknown) => void = (control): void => {
  if (control === undefined) return
  if (!isRecord(control)) throw new Error('Image request control must be an object.')
  assertOnlyKeys(control, CONTROL_KEYS, 'Image request control')
  if (control.timeoutMs !== undefined && !isValidImageRequestTimeout(control.timeoutMs)) {
    throw new Error('Image request timeoutMs is outside the allowed range.')
  }
}

const assertHistory: (history: unknown) => asserts history is ImageHistoryContinuationRefs = (
  history
): void => {
  if (!isRecord(history)) throw new Error('Image request history is required.')
  assertOnlyKeys(history, HISTORY_KEYS, 'Image request history')
  for (const [key, value] of Object.entries(history)) {
    if (value !== undefined) assertOpaqueRef(value, `Image request history.${key}`)
  }
}

const countImages = (messages: readonly ChatMessage[]): number =>
  messages.reduce(
    (total, message) =>
      total +
      (message.attachments || []).filter((attachment) => attachment.type === 'image').length,
    0
  )

const imageDescriptorsFromMessages = (
  messages: readonly ChatMessage[]
): ImageRequestImageDescriptor[] =>
  messages.flatMap((message) =>
    (message.attachments || [])
      .filter((attachment) => attachment.type === 'image')
      .map((attachment): ImageRequestImageDescriptor => ({ sizeBytes: attachment.sizeBytes }))
  )

export const validateImageRequestImageDescriptors = (
  descriptors: readonly ImageRequestImageDescriptor[],
  limits: ImageRequestLimits
): { imageCount: number; totalBytes: number } => {
  assertLimits(limits)
  if (descriptors.length > limits.maxImages) {
    throw new Error(`Too many images; the limit is ${limits.maxImages}.`)
  }
  let totalBytes = 0
  for (const descriptor of descriptors) {
    if (!isFiniteNonNegativeInteger(descriptor.sizeBytes)) {
      throw new Error('Image size is required and must be a finite non-negative integer.')
    }
    if (descriptor.sizeBytes > limits.maxBytesPerImage) {
      throw new Error(`Image exceeds the ${limits.maxBytesPerImage}-byte decoded limit.`)
    }
    totalBytes += descriptor.sizeBytes
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`Images exceed the ${limits.maxTotalBytes}-byte aggregate decoded limit.`)
    }
  }
  return { imageCount: descriptors.length, totalBytes }
}

export const isValidImageRequestTimeout = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= IMAGE_REQUEST_MIN_TIMEOUT_MS &&
  value <= IMAGE_REQUEST_MAX_TIMEOUT_MS

export const resolveImageRequestTimeoutMs = (
  contract: Pick<ImageRequestContract, 'control'>,
  fallbackMs = IMAGE_REQUEST_MAX_TIMEOUT_MS
): number => {
  if (!isValidImageRequestTimeout(fallbackMs)) {
    throw new Error('Image request fallback timeout is outside the allowed range.')
  }
  const timeoutMs = contract.control?.timeoutMs ?? fallbackMs
  if (!isValidImageRequestTimeout(timeoutMs)) {
    throw new Error('Image request timeoutMs is outside the allowed range.')
  }
  return timeoutMs
}

export const assertImageRequestBodyBytes = (
  bodyBytes: number,
  limits: Pick<ImageRequestLimits, 'maxRequestBodyBytes'>
): void => {
  if (!isFiniteNonNegativeInteger(bodyBytes)) {
    throw new Error('Image request body size must be a finite non-negative integer.')
  }
  if (!isFiniteNonNegativeInteger(limits.maxRequestBodyBytes)) {
    throw new Error('Image request body limit must be a finite non-negative integer.')
  }
  if (bodyBytes > limits.maxRequestBodyBytes) {
    throw new Error(`Image request body exceeds the ${limits.maxRequestBodyBytes}-byte limit.`)
  }
}

export const assertImageRequestPermission = (
  permission: ImageRequestPermission,
  options: { requiresExternalFetch?: boolean } = {}
): void => {
  assertPermission(permission)
  if (!permission.images) throw new Error('Image generation permission is required.')
  if (options.requiresExternalFetch && !permission.externalFetch) {
    throw new Error('External image fetch permission is required.')
  }
}

export const throwIfImageRequestCancelled = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error(typeof reason === 'string' ? reason : 'The image request was cancelled.')
  error.name = 'AbortError'
  throw error
}

export const validateImageRequestContract = (
  contract: ImageRequestContract,
  messages: readonly ChatMessage[] = []
): ImageRequestContract => {
  if (!isRecord(contract)) throw new Error('Image request contract is required.')
  assertOnlyKeys(contract, CONTRACT_KEYS, 'Image request contract')
  if (contract.version !== IMAGE_REQUEST_CONTRACT_VERSION) {
    throw new Error('Unsupported image request contract version.')
  }
  if (contract.schema !== IMAGE_REQUEST_CONTRACT_SCHEMA) {
    throw new Error('Unsupported image request contract schema.')
  }
  assertRequestId(contract.requestId, 'Image request requestId')
  assertRequestId(contract.taskId, 'Image request taskId')
  if (typeof contract.action !== 'string' || !ACTIONS.has(contract.action)) {
    throw new Error('Unsupported image request action.')
  }
  assertHistory(contract.history)
  assertLimits(contract.limits)
  assertPermission(contract.permission)
  assertWireControl(contract.control)
  assertImageRequestPermission(contract.permission)
  validateImageRequestImageDescriptors(imageDescriptorsFromMessages(messages), contract.limits)
  return contract
}

export const buildImageRequestContract = (
  input: ImageRequestContractInput
): ImageRequestContract => {
  const references = countImages(input.messages) > 0
  const action = input.imageGenerationOptions?.action || (references ? 'continue' : 'generate')
  const contract: ImageRequestContract = {
    version: IMAGE_REQUEST_CONTRACT_VERSION,
    schema: IMAGE_REQUEST_CONTRACT_SCHEMA,
    requestId: input.requestId,
    taskId: input.taskId,
    action,
    history: input.history || {},
    ...(input.imageHistoryPolicy ? { imageHistoryPolicy: input.imageHistoryPolicy } : {}),
    limits: input.limits,
    permission: input.permission,
    ...(input.control ? { control: input.control } : {})
  }
  return validateImageRequestContract(contract, input.messages)
}
