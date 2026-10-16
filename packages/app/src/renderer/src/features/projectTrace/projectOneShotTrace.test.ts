import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectTraceEventSummary } from '@shared/projectTrace'
import {
  buildProjectComparison,
  clearProjectComparisons,
  readProjectComparisons,
  readProjectComparisonsState,
  sanitizeProjectHistory,
  saveProjectComparison,
  type ProjectComparisonProject,
  type ProjectComparisonResult
} from './projectOneShotTrace'

const NOW = Date.parse('2026-06-16T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const project = {
  id: 'project-a',
  introduction: 'Make a calm landscape',
  analysisProfileId: 'model-a'
}
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const event = (
  index = 0,
  overrides: Partial<ProjectTraceEventSummary> = {}
): ProjectTraceEventSummary => ({
  id: `event-${index}`,
  at: new Date(NOW - (200 - index) * 1000).toISOString(),
  scope: 'canvas',
  status: 'success',
  action: `move-${index}`,
  safeSummary: `Moved item ${index}`,
  ...overrides
})
const report = (
  index = 0,
  overrides: Partial<ProjectComparisonResult> = {}
): ProjectComparisonResult => ({
  id: `report-${index}`,
  at: new Date(NOW - (200 - index) * 1000).toISOString(),
  profileId: 'model-a',
  eventCount: 1,
  advice: 'The layout appears aligned; colors cannot be assessed from movement metrics.',
  estimatedInputTokens: 100,
  ...overrides
})

const secrets = [
  ['person@private.invalid', 'person@private.invalid'],
  ['Bearer abcdef123456SECRET', 'abcdef123456SECRET'],
  ['Authorization: Bearer opaqueCredential', 'opaqueCredential'],
  ['authorization = Basic opaqueBasic', 'opaqueBasic'],
  ['Authorization: Digest username="privateUser", response="privateDigest"', 'privateDigest'],
  ['`/home/privateOwner/private.txt`', 'privateOwner'],
  ['sk-proj-abcdef123456SECRET', 'abcdef123456SECRET'],
  ['AIzaabcdef123456SECRET', 'abcdef123456SECRET'],
  ['api_key=abcdef123456SECRET', 'abcdef123456SECRET'],
  ['{"apiKey":"abcdef123456SECRET"}', 'abcdef123456SECRET'],
  ['{"password": "my very private SECRET"}', 'my very private SECRET'],
  ['{"client_secret":"abcdef123456SECRET"}', 'abcdef123456SECRET'],
  ['{"Authorization":"Bearer abcdef123456SECRET"}', 'abcdef123456SECRET'],
  ['C:\\Users\\privateOwner\\file.png', 'privateOwner'],
  ['D:/fixtureOwner/full file.txt', 'fixtureOwner'],
  ['\\\\privateServer\\privateOwner\\file.png', 'privateOwner'],
  ['/home/privateOwner/file.png', 'privateOwner'],
  ['file:///home/privateOwner/file.png', 'privateOwner'],
  ['local-media://privateOwner/file.png', 'privateOwner'],
  ['https://privateOwner.invalid/file?token=privateQuery#secret', 'privateOwner'],
  ['https://safe.invalid/?signature=privateQuery', 'privateQuery'],
  ['data:image/png;base64,privateAttachment', 'privateAttachment'],
  ['Ｂｅａｒｅｒ abcdef123456SECRET', 'abcdef123456SECRET']
] as const

