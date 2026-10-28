import { describe, expect, it, vi } from 'vitest'
import { getJsonPath, parseJsonPath, setJsonPath } from './jsonPath'
import type { JsonDict } from './utilTypes'

describe('parseJsonPath', () => {
  it('supports field paths and an explicit root', () => {
    expect(parseJsonPath('node.inputs.text')).toEqual(['node', 'inputs', 'text'])
    expect(parseJsonPath('$.node.inputs.text')).toEqual(['node', 'inputs', 'text'])
    expect(parseJsonPath('$')).toEqual([])
  })

  it('keeps incomplete slots tokenizable for designer validation hints', () => {
    expect(parseJsonPath('')).toEqual([''])
    expect(parseJsonPath('$.')).toEqual([''])
    expect(parseJsonPath('$..node')).toEqual(['', 'node'])
    expect(parseJsonPath('node.')).toEqual(['node', ''])
  })
})

describe('getValue', () => {
  it.each(['', '.', '$.', '.node', 'node.', 'node..text', '$..node'])(
    'rejects reading empty fields in %j',
    (jsonPath) => {
      expect(() => getJsonPath(jsonPath, {})).toThrow(/jsonPath/)
    }
  )

  it('does not invoke own getters while rejecting an accessor path', () => {
    const getter = vi.fn(() => {
      throw new Error('getter must not execute')
    })
    const input: JsonDict = Object.defineProperty({}, 'node', {
      get: getter,
      enumerable: true
    })
    expect(getJsonPath('node', input)).toBeUndefined()
    expect(() => getJsonPath('node.text', input)).toThrow(/field not found/)
    expect(getter).not.toHaveBeenCalled()
  })

  it('returns the original value for the root path', () => {
    const input = { node: { inputs: { text: 'hello' } } }
    expect(getJsonPath('$', input)).toBe(input)
    expect(getJsonPath('$', null)).toBeNull()
  })

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'does not read inherited field %s',
    (field) => {
      expect(getJsonPath(field, {})).toBeUndefined()
    }
  )

  it('does not read inherited getters or follow inherited objects', () => {
    const getter = vi.fn(() => ({ text: 'inherited' }))
    const prototype = Object.defineProperty({}, 'node', { get: getter })
    const input: JsonDict = Object.create(prototype)

    expect(getJsonPath('node', input)).toBeUndefined()
    expect(() => getJsonPath('node.text', input)).toThrow(/field not found/)
    expect(getter).not.toHaveBeenCalled()
  })

  it('reads own JSON keys even when they have prototype-related names', () => {
    const input = JSON.parse('{"__proto__":{"text":"own"},"constructor":{"prototype":7}}')
    expect(getJsonPath('$.__proto__.text', input)).toBe('own')
    expect(getJsonPath('constructor.prototype', input)).toBe(7)
  })

  it('supports dictionaries without an Object prototype', () => {
    const input: JsonDict = Object.create(null)
    input.node = { text: 'hello' }
    expect(getJsonPath('node.text', input)).toBe('hello')
    expect(getJsonPath('__proto__', input)).toBeUndefined()
  })

  it('should get value from jsonPath', () => {
    const input = {
      a: 1,
      b: 2
    }
    const value = getJsonPath('a', input)
    expect(value).toBe(1)
    const value2 = getJsonPath('b', input)
    expect(value2).toBe(2)
    const value3 = getJsonPath('c', input)
    expect(value3).toBeUndefined()
  })
  it('should get value from jsonPath with $', () => {
    const input = {
      a: 1,
      b: 2
    }
    const value = getJsonPath('$.a', input)
    expect(value).toBe(1)
    const value2 = getJsonPath('$.b', input)
    expect(value2).toBe(2)
    const value3 = getJsonPath('$.c', input)
    expect(value3).toBeUndefined()
  })
  it('should get value from jsonPath with nested object', () => {
    const input = {
      a: 1,
      b: {
        c: 3
      }
    }
    const value = getJsonPath('$.b.c', input)
    expect(value).toBe(3)
    const value2 = getJsonPath('$.b', input)
    expect(value2).toEqual({ c: 3 })
    const value3 = getJsonPath('$.c', input)
    expect(value3).toBeUndefined()
  })
})

