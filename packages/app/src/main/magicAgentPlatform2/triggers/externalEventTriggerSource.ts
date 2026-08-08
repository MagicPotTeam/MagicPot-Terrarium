import { sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import type { PersistentTriggerStore } from './persistentTriggerStore'
import type { TriggerOccurrenceStore, TriggerOccurrenceSource } from './triggerOccurrenceStore'

export type ExternalTriggerEvent = Readonly<{
  source: 'sdk' | 'custom'
  eventId: string
  eventName: string
  emittedAt: number
  payloadDigest?: string
}>

export class ExternalEventTriggerSource {
  constructor(
    private readonly triggers: PersistentTriggerStore,
    private readonly occurrences: TriggerOccurrenceStore
  ) {}

  enqueue(event: ExternalTriggerEvent): number {
    if (!event.eventId.trim() || !event.eventName.trim())
      throw new Error('External trigger event identity is required.')
    if (!Number.isFinite(event.emittedAt) || event.emittedAt < 0)
      throw new Error('External trigger emittedAt must be non-negative and finite.')
    let count = 0
    for (const trigger of this.triggers.list()) {
      const config = trigger.state.config ?? {}
      if (
        trigger.state.type !== 'event' ||
        !trigger.state.enabled ||
        trigger.state.paused ||
        config['sourceKind'] !== event.source ||
        config['eventName'] !== event.eventName
      )
        continue
      const occurrenceId = `${event.source}:${event.eventId}:${trigger.id}`
      this.occurrences.enqueue({
        occurrenceId,
        triggerId: trigger.id,
        source: event.source as TriggerOccurrenceSource,
        scheduledAt: event.emittedAt,
        requestedAt: event.emittedAt,
        idempotencyKey: occurrenceId,
        payloadDigest: event.payloadDigest ?? sha256PolicyText(event.eventId)
      })
      count += 1
    }
    return count
  }
}
