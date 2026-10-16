import { describe, expect, it } from 'vitest'
import { ALL_PROJECT_HISTORY, selectProjectHistoryRange } from './projectHistoryRange'

const events = Object.freeze([
  Object.freeze({ id: 'a', action: 'first' }),
  Object.freeze({ id: 'b', action: 'middle' }),
  Object.freeze({ id: 'c', action: 'last' })
])

describe('selectProjectHistoryRange', () => {
  it('defaults to all available events without changing the original array', () => {
    const result = selectProjectHistoryRange(events)
    expect(result.valid).toBe(true)
    expect(result.events).toEqual(events)
    expect(result.events).not.toBe(events)
    expect(ALL_PROJECT_HISTORY).toEqual({ startId: null, endId: null })
  })

  it.each([
    [{ startId: 'b', endId: 'c' }, ['b', 'c']],
    [{ startId: 'b', endId: null }, ['b', 'c']],
    [{ startId: null, endId: 'b' }, ['a', 'b']],
    [{ startId: 'b', endId: 'b' }, ['b']]
  ] as const)('uses inclusive stable-ID endpoints %o', (range, ids) => {
    const result = selectProjectHistoryRange(events, range)
    expect(result.valid).toBe(true)
    expect(result.events.map((event) => event.id)).toEqual(ids)
  })

  it.each([
    { startId: 'c', endId: 'a' },
    { startId: 'removed', endId: null },
    { startId: null, endId: 'removed' },
    { startId: '', endId: null }
  ])('does not widen missing or reversed endpoints %o', (range) => {
    expect(selectProjectHistoryRange(events, range)).toEqual({ valid: false, events: [] })
  })

  it('survives older-event pruning without shifting the selected interval', () => {
    expect(selectProjectHistoryRange(events.slice(1), { startId: 'b', endId: 'c' }).events).toEqual(
      events.slice(1)
    )
    expect(selectProjectHistoryRange(events.slice(2), { startId: 'b', endId: 'c' }).valid).toBe(
      false
    )
  })

  it('rejects ambiguous duplicate endpoints', () => {
    expect(
      selectProjectHistoryRange([...events, { id: 'b', action: 'duplicate' }], {
        startId: 'b',
        endId: null
      })
    ).toEqual({ valid: false, events: [] })
  })

  it('allows an empty default range but not a dangling explicit endpoint', () => {
    expect(selectProjectHistoryRange([])).toEqual({ valid: true, events: [] })
    expect(selectProjectHistoryRange([], { startId: 'a', endId: null })).toEqual({
      valid: false,
      events: []
    })
  })
})
