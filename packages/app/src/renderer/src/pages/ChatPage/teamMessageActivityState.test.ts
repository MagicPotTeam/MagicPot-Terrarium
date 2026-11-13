import { describe, expect, it } from 'vitest'
import type { TeamDispatchEntry } from './teamMessageDispatcher'
import { reduceTeamActivity, selectTeamActivity, type TeamActivityState } from './teamMessageActivityState'

const initial: TeamActivityState = { owner: 0, key: '', entries: [], activeKey: '', live: false, closedFor: null }
const source = { scope: 'synthetic', thread: 'one', lead: 'lead', kind: 'user' as const }
const entry = (id: string, status: TeamDispatchEntry['status']): TeamDispatchEntry => Object.freeze({
  intent: Object.freeze({ id, source: Object.freeze(source), kind: 'channel', hop: 1, text: 'fixture' }),
  recipient: 'bob', status
})
const begin = (state: TeamActivityState, owner: number, key: string) => reduceTeamActivity(state, { type: 'begin', owner, key })
const observe = (state: TeamActivityState, owner: number, key: string, entries: readonly TeamDispatchEntry[]) => reduceTeamActivity(state, { type: 'observe', owner, key, entries })
const end = (state: TeamActivityState, owner: number, key: string) => reduceTeamActivity(state, { type: 'end', owner, key })

