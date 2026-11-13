import { isPromise } from 'node:util/types'

const nativePromisePrototype = Promise.prototype
const nativePromiseThen = Promise.prototype.then

export type CooperativeExecutionKind =
  | 'assistant-turn'
  | 'llm-inference'
  | 'tool-invocation'
  | 'scheduled-task'
  | 'graph-node'

export interface CooperativeExecutionGate {
  /** Legacy wake/cancellation checkpoint, not an execution grant. Prefer run(). */
  checkpoint(kind: CooperativeExecutionKind, signal?: AbortSignal): Promise<void>
  /** Running-only legacy registration; throws synchronously while paused. */
  enter(kind: CooperativeExecutionKind): () => void
}

/**
 * Main-only callback ownership. A child gate is valid only while its exact parent
 * callback is live. This bounds callback settlement, not external-effect drainage.
 * Callbacks return only void or an ordinary same-realm native Promise<void>; data
 * must be captured inside the callback. Custom thenables/subclasses are rejected.
 */
export interface CooperativeOperationGate {
  run(
    kind: CooperativeExecutionKind,
    signal: AbortSignal | undefined,
    operation: (children: CooperativeOperationGate) => void | Promise<void>
  ): Promise<void>
}

type OperationLease = {
  live: boolean
  readonly signals: readonly AbortSignal[]
}

declare const pauseTicketBrand: unique symbol

/** MAIN-only identity for one uninterrupted pause; never an execution capability. */
export type CooperativePauseTicket = Readonly<{ [pauseTicketBrand]: true }>

export class CooperativeExecutionPausedError extends Error {
  readonly code = 'COOPERATIVE_EXECUTION_PAUSED'

  constructor() {
    super('Legacy cooperative entry is not allowed while paused. Use scoped callback admission.')
    this.name = 'CooperativeExecutionPausedError'
  }
}

export class CooperativePauseSupersededError extends Error {
  readonly code = 'COOPERATIVE_PAUSE_SUPERSEDED'

  constructor() {
    super('The cooperative pause request is no longer current.')
    this.name = 'CooperativePauseSupersededError'
  }
}

type Waiter = () => void

export class CooperativeExecutionController implements CooperativeExecutionGate, CooperativeOperationGate {
  private paused = false
  private pauseTicket?: CooperativePauseTicket
  private readonly active = new Map<CooperativeExecutionKind, number>()
  private readonly resumeWaiters = new Set<Waiter>()
  private readonly quiescenceWaiters = new Set<Waiter>()

