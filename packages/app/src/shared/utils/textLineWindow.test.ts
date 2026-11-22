import { describe, expect, it } from 'vitest'
import { selectTextLines, wantsTextLineWindow } from './textLineWindow'

describe('files.read line window', () => {
  it('returns the asked lines with their own endings and the total line count', () => {
    const text = 'one\ntwo\r\nthree\nfour'
    expect(selectTextLines(text, { offset: 1, limit: 2 })).toEqual({
      content: 'two\r\nthree\n',
      lineOffset: 1,
      lineCount: 2,
      totalLines: 4
    })
    expect(selectTextLines(text, { offset: 3 })).toMatchObject({ content: 'four', lineCount: 1 })
    expect(selectTextLines(text, { limit: 1 })).toMatchObject({ content: 'one\n', lineOffset: 0 })
  })

  it('gives an empty window past the end, and windows that join back to the text', () => {
    const text = 'a\nb\n'
    expect(selectTextLines(text, { offset: 9, limit: 5 })).toEqual({
      content: '',
      lineOffset: 2,
      lineCount: 0,
      totalLines: 2
    })
    expect(selectTextLines('', { offset: 0 })).toMatchObject({ content: '', totalLines: 0 })
    const parts = [0, 1].map((offset) => selectTextLines(text, { offset, limit: 1 }).content)
    expect(parts.join('')).toBe(text)
  })

  it('asks for a window only when offset or limit is present', () => {
    expect(wantsTextLineWindow({})).toBe(false)
    expect(wantsTextLineWindow({ offset: 0 })).toBe(true)
    expect(wantsTextLineWindow({ limit: 3 })).toBe(true)
  })
})
