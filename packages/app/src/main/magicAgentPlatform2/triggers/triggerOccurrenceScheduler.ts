import { randomUUID } from 'node:crypto'
import type { PersistentTriggerStore } from './persistentTriggerStore'
import type { TriggerOccurrenceState, TriggerOccurrenceStore } from './triggerOccurrenceStore'

export type TriggerOccurrenceSchedulerOptions = Readonly<{
  occurrences: TriggerOccurrenceStore
  triggers: PersistentTriggerStore
  execute: (
    trigger: ReturnType<PersistentTriggerStore['list']>[number]['state'],
    occurrence: TriggerOccurrenceState
  ) => Promise<void>
  pollIntervalMs?: number
  leaseMs?: number
  retryDelayMs?: number
  now?: () => number
  claimId?: () => string
}>

export class TriggerOccurrenceScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private inFlight: Promise<boolean> | undefined
  private readonly pollIntervalMs: number
  private readonly leaseMs: number
  private readonly retryDelayMs: number
  private readonly now: () => number
  private readonly claimId: () => string

  constructor(private readonly options: TriggerOccurrenceSchedulerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.leaseMs = options.leaseMs ?? 30_000
    this.retryDelayMs = options.retryDelayMs ?? 5_000
    this.now = options.now ?? Date.now
    this.claimId = options.claimId ?? randomUUID
    for (const [name, value] of [
      ['poll interval', this.pollIntervalMs],
      ['lease', this.leaseMs],
      ['retry delay', this.retryDelayMs]
    ] as const)
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`Trigger occurrence scheduler ${name} must be positive.`)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
  }

  async stop(): Promise<void> {
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
    if (!this.running) return
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule(this.pollIntervalMs))
    }, delay)
  }

  private async executeOne(): Promise<boolean> {
    const now = this.now()
    const claimId = this.claimId()
    const claimed = this.options.occurrences.claimNext(
      now,
      claimId,
      this.leaseMs,
      3,
      (occurrence) => {
        const trigger = this.options.triggers.get(occurrence.triggerId)
        return trigger !== undefined && trigger.state.enabled === true
      }
    )
    if (!claimed) return false
    const trigger = this.options.triggers.get(claimed.state.triggerId)
    if (!trigger) {
      this.options.occurrences.fail(
        claimed.id,
        claimId,
        now,
        new Error('Trigger unavailable after occurrence claim.'),
        this.retryDelayMs
      )
      return true
    }
    try {
      await this.options.execute(trigger.state, claimed.state)
      this.options.occurrences.complete(claimed.id, claimId, this.now())
    } catch (error) {
      this.options.occurrences.fail(claimed.id, claimId, this.now(), error, this.retryDelayMs)
    }
    return true
  }
}