let storage: Map<string, string>
let setItem: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  storage = new Map()
  setItem = vi.fn((key: string, value: string) => storage.set(key, value))
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem,
    removeItem: vi.fn((key: string) => storage.delete(key))
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('sanitizeProjectHistory', () => {
  it('redacts every free-text field and array element, and strips unapproved fields', () => {
    for (const [input, secret] of secrets) {
      for (const field of ['id', 'action', 'safeSummary', 'label', 'entityType'] as const) {
        const result = sanitizeProjectHistory([
          { ...event(), [field]: input, prompt: 'RAW_PROMPT', provider: { apiKey: 'RAW_KEY' } }
        ])
        expect(result).toHaveLength(1)
        expect(JSON.stringify(result), `${field}: ${input}`).not.toContain(secret)
        expect(JSON.stringify(result)).not.toContain('RAW_')
      }
      for (const field of ['inputKinds', 'outputKinds', 'riskSignals'] as const) {
        const result = sanitizeProjectHistory([{ ...event(), [field]: [input] }])
        expect(result).toHaveLength(1)
        expect(JSON.stringify(result), `${field}: ${input}`).not.toContain(secret)
      }
      for (const field of ['at', 'scope', 'status'] as const) {
        expect(sanitizeProjectHistory([{ ...event(), [field]: input }])).toEqual([])
      }
    }
  })

  it('redaction is idempotent through capture, persistence, preview, and reread', () => {
    for (const [text] of [...secrets, ['token=[redacted] password=[redacted-token]', '']]) {
      const once = sanitizeProjectHistory([event(1, { safeSummary: text })])
      expect(sanitizeProjectHistory(once)).toEqual(once)
      expect(sanitizeProjectHistory(sanitizeProjectHistory(once))).toEqual(once)
    }
  })

  it('keeps the newest 120 unique events in chronological order, with a 30-day TTL', () => {
    const values = Array.from({ length: 150 }, (_, i) => event(i))
    const result = sanitizeProjectHistory([
      ...values.reverse(),
      event(149),
      event(0, { id: 'expired', at: new Date(NOW - 30 * DAY - 1).toISOString() }),
      event(0, { id: 'future', at: new Date(NOW + 1).toISOString() })
    ])
    expect(result).toHaveLength(120)
    expect(result[0].id).toBe('event-30')
    expect(result[119].id).toBe('event-149')
    expect(new Set(result.map((item) => item.id)).size).toBe(120)
    expect(
      sanitizeProjectHistory([event(0, { at: new Date(NOW - 30 * DAY).toISOString() })])
    ).toHaveLength(1)
  })

  it('preserves equal-time ordering across repeated sanitization and takes the latest duplicate', () => {
    const at = new Date(NOW).toISOString()
    const events = [event(1, { at }), event(2, { at }), event(3, { at })]
    expect(sanitizeProjectHistory(sanitizeProjectHistory(events))).toEqual(events)
    const duplicate = { ...events[1], safeSummary: 'Latest duplicate' }
    expect(sanitizeProjectHistory([...events, duplicate])[1]).toEqual(duplicate)
  })

  it('bounds arrays, strings, counts and measurements without coercing unknown objects', () => {
    const hostile = {
      toString: () => {
        throw new Error('RAW_SECRET')
      }
    }
    const [result] = sanitizeProjectHistory([
      {
        ...event(),
        action: 'a'.repeat(1000),
        safeSummary: 'x'.repeat(8000),
        inputKinds: [...Array(20).fill('image'), hostile],
        outputKinds: [false, {}, null, 'image'],
        entityCount: Infinity,
        affectedItemCount: -1,
        createdItemCount: 1.2,
        removedItemCount: '8',
        rotatedItemCount: 1e10,
        resizedItemCount: 9,
        movementDistancePx: 12.345,
        maxScaleChangeRatio: NaN,
        canvasMutation: 'true'
      }
    ])
    expect(result.action).toHaveLength(160)
    expect(result.safeSummary).toHaveLength(1600)
    expect(result.inputKinds).toHaveLength(12)
    expect(result.outputKinds).toEqual(['image'])
    expect(result.resizedItemCount).toBe(9)
    expect(result.movementDistancePx).toBe(12.35)
    for (const key of [
      'entityCount',
      'affectedItemCount',
      'createdItemCount',
      'removedItemCount',
      'rotatedItemCount',
      'maxScaleChangeRatio',
      'canvasMutation'
    ]) {
      expect(result).not.toHaveProperty(key)
    }
  })

  it('drops malformed records and handles invalid containers or time safely', () => {
    for (const input of [null, {}, 'raw', 42]) expect(sanitizeProjectHistory(input)).toEqual([])
    expect(sanitizeProjectHistory([event()], NaN)).toEqual([])
    const bad = [
      null,
      {},
      [],
      { ...event(), id: '' },
      { ...event(), action: {} },
      { ...event(), safeSummary: 'x'.repeat(20000) },
      { ...event(), scope: 'unknown' },
      { ...event(), status: 'complete' },
      { ...event(), at: 'yesterday' }
    ]
    expect(sanitizeProjectHistory(bad)).toEqual([])
    expect(
      sanitizeProjectHistory([
        {
          get id() {
            throw new Error('SECRET')
          }
        },
        event()
      ])
    ).toHaveLength(1)
  })

  it('bounds scanning and does not mutate its input', () => {
    const value = Object.freeze(event())
    expect(sanitizeProjectHistory(Object.freeze([value]))).toEqual([value])
    const result = sanitizeProjectHistory([event(0), ...Array(2400).fill(null)])
    expect(result).toEqual([])
  })
})

