import { addAbortListener } from 'node:events'
import type {
  LocalComfyCapabilityRegistry,
  LocalComfyCapabilityStatus
} from './localComfyCapability'
import type { TrustedBackgroundRemovalDeadline } from './runner'

/** Main-owned request contract. It contains references only; never paths, URLs or credentials. */
export type BackgroundRemovalTask = Readonly<{
  task: 'background-removal'
  requestId: string
  capabilityRef: string
  runtimeRef: string
  modelRef: string
  permission: 'managed-media-read' | 'background-removal.execute'
  source: Readonly<{
    mediaRef: string
    sha256: string
    format: 'png' | 'jpeg'
    width: number
    height: number
  }>
  deadline: TrustedBackgroundRemovalDeadline
}>

export type BackgroundRemovalUsage = Readonly<{
  requestId: string
  capabilityRef: string
  runtimeRef: string
  modelRef: string
  inputBytes: number
  outputBytes: number
  startedAt: number
  finishedAt: number
}>

export type BackgroundRemovalAudit = Readonly<{
  event: 'discovered' | 'rejected' | 'cancelled' | 'failed' | 'completed'
  requestId: string
  capabilityRef: string
  error?: BackgroundRemovalDispatcherError
  usage?: BackgroundRemovalUsage
}>

export type BackgroundRemovalDispatcherError =
  | 'INVALID_REQUEST'
  | 'UNAVAILABLE'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'PERMISSION_DENIED'
  | 'INPUT_UNAVAILABLE'
  | 'EXECUTION_UNAVAILABLE'

export type BackgroundRemovalDiscovery = Readonly<{
  capabilityRef: string
  status: LocalComfyCapabilityStatus
  ready: false
  runtimeRef: null
  modelRef: null
}>

export type BackgroundRemovalDispatchResult =
  | Readonly<{ status: 'unavailable'; error: BackgroundRemovalDispatcherError }>
  | Readonly<{ status: 'result'; bytes: Buffer; usage: BackgroundRemovalUsage }>

export type TrustedBackgroundRemovalDispatcherOptions = Readonly<{
  capability: LocalComfyCapabilityRegistry
  readManagedMedia?: (
    mediaRef: string,
    expectedSha256: string,
    signal: AbortSignal
  ) => Promise<Buffer>
  execute?: (task: BackgroundRemovalTask, input: Buffer, signal: AbortSignal) => Promise<Buffer>
  audit?: (entry: BackgroundRemovalAudit) => void
}>

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY_REF = /^local-comfy-rembg:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_LIFETIME_MS = 120_000
const fail = (error: BackgroundRemovalDispatcherError) => ({
  status: 'unavailable' as const,
  error
})

function unavailableStatus(): LocalComfyCapabilityStatus {
  return { status: 'unavailable', ready: false }
}

function validFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validDimensions(width: unknown, height: unknown): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    (width as number) > 0 &&
    (height as number) > 0 &&
    (width as number) <= 4096 &&
    (height as number) <= 4096 &&
    (width as number) * (height as number) <= 4_194_304
  )
}

