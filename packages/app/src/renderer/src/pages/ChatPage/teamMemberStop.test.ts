import { describe, expect, it, vi } from 'vitest'
import { sessionPreparing, stopTeamMembers, teamMembersToStop } from './teamMemberStop'

const none = new Set<string>()
const state = (patch: Partial<Parameters<typeof teamMembersToStop>[1]> = {}) => ({
  loading: none, sending: none, waiting: none, queues: new Map<string, { inFlight?: unknown }[]>(), ...patch
})

describe('team member stop', () => {
  it('stops a member that is only preparing its send (sending set, no run yet)', () => {
    const terminate = vi.fn()
    const stopped = stopTeamMembers(['a', 'b', 'c'], state({ sending: new Set(['b']) }), terminate)
    expect(stopped).toEqual(['b'])
    expect(terminate.mock.calls).toEqual([['b', { dropQueued: true, pauseUserSends: true }]])
  })

  it('covers running, waiting and leased-queue members, and leaves idle members alone', () => {
    const queues = new Map([['d', [{ inFlight: true }]], ['e', [{}]]])
    const ids = teamMembersToStop(['a', 'b', 'c', 'd', 'e'], state({
      loading: new Set(['a']), waiting: new Set(['c']), queues
    }))
    expect(ids).toEqual(['a', 'c', 'd'])
    expect(sessionPreparing('d', none, queues)).toBe(true)
    // A queued item that is not in its preflight is not work in progress.
    expect(sessionPreparing('e', none, queues)).toBe(false)
  })
})
