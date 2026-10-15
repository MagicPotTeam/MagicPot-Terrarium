/**
 * Thin, fail-closed host orchestration contract.
 *
 * This file intentionally has no transport registration, host API access, file access,
 * GPU path, installer path, or document mutation. `unavailable` is the only production
 * receipt this contract can mint by itself; a future adapter must supply independent
 * host identity and epoch evidence before changing that boundary.
 */

export const FIGPLUGIN_HOST_ORCHESTRATION_SCHEMA_VERSION = 1 as const
export const FIGPLUGIN_HOSTS = ['figma', 'photoshop'] as const
export type FigPluginHostId = (typeof FIGPLUGIN_HOSTS)[number]

export const FIGPLUGIN_HOST_RECEIPT_STATUSES = [
  'queued',
  'preview-ready',
  'awaiting-approval',
  'running',
  'completed',
  'cancelled',
  'failed',
  'expired',
  'unavailable'
] as const
export type FigPluginHostReceiptStatus = (typeof FIGPLUGIN_HOST_RECEIPT_STATUSES)[number]

export type FigPluginHostResourceKind = 'document' | 'selection' | 'asset' | 'result'
export type FigPluginHostResourceRef = {
  kind: FigPluginHostResourceKind
  id: string
  epoch?: string
}

export type FigPluginHostPlan = {
  schemaVersion: 1
  mode: 'plan-only'
  selectionRevision: string
  steps: readonly {
    command: 'node.rename'
    targetId: string
    name: string
  }[]
}

export type FigPluginHostPermission = {
  mode: 'read' | 'write'
  approval: 'not-required' | 'pending' | 'granted' | 'denied'
  approvalId?: string
}

export type FigPluginHostCancellation = {
  requested: boolean
  requestedAt?: number
}

export type FigPluginHostRequest = {
  schemaVersion: 1
  projectId: string
  sessionId: string
  taskId: string
  requestId: string
  hostId: FigPluginHostId
  hostEpoch: string
  selectionRefs: readonly FigPluginHostResourceRef[]
  resourceRefs: readonly FigPluginHostResourceRef[]
  plan: FigPluginHostPlan
  permission: FigPluginHostPermission
  cancellation: FigPluginHostCancellation
  timeoutMs: number
}

export type FigPluginHostUsage = {
  inputBytes: number
  outputBytes: number
  inputTokens?: number
  outputTokens?: number
}

export type FigPluginHostError = {
  code:
    | 'INVALID_REQUEST'
    | 'INVALID_PLAN'
    | 'STALE_EPOCH'
    | 'PERMISSION_REQUIRED'
    | 'CANCELLED'
    | 'TIMEOUT'
    | 'HOST_UNAVAILABLE'
    | 'HOST_ERROR'
  retryable: boolean
}

export type FigPluginHostAuditEvent = {
  at: number
  status: FigPluginHostReceiptStatus
  requestId: string
  hostId: FigPluginHostId
  hostEpoch: string
}

export type FigPluginHostReceipt = {
  schemaVersion: 1
  projectId: string
  sessionId: string
  taskId: string
  requestId: string
  hostId: FigPluginHostId
  hostEpoch: string
  status: FigPluginHostReceiptStatus
  availability: 'synthetic' | 'unavailable'
  synthetic: true
  permission: FigPluginHostPermission
  cancellation: FigPluginHostCancellation
  timeoutMs: number
  usage: FigPluginHostUsage
  error?: FigPluginHostError
  audit: readonly FigPluginHostAuditEvent[]
}

export type FigPluginHostValidationError =
  | 'INVALID_REQUEST'
  | 'INVALID_PLAN'
  | 'INVALID_RESOURCE_REF'
  | 'INVALID_PERMISSION'
  | 'INVALID_CANCELLATION'
  | 'INVALID_TIMEOUT'
  | 'OVERSIZED_REQUEST'

