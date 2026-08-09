import {
  cronDueInstants,
  nextCronInstant,
  parseCalendarInstant,
  parseCronSchedule
} from '../../../shared/magicAgentPlatform2/cronSchedule'
import type { PersistentTriggerStore } from './persistentTriggerStore'
import type { TriggerOccurrenceStore } from './triggerOccurrenceStore'

const text = (config: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = config[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
const positiveInt = (value: unknown, fallback: number): number =>
  Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback

export class CalendarCronTriggerSource {
  constructor(
    private readonly triggers: PersistentTriggerStore,
    private readonly occurrences: TriggerOccurrenceStore
  ) {}

  tick(now: number): number {
    if (!Number.isFinite(now) || now < 0)
      throw new Error('Calendar/cron tick must be non-negative.')
    let count = 0
    for (const trigger of this.triggers.list()) {
      if (trigger.state.type !== 'event' || !trigger.state.enabled || trigger.state.paused) continue
      const config = trigger.state.config ?? {}
      const sourceKind = text(config, 'sourceKind')
      const startAtText = text(config, 'startAt')
      if (sourceKind === 'calendar' && startAtText) {
        const instant = parseCalendarInstant(startAtText)
        const persistedCursor = config['sourceCursorAt']
        if (instant <= now && persistedCursor !== instant) {
          const occurrenceId = `calendar:${instant}:${trigger.id}`
          this.occurrences.enqueue({
            occurrenceId,
            triggerId: trigger.id,
            source: 'calendar',
            scheduledAt: instant,
            requestedAt: now,
            idempotencyKey: occurrenceId
          })
          this.triggers.advanceSourceCursor({
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
            cursorAt: instant,
            advancedAt: now,
            idempotencyKey: `calendar-cursor:${instant}`
          })
          count += 1
        }
      }
      const expression = text(config, 'cron')
      if (sourceKind === 'cron' && expression) {
        const schedule = parseCronSchedule(expression, text(config, 'timeZone') ?? 'UTC')
        const configuredStart = startAtText ? parseCalendarInstant(startAtText) : trigger.createdAt
        const persistedCursor = config['sourceCursorAt']
        const anchor =
          typeof persistedCursor === 'number' && Number.isFinite(persistedCursor)
            ? persistedCursor + 1
            : configuredStart
        const maxCatchUpRuns = positiveInt(config['maxCatchUpRuns'], 1)
        const due = cronDueInstants(schedule, anchor - 1, now, maxCatchUpRuns)
        for (const instant of due) {
          const occurrenceId = `cron:${instant}:${trigger.id}`
          this.occurrences.enqueue({
            occurrenceId,
            triggerId: trigger.id,
            source: 'cron',
            scheduledAt: instant,
            requestedAt: now,
            idempotencyKey: occurrenceId
          })
          count += 1
        }
        const latest = due.at(-1)
        if (latest !== undefined) {
          this.triggers.advanceSourceCursor({
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
            cursorAt: latest,
            advancedAt: now,
            idempotencyKey: `cron-cursor:${latest}`
          })
        }
        if (due.length === 0 && nextCronInstant(schedule, anchor - 1) === undefined)
          throw new Error(`Cron schedule has no match: ${trigger.id}`)
      }
    }
    return count
  }
}
