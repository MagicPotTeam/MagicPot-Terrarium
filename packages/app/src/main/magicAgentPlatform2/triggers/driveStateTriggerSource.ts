import type { DriveStateEvent } from '../drives/driveStateEvents'
import type { PersistentTriggerStore } from './persistentTriggerStore'
import type { TriggerOccurrenceStore } from './triggerOccurrenceStore'

export class DriveStateTriggerSource {
  constructor(
    private readonly triggers: PersistentTriggerStore,
    private readonly occurrences: TriggerOccurrenceStore
  ) {}

  enqueue(event: DriveStateEvent): number {
    let count = 0
    for (const trigger of this.triggers.list()) {
      const config = trigger.state.config ?? {}
      if (
        trigger.state.type !== 'event' ||
        !trigger.state.enabled ||
        trigger.state.paused ||
        config['sourceKind'] !== 'drive-state' ||
        (typeof config['driveId'] === 'string' && config['driveId'] !== event.driveId) ||
        (typeof config['status'] === 'string' && config['status'] !== event.status)
      )
        continue
      const occurrenceId = `drive-state:${event.eventId}:${trigger.id}`
      this.occurrences.enqueue({
        occurrenceId,
        triggerId: trigger.id,
        source: 'drive-state',
        scheduledAt: event.changedAt,
        requestedAt: event.changedAt,
        idempotencyKey: occurrenceId
      })
      count += 1
    }
    return count
  }
}
