import { describe, it, expect } from 'vitest'
import { deepMerge, type JsonDict } from './utilTypes'

describe('deepMerge', () => {
  it.each(['left', 'right'])('preserves an own __proto__ key from the %s object', (side) => {
    const special: JsonDict = JSON.parse('{"__proto__":{"nested":"own"}}')
    const ordinary = { keep: true }
    const result = side === 'left' ? deepMerge(special, ordinary) : deepMerge(ordinary, special)

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(result['__proto__']).toEqual({ nested: 'own' })
    expect(JSON.parse(JSON.stringify(result))).toEqual(
      JSON.parse('{"keep":true,"__proto__":{"nested":"own"}}')
    )
    expect(Object.getPrototypeOf(special)).toBe(Object.prototype)
    expect(ordinary).toEqual({ keep: true })
  })

  it('merges own prototype-related keys recursively without changing prototypes', () => {
    const left = JSON.parse(
      '{"nested":{"__proto__":{"keep":1,"change":2}},"constructor":{"prototype":{"keep":3}}}'
    )
    const right = JSON.parse(
      '{"nested":{"__proto__":{"change":4}},"constructor":{"prototype":{"add":5}}}'
    )
    const result = deepMerge(left, right)

    expect(result).toEqual(
      JSON.parse(
        '{"nested":{"__proto__":{"keep":1,"change":4}},"constructor":{"prototype":{"keep":3,"add":5}}}'
      )
    )
    expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(result.nested['__proto__'])).toBe(Object.prototype)
    expect(left.nested['__proto__']).toEqual({ keep: 1, change: 2 })
    expect(right.nested['__proto__']).toEqual({ change: 4 })
  })

  it('does not merge inherited objects into an own field', () => {
    const prototype = { node: { inherited: true } }
    const left: JsonDict = Object.assign(Object.create(prototype), { keep: 1 })
    const result = deepMerge(left, { node: { own: true } })

    expect(result).toEqual({ keep: 1, node: { own: true } })
    expect(prototype).toEqual({ node: { inherited: true } })
  })

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'does not replace a new null %s field with an inherited value',
    (key) => {
      const result = deepMerge<JsonDict>({}, { [key]: null })
      expect(Object.hasOwn(result, key)).toBe(true)
      expect(result[key]).toBeNull()
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    }
  )

  it('supports null-prototype dictionaries and a shadowed hasOwnProperty field', () => {
    const left: JsonDict = Object.assign(Object.create(null), {
      node: { keep: true },
      hasOwnProperty: 'data'
    })
    const result = deepMerge(left, { node: { added: true } })
    expect(result).toEqual({ node: { keep: true, added: true }, hasOwnProperty: 'data' })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  })

  it('keeps the existing null, undefined and array replacement semantics', () => {
    const original = { keep: 1 }
    expect(deepMerge(original, null)).toBe(original)
    expect(deepMerge(original, undefined)).toBe(original)
    expect(deepMerge(null, original)).toBe(original)
    expect(deepMerge({ values: [1, 2] }, { values: [3] })).toEqual({ values: [3] })
  })

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
