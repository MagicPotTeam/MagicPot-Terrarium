import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import { PersistentRuntimeChannelStore } from './persistentRuntimeChannelStore'
import {
  createRuntimeChannelCreatePolicyRequest,
  createRuntimeChannelDeliveryPolicyRequest,
  createRuntimeChannelMembershipPolicyRequest,
  createRuntimeChannelPublishPolicyRequest,
  RuntimeChannelCommandService
} from './runtimeChannelCommandService'

const setup = (effect: 'deny' | 'require-approval') => {
  const events = new MagicAgentEventStore(':memory:')
  const store = new PersistentRuntimeChannelStore(events)
  let channel = store.createChannel({
    channel: { id: 'channel', name: 'Channel', mode: 'queue', capacity: 2, members: [] },
    createdAt: 1,
    idempotencyKey: 'create'
  })
  channel = store.join({
    channelId: channel.id,
    expectedRevision: channel.revision,
    member: { memberId: 'producer', agentInstanceId: 'agent-1', role: 'producer', joinedAt: 2 },
    joinedAt: 2,
    idempotencyKey: 'join'
  })
  const authorization = new MagicAgentPolicyAuthorizationService({
    store: events,
    policyVersion: 'm6',
    storeId: 'channel-test',
    trustedApprovers: [{ kind: 'user', id: 'approver' }],
    rules: [
      {
        ruleId: 'publish',
        priority: 1,
        effect,
        match: { actions: ['runtime-channel.publish'] },
        explanation: effect,
        ...(effect === 'require-approval'
          ? {
              approvalRequirement: {
                scopeKind: 'request',
                scopeValue: 'publish',
                maxUses: 1,
                expiresInMs: 1000,
                reason: 'publish'
              }
            }
          : {})
      }
    ]
  })
  return { events, store, authorization, channel }
}
const membershipSetup = (effect: 'deny' | 'require-approval') => {
  const events = new MagicAgentEventStore(':memory:')
  const store = new PersistentRuntimeChannelStore(events)
  const channel = store.createChannel({
    channel: { id: 'membership', name: 'Membership', mode: 'queue', capacity: 2, members: [] },
    createdAt: 1,
    idempotencyKey: 'create'
  })
  const authorization = new MagicAgentPolicyAuthorizationService({
    store: events,
    policyVersion: 'm6',
    storeId: 'membership-test',
    trustedApprovers: [{ kind: 'user', id: 'approver' }],
    rules: [
      {
        ruleId: 'delivery',
        priority: 2,
        effect: 'allow',
        match: { actions: ['runtime-channel.claim', 'runtime-channel.acknowledge'] },
        explanation: 'delivery'
      },
      {
        ruleId: 'membership',
        priority: 1,
        effect,
        match: { actions: ['runtime-channel.join', 'runtime-channel.leave'] },
        explanation: effect,
        ...(effect === 'require-approval'
          ? {
              approvalRequirement: {
                scopeKind: 'request',
                scopeValue: 'membership',
                maxUses: 1,
                expiresInMs: 1000,
                reason: 'membership'
              }
            }
          : {})
      }
    ]
  })
  return { events, store, authorization, channel }
}

const deliverySetup = (effect: 'deny' | 'require-approval') => {
  const events = new MagicAgentEventStore(':memory:')
  const store = new PersistentRuntimeChannelStore(events)
  let channel = store.createChannel({
    channel: { id: 'delivery', name: 'Delivery', mode: 'queue', capacity: 2, members: [] },
    createdAt: 1,
    idempotencyKey: 'create'
  })
  channel = store.join({
    channelId: channel.id,
    expectedRevision: channel.revision,
    member: { memberId: 'consumer', agentInstanceId: 'agent-1', role: 'consumer', joinedAt: 2 },
    joinedAt: 2,
    idempotencyKey: 'consumer'
  })
  channel = store.join({
    channelId: channel.id,
    expectedRevision: channel.revision,
    member: { memberId: 'producer', agentInstanceId: 'producer', role: 'producer', joinedAt: 3 },
    joinedAt: 3,
    idempotencyKey: 'producer'
  })
  const published = store.publish({
    message: {
      id: 'delivery-message',
      channelId: channel.id,
      publisherMemberId: 'producer',
      payload: null,
      priority: 0,
      publishedAt: 4
    },
    expectedChannelRevision: channel.revision,
    idempotencyKey: 'publish'
  })
  const authorization = new MagicAgentPolicyAuthorizationService({
    store: events,
    policyVersion: 'm6',
    storeId: 'delivery-test',
    trustedApprovers: [{ kind: 'user', id: 'approver' }],
    rules: [
      {
        ruleId: 'delivery',
        priority: 1,
        effect,
        match: { actions: ['runtime-channel.claim', 'runtime-channel.acknowledge'] },
        explanation: effect,
        ...(effect === 'require-approval'
          ? {
              approvalRequirement: {
                scopeKind: 'request',
                scopeValue: 'delivery',
                maxUses: 1,
                expiresInMs: 1000,
                reason: 'delivery'
              }
            }
          : {})
      }
    ]
  })
  return { events, store, authorization, published }
}

