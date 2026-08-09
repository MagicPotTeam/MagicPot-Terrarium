import { normalizeAgentRoute } from '../../../shared/agent'
import { canonicalPolicyJson, sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import type {
  RuntimeChannelMessageState,
  RuntimeChannelState
} from '../../../shared/magicAgentPlatform2/runtimeChannel'
import type { MagicAgentEventStore, StoredResource } from '../persistence/eventStore'

const CHANNEL = 'runtime-channel' as const
const MESSAGE = 'runtime-channel-message' as const
const event = (
  kind: typeof CHANNEL | typeof MESSAGE,
  id: string,
  type: string,
  at: number,
  revision: number,
  payload: Record<string, unknown>
) => ({
  protocolVersion: '2.0.0',
  id: `${kind}:${id}:${type}:${at}:${revision}`,
  type,
  createdAt: at,
  payload,
  envelopeKind: 'event' as const,
  streamId: `${kind}:${id}:stream`,
  sequence: revision,
  resource: { kind, id },
  revision
})
const text = (value: string, field: string) => {
  if (!value.trim() || value !== value.trim())
    throw new Error(`${field} must be trimmed and non-empty.`)
}
const integer = (value: number, field: string) => {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer.`)
}

export class PersistentRuntimeChannelStore {
  constructor(private readonly events: MagicAgentEventStore) {}

  listChannels() {
    return this.events.listResources({
      kind: CHANNEL,
      limit: 1_000
    }) as readonly StoredResource<RuntimeChannelState>[]
  }
  getChannel(id: string) {
    return this.events.getResource(CHANNEL, id) as StoredResource<RuntimeChannelState> | undefined
  }
  getMessage(id: string) {
    return this.events.getResource(MESSAGE, id) as
      | StoredResource<RuntimeChannelMessageState>
      | undefined
  }

  getCreateReplay(input: {
    channel: RuntimeChannelState
    createdAt: number
    idempotencyKey: string
  }) {
    const key = `channel:${input.channel.id}:create:${input.idempotencyKey}`
    const replay = this.events
      .listResourceMutations(CHANNEL, input.channel.id, 1_000)
      .find((item) => item.idempotencyKey === key)
    if (!replay) return undefined
    const committed = this.events.getEvent(replay.eventId)
    const digest = sha256PolicyText(canonicalPolicyJson(input.channel as never))
    if (
      committed?.type !== 'runtime-channel.created' ||
      committed.createdAt !== input.createdAt ||
      sha256PolicyText(
        canonicalPolicyJson((replay.resource as StoredResource<RuntimeChannelState>).state as never)
      ) !== digest
    )
      throw new Error('Runtime Channel create idempotency conflict.')
    return replay.resource as StoredResource<RuntimeChannelState>
  }

  createChannel(input: {
    channel: RuntimeChannelState
    createdAt: number
    idempotencyKey: string
  }) {
    text(input.channel.id, 'Channel id')
    text(input.channel.name, 'Channel name')
    integer(input.channel.capacity, 'Channel capacity')
    if (input.channel.capacity < 1) throw new Error('Channel capacity must be positive.')
    if (input.channel.members.length) throw new Error('New Channel membership must be empty.')
    return this.events.mutateResource<RuntimeChannelState>({
      operation: 'create',
      kind: CHANNEL,
      id: input.channel.id,
      state: input.channel,
      createdAt: input.createdAt,
      idempotencyKey: `channel:${input.channel.id}:create:${input.idempotencyKey}`,
      event: event(CHANNEL, input.channel.id, 'runtime-channel.created', input.createdAt, 0, {
        mode: input.channel.mode,
        capacity: input.channel.capacity
      })
    }).resource
  }

  join(input: {
    channelId: string
    expectedRevision: number
    member: RuntimeChannelState['members'][number]
    joinedAt: number
    idempotencyKey: string
  }) {
    const channel = this.requireChannel(input.channelId, input.expectedRevision)
    text(input.member.memberId, 'Member id')
    if (!input.member.agentInstanceId && !input.member.graphTargetId)
      throw new Error('Channel member requires an Agent instance or Graph target identity.')
    if (input.member.graphTargetId && !input.member.graphWakeRequest)
      throw new Error('Graph Channel member requires graphWakeRequest.')
    if (input.member.graphWakeRequest) {
      const wake = input.member.graphWakeRequest
      text(wake.graphId, 'Graph wake graph id')
      text(wake.route.channel, 'Graph wake route channel')
      text(wake.route.scopeType, 'Graph wake route scope type')
      text(wake.route.scopeId, 'Graph wake route scope id')
      const normalized = normalizeAgentRoute(wake.route)
      if (
        normalized.channel !== wake.route.channel ||
        normalized.scopeType !== wake.route.scopeType ||
        normalized.scopeId !== wake.route.scopeId
      )
        throw new Error('Graph wake route must already be canonical.')
    }
    if (channel.state.mode === 'point-to-point' && channel.state.members.length >= 2)
      throw new Error('Point-to-point Channel supports exactly two members.')
    if (channel.state.members.some((member) => member.memberId === input.member.memberId))
      throw new Error('Channel member already exists.')
    return this.updateChannel(
      channel,
      [...channel.state.members, input.member],
      input.joinedAt,
      input.idempotencyKey,
      'runtime-channel.member-joined',
      { memberId: input.member.memberId }
    )
  }

  leave(input: {
    channelId: string
    expectedRevision: number
    memberId: string
    leftAt: number
    idempotencyKey: string
  }) {
    const channel = this.requireChannel(input.channelId, input.expectedRevision)
    if (!channel.state.members.some((member) => member.memberId === input.memberId))
      throw new Error('Channel member not found.')
    return this.updateChannel(
      channel,
      channel.state.members.filter((member) => member.memberId !== input.memberId),
      input.leftAt,
      input.idempotencyKey,
      'runtime-channel.member-left',
      { memberId: input.memberId }
    )
  }

  publish(input: {
    message: RuntimeChannelMessageState
    expectedChannelRevision: number
    idempotencyKey: string
  }) {
    const channel = this.requireChannel(input.message.channelId, input.expectedChannelRevision)
    const publisher = channel.state.members.find(
      (member) => member.memberId === input.message.publisherMemberId
    )
    if (!publisher || publisher.role === 'consumer')
      throw new Error('Channel publisher is not an authorized producer.')
    integer(input.message.priority, 'Message priority')
    if (
      input.message.expiresAt !== undefined &&
      input.message.expiresAt <= input.message.publishedAt
    )
      throw new Error('Message expiry must be after publication.')
    const pending = this.listPending(input.message.channelId, input.message.publishedAt)
    if (pending.length >= channel.state.capacity)
      throw new Error('Channel backpressure: capacity exceeded.')
    const state =
      channel.state.mode === 'broadcast'
        ? {
            ...input.message,
            deliveries: channel.state.members
              .filter(
                (member) =>
                  member.memberId !== input.message.publisherMemberId && member.role !== 'producer'
              )
              .map((member) => ({ consumerMemberId: member.memberId }))
          }
        : input.message
    return this.events.mutateResource<RuntimeChannelMessageState>({
      operation: 'create',
      kind: MESSAGE,
      id: input.message.id,
      state,
      createdAt: input.message.publishedAt,
      idempotencyKey: `channel-message:${input.message.id}:publish:${input.idempotencyKey}`,
      event: event(
        MESSAGE,
        input.message.id,
        'runtime-channel.message-published',
        input.message.publishedAt,
        0,
        { channelId: channel.id, priority: input.message.priority }
      )
    }).resource
  }

  listPending(
    channelId: string,
    now: number
  ): readonly StoredResource<RuntimeChannelMessageState>[] {
    return (
      this.events.listResources({
        kind: MESSAGE,
        limit: 1_000
      }) as readonly StoredResource<RuntimeChannelMessageState>[]
    )
      .filter(
        (message) =>
          message.state.channelId === channelId &&
          message.state.acknowledgedAt === undefined &&
          (message.state.queueClaim === undefined || message.state.queueClaim.expiresAt <= now) &&
          (message.state.expiresAt === undefined || message.state.expiresAt > now)
      )
      .sort(
        (left, right) =>
          right.state.priority - left.state.priority ||
          left.state.publishedAt - right.state.publishedAt ||
          left.id.localeCompare(right.id)
      )
  }

  claimQueue(input: {
    messageId: string
    expectedRevision: number
    consumerMemberId: string
    token: string
    claimedAt: number
    leaseMs: number
    idempotencyKey: string
  }) {
    const message = this.getMessage(input.messageId)
    if (!message) throw new Error('Channel message not found.')
    if (message.revision !== input.expectedRevision)
      throw new Error('Channel message revision conflict.')
    const channel = this.getChannel(message.state.channelId)
    if (channel?.state.mode !== 'queue') throw new Error('Queue claim requires queue mode.')
    const consumer = channel.state.members.find(
      (member) => member.memberId === input.consumerMemberId
    )
    if (!consumer || consumer.role === 'producer')
      throw new Error('Channel consumer is not authorized.')
    const active = message.state.queueClaim
    if (active && active.expiresAt > input.claimedAt)
      throw new Error('Channel message is already claimed.')
    return this.events.mutateResource<RuntimeChannelMessageState>({
      operation: 'update',
      kind: MESSAGE,
      id: message.id,
      expectedRevision: message.revision,
      state: {
        ...message.state,
        queueClaim: {
          consumerMemberId: input.consumerMemberId,
          token: input.token,
          expiresAt: input.claimedAt + input.leaseMs
        }
      },
      createdAt: input.claimedAt,
      idempotencyKey: `channel-message:${message.id}:claim:${input.idempotencyKey}`,
      event: event(
        MESSAGE,
        message.id,
        'runtime-channel.message-claimed',
        input.claimedAt,
        message.revision + 1,
        { consumerMemberId: input.consumerMemberId }
      )
    }).resource
  }

  acknowledge(input: {
    messageId: string
    expectedRevision: number
    consumerMemberId: string
    acknowledgedAt: number
    idempotencyKey: string
    token?: string
  }) {
    const message = this.getMessage(input.messageId)
    if (!message) throw new Error('Channel message not found.')
    if (message.revision !== input.expectedRevision)
      throw new Error('Channel message revision conflict.')
    const channel = this.getChannel(message.state.channelId)
    const consumer = channel?.state.members.find(
      (member) => member.memberId === input.consumerMemberId
    )
    if (!consumer || consumer.role === 'producer')
      throw new Error('Channel consumer is not authorized.')
    if (channel?.state.mode === 'queue' && message.state.queueClaim?.token !== input.token)
      throw new Error('Channel queue claim token mismatch.')
    const state =
      channel?.state.mode === 'broadcast'
        ? {
            ...message.state,
            deliveries: message.state.deliveries?.map((delivery) =>
              delivery.consumerMemberId === input.consumerMemberId
                ? { ...delivery, acknowledgedAt: input.acknowledgedAt }
                : delivery
            ),
            ...(message.state.deliveries?.every(
              (delivery) =>
                delivery.consumerMemberId === input.consumerMemberId ||
                delivery.acknowledgedAt !== undefined
            )
              ? { acknowledgedAt: input.acknowledgedAt }
              : {})
          }
        : {
            ...message.state,
            acknowledgedAt: input.acknowledgedAt,
            acknowledgedBy: input.consumerMemberId
          }
    return this.events.mutateResource<RuntimeChannelMessageState>({
      operation: 'update',
      kind: MESSAGE,
      id: message.id,
      expectedRevision: message.revision,
      state,
      createdAt: input.acknowledgedAt,
      idempotencyKey: `channel-message:${message.id}:ack:${input.idempotencyKey}`,
      event: event(
        MESSAGE,
        message.id,
        'runtime-channel.message-acknowledged',
        input.acknowledgedAt,
        message.revision + 1,
        { consumerMemberId: input.consumerMemberId }
      )
    }).resource
  }

  private requireChannel(id: string, revision: number) {
    const channel = this.getChannel(id)
    if (!channel) throw new Error('Channel not found.')
    if (channel.revision !== revision) throw new Error('Channel revision conflict.')
    return channel
  }
  private updateChannel(
    channel: StoredResource<RuntimeChannelState>,
    members: RuntimeChannelState['members'],
    at: number,
    key: string,
    type: string,
    payload: Record<string, unknown>
  ) {
    return this.events.mutateResource<RuntimeChannelState>({
      operation: 'update',
      kind: CHANNEL,
      id: channel.id,
      expectedRevision: channel.revision,
      state: { ...channel.state, members },
      createdAt: at,
      idempotencyKey: `channel:${channel.id}:${type}:${key}`,
      event: event(CHANNEL, channel.id, type, at, channel.revision + 1, payload)
    }).resource
  }
}
