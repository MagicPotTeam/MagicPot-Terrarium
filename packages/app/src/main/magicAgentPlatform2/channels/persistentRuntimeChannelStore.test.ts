import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentRuntimeChannelStore } from './persistentRuntimeChannelStore'

const setup = () => {
  const events = new MagicAgentEventStore(':memory:')
  return { events, store: new PersistentRuntimeChannelStore(events) }
}

describe('PersistentRuntimeChannelStore', () => {
  it('rejects changed membership idempotent input after durable join', () => {
    const { events, store } = setup()
    const channel = store.createChannel({
      channel: {
        id: 'durable-membership',
        name: 'Durable',
        mode: 'queue',
        capacity: 2,
        members: []
      },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    const command = {
      channelId: channel.id,
      expectedRevision: 0,
      member: {
        memberId: 'consumer',
        agentInstanceId: 'agent',
        role: 'consumer' as const,
        joinedAt: 2
      },
      joinedAt: 2,
      idempotencyKey: 'join'
    }
    store.join(command)
    expect(() =>
      store.join({ ...command, member: { ...command.member, agentInstanceId: 'changed-agent' } })
    ).toThrow(/revision|idempotency|event conflict/i)
    events.close()
  })

  it('rejects non-canonical Graph wake routes', () => {
    const { events, store } = setup()
    const channel = store.createChannel({
      channel: { id: 'route-channel', name: 'Route', mode: 'queue', capacity: 1, members: [] },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    expect(() =>
      store.join({
        channelId: channel.id,
        expectedRevision: 0,
        member: {
          memberId: 'graph',
          graphTargetId: 'target',
          graphWakeRequest: {
            graphId: 'graph',
            route: { channel: ' Wake ', scopeType: ' DM ', scopeId: ' target ' },
            input: null
          },
          role: 'consumer',
          joinedAt: 2
        },
        joinedAt: 2,
        idempotencyKey: 'graph'
      })
    ).toThrow()
    events.close()
  })

  it('rejects Graph membership without a complete wake request', () => {
    const { events, store } = setup()
    const channel = store.createChannel({
      channel: { id: 'graph-channel', name: 'Graph', mode: 'queue', capacity: 1, members: [] },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    expect(() =>
      store.join({
        channelId: channel.id,
        expectedRevision: 0,
        member: { memberId: 'graph', graphTargetId: 'target', role: 'consumer', joinedAt: 2 },
        joinedAt: 2,
        idempotencyKey: 'graph'
      })
    ).toThrow(/graphWakeRequest/)
    events.close()
  })

  it('replays publish exactly and rejects changed idempotent input', () => {
    const { events, store } = setup()
    let channel = store.createChannel({
      channel: { id: 'replay', name: 'Replay', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    channel = store.join({
      channelId: channel.id,
      expectedRevision: 0,
      member: { memberId: 'producer', agentInstanceId: 'producer', role: 'producer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'join'
    })
    const command = {
      message: {
        id: 'message',
        channelId: channel.id,
        publisherMemberId: 'producer',
        payload: { text: 'same' },
        priority: 1,
        publishedAt: 3
      },
      expectedChannelRevision: 1,
      idempotencyKey: 'publish'
    }
    const published = store.publish(command)
    expect(store.publish(command)).toEqual(published)
    expect(() =>
      store.publish({ ...command, message: { ...command.message, priority: 2 } })
    ).toThrow(/idempotency|event conflict/i)
    events.close()
  })

  it('enforces point-to-point cardinality', () => {
    const { events, store } = setup()
    let channel = store.createChannel({
      channel: { id: 'p2p', name: 'Direct', mode: 'point-to-point', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    for (const memberId of ['one', 'two'])
      channel = store.join({
        channelId: channel.id,
        expectedRevision: channel.revision,
        member: {
          memberId,
          agentInstanceId: memberId,
          role: 'member',
          joinedAt: channel.revision + 2
        },
        joinedAt: channel.revision + 2,
        idempotencyKey: memberId
      })
    expect(() =>
      store.join({
        channelId: channel.id,
        expectedRevision: channel.revision,
        member: { memberId: 'three', agentInstanceId: 'three', role: 'member', joinedAt: 4 },
        joinedAt: 4,
        idempotencyKey: 'three'
      })
    ).toThrow(/exactly two/)
    events.close()
  })

  it('tracks broadcast acknowledgement independently per consumer', () => {
    const { events, store } = setup()
    let channel = store.createChannel({
      channel: { id: 'broadcast', name: 'Broadcast', mode: 'broadcast', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    for (const [memberId, role] of [
      ['producer', 'producer'],
      ['one', 'consumer'],
      ['two', 'consumer']
    ] as const)
      channel = store.join({
        channelId: channel.id,
        expectedRevision: channel.revision,
        member: { memberId, agentInstanceId: memberId, role, joinedAt: channel.revision + 2 },
        joinedAt: channel.revision + 2,
        idempotencyKey: memberId
      })
    const message = store.publish({
      message: {
        id: 'broadcast-message',
        channelId: channel.id,
        publisherMemberId: 'producer',
        payload: null,
        priority: 0,
        publishedAt: 5
      },
      expectedChannelRevision: channel.revision,
      idempotencyKey: 'publish'
    })
    expect(message.state.deliveries?.map((delivery) => delivery.consumerMemberId)).toEqual([
      'one',
      'two'
    ])
    const one = store.acknowledge({
      messageId: message.id,
      expectedRevision: 0,
      consumerMemberId: 'one',
      acknowledgedAt: 6,
      idempotencyKey: 'one'
    })
    expect(one.state.acknowledgedAt).toBeUndefined()
    const two = store.acknowledge({
      messageId: message.id,
      expectedRevision: 1,
      consumerMemberId: 'two',
      acknowledgedAt: 7,
      idempotencyKey: 'two'
    })
    expect(two.state.acknowledgedAt).toBe(7)
    events.close()
  })

  it('uses lease and token fencing for queue claims and permits expiry reclaim', () => {
    const { events, store } = setup()
    let channel = store.createChannel({
      channel: { id: 'queue', name: 'Queue', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    channel = store.join({
      channelId: channel.id,
      expectedRevision: 0,
      member: { memberId: 'producer', agentInstanceId: 'producer', role: 'producer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'producer'
    })
    channel = store.join({
      channelId: channel.id,
      expectedRevision: 1,
      member: { memberId: 'consumer', agentInstanceId: 'consumer', role: 'consumer', joinedAt: 3 },
      joinedAt: 3,
      idempotencyKey: 'consumer'
    })
    const message = store.publish({
      message: {
        id: 'queued',
        channelId: channel.id,
        publisherMemberId: 'producer',
        payload: null,
        priority: 0,
        publishedAt: 4
      },
      expectedChannelRevision: 2,
      idempotencyKey: 'publish'
    })
    const claim = store.claimQueue({
      messageId: message.id,
      expectedRevision: 0,
      consumerMemberId: 'consumer',
      token: 'one',
      claimedAt: 5,
      leaseMs: 10,
      idempotencyKey: 'one'
    })
    expect(store.listPending(channel.id, 6)).toEqual([])
    expect(() =>
      store.acknowledge({
        messageId: message.id,
        expectedRevision: claim.revision,
        consumerMemberId: 'consumer',
        token: 'wrong',
        acknowledgedAt: 7,
        idempotencyKey: 'wrong'
      })
    ).toThrow(/token mismatch/)
    const reclaimed = store.claimQueue({
      messageId: message.id,
      expectedRevision: claim.revision,
      consumerMemberId: 'consumer',
      token: 'two',
      claimedAt: 16,
      leaseMs: 10,
      idempotencyKey: 'two'
    })
    expect(
      store.acknowledge({
        messageId: message.id,
        expectedRevision: reclaimed.revision,
        consumerMemberId: 'consumer',
        token: 'two',
        acknowledgedAt: 17,
        idempotencyKey: 'ack'
      }).state.acknowledgedAt
    ).toBe(17)
    events.close()
  })

  it('persists membership, priority ordering, acknowledgement and expiry', () => {
    const { events, store } = setup()
    let channel = store.createChannel({
      channel: { id: 'channel-1', name: 'Work', mode: 'queue', capacity: 3, members: [] },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    channel = store.join({
      channelId: channel.id,
      expectedRevision: channel.revision,
      member: { memberId: 'producer', agentInstanceId: 'agent-1', role: 'producer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'producer'
    })
    channel = store.join({
      channelId: channel.id,
      expectedRevision: channel.revision,
      member: { memberId: 'consumer', agentInstanceId: 'agent-2', role: 'consumer', joinedAt: 3 },
      joinedAt: 3,
      idempotencyKey: 'consumer'
    })
    store.publish({
      message: {
        id: 'low',
        channelId: channel.id,
        publisherMemberId: 'producer',
        payload: { text: 'low' },
        priority: 1,
        publishedAt: 4
      },
      expectedChannelRevision: channel.revision,
      idempotencyKey: 'low'
    })
    store.publish({
      message: {
        id: 'high',
        channelId: channel.id,
        publisherMemberId: 'producer',
        payload: { text: 'high' },
        priority: 9,
        publishedAt: 5
      },
      expectedChannelRevision: channel.revision,
      idempotencyKey: 'high'
    })
    store.publish({
      message: {
        id: 'expired',
        channelId: channel.id,
        publisherMemberId: 'producer',
        payload: null,
        priority: 20,
        publishedAt: 5,
        expiresAt: 6
      },
      expectedChannelRevision: channel.revision,
      idempotencyKey: 'expired'
    })
    expect(store.listPending(channel.id, 7).map((message) => message.id)).toEqual(['high', 'low'])
    store.acknowledge({
      messageId: 'high',
      expectedRevision: 0,
      consumerMemberId: 'consumer',
      acknowledgedAt: 8,
      idempotencyKey: 'ack'
    })
    expect(store.listPending(channel.id, 9).map((message) => message.id)).toEqual(['low'])
    events.close()
  })

  it('enforces membership roles and capacity backpressure', () => {
    const { events, store } = setup()
    let channel = store.createChannel({
      channel: {
        id: 'channel-1',
        name: 'Direct',
        mode: 'point-to-point',
        capacity: 1,
        members: []
      },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    channel = store.join({
      channelId: channel.id,
      expectedRevision: 0,
      member: {
        memberId: 'producer',
        agentInstanceId: 'graph-owner',
        role: 'producer',
        joinedAt: 2
      },
      joinedAt: 2,
      idempotencyKey: 'join'
    })
    expect(() =>
      store.publish({
        message: {
          id: 'bad',
          channelId: channel.id,
          publisherMemberId: 'missing',
          payload: null,
          priority: 0,
          publishedAt: 3
        },
        expectedChannelRevision: channel.revision,
        idempotencyKey: 'bad'
      })
    ).toThrow(/authorized producer/)
    store.publish({
      message: {
        id: 'one',
        channelId: channel.id,
        publisherMemberId: 'producer',
        payload: null,
        priority: 0,
        publishedAt: 3
      },
      expectedChannelRevision: channel.revision,
      idempotencyKey: 'one'
    })
    expect(() =>
      store.publish({
        message: {
          id: 'two',
          channelId: channel.id,
          publisherMemberId: 'producer',
          payload: null,
          priority: 0,
          publishedAt: 4
        },
        expectedChannelRevision: channel.revision,
        idempotencyKey: 'two'
      })
    ).toThrow(/backpressure/)
    events.close()
  })
})
