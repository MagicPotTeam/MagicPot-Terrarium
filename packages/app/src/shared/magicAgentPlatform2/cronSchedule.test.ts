import { describe, expect, it } from 'vitest'
import {
  cronDueInstants,
  cronMatchesInstant,
  nextCronInstant,
  parseCalendarInstant,
  parseCronSchedule
} from './cronSchedule'

describe('cronSchedule', () => {
  it('parses five-field UTC cron and applies standard DOM/DOW OR semantics', () => {
    const schedule = parseCronSchedule('30 9 1 * 1-5', 'UTC')
    expect(cronMatchesInstant(schedule, Date.parse('2026-06-01T09:30:00Z'))).toBe(true)
    expect(cronMatchesInstant(schedule, Date.parse('2026-06-02T09:30:00Z'))).toBe(true)
    expect(cronMatchesInstant(schedule, Date.parse('2026-06-07T09:30:00Z'))).toBe(false)
  })

  it('uses IANA timezone local wall-clock fields', () => {
    const schedule = parseCronSchedule('0 9 * * *', 'Asia/Shanghai')
    expect(cronMatchesInstant(schedule, Date.parse('2026-01-01T01:00:00Z'))).toBe(true)
    expect(cronMatchesInstant(schedule, Date.parse('2026-01-01T09:00:00Z'))).toBe(false)
  })

  it('finds deterministic next and bounded due instants', () => {
    const schedule = parseCronSchedule('*/15 * * * *', 'UTC')
    expect(nextCronInstant(schedule, Date.parse('2026-01-01T00:01:00Z'))).toBe(
      Date.parse('2026-01-01T00:15:00Z')
    )
    expect(
      cronDueInstants(
        schedule,
        Date.parse('2026-01-01T00:01:00Z'),
        Date.parse('2026-01-01T01:00:00Z'),
        3
      )
    ).toEqual([
      Date.parse('2026-01-01T00:15:00Z'),
      Date.parse('2026-01-01T00:30:00Z'),
      Date.parse('2026-01-01T00:45:00Z')
    ])
  })

  it('handles DST spring gaps and fall repeats as real instants', () => {
    const schedule = parseCronSchedule('30 2 * * *', 'America/New_York')
    expect(
      cronDueInstants(
        schedule,
        Date.parse('2026-03-08T05:00:00Z'),
        Date.parse('2026-03-09T08:00:00Z'),
        3
      )
    ).toEqual([Date.parse('2026-03-09T06:30:00Z')])
    const repeated = parseCronSchedule('30 1 * * *', 'America/New_York')
    expect(
      cronDueInstants(
        repeated,
        Date.parse('2026-11-01T04:00:00Z'),
        Date.parse('2026-11-01T07:00:00Z'),
        3
      )
    ).toEqual([Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-01T06:30:00Z')])
  })

  it('rejects unsupported grammar and offset-less calendar instants', () => {
    expect(() => parseCronSchedule('0 0 L * *')).toThrow()
    expect(() => parseCronSchedule('0 0 * * * *')).toThrow()
    expect(() => parseCronSchedule('0 0 * * *', 'Not/AZone')).toThrow()
    expect(() => parseCalendarInstant('2026-01-01T09:00:00')).toThrow()
    expect(parseCalendarInstant('2026-01-01T09:00:00+08:00')).toBe(
      Date.parse('2026-01-01T01:00:00Z')
    )
  })
})
