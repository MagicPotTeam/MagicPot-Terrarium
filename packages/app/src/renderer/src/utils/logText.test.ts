import { describe, expect, it } from 'vitest'
import {
  LOG_REDACTION,
  LOG_TRUNCATION,
  MAX_LOG_CHARACTERS,
  MAX_LOG_ENTRY_CHARACTERS,
  MAX_LOG_ENTRY_LINES,
  MAX_LOG_LINE_CHARACTERS,
  MAX_LOG_LINES,
  normalizeLogBatch,
  normalizeLogText,
  retainLogLines
} from './logText'

const characters = (lines: string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0)

describe('log display normalization', () => {
  it('preserves ordinary diagnostics, indentation, paths, URLs and error lines', () => {
    const text =
      'ERROR> failed C:\\models\\test.safetensors\r\n  File "test.py", line 42\rhttp://localhost:8188\n'
    expect(normalizeLogText(text)).toEqual([
      'ERROR> failed C:\\models\\test.safetensors',
      '  File "test.py", line 42',
      'http://localhost:8188',
      ''
    ])
  })

  it('redacts short data images and long bare, unpadded and URL-safe fragments with surrounding text intact', () => {
    const text = `before "data:image/png;base64,AAAA==" after; ${'Ab9+/'.repeat(100)}; ${'xy-_'.repeat(100)}! failure`
    expect(normalizeLogText(text)).toEqual([
      `before "${LOG_REDACTION}" after; ${LOG_REDACTION}; ${LOG_REDACTION}! failure`
    ])
  })

  it('redacts wrapped data images, including their short final row, without hiding errors', () => {
    const payload = Array<string>(40)
      .fill('Ab9+/'.repeat(15) + 'A')
      .join('\r\n')
    const text = `before "data:image/png;base64,${payload}\r\nTWFu" after\r\nERROR: failed\r\nTraceback`
    const rows = normalizeLogText(text)
    expect(rows.join('\n')).toContain(LOG_REDACTION)
    expect(rows.join('\n')).not.toContain('Ab9+/')
    expect(rows.join('\n')).not.toContain('TWFu')
    expect(rows.join('\n')).toContain('" after')
    expect(rows.slice(-2)).toEqual(['ERROR: failed', 'Traceback'])
  })

  it('redacts headerless wrapped payloads at sample boundaries and in separate stream chunks', () => {
    const payload = Array<string>(20_000)
      .fill('Ab9+/'.repeat(15) + 'A')
      .join('\n')
    const rows = normalizeLogText(`data:image/png;base64,${payload}\nERROR: final exception`)
    expect(rows.join('\n')).not.toContain('Ab9+/')
    expect(rows.at(-1)).toBe('ERROR: final exception')
    expect(normalizeLogText('Ab9+/'.repeat(15) + 'A')).toEqual([LOG_REDACTION])
  })

  it('removes control bytes before redaction so one normalization cannot recreate base64 tokens', () => {
    const payload = `${'A'.repeat(128)}${String.fromCharCode(0)}${'B'.repeat(128)}`
    expect(normalizeLogText(`ERROR ${payload}; failed`)).toEqual([`ERROR ${LOG_REDACTION}; failed`])
  })

  it('samples megabytes without scanning the whole payload and retains the final error', () => {
    const text = `prefix data:image/webp;base64,${'A'.repeat(4_000_000)}; ERROR: decode failed`
    const started = performance.now()
    const rows = normalizeLogText(text)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(rows.join('\n')).toContain('prefix')
    expect(rows.join('\n')).toContain('ERROR: decode failed')
    expect(rows.join('\n')).toContain(LOG_TRUNCATION)
    expect(rows.join('\n')).not.toContain('A'.repeat(256))
    expect(characters(rows)).toBeLessThanOrEqual(MAX_LOG_ENTRY_CHARACTERS)
  })

  it('caps long non-base64 lines and multiline entries, including their total characters', () => {
    for (const text of [
      `start ${'word: '.repeat(100_000)} end`,
      `Traceback\n${('field: '.repeat(400) + '\n').repeat(1000)}ERROR: final exception`,
      '\n'.repeat(1_000_000)
    ]) {
      const rows = normalizeLogText(text)
      expect(rows.length).toBeLessThanOrEqual(MAX_LOG_ENTRY_LINES)
      expect(characters(rows)).toBeLessThanOrEqual(MAX_LOG_ENTRY_CHARACTERS)
      expect(rows.every((row) => row.length <= MAX_LOG_LINE_CHARACTERS)).toBe(true)
      expect(rows.join('\n')).toContain(LOG_TRUNCATION)
    }
    const rows = normalizeLogText(`Traceback\n${'  detail\n'.repeat(500)}ERROR: final exception`)
    expect(rows[0]).toBe('Traceback')
    expect(rows.at(-1)).toBe('ERROR: final exception')
  })

  it('bounds batch work by the retained window, including empty entries', () => {
    let reads = 0
    const messages = new Proxy(new Array<string>(1_000_000), {
      get(target, key) {
        if (key === 'length') return target.length
        reads += 1
        return ''
      }
    })
    expect(normalizeLogBatch(messages)).toHaveLength(MAX_LOG_LINES)
    expect(reads).toBe(MAX_LOG_LINES)
    expect(normalizeLogBatch(['unsafe'], 0)).toEqual([])
    expect(normalizeLogBatch(['unsafe'], -1)).toEqual([])
  })

  it('enforces both character and row retention limits with chronological tail order', () => {
    const batch = normalizeLogBatch(
      Array.from({ length: 20_000 }, (_, index) => `${index}: ${'text: '.repeat(300)}`)
    )
    const retained = retainLogLines(['old: '.repeat(400)], batch)
    expect(retained.lines.length).toBeLessThan(MAX_LOG_LINES)
    expect(characters(retained.lines)).toBeLessThanOrEqual(MAX_LOG_CHARACTERS)
    expect(retained.lines.at(-1)).toMatch(/^19999:/)
    expect(retained.removed).toBeGreaterThan(0)
  })
})
