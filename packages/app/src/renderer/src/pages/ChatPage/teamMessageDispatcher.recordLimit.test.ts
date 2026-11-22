import { describe, expect, it, vi } from 'vitest'
import { TeamMessageDispatcher, type TeamDispatchStage, type TeamMessageIntent } from './teamMessageDispatcher'

// The dispatcher lives for the whole team in a pane, so its bounded record log must not fill up
// with finished deliveries: the oldest settled ones make room, unsettled ones never do.
const team = { scope: 's', thread: 't', lead: 'l' }
const members = ['a', 'b', 'c']
const message = (id: string, recipient = 'b'): TeamMessageIntent =>
  ({ id, source: { ...team, kind: 'member', member: recipient === 'a' ? 'b' : 'a' }, kind: 'message', hop: 1, recipient, text: `text ${id}` })
const answered = vi.fn(async (_delivery: unknown, _source: unknown, stage: (value: TeamDispatchStage) => void) => {
  stage('request_started')
  stage('response_received')
})

describe('team message dispatcher record limit', () => {
  it('accepts and delivers a new message after more than 1000 settled records', async () => {
    const delivered: string[] = []
    const deliver = vi.fn(async (delivery: { id: string }, _source: unknown, stage: (value: TeamDispatchStage) => void) => {
      delivered.push(delivery.id)
      stage('request_started')
      stage('response_received')
    })
    const dispatcher = new TeamMessageDispatcher(team, () => true, id => members.includes(id), members, deliver, undefined, 1000)
    for (let i = 0; i < 1005; i++) {
      dispatcher.enqueue(message(`m${i}`))
      await dispatcher.pump('b')
    }
    // A few unavailable and unknown records are settled too.
    dispatcher.recordUnavailable(message('gone', 'c'), 'c')
    expect(dispatcher.entries()).toHaveLength(1000)
    expect(dispatcher.entries().every(entry => entry.status === 'response_received' || entry.status === 'unavailable')).toBe(true)
    expect(dispatcher.enqueue(message('new'))).toBe(1)
    await dispatcher.pump('b')
    expect(delivered.at(-1)).toBe('new')
    expect(delivered).toHaveLength(1006)
    expect(new Set(delivered).size).toBe(1006)
    const entries = dispatcher.entries()
    expect(entries).toHaveLength(1000)
    expect(entries.at(-1)).toMatchObject({ recipient: 'b', status: 'response_received', intent: { id: 'new' } })
    // The oldest settled records went first; a dropped message ID is still refused as a duplicate.
    expect(entries.some(entry => entry.intent.id === 'm0')).toBe(false)
    expect(() => dispatcher.enqueue(message('m0'))).toThrow(/Duplicate/)
    expect(() => dispatcher.enqueue(message('new'))).toThrow(/Duplicate/)
  })

  it('still refuses a new message when every record is unsettled, and drops nothing', () => {
    const dispatcher = new TeamMessageDispatcher(team, () => true, id => members.includes(id), members, answered, undefined, 1000, () => true)
    for (let i = 0; i < 1000; i++) dispatcher.enqueue(message(`q${i}`))
    expect(dispatcher.pump('b')).toBeUndefined()
    const before = dispatcher.entries()
    expect(() => dispatcher.enqueue(message('over'))).toThrow('Team message activity limit reached.')
    expect(() => dispatcher.recordUnavailable(message('over'), 'b')).toThrow('Team message activity limit reached.')
    expect(dispatcher.entries()).toEqual(before)
    expect(answered).not.toHaveBeenCalled()
  })

  it('never drops queued, held, started or claimed records, and keeps a claimed delivery on its own record', async () => {
    const finishers: Array<() => void> = []
    let starts = 0
    const deliver = vi.fn((delivery: { id: string }, _source: unknown, stage: (value: TeamDispatchStage) => void) => {
      if (delivery.id === 'claimed') {
        return new Promise<void>(resolve => finishers.push(() => { stage('request_started'); stage('response_received'); resolve() }))
      }
      if (delivery.id === 'started') {
        starts++
        stage('request_started')
        return new Promise<void>(resolve => finishers.push(resolve))
      }
      stage('request_started')
      stage('response_received')
      return Promise.resolve()
    })
    const dispatcher = new TeamMessageDispatcher(team, () => true, id => members.includes(id), members, deliver, undefined, 6)
    dispatcher.enqueue(message('claimed', 'a'))
    const claimedWork = dispatcher.pump('a')
    dispatcher.enqueue(message('started', 'c'))
    const startedWork = dispatcher.pump('c')
    dispatcher.hold('b')
    dispatcher.enqueue(message('held', 'b'))
    for (const id of ['s1', 's2', 's3']) {
      dispatcher.enqueue(message(id, 'c'))
    }
    expect(dispatcher.entries().map(entry => `${entry.intent.id}:${entry.status}`)).toEqual([
      'claimed:queued', 'started:request_started', 'held:held', 's1:queued', 's2:queued', 's3:queued'
    ])
    // Nothing is settled: refused.
    expect(() => dispatcher.enqueue(message('x1', 'c'))).toThrow(/limit/)
    finishers[1]()
    await startedWork
    for (let i = 0; i < 3; i++) await dispatcher.pump('c')
    expect(dispatcher.entries().map(entry => `${entry.intent.id}:${entry.status}`)).toEqual([
      'claimed:queued', 'started:unknown', 'held:held', 's1:response_received', 's2:response_received', 's3:response_received'
    ])
    // Two new messages drop the two oldest settled records ('started' and 's1'), never the claimed or held one.
    dispatcher.enqueue(message('x1', 'c'))
    dispatcher.enqueue(message('x2', 'c'))
    expect(dispatcher.entries().map(entry => `${entry.intent.id}:${entry.status}`)).toEqual([
      'claimed:queued', 'held:held', 's2:response_received', 's3:response_received', 'x1:queued', 'x2:queued'
    ])
    // The claimed delivery ends on its own record although the records before it moved.
    finishers[0]()
    await claimedWork
    expect(dispatcher.entries().map(entry => `${entry.intent.id}:${entry.status}`)).toEqual([
      'claimed:response_received', 'held:held', 's2:response_received', 's3:response_received', 'x1:queued', 'x2:queued'
    ])
    expect(starts).toBe(1)
    dispatcher.release('b')
    await dispatcher.pump('b')
    expect(dispatcher.entries()[1]).toMatchObject({ intent: { id: 'held' }, status: 'response_received' })
  })

  it('drops a channel message only as a whole, once all its records are settled', async () => {
    let finish = () => {}
    const deliver = vi.fn((delivery: { recipient: string }, _source: unknown, stage: (value: TeamDispatchStage) => void) => {
      stage('request_started')
      if (delivery.recipient === 'c') return new Promise<void>(resolve => { finish = () => { stage('response_received'); resolve() } })
      stage('response_received')
      return Promise.resolve()
    })
    const dispatcher = new TeamMessageDispatcher(team, () => true, id => members.includes(id), members, deliver, undefined, 3)
    expect(dispatcher.enqueue({ id: 'ch', source: { ...team, kind: 'member', member: 'a' }, kind: 'channel', hop: 1, text: 'all' })).toBe(2)
    await dispatcher.pump('b')
    const pending = dispatcher.pump('c')
    dispatcher.enqueue(message('one', 'a'))
    // 'ch' to b is settled but 'ch' to c is still running: the channel message stays.
    expect(() => dispatcher.enqueue(message('two', 'a'))).toThrow(/limit/)
    finish()
    await pending
    await dispatcher.pump('a')
    dispatcher.enqueue(message('two', 'a'))
    expect(dispatcher.entries().map(entry => `${entry.intent.id}:${entry.recipient}`)).toEqual(['one:a', 'two:a'])
  })
})
