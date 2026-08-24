import type { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import type { BatchManifest, BatchWorkspacePaths } from './svcFs'
import type {
  ComfyDispatchTarget,
  ComfyInstanceCapabilities,
  ComfyInstanceState
} from '../comfy/dispatch'
import type { Workflow } from '../comfy/types'
import { ServiceValidationError } from './apiUtils/serviceValidation'

export type ComfyInstanceProfile = Readonly<{
  revision: number
  state: ComfyInstanceState
}>
export type PutComfyInstanceReq = Readonly<{
  id: string
  name: string
  origin: string
  /** Public instance registration is remote-only; managed local entries are created internally. */
  kind?: 'remote'
  enabled?: boolean
  maxConcurrency?: 1
  tags?: readonly string[]
}>
export type UpdateComfyInstanceReq = Readonly<{
  id: string
  expectedRevision: number
  patch: Readonly<{
    name?: string
    origin?: string
    enabled?: boolean
    maxConcurrency?: 1
    tags?: readonly string[]
  }>
}>
export type RemoveComfyInstanceReq = Readonly<{ id: string; expectedRevision: number }>
export type ProbeComfyInstanceReq = Readonly<{ id: string }>
export type ProbeComfyInstanceResp = Readonly<{
  profile: ComfyInstanceProfile
  capabilities: ComfyInstanceCapabilities
  queueRunning: number
  queuePending: number
}>

export type ComfyBatchStatus =
  'queued' | 'running' | 'paused' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed'
export type ComfyBatchBinding = Readonly<{
  inputNodeId: string
  inputField: string
  outputNodeId: string
  outputIndex?: number
}>
export type ComfyBatchItemSummary = Readonly<{
  relativeInputPath: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  instanceId?: string
  /** Immutable endpoint captured before upload and prompt submission. */
  instanceOrigin?: string
  instanceKind?: ComfyInstanceState['kind']
  promptId?: string
  attempts: number
  error?: string
  /** Durable intent written before POST /prompt. */
  submissionToken?: string
  submissionState?: 'prepared' | 'submitted' | 'unknown'
  /** Automatic dispatch is blocked when accepting another prompt could duplicate work. */
  requiresManualIntervention?: boolean
}>
export type ComfyBatchState = Readonly<{
  batchId: string
  status: ComfyBatchStatus
  sourceRoot: string
  workflow: Workflow
  binding: ComfyBatchBinding
  target: ComfyDispatchTarget
  workspace: BatchWorkspacePaths
  manifest: BatchManifest
  items: readonly ComfyBatchItemSummary[]
  createdAt: string
  updatedAt: string
  errorLogPath: string
}>
export type StartComfyBatchReq = Readonly<{
  sourceRoot: string
  userAuthorized: true
  workflow: Workflow
  binding: ComfyBatchBinding
  target?: ComfyDispatchTarget
}>
export type BatchIdReq = Readonly<{ batchId: string }>
export type ResolveComfyBatchSubmissionReq = Readonly<{
  batchId: string
  relativeInputPath: string
  outcome: 'submitted' | 'not-submitted' | 'cancelled'
  promptId?: string
}>

const validationError = (method: string, field: string, message: string): never => {
  throw new ServiceValidationError(`svcComfyBatch.${method} ${field}`, [
    { path: field.split('.'), message, code: 'invalid_type' }
  ])
}
const requireRecord = (
  value: unknown,
  method: string,
  field = 'request'
): Record<string, unknown> => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return validationError(method, field, 'Expected an object')
}
const requireExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  method: string,
  field = 'request'
): void => {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key))
  if (unexpected !== undefined) {
    validationError(method, `${field}.${unexpected}`, 'Unexpected field')
  }
}
const requireString = (value: unknown, method: string, field: string): string => {
  if (typeof value === 'string' && value.trim() === value && value.length > 0) return value
  return validationError(method, field, 'Expected a trimmed non-empty string')
}
const requireRevision = (value: unknown, method: string): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  return validationError(method, 'expectedRevision', 'Expected a non-negative integer')
}
const requireTags = (value: unknown, method: string, field: string): readonly string[] => {
  if (!Array.isArray(value)) return validationError(method, field, 'Expected an array')
  const tags = value.map((tag, index) => requireString(tag, method, `${field}.${index}`))
  if (new Set(tags).size !== tags.length) {
    return validationError(method, field, 'Expected unique values')
  }
  return tags
}
const isUnsafeLiteralHostname = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(host)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    return (
      octets.every((octet) => octet === 0) ||
      octets[0] === 10 ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      octets[0] >= 224 ||
      host === '100.100.100.200' ||
      host === '192.0.0.192'
    )
  }
  if (host === '::' || host === 'fd00:ec2::254' || /^fe[89ab]/u.test(host) || /^ff/u.test(host)) {
    return true
  }
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(host)
  if (!mapped) return false
  const high = Number.parseInt(mapped[1], 16)
  const low = Number.parseInt(mapped[2], 16)
  return isUnsafeLiteralHostname(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`)
}
const requireOrigin = (value: unknown, method: string, field: string): string => {
  const input = requireString(value, method, field)
  if (!/^https?:\/\/[^/?#\\]+\/?$/iu.test(input)) {
    return validationError(method, field, 'Expected an HTTP(S) origin without path, query or hash')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return validationError(method, field, 'Expected a valid HTTP(S) origin')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    isUnsafeLiteralHostname(url.hostname)
  ) {
    return validationError(method, field, 'Expected a safe HTTP(S) origin')
  }
  return url.href
}
const validateEmptyReq =
  (method: string) =>
  (value: unknown): Record<string, never> => {
    const req = requireRecord(value, method)
    requireExactKeys(req, [], method)
    return {}
  }
const validatePutInstanceReq = (value: unknown): PutComfyInstanceReq => {
  const method = 'putInstance'
  const req = requireRecord(value, method)
  requireExactKeys(
    req,
    ['id', 'name', 'origin', 'kind', 'enabled', 'maxConcurrency', 'tags'],
    method
  )
  if ('maxConcurrency' in req && req.maxConcurrency !== 1) {
    return validationError(method, 'maxConcurrency', 'maxConcurrency is fixed at 1')
  }
  if ('enabled' in req && typeof req.enabled !== 'boolean') {
    return validationError(method, 'enabled', 'Expected a boolean')
  }
  if ('kind' in req && req.kind !== 'remote') {
    return validationError(method, 'kind', 'Public instance registration is remote-only')
  }
  return {
    id: requireString(req.id, method, 'id'),
    name: requireString(req.name, method, 'name'),
    origin: requireOrigin(req.origin, method, 'origin'),
    ...('kind' in req ? { kind: 'remote' as const } : {}),
    ...('enabled' in req ? { enabled: req.enabled as boolean } : {}),
    maxConcurrency: 1,
    ...('tags' in req ? { tags: requireTags(req.tags, method, 'tags') } : {})
  }
}
const validateUpdateInstanceReq = (value: unknown): UpdateComfyInstanceReq => {
  const method = 'updateInstance'
  const req = requireRecord(value, method)
  requireExactKeys(req, ['id', 'expectedRevision', 'patch'], method)
  const patch = requireRecord(req.patch, method, 'patch')
  requireExactKeys(patch, ['name', 'origin', 'enabled', 'maxConcurrency', 'tags'], method, 'patch')
  if (Object.keys(patch).length === 0) {
    return validationError(method, 'patch', 'Expected at least one field')
  }
  if ('enabled' in patch && typeof patch.enabled !== 'boolean') {
    return validationError(method, 'patch.enabled', 'Expected a boolean')
  }
  if ('maxConcurrency' in patch && patch.maxConcurrency !== 1) {
    return validationError(method, 'patch.maxConcurrency', 'maxConcurrency is fixed at 1')
  }
  return {
    id: requireString(req.id, method, 'id'),
    expectedRevision: requireRevision(req.expectedRevision, method),
    patch: {
      ...('name' in patch ? { name: requireString(patch.name, method, 'patch.name') } : {}),
      ...('origin' in patch ? { origin: requireOrigin(patch.origin, method, 'patch.origin') } : {}),
      ...('enabled' in patch ? { enabled: patch.enabled as boolean } : {}),
      ...('maxConcurrency' in patch ? { maxConcurrency: 1 as const } : {}),
      ...('tags' in patch ? { tags: requireTags(patch.tags, method, 'patch.tags') } : {})
    }
  }
}
const validateRemoveInstanceReq = (value: unknown): RemoveComfyInstanceReq => {
  const method = 'removeInstance'
  const req = requireRecord(value, method)
  requireExactKeys(req, ['id', 'expectedRevision'], method)
  return {
    id: requireString(req.id, method, 'id'),
    expectedRevision: requireRevision(req.expectedRevision, method)
  }
}
const validateProbeInstanceReq = (value: unknown): ProbeComfyInstanceReq => {
  const method = 'probeInstance'
  const req = requireRecord(value, method)
  requireExactKeys(req, ['id'], method)
  return { id: requireString(req.id, method, 'id') }
}
const validateBatchIdReq =
  (method: string) =>
  (value: unknown): BatchIdReq => {
    const req = requireRecord(value, method)
    requireExactKeys(req, ['batchId'], method)
    return { batchId: requireString(req.batchId, method, 'batchId') }
  }
const validateResolveSubmissionReq = (value: unknown): ResolveComfyBatchSubmissionReq => {
  const method = 'resolveSubmission'
  const req = requireRecord(value, method)
  requireExactKeys(req, ['batchId', 'relativeInputPath', 'outcome', 'promptId'], method)
  if (!['submitted', 'not-submitted', 'cancelled'].includes(String(req.outcome))) {
    return validationError(method, 'outcome', 'Expected a supported resolution outcome')
  }
  const outcome = req.outcome as ResolveComfyBatchSubmissionReq['outcome']
  if (outcome === 'submitted') {
    return {
      batchId: requireString(req.batchId, method, 'batchId'),
      relativeInputPath: requireString(req.relativeInputPath, method, 'relativeInputPath'),
      outcome,
      promptId: requireString(req.promptId, method, 'promptId')
    }
  }
  if ('promptId' in req) {
    return validationError(method, 'promptId', 'promptId is only valid for a submitted outcome')
  }
  return {
    batchId: requireString(req.batchId, method, 'batchId'),
    relativeInputPath: requireString(req.relativeInputPath, method, 'relativeInputPath'),
    outcome
  }
}

const validateDispatchTarget = (value: unknown, method: string): ComfyDispatchTarget => {
  const target = requireRecord(value, method, 'target')
  switch (target.mode) {
    case 'auto':
    case 'local-only':
      requireExactKeys(target, ['mode'], method, 'target')
      return { mode: target.mode }
    case 'specific':
      requireExactKeys(target, ['mode', 'instanceId'], method, 'target')
      return {
        mode: 'specific',
        instanceId: requireString(target.instanceId, method, 'target.instanceId')
      }
    case 'tag':
      requireExactKeys(target, ['mode', 'tag'], method, 'target')
      return { mode: 'tag', tag: requireString(target.tag, method, 'target.tag') }
    default:
      return validationError(method, 'target.mode', 'Expected a supported dispatch target mode')
  }
}
const validateStartBatchReq = (value: unknown): StartComfyBatchReq => {
  const method = 'startBatch'
  const req = requireRecord(value, method)
  requireExactKeys(req, ['sourceRoot', 'userAuthorized', 'workflow', 'binding', 'target'], method)
  if (req.userAuthorized !== true)
    return validationError(method, 'userAuthorized', 'Expected explicit user authorization')
  const workflow = requireRecord(req.workflow, method, 'workflow') as Workflow
  const binding = requireRecord(req.binding, method, 'binding')
  requireExactKeys(
    binding,
    ['inputNodeId', 'inputField', 'outputNodeId', 'outputIndex'],
    method,
    'binding'
  )
  return {
    sourceRoot: requireString(req.sourceRoot, method, 'sourceRoot'),
    userAuthorized: true,
    workflow,
    binding: {
      inputNodeId: requireString(binding.inputNodeId, method, 'binding.inputNodeId'),
      inputField: requireString(binding.inputField, method, 'binding.inputField'),
      outputNodeId: requireString(binding.outputNodeId, method, 'binding.outputNodeId'),
      ...(!('outputIndex' in binding)
        ? {}
        : Number.isSafeInteger(binding.outputIndex) && Number(binding.outputIndex) >= 0
          ? { outputIndex: Number(binding.outputIndex) }
          : validationError(method, 'binding.outputIndex', 'Expected a non-negative integer'))
    },
    ...(!('target' in req) ? {} : { target: validateDispatchTarget(req.target, method) })
  }
}

export type ComfyBatchSvc = {
  listInstances(req: Record<string, never>): Promise<readonly ComfyInstanceProfile[]>
  putInstance(req: PutComfyInstanceReq): Promise<ComfyInstanceProfile>
  updateInstance(req: UpdateComfyInstanceReq): Promise<ComfyInstanceProfile>
  removeInstance(req: RemoveComfyInstanceReq): Promise<Record<string, never>>
  probeInstance(req: ProbeComfyInstanceReq): Promise<ProbeComfyInstanceResp>
  startBatch(req: StartComfyBatchReq): Promise<ComfyBatchState>
  getBatch(req: BatchIdReq): Promise<ComfyBatchState>
  pauseBatch(req: BatchIdReq): Promise<ComfyBatchState>
  resumeBatch(req: BatchIdReq): Promise<ComfyBatchState>
  cancelBatch(req: BatchIdReq): Promise<ComfyBatchState>
  retryFailed(req: BatchIdReq): Promise<ComfyBatchState>
  resolveSubmission(req: ResolveComfyBatchSubmissionReq): Promise<ComfyBatchState>
}

export const comfyBatchSvcDef: ServiceDefSheet<ComfyBatchSvc> = {
  listInstances: { type: 'unary', request: validateEmptyReq('listInstances') },
  putInstance: { type: 'unary', request: validatePutInstanceReq },
  updateInstance: { type: 'unary', request: validateUpdateInstanceReq },
  removeInstance: { type: 'unary', request: validateRemoveInstanceReq },
  probeInstance: { type: 'unary', request: validateProbeInstanceReq },
  startBatch: { type: 'unary', request: validateStartBatchReq },
  getBatch: { type: 'unary', request: validateBatchIdReq('getBatch') },
  pauseBatch: { type: 'unary', request: validateBatchIdReq('pauseBatch') },
  resumeBatch: { type: 'unary', request: validateBatchIdReq('resumeBatch') },
  cancelBatch: { type: 'unary', request: validateBatchIdReq('cancelBatch') },
  retryFailed: { type: 'unary', request: validateBatchIdReq('retryFailed') },
  resolveSubmission: { type: 'unary', request: validateResolveSubmissionReq }
}
