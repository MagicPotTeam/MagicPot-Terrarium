import { describe, it, expect } from 'vitest'
import { readableSize, parsePortFromOrigin, splitSpace } from './utilFuncs'

describe('splitSpace', () => {
  it('should return the correct array', () => {
    expect(splitSpace('')).toEqual([])
    expect(splitSpace(' ')).toEqual([])
    expect(splitSpace('a b c')).toEqual(['a', 'b', 'c'])
  })
})

describe('readableSize', () => {
  it('should return the correct size', () => {
    expect(readableSize(1024)).toBe('1.00 KiB')
    expect(readableSize(1024 * 1024)).toBe('1.00 MiB')
    expect(readableSize(1024 * 1024 * 1024)).toBe('1.00 GiB')
    expect(readableSize(1024 * 1024 * 1024 * 1024)).toBe('1.00 TiB')
    expect(readableSize(1024 * 1024 * 1024 * 1024 * 1024)).toBe('1.00 PiB')

    expect(readableSize(3 * 1024 * 1024 * 1024)).toBe('3.00 GiB')
    expect(readableSize(30 * 1024 * 1024 * 1024)).toBe('30.00 GiB')
    expect(readableSize(300 * 1024 * 1024 * 1024)).toBe('300.00 GiB')
    expect(readableSize(31 * 1024 * 1024 * 1024)).toBe('31.00 GiB')
    expect(readableSize(31.5 * 1024 * 1024 * 1024)).toBe('31.50 GiB')
    expect(readableSize(31.54 * 1024 * 1024 * 1024)).toBe('31.54 GiB')
    expect(readableSize(31.545 * 1024 * 1024 * 1024)).toBe('31.55 GiB')
  })
})

describe('parsePortFromOrigin', () => {
  it('should parse port from origin', () => {
    expect(parsePortFromOrigin('http://localhost:7860')).toBe('7860')
    expect(parsePortFromOrigin('https://localhost:7860')).toBe('7860')
    expect(parsePortFromOrigin('localhost:7860')).toBe('7860')
  })
  it('should parse port from origin with protocol', () => {
    expect(parsePortFromOrigin('localhost')).toBe('80')
    expect(parsePortFromOrigin('http://localhost')).toBe('80')
    expect(parsePortFromOrigin('https://localhost')).toBe('443')
    expect(parsePortFromOrigin('')).toBe('')
  })
})
