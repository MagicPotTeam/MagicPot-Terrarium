import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalPolicyJson,
  digestPolicyRequest,
  POLICY_REQUEST_DISCRIMINATOR,
  POLICY_REQUEST_VERSION,
  type PolicyActorRef,
  type PolicyRequest
} from '../../../shared/magicAgentPlatform2/policy'
import type {
  RuntimeChannelMember,
  RuntimeChannelMessageState,
  RuntimeChannelState
} from '../../../shared/magicAgentPlatform2/runtimeChannel'
import { MagicAgentPolicyAuthorizationService, PermitConsumedError } from '../policy'
import { PersistentRuntimeChannelStore } from './persistentRuntimeChannelStore'

export const createRuntimeChannelPublishPolicyRequest = (input: {
  actor: PolicyActorRef
  message: RuntimeChannelMessageState
  channelRevision: number
}): PolicyRequest => {
  const request = {
    discriminator: POLICY_REQUEST_DISCRIMINATOR,
    version: POLICY_REQUEST_VERSION,
    requestId: 'runtime-channel:seed',
    actor: input.actor,
    origin: 'internal' as const,
    action: 'runtime-channel.publish',
    target: {
      kind: 'runtime-channel',
      id: input.message.channelId,
      source: 'dynamic-agent-fabric'
    },
    input: {
      channelId: input.message.channelId,
      messageId: input.message.id,
      publisherMemberId: input.message.publisherMemberId,
      priority: input.message.priority,
      channelRevision: input.channelRevision,
      payloadDigest: createHash('sha256')
        .update(canonicalPolicyJson(input.message.payload))
        .digest('hex')
    },
    effects: [
      {
        kind: 'external.message' as const,
        risk: 'high' as const,
        target: input.message.channelId,
        metadata: { messageId: input.message.id }
      }
    ]
  }
  return { ...request, requestId: `runtime-channel:${digestPolicyRequest(request)}` }
}

export const createRuntimeChannelCreatePolicyRequest = (input: {
  actor: PolicyActorRef
  channel: RuntimeChannelState
}): PolicyRequest => {
  const request = {
    discriminator: POLICY_REQUEST_DISCRIMINATOR,
    version: POLICY_REQUEST_VERSION,
    requestId: 'runtime-channel-create-request:seed',
    actor: input.actor,
    origin: 'internal' as const,
    action: 'runtime-channel.create',
    target: { kind: 'runtime-channel', id: input.channel.id, source: 'dynamic-agent-fabric' },
    input: {
      channelId: input.channel.id,
      mode: input.channel.mode,
      capacity: input.channel.capacity
    },
    effects: [
      {
        kind: 'external.message',
        risk: 'high',
        target: input.channel.id,
        metadata: { action: 'runtime-channel.create' }
      }
    ]
  }
  return { ...request, requestId: `runtime-channel-create-request:${digestPolicyRequest(request)}` }
}

export const createRuntimeChannelMembershipPolicyRequest = (input: {
  actor: PolicyActorRef
  action: 'join' | 'leave'
  channelId: string
  memberId: string
  channelRevision: number
}): PolicyRequest => {
  const request = {
    discriminator: POLICY_REQUEST_DISCRIMINATOR,
    version: POLICY_REQUEST_VERSION,
    requestId: 'runtime-channel-membership:seed',
    actor: input.actor,
    origin: 'internal' as const,
    action: `runtime-channel.${input.action}`,
    target: { kind: 'runtime-channel', id: input.channelId, source: 'dynamic-agent-fabric' },
    input: {
      channelId: input.channelId,
      memberId: input.memberId,
      channelRevision: input.channelRevision
    },
    effects: [
      {
        kind: 'external.message' as const,
        risk: 'high' as const,
        target: input.channelId,
        metadata: { membershipAction: input.action, memberId: input.memberId }
      }
    ]
  }
  return { ...request, requestId: `runtime-channel-membership:${digestPolicyRequest(request)}` }
}

