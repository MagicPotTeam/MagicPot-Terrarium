import type { MagicAgentDriveState } from '../../../shared/magicAgentPlatform2/drive'
import type { MagicAgentEventStore, StoredResource } from '../persistence/eventStore'
import { DriveDeliveryScheduler } from './driveDeliveryScheduler'
import { PersistentDriveStore } from './persistentDriveStore'

export type ProductionDriveRuntimeOptions = Readonly<{
  eventStore: MagicAgentEventStore
  deliver: (drive: StoredResource<MagicAgentDriveState>) => Promise<void>
  ownerId?: string
  pollIntervalMs?: number
  leaseMs?: number
  retryDelayMs?: number
  maxAttempts?: number
  now?: () => number
  token?: () => string
  deliveryEnabled?: boolean
}>

export class ProductionDriveRuntime {
  readonly store: PersistentDriveStore
  readonly scheduler: DriveDeliveryScheduler
  private started = false
  private readonly deliveryEnabled: boolean

  constructor(options: ProductionDriveRuntimeOptions) {
    this.deliveryEnabled = options.deliveryEnabled ?? true
    this.store = new PersistentDriveStore(options.eventStore)
    this.scheduler = new DriveDeliveryScheduler({
      store: this.store,
      deliver: options.deliver,
      ownerId: options.ownerId ?? 'production-drive-runtime',
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.token === undefined ? {} : { token: options.token })
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (this.deliveryEnabled) this.scheduler.start()
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    await this.scheduler.stop()
  }
}
