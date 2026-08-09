import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { TriggerOccurrenceStore } from './triggerOccurrenceStore'
import { DriveStateTriggerSource } from './driveStateTriggerSource'

describe('DriveStateTriggerSource', () => {
  it('matches committed Drive state and durably deduplicates occurrences', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const triggers = new PersistentTriggerStore(eventStore)
      const occurrences = new TriggerOccurrenceStore(eventStore)
      triggers.create(
        {
          id: 'drive-trigger',
          type: 'event',
          title: 'Drive completed',
          enabled: true,
          config: { sourceKind: 'drive-state', driveId: 'drive-1', status: 'completed' }
        },
        0,
        'create'
      )
      const source = new DriveStateTriggerSource(triggers, occurrences)
      const event = {
        eventId: 'drive-state:drive-1:2:20',
        driveId: 'drive-1',
        previousStatus: 'active' as const,
        status: 'completed' as const,
        revision: 2,
        changedAt: 20
      }
      expect(source.enqueue(event)).toBe(1)
      expect(source.enqueue(event)).toBe(1)
      expect(occurrences.list()).toHaveLength(1)
      expect(occurrences.list()[0]?.state).toMatchObject({ source: 'drive-state', requestedAt: 20 })
    } finally {
      eventStore.close()
    }
  })
})
