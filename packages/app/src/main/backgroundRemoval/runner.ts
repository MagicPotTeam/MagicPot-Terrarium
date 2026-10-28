import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { addAbortListener } from 'node:events'
import {
  validateBackgroundRemovalInput,
  validateBackgroundRemovalOutput,
  type ImageMetadata,
  type TrustedImageDecoder
} from './imageValidation'

export const MAX_BACKGROUND_REMOVAL_LIFETIME_MS = 120_000
export const BACKGROUND_REMOVAL_REVIEW_DOMAIN = 'MagicPot.BackgroundRemoval.Review.v1\0'

/** Opaque main-owned identifiers, never filenames, URLs, credentials or renderer assertions. */
export type BackgroundRemovalScope = {
  senderId: number
  documentEpoch: number
  projectId: string
  operationId: string
  sourceId: string
}

/**
 * Optional trusted-main envelope, created BEFORE source choice/read. Absolute Date.now()
 * and performance.now() deadlines share their respective clock domains with this runner.
 * Both must be finite with at most 120s remaining. Values and signal identity are captured
 * once by prepare; only expiresAt enters the public review binding. This is not consent.
 */
export type TrustedBackgroundRemovalDeadline = Readonly<{
  expiresAt: number
  monotonicDeadline: number
  signal?: AbortSignal
}>

export type BackgroundRemovalBackendDescriptor = {
  id: string
  configurationRevision: string
  // Public opaque destination identifier, NOT an endpoint, path or connection configuration.
  destination: string
  kind: 'synthetic'
}

export type BackgroundRemovalBinding = Readonly<{
  scope: Readonly<BackgroundRemovalScope>
  source: Readonly<ImageMetadata & { sha256: string }>
  backgroundRemovalProfileId: string
  authorityEpoch: number
  backend: Readonly<BackgroundRemovalBackendDescriptor>
  expiresAt: number
}>

export type BackgroundRemovalReview = Readonly<{
  receiptId: string
  reviewHash: string
  binding: BackgroundRemovalBinding
}>

/** Only explicit synthetic, non-generative test adapters are supported in this foundation. */
export type ResolvedBackgroundRemovalBackend = {
  backgroundRemovalProfileId: string
  authorityEpoch: number
  descriptor: BackgroundRemovalBackendDescriptor
  run: (bytes: Buffer, metadata: Readonly<ImageMetadata>, signal: AbortSignal) => Promise<Buffer>
}

export type TrustedBackgroundRemovalOptions = {
  decoder?: TrustedImageDecoder
  /**
   * Readiness/configuration lookup ONLY: no source bytes, upload, provider launch or fallback.
   * Must resolve exactly this dedicated capability reference, not model_use === 'image', a
   * first profile or an instance pool. Unavailable references remain unavailable.
   */
  resolve?: (
    backgroundRemovalProfileId: string,
    signal: AbortSignal
  ) => Promise<ResolvedBackgroundRemovalBackend | undefined>
  /**
   * Synchronous trusted-main authority check of the ENTIRE captured binding: live scope,
   * exact capability reference, authorityEpoch and every backend descriptor field. A
   * revision/destination/authority change must return false (including change-away-and-back
   * via an incremented epoch). Do not substitute a narrowed digest or just profile equality.
   * Owners must also call invalidate() synchronously on revocation/document replacement.
   */
  isCurrent?: (binding: BackgroundRemovalBinding) => boolean
  /** Native main approval for this exact frozen review; only literal true approves. */
  approveNative?: (review: BackgroundRemovalReview, signal: AbortSignal) => Promise<boolean>
}

export type BackgroundRemovalRunnerError =
  | 'BUSY'
  | 'INVALID_REQUEST'
  | 'UNAVAILABLE'
  | 'DECODER_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'INVALID_RECEIPT'
  | 'APPROVAL_UNAVAILABLE'
  | 'APPROVAL_DENIED'
  | 'BACKEND_FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REVOKED'

type Failure = { status: 'error'; error: BackgroundRemovalRunnerError }
export type PrepareBackgroundRemovalResult =
  { status: 'review'; review: BackgroundRemovalReview } | Failure
