import { describe, expect, it, vi } from 'vitest'
import { TeamMessageDispatcher, type TeamDispatchStage } from './teamMessageDispatcher'

const team = { scope: 's', thread: 't', lead: 'l' }
const source = { ...team, kind: 'member' as const, member: 'a' }
const intent = (id = '1') => ({ id, source, kind: 'message' as const, hop: 1 as const, recipient: 'b', text: 'hello' })
const setup = (deliver = vi.fn(async (_item, _source, _stage, _hop?: 1 | 2) => {}), members = ['a', 'b', 'c']) => {
  let current = true
  const onChange = vi.fn()
  const dispatcher = new TeamMessageDispatcher(team, () => current, id => members.includes(id), members, deliver, onChange)
  return { dispatcher, deliver, onChange, stop: () => { current = false } }
}

describe('TeamMessageDispatcher', () => {
  it('preflights activity capacity before mutating the service, including unavailable records', () => {
    const dispatcher = new TeamMessageDispatcher(team, () => true, id => ['a', 'b'].includes(id), ['a', 'b'], vi.fn(async () => {}), undefined, 2)
    dispatcher.recordUnavailable({ ...intent('rejected'), recipient: 'missing' }, 'missing')
    expect(() => dispatcher.enqueueUserChannel({ id: 'u', source: { ...team, kind: 'user' }, text: 'hello' })).toThrow(/limit/)
    expect(dispatcher.entries()).toHaveLength(1)
    dispatcher.unsubscribe('a')
    expect(dispatcher.enqueueUserChannel({ id: 'u', source: { ...team, kind: 'user' }, text: 'hello' })).toEqual({ queued: 1 })
    expect(dispatcher.entries()).toHaveLength(2)
    expect(() => dispatcher.enqueue(intent('full'))).toThrow(/limit/)
  })

  it('broadcasts user origin to a subscription snapshot with hop 1 and no fake member', async () => {
    const deliver = vi.fn(async (_item, _source, stage: (value: TeamDispatchStage) => void, _hop?: 1 | 2) => { stage('request_started'); stage('response_received') })
    const { dispatcher } = setup(deliver)
    dispatcher.unsubscribe('c')
    const user = { ...team, kind: 'user' as const }
    expect(dispatcher.enqueueUserChannel({ id: 'u', source: user, text: 'hello' })).toEqual({ queued: 2 })
    dispatcher.unsubscribe('b')
    await dispatcher.pump('a'); await dispatcher.pump('b')
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver.mock.calls[0][0]).toMatchObject({ sender: null, status: 'claimed', text: 'hello' })
    expect(deliver.mock.calls[0][1]).toEqual(user)
    expect(deliver.mock.calls[0][3]).toBe(1)
    expect(dispatcher.entries().map(item => item.status)).toEqual(['response_received', 'response_received'])
    expect(() => dispatcher.enqueueUserChannel({ id: 'u', source: user, text: 'hello' })).toThrow(/Duplicate/)
  })

  it('handles empty subscriptions, invalid user identities and End conservatively', () => {
    const { dispatcher } = setup()
    const source = { ...team, kind: 'user' as const }
    for (const id of ['a', 'b', 'c']) dispatcher.unsubscribe(id)
    expect(dispatcher.enqueueUserChannel({ id: 'u', source, text: 'hello' })).toEqual({ queued: 0 })
    expect(dispatcher.entries()[0].status).toBe('unavailable')
    expect(() => dispatcher.enqueue({ id: 'bad', source: { ...source, member: 'a' } as typeof source, kind: 'channel', hop: 1, text: 'hello' })).toThrow()
    expect(() => dispatcher.enqueue({ id: 'bad', source, kind: 'channel', hop: 2, text: 'hello' })).toThrow()
    dispatcher.end()
    expect(() => dispatcher.enqueueUserChannel({ id: 'v', source, text: 'hello' })).toThrow()
  })

  it('delivers source and body, and only explicit stages show request and response', async () => {
    const deliver = vi.fn(async (item, origin, stage: (value: TeamDispatchStage) => void) => {
      expect(item).toMatchObject({ id: '1', sender: 'a', recipient: 'b', text: 'hello', status: 'claimed' })
      expect(origin).toEqual(source)
      stage('request_started')
      stage('response_received')
    })
    const { dispatcher, onChange } = setup(deliver)
    dispatcher.enqueue(intent())
    await dispatcher.pump('b')
    expect(dispatcher.entries()[0].status).toBe('response_received')
    expect(onChange.mock.calls.flatMap(call => call[0].map(entry => entry.status))).toContain('request_started')
  })

  it('passes the host-bound two-hop budget to deliveries and rejects malformed depths', async () => {
    const deliver = vi.fn(async (_item, _source, stage: (value: TeamDispatchStage) => void, hop?: 1 | 2) => {
      expect(hop).toBe(2)
      stage('request_started'); stage('response_received')
    })
    const { dispatcher } = setup(deliver)
    expect(() => dispatcher.enqueue({ ...intent(), hop: 3 as 1 })).toThrow(/hop/)
    dispatcher.enqueue({ ...intent(), hop: 2 })
    await dispatcher.pump('b')
    expect(deliver).toHaveBeenCalledOnce()
    expect(dispatcher.entries()[0]).toMatchObject({ status: 'response_received', intent: { hop: 2 } })
  })

  it('handles per-recipient broadcasts, unsubscription and no subscribers', async () => {
    const { dispatcher } = setup()
    dispatcher.unsubscribe('c')
    dispatcher.enqueue({ id: '1', source, kind: 'channel', hop: 1, text: 'hello' })
    expect(dispatcher.entries().map(entry => entry.recipient)).toEqual(['b'])
    dispatcher.unsubscribe('b')
    dispatcher.enqueue({ id: '2', source, kind: 'channel', hop: 2, text: 'hello' })
    expect(dispatcher.entries()[1].status).toBe('unavailable')
    await dispatcher.pump('b')
    expect(dispatcher.entries()[0].status).toBe('unavailable')
  })

  it('rejects forged scope, members, duplicate ids and stale generation', () => {
    const { dispatcher, stop } = setup()
    expect(() => dispatcher.enqueue({ ...intent(), source: { ...source, scope: 'other' } })).toThrow()
    expect(() => dispatcher.enqueue({ ...intent(), source: { ...source, member: 'x' } })).toThrow()
    expect(() => dispatcher.enqueue({ ...intent(), recipient: 'x' })).toThrow()
    dispatcher.enqueue(intent())
    expect(() => dispatcher.enqueue({ ...intent(), text: 'different' })).toThrow(/Duplicate/)
    stop()
    expect(() => dispatcher.enqueue(intent('2'))).toThrow()
    expect(() => dispatcher.pump('b')).toThrow()
  })

  it('does not claim when the host reports the recipient busy', async () => {
    let busy = true
    const deliver = vi.fn(async () => {})
    const dispatcher = new TeamMessageDispatcher(team, () => true, id => ['a', 'b'].includes(id), ['a', 'b'], deliver, undefined, 1000, () => busy)
    dispatcher.enqueue(intent())
    expect(dispatcher.pump('b')).toBeUndefined()
    expect(dispatcher.entries()[0].status).toBe('queued')
    expect(deliver).not.toHaveBeenCalled()
    busy = false
    await dispatcher.pump('b')
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('marks queued removed recipients unavailable without retry or recalling started requests', async () => {
    const members = ['a', 'b', 'c']
    let finish!: () => void
    const deliver = vi.fn((_item, _source, stage: (value: TeamDispatchStage) => void) => {
      stage('request_started')
      return new Promise<void>(resolve => { finish = resolve })
    })
    const { dispatcher } = setup(deliver, members)
    dispatcher.enqueue(intent())
    dispatcher.enqueue({ ...intent('2'), recipient: 'c' })
    const running = dispatcher.pump('b')!
    members.splice(members.indexOf('c'), 1)
    dispatcher.reconcileMembers()
    expect(dispatcher.entries().map(entry => entry.status)).toEqual(['request_started', 'unavailable'])
    expect(deliver).toHaveBeenCalledTimes(1)
    finish(); await running
    expect(dispatcher.entries().map(entry => entry.status)).toEqual(['unknown', 'unavailable'])
  })

  it('single-flights a busy member and leaves later work queued', async () => {
    let finish!: () => void
    const deliver = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const { dispatcher } = setup(deliver)
    dispatcher.enqueue(intent())
    dispatcher.enqueue(intent('2'))
    const first = dispatcher.pump('b')!
    expect(dispatcher.pump('b')).toBeUndefined()
    expect(dispatcher.entries().map(item => item.status)).toEqual(['queued', 'queued'])
    expect(deliver).toHaveBeenCalledTimes(1)
    finish()
    await first
    expect(dispatcher.entries().map(item => item.status)).toEqual(['unavailable', 'queued'])
  })

  it.each(['resolve', 'reject', 'started', 'started-reject'] as const)('settles %s without blindly retrying', async mode => {
    const deliver = vi.fn(async (_item, _source, stage: (value: TeamDispatchStage) => void) => {
      if (mode.startsWith('started')) stage('request_started')
      if (mode.includes('reject')) throw new Error('cancelled')
    })
    const { dispatcher } = setup(deliver)
    dispatcher.enqueue(intent())
    await dispatcher.pump('b')
    expect(dispatcher.entries()[0].status).toBe(mode.startsWith('started') ? 'unknown' : 'unavailable')
    expect(dispatcher.pump('b')).toBeUndefined()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('records a rejected claimed intent as unavailable without retry', () => {
    const { dispatcher, deliver } = setup()
    const invalid = { ...intent(), recipient: 'missing' }
    expect(() => dispatcher.enqueue(invalid)).toThrow()
    dispatcher.recordUnavailable(invalid, invalid.recipient)
    expect(dispatcher.entries()).toMatchObject([{ intent: invalid, recipient: 'missing', status: 'unavailable' }])
    expect(() => dispatcher.enqueue(intent())).toThrow(/Duplicate/)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('End revokes a claimed delivery that has not started a request', async () => {
    let release!: () => void
    let onStage!: (stage: TeamDispatchStage) => void
    const deliver = vi.fn((_delivery, _source, stage: (stage: TeamDispatchStage) => void) => {
      onStage = stage
      return new Promise<void>(resolve => { release = resolve })
    })
    const { dispatcher } = setup(deliver)
    dispatcher.enqueue(intent())
    const pending = dispatcher.pump('b')!
    dispatcher.end()
    expect(dispatcher.entries()[0].status).toBe('unavailable')
    onStage('request_started'); release(); await pending
    expect(dispatcher.entries()[0].status).toBe('unavailable')
  })

  it('End leaves an admitted request free to report its actual response', async () => {
    let finish!: () => void
    let onStage!: (stage: TeamDispatchStage) => void
    const deliver = vi.fn((_item, _source, stage: (value: TeamDispatchStage) => void) => {
      onStage = stage; stage('request_started')
      return new Promise<void>(resolve => { finish = resolve })
    })
    const { dispatcher } = setup(deliver)
    dispatcher.enqueue(intent())
    const running = dispatcher.pump('b')!
    dispatcher.end()
    onStage('response_received'); finish(); await running
    expect(dispatcher.entries()[0].status).toBe('response_received')
  })

  it('End blocks new work and leaves claimed work to host, never starts queued work', async () => {
    let finish!: () => void
    const deliver = vi.fn((_item, _source, stage: (value: TeamDispatchStage) => void) => {
      stage('request_started')
      return new Promise<void>(resolve => { finish = resolve })
    })
    const { dispatcher } = setup(deliver)
    dispatcher.enqueue(intent())
    dispatcher.enqueue(intent('2'))
    const running = dispatcher.pump('b')!
    dispatcher.end()
    expect(dispatcher.entries().map(item => item.status)).toEqual(['request_started', 'unavailable'])
    expect(() => dispatcher.pump('b')).toThrow()
    expect(() => dispatcher.enqueue(intent('3'))).toThrow()
    finish()
    await running
    expect(dispatcher.entries().map(item => item.status)).toEqual(['unknown', 'unavailable'])
  })
})
