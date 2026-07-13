import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAutoSaveFileName } from './autoSaveTracker'

describe('createAutoSaveFileName', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps names unique for multiple saves in the same millisecond', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-13T10:11:12.345Z'))

    const first = createAutoSaveFileName('.txt')
    const second = createAutoSaveFileName('txt')

    expect(first).not.toBe(second)
    expect(first).toMatch(/^qapp_auto_2026-03-13T10-11-12-345Z_\d+\.txt$/)
    expect(second).toMatch(/^qapp_auto_2026-03-13T10-11-12-345Z_\d+\.txt$/)
  })
})
