import type { ComfyHistory, ObjectInfoMap, Workflow } from './types'
import type { JsonDict } from '@shared/utils/utilTypes'

export const COMFY_INSTANCE_RESOURCE_KIND = 'comfy-instance' as const
export const COMFY_JOB_RESOURCE_KIND = 'comfy-job' as const

export type ComfyInstanceKind = 'local' | 'remote'
export type ComfyInstanceHealthStatus = 'unknown' | 'online' | 'degraded' | 'offline' | 'draining'
export type ComfyInstanceCapabilities = Readonly<{
  tags: readonly string[]
  models: readonly string[]
  customNodes: readonly string[]
  comfyVersion?: string
  objectInfoDigest?: string
}>
export type ComfyInstanceHealth = Readonly<{
  status: ComfyInstanceHealthStatus
  lastCheckedAt?: number
  lastError?: string
}>
export type ComfyInstanceState = Readonly<{
  id: string
  name: string
  origin: string
  kind: ComfyInstanceKind
  enabled: boolean
  maxConcurrency: number
  tags: readonly string[]
  capabilities: ComfyInstanceCapabilities
  health: ComfyInstanceHealth
}>
export type ComfyDispatchTarget =
  | Readonly<{ mode: 'auto' }>
  | Readonly<{ mode: 'specific'; instanceId: string }>
  | Readonly<{ mode: 'tag'; tag: string }>
  | Readonly<{ mode: 'local-only' }>
export type ComfyJobRequirements = Readonly<{
  tags?: readonly string[]
  models?: readonly string[]
  customNodes?: readonly string[]
}>
export type ComfyJobStatus =
  | 'queued'
  | 'leased'
  | 'prepared'
  | 'submitting'
  | 'submitted'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'unknown'
export type ComfyJobState = Readonly<{
  jobId: string
  type: 'qapp-workflow'
  qAppKey?: string
  sessionKey?: string
  clientId: string
  /** Original durable workflow. It is never replaced by leased-instance materialization. */
  workflow: Workflow
  /** Materialized workflow retained only after deferred inputs are prepared for submission. */
  promptWorkflow?: Workflow
  /** Original workflow retained for history/result reruns. */
  historyWorkflow?: Workflow
  extraData?: JsonDict
  cleanupAfterRun?: boolean
  target: ComfyDispatchTarget
  requirements?: ComfyJobRequirements
  status: ComfyJobStatus
  /** Immutable dispatch affinity captured before any Comfy side effect. */
  instanceId?: string
  instanceRouteId?: string
  instanceOrigin?: string
  instanceKind?: ComfyInstanceKind
  legacyDefaultEndpoint?: boolean
  /** Stable idempotency/reconciliation token written before POST /prompt. */
  submissionToken?: string
  /** True once the caller requested cancellation, including prompt-unknown cancellation. */
  cancelRequested?: boolean
  submissionUnknown?: boolean
  requiresManualIntervention?: boolean
  promptId?: string
  attempt: number
  maxAttempts: number
  nextAttemptAt?: number
  /** Process-local lease metadata; restored logical capacity does not depend on its expiry. */
  leaseOwner?: string
  leaseExpiresAt?: number
  result?: ComfyHistory
  failureCode?: string
  failureMessage?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
}>
export type ComfyInstanceProbe = Readonly<{
  capabilities?: Partial<ComfyInstanceCapabilities>
  objectInfo?: ObjectInfoMap
  comfyVersion?: string
}>