describe('team message activity reducer', () => {
  it('preserves received and unavailable outcomes and makes unfinished observations unknown without mutating input', () => {
    const entries = Object.freeze([entry('q', 'queued'), entry('started', 'request_started'), entry('received', 'response_received'), entry('missing', 'unavailable'), entry('unknown', 'unknown')])
    const current = observe(begin(initial, 1, 'A'), 1, 'A', entries)
    const closed = end(current, 1, 'A')
    expect(selectTeamActivity(closed, 'A').map(item => item.status)).toEqual(['unknown', 'unknown', 'response_received', 'unavailable', 'unknown'])
    expect(entries.map(item => item.status)).toEqual(['queued', 'request_started', 'response_received', 'unavailable', 'unknown'])
    expect(selectTeamActivity(closed, 'B')).toEqual([])
    expect(observe(closed, 1, 'A', [entry('late', 'response_received')])).toBe(closed)
  })

  it('projects unfinished entries as unknown while the host gate is closed without mutating dispatch state', () => {
    const entries = Object.freeze([entry('waiting', 'queued'), entry('started', 'request_started'), entry('received', 'response_received'), entry('unavailable', 'unavailable')])
    const current = observe(begin(initial, 1, 'A'), 1, 'A', entries)
    expect(selectTeamActivity(current, 'A', true).map(item => item.status)).toEqual(['unknown', 'unknown', 'response_received', 'unavailable'])
    expect(selectTeamActivity(current, 'A').map(item => item.status)).toEqual(['queued', 'request_started', 'response_received', 'unavailable'])
    expect(selectTeamActivity(current, 'B', true)).toEqual([])
  })

  it('does not turn interrupted entries into a weaker unavailable status on a late observation', () => {
    const entries = [entry('inflight', 'queued'), entry('terminal', 'unavailable'), entry('responded', 'request_started')]
    const current = observe(begin(initial, 1, 'A'), 1, 'A', entries)
    const closed = reduceTeamActivity(current, { type: 'close', owner: 1, key: 'A' })
    const next = observe(closed, 1, 'A', [entry('inflight', 'unavailable'), entry('terminal', 'unavailable'), entry('responded', 'response_received')])
    expect(selectTeamActivity(next, 'A').map(item => [item.intent.id, item.status])).toEqual([
      ['inflight', 'unknown'], ['terminal', 'unavailable'], ['responded', 'response_received']
    ])
    expect(selectTeamActivity(current, 'A').map(item => item.status)).toEqual(['queued', 'unavailable', 'request_started'])
  })

  it('keeps a closed broadcast recipient unknown without changing another recipient or another owner', () => {
    const delivery = (recipient: string, status: TeamDispatchEntry['status']): TeamDispatchEntry => Object.freeze({ ...entry('broadcast', status), recipient })
    const first = observe(begin(initial, 1, 'A'), 1, 'A', [delivery('alice', 'queued'), delivery('bob', 'unavailable')])
    const closed = reduceTeamActivity(first, { type: 'close', owner: 1, key: 'A' })
    const late = observe(closed, 1, 'A', [delivery('alice', 'unavailable'), delivery('bob', 'unavailable')])
    expect(selectTeamActivity(late, 'A').map(item => [item.recipient, item.status])).toEqual([['alice', 'unknown'], ['bob', 'unavailable']])
    const fresh = begin(end(late, 1, 'A'), 2, 'A')
    const freshObserved = observe(fresh, 2, 'A', [delivery('alice', 'unavailable')])
    expect(selectTeamActivity(freshObserved, 'A').map(item => item.status)).toEqual(['unavailable'])
    expect(observe(freshObserved, 1, 'A', [delivery('alice', 'queued')])).toBe(freshObserved)
  })

  it('retains uncertainty after a gate cycle while still preserving subsequently observed terminal evidence', () => {
    const current = observe(begin(initial, 1, 'A'), 1, 'A', [entry('q', 'queued'), entry('started', 'request_started')])
    const closed = reduceTeamActivity(current, { type: 'close', owner: 1, key: 'A' })
    expect(selectTeamActivity(closed, 'A').map(item => item.status)).toEqual(['unknown', 'unknown'])
    const latePending = observe(closed, 1, 'A', [entry('q', 'queued'), entry('started', 'request_started')])
    expect(selectTeamActivity(latePending, 'A').map(item => item.status)).toEqual(['unknown', 'unknown'])
    const lateResponse = observe(latePending, 1, 'A', [entry('q', 'queued'), entry('started', 'response_received')])
    expect(selectTeamActivity(lateResponse, 'A').map(item => item.status)).toEqual(['unknown', 'response_received'])
    const next = begin(end(lateResponse, 1, 'A'), 2, 'A')
    expect(selectTeamActivity(next, 'A').map(item => item.status)).toEqual(['unknown', 'response_received'])
    expect(selectTeamActivity(observe(next, 2, 'A', [entry('new', 'queued')]), 'A')[0].status).toBe('queued')
    expect(reduceTeamActivity(next, { type: 'close', owner: 1, key: 'A' })).toBe(next)
  })

  it('ignores old observer and cleanup after a new owner starts, including same-key ABA', () => {
    const first = observe(begin(initial, 1, 'A'), 1, 'A', [entry('old', 'queued')])
    const second = observe(begin(end(first, 1, 'A'), 2, 'B'), 2, 'B', [entry('other', 'queued')])
    const third = begin(end(second, 2, 'B'), 3, 'A')
    expect(selectTeamActivity(third, 'A')).toEqual([])
    const current = observe(third, 3, 'A', [entry('new', 'queued')])
    expect(observe(current, 1, 'A', [entry('late', 'response_received')])).toBe(current)
    expect(end(current, 1, 'A')).toBe(current)
    expect(begin(current, 2, 'B')).toBe(current)
    expect(selectTeamActivity(current, 'A').map(item => [item.intent.id, item.status])).toEqual([['new', 'queued']])
  })

  it('preserves completed activity on a same-key restart until a new observation replaces it', () => {
    const observed = observe(begin(initial, 1, 'A'), 1, 'A', [entry('done', 'response_received')])
    const restarted = begin(end(observed, 1, 'A'), 2, 'A')
    expect(selectTeamActivity(restarted, 'A')[0].status).toBe('response_received')
    expect(selectTeamActivity(observe(restarted, 2, 'A', [entry('new', 'queued')]), 'A').map(item => item.intent.id)).toEqual(['new'])
  })
})
