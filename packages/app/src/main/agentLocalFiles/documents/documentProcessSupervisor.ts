import {
  checkDocumentTextRequest,
  checkDocumentTextResult,
  DOCUMENT_TEXT_PROTOCOL,
  type DocumentTextFailureCode,
  type DocumentTextFormat,
  type DocumentTextRequest,
  type DocumentTextResult
} from './documentSchema'

/** This module owns lifecycle only. It never selects an executable, path, runtime or grant. */
export const DOCUMENT_PROCESS_DEADLINE_MS = 5000
/** Receipt is deliberately fixed and carries neither document data nor authorization. */
export const DOCUMENT_PROCESS_RECEIPT_ACK = 'ACK'

export type DocumentProcessChild = Readonly<{
  kill: () => boolean
}>

export type DocumentProcessTransportEvents = {
  spawn: (child: DocumentProcessChild) => void
  /** Every event carries the opaque child identity; untagged fan-in is rejected. */
  data: (child: DocumentProcessChild, frame: unknown) => void
  exit: (child: DocumentProcessChild, code: number | null, signal: string | null) => void
  error: (child: DocumentProcessChild, error: unknown) => void
}

export type DocumentProcessUnsubscribe = (() => void) | { unsubscribe: () => void } | void

/** Main-owned event transport. The request never supplies any transport field. */
export type DocumentProcessTransport = {
  subscribe: (events: DocumentProcessTransportEvents) => DocumentProcessUnsubscribe
  send: (frame: string) => void | Promise<void>
}

export type DocumentProcessStartContext = Readonly<{
  signal: AbortSignal
}>

/** Start is injected by the main owner; it receives no request, path, entry or runtime choice. */
export type DocumentProcessStart = (
  context: DocumentProcessStartContext
) => unknown | Promise<unknown>

export type DocumentProcessCodec = {
  serialize: (request: DocumentTextRequest) => string | Promise<string>
  decode: (
    frame: unknown,
    expectedJobId: string,
    expectedFormat: DocumentTextFormat
  ) => unknown | Promise<unknown>
}

export type DocumentProcessSupervisorDeps = {
  transport?: DocumentProcessTransport
  start?: DocumentProcessStart
  codec?: DocumentProcessCodec
  now?: () => number
}

export type DocumentProcessShortFailure = {
  ok: false
  code: Extract<
    DocumentTextFailureCode,
    'INVALID' | 'LIMIT' | 'TIMEOUT' | 'CANCELLED' | 'EXECUTION_FAILED'
  >
}

export type DocumentProcessOutcome = DocumentTextResult | DocumentProcessShortFailure

export type DocumentProcessRunOptions = Readonly<{
  signal?: AbortSignal
}>

export type DocumentProcessSupervisorState = 'idle' | 'running' | 'quarantined' | 'disposed'

export type DocumentProcessSupervisor = {
  run: (
    request: unknown,
    options?: DocumentProcessRunOptions | AbortSignal
  ) => Promise<DocumentProcessOutcome>
  cancel: () => boolean
  dispose: () => void
  isBusy: () => boolean
  readonly state: DocumentProcessSupervisorState
}

type RunState = {
  readonly generation: number
  readonly controller: AbortController
  readonly deadline: number
  readonly resolve: (outcome: DocumentProcessOutcome) => void
  request?: DocumentTextRequest
  serialized?: string
  child?: DocumentProcessChild
  pendingResult?: DocumentTextResult
  outcome?: DocumentProcessOutcome
  dataSeen: boolean
  requestSent: boolean
  startCalled: boolean
  startSettled: boolean
  startFailedSynchronously: boolean
  subscribed: boolean
  released: boolean
  disposed: boolean
  exitConfirmed: boolean
  exitSuccessful: boolean
  ackStarted: boolean
  ackSettled: boolean
  ackSucceeded: boolean
  killAttempted: boolean
  timer?: ReturnType<typeof setTimeout>
  unsubscribe?: () => void
  abortCleanup?: () => void
}

const defaultNow = (): number => Date.now()

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  try {
    return typeof (value as { then?: unknown }).then === 'function'
  } catch {
    return false
  }
}

function shortFailure(code: DocumentProcessShortFailure['code']): DocumentProcessShortFailure {
  return { ok: false, code }
}

function resultFailure(
  request: Pick<DocumentTextRequest, 'jobId' | 'format'>,
  code: DocumentTextFailureCode
): Extract<DocumentTextResult, { ok: false }> {
  return {
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: request.jobId,
    format: request.format,
    ok: false,
    code
  }
}

