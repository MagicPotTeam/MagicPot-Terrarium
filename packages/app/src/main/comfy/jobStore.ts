import { canonicalPolicyJson, sha256PolicyText } from '../../shared/magicAgentPlatform2/policy'
import type {
  ComfyDispatchTarget,
  ComfyJobRequirements,
  ComfyJobState,
  ComfyJobStatus
} from '@shared/comfy/dispatch'
import { COMFY_JOB_RESOURCE_KIND } from '@shared/comfy/dispatch'
import type { ComfyHistory, Workflow } from '@shared/comfy/types'
import type { JsonDict } from '@shared/utils/utilTypes'
import type {
  MagicAgentEventStore,
  ResourceCursor,
  StoredResource
} from '../magicAgentPlatform2/persistence/eventStore'

export const COMFY_JOB_KIND = COMFY_JOB_RESOURCE_KIND
// Deferred inline/file envelopes are bounded by the shared 256 MiB full-file IPC cap. Keep
// enough room for JSON/URI overhead while retaining the same security ceiling for persisted jobs.
export const MAX_COMFY_JOB_WORKFLOW_BYTES = 256 * 1024 * 1024
export const MAX_COMFY_JOB_RESULT_BYTES = 256 * 1024 * 1024

const transitions: Readonly<Record<ComfyJobStatus, readonly ComfyJobStatus[]>> = {
  queued: ['leased', 'cancelled', 'failed', 'unknown'],
  leased: [
    'prepared',
    'submitting',
    'submitted',
    'cancel_requested',
    'cancelled',
    'failed',
    'unknown'
  ],
  prepared: ['submitting', 'submitted', 'cancel_requested', 'cancelled', 'failed', 'unknown'],
  submitting: ['submitted', 'cancel_requested', 'cancelled', 'failed', 'unknown'],
  submitted: ['running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'unknown'],
  running: ['cancel_requested', 'succeeded', 'failed', 'cancelled', 'unknown'],
  cancel_requested: ['cancelled', 'succeeded', 'failed', 'unknown'],
  succeeded: [],
  failed: ['queued'],
  cancelled: [],
  // Unknown is deliberately not automatically retryable. Manual resolution is the only path
  // back to queued/submitted/cancelled and must preserve the captured authority until then.
  unknown: ['prepared', 'submitted', 'cancel_requested', 'cancelled', 'succeeded', 'failed']
}
function assertTrimmed(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim())
    throw new Error(`${field} must be a trimmed non-empty string.`)
}
const assertTime = (value: number, field: string): void => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative.`)
}
const assertRevision = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid expected revision.')
}
const assertPositive = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be positive.`)
}
const digest = (value: unknown): string => sha256PolicyText(canonicalPolicyJson(value as never))
const assertBounded = (value: unknown, maxBytes: number, field: string): void => {
  let size: number
  try {
    size = Buffer.byteLength(canonicalPolicyJson(value as never), 'utf8')
  } catch (error) {
    throw new Error(`${field} must be JSON serializable.`, { cause: error })
  }
  if (size > maxBytes) throw new Error(`${field} exceeds ${maxBytes} bytes.`)
}
const validateTarget = (target: ComfyDispatchTarget): void => {
  if (!target || typeof target !== 'object' || !('mode' in target))
    throw new Error('Invalid dispatch target.')
  if (target.mode === 'auto' || target.mode === 'local-only') return
  if (target.mode === 'specific') {
    assertTrimmed(target.instanceId, 'Target instance id')
  } else if (target.mode === 'tag') {
    assertTrimmed(target.tag, 'Target tag')
  } else {
    throw new Error('Invalid dispatch target mode.')
  }
}
const validateRequirements = (requirements: ComfyJobRequirements | undefined): void => {
  for (const [field, values] of Object.entries(requirements ?? {}))
    if (values !== undefined) {
      values.forEach((value) => assertTrimmed(value, `Requirement ${field}`))
      if (new Set(values).size !== values.length)
        throw new Error(`Requirement ${field} values must be unique.`)
    }
}
const validateState = (state: ComfyJobState): void => {
  assertTrimmed(state.jobId, 'Comfy job id')
  assertTrimmed(state.clientId, 'Comfy job client id')
  if (
    typeof state.maxAttempts !== 'number' ||
    !Number.isSafeInteger(state.maxAttempts) ||
    state.maxAttempts < 1
  )
    throw new Error('Invalid maxAttempts.')
  if (state.type !== 'qapp-workflow' || !Object.hasOwn(transitions, state.status))
    throw new Error('Invalid Comfy job state.')
  if (
    [
      'leased',
      'prepared',
      'submitting',
      'submitted',
      'running',
      'cancel_requested',
      'unknown'
    ].includes(state.status) &&
    (!state.instanceId || !state.instanceRouteId || !state.instanceOrigin || !state.instanceKind)
  )
    throw new Error('Active Comfy jobs require complete captured endpoint authority.')
  if (
    ['prepared', 'submitting'].includes(state.status) &&
    (!state.submissionToken || !state.promptWorkflow || !state.historyWorkflow)
  )
    throw new Error('Prepared/submitting jobs require materialized workflows and submission token.')
  if (['submitted', 'running'].includes(state.status) && !state.promptId)
    throw new Error('Submitted jobs require a prompt id.')
  if (
    state.status === 'cancel_requested' &&
    (!state.instanceRouteId ||
      !state.instanceOrigin ||
      !state.instanceKind ||
      state.cancelRequested !== true ||
      (state.submissionToken === undefined && state.promptId === undefined))
  )
    throw new Error(
      'Cancellation requires captured endpoint authority, cancellation intent, and token or prompt id.'
    )
  if (state.status === 'unknown' && !state.requiresManualIntervention)
    throw new Error('Unknown jobs require manual intervention.')
  if (state.submissionToken !== undefined && state.submissionToken !== state.jobId)
    throw new Error('Comfy submission token must match the durable job id.')
  if (
    ['prepared', 'submitting', 'submitted', 'running', 'cancel_requested', 'unknown'].includes(
      state.status
    ) &&
    state.instanceRouteId &&
    state.instanceOrigin &&
    state.instanceKind
  ) {
    // Captured route metadata is immutable authority. Its syntax is intentionally bounded here;
    // the route store remains the source of endpoint policy validation.
    if (state.instanceRouteId.length > 256 || state.instanceOrigin.length > 2048)
      throw new Error('Captured Comfy route metadata exceeds bounds.')
  }
  if (state.status === 'succeeded' && state.result === undefined)
    throw new Error('Succeeded jobs require a result.')
  if (state.status === 'failed' && (!state.failureCode || !state.failureMessage))
    throw new Error('Failed jobs require failure details.')
  validateTarget(state.target)
  validateRequirements(state.requirements)
  if (
    !Number.isSafeInteger(state.attempt) ||
    state.attempt < 0 ||
    state.attempt > state.maxAttempts
  )
    throw new Error('Invalid Comfy job attempt.')
  assertPositive(state.maxAttempts, 'Comfy job maxAttempts')
  assertTime(state.createdAt, 'createdAt')
  assertTime(state.updatedAt, 'updatedAt')
  for (const [field, value] of Object.entries({
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    nextAttemptAt: state.nextAttemptAt,
    leaseExpiresAt: state.leaseExpiresAt
  }))
    if (value !== undefined) assertTime(value, field)
  for (const [field, value] of Object.entries({
    instanceId: state.instanceId,
    instanceRouteId: state.instanceRouteId,
    instanceOrigin: state.instanceOrigin,
    instanceKind: state.instanceKind,
    submissionToken: state.submissionToken,
    promptId: state.promptId,
    leaseOwner: state.leaseOwner,
    failureCode: state.failureCode,
    failureMessage: state.failureMessage
  }))
    if (value !== undefined) assertTrimmed(value, field)
  if (state.instanceKind !== undefined && !['local', 'remote'].includes(state.instanceKind))
    throw new Error('Invalid captured Comfy instance kind.')
  if (state.cancelRequested !== undefined && typeof state.cancelRequested !== 'boolean')
    throw new Error('Invalid Comfy cancellation flag.')
  if (state.cleanupAfterRun !== undefined && typeof state.cleanupAfterRun !== 'boolean')
    throw new Error('Invalid Comfy cleanupAfterRun flag.')
  if (state.submissionUnknown !== undefined && typeof state.submissionUnknown !== 'boolean')
    throw new Error('Invalid Comfy submission unknown flag.')
  if (
    state.requiresManualIntervention !== undefined &&
    typeof state.requiresManualIntervention !== 'boolean'
  )
    throw new Error('Invalid Comfy manual intervention flag.')
  assertBounded(state.workflow, MAX_COMFY_JOB_WORKFLOW_BYTES, 'Comfy workflow')
  if (state.promptWorkflow !== undefined)
    assertBounded(state.promptWorkflow, MAX_COMFY_JOB_WORKFLOW_BYTES, 'Comfy prompt workflow')
  if (state.historyWorkflow !== undefined)
    assertBounded(state.historyWorkflow, MAX_COMFY_JOB_WORKFLOW_BYTES, 'Comfy history workflow')
  if (state.extraData !== undefined)
    assertBounded(state.extraData, MAX_COMFY_JOB_WORKFLOW_BYTES, 'Comfy extra data')
  if (state.result !== undefined)
    assertBounded(state.result, MAX_COMFY_JOB_RESULT_BYTES, 'Comfy result')
}
const validateStoredResource = (resource: StoredResource<ComfyJobState>): void => {
  if (resource.kind !== COMFY_JOB_RESOURCE_KIND || resource.id !== resource.state.jobId)
    throw new Error('Corrupt Comfy job resource identity.')
  if (!Number.isSafeInteger(resource.revision) || resource.revision < 0)
    throw new Error('Corrupt Comfy job resource revision.')
  validateState(resource.state)
}