export type RunBackgroundRemovalResult =
  { status: 'result'; bytes: Buffer; metadata: Readonly<ImageMetadata> } | Failure
export type DiscardBackgroundRemovalResult = { status: 'discarded' } | Failure

export type BackgroundRemovalRunner = {
  prepare: (
    bytes: Buffer,
    scope: BackgroundRemovalScope,
    backgroundRemovalProfileId: string,
    deadline?: TrustedBackgroundRemovalDeadline
  ) => Promise<PrepareBackgroundRemovalResult>
  run: (
    receiptId: string,
    reviewHash: string,
    scope: BackgroundRemovalScope
  ) => Promise<RunBackgroundRemovalResult>
  discard: (
    receiptId: string,
    reviewHash: string,
    scope: BackgroundRemovalScope
  ) => DiscardBackgroundRemovalResult
  cancel: () => void
  invalidate: () => void
}

type Operation = {
  generation: number
  expiresAt: number
  monotonicDeadline: number
  controller: AbortController
  phase: 'preparing' | 'review' | 'running'
  timer?: ReturnType<typeof setTimeout>
  detachAbort?: () => void
  error?: BackgroundRemovalRunnerError
  source?: Buffer
  review?: BackgroundRemovalReview
  backendRun?: ResolvedBackgroundRemovalBackend['run']
  runPromise?: Promise<RunBackgroundRemovalResult>
}

const failure = (error: BackgroundRemovalRunnerError): Failure => ({ status: 'error', error })
class RunnerFault {
  constructor(readonly error: BackgroundRemovalRunnerError) {}
}
// Public references are bounded opaque tokens; sensitive configuration never enters review.
const opaqueId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const epoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function snapshotScope(
  input: BackgroundRemovalScope
): Readonly<BackgroundRemovalScope> | undefined {
  try {
    const { senderId, documentEpoch, projectId, operationId, sourceId } = input
    if (
      !epoch(senderId) ||
      !epoch(documentEpoch) ||
      !opaqueId(projectId) ||
      !opaqueId(operationId) ||
      !opaqueId(sourceId)
    ) {
      return undefined
    }
    return Object.freeze({ senderId, documentEpoch, projectId, operationId, sourceId })
  } catch {
    return undefined
  }
}

function sameScope(
  a: Readonly<BackgroundRemovalScope>,
  b: Readonly<BackgroundRemovalScope>
): boolean {
  return (
    a.senderId === b.senderId &&
    a.documentEpoch === b.documentEpoch &&
    a.projectId === b.projectId &&
    a.operationId === b.operationId &&
    a.sourceId === b.sourceId
  )
}

/**
 * MAIN ONLY, inert until explicitly constructed/called. No IPC, UI, registration, IO or
 * automatic decoder/backend. One owner must retain one runner; capacity is per instance.
 *
 * Prerequisites OUTSIDE this runner: a native chooser/authorized asset read, byte/file
 * provenance and integrity, trusted sender/document/project context, and any required
 * host-transfer/upload consent. A readable media grant or this review is NOT approval,
 * and validating bytes cannot make untrusted bytes authorized. Native approval is an
 * additional explicit Run decision, not a replacement for those prerequisites.
 *
 * Ordinary main inputs are snapshotted (bytes through the existing validation helper).
 * All adapters/options/records and promise settlement are trusted main code, NOT a sandbox
 * for malicious getters, callbacks or codecs. isCurrent and invalidate are the authority
 * boundary; a callback lying about readiness/current configuration is not detectable here.
 *
 * Cancellation/expiry requests abort and discard late data. Outward settlement is
 * cooperative: already-dispatched work MUST settle before capacity is released, even if
 * it ignores abort forever. No Promise.race that falsely frees capacity or hard realtime
 * guarantee for blocking JS. One unref'ed timer and both wall/monotonic checks cover input
 * decode, readiness, review, approval, backend and output decode; Run never resets them.
 * Three-argument prepare starts 120s here. An optional main-owned pre-choice envelope
 * instead preserves the original deadlines and schedules only their earliest remainder.
 * This accepts sharing, but does not itself wire source reading or enforce orchestration.
 *
 * Results are detached mutable bytes for trusted main only, never immutable receipts or
 * published media. No retained result cache. Alpha/dimension validation is not semantic
 * matting quality, non-generative behavior attestation, or production backend readiness.
 */
