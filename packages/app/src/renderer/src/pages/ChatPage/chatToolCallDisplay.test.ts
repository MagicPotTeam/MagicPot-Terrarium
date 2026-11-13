import { describe, expect, it, vi } from 'vitest'
import type { ToolHistoryEntry } from '@shared/llm/types'
import * as cardFormatting from './chatToolCallDisplay'
import { formatToolCallValue, formatToolCardField, toolCallSummary, visibleToolCalls } from './chatToolCallDisplay'

const entry: ToolHistoryEntry = {
  runId: 'run',
  toolCallId: 'call',
  toolName: 'web_search',
  args: { query: 'Electron docs' },
  status: 'completed',
  content: 'search result'
}

describe('tool call display formatting', () => {
  it('never runs icon conversion hooks, strips only existing display controls/patterns and preserves ZWJ/raw data', () => {
    const getIcon = Reflect.get(cardFormatting, 'getToolCardIcon'), toJSON = vi.fn(() => '✓'), toString = vi.fn(() => '✓')
    for (const value of [{ toJSON, toString }, Object.assign(Object('✓'), { toJSON, toString }), { src: 'https://external.invalid' }]) expect(getIcon(value)).toBeUndefined()
    expect(toJSON).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled()
    const raw = '\u0001\u202e\u2066👩🏽‍💻\ufe0f\u2069', source = { icon: raw }
    expect(getIcon(source.icon)).toBe('👩🏽‍💻\ufe0f'); expect(source.icon).toBe(raw)
    expect(getIcon(' password=ICON_FORMAT_SECRET ')).toBe(' password=[redacted] ')
    for (const value of ['\u0000\u0001\u202e\u2066\u2069', '\u001b[31m\u001b[0m', ' \n\t ']) expect(getIcon(value)).toBeUndefined()
  })
  it('formats only bounded primitive icon text without resource lookup, coercion or data mutation', () => {
    const getIcon = Reflect.get(cardFormatting, 'getToolCardIcon')
    expect(typeof getIcon).toBe('function')
    for (const icon of ['✓', '👩🏽‍💻', '😀'.repeat(32), 'x'.repeat(64), '  ✓  ', '<img src="https://external.invalid/i">', 'https://external.invalid/i', 'i-carbon-checkmark']) expect(getIcon(icon)).toBe(icon)
    expect(getIcon('\u001b[31mBearer ICON_FORMAT_SECRET\u001b[0m\u202e')).toBe('Bearer [redacted]')
    for (const icon of ['', '  ', '\n\t', undefined, null, false, 1, {}, [], ['✓'], Object('✓'), { toJSON: () => '✓' }, { toString: () => '✓' }, 'x'.repeat(65), '😀'.repeat(33)]) expect(getIcon(icon)).toBeUndefined()
  })
  it('maps only non-link literal action styles to fresh fixed button props without coercion or authority', () => {
    const getStyle = Reflect.get(cardFormatting, 'getToolCardActionStyle')
    expect(typeof getStyle).toBe('function')
    for (const [style, props] of Object.entries({ primary: { variant: 'contained', color: 'primary' }, secondary: { variant: 'outlined', color: 'primary' }, danger: { variant: 'contained', color: 'error' } })) {
      expect(getStyle(style)).toEqual(props)
      const copy = getStyle(style)
      expect(copy).toBeDefined(); if (!copy) throw new Error('Expected valid fixed button style')
      Reflect.set(copy, 'color', 'url(https://external.invalid)'); expect(getStyle(style)).toEqual(props)
    }
    for (const style of [undefined, null, false, 1, [], {}, ['primary'], Object('primary'), { toJSON: () => 'primary' }, { toString: () => 'primary' }, 'link', 'error', 'Primary', 'primary ', 'url(https://external.invalid)', '__proto__', 'constructor', 'toString']) expect(getStyle(style)).toBeUndefined()
  })
  it('maps only six literal card accents to fixed theme tokens, never raw CSS, status, permission or caller-owned style data', () => {
    const getAccent = Reflect.get(cardFormatting, 'getToolCardAccent')
    expect(typeof getAccent).toBe('function')
    const expected = { primary: { borderColor: 'primary.main', headerColor: 'primary.main' }, info: { borderColor: 'info.main', headerColor: 'info.main' }, success: { borderColor: 'success.main', headerColor: 'success.main' }, warning: { borderColor: 'warning.main', headerColor: 'warning.main' }, danger: { borderColor: 'error.main', headerColor: 'error.main' }, neutral: { borderColor: 'divider', headerColor: 'text.primary' } }
    for (const [accent, tokens] of Object.entries(expected)) {
      expect(getAccent(accent)).toEqual(tokens)
      const copy = getAccent(accent)
      expect(copy).toBeDefined()
      if (!copy) throw new Error('Expected fixed accent tokens for a valid literal')
      Reflect.set(copy, 'borderColor', 'url(https://external.invalid)')
      expect(getAccent(accent)).toEqual(tokens)
    }
    for (const invalid of [undefined, null, 1, false, [], {}, ['primary'], Object('primary'), { toJSON: () => 'primary' }, { toString: () => 'primary' }, 'error', 'Primary', 'primary ', 'red', '#ff0000', 'url(https://external.invalid)', '__proto__', 'constructor', 'toString', '<style>body{display:none}</style>']) expect(getAccent(invalid)).toBeUndefined()
  })
  it('formats real arguments and results without changing the source receipt', () => {
    const args = { query: 'Electron docs', nested: { limit: 3 } }
    const before = JSON.stringify(args)
    expect(formatToolCallValue(args).text).toContain('Electron docs')
    expect(formatToolCallValue('{"results":[{"title":"docs"}]}').text).toContain('"results"')
    expect(toolCallSummary(args)).not.toContain('\n')
    expect(JSON.stringify(args)).toBe(before)
  })
  it('redacts nested credentials, URL credentials, bearer tokens and signed URL query secrets', () => {
    const source = {
      query: 'safe query',
      api_key: 'DO_NOT_SHOW_KEY',
      nested: { Authorization: 'Bearer DO_NOT_SHOW_AUTH', password: 'DO_NOT_SHOW_PASSWORD' },
      url: 'https://user:DO_NOT_SHOW_PASS@example.com/path?token=DO_NOT_SHOW_TOKEN&safe=yes',
      command: 'curl -H "Authorization: Bearer DO_NOT_SHOW_HEADER" https://example.com'
    }
    const result = formatToolCallValue(source)
    expect(result.text).toContain('safe query')
    expect(result.text).toContain('safe=yes')
    expect(result.text).not.toContain('DO_NOT_SHOW')
    expect(result.text).toContain('[redacted]')
    expect(source.api_key).toBe('DO_NOT_SHOW_KEY')
  })
  it('redacts complete values of sensitive-labelled exact key/value rows, including expanded serialized card fields', () => {
    const fields = [{ label: 'password', value: 'PRIVATE_FIELD_ONE with spaces\nand a second line', inline: true }, { label: 'Cookie', value: 'session=PRIVATE_FIELD_TWO; sid=PRIVATE_FIELD_THREE' }, { label: 'Status', value: 'Public status' }]
    const serialized = JSON.stringify({ card: { title: 'Fields', fields } })
    for (const input of [fields, serialized]) {
      const result = formatToolCallValue(input).text
      expect(result).not.toContain('PRIVATE_FIELD_')
      expect(result).not.toContain('with spaces')
      expect(result).toContain('[redacted]')
      expect(result).toContain('Public status')
    }
    expect(serialized).toContain('PRIVATE_FIELD_ONE')
    expect(fields[0].value).toContain('PRIVATE_FIELD_ONE')
  })
  it('formats sensitive field labels as whole-value redaction while leaving ordinary data inert and unmodified', () => {
    for (const label of ['password', ' Password ', 'COOKIE', 'credentials', 'api_key', 'to\u0000ken']) {
      const value = 'PRIVATE_ROW_VALUE with spaces\nand a second line; key=still private'
      const result = formatToolCardField(label, value)
      expect(result).toContain('[redacted]')
      expect(result).not.toContain('PRIVATE_ROW_')
      expect(result).not.toContain('second line')
      expect(value).toContain('PRIVATE_ROW_VALUE')
    }
    expect(formatToolCardField('Status', '<img src="https://external.invalid">')).toBe('Status: <img src="https://external.invalid">')
    expect(formatToolCallValue([{ label: 'to\u0000ken', value: 'PRIVATE_NORMALIZED_VALUE' }]).text).not.toContain('PRIVATE_NORMALIZED_VALUE')
    expect(formatToolCardField('Status', 'Authorization: Basic PRIVATE_HEADER\npublic')).not.toContain('PRIVATE_HEADER')
  })
  it('conceals full Basic authorization and multi-cookie header values', () => {
    const value =
      'Authorization: Basic PRIVATE_AUTH\nCookie: session=PRIVATE_ONE; sid=PRIVATE_TWO\nSet-Cookie: token=PRIVATE_THREE; HttpOnly\npublic line'
    const formatted = formatToolCallValue(value).text
    expect(formatted).not.toContain('PRIVATE_')
    expect(formatted).toContain('public line')
  })
  it('does not throw when sanitized or truncated object keys collide', () => {
    expect(() => formatToolCallValue({ a: 1, ['a\u0000']: 2 })).not.toThrow()
    expect(() =>
      formatToolCallValue({ ['x'.repeat(129)]: 1, ['x'.repeat(128) + 'y']: 2 })
    ).not.toThrow()
  })
  it('bounds output, nested objects, summary and control sequences', () => {
    expect(formatToolCallValue('x'.repeat(100_000)).text.length).toBeLessThanOrEqual(16_384)
    expect(formatToolCallValue('x'.repeat(100_000)).truncated).toBe(true)
    expect(toolCallSummary({ command: 'x'.repeat(10000) }).length).toBeLessThanOrEqual(240)
    expect(formatToolCallValue('\u001b[31mhello\u0000\u202e').text).toBe('hello')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(formatToolCallValue(cycle).text).toContain('[circular]')
    const deep = { nested: {} }
    let next = deep.nested
    for (let i = 0; i < 100; i++) {
      const child = {}
      Object.assign(next, { nested: child })
      next = child
    }
    expect(formatToolCallValue(deep).truncated).toBe(true)
  })
  it('deduplicates by run and call identity without downgrading terminal state', () => {
    expect(visibleToolCalls([entry, { ...entry, status: 'running' }])).toEqual([entry])
    expect(visibleToolCalls([{ ...entry, status: 'running' }, entry])).toEqual([entry])
    expect(visibleToolCalls([entry, { ...entry, runId: 'another' }])).toHaveLength(2)
    expect(visibleToolCalls(undefined)).toEqual([])
    expect(
      visibleToolCalls([null, { ...entry, args: null }] as unknown as ToolHistoryEntry[])
    ).toEqual([])
  })
})
