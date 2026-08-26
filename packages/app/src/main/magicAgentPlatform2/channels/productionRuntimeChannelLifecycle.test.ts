import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { ProductionRuntimeChannelLifecycle } from './productionRuntimeChannelLifecycle'

const createAllowAuthorization = () =>
  ({
    authorize: vi.fn(() => ({ status: 'authorized', permit: { token: 'permit' } })),
    consumeExecutionPermit: vi.fn()
  }) as never

describe('ProductionRuntimeChannelLifecycle', () => {
  it('recovers target-published forwarding whose outcome was not committed', () => {
    const events = new MagicAgentEventStore(':memory:')
    const lifecycle = new ProductionRuntimeChannelLifecycle({
      eventStore: events,
      authorization: { authorize: vi.fn(), consumeExecutionPermit: vi.fn() } as never,
      now: () => 20
    })
    let source = lifecycle.store.createChannel({
      channel: { id: 'sr', name: 'S', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 's'
    })
    source = lifecycle.store.join({
      channelId: source.id,
      expectedRevision: 0,
      member: { memberId: 'sp', agentInstanceId: 'sp', role: 'producer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'sp'
    })
    let target = lifecycle.store.createChannel({
      channel: { id: 'tr', name: 'T', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 't'
    })
    target = lifecycle.store.join({
      channelId: target.id,
      expectedRevision: 0,
      member: { memberId: 'tp', agentInstanceId: 'tp', role: 'producer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'tp'
    })
    const wire = lifecycle.wires.wire({
      wire: {
        id: 'rw',
        sourceChannelId: source.id,
        targetChannelId: target.id,
        targetPublisherMemberId: 'tp',
        enabled: true,
        createdAt: 3,
        maxHops: 4
      },
      idempotencyKey: 'w'
    })
    const sourceMessage = lifecycle.store.publish({
      message: {
        id: 'rs',
        channelId: source.id,
        publisherMemberId: 'sp',
        payload: null,
        priority: 0,
        publishedAt: 4
      },
      expectedChannelRevision: source.revision,
      idempotencyKey: 's'
    })
    const attempt = lifecycle.forwarding.ensure({
      state: {
        id: `${wire.id}:${sourceMessage.id}`,
        wireId: wire.id,
        sourceMessageId: sourceMessage.id,
        targetMessageId: `wire:${wire.id}:${sourceMessage.id}`,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: 20
      },
      createdAt: 20,
      idempotencyKey: 'a'
    })
    lifecycle.store.publish({
      message: {
        ...sourceMessage.state,
        id: attempt.state.targetMessageId,
        channelId: target.id,
        publisherMemberId: 'tp',
        publishedAt: attempt.createdAt,
        wirePath: [wire.id]
      },
      expectedChannelRevision: target.revision,
      idempotencyKey: `wire-forward:${wire.id}:${sourceMessage.id}`
    })
    expect(lifecycle.retryForwarding(20)).toBe(1)
    expect(lifecycle.forwarding.get(attempt.id)?.state.status).toBe('succeeded')
    expect(lifecycle.store.listPending(target.id, 21)).toHaveLength(1)
    events.close()
  })

  it('polls due forwarding retries and stops polling on close', () => {
    vi.useFakeTimers()
    const events = new MagicAgentEventStore(':memory:')
    const lifecycle = new ProductionRuntimeChannelLifecycle({
      eventStore: events,
      authorization: { authorize: vi.fn(), consumeExecutionPermit: vi.fn() } as never,
      now: () => 100,
      pollIntervalMs: 50
    })
    const retry = vi.spyOn(lifecycle, 'retryForwarding')
    lifecycle.start()
    expect(retry).toHaveBeenCalledWith(100)
    retry.mockClear()
    vi.advanceTimersByTime(50)
    expect(retry).toHaveBeenCalledWith(100)
    lifecycle.close()
    retry.mockClear()
    vi.advanceTimersByTime(100)
    expect(retry).not.toHaveBeenCalled()
    vi.useRealTimers()
    events.close()
  })

  it('continues forwarding across multiple hops', () => {
    const events = new MagicAgentEventStore(':memory:')
    const authorization = createAllowAuthorization()
    const lifecycle = new ProductionRuntimeChannelLifecycle({
      eventStore: events,
      authorization,
      now: () => 20
    })
    for (const id of ['a', 'b', 'c']) {
      const channel = lifecycle.store.createChannel({
        channel: { id, name: id, mode: 'queue', capacity: 3, members: [] },
        createdAt: 1,
        idempotencyKey: id
      })
      lifecycle.store.join({
        channelId: id,
        expectedRevision: channel.revision,
        member: { memberId: `${id}p`, agentInstanceId: id, role: 'producer', joinedAt: 2 },
        joinedAt: 2,
        idempotencyKey: `${id}p`
      })
    }
    lifecycle.wires.wire({
      wire: {
        id: 'ab',
        sourceChannelId: 'a',
        targetChannelId: 'b',
        targetPublisherMemberId: 'bp',
        enabled: true,
        createdAt: 3,
        maxHops: 4
      },
      idempotencyKey: 'ab'
    })
    lifecycle.wires.wire({
      wire: {
        id: 'bc',
        sourceChannelId: 'b',
        targetChannelId: 'c',
        targetPublisherMemberId: 'cp',
        enabled: true,
        createdAt: 3,
        maxHops: 4
      },
      idempotencyKey: 'bc'
    })
    lifecycle.commands.publish({
      actor: { kind: 'user', id: 'u' },
      message: {
        id: 'origin',
        channelId: 'a',
        publisherMemberId: 'ap',
        payload: null,
        priority: 0,
        publishedAt: 4
      },
      expectedChannelRevision: 1,
      idempotencyKey: 'origin'
    })
    expect(lifecycle.store.getMessage('wire:bc:wire:ab:origin')?.state.wirePath).toEqual([
      'ab',
      'bc'
    ])
    events.close()
  })

  it('persists target backpressure failure and retries after capacity recovers', () => {
    const events = new MagicAgentEventStore(':memory:')
    const authorization = createAllowAuthorization()
    let now = 10
    const lifecycle = new ProductionRuntimeChannelLifecycle({
      eventStore: events,
      authorization,
      now: () => now
    })
    let source = lifecycle.store.createChannel({
      channel: { id: 's', name: 'S', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 's'
    })
    source = lifecycle.store.join({
      channelId: 's',
      expectedRevision: 0,
      member: { memberId: 'sp', agentInstanceId: 'sp', role: 'producer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'sp'
    })
    let target = lifecycle.store.createChannel({
      channel: { id: 't', name: 'T', mode: 'queue', capacity: 1, members: [] },
      createdAt: 1,
      idempotencyKey: 't'
    })
    target = lifecycle.store.join({
      channelId: 't',
      expectedRevision: 0,
      member: { memberId: 'tp', agentInstanceId: 'tp', role: 'producer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'tp'
    })
    target = lifecycle.store.join({
      channelId: 't',
      expectedRevision: 1,
      member: { memberId: 'tc', agentInstanceId: 'tc', role: 'consumer', joinedAt: 3 },
      joinedAt: 3,
      idempotencyKey: 'tc'
    })
    lifecycle.store.publish({
      message: {
        id: 'blocker',
        channelId: 't',
        publisherMemberId: 'tp',
        payload: null,
        priority: 0,
        publishedAt: 4
      },
      expectedChannelRevision: target.revision,
      idempotencyKey: 'blocker'
    })
    lifecycle.wires.wire({
      wire: {
        id: 'w',
        sourceChannelId: 's',
        targetChannelId: 't',
        targetPublisherMemberId: 'tp',
        enabled: true,
        createdAt: 5,
        maxHops: 4
      },
      idempotencyKey: 'w'
    })
    lifecycle.commands.publish({
      actor: { kind: 'user', id: 'u' },
      message: {
        id: 'source',
        channelId: 's',
        publisherMemberId: 'sp',
        payload: null,
        priority: 0,
        publishedAt: 6
      },
      expectedChannelRevision: source.revision,
      idempotencyKey: 'source'
    })
    const failed = lifecycle.forwarding.get('w:source')!
    expect(failed.state).toMatchObject({ status: 'failed', attemptCount: 1 })
    lifecycle.store.acknowledge({
      messageId: 'blocker',
      expectedRevision: 0,
      consumerMemberId: 'tc',
      acknowledgedAt: 7,
      idempotencyKey: 'ack'
    })
    now = failed.state.nextAttemptAt
    expect(lifecycle.retryForwarding(now)).toBe(1)
    expect(lifecycle.forwarding.get('w:source')?.state.status).toBe('succeeded')
    expect(lifecycle.store.getMessage('wire:w:source')).toBeDefined()
    events.close()
  })

  it('forwards a committed message across a durable wire and emits target wakeup', () => {
    const events = new MagicAgentEventStore(':memory:')
    const authorization = createAllowAuthorization()
    const lifecycle = new ProductionRuntimeChannelLifecycle({
      eventStore: events,
      authorization,
      now: () => 20
    })
    let source = lifecycle.store.createChannel({
      channel: { id: 'source', name: 'Source', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'source'
    })
    source = lifecycle.store.join({
      channelId: source.id,
      expectedRevision: 0,
      member: {
        memberId: 'source-publisher',
        agentInstanceId: 'source-agent',
        role: 'producer',
        joinedAt: 2
      },
      joinedAt: 2,
      idempotencyKey: 'source-member'
    })
    let target = lifecycle.store.createChannel({
      channel: { id: 'target', name: 'Target', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'target'
    })
    target = lifecycle.store.join({
      channelId: target.id,
      expectedRevision: 0,
      member: {
        memberId: 'target-publisher',
        agentInstanceId: 'target-agent',
        role: 'producer',
        joinedAt: 2
      },
      joinedAt: 2,
      idempotencyKey: 'target-member'
    })
    lifecycle.wires.wire({
      wire: {
        id: 'wire',
        sourceChannelId: source.id,
        targetChannelId: target.id,
        targetPublisherMemberId: 'target-publisher',
        enabled: true,
        createdAt: 3,
        maxHops: 4
      },
      idempotencyKey: 'wire'
    })
    const wake = vi.fn()
    lifecycle.subscribeWake(wake)
    lifecycle.commands.publish({
      actor: { kind: 'user', id: 'user' },
      message: {
        id: 'source-message',
        channelId: source.id,
        publisherMemberId: 'source-publisher',
        payload: { text: 'forward' },
        priority: 3,
        publishedAt: 4
      },
      expectedChannelRevision: source.revision,
      idempotencyKey: 'publish'
    })
    const forwarded = lifecycle.store.getMessage('wire:wire:source-message')
    expect(forwarded?.state).toMatchObject({
      channelId: 'target',
      publisherMemberId: 'target-publisher',
      wirePath: ['wire']
    })
    expect(wake).toHaveBeenCalledWith({
      channelId: 'target',
      pendingMessageIds: ['wire:wire:source-message']
    })
    events.close()
  })

  it('emits wakeups after publish and re-emits pending work on recovery', () => {
    const events = new MagicAgentEventStore(':memory:')
    const authorization = createAllowAuthorization()
    let now = 10
    const lifecycle = new ProductionRuntimeChannelLifecycle({
      eventStore: events,
      authorization,
      now: () => now
    })
    let channel = lifecycle.store.createChannel({
      channel: { id: 'channel', name: 'Channel', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    channel = lifecycle.store.join({
      channelId: channel.id,
      expectedRevision: 0,
      member: { memberId: 'producer', agentInstanceId: 'agent-1', role: 'producer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'join'
    })
    const wake = vi.fn()
    lifecycle.subscribeWake(wake)
    lifecycle.commands.publish({
      actor: { kind: 'user', id: 'user' },
      message: {
        id: 'message',
        channelId: channel.id,
        publisherMemberId: 'producer',
        payload: null,
        priority: 0,
        publishedAt: 3
      },
      expectedChannelRevision: 1,
      idempotencyKey: 'publish'
    })
    expect(wake).toHaveBeenCalledWith({ channelId: 'channel', pendingMessageIds: ['message'] })
    wake.mockClear()
    now = 20
    expect(lifecycle.recoverWakeups()).toEqual([
      { channelId: 'channel', pendingMessageIds: ['message'] }
    ])
    expect(wake).toHaveBeenCalledOnce()
    lifecycle.close()
    events.close()
  })
})