describe('buildProjectComparison', () => {
  it('uses the exact selected agent profile without a route, API override, tools or provider object', () => {
    const output = buildProjectComparison(
      project,
      [event(0, { entityCount: 2, inputKinds: ['text'] })],
      'model-a',
      'zh-CN'
    )
    expect(Object.keys(output.request).sort()).toEqual([
      'maxOutputTokens',
      'messages',
      'profileId',
      'profileScope',
      'temperature'
    ])
    expect(output.request).toMatchObject({
      profileId: 'model-a',
      profileScope: 'agent',
      temperature: 0.2,
      maxOutputTokens: 1200
    })
    expect(JSON.parse(output.preview).events[0]).toEqual({
      scope: 'canvas',
      status: 'success',
      action: 'move-0',
      at: event().at,
      safeSummary: 'Moved item 0',
      entityCount: 2
    })
    expect(output.payloadBytes).toBe(bytes(output.request))
    expect(output.estimatedInputTokens).toBe(Math.ceil(output.payloadBytes / 3))
    expect(output.request.messages[0].content).toContain('untrusted data')
    expect(output.request.messages[0].content).toContain('not an executable plan')
    expect(output.request.messages[0].content).toContain('uncertainty')
  })

  it('exports no raw IDs, roots, prompts, replies, attachments, files or provider objects', () => {
    const values = [
      {
        ...event(),
        id: 'RAW_EVENT_ID',
        prompt: 'RAW_PROMPT',
        reply: 'RAW_REPLY',
        attachments: ['RAW_ATTACHMENT'],
        file: 'RAW_FILE',
        provider: { apiKey: 'RAW_KEY' }
      }
    ]
    const output = buildProjectComparison(
      { ...project, id: 'RAW_PROJECT_ID', rootPath: 'C:/RAW_ROOT' } as ProjectComparisonProject,
      values,
      'model-a',
      'en'
    )
    expect(JSON.stringify(output)).not.toContain('RAW_')
    expect(storage.size).toBe(0)
  })

  it('redacts introductions and summaries, even when truncation would split a secret', () => {
    for (const [input, secret] of secrets) {
      const output = buildProjectComparison(
        { ...project, introduction: input },
        [event(0, { safeSummary: `${'x'.repeat(1595)} ${input}` })],
        'model-a',
        input
      )
      expect(JSON.stringify(output), input).not.toContain(secret)
      expect(JSON.parse(output.preview).language).toBe('en')
    }
  })

  it('measures the final UTF-8 request and drops oldest events for Unicode and JSON escaping', () => {
    for (const text of ['界🌱'.repeat(500), '\\"'.repeat(800), 'a'.repeat(1600)]) {
      const events = Array.from({ length: 120 }, (_, i) => event(i, { safeSummary: text }))
      const output = buildProjectComparison(
        { ...project, introduction: '🌱'.repeat(2000) },
        events,
        'model-a',
        'en'
      )
      const data = JSON.parse(output.preview)
      expect(output.payloadBytes).toBeLessThanOrEqual(48 * 1024)
      expect(output.payloadBytes).toBe(bytes(output.request))
      expect(output.eventCount).toBeGreaterThan(0)
      expect(output.eventCount).toBeLessThan(120)
      expect(data.events[0].action).toBe(`move-${120 - output.eventCount}`)
      expect(data.events.at(-1).action).toBe('move-119')
      expect(data.history.omittedForBudget).toBe(120 - output.eventCount)
      expect(data.history.omittedEventCount).toBe(120 - output.eventCount)
    }
  })

  it('reports all omissions and explicitly represents partial or empty history', () => {
    const events = [event(), event(), event(1, { at: new Date(NOW - 31 * DAY).toISOString() })]
    const output = buildProjectComparison(project, events, 'model-a', 'en')
    expect(JSON.parse(output.preview).history).toMatchObject({
      suppliedEventCount: 3,
      includedEventCount: 1,
      omittedBeforeBudget: 2,
      omittedForBudget: 0,
      omittedEventCount: 2,
      historyMayBeIncomplete: true
    })
    const empty = buildProjectComparison(project, [], 'model-a', 'en')
    expect(empty.eventCount).toBe(0)
    expect(JSON.parse(empty.preview).events).toEqual([])
  })

  it('rejects invalid projects, introductions, histories, and missing or mismatched model references', () => {
    for (const id of ['', 'x'.repeat(161), '\ud800']) {
      expect(() => buildProjectComparison({ ...project, id }, [], 'model-a', 'en')).toThrow(
        'Invalid project'
      )
    }
    expect(() =>
      buildProjectComparison(null as unknown as ProjectComparisonProject, [], 'model-a', 'en')
    ).toThrow('Invalid project')
    for (const introduction of [undefined, '', '   ', 'x'.repeat(4001)]) {
      expect(() =>
        buildProjectComparison({ ...project, introduction }, [], 'model-a', 'en')
      ).toThrow('Invalid introduction')
    }
    for (const model of ['', ' ', 'other', 'x'.repeat(513)]) {
      expect(() => buildProjectComparison(project, [], model, 'en')).toThrow(
        'Invalid analysis model'
      )
    }
    expect(() =>
      buildProjectComparison({ ...project, analysisProfileId: undefined }, [], 'model-a', 'en')
    ).toThrow('Invalid analysis model')
    expect(() =>
      buildProjectComparison(project, {} as ProjectTraceEventSummary[], 'model-a', 'en')
    ).toThrow('Invalid project history')
    expect(
      buildProjectComparison(
        { ...project, analysisProfileId: 'x'.repeat(512) },
        [],
        'x'.repeat(512),
        'en'
      ).request.profileId
    ).toHaveLength(512)
  })
})