const message = {
  id: 'message',
  channelId: 'channel',
  publisherMemberId: 'producer',
  payload: { text: 'secret' },
  priority: 1,
  publishedAt: 10
}

describe('RuntimeChannelCommandService create', () => {
  const channel = {
    id: 'created-channel',
    name: 'Created Channel',
    mode: 'queue' as const,
    capacity: 5,
    members: [],
    createdAt: 1
  }

  it('denies creation with zero durable side effects', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new PersistentRuntimeChannelStore(eventStore)
    const authorization = new MagicAgentPolicyAuthorizationService({
      store: eventStore,
      storeId: 'deny-create',
      policyVersion: 'deny',
      trustedApprovers: [{ kind: 'user', id: 'approver' }],
      rules: [
        {
          ruleId: 'deny',
          priority: 1,
          effect: 'deny',
          match: { origins: ['internal'], actions: ['runtime-channel.create'] },
          explanation: 'deny'
        }
      ]
    })
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    expect(() =>
      service.create({
        actor: { kind: 'user', id: 'owner' },
        channel,
        createdAt: 1,
        idempotencyKey: 'create'
      })
    ).toThrow(/denied/)
    expect(store.getChannel(channel.id)).toBeUndefined()
    eventStore.close()
  })

  it('resumes approval and exact-replays without another authorization', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new PersistentRuntimeChannelStore(eventStore)
    const authorization = new MagicAgentPolicyAuthorizationService({
      store: eventStore,
      storeId: 'approval-create',
      policyVersion: 'approval',
      trustedApprovers: [{ kind: 'user', id: 'approver' }],
      rules: [
        {
          ruleId: 'approval',
          priority: 1,
          effect: 'require-approval',
          match: { origins: ['internal'], actions: ['runtime-channel.create'] },
          explanation: 'approval'
        }
      ]
    })
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    const actor = { kind: 'user', id: 'owner' } as const
    expect(() =>
      service.create({ actor, channel, createdAt: 1, idempotencyKey: 'create' })
    ).toThrow(/awaiting-approval/)
    const request = createRuntimeChannelCreatePolicyRequest({ actor, channel })
    const grant = authorization.createApprovalGrant({
      grantId: 'create-grant',
      request,
      approvedBy: { kind: 'user', id: 'approver' },
      issuedAt: 10,
      expiresAt: 100,
      maxUses: 1,
      idempotencyKey: 'create-grant'
    }).grant
    const created = service.create({
      actor,
      channel,
      createdAt: 1,
      idempotencyKey: 'create-resume',
      grantId: grant.grantId,
      expectedGrantUseCount: 0
    })
    expect(created.state.mode).toBe('queue')
    expect(
      service.create({
        actor,
        channel,
        createdAt: 1,
        idempotencyKey: 'create-resume',
        grantId: grant.grantId,
        expectedGrantUseCount: 0
      })
    ).toEqual(created)
    expect(() =>
      service.create({
        actor,
        channel: { ...channel, capacity: 6 },
        createdAt: 1,
        idempotencyKey: 'create-resume'
      })
    ).toThrow(/idempotency conflict/)
    eventStore.close()
  })
})

