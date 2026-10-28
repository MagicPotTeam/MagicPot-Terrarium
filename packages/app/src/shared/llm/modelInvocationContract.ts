import type { LLMChatTokenUsage } from './types'

/** Stable wire identity for a single model operation. */
export type ModelInvocationIdentity = {
  project: string
  session: string
  task: string
  requestId: string
}

export type ModelInvocationResourceRef = {
  ref: string
  kind: 'attachment' | 'document' | 'image' | 'opaque'
  label?: string
  mediaType?: string
}

/** Capability is explicit; an omitted or denied permission must fail closed. */
export type ModelInvocationPermission = {
  granted: boolean
  capabilities: readonly string[]
  scope?: string
}

export type ModelInvocationCancel = {
  requested: boolean
  reason?: 'caller' | 'timeout' | 'superseded'
}

export type ModelInvocationTimeout = {
  deadlineMs: number
  /** Optional wall-clock deadline supplied by the host. */
  expiresAt?: number
}

export type ModelInvocationError = {
  kind: 'cancelled' | 'timeout' | 'upstream' | 'validation' | 'transport' | 'unknown'
  code?: string
  message: string
  status?: number
  retryable?: boolean
  /** Bounded, redacted diagnostic detail; never a raw provider body or cause object. */
  detail?: string
}

export type ModelInvocationUsage = LLMChatTokenUsage & {
  requestCount?: number
  durationMs?: number
}

export const MODEL_INVOCATION_VERSION = 1 as const
export const MODEL_INVOCATION_SCHEMA = 'magicpot.model-invocation' as const

export type ModelInvocationContract = ModelInvocationIdentity & {
  version: typeof MODEL_INVOCATION_VERSION
  schema: typeof MODEL_INVOCATION_SCHEMA
  resourceRefs: readonly ModelInvocationResourceRef[]
  permission: ModelInvocationPermission
  cancel: ModelInvocationCancel
  timeout: ModelInvocationTimeout
  usage?: ModelInvocationUsage
  error?: ModelInvocationError
}

export type ModelInvocationRequest<Input = unknown> = ModelInvocationContract & {
  input: Input
}

export type ModelInvocationEvent<Output = unknown> = ModelInvocationContract & {
  kind: 'delta' | 'completed' | 'error'
  output?: Output
}

const MAX_DIAGNOSTIC_DETAIL = 4 * 1024
const MAX_IDENTITY_LENGTH = 256
const MAX_RESOURCE_REFS = 128
const MAX_TIMEOUT_MS = 15 * 60 * 1000
const SECRET_OR_INLINE_RESOURCE =
  /^(?:data:|blob:)|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)=/i
const HEADER_UNSAFE = /[\r\n]/

/** The envelope is metadata only; provider clients keep their existing body. */
export const MODEL_INVOCATION_DEFAULT_DEADLINE_MS = 15 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const required = (value: string, field: string): string => {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`Model invocation ${field} is required.`)
  if (normalized.length > MAX_IDENTITY_LENGTH || HEADER_UNSAFE.test(normalized)) {
    throw new TypeError(`Model invocation ${field} is not a safe bounded identifier.`)
  }
  return normalized
}

const normalizeDetail = (value: string | undefined): string | undefined => {
  const detail = value?.trim()
  return detail ? detail.slice(0, MAX_DIAGNOSTIC_DETAIL) : undefined
}

const normalizeResourceRefs = (
  refs: readonly ModelInvocationResourceRef[]
): readonly ModelInvocationResourceRef[] => {
  if (refs.length > MAX_RESOURCE_REFS) {
    throw new TypeError('Model invocation has too many resource refs.')
  }
  return refs.map((resource) => {
    if (!isRecord(resource) || typeof resource.ref !== 'string') {
      throw new TypeError('Model invocation resource ref is invalid.')
    }
    const ref = required(resource.ref, 'resource ref')
    if (SECRET_OR_INLINE_RESOURCE.test(ref)) {
      throw new TypeError('Model invocation resource refs must be opaque and credential-free.')
    }
    if (!['attachment', 'document', 'image', 'opaque'].includes(resource.kind)) {
      throw new TypeError('Model invocation resource ref kind is invalid.')
    }
    return {
      ref,
      kind: resource.kind,
      ...(typeof resource.label === 'string' && resource.label.trim()
        ? { label: resource.label.trim() }
        : {}),
      ...(typeof resource.mediaType === 'string' && resource.mediaType.trim()
        ? { mediaType: resource.mediaType.trim() }
        : {})
    }
  })
}

const normalizeTimeout = (timeout: ModelInvocationTimeout): ModelInvocationTimeout => {
  const deadlineMs = timeout.deadlineMs
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      'Model invocation timeout must be a positive finite number within the allowed bound.'
    )
  }
  if (
    timeout.expiresAt !== undefined &&
    (!Number.isFinite(timeout.expiresAt) || timeout.expiresAt <= 0)
  ) {
    throw new RangeError('Model invocation expiry must be a positive finite timestamp.')
  }
  return {
    deadlineMs,
    ...(timeout.expiresAt !== undefined ? { expiresAt: timeout.expiresAt } : {})
  }
}

const normalizePermission = (permission: ModelInvocationPermission): ModelInvocationPermission => {
  if (permission.granted !== true) throw new Error('Model invocation permission is denied.')
  if (!Array.isArray(permission.capabilities)) {
    throw new TypeError('Model invocation capabilities must be an array.')
  }
  const capabilities = permission.capabilities.map((capability) => {
    if (typeof capability !== 'string') {
      throw new TypeError('Model invocation capability is invalid.')
    }
    return required(capability, 'capability')
  })
  if (capabilities.length > MAX_RESOURCE_REFS) {
    throw new TypeError('Model invocation has too many capabilities.')
  }
  return {
    granted: true,
    capabilities,
    ...(permission.scope?.trim() ? { scope: required(permission.scope, 'permission scope') } : {})
  }
}

