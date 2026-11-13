import { describe, expect, it } from 'vitest'
import { TeamMessageService } from './teamMessageService'

const create = (team = 'scope/lead/generation', limit = 10, members = new Set(['a', 'b', 'c'])) =>
  new TeamMessageService(team, id => members.has(id), limit, 10)

describe('temporary team message service', () => {
  it('broadcasts user messages without pretending user is a member', () => {
    const service = create()
    service.subscribe('a', 'general'); service.subscribe('b', 'general')
    expect(service.sendUserChannel('u', 'general', 'hello')).toBe(2)
    expect(service.peek('a')[0]).toMatchObject({ sender: null, recipient: 'a', status: 'queued' })
    expect(service.peek('b')[0]).toMatchObject({ sender: null, recipient: 'b', status: 'queued' })
    expect(() => service.sendUserChannel('u', 'general', 'hello')).toThrow(/Duplicate/)
  })

  it('claims only once without implying receipt and blocks claims after End', () => {
    const service = create()
    service.sendDirect('1', 'a', 'b', 'hello')
    const claim = service.claim('b', '1')!
    expect(claim.status).toBe('claimed')
    expect(Object.isFrozen(claim)).toBe(true)
    expect(service.claim('b', '1')).toBeUndefined()
    expect(service.peek('b')).toEqual([])
    service.end()
    expect(() => service.claim('b', '1')).toThrow(/ended/)
    expect(service.ack('b', '1')).toBe(true)
    expect(service.history()[0].status).toBe('acknowledged')
  })

  it('isolates teams and rejects outsiders for sends, peeks and subscriptions', () => {
    const first = create('first')
    const second = create('second', 10, new Set(['x', 'y']))
    first.sendDirect('1', 'a', 'b', 'hello')
    expect(first.peek('b')).toEqual([{ id: '1', teamKey: 'first', sender: 'a', recipient: 'b', text: 'hello', status: 'queued' }])
    expect(second.peek('y')).toEqual([])
    expect(() => second.sendDirect('2', 'x', 'b', 'hello')).toThrow()
    expect(() => first.sendDirect('2', 'x', 'a', 'hello')).toThrow()
    expect(() => first.peek('x')).toThrow()
    expect(() => first.subscribe('x', 'general')).toThrow()
  })

  it('snapshots subscribers and tracks each recipient independently', () => {
    const service = create()
    service.subscribe('a', 'general')
    service.subscribe('b', 'general')
    service.subscribe('c', 'general')
    expect(service.sendChannel('1', 'a', 'general', 'hello')).toBe(2)
    service.unsubscribe('b', 'general')
    expect(service.ack('b', '1')).toBe(true)
    expect(service.peek('b')).toEqual([])
    expect(service.peek('c')[0].status).toBe('queued')
    expect(service.sendChannel('2', 'a', 'general', 'again')).toBe(1)
    expect(service.peek('b')).toEqual([])
    expect(service.peek('c').map(item => item.id)).toEqual(['1', '2'])
    expect(service.history().map(item => item.status)).toEqual(['acknowledged', 'queued', 'queued'])
  })

  it('keeps failed deliveries until explicitly acknowledged; ack is per recipient', () => {
    const service = create()
    service.sendDirect('1', 'a', 'b', 'hello')
    expect(service.peek('b')).toEqual(service.peek('b'))
    expect(service.ack('c', '1')).toBe(false)
    expect(service.peek('b')).toHaveLength(1)
    expect(service.ack('b', '1')).toBe(true)
    expect(service.ack('b', '1')).toBe(true)
    expect(service.peek('b')).toEqual([])
    expect(service.history()[0].status).toBe('acknowledged')
  })

  it('validates IDs, membership, text and unique IDs even for empty broadcasts', () => {
    const service = create()
    expect(() => create(' ')).toThrow()
    expect(() => service.sendDirect('', 'a', 'b', 'hello')).toThrow()
    expect(() => service.sendDirect('1', 'a', 'b', ' ')).toThrow()
    expect(() => service.sendDirect('1', 'a', 'b', '12345678901')).toThrow()
    expect(() => service.sendChannel('1', 'a', '', 'hello')).toThrow()
    expect(service.sendChannel('1', 'a', 'empty', 'hello')).toBe(0)
    expect(() => service.sendDirect('1', 'a', 'b', 'hello')).toThrow(/Duplicate/)
    expect(service.history()).toEqual([])
  })

  it('preflights broadcast capacity with no partial delivery or ID consumption', () => {
    const service = create('team', 2)
    service.subscribe('b', 'general')
    service.subscribe('c', 'general')
    service.sendDirect('1', 'a', 'b', 'hello')
    expect(() => service.sendChannel('2', 'a', 'general', 'hello')).toThrow(/full/)
    expect(service.peek('c')).toEqual([])
    service.sendDirect('2', 'a', 'c', 'hello')
    expect(() => service.sendDirect('3', 'a', 'b', 'hello')).toThrow(/full/)
    service.ack('b', '1')
    expect(() => service.sendDirect('3', 'a', 'b', 'hello')).toThrow(/full/)
  })

  it('bounds subscriptions and excludes members removed before publishing', () => {
    const members = new Set(['a', 'b', 'c'])
    const service = create('team', 2, members)
    service.subscribe('b', 'general')
    service.subscribe('c', 'general')
    expect(() => service.subscribe('a', 'other')).toThrow(/limit/)
    members.delete('c')
    expect(service.sendChannel('1', 'a', 'general', 'hello')).toBe(1)
    expect(() => service.peek('c')).toThrow()
  })

  it('blocks new send, peek and subscriptions after End while allowing acknowledgement of already observed items', () => {
    const service = create()
    service.subscribe('b', 'general')
    service.sendDirect('1', 'a', 'b', 'hello')
    const [observed] = service.peek('b')
    service.end()
    expect(() => service.sendDirect('2', 'a', 'b', 'hello')).toThrow(/ended/)
    expect(() => service.sendChannel('2', 'a', 'general', 'hello')).toThrow(/ended/)
    expect(() => service.peek('b')).toThrow(/ended/)
    expect(() => service.subscribe('b', 'general')).toThrow(/ended/)
    expect(service.ack('b', observed.id)).toBe(true)
    expect(service.history()[0].status).toBe('acknowledged')
  })
})