describe('setValue', () => {
  it.each(['', '.', '$.', '.node', 'node.', 'node..text', '$..node'])(
    'rejects writing empty fields in %j without modifying the input',
    (jsonPath) => {
      const input = { '': { node: 1 }, node: { '': { text: 'before' } } }
      expect(() => setJsonPath(jsonPath, input, 'changed')).toThrow(/jsonPath/)
      expect(input).toEqual({ '': { node: 1 }, node: { '': { text: 'before' } } })
    }
  )

  it('does not invoke own getters while rejecting an accessor parent', () => {
    const getter = vi.fn(() => {
      throw new Error('getter must not execute')
    })
    const input: JsonDict = Object.defineProperty({}, 'node', {
      get: getter,
      enumerable: true
    })
    expect(() => setJsonPath('node.text', input, 'changed')).toThrow(/field is not an object/)
    expect(getter).not.toHaveBeenCalled()
  })

  it('does not serialize workflow values in access errors', () => {
    const input = { node: null, api_key: 'private-workflow-secret', seed: 1n }
    expect(() => getJsonPath('node.text', input)).toThrow('field not found: node.text')
    expect(() => setJsonPath('node.text', input, 'changed')).toThrow(
      'field is not an object: node.text'
    )
  })

  it('rejects root replacement instead of creating an undefined key', () => {
    const input = { text: 'original' }
    expect(() => setJsonPath('$', input, 'changed')).toThrow(/jsonPath/)
    expect(input).toEqual({ text: 'original' })
  })

  it.each(['__proto__', 'node'])(
    'does not modify objects reached through inherited field %s',
    (field) => {
      const prototype = { text: 'original', node: { text: 'original' } }
      const input: JsonDict = Object.create(prototype)
      expect(() => setJsonPath(`${field}.text`, input, 'changed')).toThrow(/field is not an object/)
      expect(prototype).toEqual({ text: 'original', node: { text: 'original' } })
      expect(Object.keys(input)).toEqual([])
    }
  )

  it('creates an own __proto__ field without changing the target prototype', () => {
    const input: JsonDict = {}
    const value = { text: 'own' }
    expect(setJsonPath('__proto__', input, value)).toBe(input)
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype)
    expect(Object.hasOwn(input, '__proto__')).toBe(true)
    expect(input['__proto__']).toBe(value)
    expect(JSON.stringify(input)).toBe('{"__proto__":{"text":"own"}}')
  })

  it('can update existing own prototype-related JSON fields', () => {
    const input = JSON.parse('{"__proto__":{"text":"before"},"constructor":{"prototype":1}}')
    setJsonPath('__proto__.text', input, 'after')
    setJsonPath('constructor.prototype', input, 2)
    expect(input).toEqual(
      JSON.parse('{"__proto__":{"text":"after"},"constructor":{"prototype":2}}')
    )
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype)
  })

  it('does not invoke an inherited setter when adding a field', () => {
    const setter = vi.fn()
    const prototype = Object.defineProperty({}, 'text', { set: setter })
    const input: JsonDict = Object.create(prototype)
    setJsonPath('text', input, 'own')
    expect(setter).not.toHaveBeenCalled()
    expect(Object.getOwnPropertyDescriptor(input, 'text')).toEqual({
      value: 'own',
      enumerable: true,
      configurable: true,
      writable: true
    })
  })

  it('supports null-prototype dictionaries and preserves unrelated fields', () => {
    const input: JsonDict = Object.create(null)
    input.node = { text: 'before', keep: 1 }
    setJsonPath('node.text', input, 'after')
    expect(input.node).toEqual({ text: 'after', keep: 1 })
    expect(Object.getPrototypeOf(input)).toBeNull()
  })

  it('should set value to jsonPath', () => {
    const newInput = () => {
      return {
        a: 1,
        b: 2
      }
    }
    const value = setJsonPath('$.a', newInput(), 3)
    expect(value).toEqual({ a: 3, b: 2 })
    const value2 = setJsonPath('$.b', newInput(), 4)
    expect(value2).toEqual({ a: 1, b: 4 })
    const value3 = setJsonPath('$.c', newInput(), 5)
    expect(value3).toEqual({ a: 1, b: 2, c: 5 })
  })
  it('should set value to jsonPath with nested object', () => {
    const newInput = () => {
      return {
        a: 1,
        b: { c: 2 }
      }
    }
    const value = setJsonPath('$.b.c', newInput(), 5)
    expect(value).toEqual({ a: 1, b: { c: 5 } })
    const value2 = setJsonPath('$.b', newInput(), { d: 6 })
    expect(value2).toEqual({ a: 1, b: { d: 6 } })
    const value3 = setJsonPath('$.c', newInput(), 7)
    expect(value3).toEqual({ a: 1, b: { c: 2 }, c: 7 })
    const value4 = setJsonPath('$.b.c', newInput(), { d: 8 })
    expect(value4).toEqual({ a: 1, b: { c: { d: 8 } } })
  })
  it('should modify input directly', () => {
    const input = {
      a: 1,
      b: 2
    }
    const value = setJsonPath('$.a', input, 3)
    expect(value).toEqual({ a: 3, b: 2 })
    expect(input).toEqual({ a: 3, b: 2 })
  })
})