  async checkpoint(_kind: CooperativeExecutionKind, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!this.paused) return
    let resume: Waiter | undefined
    let abort: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        resume = resolve
        abort = () => reject(signal?.reason)
        this.resumeWaiters.add(resume)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      // resume() may resolve the waiter just before cancellation in the same tick.
      signal?.throwIfAborted()
    } finally {
      if (resume) this.resumeWaiters.delete(resume)
      if (abort) signal?.removeEventListener('abort', abort)
    }
  }

  /** Root entry. Active work is registered in the same turn as the pause check. */
  run(
    kind: CooperativeExecutionKind,
    signal: AbortSignal | undefined,
    operation: (children: CooperativeOperationGate) => void | Promise<void>
  ): Promise<void> {
    return this.runOperation(kind, signal, operation)
  }

  private async runOperation(
    kind: CooperativeExecutionKind,
    signal: AbortSignal | undefined,
    operation: (children: CooperativeOperationGate) => void | Promise<void>,
    parent?: OperationLease
  ): Promise<void> {
    const signals = [...new Set([...(parent?.signals ?? []), ...(signal ? [signal] : [])])]
    for (;;) {
      if (parent && !parent.live) {
        throw Object.assign(new Error('This cooperative operation scope has already settled.'), {
          code: 'COOPERATIVE_SCOPE_RELEASED'
        })
      }
      for (const inherited of signals) inherited.throwIfAborted()
      if (parent || !this.paused) break
      await this.waitForOperationResume(signals)
      // A wakeup is not admission: resume/re-pause may occur before continuation.
    }

    const lease: OperationLease = { live: true, signals }
    // No await may separate eligibility from registration or callback invocation.
    const leave = this.registerActive(kind)
    const children: CooperativeOperationGate = Object.freeze({
      run: (
        childKind: CooperativeExecutionKind,
        childSignal: AbortSignal | undefined,
        child: (descendants: CooperativeOperationGate) => void | Promise<void>
      ) => this.runOperation(childKind, childSignal, child, lease)
    })
    try {
      const result = operation(children)
      // No data-returning/foreign thenable API: only void or an ordinary local
      // native promise. Do not read arbitrary .then/constructor accessors.
      if (result !== undefined) {
        if (
          !isPromise(result) ||
          Object.getPrototypeOf(result) !== nativePromisePrototype ||
          Object.getOwnPropertyDescriptor(result, 'constructor') ||
          Object.getOwnPropertyDescriptor(result, 'then')
        ) {
          throw Object.assign(new Error('Cooperative callbacks must return void or an ordinary native Promise<void>.'), {
            code: 'COOPERATIVE_CALLBACK_RESULT_UNSUPPORTED'
          })
        }
        await new Promise<void>((resolve, reject) => {
          // Ignore the fulfilled value, so no getter/thenable is assimilated a
          // second time after active ownership has been released.
          Reflect.apply(nativePromiseThen, result, [() => resolve(), reject])
        })
      }
    } finally {
      lease.live = false
      leave()
    }
  }

  private async waitForOperationResume(signals: readonly AbortSignal[]): Promise<void> {
    let resume: Waiter | undefined
    const abortHandlers: Array<readonly [AbortSignal, () => void]> = []
    try {
      await new Promise<void>((resolve, reject) => {
        resume = resolve
        this.resumeWaiters.add(resume)
        for (const signal of signals) {
          const abort = () => reject(signal.reason)
          abortHandlers.push([signal, abort])
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }
      })
    } finally {
      if (resume) this.resumeWaiters.delete(resume)
      for (const [signal, abort] of abortHandlers) signal.removeEventListener('abort', abort)
    }
  }

  enter(kind: CooperativeExecutionKind): () => void {
    // No ambient/nested exception: only an exact live callback child may drain
    // during pause. Eligibility and legacy registration stay in this same turn.
    if (this.paused) throw new CooperativeExecutionPausedError()
    return this.registerActive(kind)
  }

  private registerActive(kind: CooperativeExecutionKind): () => void {
    this.active.set(kind, (this.active.get(kind) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const next = (this.active.get(kind) ?? 1) - 1
      if (next > 0) this.active.set(kind, next)
      else this.active.delete(kind)
      if (this.active.size === 0) {
        for (const resolve of this.quiescenceWaiters) resolve()
        this.quiescenceWaiters.clear()
      }
    }
  }

  /** Observe actual registration drainage without changing admission or pause identity. */
  async whenQuiescent(): Promise<void> {
    // resume() also wakes these waiters. A wakeup alone never proves drainage;
    // recheck when another registration overtakes the resolved continuation too.
    while (!this.isQuiescent()) {
      await new Promise<void>((resolve) => this.quiescenceWaiters.add(resolve))
    }
  }

  async requestPause(): Promise<CooperativePauseTicket> {
    this.paused = true
    const ticket = this.pauseTicket ??= Object.freeze({}) as CooperativePauseTicket
    for (;;) {
      if (!this.paused || this.pauseTicket !== ticket) throw new CooperativePauseSupersededError()
      if (this.active.size === 0) return ticket
      await new Promise<void>((resolve) => this.quiescenceWaiters.add(resolve))
    }
  }

  /** Recheck synchronously at the consumer's state commit, even after await. */
  isPauseCurrent(ticket: CooperativePauseTicket): boolean {
    return this.paused && this.pauseTicket === ticket && this.active.size === 0
  }

  resume(): void {
    this.paused = false
    this.pauseTicket = undefined
    // Wake obsolete pause waiters without releasing any actual active operation.
    for (const resolve of this.quiescenceWaiters) resolve()
    this.quiescenceWaiters.clear()
    for (const resolve of this.resumeWaiters) resolve()
    this.resumeWaiters.clear()
  }

  isPaused(): boolean {
    return this.paused
  }

  isQuiescent(): boolean {
    return this.active.size === 0
  }
}
