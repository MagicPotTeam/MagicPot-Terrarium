import { describe, expect, it, vi } from 'vitest'
import { pruneTeamMemberHolds, sendReleasesStopHolds, sessionPreparing, stopTeamMembers, stopTeamMembersAndHoldQueued, teamMembersToStop } from './teamMemberStop'

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

describe('stop-all and idle members with queued team messages', () => {
  it('holds the idle members that still have queued team messages, and leaves the other idle members alone', () => {
    const terminate = vi.fn()
    const hold = vi.fn()
    const queued = new Set(['b', 'c'])
    const result = stopTeamMembersAndHoldQueued(['a', 'b', 'c', 'd'], state({ loading: new Set(['a', 'c']) }), terminate, id => queued.has(id), hold)
    // c works: it is stopped (and held by its stop), not held a second time here.
    expect(result).toEqual({ stopped: ['a', 'c'], held: ['b'] })
    expect(terminate.mock.calls.map(call => call[0])).toEqual(['a', 'c'])
    expect(hold.mock.calls).toEqual([['b']])
  })
  it('holds an idle member with queued messages even when no member works at the click (its run just ended)', () => {
    const terminate = vi.fn()
    const hold = vi.fn()
    expect(stopTeamMembersAndHoldQueued(['a', 'b'], state(), terminate, id => id === 'b', hold)).toEqual({ stopped: [], held: ['b'] })
    expect(terminate).not.toHaveBeenCalled()
    expect(hold.mock.calls).toEqual([['b']])
  })
})

describe('which accepted send releases a stop hold', () => {
  const task = { content: '团队任务：x', onTaskCompleted: () => undefined, onTaskSettled: () => undefined }
  it('releases on the user\'s own sends: composer, @member, edit-resend and a task the user dispatched', () => {
    expect(sendReleasesStopHolds(undefined)).toBe(true)
    expect(sendReleasesStopHolds({ composerSubmission: true })).toBe(true)
    expect(sendReleasesStopHolds({ onComposerSubmissionAccepted: () => undefined })).toBe(true)
    expect(sendReleasesStopHolds({ ...task, userTaskDispatch: true })).toBe(true)
  })
  it('never releases on a task dispatched by the lead or by automation, a team-message delivery or a drained queue item', () => {
    expect(sendReleasesStopHolds(task)).toBe(false)
    expect(sendReleasesStopHolds({ ...task, userTaskDispatch: false })).toBe(false)
    expect(sendReleasesStopHolds({ content: '[团队成员消息]', queueKey: 'team-message:1', teamMessageHop: 1 } as never)).toBe(false)
    // A drained item releases in its own lease (onQueuedComposerAccepted), not here.
    expect(sendReleasesStopHolds({ composerSubmission: true, isQueuedComposerCurrent: () => true })).toBe(false)
    expect(sendReleasesStopHolds({ ...task, userTaskDispatch: true, isQueuedComposerCurrent: () => true })).toBe(false)
  })
})

describe('pruning stop holds of members that left the team', () => {
  const key = (scope: string, id: string) => `${scope}\u0000${id}`
  const lead = { id: 'lead', teamGeneration: 1 }
  const members = [
    { id: 'kept', teamLeadId: 'lead', teamMemberGeneration: 1 },
    { id: 'archived', teamLeadId: 'lead', teamMemberGeneration: 1, archived: true },
    { id: 'old-generation', teamLeadId: 'lead', teamMemberGeneration: 0 },
    { id: 'deleted', teamLeadId: 'lead', teamMemberGeneration: 1 }
  ]
  it('drops the holds of removed, deleted and older-generation members and keeps current members and other scopes', () => {
    const held = new Set([key('s', 'kept'), key('s', 'archived'), key('s', 'old-generation'), key('s', 'deleted'), key('s', 'missing'), key('other', 'archived')])
    const dropped = pruneTeamMemberHolds(held, 's', [lead, ...members], id => id === 'deleted')
    expect(dropped.sort()).toEqual(['archived', 'deleted', 'missing', 'old-generation'])
    expect([...held]).toEqual([key('s', 'kept'), key('other', 'archived')])
  })
  it('drops every hold of the team when the team ends, or its lead is archived or deleted', () => {
    for (const [endedLead, deleted] of [[{ ...lead, teamEnded: true }, ''], [{ ...lead, archived: true }, ''], [lead, 'lead']] as const) {
      const held = new Set([key('s', 'kept'), key('other', 'kept')])
      expect(pruneTeamMemberHolds(held, 's', [endedLead, ...members], id => id === deleted)).toEqual(['kept'])
      expect([...held]).toEqual([key('other', 'kept')])
    }
  })
  it('changes nothing while every held member is still in the team', () => {
    const held = new Set([key('s', 'kept')])
    expect(pruneTeamMemberHolds(held, 's', [lead, ...members])).toEqual([])
    expect([...held]).toEqual([key('s', 'kept')])
  })
})