const event = (
  id: string,
  type: string,
  at: number,
  revision: number,
  payload: Record<string, unknown>
) => ({
  protocolVersion: '2.0.0',
  id: `comfy-job:${id}:${type}:${at}:${revision}`,
  type,
  createdAt: at,
  payload: { ...payload, resourceKind: COMFY_JOB_RESOURCE_KIND, resourceId: id, revision },
  envelopeKind: 'event' as const,
  streamId: `comfy-job:${id}:stream`,
  sequence: revision
})
const clearLease = (state: ComfyJobState): ComfyJobState => {
  const { leaseOwner: _owner, leaseExpiresAt: _expires, ...rest } = state
  return rest
}

export type CreateComfyJobInput = Readonly<{
  jobId: string
  workflow: Workflow
  clientId: string
  target?: ComfyDispatchTarget
  requirements?: ComfyJobRequirements
  qAppKey?: string
  sessionKey?: string
  extraData?: JsonDict
  cleanupAfterRun?: boolean
  maxAttempts?: number
  createdAt: number
  idempotencyKey: string
}>
type TransitionInput = Readonly<{
  jobId: string
  expectedRevision: number
  status: ComfyJobStatus
  at: number
  idempotencyKey: string
  patch?: Partial<
    Pick<
      ComfyJobState,
      | 'instanceId'
      | 'instanceRouteId'
      | 'instanceOrigin'
      | 'instanceKind'
      | 'legacyDefaultEndpoint'
      | 'submissionToken'
      | 'cancelRequested'
      | 'submissionUnknown'
      | 'requiresManualIntervention'
      | 'promptWorkflow'
      | 'historyWorkflow'
      | 'promptId'
      | 'attempt'
      | 'nextAttemptAt'
      | 'leaseOwner'
      | 'leaseExpiresAt'
      | 'result'
      | 'failureCode'
      | 'failureMessage'
      | 'startedAt'
    >
  >
}>

