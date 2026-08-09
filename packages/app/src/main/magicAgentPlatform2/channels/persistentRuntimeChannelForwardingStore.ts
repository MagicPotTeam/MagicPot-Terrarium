import type { RuntimeChannelForwardingState } from '../../../shared/magicAgentPlatform2/runtimeChannel'
import type { MagicAgentEventStore, StoredResource } from '../persistence/eventStore'
const KIND = 'runtime-channel-forwarding' as const
const event = (
  id: string,
  type: string,
  at: number,
  revision: number,
  payload: Record<string, unknown>
) => ({
  protocolVersion: '2.0.0',
  id: `${KIND}:${id}:${type}:${at}:${revision}`,
  type,
  createdAt: at,
  payload,
  envelopeKind: 'event' as const,
  streamId: `${KIND}:${id}:stream`,
  sequence: revision,
  resource: { kind: KIND, id },
  revision
})
export class PersistentRuntimeChannelForwardingStore {
  constructor(private readonly events: MagicAgentEventStore) {}
  get(id: string) {
    return this.events.getResource(KIND, id) as
      | StoredResource<RuntimeChannelForwardingState>
      | undefined
  }
  listPending(now: number) {
    return (
      this.events.listResources({
        kind: KIND,
        limit: 1_000
      }) as readonly StoredResource<RuntimeChannelForwardingState>[]
    ).filter((item) => item.state.status !== 'succeeded' && item.state.nextAttemptAt <= now)
  }
  ensure(input: {
    state: RuntimeChannelForwardingState
    createdAt: number
    idempotencyKey: string
  }) {
    const existing = this.get(input.state.id)
    if (existing) return existing
    return this.events.mutateResource<RuntimeChannelForwardingState>({
      operation: 'create',
      kind: KIND,
      id: input.state.id,
      state: input.state,
      createdAt: input.createdAt,
      idempotencyKey: `channel-forward:${input.state.id}:create:${input.idempotencyKey}`,
      event: event(input.state.id, 'runtime-channel.forwarding-created', input.createdAt, 0, {
        wireId: input.state.wireId,
        sourceMessageId: input.state.sourceMessageId
      })
    }).resource
  }
  succeed(input: {
    id: string
    expectedRevision: number
    completedAt: number
    idempotencyKey: string
  }) {
    const current = this.get(input.id)
    if (!current) throw new Error('Forwarding not found.')
    return this.events.mutateResource<RuntimeChannelForwardingState>({
      operation: 'update',
      kind: KIND,
      id: current.id,
      expectedRevision: input.expectedRevision,
      state: {
        ...current.state,
        status: 'succeeded',
        completedAt: input.completedAt
      },
      createdAt: input.completedAt,
      idempotencyKey: `channel-forward:${current.id}:success:${input.idempotencyKey}`,
      event: event(
        current.id,
        'runtime-channel.forwarding-succeeded',
        input.completedAt,
        input.expectedRevision + 1,
        {}
      )
    }).resource
  }
  fail(input: {
    id: string
    expectedRevision: number
    failedAt: number
    reason: string
    retryDelayMs: number
    idempotencyKey: string
  }) {
    const current = this.get(input.id)
    if (!current) throw new Error('Forwarding not found.')
    return this.events.mutateResource<RuntimeChannelForwardingState>({
      operation: 'update',
      kind: KIND,
      id: current.id,
      expectedRevision: input.expectedRevision,
      state: {
        ...current.state,
        status: 'failed',
        attemptCount: current.state.attemptCount + 1,
        nextAttemptAt: input.failedAt + input.retryDelayMs,
        lastFailure: input.reason
      },
      createdAt: input.failedAt,
      idempotencyKey: `channel-forward:${current.id}:failure:${input.idempotencyKey}`,
      event: event(
        current.id,
        'runtime-channel.forwarding-failed',
        input.failedAt,
        input.expectedRevision + 1,
        { reason: input.reason }
      )
    }).resource
  }
}
