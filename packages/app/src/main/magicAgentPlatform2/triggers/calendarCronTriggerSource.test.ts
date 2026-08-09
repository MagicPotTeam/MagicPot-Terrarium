import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { CalendarCronTriggerSource } from './calendarCronTriggerSource'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { TriggerOccurrenceStore } from './triggerOccurrenceStore'

describe('CalendarCronTriggerSource', () => {
  it('durably enqueues one-shot calendar and bounded cron catch-up occurrences', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const triggers = new PersistentTriggerStore(eventStore)
      const occurrences = new TriggerOccurrenceStore(eventStore)
      triggers.create(
        {
          id: 'calendar-one',
          type: 'event',
          title: 'Calendar one',
          enabled: true,
          config: { sourceKind: 'calendar', startAt: '2026-01-01T00:15:00Z' }
        },
        Date.parse('2026-01-01T00:00:00Z'),
        'calendar-create'
      )
      triggers.create(
        {
          id: 'cron-one',
          type: 'event',
          title: 'Cron one',
          enabled: true,
          config: {
            sourceKind: 'cron',
            cron: '*/15 * * * *',
            timeZone: 'UTC',
            startAt: '2026-01-01T00:01:00Z',
            maxCatchUpRuns: 2
          }
        },
        Date.parse('2026-01-01T00:00:00Z'),
        'cron-create'
      )
      const source = new CalendarCronTriggerSource(triggers, occurrences)
      const now = Date.parse('2026-01-01T01:00:00Z')
      expect(source.tick(now)).toBe(3)
      expect(source.tick(now)).toBe(2)
      expect(source.tick(now)).toBe(0)
      expect(
        occurrences
          .list()
          .map((item) => item.id)
          .toSorted()
      ).toEqual([
        `calendar:${Date.parse('2026-01-01T00:15:00Z')}:calendar-one`,
        `cron:${Date.parse('2026-01-01T00:15:00Z')}:cron-one`,
        `cron:${Date.parse('2026-01-01T00:30:00Z')}:cron-one`,
        `cron:${Date.parse('2026-01-01T00:45:00Z')}:cron-one`,
        `cron:${Date.parse('2026-01-01T01:00:00Z')}:cron-one`
      ])
      expect(triggers.get('calendar-one')?.state.config?.['sourceCursorAt']).toBe(
        Date.parse('2026-01-01T00:15:00Z')
      )
      expect(triggers.get('cron-one')?.state.config?.['sourceCursorAt']).toBe(
        Date.parse('2026-01-01T01:00:00Z')
      )
    } finally {
      eventStore.close()
    }
  })
})