export type FigPluginHostValidationResult<T> =
  { ok: true; value: T } | { ok: false; code: FigPluginHostValidationError }

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const requestIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const epochIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const unsafeName = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}\\u061c\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]`,
  'u'
)
const hostSet = new Set<string>(FIGPLUGIN_HOSTS)
const resourceKinds = new Set<string>(['document', 'selection', 'asset', 'result'])
const statuses = new Set<string>(FIGPLUGIN_HOST_RECEIPT_STATUSES)
const encoder = new TextEncoder()

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    return (
      Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
    )
  } catch {
    return false
  }
}

const ownKeysAre = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
) => {
  try {
    const keys = Object.keys(value)
    return (
      required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key))
    )
  } catch {
    return false
  }
}

const ownValue = (value: Record<string, unknown>, key: string): unknown => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

const text = (value: unknown, max: number, pattern?: RegExp): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  encoder.encode(value).byteLength <= max &&
  (pattern === undefined || pattern.test(value))

const safeInteger = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max

const cloneResource = (value: unknown): FigPluginHostResourceRef | undefined => {
  if (!isRecord(value) || !ownKeysAre(value, ['kind', 'id'], ['epoch'])) return undefined
  const kind = ownValue(value, 'kind')
  const id = ownValue(value, 'id')
  const epoch = ownValue(value, 'epoch')
  if (typeof kind !== 'string' || !resourceKinds.has(kind) || !text(id, 128, identifier))
    return undefined
  if (epoch !== undefined && !text(epoch, 128, epochIdentifier)) return undefined
  return epoch === undefined
    ? { kind: kind as FigPluginHostResourceKind, id }
    : { kind: kind as FigPluginHostResourceKind, id, epoch }
}

const clonePlan = (value: unknown): FigPluginHostPlan | undefined => {
  if (
    !isRecord(value) ||
    !ownKeysAre(value, ['schemaVersion', 'mode', 'selectionRevision', 'steps'])
  )
    return undefined
  if (ownValue(value, 'schemaVersion') !== 1 || ownValue(value, 'mode') !== 'plan-only')
    return undefined
  const selectionRevision = ownValue(value, 'selectionRevision')
  const steps = ownValue(value, 'steps')
  if (
    !text(selectionRevision, 128) ||
    !Array.isArray(steps) ||
    steps.length < 1 ||
    steps.length > 20
  )
    return undefined
  const cloned = [] as { command: 'node.rename'; targetId: string; name: string }[]
  const targets = new Set<string>()
  for (const raw of steps) {
    if (
      !isRecord(raw) ||
      !ownKeysAre(raw, ['command', 'targetId', 'name']) ||
      ownValue(raw, 'command') !== 'node.rename'
    )
      return undefined
    const targetId = ownValue(raw, 'targetId')
    const name = ownValue(raw, 'name')
    if (
      !text(targetId, 128) ||
      !text(name, 120) ||
      encoder.encode(name).byteLength > 256 ||
      name.trim().length === 0 ||
      unsafeName.test(name)
    )
      return undefined
    if (targets.has(targetId)) return undefined
    targets.add(targetId)
    cloned.push({ command: 'node.rename', targetId, name })
  }
  return { schemaVersion: 1, mode: 'plan-only', selectionRevision, steps: cloned }
}

const clonePermission = (value: unknown): FigPluginHostPermission | undefined => {
  if (!isRecord(value) || !ownKeysAre(value, ['mode', 'approval'], ['approvalId'])) return undefined
  const mode = ownValue(value, 'mode')
  const approval = ownValue(value, 'approval')
  const approvalId = ownValue(value, 'approvalId')
  if (
    (mode !== 'read' && mode !== 'write') ||
    !['not-required', 'pending', 'granted', 'denied'].includes(String(approval))
  )
    return undefined
  if (mode === 'read' && approval !== 'not-required') return undefined
  if (mode === 'write' && approval === 'not-required') return undefined
  if (approvalId !== undefined && !text(approvalId, 80, requestIdentifier)) return undefined
  if (
    approvalId !== undefined &&
    approval !== 'pending' &&
    approval !== 'granted' &&
    approval !== 'denied'
  )
    return undefined
  if (approval === 'pending' && approvalId === undefined) return undefined
  return approvalId === undefined
    ? ({ mode, approval } as FigPluginHostPermission)
    : ({ mode, approval, approvalId } as FigPluginHostPermission)
}

const cloneCancellation = (value: unknown): FigPluginHostCancellation | undefined => {
  if (!isRecord(value) || !ownKeysAre(value, ['requested'], ['requestedAt'])) return undefined
  const requested = ownValue(value, 'requested')
  const requestedAt = ownValue(value, 'requestedAt')
  if (typeof requested !== 'boolean') return undefined
  if (requested && !safeInteger(requestedAt)) return undefined
  if (!requested && requestedAt !== undefined) return undefined
  if (requested) return { requested: true, requestedAt: requestedAt as number }
  return { requested: false }
}

/** Validates and detaches a request. No defaults, coercion, trimming, or normalization occur. */
export const validateFigPluginHostRequest = (
  raw: unknown
): FigPluginHostValidationResult<FigPluginHostRequest> => {
  if (
    !isRecord(raw) ||
    !ownKeysAre(raw, [
      'schemaVersion',
      'projectId',
      'sessionId',
      'taskId',
      'requestId',
      'hostId',
      'hostEpoch',
      'selectionRefs',
      'resourceRefs',
      'plan',
      'permission',
      'cancellation',
      'timeoutMs'
    ])
  )
    return { ok: false, code: 'INVALID_REQUEST' }
  if (
    ownValue(raw, 'schemaVersion') !== 1 ||
    !text(ownValue(raw, 'projectId'), 160, identifier) ||
    !text(ownValue(raw, 'sessionId'), 160, identifier) ||
    !text(ownValue(raw, 'taskId'), 160, identifier) ||
    !text(ownValue(raw, 'requestId'), 80, requestIdentifier) ||
    typeof ownValue(raw, 'hostId') !== 'string' ||
    !hostSet.has(ownValue(raw, 'hostId') as string) ||
    !text(ownValue(raw, 'hostEpoch'), 128, epochIdentifier)
  )
    return { ok: false, code: 'INVALID_REQUEST' }
  const selectionRefs = ownValue(raw, 'selectionRefs')
  const resourceRefs = ownValue(raw, 'resourceRefs')
  if (
    !Array.isArray(selectionRefs) ||
    !Array.isArray(resourceRefs) ||
    !Number.isInteger(selectionRefs.length) ||
    !Number.isInteger(resourceRefs.length) ||
    selectionRefs.length > 100 ||
    resourceRefs.length > 128
  )
    return { ok: false, code: 'INVALID_RESOURCE_REF' }
  const selection = selectionRefs.map(cloneResource)
  const resources = resourceRefs.map(cloneResource)
  if (
    selection.length !== selectionRefs.length ||
    resources.length !== resourceRefs.length ||
    selection.some((ref) => !ref || ref.kind !== 'selection') ||
    resources.some((ref) => !ref || ref.kind === 'selection')
  )
    return { ok: false, code: 'INVALID_RESOURCE_REF' }
  const plan = clonePlan(ownValue(raw, 'plan'))
  if (!plan) return { ok: false, code: 'INVALID_PLAN' }
  const permission = clonePermission(ownValue(raw, 'permission'))
  if (!permission) return { ok: false, code: 'INVALID_PERMISSION' }
  const cancellation = cloneCancellation(ownValue(raw, 'cancellation'))
  if (!cancellation) return { ok: false, code: 'INVALID_CANCELLATION' }
  const timeoutMs = ownValue(raw, 'timeoutMs')
  if (!safeInteger(timeoutMs, 120_000) || timeoutMs < 100)
    return { ok: false, code: 'INVALID_TIMEOUT' }
  const value: FigPluginHostRequest = {
    schemaVersion: 1,
    projectId: ownValue(raw, 'projectId') as string,
    sessionId: ownValue(raw, 'sessionId') as string,
    taskId: ownValue(raw, 'taskId') as string,
    requestId: ownValue(raw, 'requestId') as string,
    hostId: ownValue(raw, 'hostId') as FigPluginHostId,
    hostEpoch: ownValue(raw, 'hostEpoch') as string,
    selectionRefs: Object.freeze(selection as FigPluginHostResourceRef[]),
    resourceRefs: Object.freeze(resources as FigPluginHostResourceRef[]),
    plan: Object.freeze({
      ...plan,
      steps: Object.freeze(plan.steps.map((step) => Object.freeze({ ...step })))
    }),
    permission: Object.freeze({ ...permission }),
    cancellation: Object.freeze({ ...cancellation }),
    timeoutMs
  }
  try {
    if (encoder.encode(JSON.stringify(value)).byteLength > 64 * 1024)
      return { ok: false, code: 'OVERSIZED_REQUEST' }
  } catch {
    return { ok: false, code: 'OVERSIZED_REQUEST' }
  }
  return { ok: true, value }
}

const audit = (
  subject: Pick<FigPluginHostRequest, 'requestId' | 'hostId' | 'hostEpoch'>,
  status: FigPluginHostReceiptStatus,
  at: number
): FigPluginHostAuditEvent => ({
  at,
  status,
  requestId: subject.requestId,
  hostId: subject.hostId,
  hostEpoch: subject.hostEpoch
})

/** The production-safe endpoint: it records intent and explicit unavailability, never dispatch. */
export const createUnavailableFigPluginHostReceipt = (
  request: FigPluginHostRequest,
  at = Date.now()
): FigPluginHostReceipt =>
  Object.freeze({
    schemaVersion: 1,
    projectId: request.projectId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    requestId: request.requestId,
    hostId: request.hostId,
    hostEpoch: request.hostEpoch,
    status: 'unavailable',
    availability: 'unavailable',
    synthetic: true,
    permission: Object.freeze({ ...request.permission }),
    cancellation: Object.freeze({ ...request.cancellation }),
    timeoutMs: request.timeoutMs,
    usage: Object.freeze({ inputBytes: 0, outputBytes: 0 }),
    error: Object.freeze({ code: 'HOST_UNAVAILABLE', retryable: false }),
    audit: Object.freeze([audit(request, 'unavailable', at)])
  })

/** Validate then stop at the unavailable boundary. This is the only raw-input orchestration path. */
export const prepareUnavailableFigPluginHostReceipt = (
  raw: unknown,
  at = Date.now()
): FigPluginHostValidationResult<FigPluginHostReceipt> => {
  const request = validateFigPluginHostRequest(raw)
  return request.ok
    ? { ok: true, value: createUnavailableFigPluginHostReceipt(request.value, at) }
    : request
}

const allowedTransitions: Record<
  FigPluginHostReceiptStatus,
  readonly FigPluginHostReceiptStatus[]
> = {
  queued: ['preview-ready', 'awaiting-approval', 'cancelled', 'failed', 'expired', 'unavailable'],
  'preview-ready': ['awaiting-approval', 'cancelled', 'failed', 'expired', 'unavailable'],
  'awaiting-approval': ['running', 'cancelled', 'failed', 'expired', 'unavailable'],
  running: ['completed', 'cancelled', 'failed', 'expired'],
  completed: [],
  cancelled: [],
  failed: [],
  expired: [],
  unavailable: []
}

export const canTransitionFigPluginHostReceipt = (
  from: FigPluginHostReceiptStatus,
  to: FigPluginHostReceiptStatus
): boolean => statuses.has(from) && allowedTransitions[from].includes(to)

export const appendFigPluginHostReceiptAudit = (
  receipt: FigPluginHostReceipt,
  status: FigPluginHostReceiptStatus,
  at = Date.now()
): FigPluginHostReceipt | undefined => {
  if (!canTransitionFigPluginHostReceipt(receipt.status, status)) return undefined
  return Object.freeze({
    ...receipt,
    status,
    audit: Object.freeze([...receipt.audit, audit(receipt, status, at)])
  })
}
