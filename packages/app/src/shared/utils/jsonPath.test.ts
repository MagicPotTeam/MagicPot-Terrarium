import { describe, expect, it } from 'vitest'
import { getJsonPath, setJsonPath } from './jsonPath'

describe('getValue', () => {
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
