import type { PersistentTriggerStore } from './persistentTriggerStore'
import type { TriggerOccurrenceStore } from './triggerOccurrenceStore'

export class StartupTriggerSource {
  constructor(
    private readonly triggers: PersistentTriggerStore,
    private readonly occurrences: TriggerOccurrenceStore,
    private readonly bootId: string,
    private readonly now: () => number = Date.now
  ) {
    if (!bootId.trim()) throw new Error('Startup trigger bootId is required.')
  }

  enqueue(): number {
    const requestedAt = this.now()
    let count = 0
    for (const trigger of this.triggers.list()) {
      if (trigger.state.type !== 'startup' || !trigger.state.enabled || trigger.state.paused)
        continue
      const occurrenceId = `startup:${this.bootId}:${trigger.id}`
      this.occurrences.enqueue({
        occurrenceId,
        triggerId: trigger.id,
        source: 'startup',
        scheduledAt: requestedAt,
        requestedAt,
        idempotencyKey: occurrenceId
      })
      count += 1
    }
    return count
  }
}
