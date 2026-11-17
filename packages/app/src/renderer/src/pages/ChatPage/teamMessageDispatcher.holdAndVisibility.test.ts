import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamMessageDispatcher, type TeamDispatchStage, type TeamMessageIntent } from './teamMessageDispatcher'

// A host like the ChatPage effect: every 500 ms it claims the MAIN intents (which expire after
// 60 s, agentTeamMessageQueue.ts) into the dispatcher and pumps every member.
const team = { scope: 'synthetic-scope', thread: 'synthetic-thread', lead: 'synthetic-lead' }
const members = ['a', 'b']
const TTL_MS = 60_000

const createHost = () => {
  let visible = true
  const busy = new Set<string>()
  const main = new Map<string, { intent: TeamMessageIntent; expiresAt: number }>()
  const claims: string[] = []
  const requests: string[] = []
  const deliver = vi.fn(async (delivery: { id: string; recipient: string }, _source: unknown, stage: (value: TeamDispatchStage) => void) => {
    requests.push(`${delivery.recipient}:${delivery.id}`)
    stage('request_started')
    stage('response_received')
  })
  const dispatcher = new TeamMessageDispatcher(team, () => true, id => members.includes(id), members, deliver, undefined, 1000,
    id => busy.has(id), () => visible)
  const send = (id: string, recipient: string) => {
    main.set(id, {
      intent: { id, source: { ...team, kind: 'member', member: recipient === 'a' ? 'b' : 'a' }, kind: 'message', hop: 1, recipient, text: `text ${id}` },
      expiresAt: Date.now() + TTL_MS
    })
  }
  const tick = () => {
    for (const [id, entry] of main) if (entry.expiresAt <= Date.now()) main.delete(id)
    for (const [id, entry] of [...main]) {
      main.delete(id)
      claims.push(id)
      dispatcher.enqueue(entry.intent)
    }
    for (const member of members) void dispatcher.pump(member)
  }
  const timer = setInterval(tick, 500)
  return {
    dispatcher, deliver, requests, claims, main, busy, send,
    setVisible: (value: boolean) => { visible = value },
    statuses: () => dispatcher.entries().map(entry => `${entry.recipient}:${entry.intent.id}:${entry.status}`),
    dispose: () => { clearInterval(timer); dispatcher.end() }
  }
}

describe('team message delivery across a hidden pane and a member stop', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('claims a message while the pane is hidden for 90 s and delivers it once after the pane returns', async () => {
    const host = createHost()
    host.setVisible(false)
    host.send('m1', 'b')
    await vi.advanceTimersByTimeAsync(90_000)
    // Claimed within the first tick, so the 60 s MAIN expiry cannot drop it; nothing was delivered.
    expect(host.claims).toEqual(['m1'])
    expect(host.main.size).toBe(0)
    expect(host.deliver).not.toHaveBeenCalled()
    expect(host.statuses()).toEqual(['b:m1:queued'])

    host.setVisible(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(host.requests).toEqual(['b:m1'])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(host.requests).toEqual(['b:m1'])
    expect(host.statuses()).toEqual(['b:m1:response_received'])
    host.dispose()
  })

  it('keeps a stopped member stopped: its queued message is held, then delivered once after release', async () => {
    const host = createHost()
    host.busy.add('b')
    host.send('m1', 'b')
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.statuses()).toEqual(['b:m1:queued'])

    // Stop-all: the member's run ends (no longer busy) and its team messages are held.
    host.dispatcher.hold('b')
    host.busy.delete('b')
    await vi.advanceTimersByTimeAsync(2000)
    expect(host.deliver).not.toHaveBeenCalled()
    expect(host.statuses()).toEqual(['b:m1:held'])
    // A message that arrives for the stopped member waits too; the other member is not held.
    host.send('m2', 'b')
    host.send('m3', 'a')
    await vi.advanceTimersByTimeAsync(2000)
    expect(host.requests).toEqual(['a:m3'])
    expect(host.statuses()).toEqual(['b:m1:held', 'b:m2:held', 'a:m3:response_received'])
    expect(host.dispatcher.isHeld('b')).toBe(true)

    // The user's next send to the member resumes it: each held message is delivered once, in order.
    host.dispatcher.release('b')
    await vi.advanceTimersByTimeAsync(5000)
    expect(host.requests).toEqual(['a:m3', 'b:m1', 'b:m2'])
    expect(host.statuses()).toEqual(['b:m1:response_received', 'b:m2:response_received', 'a:m3:response_received'])
    host.dispatcher.release('b')
    await vi.advanceTimersByTimeAsync(5000)
    expect(host.requests).toEqual(['a:m3', 'b:m1', 'b:m2'])
    host.dispose()
  })

  it('never holds a claimed delivery, and End turns held records unavailable', async () => {
    let finish = () => {}
    const deliver = vi.fn((_delivery: unknown, _source: unknown, _stage: (value: TeamDispatchStage) => void) => new Promise<void>(resolve => { finish = resolve }))
    const onChange = vi.fn()
    const dispatcher = new TeamMessageDispatcher(team, () => true, id => members.includes(id), members, deliver, onChange)
    const intent = (id: string): TeamMessageIntent => ({ id, source: { ...team, kind: 'member', member: 'a' }, kind: 'message', hop: 1, recipient: 'b', text: id })
    dispatcher.enqueue(intent('claimed'))
    dispatcher.enqueue(intent('waiting'))
    const work = dispatcher.pump('b')
    expect(deliver).toHaveBeenCalledOnce()
    dispatcher.hold('b')
    // The claimed one follows the host's cancellation (here: settles without a start), the other waits.
    expect(dispatcher.entries().map(entry => entry.status)).toEqual(['queued', 'held'])
    finish()
    await work
    expect(dispatcher.entries().map(entry => entry.status)).toEqual(['unavailable', 'held'])
    expect(dispatcher.pump('b')).toBeUndefined()
    expect(deliver).toHaveBeenCalledOnce()
    const notified = onChange.mock.calls.length
    dispatcher.hold('b')
    expect(onChange.mock.calls.length).toBe(notified)

    dispatcher.end()
    expect(dispatcher.entries().map(entry => entry.status)).toEqual(['unavailable', 'unavailable'])
    // A stop or a resume after End does nothing and never throws.
    expect(() => { dispatcher.hold('b'); dispatcher.release('b') }).not.toThrow()
    expect(dispatcher.entries().map(entry => entry.status)).toEqual(['unavailable', 'unavailable'])
    expect(deliver).toHaveBeenCalledOnce()
  })

  it('turns a held record of a removed member unavailable', () => {
    const current = new Set(members)
    const dispatcher = new TeamMessageDispatcher(team, () => true, id => current.has(id), members, vi.fn(async () => {}))
    dispatcher.hold('b')
    dispatcher.enqueue({ id: 'x', source: { ...team, kind: 'member', member: 'a' }, kind: 'message', hop: 1, recipient: 'b', text: 'x' })
    expect(dispatcher.entries()[0].status).toBe('held')
    current.delete('b')
    dispatcher.reconcileMembers()
    expect(dispatcher.entries()[0].status).toBe('unavailable')
  })
})