export const createRuntimeChannelDeliveryPolicyRequest = (input: {
  actor: PolicyActorRef
  action: 'claim' | 'acknowledge'
  channelId: string
  messageId: string
  messageRevision: number
  consumerMemberId: string
}): PolicyRequest => {
  const request = {
    discriminator: POLICY_REQUEST_DISCRIMINATOR,
    version: POLICY_REQUEST_VERSION,
    requestId: 'runtime-channel-delivery:seed',
    actor: input.actor,
    origin: 'internal' as const,
    action: `runtime-channel.${input.action}`,
    target: {
      kind: 'runtime-channel-message',
      id: input.messageId,
      source: 'dynamic-agent-fabric'
    },
    input: {
      channelId: input.channelId,
      messageId: input.messageId,
      messageRevision: input.messageRevision,
      consumerMemberId: input.consumerMemberId
    },
    effects: [
      {
        kind: 'database.write' as const,
        risk: 'medium' as const,
        target: input.channelId,
        metadata: {
          deliveryAction: input.action,
          messageId: input.messageId,
          consumerMemberId: input.consumerMemberId
        }
      }
    ]
  }
  return { ...request, requestId: `runtime-channel-delivery:${digestPolicyRequest(request)}` }
}

export class RuntimeChannelCommandService {
  constructor(
    private readonly store: PersistentRuntimeChannelStore,
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    private readonly now: () => number = Date.now,
    private readonly wake?: (channelId: string) => void
  ) {}

  create(input: {
    actor: PolicyActorRef
    channel: RuntimeChannelState
    createdAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const replay = this.store.getCreateReplay({
      channel: input.channel,
      createdAt: input.createdAt,
      idempotencyKey: input.idempotencyKey
    })
    if (replay) return replay
    const existing = this.store.getChannel(input.channel.id)
    if (existing) throw new Error('Runtime Channel already exists with different create input.')
    const request = createRuntimeChannelCreatePolicyRequest(input)
    const authorized = this.authorization.authorize({
      authorizationId: `runtime-channel-create-authorization:${digestPolicyRequest(request)}`,
      request,
      evaluatedAt: this.now(),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount !== undefined
        ? { expectedGrantUseCount: input.expectedGrantUseCount }
        : {}),
      idempotencyKey: `runtime-channel:create:authorize:${input.idempotencyKey}`
    })
    if (authorized.status !== 'authorized')
      throw new Error(`Runtime Channel create ${authorized.status}.`)
    this.authorization.consumeExecutionPermit({
      permit: authorized.permit,
      request,
      consumedAt: this.now(),
      idempotencyKey: `runtime-channel:create:consume:${input.idempotencyKey}`
    })
    return this.store.createChannel({
      channel: input.channel,
      createdAt: input.createdAt,
      idempotencyKey: input.idempotencyKey
    })
  }

