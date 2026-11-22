import { describe, expect, it, vi } from 'vitest'
import { createHelperInvocationActivity, type HelperEvent } from './helperInvocationActivity'

const base: HelperEvent = { scope: 'scope', sessionId: 'session', parentRunId: 1, runId: 'event', toolCallId: 'one', name: 'explore', status: 'running' }
const make = (now: () => number, maxTotal = 10, maxPerSession = 5) => createHelperInvocationActivity({ now, ttlMs: 100, maxTotal, maxPerSession })

describe('helper invocation observations', () => {
  it('tracks distinct calls and freezes terminal states without retaining extra payload', () => {
    const store = make(() => 1)
    store.begin('scope', 'session', 1)
    expect(store.observe({ ...base, args: 'secret', output: 'secret' } as HelperEvent)).toBe(true)
    expect(store.observe({ ...base, toolCallId: 'two', name: 'critic' })).toBe(true)
    expect(store.observe({ ...base, status: 'returned' })).toBe(true)
    expect(store.observe({ ...base, status: 'running' })).toBe(false)
    expect(store.observe({ ...base, status: 'failed' })).toBe(false)
    expect(store.list('scope', 'session')).toHaveLength(2)
    expect(JSON.stringify(store.list('scope', 'session'))).not.toContain('secret')
    expect(store.list('scope', 'session').find(item => item.toolCallId === 'one')?.status).toBe('returned')
  })
  it('ends parent without altering terminal rows, and rejects late events and older runs', () => {
    const store = make(() => 1)
    store.begin('scope', 'session', 1)
    store.observe(base)
    store.observe({ ...base, toolCallId: 'two', status: 'failed' })
    store.end('scope', 'session', 1)
    store.end('scope', 'session', 1)
    expect(store.list('scope', 'session').map(item => item.status)).toEqual(['unknown', 'failed'])
    expect(store.observe({ ...base, toolCallId: 'late' })).toBe(false)
    expect(store.begin('scope', 'session', 1)).toBe(false)
    expect(store.begin('scope', 'session', 2)).toBe(true)
    expect(store.observe(base)).toBe(false)
  })
  it('expires bounded observations and closes stale admission', () => {
    let time = 0
    const store = make(() => time)
    store.begin('scope', 'session', 1); store.observe(base)
    time = 101
    expect(store.list('scope', 'session')[0].status).toBe('unknown')
    expect(store.observe(base)).toBe(false)
    expect(store.begin('scope', 'session', 1)).toBe(false)
    time = 202
    expect(store.list('scope', 'session')).toEqual([])
  })
  it('expires a terminal row without ending a parent or reviving the expired call', () => {
    let time = 0
    const store = make(() => time)
    store.begin('scope', 'session', 1)
    store.observe({ ...base, status: 'returned' })
    time = 80
    store.observe({ ...base, toolCallId: 'two' })
    time = 101
    expect(store.list('scope', 'session').map(item => item.toolCallId)).toEqual(['two'])
    expect(store.observe(base)).toBe(false)
    expect(store.observe({ ...base, toolCallId: 'two', status: 'returned' })).toBe(true)
    time = 202
    expect(store.observe({ ...base, toolCallId: 'late' })).toBe(false)
  })
  it('expires one stale running row conservatively without ending newer calls', () => {
    let time = 0
    const store = make(() => time)
    store.begin('scope', 'session', 1); store.observe(base)
    time = 80; store.observe({ ...base, toolCallId: 'two' })
    time = 101
    expect(store.list('scope', 'session').map(item => item.status)).toEqual(['unknown', 'running'])
    expect(store.observe({ ...base, status: 'returned' })).toBe(false)
    expect(store.observe({ ...base, toolCallId: 'two', status: 'returned' })).toBe(true)
  })
  it('enforces capacity fail closed and isolates scope/session', () => {
    const store = make(() => 1, 2, 1)
    store.begin('scope', 'session', 1); store.begin('other', 'session', 1)
    expect(store.observe(base)).toBe(true)
    expect(store.observe({ ...base, toolCallId: 'two' })).toBe(false)
    expect(store.observe({ ...base, scope: 'other' })).toBe(true)
    expect(store.begin('scope', 'different', 1)).toBe(false)
    expect(store.list('scope', 'session')).toHaveLength(1)
    expect(store.list('other', 'session')).toHaveLength(1)
    expect(store.list('scope', 'different')).toEqual([])
  })
  it('bounds scope and session at 256 and event IDs at 128', () => {
    const store = make(() => 1)
    const scope = 's'.repeat(256), sessionId = 'i'.repeat(256), id = 'r'.repeat(128)
    expect(store.begin(scope, sessionId, 1)).toBe(true)
    expect(store.observe({ ...base, scope, sessionId, runId: id, toolCallId: id })).toBe(true)
    expect(store.list(scope, sessionId)).toHaveLength(1)
    expect(store.begin('s'.repeat(257), sessionId, 1)).toBe(false)
    expect(store.begin(scope, 'i'.repeat(257), 2)).toBe(false)
    expect(store.observe({ ...base, scope, sessionId, runId: 'r'.repeat(129) })).toBe(false)
    expect(store.observe({ ...base, scope, sessionId, toolCallId: 't'.repeat(129) })).toBe(false)
  })
  it('treats a 15-minute local TTL as observation expiry, not a run timeout', () => {
    let time = 0
    const store = createHelperInvocationActivity({ now: () => time, ttlMs: 15 * 60 * 1000, maxTotal: 3, maxPerSession: 3 })
    store.begin('scope', 'session', 1); store.observe(base)
    time = 15 * 60 * 1000
    expect(store.list('scope', 'session')[0].status).toBe('unknown')
    expect(store.observe({ ...base, status: 'returned' })).toBe(false)
  })
  it('rejects invalid inputs and has no calls beyond the supplied clock', () => {
    const clock = vi.fn(() => 1), store = make(clock)
    expect(store.observe(base)).toBe(false)
    store.begin('scope', 'session', 1)
    for (const bad of [{ name: 'search_memory' }, { runId: '' }, { toolCallId: 'a'.repeat(129) }, { status: 'success' }, { parentRunId: NaN }]) expect(store.observe({ ...base, ...bad } as HelperEvent)).toBe(false)
    expect(store.list('scope', 'session')).toEqual([])
    expect(clock).toHaveBeenCalled()
    expect(Object.keys(store).sort()).toEqual(['begin', 'end', 'list', 'observe'])
  })
})
