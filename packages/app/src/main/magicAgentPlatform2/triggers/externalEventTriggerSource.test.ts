import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { ExternalEventTriggerSource } from './externalEventTriggerSource'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { TriggerOccurrenceStore } from './triggerOccurrenceStore'

describe('ExternalEventTriggerSource', () => {
  it('enqueues matching SDK/custom events without raw payload persistence', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const triggers = new PersistentTriggerStore(eventStore)
      const occurrences = new TriggerOccurrenceStore(eventStore)
      triggers.create(
        {
          id: 'sdk-event',
          type: 'event',
          title: 'SDK event',
          enabled: true,
          config: { sourceKind: 'sdk', eventName: 'order.created' }
        },
        0,
        'sdk-event-create'
      )
      const source = new ExternalEventTriggerSource(triggers, occurrences)
      const event = {
        source: 'sdk' as const,
        eventId: 'event-1',
        eventName: 'order.created',
        emittedAt: 10,
        payloadDigest: 'c'.repeat(64)
      }
      expect(source.enqueue(event)).toBe(1)
      expect(source.enqueue(event)).toBe(1)
      expect(occurrences.list()).toHaveLength(1)
      expect(occurrences.list()[0]?.state).toMatchObject({
        occurrenceId: 'sdk:event-1:sdk-event',
        source: 'sdk',
        payloadDigest: 'c'.repeat(64)
      })
    } finally {
      eventStore.close()
    }
  })
})
