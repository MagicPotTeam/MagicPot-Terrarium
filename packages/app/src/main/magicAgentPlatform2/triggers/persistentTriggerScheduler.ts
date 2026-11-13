import { randomUUID } from 'node:crypto'
import { withCooperativeOperation } from '../../assistantRuntime/cooperativeOperation'
import type { CooperativeOperationGate } from '../agents/cooperativeExecutionController'
import type { PersistentTriggerState, PersistentTriggerStore } from './persistentTriggerStore'

/** MAIN-only execution context, never read from persisted trigger config or IPC JSON. */
export type TriggerExecutionOptions = Readonly<{
  signal: AbortSignal
  cooperativeExecution?: CooperativeOperationGate
}>

export type TriggerExecution = (
  trigger: PersistentTriggerState,
  options: TriggerExecutionOptions
) => Promise<void>

export type PersistentTriggerSchedulerOptions = Readonly<{
  store: PersistentTriggerStore
  execute: TriggerExecution
  pollIntervalMs?: number
  leaseMs?: number
  retryDelayMs?: number
  now?: () => number
  claimId?: () => string
  cooperativeExecution?: CooperativeOperationGate
}>

type AdmissionAttempt = {
  readonly controller: AbortController
  readonly cancellation: Error
  admitted: boolean
}

export class PersistentTriggerScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private stopping = false
  private generation = 0
  private inFlight: Promise<boolean> | undefined
  private stopTask: Promise<void> | undefined
  private waitingAdmission: AdmissionAttempt | undefined
  private fault: Readonly<{ cause: unknown }> | undefined
  private readonly pollIntervalMs: number
  private readonly leaseMs: number
  private readonly retryDelayMs: number
  private readonly now: () => number
  private readonly claimId: () => string

  constructor(private readonly options: PersistentTriggerSchedulerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.leaseMs = options.leaseMs ?? 30_000
    this.retryDelayMs = options.retryDelayMs ?? 5_000
    this.now = options.now ?? Date.now
    this.claimId = options.claimId ?? randomUUID
    for (const [name, value] of [
      ['poll interval', this.pollIntervalMs],
      ['lease', this.leaseMs],
      ['retry delay', this.retryDelayMs]
    ] as const) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`Trigger scheduler ${name} must be positive.`)
    }
  }

  /** Unexpected gate/claim/settlement errors halt this owner; not a trigger retry. */
  getFault(): Readonly<{ cause: unknown }> | undefined {
    return this.fault
  }

  start(): void {
    if (this.stopTask) throw new Error('Trigger scheduler is stopping.')
    if (this.fault) throw new Error('Trigger scheduler is faulted.', { cause: this.fault.cause })
    if (this.running) return
    this.stopping = false
    this.running = true
    this.generation += 1
    this.schedule(0, this.generation)
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask
    this.stopping = true
    this.running = false
    this.generation += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const current = this.inFlight
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const task = new Promise<void>((done, failed) => {
      resolve = done
      reject = failed
    })
    // Publish the drain before synchronous abort listeners can reenter start/stop.
    this.stopTask = task
    const waiting = this.waitingAdmission
    if (waiting && !waiting.admitted) waiting.controller.abort(waiting.cancellation)
    void Promise.resolve(current).then(
      () => {
        if (this.stopTask === task) this.stopTask = undefined
        resolve()
      },
      (error) => {
        if (this.stopTask === task) this.stopTask = undefined
        reject(error)
      }
    )
    return task
  }

  async runOnce(): Promise<boolean> {
    if (this.fault) throw this.fault.cause
    if (this.inFlight || this.stopping) return false
    const attempt: AdmissionAttempt = {
      controller: new AbortController(),
      cancellation: new Error('Trigger scheduler stopped before admission.'),
      admitted: false
    }
    // Install BOTH identities before any gate, clock, claim or executor callback.
    // A synchronous stop before this microtask must still cancel this exact wait.
    this.waitingAdmission = attempt
    const task = Promise.resolve().then(() => this.executeOne(attempt))
    this.inFlight = task
    try {
      return await task
    } catch (error) {
      this.fault = Object.freeze({ cause: error })
      this.running = false
      this.generation += 1
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      throw error
    } finally {
      if (this.waitingAdmission === attempt) this.waitingAdmission = undefined
      if (this.inFlight === task) this.inFlight = undefined
    }
  }

  private schedule(delay: number, generation: number): void {
    if (!this.running || this.stopping || generation !== this.generation) return
    const timer = setTimeout(() => {
      if (this.timer === timer) this.timer = undefined
      if (!this.running || this.stopping || generation !== this.generation) return
      void this.runOnce().then(
        () => this.schedule(this.pollIntervalMs, generation),
        // runOnce latches the original fault. No unhandled rejection or automatic
        // next claim after an unknown partial gate/claim/settlement failure.
        () => undefined
      )
    }, delay)
    this.timer = timer
  }

  private async executeOne(attempt: AdmissionAttempt): Promise<boolean> {
    const signal = attempt.controller.signal
    try {
      return await withCooperativeOperation(
        this.options.cooperativeExecution,
        'scheduled-task',
        signal,
        async (children) => {
          // The helper guards cancellation inside gate admission, preserving stale
          // parent precedence. No later stop aborts this admitted callback's signal.
          attempt.admitted = true
          if (this.waitingAdmission === attempt) this.waitingAdmission = undefined
          const claimId = this.claimId()
          const claimed = this.options.store.claimDue(this.now(), claimId, this.leaseMs)
          if (!claimed) return false
          try {
            await this.options.execute(claimed.state, {
              signal,
              ...(children ? { cooperativeExecution: children } : {})
            })
            this.options.store.completeClaim(claimed.id, claimId, this.now())
          } catch (error) {
            // Preserve existing execution/completion failure and backoff semantics.
            // A failClaim exception escapes and faults this scheduler, not success.
            const message = error instanceof Error ? error.message : String(error)
            this.options.store.failClaim(
              claimed.id,
              claimId,
              this.now(),
              message,
              this.retryDelayMs
            )
          }
          return true
        }
      )
    } catch (error) {
      if (!attempt.admitted && signal.aborted && error === attempt.cancellation) return false
      throw error
    }
  }
}
