import { describe, expect, it } from 'vitest'
import { TeamMessageMailbox } from './teamMessageMailbox'

describe('TeamMessageMailbox', () => {
  it('enqueues direct messages only for their recipient', () => {
    const box = new TeamMessageMailbox(id => ['lead', 'a', 'b'].includes(id))
    box.sendMessage('lead', 'a', 'hello')
    expect(box.take('b')).toEqual([])
    expect(box.take('a')).toEqual([{ from: 'lead', to: 'a', text: 'hello' }])
    expect(box.take('a')).toEqual([])
  })

  it('delivers channel messages to current subscribers and supports unsubscribe', () => {
    const members = new Set(['lead', 'a', 'b'])
    const box = new TeamMessageMailbox(id => members.has(id))
    box.subscribe('a', 'news')
    box.subscribe('b', 'news')
    box.unsubscribe('b', 'news')
    expect(box.sendChannel('lead', 'news', 'update')).toBe(1)
    expect(box.take('a')).toEqual([{ from: 'lead', to: 'a', text: 'update', channel: 'news' }])
    expect(box.take('b')).toEqual([])
    members.delete('a')
    expect(box.sendChannel('lead', 'news', 'next')).toBe(0)
  })

  it('rejects nonmembers and isolates independent team mailboxes', () => {
    const left = new TeamMessageMailbox(id => ['lead', 'a'].includes(id))
    const right = new TeamMessageMailbox(id => ['lead', 'b'].includes(id))
    left.subscribe('a', 'news')
    right.subscribe('b', 'news')
    expect(() => left.sendMessage('lead', 'b', 'no')).toThrow()
    expect(() => left.sendMessage('b', 'a', 'no')).toThrow()
    expect(() => left.subscribe('b', 'news')).toThrow()
    left.sendChannel('lead', 'news', 'left only')
    expect(right.take('b')).toEqual([])
  })

  it('broadcasts atomically when a mailbox is full', () => {
    const box = new TeamMessageMailbox(() => true, 1)
    box.subscribe('a', 'news')
    box.subscribe('b', 'news')
    box.sendMessage('lead', 'b', 'full')
    expect(() => box.sendChannel('lead', 'news', 'update')).toThrow('full')
    expect(box.take('a')).toEqual([])
    expect(box.take('b')).toHaveLength(1)
  })

  it('clears queued messages and subscriptions before member identity reuse', () => {
    const box = new TeamMessageMailbox(() => true)
    box.subscribe('a', 'news')
    box.sendMessage('lead', 'a', 'old')
    box.removeMember('a')
    expect(box.take('a')).toEqual([])
    expect(box.sendChannel('lead', 'news', 'new')).toBe(0)
  })

  it('rejects invalid channels, messages and limits', () => {
    expect(() => new TeamMessageMailbox(() => true, 0)).toThrow()
    const box = new TeamMessageMailbox(() => true)
    expect(() => box.subscribe('a', '../bad')).toThrow()
    expect(() => box.sendMessage('a', 'b', '  ')).toThrow()
    expect(() => box.sendMessage('a', 'b', 'x'.repeat(16385))).toThrow()
  })
})