const normalizeCancel = (cancel: ModelInvocationCancel): ModelInvocationCancel => {
  if (typeof cancel.requested !== 'boolean') {
    throw new TypeError('Model invocation cancel flag must be boolean.')
  }
  if (cancel.reason !== undefined && !['caller', 'timeout', 'superseded'].includes(cancel.reason)) {
    throw new TypeError('Model invocation cancel reason is invalid.')
  }
  return {
    requested: cancel.requested,
    ...(cancel.reason ? { reason: cancel.reason } : {})
  }
}

/** Build a validated provider-neutral contract without carrying model input. */
export const createModelInvocationContract = (
  identity: ModelInvocationIdentity,
  options: Omit<
    ModelInvocationContract,
    keyof ModelInvocationIdentity | 'version' | 'schema' | 'usage' | 'error'
  >
): ModelInvocationContract => {
  return {
    project: required(identity.project, 'project'),
    session: required(identity.session, 'session'),
    task: required(identity.task, 'task'),
    requestId: required(identity.requestId, 'requestId'),
    version: MODEL_INVOCATION_VERSION,
    schema: MODEL_INVOCATION_SCHEMA,
    resourceRefs: normalizeResourceRefs(options.resourceRefs),
    permission: normalizePermission(options.permission),
    cancel: normalizeCancel(options.cancel),
    timeout: normalizeTimeout(options.timeout)
  }
}

/** Normalize a contract received from an internal boundary before use. */
export const normalizeModelInvocationContract = (value: unknown): ModelInvocationContract => {
  if (!isRecord(value)) throw new TypeError('Model invocation contract must be an object.')
  if (value.version !== MODEL_INVOCATION_VERSION || value.schema !== MODEL_INVOCATION_SCHEMA) {
    throw new TypeError('Model invocation contract version is unsupported.')
  }
  if (!isRecord(value.permission) || !isRecord(value.cancel) || !isRecord(value.timeout)) {
    throw new TypeError('Model invocation contract is incomplete.')
  }
  if (!Array.isArray(value.resourceRefs)) {
    throw new TypeError('Model invocation resource refs must be an array.')
  }
  if (value.resourceRefs.length > MAX_RESOURCE_REFS) {
    throw new TypeError('Model invocation has too many resource refs.')
  }
  return createModelInvocationContract(
    {
      project: typeof value.project === 'string' ? value.project : '',
      session: typeof value.session === 'string' ? value.session : '',
      task: typeof value.task === 'string' ? value.task : '',
      requestId: typeof value.requestId === 'string' ? value.requestId : ''
    },
    {
      resourceRefs: value.resourceRefs as ModelInvocationResourceRef[],
      permission: value.permission as unknown as ModelInvocationPermission,
      cancel: value.cancel as unknown as ModelInvocationCancel,
      timeout: value.timeout as unknown as ModelInvocationTimeout
    }
  )
}

/**
 * Return only bounded correlation metadata for an upstream request. Never send
 * permissions, resources, input, credentials, or diagnostic bodies upstream.
 */
export const buildModelInvocationHeaders = (
  value: ModelInvocationContract
): Record<string, string> => {
  const contract = normalizeModelInvocationContract(value)
  return {
    'X-MagicPot-Invocation-Id': contract.requestId,
    'X-MagicPot-Invocation-Version': String(contract.version),
    'X-MagicPot-Invocation-Schema': contract.schema
  }
}

export const createModelInvocationRequest = <Input>(
  identity: ModelInvocationIdentity,
  input: Input,
  options: Omit<ModelInvocationContract, keyof ModelInvocationIdentity | 'version' | 'schema'>
): ModelInvocationRequest<Input> => {
  const contract = createModelInvocationContract(identity, options)
  return {
    ...contract,
    input
  }
}

export const normalizeModelInvocationError = (
  error: ModelInvocationError
): ModelInvocationError => ({
  kind: error.kind,
  ...(error.code?.trim() ? { code: error.code.trim() } : {}),
  message: required(error.message, 'error message'),
  ...(error.status !== undefined ? { status: error.status } : {}),
  ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
  ...(normalizeDetail(error.detail) ? { detail: normalizeDetail(error.detail) } : {})
})

/** Rejects stale stream events before they can update a switched chat session. */
export const isCurrentModelInvocation = (
  event: Pick<
    ModelInvocationContract,
    'project' | 'session' | 'task' | 'requestId' | 'version' | 'schema'
  >,
  current: Pick<
    ModelInvocationContract,
    'project' | 'session' | 'task' | 'requestId' | 'version' | 'schema'
  >
): boolean =>
  event.project === current.project &&
  event.session === current.session &&
  event.task === current.task &&
  event.requestId === current.requestId &&
  event.version === current.version &&
  event.schema === current.schema

export const toModelInvocationError = (error: unknown): ModelInvocationError => {
  if (error && typeof error === 'object' && 'kind' in error && 'message' in error) {
    const value = error as Partial<ModelInvocationError>
    if (typeof value.kind === 'string' && typeof value.message === 'string') {
      return normalizeModelInvocationError({
        kind: value.kind as ModelInvocationError['kind'],
        message: value.message,
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
        ...(typeof value.status === 'number' ? { status: value.status } : {}),
        ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
        ...(typeof value.detail === 'string' ? { detail: value.detail } : {})
      })
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'unknown', message: message.trim() || 'Model invocation failed.' }
}