describe('local comparison history (synthetic storage only)', () => {
  it('reports unavailable storage separately from an empty history', () => {
    storage.set('projectTrace.comparisons.a', '{invalid json')
    expect(readProjectComparisonsState('a')).toEqual({ results: [], unavailable: true })
    storage.delete('projectTrace.comparisons.a')
    expect(readProjectComparisonsState('a')).toEqual({ results: [], unavailable: false })
  })

  it('isolates project keys with encoding, rejects truncation collisions, and clears only one project', () => {
    saveProjectComparison('a/b', report(1))
    saveProjectComparison('a%2Fb', report(2))
    expect([...storage.keys()]).toEqual([
      'projectTrace.comparisons.a%2Fb',
      'projectTrace.comparisons.a%252Fb'
    ])
    expect(readProjectComparisons('a/b')[0].id).toBe('report-1')
    expect(readProjectComparisons('a%2Fb')[0].id).toBe('report-2')
    expect(() => saveProjectComparison('a'.repeat(161), report())).toThrow('Invalid project')
    saveProjectComparison('a'.repeat(160), report())
    clearProjectComparisons('a/b')
    expect(readProjectComparisons('a/b')).toEqual([])
    expect(readProjectComparisons('a%2Fb')).toHaveLength(1)
  })

  it('fails closed on corrupt stored history instead of overwriting it during a save', () => {
    const key = 'projectTrace.comparisons.a'
    const corrupt = '{not-json-and-must-remain}'
    storage.set(key, corrupt)
    expect(() => saveProjectComparison('a', report(1))).toThrow('Unable to save project comparison')
    expect(storage.get(key)).toBe(corrupt)
  })

  it('fails closed on an oversized stored history instead of replacing it', () => {
    const key = 'projectTrace.comparisons.a'
    const oversized = 'x'.repeat(512 * 1024 + 1)
    storage.set(key, oversized)
    expect(() => saveProjectComparison('a', report(1))).toThrow('Unable to save project comparison')
    expect(storage.get(key)).toBe(oversized)
  })

  it('fails closed when storage read is unavailable before writing a result', () => {
    const key = 'projectTrace.comparisons.a'
    const getItem = vi.fn(() => {
      throw new Error('private storage detail')
    })
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem: vi.fn() })
    expect(() => saveProjectComparison('a', report(1))).toThrow('Unable to save project comparison')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('retains ten recent reports, replaces duplicate IDs, and expires at 30 days', () => {
    for (let i = 0; i < 15; i++) saveProjectComparison('a', report(i))
    expect(readProjectComparisons('a').map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `report-${14 - i}`)
    )
    saveProjectComparison('a', report(14, { advice: 'Updated advice' }))
    expect(readProjectComparisons('a')[0].advice).toBe('Updated advice')
    vi.setSystemTime(NOW + 31 * DAY)
    expect(readProjectComparisons('a')).toEqual([])
    expect(JSON.parse(storage.get('projectTrace.comparisons.a')!)).toEqual([])
    saveProjectComparison('a', report(16, { at: new Date(Date.now()).toISOString() }))
    expect(JSON.parse(storage.get('projectTrace.comparisons.a')!)).toHaveLength(1)
  })

  it('redacts all report strings and never persists provider objects or raw errors', () => {
    for (const [input, secret] of secrets) {
      for (const field of ['id', 'profileId', 'advice'] as const) {
        saveProjectComparison('a', {
          ...report(),
          [field]: input,
          rawResponse: { secret: 'RAW_PROVIDER' },
          error: 'RAW_ERROR',
          input: 'RAW_INPUT',
          rawProfile: 'RAW_PROFILE'
        } as ProjectComparisonResult)
        const raw = storage.get('projectTrace.comparisons.a')!
        expect(raw, `${field}: ${input}`).not.toContain(secret)
        expect(raw).not.toContain('RAW_')
        expect(JSON.stringify(readProjectComparisons('a'))).not.toContain(secret)
        clearProjectComparisons('a')
      }
    }
  })

  it('caps complete reports at 16 KiB, including Unicode, escaping and metadata', () => {
    for (const advice of ['🌱界'.repeat(5000), '\\"'.repeat(16000), 'x'.repeat(20000)]) {
      saveProjectComparison('a', report(0, { advice, actualTotalTokens: 321 }))
      const [value] = readProjectComparisons('a')
      expect(value.advice.length).toBeGreaterThan(0)
      expect(bytes(value)).toBeLessThanOrEqual(16 * 1024)
      expect(bytes(JSON.parse(storage.get('projectTrace.comparisons.a')!)[0])).toBeLessThanOrEqual(
        16 * 1024
      )
      expect(value.actualTotalTokens).toBe(321)
    }
  })

  it('validates and redacts untrusted stored reports and handles corrupt or huge storage', () => {
    const key = 'projectTrace.comparisons.a'
    for (const raw of ['{invalid json', '{}', 'null', ' '.repeat(512 * 1024 + 1)]) {
      storage.set(key, raw)
      expect(readProjectComparisons('a')).toEqual([])
    }
    storage.set(
      key,
      JSON.stringify([
        report(1, { advice: 'Bearer secret123', actualTotalTokens: -1 }),
        report(2, { at: new Date(NOW - 31 * DAY).toISOString() }),
        report(3, { eventCount: -1 }),
        report(4, { estimatedInputTokens: 1.5 }),
        report(5, { at: new Date(NOW + 1).toISOString() }),
        { ...report(6), advice: { content: 'RAW_PROVIDER' } }
      ])
    )
    const result = readProjectComparisons('a')
    expect(result).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('secret123')
    expect(result[0]).not.toHaveProperty('actualTotalTokens')
    expect(() =>
      saveProjectComparison('a', { ...report(), advice: {} } as ProjectComparisonResult)
    ).toThrow('Invalid comparison result')
  })

  it('throws fixed quota and clear errors without retaining provider error contents', () => {
    setItem.mockImplementation(() => {
      throw new Error('RAW_PROVIDER api_key=private')
    })
    expect(() => saveProjectComparison('a', report())).toThrow(
      /^Unable to save project comparison$/
    )
    expect(storage.size).toBe(0)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('PRIVATE_STORAGE')
      },
      removeItem: () => {
        throw new Error('PRIVATE_STORAGE')
      }
    })
    expect(readProjectComparisons('a')).toEqual([])
    expect(() => clearProjectComparisons('a')).toThrow(/^Unable to clear project comparisons$/)
  })
})
