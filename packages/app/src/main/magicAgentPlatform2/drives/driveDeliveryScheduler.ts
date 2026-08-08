import { randomUUID } from 'node:crypto'
import type { MagicAgentDriveState } from '../../../shared/magicAgentPlatform2/drive'
import type { StoredResource } from '../persistence/eventStore'
import type { PersistentDriveStore } from './persistentDriveStore'

export type DriveDeliverySchedulerOptions = Readonly<{
  store: PersistentDriveStore
  deliver: (drive: StoredResource<MagicAgentDriveState>) => Promise<void>
  ownerId: string
  pollIntervalMs?: number
  leaseMs?: number
  retryDelayMs?: number
  maxAttempts?: number
  now?: () => number
  token?: () => string
}>

export class DriveDeliveryScheduler {
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<boolean> | undefined
  private readonly pollIntervalMs: number
  private readonly leaseMs: number
  private readonly retryDelayMs: number
  private readonly maxAttempts: number
  private readonly now: () => number
  private readonly token: () => string

  constructor(private readonly options: DriveDeliverySchedulerOptions) {
    if (!options.ownerId.trim()) throw new Error('Drive delivery scheduler ownerId is required.')
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.leaseMs = options.leaseMs ?? 30_000
    this.retryDelayMs = options.retryDelayMs ?? 5_000
    this.maxAttempts = options.maxAttempts ?? 3
    this.now = options.now ?? Date.now
    this.token = options.token ?? randomUUID
    for (const [name, value] of [
      ['poll interval', this.pollIntervalMs],
      ['lease', this.leaseMs],
      ['retry delay', this.retryDelayMs],
      ['max attempts', this.maxAttempts]
    ] as const)
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`Drive delivery scheduler ${name} must be positive.`)
    if (!Number.isInteger(this.maxAttempts))
      throw new Error('Drive delivery scheduler max attempts must be an integer.')
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
    const task = this.deliverOne()
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
    this.timer.unref?.()
  }

  private async deliverOne(): Promise<boolean> {
    const claimedAt = this.now()
    const token = this.token()
    const claimed = this.options.store.claimDelivery({
      now: claimedAt,
      leaseMs: this.leaseMs,
      ownerId: this.options.ownerId,
      token
    })
    if (!claimed) return false
    try {
      await this.options.deliver(claimed)
      this.options.store.acknowledgeDelivery({
        driveId: claimed.id,
        expectedRevision: claimed.revision,
        token,
        acknowledgedAt: this.now(),
        idempotencyKey: `scheduler-ack:${token}`
      })
    } catch (error) {
      this.options.store.failDelivery({
        driveId: claimed.id,
        expectedRevision: claimed.revision,
        token,
        failedAt: this.now(),
        reason: error instanceof Error ? error.message : String(error),
        retryDelayMs: this.retryDelayMs,
        maxAttempts: this.maxAttempts,
        idempotencyKey: `scheduler-fail:${token}`
      })
    }
    return true
  }
}