export class ComfyJobStore {
  constructor(private readonly eventStore: MagicAgentEventStore) {}
  list(): readonly StoredResource<ComfyJobState>[] {
    const resources: StoredResource<ComfyJobState>[] = []
    let after: ResourceCursor | undefined
    for (;;) {
      const page = this.eventStore.listResources({
        kind: COMFY_JOB_RESOURCE_KIND,
        ...(after ? { after } : {}),
        limit: 1_000
      }) as StoredResource<ComfyJobState>[]
      for (const resource of page) {
        validateStoredResource(resource)
        resources.push(resource)
      }
      if (page.length < 1_000) return resources
      const last = page[page.length - 1]
      if (!last) throw new Error('Comfy job store pagination returned an empty tail.')
      after = {
        updatedAt: last.updatedAt,
        resourceKind: last.kind,
        resourceId: last.id
      }
    }
  }
  get(jobId: string): StoredResource<ComfyJobState> | undefined {
    assertTrimmed(jobId, 'Comfy job id')
    const resource = this.eventStore.getResource(COMFY_JOB_RESOURCE_KIND, jobId) as
      StoredResource<ComfyJobState> | undefined
    if (resource) validateStoredResource(resource)
    return resource
  }
  create(input: CreateComfyJobInput): StoredResource<ComfyJobState> {
    assertTrimmed(input.jobId, 'Comfy job id')
    assertTrimmed(input.clientId, 'Comfy job client id')
    assertTrimmed(input.idempotencyKey, 'Job idempotency key')
    assertTime(input.createdAt, 'createdAt')
    const maxAttempts = input.maxAttempts ?? 1
    assertPositive(maxAttempts, 'maxAttempts')
    const target = input.target ?? { mode: 'auto' as const }
    validateTarget(target)
    validateRequirements(input.requirements)
    assertBounded(input.workflow, MAX_COMFY_JOB_WORKFLOW_BYTES, 'Comfy workflow')
    if (input.extraData !== undefined)
      assertBounded(input.extraData, MAX_COMFY_JOB_WORKFLOW_BYTES, 'Comfy extra data')
    const state: ComfyJobState = {
      jobId: input.jobId,
      type: 'qapp-workflow',
      ...(input.qAppKey === undefined ? {} : { qAppKey: input.qAppKey }),
      ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey }),
      clientId: input.clientId,
      workflow: input.workflow,
      ...(input.extraData === undefined ? {} : { extraData: input.extraData }),
      ...(input.cleanupAfterRun === undefined ? {} : { cleanupAfterRun: input.cleanupAfterRun }),
      target,
      ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
      status: 'queued',
      attempt: 0,
      maxAttempts,
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    }
    validateState(state)
    const command = {
      ...input,
      workflowDigest: digest(input.workflow),
      extraDataDigest: input.extraData === undefined ? null : digest(input.extraData)
    }
    const commandDigest = digest(command)
    const key = `comfy-job:${state.jobId}:create:${input.idempotencyKey}`
    const replay = this.findMutation(state.jobId, key)
    if (replay) {
      this.assertReplay(replay, 'comfy-job.created', commandDigest)
      return replay.resource as StoredResource<ComfyJobState>
    }
    if (this.get(state.jobId)) throw new Error('Comfy job already exists.')
    return this.eventStore.mutateResource<ComfyJobState>({
      operation: 'create',
      kind: COMFY_JOB_RESOURCE_KIND,
      id: state.jobId,
      state,
      createdAt: input.createdAt,
      idempotencyKey: key,
      event: event(state.jobId, 'comfy-job.created', input.createdAt, 0, { commandDigest })
    }).resource
  }
  private transition(
    input: TransitionInput,
    options: Readonly<{ allowSameStatus?: boolean }> = {}
  ): StoredResource<ComfyJobState> {
    assertTrimmed(input.jobId, 'Comfy job id')
    assertTrimmed(input.idempotencyKey, 'Transition idempotency key')
    assertRevision(input.expectedRevision)
    assertTime(input.at, 'transition time')
    const commandDigest = digest({
      expectedRevision: input.expectedRevision,
      status: input.status,
      at: input.at,
      patch: input.patch ?? {}
    })
    const key = `comfy-job:${input.jobId}:transition:${input.idempotencyKey}`
    const replay = this.findMutation(input.jobId, key)
    if (replay) {
      this.assertReplay(replay, 'comfy-job.transitioned', commandDigest)
      return replay.resource as StoredResource<ComfyJobState>
    }
    const current = this.get(input.jobId)
    if (!current) throw new Error('Comfy job not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Comfy job revision conflict.')
    if (input.at < current.state.updatedAt)
      throw new Error('Comfy transition time cannot move backwards.')
    if (
      !(options.allowSameStatus && current.state.status === input.status) &&
      !transitions[current.state.status].includes(input.status)
    )
      throw new Error(`Invalid Comfy job transition: ${current.state.status} -> ${input.status}.`)
    const capturedFields = [
      'instanceId',
      'instanceRouteId',
      'instanceOrigin',
      'instanceKind',
      'legacyDefaultEndpoint'
    ] as const
    const hasOwn = (field: keyof ComfyJobState): boolean =>
      Object.prototype.hasOwnProperty.call(input.patch ?? {}, field)
    const hasCapturedAuthority = capturedFields.some((field) => current.state[field] !== undefined)
    const writesCapturedAuthority = capturedFields.some(hasOwn)
    if (!hasCapturedAuthority && writesCapturedAuthority) {
      if (current.state.status !== 'queued' || input.status !== 'leased') {
        throw new Error('Captured Comfy endpoint authority may only be initialized by assignment.')
      }
      for (const field of [
        'instanceId',
        'instanceRouteId',
        'instanceOrigin',
        'instanceKind'
      ] as const) {
        if (!hasOwn(field) || input.patch?.[field] === undefined) {
          throw new Error('Captured Comfy endpoint authority must be complete.')
        }
      }
    }
    if (hasCapturedAuthority) {
      for (const field of capturedFields) {
        if (hasOwn(field) && input.patch?.[field] !== current.state[field]) {
          throw new Error('Captured Comfy endpoint authority is immutable.')
        }
      }
    }
    const preparedFields = ['submissionToken', 'promptWorkflow', 'historyWorkflow'] as const
    const writesPreparedData = preparedFields.some(hasOwn)
    const hasPreparedData = preparedFields.some((field) => current.state[field] !== undefined)
    if (!hasPreparedData && writesPreparedData) {
      if (current.state.status !== 'leased' || input.status !== 'prepared') {
        throw new Error('Prepared Comfy submission data may only be initialized by prepare.')
      }
      for (const field of preparedFields) {
        if (!hasOwn(field) || input.patch?.[field] === undefined) {
          throw new Error('Prepared Comfy submission data must be complete.')
        }
      }
    }
    for (const field of preparedFields) {
      const existing = current.state[field]
      if (existing !== undefined && hasOwn(field)) {
        const next = input.patch?.[field]
        if (next === undefined || digest(existing) !== digest(next)) {
          throw new Error('Prepared Comfy submission data is immutable.')
        }
      }
    }
    if (current.state.promptId !== undefined && hasOwn('promptId')) {
      if (input.patch?.promptId !== current.state.promptId) {
        throw new Error('Captured Comfy prompt id is immutable.')
      }
    } else if (current.state.promptId === undefined && hasOwn('promptId')) {
      const normalBind =
        ['submitting', 'unknown'].includes(current.state.status) && input.status === 'submitted'
      const cancellationBind =
        current.state.status === 'cancel_requested' && input.status === 'cancel_requested'
      if (!normalBind && !cancellationBind) {
        throw new Error('Captured Comfy prompt id may only be initialized by reconciliation.')
      }
    }
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(input.status)
    const clearsUncertainty = [
      'queued',
      'submitted',
      'running',
      'succeeded',
      'failed',
      'cancelled'
    ].includes(input.status)
    let state: ComfyJobState = {
      ...current.state,
      ...(input.patch ?? {}),
      status: input.status,
      updatedAt: input.at,
      ...(terminal ? { finishedAt: input.at } : {}),
      ...(clearsUncertainty ? { submissionUnknown: false, requiresManualIntervention: false } : {}),
      ...(input.status === 'unknown'
        ? {
            cancelRequested: input.patch?.cancelRequested ?? current.state.cancelRequested ?? false
          }
        : !['cancel_requested', 'cancelled'].includes(input.status)
          ? { cancelRequested: false }
          : terminal
            ? { cancelRequested: input.status === 'cancelled' }
            : {})
    }
    const mutableState = state as { -readonly [K in keyof ComfyJobState]: ComfyJobState[K] }
    if (!terminal) delete mutableState.finishedAt
    if (!['failed', 'unknown'].includes(input.status)) {
      delete mutableState.failureCode
      delete mutableState.failureMessage
    }
    if (input.status !== 'succeeded') delete mutableState.result
    // A process restart cannot recreate the transport lease, but unknown and cancellation states
    // retain their captured authority and logical reservation. Only terminal confirmation and a
    // deliberately re-queued/manual-resolved job clear process-local lease metadata.
    if (['queued', 'succeeded', 'failed', 'cancelled'].includes(input.status))
      state = clearLease(state)
    validateState(state)
    return this.eventStore.mutateResource<ComfyJobState>({
      operation: 'update',
      kind: COMFY_JOB_RESOURCE_KIND,
      id: input.jobId,
      expectedRevision: input.expectedRevision,
      state,
      createdAt: input.at,
      idempotencyKey: key,
      event: event(input.jobId, 'comfy-job.transitioned', input.at, input.expectedRevision + 1, {
        status: input.status,
        commandDigest
      })
    }).resource
  }
  assign(
    input: Readonly<{
      jobId: string
      expectedRevision: number
      instanceId: string
      instanceRouteId: string
      instanceOrigin: string
      instanceKind: 'local' | 'remote'
      leaseOwner: string
      leaseExpiresAt: number
      at: number
      idempotencyKey: string
    }>
  ) {
    assertTrimmed(input.instanceId, 'instanceId')
    assertTrimmed(input.instanceRouteId, 'instanceRouteId')
    assertTrimmed(input.instanceOrigin, 'instanceOrigin')
    assertTrimmed(input.leaseOwner, 'leaseOwner')
    assertTime(input.leaseExpiresAt, 'leaseExpiresAt')
    if (input.leaseExpiresAt <= input.at) throw new Error('leaseExpiresAt must be after at.')
    if (input.instanceKind !== 'local' && input.instanceKind !== 'remote')
      throw new Error('Invalid instanceKind.')
    return this.transition({
      ...input,
      status: 'leased',
      patch: {
        instanceId: input.instanceId,
        instanceRouteId: input.instanceRouteId,
        instanceOrigin: input.instanceOrigin,
        instanceKind: input.instanceKind,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt
      }
    })
  }
  prepare(
    input: Omit<TransitionInput, 'status' | 'patch'> &
      Pick<ComfyJobState, 'submissionToken' | 'promptWorkflow' | 'historyWorkflow'>
  ) {
    assertTrimmed(input.submissionToken, 'submissionToken')
    return this.transition({
      ...input,
      status: 'prepared',
      patch: {
        submissionToken: input.submissionToken,
        promptWorkflow: input.promptWorkflow,
        historyWorkflow: input.historyWorkflow
      }
    })
  }
  markSubmitting(input: Omit<TransitionInput, 'status' | 'patch'>) {
    return this.transition({ ...input, status: 'submitting' })
  }
  bindPrompt(
    input: Readonly<{
      jobId: string
      expectedRevision: number
      promptId: string
      at: number
      idempotencyKey: string
    }>
  ) {
    assertTrimmed(input.promptId, 'promptId')
    return this.transition({
      ...input,
      status: 'submitted',
      patch: {
        promptId: input.promptId,
        startedAt: input.at,
        submissionUnknown: false,
        requiresManualIntervention: false
      }
    })
  }
  bindPromptForCancellation(
    input: Readonly<{
      jobId: string
      expectedRevision: number
      promptId: string
      at: number
      idempotencyKey: string
    }>
  ) {
    assertTrimmed(input.promptId, 'promptId')
    const current = this.get(input.jobId)
    if (!current || current.state.status !== 'cancel_requested') {
      throw new Error('Comfy job is not awaiting a cancellation prompt id.')
    }
    return this.transition(
      {
        ...input,
        status: 'cancel_requested',
        patch: { promptId: input.promptId, startedAt: input.at, cancelRequested: true }
      },
      { allowSameStatus: true }
    )
  }
  reconcilePrompt(
    input: Readonly<{
      jobId: string
      expectedRevision: number
      promptId: string
      at: number
      idempotencyKey: string
    }>
  ) {
    assertTrimmed(input.promptId, 'promptId')
    const current = this.get(input.jobId)
    if (!current) throw new Error('Comfy job not found.')
    if (!['prepared', 'submitting', 'unknown'].includes(current.state.status)) {
      throw new Error(`Comfy job cannot reconcile a prompt from ${current.state.status}.`)
    }
    return this.transition({
      ...input,
      status: 'submitted',
      patch: {
        promptId: input.promptId,
        startedAt: input.at,
        submissionUnknown: false,
        requiresManualIntervention: false
      }
    })
  }

  resolveNotSubmitted(
    input: Readonly<{
      jobId: string
      expectedRevision: number
      at: number
      idempotencyKey: string
    }>
  ) {
    const current = this.get(input.jobId)
    if (!current) throw new Error('Comfy job not found.')
    if (current.state.status !== 'unknown') {
      throw new Error('Only an unknown Comfy job can be resolved as not submitted.')
    }
    if (
      !current.state.submissionToken ||
      !current.state.promptWorkflow ||
      !current.state.historyWorkflow
    ) {
      throw new Error('Unknown Comfy job has no durable prepared submission to resume.')
    }
    return this.transition({
      ...input,
      status: 'prepared',
      patch: {
        cancelRequested: false,
        submissionUnknown: false,
        requiresManualIntervention: false
      }
    })
  }

  markRunning(input: Omit<TransitionInput, 'status' | 'patch'>) {
    return this.transition({ ...input, status: 'running' })
  }
  requestCancel(
    input: Omit<TransitionInput, 'status' | 'patch'> &
      Partial<Pick<ComfyJobState, 'cancelRequested'>>
  ) {
    return this.transition({
      ...input,
      status: 'cancel_requested',
      patch: { cancelRequested: input.cancelRequested ?? true }
    })
  }
  cancel(input: Omit<TransitionInput, 'status' | 'patch'>) {
    return this.transition({
      ...input,
      status: 'cancelled',
      patch: { cancelRequested: true, requiresManualIntervention: false }
    })
  }
  complete(
    input: Readonly<{
      jobId: string
      expectedRevision: number
      result: ComfyHistory
      at: number
      idempotencyKey: string
    }>
  ) {
    assertBounded(input.result, MAX_COMFY_JOB_RESULT_BYTES, 'Comfy result')
    return this.transition({ ...input, status: 'succeeded', patch: { result: input.result } })
  }
  fail(
    input: Readonly<{
      jobId: string
      expectedRevision: number
      code: string
      message: string
      at: number
      idempotencyKey: string
    }>
  ) {
    assertTrimmed(input.code, 'failure code')
    assertTrimmed(input.message, 'failure message')
    return this.transition({
      ...input,
      status: 'failed',
      patch: { failureCode: input.code, failureMessage: input.message }
    })
  }
  markUnknown(
    input: Readonly<{
      jobId: string
      expectedRevision: number
      code: string
      message: string
      at: number
      idempotencyKey: string
    }>
  ) {
    assertTrimmed(input.code, 'failure code')
    assertTrimmed(input.message, 'failure message')
    return this.transition({
      ...input,
      status: 'unknown',
      patch: {
        failureCode: input.code,
        failureMessage: input.message,
        submissionUnknown: true,
        requiresManualIntervention: true
      }
    })
  }
  retry(
    input: Readonly<{
      jobId: string
      expectedRevision: number
      retryAt: number
      at: number
      idempotencyKey: string
    }>
  ) {
    assertTime(input.retryAt, 'retryAt')
    const current = this.get(input.jobId)
    if (!current) throw new Error('Comfy job not found.')
    if (current.state.status === 'unknown') {
      throw new Error(
        'Unknown Comfy jobs require explicit manual resolution and cannot be retried.'
      )
    }
    if (
      current.state.instanceId ||
      current.state.instanceRouteId ||
      current.state.submissionToken ||
      current.state.promptWorkflow ||
      current.state.historyWorkflow
    ) {
      throw new Error(
        'Captured or prepared Comfy jobs cannot be retried; create a new job instead.'
      )
    }
    const replay = this.findMutation(
      input.jobId,
      `comfy-job:${input.jobId}:transition:${input.idempotencyKey}`
    )
    if (replay) {
      const replayedResource = replay.resource as StoredResource<ComfyJobState>
      const commandDigest = digest({
        expectedRevision: input.expectedRevision,
        status: 'queued',
        at: input.at,
        patch: { attempt: replayedResource.state.attempt, nextAttemptAt: input.retryAt }
      })
      this.assertReplay(replay, 'comfy-job.transitioned', commandDigest)
      return replayedResource
    }
    if (current.state.attempt >= current.state.maxAttempts)
      throw new Error('Comfy job retry limit reached.')
    return this.transition({
      ...input,
      status: 'queued',
      patch: { attempt: current.state.attempt + 1, nextAttemptAt: input.retryAt }
    })
  }
  private findMutation(id: string, key: string) {
    return this.eventStore.findResourceMutation(COMFY_JOB_RESOURCE_KIND, id, key)
  }
  private assertReplay(
    mutation: ReturnType<ComfyJobStore['findMutation']>,
    type: string,
    expectedDigest: string
  ): void {
    const committed = mutation && this.eventStore.getEvent(mutation.eventId)
    const payload = committed?.payload as { commandDigest?: string } | undefined
    if (committed?.type !== type || payload?.commandDigest !== expectedDigest)
      throw new Error('Comfy job idempotency conflict.')
  }
}
