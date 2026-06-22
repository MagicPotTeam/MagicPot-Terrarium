import { describe, expect, it } from 'vitest'
import { formatCompactTokenCount } from './chatFormatUtils'

describe('chatFormatUtils', () => {
  it('formats compact token counts consistently with ChatPage display', () => {
    expect(formatCompactTokenCount()).toBe('0')
    expect(formatCompactTokenCount(Number.NaN)).toBe('0')
    expect(formatCompactTokenCount(999.6)).toBe('1000')
    expect(formatCompactTokenCount(1_499)).toBe('1K')
    expect(formatCompactTokenCount(12_500)).toBe('13K')
    expect(formatCompactTokenCount(1_500_000)).toBe('1.5M')
    expect(formatCompactTokenCount(12_500_000)).toBe('13M')
  })
})