export function createBackgroundRemovalRunner(
  options: TrustedBackgroundRemovalOptions = {}
): BackgroundRemovalRunner {
  const { decoder, resolve, isCurrent, approveNative } = options
  let generation = 0
  let active: Operation | undefined

  function detachAbort(operation: Operation): void {
    const detach = operation.detachAbort
    operation.detachAbort = undefined
    detach?.()
  }

  function finish(operation: Operation): void {
    clearTimeout(operation.timer)
    operation.timer = undefined
    detachAbort(operation)
    operation.source = undefined
    operation.backendRun = undefined
    operation.review = undefined
    operation.runPromise = undefined
    if (active === operation) active = undefined
  }

  function stop(operation: Operation, error: BackgroundRemovalRunnerError): void {
    if (operation.error) return
    // Set the terminal reason BEFORE synchronous abort listeners can reenter.
    operation.error = error
    clearTimeout(operation.timer)
    operation.timer = undefined
    detachAbort(operation)
    operation.source = undefined
    operation.controller.abort()
    // Preparing/running callbacks may still own work, including a promise returned by a
    // synchronously cancelling callback. Only settlement can release that slot.
    if (operation.phase === 'review') finish(operation)
  }

  function localGuard(operation: Operation): BackgroundRemovalRunnerError | undefined {
    if (operation.error) return operation.error
    if (active !== operation || operation.generation !== generation) {
      stop(operation, 'REVOKED')
    } else if (
      Date.now() >= operation.expiresAt ||
      performance.now() >= operation.monotonicDeadline
    ) {
      stop(operation, 'EXPIRED')
    }
    return operation.error
  }

  function guard(operation: Operation): BackgroundRemovalRunnerError | undefined {
    if (localGuard(operation)) return operation.error
    const binding = operation.review?.binding
    if (binding) {
      let current = false
      try {
        current = isCurrent?.(binding) === true
      } catch {
        // Never return callback errors, names, paths or provider details.
      }
      // Even true cannot override synchronous invalidation/cancellation/elapsed deadline.
      if (localGuard(operation)) return operation.error
      if (!current) stop(operation, 'REVOKED')
    }
    return operation.error
  }

  function assertCurrent(operation: Operation): void {
    const error = guard(operation)
    if (error) throw new RunnerFault(error)
  }

  async function call<T>(
    operation: Operation,
    invoke: () => Promise<T>,
    fallback: BackgroundRemovalRunnerError
  ): Promise<T> {
    assertCurrent(operation)
    let value: T
    try {
      const pending = invoke()
      // Check synchronous reentry BEFORE awaiting, but always drain work already invoked.
      // A stop here must not orphan its promise or allow replacement work into the slot.
      guard(operation)
      value = await pending
    } catch {
      assertCurrent(operation)
      throw new RunnerFault(fallback)
    }
    assertCurrent(operation)
    return value
  }

  function guardedDecoder(operation: Operation): TrustedImageDecoder {
    return (bytes, metadata, signal) =>
      call(operation, () => decoder!(bytes, metadata, signal), 'INVALID_INPUT')
  }

  function caught(error: unknown, fallback: BackgroundRemovalRunnerError): Failure {
    return failure(error instanceof RunnerFault ? error.error : fallback)
  }

  async function prepare(
    bytes: Buffer,
    inputScope: BackgroundRemovalScope,
    backgroundRemovalProfileId: string,
    deadline?: TrustedBackgroundRemovalDeadline
  ): Promise<PrepareBackgroundRemovalResult> {
    if (active) return failure('BUSY')
    let expiresAt: number
    let monotonicDeadline: number
    let externalSignal: AbortSignal | undefined
    if (deadline === undefined) {
      expiresAt = Date.now() + MAX_BACKGROUND_REMOVAL_LIFETIME_MS
      monotonicDeadline = performance.now() + MAX_BACKGROUND_REMOVAL_LIFETIME_MS
    } else {
      try {
        // Capture once: later mutation must not extend either clock or replace the owner.
        ;({ expiresAt, monotonicDeadline, signal: externalSignal } = deadline)
        if (
          !Number.isFinite(expiresAt) ||
          !Number.isFinite(monotonicDeadline) ||
          (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))
        ) {
          return failure('INVALID_REQUEST')
        }
        const wallRemaining = expiresAt - Date.now()
        const monoRemaining = monotonicDeadline - performance.now()
        if (Math.max(wallRemaining, monoRemaining) > MAX_BACKGROUND_REMOVAL_LIFETIME_MS) {
          return failure('INVALID_REQUEST')
        }
        if (Math.min(wallRemaining, monoRemaining) <= 0) return failure('EXPIRED')
        if (externalSignal?.aborted) return failure('CANCELLED')
      } catch {
        return failure('INVALID_REQUEST')
      }
    }
    // Reserve before ANY decoder/readiness/current callback, including synchronous reentry.
    const operation: Operation = {
      generation,
      expiresAt,
      monotonicDeadline,
      controller: new AbortController(),
      phase: 'preparing'
    }
    active = operation
    operation.timer = setTimeout(
      () => stop(operation, 'EXPIRED'),
      deadline === undefined
        ? MAX_BACKGROUND_REMOVAL_LIFETIME_MS
        : Math.min(expiresAt - Date.now(), monotonicDeadline - performance.now())
    )
    operation.timer.unref()
    try {
      if (externalSignal) {
        const signal = externalSignal
        const onAbort = () => stop(operation, 'CANCELLED')
        // Ordinary abort listeners can be suppressed by an earlier stopImmediatePropagation.
        const subscription = addAbortListener(signal, onAbort)
        operation.detachAbort = () => subscription[Symbol.dispose]()
        if (signal.aborted) onAbort()
        assertCurrent(operation)
      }
      const scope = snapshotScope(inputScope)
      if (!scope || !opaqueId(backgroundRemovalProfileId)) return failure('INVALID_REQUEST')
      if (!resolve || !isCurrent) return failure('UNAVAILABLE')
      if (!decoder) return failure('DECODER_UNAVAILABLE')
      const signal = operation.controller.signal
      const validated = await call(
        operation,
        () => validateBackgroundRemovalInput(bytes, { decoder: guardedDecoder(operation), signal }),
        'INVALID_INPUT'
      )
      assertCurrent(operation)
      if (!validated.ok) {
        return failure(
          validated.error === 'DECODER_UNAVAILABLE' ? validated.error : 'INVALID_INPUT'
        )
      }
      // Keep only encoded source bytes; decoded RGBA is not retained during review.
      operation.source = validated.image.bytes
      const { format, width, height } = validated.image
      const source = Object.freeze({
        sha256: createHash('sha256').update(operation.source).digest('hex'),
        format,
        width,
        height
      })
      const resolved = await call(
        operation,
        () => resolve(backgroundRemovalProfileId, signal),
        'UNAVAILABLE'
      )
      assertCurrent(operation)
      if (!resolved || resolved.backgroundRemovalProfileId !== backgroundRemovalProfileId) {
        return failure('UNAVAILABLE')
      }
      const authorityEpoch = resolved.authorityEpoch
      const { id, configurationRevision, destination, kind } = resolved.descriptor
      const backendRun = resolved.run
      if (
        !epoch(authorityEpoch) ||
        !opaqueId(id) ||
        !opaqueId(configurationRevision) ||
        !opaqueId(destination) ||
        kind !== 'synthetic' ||
        typeof backendRun !== 'function'
      ) {
        return failure('UNAVAILABLE')
      }
      const binding: BackgroundRemovalBinding = Object.freeze({
        scope,
        source,
        backgroundRemovalProfileId,
        authorityEpoch,
        backend: Object.freeze({ id, configurationRevision, destination, kind }),
        expiresAt: operation.expiresAt
      })
      const receiptId = randomBytes(16).toString('hex')
      const reviewHash = createHash('sha256')
        .update(BACKGROUND_REMOVAL_REVIEW_DOMAIN)
        .update(JSON.stringify({ receiptId, binding }))
        .digest('hex')
      const review = Object.freeze({ receiptId, reviewHash, binding })
      operation.review = review
      operation.backendRun = backendRun
      assertCurrent(operation)
      operation.phase = 'review'
      return { status: 'review', review }
    } catch (error) {
      return caught(error, 'UNAVAILABLE')
    } finally {
      if (operation.phase !== 'review') finish(operation)
    }
  }

  function matches(
    operation: Operation,
    receiptId: string,
    reviewHash: string,
    inputScope: BackgroundRemovalScope
  ): boolean {
    const scope = snapshotScope(inputScope)
    const review = operation.review
    return !!(
      scope &&
      review &&
      receiptId === review.receiptId &&
      reviewHash === review.reviewHash &&
      sameScope(scope, review.binding.scope)
    )
  }

  async function executeRun(operation: Operation): Promise<RunBackgroundRemovalResult> {
    try {
      assertCurrent(operation)
      const review = operation.review!
      if (!approveNative) return failure('APPROVAL_UNAVAILABLE')
      const signal = operation.controller.signal
      const approved = await call(operation, () => approveNative(review, signal), 'APPROVAL_DENIED')
      assertCurrent(operation)
      if (approved !== true) return failure('APPROVAL_DENIED')
      const metadata: Readonly<ImageMetadata> = Object.freeze({
        format: review.binding.source.format,
        width: review.binding.source.width,
        height: review.binding.source.height
      })
      const source = operation.source!
      const backendBytes = Buffer.alloc(source.length)
      backendBytes.set(source)
      const output = await call(
        operation,
        () => operation.backendRun!(backendBytes, metadata, signal),
        'BACKEND_FAILED'
      )
      assertCurrent(operation)
      const validated = await call(
        operation,
        () =>
          validateBackgroundRemovalOutput(output, metadata, {
            decoder: guardedDecoder(operation),
            signal
          }),
        'INVALID_OUTPUT'
      )
      assertCurrent(operation)
      if (!validated.ok) return failure('INVALID_OUTPUT')
      // The validator has defensively snapshotted the encoded output and fully decoded it.
      // No result cache: the trusted caller owns this detached mutable Buffer on settlement.
      return {
        status: 'result',
        bytes: validated.image.bytes,
        metadata: Object.freeze({ format: 'png', width: metadata.width, height: metadata.height })
      }
    } catch (error) {
      return caught(error, 'BACKEND_FAILED')
    }
  }

  function run(
    receiptId: string,
    reviewHash: string,
    scope: BackgroundRemovalScope
  ): Promise<RunBackgroundRemovalResult> {
    const operation = active
    if (!operation || !matches(operation, receiptId, reviewHash, scope)) {
      return Promise.resolve(failure('INVALID_RECEIPT'))
    }
    if (operation.runPromise) return operation.runPromise
    // Not an async wrapper: repeat calls must return this exact Promise, even from a
    // synchronous isCurrent/native/backend callback before the first await is reached.
    let settle!: (result: RunBackgroundRemovalResult) => void
    const promise = new Promise<RunBackgroundRemovalResult>((resolveResult) => {
      settle = resolveResult
    })
    operation.runPromise = promise
    operation.phase = 'running'
    void executeRun(operation).then((result) => {
      // The outer Promise's settlement is a boundary too: keep capacity and recheck after
      // executeRun, with no further await/callback between this guard and delivery.
      const error = guard(operation)
      finish(operation)
      settle(error ? failure(error) : result)
    })
    return promise
  }

  return {
    prepare,
    run,
    discard(receiptId, reviewHash, scope) {
      const operation = active
      if (!operation || !matches(operation, receiptId, reviewHash, scope)) {
        return failure('INVALID_RECEIPT')
      }
      stop(operation, 'CANCELLED')
      return { status: 'discarded' }
    },
    cancel() {
      if (active) stop(active, 'CANCELLED')
    },
    invalidate() {
      generation++
      if (active) stop(active, 'REVOKED')
    }
  }
}
