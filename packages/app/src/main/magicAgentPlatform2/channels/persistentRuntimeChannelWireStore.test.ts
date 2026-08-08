import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentRuntimeChannelStore } from './persistentRuntimeChannelStore'
import { PersistentRuntimeChannelWireStore } from './persistentRuntimeChannelWireStore'

describe('PersistentRuntimeChannelWireStore', () => {
  it('rejects indirect wire cycles', () => {
    const events = new MagicAgentEventStore(':memory:')
    const channels = new PersistentRuntimeChannelStore(events)
    for (const id of ['a', 'b', 'c']) {
      const channel = channels.createChannel({
        channel: { id, name: id, mode: 'queue', capacity: 2, members: [] },
        createdAt: 1,
        idempotencyKey: id
      })
      channels.join({
        channelId: id,
        expectedRevision: channel.revision,
        member: { memberId: `${id}-publisher`, agentInstanceId: id, role: 'producer', joinedAt: 2 },
        joinedAt: 2,
        idempotencyKey: `${id}-publisher`
      })
    }
    const wires = new PersistentRuntimeChannelWireStore(events, channels)
    wires.wire({
      wire: {
        id: 'ab',
        sourceChannelId: 'a',
        targetChannelId: 'b',
        targetPublisherMemberId: 'b-publisher',
        enabled: true,
        createdAt: 3,
        maxHops: 4
      },
      idempotencyKey: 'ab'
    })
    wires.wire({
      wire: {
        id: 'bc',
        sourceChannelId: 'b',
        targetChannelId: 'c',
        targetPublisherMemberId: 'c-publisher',
        enabled: true,
        createdAt: 4,
        maxHops: 4
      },
      idempotencyKey: 'bc'
    })
    expect(() =>
      wires.wire({
        wire: {
          id: 'ca',
          sourceChannelId: 'c',
          targetChannelId: 'a',
          targetPublisherMemberId: 'a-publisher',
          enabled: true,
          createdAt: 5,
          maxHops: 4
        },
        idempotencyKey: 'ca'
      })
    ).toThrow(/cycle/)
    events.close()
  })

  it('persists wire/unwire and validates endpoints/publisher membership', () => {
    const events = new MagicAgentEventStore(':memory:')
    const channels = new PersistentRuntimeChannelStore(events)
    channels.createChannel({
      channel: { id: 'source', name: 'Source', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'source'
    })
    let target = channels.createChannel({
      channel: { id: 'target', name: 'Target', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'target'
    })
    target = channels.join({
      channelId: target.id,
      expectedRevision: 0,
      member: {
        memberId: 'wire-publisher',
        agentInstanceId: 'agent-1',
        role: 'producer',
        joinedAt: 2
      },
      joinedAt: 2,
      idempotencyKey: 'join'
    })
    const wires = new PersistentRuntimeChannelWireStore(events, channels)
    const wire = wires.wire({
      wire: {
        id: 'wire-1',
        sourceChannelId: 'source',
        targetChannelId: 'target',
        targetPublisherMemberId: 'wire-publisher',
        enabled: true,
        createdAt: 3,
        maxHops: 8
      },
      idempotencyKey: 'wire'
    })
    expect(wires.targets('source').map((item) => item.id)).toEqual(['wire-1'])
    expect(
      wires.unwire({ wireId: wire.id, expectedRevision: 0, removedAt: 4, idempotencyKey: 'unwire' })
        .state.enabled
    ).toBe(false)
    expect(wires.targets('source')).toEqual([])
    events.close()
  })
})
