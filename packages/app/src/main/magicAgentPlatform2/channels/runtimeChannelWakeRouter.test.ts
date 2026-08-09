import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentRuntimeChannelStore } from './persistentRuntimeChannelStore'
import { RuntimeChannelWakeRouter } from './runtimeChannelWakeRouter'

describe('RuntimeChannelWakeRouter', () => {
  it('routes consumer memberships to Agent and Graph wake adapters', async () => {
    const events = new MagicAgentEventStore(':memory:')
    const channels = new PersistentRuntimeChannelStore(events)
    let channel = channels.createChannel({
      channel: { id: 'channel', name: 'C', mode: 'broadcast', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'c'
    })
    channel = channels.join({
      channelId: channel.id,
      expectedRevision: channel.revision,
      member: {
        memberId: 'agent-member',
        agentInstanceId: 'agent-instance',
        role: 'consumer',
        joinedAt: 2
      },
      joinedAt: 2,
      idempotencyKey: 'a'
    })
    channel = channels.join({
      channelId: channel.id,
      expectedRevision: channel.revision,
      member: {
        memberId: 'graph-member',
        graphTargetId: 'graph-target',
        graphWakeRequest: {
          graphId: 'graph-definition',
          route: { channel: 'wake', scopeType: 'dm', scopeId: 'graph-target' },
          input: { source: 'channel' }
        },
        role: 'consumer',
        joinedAt: 3
      },
      joinedAt: 3,
      idempotencyKey: 'g'
    })
    channel = channels.join({
      channelId: channel.id,
      expectedRevision: channel.revision,
      member: {
        memberId: 'producer',
        agentInstanceId: 'producer-agent',
        role: 'producer',
        joinedAt: 4
      },
      joinedAt: 4,
      idempotencyKey: 'p'
    })
    const agent = vi.fn()
    const graph = vi.fn()
    const router = new RuntimeChannelWakeRouter(channels, agent, graph)
    await router.route({ channelId: channel.id, pendingMessageIds: ['message'] })
    expect(agent).toHaveBeenCalledWith({
      channelId: 'channel',
      agentInstanceId: 'agent-instance',
      memberId: 'agent-member',
      pendingMessageIds: ['message']
    })
    expect(graph).toHaveBeenCalledWith({
      channelId: 'channel',
      graphTargetId: 'graph-target',
      memberId: 'graph-member',
      graphWakeRequest: {
        graphId: 'graph-definition',
        route: { channel: 'wake', scopeType: 'dm', scopeId: 'graph-target' },
        input: { source: 'channel' }
      },
      pendingMessageIds: ['message']
    })
    expect(agent).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentInstanceId: 'producer-agent' })
    )
    events.close()
  })
})
