import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamMessageDispatcher, type TeamDispatchStage, type TeamMessageIntent } from './teamMessageDispatcher'
import { TEAM_MESSAGE_HIDDEN_POLL_MS, TEAM_MESSAGE_VISIBLE_POLL_MS, startTeamMessagePolling } from './teamMessagePolling'

// A host like the ChatPage effect: each poll lists MAIN's intents (which expire after 60 s,
// agentTeamMessageQueue.ts), claims them into the dispatcher and pumps every member.
const team = { scope: 'synthetic-scope', thread: 'synthetic-thread', lead: 'synthetic-lead' }
const members = ['a', 'b']
const TTL_MS = 60_000

const createHost = () => {
  let visible = true
  const main = new Map<string, { intent: TeamMessageIntent; expiresAt: number }>()
  let listCalls = 0
  const claims: string[] = []
  const requests: string[] = []
  const deliver = vi.fn(async (delivery: { id: string; recipient: string }, _source: unknown, stage: (value: TeamDispatchStage) => void) => {
    requests.push(`${delivery.recipient}:${delivery.id}`)
    stage('request_started')
    stage('response_received')
  })
  const isVisible = () => visible
  const dispatcher = new TeamMessageDispatcher(team, () => true, id => members.includes(id), members, deliver, undefined, 1000, () => false, isVisible)
  const pump = () => { if (visible) for (const member of members) void dispatcher.pump(member) }
  const poll = () => {
    pump()
    listCalls++
    for (const [id, entry] of [...main]) {
      main.delete(id)
      if (entry.expiresAt <= Date.now()) continue
      claims.push(id)
      dispatcher.enqueue(entry.intent)
    }
    pump()
  }
  const poller = startTeamMessagePolling(isVisible, poll)
  return {
    main, claims, requests, poller,
    listCalls: () => listCalls,
    send: (id: string, recipient: string) => main.set(id, {
      intent: { id, source: { ...team, kind: 'member', member: recipient === 'a' ? 'b' : 'a' }, kind: 'message', hop: 1, recipient, text: id },
      expiresAt: Date.now() + TTL_MS
    }),
    setVisible: (value: boolean) => { visible = value },
    dispose: () => { poller.stop(); dispatcher.end() }
  }
}

describe('team message polling pace', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('polls MAIN every 500 ms while visible and every 3 s while hidden, then at once and fast again when shown', async () => {
    expect(TEAM_MESSAGE_VISIBLE_POLL_MS).toBe(500)
    expect(TEAM_MESSAGE_HIDDEN_POLL_MS).toBe(3000)
    // Claiming must stay well within MAIN's 60 s expiry.
    expect(TEAM_MESSAGE_HIDDEN_POLL_MS * 5).toBeLessThanOrEqual(TTL_MS / 4)
    const host = createHost()
    expect(host.listCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    const visibleCalls = host.listCalls() - 1
    expect(visibleCalls).toBe(60)

    host.setVisible(false)
    // The poll already scheduled at the visible pace runs once more, then the hidden pace applies.
    const beforeHidden = host.listCalls()
    await vi.advanceTimersByTimeAsync(30_000)
    const hiddenCalls = host.listCalls() - beforeHidden
    expect(hiddenCalls).toBeGreaterThanOrEqual(10)
    expect(hiddenCalls).toBeLessThanOrEqual(11)

    // A message posted while hidden is claimed by the next hidden poll and waits, undelivered.
    host.send('m-hidden', 'b')
    await vi.advanceTimersByTimeAsync(TEAM_MESSAGE_HIDDEN_POLL_MS)
    expect(host.claims).toEqual(['m-hidden'])
    expect(host.main.size).toBe(0)
    expect(host.requests).toEqual([])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(host.requests).toEqual([])

    // Shown again: the host wakes the poller, the message is delivered at once, the pace is 500 ms.
    host.setVisible(true)
    host.poller.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.requests).toEqual(['b:m-hidden'])
    const shownAt = host.listCalls()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(host.listCalls() - shownAt).toBe(10)
    expect(host.requests).toEqual(['b:m-hidden'])
    host.dispose()
  })

  it('claims a message posted just after a hidden poll long before MAIN drops it, and stops polling after stop()', async () => {
    const host = createHost()
    host.setVisible(false)
    await vi.advanceTimersByTimeAsync(1_000)
    host.send('late', 'a')
    await vi.advanceTimersByTimeAsync(TEAM_MESSAGE_HIDDEN_POLL_MS)
    expect(host.claims).toEqual(['late'])
    host.dispose()
    const calls = host.listCalls()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(host.listCalls()).toBe(calls)
  })

  it('keeps polling when one poll throws', async () => {
    let calls = 0
    const poller = startTeamMessagePolling(() => true, () => { calls++; if (calls === 2) throw new Error('IPC unavailable') })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls).toBe(5)
    poller.stop()
  })
})