function isChild(value: unknown): value is DocumentProcessChild {
  if (value === null || typeof value !== 'object') return false
  try {
    return typeof (value as { kill?: unknown }).kill === 'function'
  } catch {
    return false
  }
}

function sameChild(value: unknown, child: DocumentProcessChild | undefined): boolean {
  return child !== undefined && value === child
}

function normalizeUnsubscribe(value: DocumentProcessUnsubscribe): (() => void) | undefined {
  if (typeof value === 'function') return value
  if (value !== undefined && value !== null && typeof value === 'object') {
    try {
      return typeof value.unsubscribe === 'function' ? () => value.unsubscribe() : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function normalizeSignal(
  options: DocumentProcessRunOptions | AbortSignal | undefined
): AbortSignal | undefined {
  if (options === undefined) return undefined
  if (typeof (options as AbortSignal).aborted === 'boolean') return options as AbortSignal
  return (options as DocumentProcessRunOptions).signal
}

/**
 * Creates a one-slot supervisor around already-owned main-process dependencies.
 * A slot is released only after a matching child exit and a settled receipt send,
 * except for failures proved before a child can belong to the slot.
 */
export function createDocumentProcessSupervisor(
  deps: DocumentProcessSupervisorDeps = {}
): DocumentProcessSupervisor {
  let current: RunState | null = null
  let nextGeneration = 0
  let disposed = false

  const now = typeof deps.now === 'function' ? deps.now : defaultNow

  const owns = (state: RunState): boolean =>
    current === state && state.generation === nextGeneration && !state.released

  const safeNow = (): number => {
    try {
      const value = now()
      return Number.isFinite(value) ? value : defaultNow()
    } catch {
      return defaultNow()
    }
  }

  const fullFailure = (state: RunState, code: DocumentTextFailureCode): DocumentProcessOutcome =>
    state.request
      ? resultFailure(state.request, code)
      : shortFailure(code as DocumentProcessShortFailure['code'])

  const clearTimer = (state: RunState): void => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  const clearAbortListener = (state: RunState): void => {
    const cleanup = state.abortCleanup
    state.abortCleanup = undefined
    if (cleanup) {
      try {
        cleanup()
      } catch {
        // An injected signal is not allowed to keep the lifecycle alive.
      }
    }
  }

  const unsubscribe = (state: RunState): void => {
    const cleanup = state.unsubscribe
    state.unsubscribe = undefined
    if (cleanup) {
      try {
        cleanup()
      } catch {
        // Teardown is best effort; no external error is exposed.
      }
    }
  }

  const release = (state: RunState): void => {
    if (!owns(state)) return
    state.released = true
    clearTimer(state)
    clearAbortListener(state)
    current = null
    nextGeneration += 1
    unsubscribe(state)
  }

  const resolveOnce = (state: RunState, outcome: DocumentProcessOutcome): void => {
    if (state.outcome !== undefined) return
    state.outcome = outcome
    clearTimer(state)
    state.resolve(outcome)
  }

  const maybeRelease = (state: RunState): void => {
    if (!owns(state) || state.outcome === undefined) return
    if (state.child !== undefined) {
      if (!state.exitConfirmed) return
      // Do not let a still-running receipt callback race a newly promoted job.
      if (state.ackStarted && !state.ackSettled) return
      release(state)
      return
    }
    // A pending start may still deliver a child after a timeout/cancellation.
    if (!state.startCalled || state.startFailedSynchronously || state.startSettled) release(state)
  }

  const kill = (state: RunState, child: DocumentProcessChild): void => {
    state.killAttempted = true
    try {
      // The boolean is intentionally ignored: true is not an exit confirmation.
      void child.kill()
    } catch {
      // A failed kill quarantines the same slot; it never unlocks it.
    }
  }

  const abortController = (state: RunState): void => {
    try {
      state.controller.abort()
    } catch {
      // AbortController is local; failure still leaves the slot quarantined.
    }
  }

  const commitControlledFailure = (
    state: RunState,
    code: Extract<DocumentTextFailureCode, 'TIMEOUT' | 'CANCELLED' | 'EXECUTION_FAILED'>
  ): void => {
    if (!owns(state) || state.outcome !== undefined) return
    state.pendingResult = undefined
    // Commit before invoking abort/kill callbacks so re-entry cannot replace the reason.
    resolveOnce(state, fullFailure(state, code))
    abortController(state)
    if (state.child && !state.exitConfirmed) kill(state, state.child)
    maybeRelease(state)
  }

  const timeout = (state: RunState): void => {
    commitControlledFailure(state, 'TIMEOUT')
  }

  const scheduleTimeout = (state: RunState): void => {
    const arm = (): void => {
      if (!owns(state) || state.outcome !== undefined) return
      const remaining = state.deadline - safeNow()
      if (remaining <= 0) {
        timeout(state)
        return
      }
      state.timer = setTimeout(
        () => {
          state.timer = undefined
          if (!owns(state) || state.outcome !== undefined) return
          if (state.deadline - safeNow() <= 0) timeout(state)
          else arm()
        },
        Math.max(1, Math.min(remaining, 2_147_483_647))
      )
    }
    arm()
  }

  const sendRequest = async (state: RunState, frame: string): Promise<boolean> => {
    if (!owns(state) || state.outcome !== undefined || !deps.transport) return false
    try {
      const returned = deps.transport.send(frame)
      if (isPromiseLike(returned)) await returned
      return owns(state) && state.outcome === undefined
    } catch {
      if (owns(state) && state.outcome === undefined)
        commitControlledFailure(state, 'EXECUTION_FAILED')
      return false
    }
  }

  const settleAfterExit = (state: RunState): void => {
    if (!owns(state)) return
    if (state.outcome !== undefined) {
      maybeRelease(state)
      return
    }
    if (!state.exitConfirmed) return

    if (state.pendingResult !== undefined) {
      // A valid parser result, including a structured failure, is not complete
      // until its exact receipt send has settled and the child exited normally.
      if (!state.ackSettled) return
      if (state.ackSucceeded && state.exitSuccessful) resolveOnce(state, state.pendingResult)
      else resolveOnce(state, fullFailure(state, 'EXECUTION_FAILED'))
    } else {
      // No decoder result can be promoted after exit. An in-flight receipt is
      // still allowed to finish before the slot is reused.
      if (state.ackStarted && !state.ackSettled) return
      resolveOnce(state, fullFailure(state, 'EXECUTION_FAILED'))
    }
    maybeRelease(state)
  }

  const finishAck = (state: RunState, succeeded: boolean): void => {
    if (state.ackSettled) return
    state.ackSettled = true
    state.ackSucceeded = succeeded
    if (!succeeded && owns(state) && state.outcome === undefined) {
      state.pendingResult = undefined
      commitControlledFailure(state, 'EXECUTION_FAILED')
    }
    settleAfterExit(state)
  }

  const beginAck = (state: RunState): void => {
    if (!owns(state) || state.outcome !== undefined || !deps.transport) return
    state.ackStarted = true
    let returned: void | Promise<void>
    try {
      returned = deps.transport.send(DOCUMENT_PROCESS_RECEIPT_ACK)
    } catch {
      finishAck(state, false)
      return
    }
    if (isPromiseLike(returned)) {
      void Promise.resolve(returned).then(
        () => finishAck(state, true),
        () => finishAck(state, false)
      )
    } else {
      // A synchronous return is the complete receipt transport operation. Any
      // re-entrant exit event was recorded by handleExit before this point.
      finishAck(state, true)
    }
  }

  const handleExit = (
    state: RunState,
    child: DocumentProcessChild,
    code: unknown,
    signal: unknown
  ): void => {
    if (!owns(state) || !sameChild(child, state.child) || state.exitConfirmed) return
    state.exitConfirmed = true
    state.exitSuccessful = code === 0 && signal === null
    settleAfterExit(state)
  }

  const handleError = (state: RunState, child: DocumentProcessChild | undefined): void => {
    if (!owns(state) || (child !== undefined && !sameChild(child, state.child))) return
    commitControlledFailure(state, 'EXECUTION_FAILED')
  }

  const handleData = async (
    state: RunState,
    child: DocumentProcessChild,
    frame: unknown
  ): Promise<void> => {
    if (!owns(state) || state.outcome !== undefined || !sameChild(child, state.child)) return
    if (state.child === undefined) {
      commitControlledFailure(state, 'EXECUTION_FAILED')
      return
    }
    if (state.dataSeen) {
      commitControlledFailure(state, 'EXECUTION_FAILED')
      return
    }
    state.dataSeen = true
    if (!deps.codec) {
      commitControlledFailure(state, 'EXECUTION_FAILED')
      return
    }

    let decoded: unknown
    try {
      decoded = deps.codec.decode(frame, state.request!.jobId, state.request!.format)
      if (isPromiseLike(decoded)) decoded = await decoded
    } catch {
      if (owns(state) && state.outcome === undefined)
        commitControlledFailure(state, 'EXECUTION_FAILED')
      return
    }
    if (!owns(state) || state.outcome !== undefined || state.exitConfirmed) {
      if (owns(state) && state.exitConfirmed) commitControlledFailure(state, 'EXECUTION_FAILED')
      return
    }

    let checked: ReturnType<typeof checkDocumentTextResult>
    try {
      checked = checkDocumentTextResult(decoded, state.request!.jobId, state.request!.format)
    } catch {
      checked = { ok: false, code: 'INVALID' }
    }
    if (!checked.ok) {
      commitControlledFailure(state, 'EXECUTION_FAILED')
      return
    }
    if (state.exitConfirmed) {
      commitControlledFailure(state, 'EXECUTION_FAILED')
      return
    }

    // Record both success and structured failure before send so a synchronous
    // ACK callback can race an exit without losing the candidate result.
    state.pendingResult = checked.result
    beginAck(state)
  }

  const makeEvents = (state: RunState): DocumentProcessTransportEvents => ({
    spawn: (child) => {
      if (!owns(state)) {
        if (isChild(child)) kill(state, child)
        return
      }
      if (!isChild(child)) {
        commitControlledFailure(state, 'EXECUTION_FAILED')
        return
      }
      if (state.child !== undefined) {
        kill(state, child)
        commitControlledFailure(state, 'EXECUTION_FAILED')
        return
      }
      state.child = child
      if (state.outcome !== undefined) {
        kill(state, child)
        return
      }
      if (safeNow() >= state.deadline) {
        timeout(state)
        return
      }
      if (state.serialized === undefined || state.requestSent) {
        commitControlledFailure(state, 'EXECUTION_FAILED')
        return
      }
      state.requestSent = true
      void sendRequest(state, state.serialized)
    },
    data: (child, frame) => {
      void handleData(state, child, frame)
    },
    exit: (child, code, signal) => {
      handleExit(state, child, code, signal)
    },
    error: (child) => {
      handleError(state, child)
    }
  })

  const handleStartSettled = (state: RunState, value: unknown, rejected: boolean): void => {
    if (state.startSettled) return
    state.startSettled = true
    if (isChild(value)) {
      const events = makeEvents(state)
      events.spawn(value)
    }
    if (!owns(state)) return
    if (rejected && state.outcome === undefined) commitControlledFailure(state, 'EXECUTION_FAILED')
    else settleAfterExit(state)
  }

  const invokeStart = (state: RunState): void => {
    if (!owns(state) || state.outcome !== undefined || !deps.start) return
    state.startCalled = true
    let started: unknown
    try {
      started = deps.start({ signal: state.controller.signal })
    } catch {
      state.startFailedSynchronously = true
      state.startSettled = true
      if (state.outcome === undefined) commitControlledFailure(state, 'EXECUTION_FAILED')
      else maybeRelease(state)
      return
    }
    if (!owns(state)) return
    if (isPromiseLike(started)) {
      void Promise.resolve(started).then(
        (value) => handleStartSettled(state, value, false),
        () => handleStartSettled(state, undefined, true)
      )
    } else {
      handleStartSettled(state, started, false)
    }
  }

  const attachAbort = (state: RunState, signal: AbortSignal | undefined): void => {
    if (!signal) return
    const onAbort = (): void => {
      if (owns(state)) commitControlledFailure(state, 'CANCELLED')
    }
    try {
      signal.addEventListener('abort', onAbort, { once: true })
      state.abortCleanup = () => signal.removeEventListener('abort', onAbort)
      if (signal.aborted) onAbort()
    } catch {
      // A malformed injected signal cannot make a child eligible for release.
    }
  }

  const initialize = async (
    state: RunState,
    rawRequest: unknown,
    signal: AbortSignal | undefined
  ): Promise<void> => {
    if (!owns(state)) return
    let checkedRequest: ReturnType<typeof checkDocumentTextRequest>
    try {
      checkedRequest = checkDocumentTextRequest(rawRequest)
    } catch {
      checkedRequest = { ok: false, code: 'INVALID' }
    }
    if (!checkedRequest.ok) {
      resolveOnce(state, shortFailure(checkedRequest.code))
      release(state)
      return
    }
    state.request = checkedRequest.request
    attachAbort(state, signal)
    if (!owns(state)) return
    if (signal?.aborted) {
      commitControlledFailure(state, 'CANCELLED')
      return
    }
    if (safeNow() >= state.deadline) {
      timeout(state)
      return
    }
    if (
      !deps.transport ||
      typeof deps.transport.subscribe !== 'function' ||
      typeof deps.transport.send !== 'function' ||
      !deps.codec ||
      typeof deps.codec.serialize !== 'function' ||
      typeof deps.codec.decode !== 'function' ||
      typeof deps.start !== 'function'
    ) {
      resolveOnce(state, resultFailure(state.request, 'EXECUTION_FAILED'))
      release(state)
      return
    }

    let serialized: unknown
    try {
      serialized = deps.codec.serialize(state.request)
      if (isPromiseLike(serialized)) serialized = await serialized
    } catch {
      if (owns(state)) {
        resolveOnce(state, resultFailure(state.request, 'EXECUTION_FAILED'))
        release(state)
      }
      return
    }
    if (!owns(state) || state.outcome !== undefined) return
    if (typeof serialized !== 'string' || safeNow() >= state.deadline) {
      if (safeNow() >= state.deadline) timeout(state)
      else commitControlledFailure(state, 'EXECUTION_FAILED')
      return
    }
    state.serialized = serialized

    let subscription: DocumentProcessUnsubscribe
    try {
      subscription = deps.transport.subscribe(makeEvents(state))
      state.unsubscribe = normalizeUnsubscribe(subscription)
      state.subscribed = true
    } catch {
      if (owns(state)) {
        resolveOnce(state, resultFailure(state.request, 'EXECUTION_FAILED'))
        release(state)
      }
      return
    }
    if (!owns(state) || state.outcome !== undefined) return
    if (safeNow() >= state.deadline) {
      timeout(state)
      return
    }
    invokeStart(state)
  }

  const cancel = (): boolean => {
    if (!current || !owns(current) || current.outcome !== undefined) return false
    commitControlledFailure(current, 'CANCELLED')
    return true
  }

  const dispose = (): void => {
    disposed = true
    const state = current
    if (!state || !owns(state)) return
    state.disposed = true
    if (state.outcome === undefined) commitControlledFailure(state, 'EXECUTION_FAILED')
    else {
      abortController(state)
      if (state.child && !state.exitConfirmed) kill(state, state.child)
      maybeRelease(state)
    }
  }

  const run = (
    rawRequest: unknown,
    options?: DocumentProcessRunOptions | AbortSignal
  ): Promise<DocumentProcessOutcome> => {
    if (disposed) return Promise.resolve(shortFailure('EXECUTION_FAILED'))
    if (current && owns(current)) return Promise.resolve(shortFailure('LIMIT'))

    let resolveRun!: (outcome: DocumentProcessOutcome) => void
    const promise = new Promise<DocumentProcessOutcome>((resolve) => {
      resolveRun = resolve
    })
    const generation = nextGeneration + 1
    nextGeneration = generation
    const state: RunState = {
      generation,
      controller: new AbortController(),
      deadline: safeNow() + DOCUMENT_PROCESS_DEADLINE_MS,
      resolve: resolveRun,
      dataSeen: false,
      requestSent: false,
      startCalled: false,
      startSettled: false,
      startFailedSynchronously: false,
      subscribed: false,
      released: false,
      disposed: false,
      exitConfirmed: false,
      exitSuccessful: false,
      ackStarted: false,
      ackSettled: false,
      ackSucceeded: false,
      killAttempted: false
    }
    current = state
    scheduleTimeout(state)
    void initialize(state, rawRequest, normalizeSignal(options)).catch(() => {
      if (owns(state) && state.outcome === undefined) {
        resolveOnce(state, fullFailure(state, 'EXECUTION_FAILED'))
        maybeRelease(state)
      }
    })
    return promise
  }

  const supervisor: DocumentProcessSupervisor = {
    run,
    cancel,
    dispose,
    isBusy: () => current !== null && owns(current),
    get state(): DocumentProcessSupervisorState {
      if (disposed) return 'disposed'
      if (!current || !owns(current)) return 'idle'
      return current.outcome === undefined ? 'running' : 'quarantined'
    }
  }
  return supervisor
}