  join(input: {
    actor: PolicyActorRef
    channelId: string
    expectedRevision: number
    member: RuntimeChannelMember
    joinedAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const request = createRuntimeChannelMembershipPolicyRequest({
      actor: input.actor,
      action: 'join',
      channelId: input.channelId,
      memberId: input.member.memberId,
      channelRevision: input.expectedRevision
    })
    if (!this.authorizeMutation(request, input, 'membership'))
      return this.store.getChannel(input.channelId)
    return this.store.join(input)
  }

  leave(input: {
    actor: PolicyActorRef
    channelId: string
    expectedRevision: number
    memberId: string
    leftAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const request = createRuntimeChannelMembershipPolicyRequest({
      actor: input.actor,
      action: 'leave',
      channelId: input.channelId,
      memberId: input.memberId,
      channelRevision: input.expectedRevision
    })
    if (!this.authorizeMutation(request, input, 'membership'))
      return this.store.getChannel(input.channelId)
    return this.store.leave(input)
  }

  private authorizeMutation(
    request: PolicyRequest,
    input: { idempotencyKey: string; grantId?: string; expectedGrantUseCount?: number },
    prefix: string
  ): boolean {
    const authorization = this.authorization.authorize({
      authorizationId: `runtime-channel-authorization:${digestPolicyRequest(request)}`,
      request,
      evaluatedAt: this.now(),
      idempotencyKey: `channel:${prefix}:authorize:${input.idempotencyKey}`,
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount === undefined
        ? {}
        : { expectedGrantUseCount: input.expectedGrantUseCount })
    })
    if (authorization.status === 'already-consumed') return false
    if (authorization.status !== 'authorized')
      throw new Error(`Runtime Channel ${prefix} ${authorization.status}.`)
    try {
      this.authorization.consumeExecutionPermit({
        permit: authorization.permit,
        request,
        consumedAt: this.now(),
        idempotencyKey: `channel:${prefix}:consume:${input.idempotencyKey}`
      })
    } catch (error) {
      if (error instanceof PermitConsumedError) return false
      throw error
    }
    return true
  }

  private requireActorMembership(actor: PolicyActorRef, channelId: string, memberId: string) {
    const channel = this.store.getChannel(channelId)
    if (!channel) throw new Error('Channel not found.')
    const member = channel.state.members.find((candidate) => candidate.memberId === memberId)
    if (!member || member.role === 'producer')
      throw new Error('Channel consumer is not authorized.')
    const ownsAgent = member.agentInstanceId === actor.id && actor.kind === 'agent'
    const ownsGraph = member.graphTargetId === actor.id && actor.kind === 'graph'
    if (!ownsAgent && !ownsGraph)
      throw new Error('Channel actor does not own the consumer membership.')
    return member
  }

  claim(input: {
    actor: PolicyActorRef
    messageId: string
    expectedRevision: number
    consumerMemberId: string
    claimedAt: number
    leaseMs: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const message = this.store.getMessage(input.messageId)
    if (!message) throw new Error('Channel message not found.')
    this.requireActorMembership(input.actor, message.state.channelId, input.consumerMemberId)
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0)
      throw new Error('Channel claim lease must be positive.')
    const request = createRuntimeChannelDeliveryPolicyRequest({
      actor: input.actor,
      action: 'claim',
      channelId: message.state.channelId,
      messageId: message.id,
      messageRevision: input.expectedRevision,
      consumerMemberId: input.consumerMemberId
    })
    if (!this.authorizeMutation(request, input, 'claim'))
      return this.store.getMessage(input.messageId)
    return this.store.claimQueue({ ...input, token: randomUUID() })
  }

  acknowledge(input: {
    actor: PolicyActorRef
    messageId: string
    expectedRevision: number
    consumerMemberId: string
    acknowledgedAt: number
    idempotencyKey: string
    token?: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const message = this.store.getMessage(input.messageId)
    if (!message) throw new Error('Channel message not found.')
    this.requireActorMembership(input.actor, message.state.channelId, input.consumerMemberId)
    const request = createRuntimeChannelDeliveryPolicyRequest({
      actor: input.actor,
      action: 'acknowledge',
      channelId: message.state.channelId,
      messageId: message.id,
      messageRevision: input.expectedRevision,
      consumerMemberId: input.consumerMemberId
    })
    if (!this.authorizeMutation(request, input, 'acknowledge'))
      return this.store.getMessage(input.messageId)
    return this.store.acknowledge(input)
  }

  publish(input: {
    actor: PolicyActorRef
    message: RuntimeChannelMessageState
    expectedChannelRevision: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const channel = this.store.getChannel(input.message.channelId)
    if (!channel) throw new Error('Runtime Channel not found.')
    const publisher = channel.state.members.find(
      (member) => member.memberId === input.message.publisherMemberId
    )
    if (!publisher || publisher.role !== 'producer')
      throw new Error('Runtime Channel publisher member is invalid.')
    if (input.actor.kind === 'agent' && publisher.agentInstanceId !== input.actor.id)
      throw new Error('Agent may only publish through its own Runtime Channel member.')
    if (input.actor.kind !== 'agent' && input.actor.kind !== 'user')
      throw new Error('Runtime Channel publish actor must be an Agent or user.')
    const request = createRuntimeChannelPublishPolicyRequest({
      actor: input.actor,
      message: input.message,
      channelRevision: input.expectedChannelRevision
    })
    const authorization = this.authorization.authorize({
      authorizationId: `runtime-channel-authorization:${digestPolicyRequest(request)}`,
      request,
      evaluatedAt: this.now(),
      idempotencyKey: `channel:publish:authorize:${input.idempotencyKey}`,
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount === undefined
        ? {}
        : { expectedGrantUseCount: input.expectedGrantUseCount })
    })
    if (authorization.status !== 'authorized')
      throw new Error(`Runtime Channel publish ${authorization.status}.`)
    try {
      this.authorization.consumeExecutionPermit({
        permit: authorization.permit,
        request,
        consumedAt: this.now(),
        idempotencyKey: `channel:publish:consume:${input.idempotencyKey}`
      })
    } catch (error) {
      if (error instanceof PermitConsumedError) return this.store.getMessage(input.message.id)
      throw error
    }
    const published = this.store.publish({
      message: input.message,
      expectedChannelRevision: input.expectedChannelRevision,
      idempotencyKey: input.idempotencyKey
    })
    this.wake?.(input.message.channelId)
    return published
  }
}