describe('RuntimeChannelCommandService', () => {
  it('delivery deny causes zero claim mutation', () => {
    const { events, store, authorization, published } = deliverySetup('deny')
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    expect(() =>
      service.claim({
        actor: { kind: 'agent', id: 'agent-1' },
        messageId: published.id,
        expectedRevision: published.revision,
        consumerMemberId: 'consumer',
        claimedAt: 10,
        leaseMs: 100,
        idempotencyKey: 'claim'
      })
    ).toThrow(/denied/)
    expect(store.getMessage(published.id)?.state.queueClaim).toBeUndefined()
    events.close()
  })

  it('delivery approval resumes claim and permit replay preserves the token', () => {
    const { events, store, authorization, published } = deliverySetup('require-approval')
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    const input = {
      actor: { kind: 'agent', id: 'agent-1' } as const,
      messageId: published.id,
      expectedRevision: published.revision,
      consumerMemberId: 'consumer',
      claimedAt: 10,
      leaseMs: 100,
      idempotencyKey: 'claim'
    }
    expect(() => service.claim(input)).toThrow(/awaiting-approval/)
    expect(store.getMessage(published.id)?.state.queueClaim).toBeUndefined()
    const request = createRuntimeChannelDeliveryPolicyRequest({
      actor: input.actor,
      action: 'claim',
      channelId: published.state.channelId,
      messageId: published.id,
      messageRevision: published.revision,
      consumerMemberId: input.consumerMemberId
    })
    const grant = authorization.createApprovalGrant({
      grantId: 'claim-grant',
      request,
      approvedBy: { kind: 'user', id: 'approver' },
      issuedAt: 10,
      expiresAt: 1000,
      maxUses: 1,
      idempotencyKey: 'grant'
    }).grant
    const claimed = service.claim({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })
    expect(claimed?.state.queueClaim?.token).toEqual(expect.any(String))
    expect(
      service.claim({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })?.state
        .queueClaim?.token
    ).toBe(claimed?.state.queueClaim?.token)
    events.close()
  })

  it('delivery deny causes zero ack mutation', () => {
    const { events, store, authorization, published } = deliverySetup('deny')
    const claimed = store.claimQueue({
      messageId: published.id,
      expectedRevision: published.revision,
      consumerMemberId: 'consumer',
      token: 'durable-token',
      claimedAt: 5,
      leaseMs: 100,
      idempotencyKey: 'seed-claim'
    })
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    expect(() =>
      service.acknowledge({
        actor: { kind: 'agent', id: 'agent-1' },
        messageId: claimed.id,
        expectedRevision: claimed.revision,
        consumerMemberId: 'consumer',
        acknowledgedAt: 10,
        token: 'durable-token',
        idempotencyKey: 'ack'
      })
    ).toThrow(/denied/)
    expect(store.getMessage(claimed.id)?.state.acknowledgedAt).toBeUndefined()
    events.close()
  })

  it('delivery approval resumes ack and permit replay remains acknowledged', () => {
    const { events, store, authorization, published } = deliverySetup('require-approval')
    const claimed = store.claimQueue({
      messageId: published.id,
      expectedRevision: published.revision,
      consumerMemberId: 'consumer',
      token: 'durable-token',
      claimedAt: 5,
      leaseMs: 100,
      idempotencyKey: 'seed-claim'
    })
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    const input = {
      actor: { kind: 'agent', id: 'agent-1' } as const,
      messageId: claimed.id,
      expectedRevision: claimed.revision,
      consumerMemberId: 'consumer',
      acknowledgedAt: 10,
      token: 'durable-token',
      idempotencyKey: 'ack'
    }
    expect(() => service.acknowledge(input)).toThrow(/awaiting-approval/)
    expect(store.getMessage(claimed.id)?.state.acknowledgedAt).toBeUndefined()
    const request = createRuntimeChannelDeliveryPolicyRequest({
      actor: input.actor,
      action: 'acknowledge',
      channelId: claimed.state.channelId,
      messageId: claimed.id,
      messageRevision: claimed.revision,
      consumerMemberId: input.consumerMemberId
    })
    const grant = authorization.createApprovalGrant({
      grantId: 'ack-grant',
      request,
      approvedBy: { kind: 'user', id: 'approver' },
      issuedAt: 10,
      expiresAt: 1000,
      maxUses: 1,
      idempotencyKey: 'ack-grant'
    }).grant
    const acknowledged = service.acknowledge({
      ...input,
      grantId: grant.grantId,
      expectedGrantUseCount: 0
    })
    expect(acknowledged?.state.acknowledgedAt).toBe(10)
    expect(
      service.acknowledge({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })?.state
        .acknowledgedAt
    ).toBe(10)
    events.close()
  })

  it('deny causes zero store and wakeup side effects', () => {
    const { events, store, authorization } = setup('deny')
    const wake = vi.fn()
    const service = new RuntimeChannelCommandService(store, authorization, () => 10, wake)
    expect(() =>
      service.publish({
        actor: { kind: 'user', id: 'user' },
        message,
        expectedChannelRevision: 1,
        idempotencyKey: 'publish'
      })
    ).toThrow(/denied/)
    expect(store.getMessage(message.id)).toBeUndefined()
    expect(wake).not.toHaveBeenCalled()
    events.close()
  })

  it('binds queue claim and ack to the actor-owned consumer membership', () => {
    const { events, store, authorization } = membershipSetup('deny')
    let channel = store.join({
      channelId: 'membership',
      expectedRevision: 0,
      member: { memberId: 'consumer', agentInstanceId: 'agent-1', role: 'consumer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'consumer'
    })
    channel = store.join({
      channelId: 'membership',
      expectedRevision: channel.revision,
      member: {
        memberId: 'producer',
        agentInstanceId: 'producer-1',
        role: 'producer',
        joinedAt: 3
      },
      joinedAt: 3,
      idempotencyKey: 'producer'
    })
    const published = store.publish({
      message: {
        id: 'claimed-message',
        channelId: channel.id,
        publisherMemberId: 'producer',
        payload: null,
        priority: 0,
        publishedAt: 4
      },
      expectedChannelRevision: channel.revision,
      idempotencyKey: 'publish'
    })
    const deliveryAuthorization = {
      authorize: vi.fn(() => ({ status: 'authorized', permit: { permitId: 'delivery-permit' } })),
      consumeExecutionPermit: vi.fn()
    }
    const service = new RuntimeChannelCommandService(
      store,
      deliveryAuthorization as never,
      () => 10
    )
    expect(() =>
      service.claim({
        actor: { kind: 'agent', id: 'other-agent' },
        messageId: published.id,
        expectedRevision: published.revision,
        consumerMemberId: 'consumer',
        claimedAt: 10,
        leaseMs: 100,
        idempotencyKey: 'claim-other'
      })
    ).toThrow(/own/)
    const claimed = service.claim({
      actor: { kind: 'agent', id: 'agent-1' },
      messageId: published.id,
      expectedRevision: published.revision,
      consumerMemberId: 'consumer',
      claimedAt: 10,
      leaseMs: 100,
      idempotencyKey: 'claim'
    })
    expect(claimed).toBeDefined()
    if (!claimed) throw new Error('Expected the queue message to be claimed.')
    expect(claimed.state.queueClaim?.token).toEqual(expect.any(String))
    expect(() =>
      service.acknowledge({
        actor: { kind: 'agent', id: 'agent-1' },
        messageId: claimed.id,
        expectedRevision: claimed.revision,
        consumerMemberId: 'consumer',
        acknowledgedAt: 11,
        token: 'wrong',
        idempotencyKey: 'ack-wrong'
      })
    ).toThrow(/token mismatch/)
    const acknowledged = service.acknowledge({
      actor: { kind: 'agent', id: 'agent-1' },
      messageId: claimed.id,
      expectedRevision: claimed.revision,
      consumerMemberId: 'consumer',
      acknowledgedAt: 11,
      token: claimed.state.queueClaim?.token,
      idempotencyKey: 'ack'
    })
    expect(acknowledged?.state.acknowledgedBy).toBe('consumer')
    events.close()
  })

  it('membership deny causes zero durable mutation', () => {
    const { events, store, authorization } = membershipSetup('deny')
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    expect(() =>
      service.join({
        actor: { kind: 'user', id: 'user' },
        channelId: 'membership',
        expectedRevision: 0,
        member: { memberId: 'consumer', agentInstanceId: 'agent', role: 'consumer', joinedAt: 10 },
        joinedAt: 10,
        idempotencyKey: 'join'
      })
    ).toThrow(/denied/)
    expect(store.getChannel('membership')?.state.members).toHaveLength(0)
    events.close()
  })

  it('membership approval resumes join and permit replay does not duplicate it', () => {
    const { events, store, authorization } = membershipSetup('require-approval')
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    const input = {
      actor: { kind: 'user', id: 'user' } as const,
      channelId: 'membership',
      expectedRevision: 0,
      member: {
        memberId: 'consumer',
        agentInstanceId: 'agent',
        role: 'consumer' as const,
        joinedAt: 10
      },
      joinedAt: 10,
      idempotencyKey: 'join'
    }
    expect(() => service.join(input)).toThrow(/awaiting-approval/)
    const request = createRuntimeChannelMembershipPolicyRequest({
      actor: input.actor,
      action: 'join',
      channelId: input.channelId,
      memberId: input.member.memberId,
      channelRevision: input.expectedRevision
    })
    const grant = authorization.createApprovalGrant({
      grantId: 'membership-grant',
      request,
      approvedBy: { kind: 'user', id: 'approver' },
      issuedAt: 10,
      expiresAt: 1000,
      maxUses: 1,
      idempotencyKey: 'grant'
    }).grant
    expect(
      service.join({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })?.state.members
    ).toHaveLength(1)
    expect(
      service.join({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })?.state.members
    ).toHaveLength(1)
    events.close()
  })

  it('membership approval resumes leave and replay remains removed', () => {
    const { events, store, authorization } = membershipSetup('require-approval')
    const joined = store.join({
      channelId: 'membership',
      expectedRevision: 0,
      member: { memberId: 'consumer', agentInstanceId: 'agent', role: 'consumer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'seed'
    })
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    const input = {
      actor: { kind: 'user', id: 'user' } as const,
      channelId: 'membership',
      expectedRevision: joined.revision,
      memberId: 'consumer',
      leftAt: 10,
      idempotencyKey: 'leave'
    }
    expect(() => service.leave(input)).toThrow(/awaiting-approval/)
    const request = createRuntimeChannelMembershipPolicyRequest({
      actor: input.actor,
      action: 'leave',
      channelId: input.channelId,
      memberId: input.memberId,
      channelRevision: input.expectedRevision
    })
    const grant = authorization.createApprovalGrant({
      grantId: 'leave-grant',
      request,
      approvedBy: { kind: 'user', id: 'approver' },
      issuedAt: 10,
      expiresAt: 1000,
      maxUses: 1,
      idempotencyKey: 'leave-grant'
    }).grant
    expect(
      service.leave({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })?.state.members
    ).toHaveLength(0)
    expect(
      service.leave({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })?.state.members
    ).toHaveLength(0)
    events.close()
  })

  it('rejects stale membership revision without store mutation after authorization', () => {
    const { events, store, authorization } = membershipSetup('require-approval')
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    const actor = { kind: 'user', id: 'user' } as const
    const request = createRuntimeChannelMembershipPolicyRequest({
      actor,
      action: 'join',
      channelId: 'membership',
      memberId: 'consumer',
      channelRevision: 1
    })
    const grant = authorization.createApprovalGrant({
      grantId: 'stale-grant',
      request,
      approvedBy: { kind: 'user', id: 'approver' },
      issuedAt: 10,
      expiresAt: 1000,
      maxUses: 1,
      idempotencyKey: 'stale-grant'
    }).grant
    expect(() =>
      service.join({
        actor,
        channelId: 'membership',
        expectedRevision: 1,
        member: { memberId: 'consumer', agentInstanceId: 'agent', role: 'consumer', joinedAt: 10 },
        joinedAt: 10,
        idempotencyKey: 'stale',
        grantId: grant.grantId,
        expectedGrantUseCount: 0
      })
    ).toThrow(/revision/i)
    expect(store.getChannel('membership')?.state.members).toHaveLength(0)
    events.close()
  })

  it('binds Agent publish to its own producer membership', () => {
    const { events, store, authorization, channel } = setup('require-approval')
    const service = new RuntimeChannelCommandService(store, authorization, () => 10)
    expect(() =>
      service.publish({
        actor: { kind: 'agent', id: 'other-agent' },
        message,
        expectedChannelRevision: channel.revision,
        idempotencyKey: 'owner-check'
      })
    ).toThrow(/own/)
    expect(store.getMessage(message.id)).toBeUndefined()
    events.close()
  })

  it('requires approval then consumes permit before publish and wakeup', () => {
    const { events, store, authorization } = setup('require-approval')
    const wake = vi.fn()
    const service = new RuntimeChannelCommandService(store, authorization, () => 10, wake)
    const input = {
      actor: { kind: 'user', id: 'user' } as const,
      message,
      expectedChannelRevision: 1,
      idempotencyKey: 'publish'
    }
    expect(() => service.publish(input)).toThrow(/awaiting-approval/)
    expect(store.getMessage(message.id)).toBeUndefined()
    const policyRequest = createRuntimeChannelPublishPolicyRequest({
      actor: input.actor,
      message,
      channelRevision: 1
    })
    const grant = authorization.createApprovalGrant({
      grantId: 'grant',
      request: policyRequest,
      approvedBy: { kind: 'user', id: 'approver' },
      issuedAt: 10,
      expiresAt: 1000,
      maxUses: 1,
      idempotencyKey: 'grant'
    }).grant
    expect(
      service.publish({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })?.id
    ).toBe(message.id)
    expect(wake).toHaveBeenCalledWith('channel')
    events.close()
  })
})
