import { randomUUID } from 'node:crypto'
import type { PersistentTriggerState, PersistentTriggerStore } from './persistentTriggerStore'

import type { CooperativeExecutionGate } from '../agents/cooperativeExecutionController'

export type TriggerExecution = (trigger: PersistentTriggerState) => Promise<void>

export type PersistentTriggerSchedulerOptions = Readonly<{
  store: PersistentTriggerStore
  execute: TriggerExecution
  pollIntervalMs?: number
  leaseMs?: number
  retryDelayMs?: number
  now?: () => number
  claimId?: () => string
  cooperativeExecution?: CooperativeExecutionGate
}>

export class PersistentTriggerScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private stopping = false
  private inFlight: Promise<boolean> | undefined
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

  start(): void {
    if (this.running) return
    this.stopping = false
    this.running = true
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  async runOnce(): Promise<boolean> {
    if (this.inFlight) return false
    const task = this.executeOne()
    this.inFlight = task
    try {
      return await task
    } finally {
      this.inFlight = undefined
    }
  }

  private schedule(delay: number): void {
    if (!this.running || this.stopping) return
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule(this.pollIntervalMs))
    }, delay)
  }

  private async executeOne(): Promise<boolean> {
    const claimId = this.claimId()
    const claimed = this.options.store.claimDue(this.now(), claimId, this.leaseMs)
    if (!claimed) return false
    try {
      await this.options.cooperativeExecution?.checkpoint('scheduled-task')
      const leaveScheduledTask = this.options.cooperativeExecution?.enter('scheduled-task')
      try {
        await this.options.execute(claimed.state)
      } finally {
        leaveScheduledTask?.()
      }
      this.options.store.completeClaim(claimed.id, claimId, this.now())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.store.failClaim(claimed.id, claimId, this.now(), message, this.retryDelayMs)
    }
    return true
  }
}
