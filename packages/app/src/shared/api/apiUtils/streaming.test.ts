import { describe, expect, it } from 'vitest'
import { isServerStreamingError } from './streaming'

describe('isServerStreamingError', () => {
  it('accepts structured streaming errors with a string message', () => {
    expect(isServerStreamingError({ message: 'failed' })).toBe(true)
    expect(isServerStreamingError({ message: 'failed', payload: { code: 'E_TEST' } })).toBe(true)
  })

  it('rejects non-object values and objects without a string message', () => {
    expect(isServerStreamingError(null)).toBe(false)
    expect(isServerStreamingError('failed')).toBe(false)
    expect(isServerStreamingError({ message: 42 })).toBe(false)
  })
})
