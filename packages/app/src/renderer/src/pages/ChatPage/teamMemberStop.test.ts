import { describe, expect, it, vi } from 'vitest'
import { sendReleasesStopHolds, sessionPreparing, stopTeamMembers, teamMembersToStop } from './teamMemberStop'

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
