export type CronField = ReadonlySet<number>
export type CronSchedule = Readonly<{
  expression: string
  timeZone: string
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
  dayOfMonthWildcard: boolean
  dayOfWeekWildcard: boolean
}>

const ranges = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7]
] as const

const parseNumber = (value: string, min: number, max: number): number => {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid cron value: ${value}`)
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(`Cron value out of range: ${value}`)
  return number
}

const parseField = (source: string, min: number, max: number): CronField => {
  if (!source) throw new Error('Cron field is required.')
  const values = new Set<number>()
  for (const item of source.split(',')) {
    const [base, stepText, extra] = item.split('/')
    if (extra !== undefined || !base) throw new Error(`Invalid cron field: ${source}`)
    const step = stepText === undefined ? 1 : parseNumber(stepText, 1, max - min + 1)
    let start: number
    let end: number
    if (base === '*') {
      start = min
      end = max
    } else if (base.includes('-')) {
      const parts = base.split('-')
      if (parts.length !== 2) throw new Error(`Invalid cron range: ${base}`)
      start = parseNumber(parts[0]!, min, max)
      end = parseNumber(parts[1]!, min, max)
      if (start > end) throw new Error(`Cron range must not wrap: ${base}`)
    } else {
      if (stepText !== undefined) throw new Error(`Cron step requires * or range: ${item}`)
      start = parseNumber(base, min, max)
      end = start
    }
    for (let value = start; value <= end; value += step)
      values.add(value === 7 && min === 0 ? 0 : value)
  }
  return values
}

export const validateCronTimeZone = (timeZone: string): string => {
  const normalized = timeZone.trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(0)
  } catch {
    throw new Error(`Invalid cron time zone: ${normalized}`)
  }
  return normalized
}

export const parseCronSchedule = (expression: string, timeZone = 'UTC'): CronSchedule => {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Cron expression must contain five fields.')
  const parsed = fields.map((field, index) => {
    const [min, max] = ranges[index]!
    return parseField(field!, min, max)
  })
  return {
    expression: fields.join(' '),
    timeZone: validateCronTimeZone(timeZone),
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: parsed[4]!,
    dayOfMonthWildcard: fields[2] === '*',
    dayOfWeekWildcard: fields[4] === '*'
  }
}

const localParts = (instant: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  return {
    minute: get('minute'),
    hour: get('hour'),
    day,
    month,
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  }
}

export const cronMatchesInstant = (schedule: CronSchedule, instant: number): boolean => {
  if (!Number.isFinite(instant)) throw new Error('Cron instant must be finite.')
  const part = localParts(instant, schedule.timeZone)
  const dom = schedule.dayOfMonth.has(part.day)
  const dow = schedule.dayOfWeek.has(part.dayOfWeek)
  const dayMatches = schedule.dayOfMonthWildcard
    ? dow
    : schedule.dayOfWeekWildcard
      ? dom
      : dom || dow
  return (
    schedule.minute.has(part.minute) &&
    schedule.hour.has(part.hour) &&
    schedule.month.has(part.month) &&
    dayMatches
  )
}

export const nextCronInstant = (
  schedule: CronSchedule,
  afterExclusive: number,
  searchLimitMinutes = 366 * 24 * 60 * 5
): number | undefined => {
  if (!Number.isFinite(afterExclusive)) throw new Error('Cron cursor must be finite.')
  if (!Number.isInteger(searchLimitMinutes) || searchLimitMinutes <= 0)
    throw new Error('Cron search limit must be a positive integer.')
  let candidate = Math.floor(afterExclusive / 60_000) * 60_000 + 60_000
  for (let index = 0; index < searchLimitMinutes; index += 1) {
    if (cronMatchesInstant(schedule, candidate)) return candidate
    candidate += 60_000
  }
  return undefined
}

export const cronDueInstants = (
  schedule: CronSchedule,
  afterExclusive: number,
  throughInclusive: number,
  limit: number
): readonly number[] => {
  if (!Number.isFinite(throughInclusive)) throw new Error('Cron due boundary must be finite.')
  if (!Number.isInteger(limit) || limit <= 0)
    throw new Error('Cron due limit must be a positive integer.')
  const due: number[] = []
  let cursor = afterExclusive
  while (due.length < limit) {
    const next = nextCronInstant(schedule, cursor)
    if (next === undefined || next > throughInclusive) break
    due.push(next)
    cursor = next
  }
  return due
}

export const parseCalendarInstant = (value: string): number => {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    throw new Error('Calendar instant must include an explicit UTC offset.')
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) throw new Error('Invalid calendar instant.')
  return instant
}
