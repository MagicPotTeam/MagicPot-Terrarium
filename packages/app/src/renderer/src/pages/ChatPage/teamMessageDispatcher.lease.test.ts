import { describe, expect, it, vi } from 'vitest'
import { TeamMessageDispatcher, type TeamDispatchStage, type TeamMessageIntent } from './teamMessageDispatcher'

// A claimed member message carries MAIN's lease; the delivery of each of its records presents it.
const team = { scope: 's', thread: 't', lead: 'l' }
const members = ['a', 'b', 'c']
const message = (id: string, lease?: string, recipient = 'b'): TeamMessageIntent =>
  ({ id, source: { ...team, kind: 'member', member: 'a' }, kind: 'message', hop: 1, recipient, text: `text ${id}`, ...(lease ? { lease } : {}) })
const setup = (limit = 1000) => {
  const deliver = vi.fn(async (_delivery: { id: string; recipient: string }, _source: unknown, stage: (value: TeamDispatchStage) => void, _hop: 1 | 2, _lease?: string) => {
    stage('request_started')
    stage('response_received')
  })
  return { deliver, dispatcher: new TeamMessageDispatcher(team, () => true, id => members.includes(id), members, deliver, undefined, limit) }
}

describe('team message dispatcher leases', () => {
  it('gives each record of a direct and of a channel message its own lease at delivery', async () => {
    const { deliver, dispatcher } = setup()
    dispatcher.enqueue(message('direct', 'lease-direct'))
    dispatcher.enqueue({ id: 'channel', source: { ...team, kind: 'member', member: 'a' }, kind: 'channel', hop: 2, text: 'to all', lease: 'lease-channel' })
    await dispatcher.pump('b')
    await dispatcher.pump('b')
    await dispatcher.pump('c')
    expect(deliver.mock.calls.map(call => [call[0].id, call[0].recipient, call[3], call[4]])).toEqual([
      ['direct', 'b', 1, 'lease-direct'],
      ['channel', 'b', 2, 'lease-channel'],
      ['channel', 'c', 2, 'lease-channel']
    ])
    expect(dispatcher.recipientsOf('channel').sort()).toEqual(['b', 'c'])
    expect(dispatcher.recipientsOf('direct')).toEqual(['b'])
  })

  it('keeps the lease with its record after pruning shifted the indexes', async () => {
    const { deliver, dispatcher } = setup(4)
    for (const id of ['m0', 'm1', 'm2']) { dispatcher.enqueue(message(id, `lease-${id}`)); await dispatcher.pump('b') }
    // Two records wait for 'c' (busy elsewhere), then the log is full and the oldest settled ones go.
    dispatcher.enqueue(message('w1', 'lease-w1', 'c'))
    dispatcher.enqueue(message('w2', 'lease-w2', 'c'))
    dispatcher.enqueue(message('w3', 'lease-w3', 'c'))
    expect(dispatcher.entries().map(entry => entry.intent.id)).toEqual(['m2', 'w1', 'w2', 'w3'])
    await dispatcher.pump('c'); await dispatcher.pump('c'); await dispatcher.pump('c')
    expect(deliver.mock.calls.slice(3).map(call => [call[0].id, call[4]])).toEqual([['w1', 'lease-w1'], ['w2', 'lease-w2'], ['w3', 'lease-w3']])
  })

  it('sends no lease for a user broadcast, nor for a member message claimed without one', async () => {
    const { deliver, dispatcher } = setup()
    dispatcher.enqueueUserChannel({ id: 'user', source: { ...team, kind: 'user' }, text: 'from the user' })
    // Even when one is passed in, a user record never carries it.
    dispatcher.enqueue({ id: 'user-2', source: { ...team, kind: 'user' }, kind: 'channel', hop: 1, text: 'again', lease: 'not-for-users' })
    dispatcher.enqueue(message('plain'))
    for (const id of ['a', 'b', 'c', 'a', 'b', 'c', 'b']) await dispatcher.pump(id)
    expect(deliver.mock.calls.length).toBe(7)
    expect(deliver.mock.calls.every(call => call[4] === undefined)).toBe(true)
    expect(dispatcher.entries().every(entry => entry.intent.lease === undefined)).toBe(true)
  })
})
