import { describe, expect, it } from 'vitest'

import {
  hasQueueCapacity,
  isPublicTargetAddress,
  parseConnectTarget,
  removeExactQueueEntry
} from './httpProxyServer'

describe('HTTP proxy queue policy', () => {
  it('removes only the exact queued entry', () => {
    const first = { ip: '127.0.0.1' }
    const second = { ip: '127.0.0.1' }
    const queue = [first, second]

    expect(removeExactQueueEntry(queue, second)).toBe(true)
    expect(queue).toEqual([first])
    expect(removeExactQueueEntry(queue, second)).toBe(false)
  })

  it('enforces global and per-IP queue caps', () => {
    expect(hasQueueCapacity(Array(49).fill('127.0.0.1'), '127.0.0.1')).toBe(true)
    expect(hasQueueCapacity(Array(50).fill('127.0.0.1'), '127.0.0.1')).toBe(false)
    expect(
      hasQueueCapacity(
        Array.from({ length: 200 }, (_, index) => String(index)),
        'new'
      )
    ).toBe(false)
  })
})

describe('HTTP proxy CONNECT policy', () => {
  it('strictly parses DNS and bracketed IPv6 authorities', () => {
    expect(parseConnectTarget('example.com:443')).toEqual({ hostname: 'example.com', port: 443 })
    expect(parseConnectTarget('[2606:4700:4700::1111]:443')).toEqual({
      hostname: '2606:4700:4700::1111',
      port: 443
    })
  })

  it.each([
    undefined,
    '',
    'example.com',
    'example.com:443junk',
    'user@example.com:443',
    'example.com:22',
    'localhost:443',
    '-bad.example:443',
    '[::1]443'
  ])('rejects malformed or unsafe authority %s', (authority) => {
    expect(() => parseConnectTarget(authority)).toThrow()
  })

  it('allows only public target addresses', () => {
    expect(isPublicTargetAddress('8.8.8.8')).toBe(true)
    expect(isPublicTargetAddress('2606:4700:4700::1111')).toBe(true)
    expect(isPublicTargetAddress('127.0.0.1')).toBe(false)
    expect(isPublicTargetAddress('10.0.0.1')).toBe(false)
    expect(isPublicTargetAddress('169.254.169.254')).toBe(false)
    expect(isPublicTargetAddress('::1')).toBe(false)
    expect(isPublicTargetAddress('fc00::1')).toBe(false)
    expect(isPublicTargetAddress('not-an-ip')).toBe(false)
  })
})