function validTask(value: unknown): value is BackgroundRemovalTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const task = value as Partial<BackgroundRemovalTask>
  if (
    task.task !== 'background-removal' ||
    typeof task.requestId !== 'string' ||
    !REQUEST_ID.test(task.requestId) ||
    typeof task.capabilityRef !== 'string' ||
    !CAPABILITY_REF.test(task.capabilityRef) ||
    typeof task.runtimeRef !== 'string' ||
    !OPAQUE_REF.test(task.runtimeRef) ||
    typeof task.modelRef !== 'string' ||
    !OPAQUE_REF.test(task.modelRef) ||
    (task.permission !== 'managed-media-read' &&
      task.permission !== 'background-removal.execute') ||
    !task.source ||
    typeof task.source !== 'object' ||
    Array.isArray(task.source) ||
    typeof task.source.mediaRef !== 'string' ||
    !OPAQUE_REF.test(task.source.mediaRef) ||
    typeof task.source.sha256 !== 'string' ||
    !SHA256.test(task.source.sha256) ||
    (task.source.format !== 'png' && task.source.format !== 'jpeg') ||
    !validDimensions(task.source.width, task.source.height) ||
    !task.deadline ||
    typeof task.deadline !== 'object' ||
    !validFinite(task.deadline.expiresAt) ||
    !validFinite(task.deadline.monotonicDeadline) ||
    (task.deadline.signal !== undefined && !(task.deadline.signal instanceof AbortSignal))
  ) {
    return false
  }
  const wallRemaining = task.deadline.expiresAt - Date.now()
  const monoRemaining = task.deadline.monotonicDeadline - performance.now()
  return (
    Math.min(wallRemaining, monoRemaining) > 0 &&
    Math.max(wallRemaining, monoRemaining) <= MAX_LIFETIME_MS
  )
}

function deadlineExpired(deadline: TrustedBackgroundRemovalDeadline): boolean {
  return Date.now() >= deadline.expiresAt || performance.now() >= deadline.monotonicDeadline
}

