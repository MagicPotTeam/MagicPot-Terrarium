import { describe, it, expect } from 'vitest'
import { deepMerge } from './utilTypes'

describe('deepMerge', () => {
  it('should merge two objects', () => {
    const a = {
      a: 1,
      b: 2,
      c: 3
    }
    const b = {
      b: 20
    }
    const c = deepMerge(a, b)
    expect(c).toEqual({
      a: 1,
      b: 20,
      c: 3
    })
  })

  it('should handle nested objects', () => {
    const a = {
      user: {
        name: 'Alice',
        age: 25,
        settings: {
          theme: 'dark',
          notifications: true
        }
      }
    }
    const b = {
      user: {
        age: 30,
        settings: {
          theme: 'light'
        }
      }
    }
    const c = deepMerge(a, b)
    expect(c).toEqual({
      user: {
        name: 'Alice',
        age: 30,
        settings: {
          theme: 'light',
          notifications: true
        }
      }
    })
  })

  it('should handle null and undefined values', () => {
    const a = { a: 1, b: null, c: 3 }
    const b = { b: 2, d: 4 }
    const c = deepMerge<Partial<{ a: number; b: number | null; c: number; d: number }>>(a, b)
    expect(c).toEqual({
      a: 1,
      b: 2,
      c: 3,
      d: 4
    })
  })

  it('should handle primitive values', () => {
    expect(deepMerge(1, 2)).toBe(2)
    expect(deepMerge('hello', 'world')).toBe('world')
    expect(deepMerge(true, false)).toBe(false)
  })
})