/** Main-only, fail-closed foundation: no default reader/executor, tensor, GPU or model. */
export function createBackgroundRemovalDispatcher(
  options: TrustedBackgroundRemovalDispatcherOptions
) {
  const emit = (entry: BackgroundRemovalAudit): void => {
    try {
      options.audit?.(Object.freeze(entry))
    } catch {
      // Audit is observational; it cannot make an unavailable capability ready.
    }
  }

  const discover = (capabilityRef: string): BackgroundRemovalDiscovery => {
    if (!CAPABILITY_REF.test(capabilityRef)) {
      return Object.freeze({
        capabilityRef,
        status: unavailableStatus(),
        ready: false,
        runtimeRef: null,
        modelRef: null
      })
    }
    const status = options.capability.status(capabilityRef)
    return Object.freeze({ capabilityRef, status, ready: false, runtimeRef: null, modelRef: null })
  }

  const dispatch = async (
    task: unknown,
    signal?: AbortSignal
  ): Promise<BackgroundRemovalDispatchResult> => {
    if (!validTask(task)) {
      emit({
        event: 'rejected',
        requestId: 'invalid',
        capabilityRef: 'invalid',
        error: 'INVALID_REQUEST'
      })
      return fail('INVALID_REQUEST')
    }
    if (signal?.aborted || task.deadline.signal?.aborted) {
      emit({
        event: 'cancelled',
        requestId: task.requestId,
        capabilityRef: task.capabilityRef,
        error: 'CANCELLED'
      })
      return fail('CANCELLED')
    }
    if (task.permission !== 'background-removal.execute') {
      emit({
        event: 'rejected',
        requestId: task.requestId,
        capabilityRef: task.capabilityRef,
        error: 'PERMISSION_DENIED'
      })
      return fail('PERMISSION_DENIED')
    }
    const discovered = discover(task.capabilityRef)
    emit({ event: 'discovered', requestId: task.requestId, capabilityRef: task.capabilityRef })
    if (discovered.status.status !== 'configured-but-unattested') {
      emit({
        event: 'failed',
        requestId: task.requestId,
        capabilityRef: task.capabilityRef,
        error: 'UNAVAILABLE'
      })
      return fail('UNAVAILABLE')
    }
    if (!options.readManagedMedia) {
      emit({
        event: 'failed',
        requestId: task.requestId,
        capabilityRef: task.capabilityRef,
        error: 'INPUT_UNAVAILABLE'
      })
      return fail('INPUT_UNAVAILABLE')
    }
    if (!options.execute) {
      emit({
        event: 'failed',
        requestId: task.requestId,
        capabilityRef: task.capabilityRef,
        error: 'EXECUTION_UNAVAILABLE'
      })
      return fail('EXECUTION_UNAVAILABLE')
    }

    const controller = new AbortController()
    const subscriptions: Array<{ [Symbol.dispose](): void }> = []
    let ownsLease = false
    const relayAbort = () => controller.abort()
    const subscribe = (owner: AbortSignal | undefined): void => {
      if (owner) subscriptions.push(addAbortListener(owner, relayAbort))
    }
    subscribe(signal)
    subscribe(task.deadline.signal)
    const timeoutMs = Math.max(
      1,
      Math.min(
        task.deadline.expiresAt - Date.now(),
        task.deadline.monotonicDeadline - performance.now()
      )
    )
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', relayAbort, { once: true })
    try {
      const acquiredDeadline: TrustedBackgroundRemovalDeadline = {
        expiresAt: task.deadline.expiresAt,
        monotonicDeadline: task.deadline.monotonicDeadline,
        signal: controller.signal
      }
      const leaseResult = await options.capability.acquire(task.capabilityRef, acquiredDeadline)
      if (controller.signal.aborted || deadlineExpired(task.deadline)) {
        return fail(signal?.aborted || task.deadline.signal?.aborted ? 'CANCELLED' : 'EXPIRED')
      }
      if (leaseResult.status !== 'lease') {
        const error: BackgroundRemovalDispatcherError =
          leaseResult.error === 'CANCELLED'
            ? 'CANCELLED'
            : leaseResult.error === 'EXPIRED'
              ? 'EXPIRED'
              : leaseResult.error === 'REVOKED'
                ? 'REVOKED'
                : 'UNAVAILABLE'
        emit({
          event: error === 'CANCELLED' ? 'cancelled' : 'failed',
          requestId: task.requestId,
          capabilityRef: task.capabilityRef,
          error
        })
        return fail(error)
      }
      ownsLease = true
      subscribe(leaseResult.lease.signal)
      if (!options.capability.isCurrent(leaseResult.lease)) {
        emit({
          event: 'failed',
          requestId: task.requestId,
          capabilityRef: task.capabilityRef,
          error: 'REVOKED'
        })
        return fail('REVOKED')
      }
      const startedAt = Date.now()
      const input = await options.readManagedMedia(
        task.source.mediaRef,
        task.source.sha256,
        controller.signal
      )
      if (controller.signal.aborted || deadlineExpired(task.deadline))
        return fail(signal?.aborted || task.deadline.signal?.aborted ? 'CANCELLED' : 'EXPIRED')
      const bytes = await options.execute(task, input, controller.signal)
      if (controller.signal.aborted || deadlineExpired(task.deadline))
        return fail(signal?.aborted || task.deadline.signal?.aborted ? 'CANCELLED' : 'EXPIRED')
      if (!options.capability.isCurrent(leaseResult.lease)) return fail('REVOKED')
      const usage = Object.freeze({
        requestId: task.requestId,
        capabilityRef: task.capabilityRef,
        runtimeRef: task.runtimeRef,
        modelRef: task.modelRef,
        inputBytes: input.byteLength,
        outputBytes: bytes.byteLength,
        startedAt,
        finishedAt: Date.now()
      })
      emit({
        event: 'completed',
        requestId: task.requestId,
        capabilityRef: task.capabilityRef,
        usage
      })
      return { status: 'result', bytes, usage }
    } catch {
      const error: BackgroundRemovalDispatcherError = controller.signal.aborted
        ? signal?.aborted || task.deadline.signal?.aborted
          ? 'CANCELLED'
          : 'EXPIRED'
        : 'UNAVAILABLE'
      emit({
        event: error === 'CANCELLED' ? 'cancelled' : 'failed',
        requestId: task.requestId,
        capabilityRef: task.capabilityRef,
        error
      })
      return fail(error)
    } finally {
      clearTimeout(timer)
      for (const subscription of subscriptions) subscription[Symbol.dispose]()
      signal?.removeEventListener('abort', relayAbort)
      controller.abort()
      if (ownsLease) options.capability.revoke()
    }
  }

  return Object.freeze({ discover, dispatch })
}
