import type { RuntimeChannelWireState } from '../../../shared/magicAgentPlatform2/runtimeChannel'
import type { MagicAgentEventStore, StoredResource } from '../persistence/eventStore'
import type { PersistentRuntimeChannelStore } from './persistentRuntimeChannelStore'

const WIRE = 'runtime-channel-wire' as const
const event = (
  id: string,
  type: string,
  at: number,
  revision: number,
  payload: Record<string, unknown>
) => ({
  protocolVersion: '2.0.0',
  id: `runtime-channel-wire:${id}:${type}:${at}:${revision}`,
  type,
  createdAt: at,
  payload,
  envelopeKind: 'event' as const,
  streamId: `runtime-channel-wire:${id}:stream`,
  sequence: revision,
  resource: { kind: WIRE, id },
  revision
})

export class PersistentRuntimeChannelWireStore {
  constructor(
    private readonly events: MagicAgentEventStore,
    private readonly channels: PersistentRuntimeChannelStore
  ) {}
  list() {
    return this.events.listResources({
      kind: WIRE,
      limit: 1_000
    }) as readonly StoredResource<RuntimeChannelWireState>[]
  }
  get(id: string) {
    return this.events.getResource(WIRE, id) as StoredResource<RuntimeChannelWireState> | undefined
  }

  wire(input: { wire: RuntimeChannelWireState; idempotencyKey: string }) {
    if (
      !this.channels.getChannel(input.wire.sourceChannelId) ||
      !this.channels.getChannel(input.wire.targetChannelId)
    )
      throw new Error('Runtime Channel wire endpoint not found.')
    if (input.wire.sourceChannelId === input.wire.targetChannelId)
      throw new Error('Runtime Channel self-wire is not allowed.')
    const target = this.channels.getChannel(input.wire.targetChannelId)!
    const publisher = target.state.members.find(
      (member) => member.memberId === input.wire.targetPublisherMemberId
    )
    if (!publisher || publisher.role === 'consumer')
      throw new Error('Runtime Channel wire target publisher is not authorized.')
    if (!Number.isInteger(input.wire.maxHops) || input.wire.maxHops < 1 || input.wire.maxHops > 32)
      throw new Error('Runtime Channel wire maxHops must be between 1 and 32.')
    if (this.reaches(input.wire.targetChannelId, input.wire.sourceChannelId))
      throw new Error('Runtime Channel wire cycle is not allowed.')
    return this.events.mutateResource<RuntimeChannelWireState>({
      operation: 'create',
      kind: WIRE,
      id: input.wire.id,
      state: input.wire,
      createdAt: input.wire.createdAt,
      idempotencyKey: `channel-wire:${input.wire.id}:create:${input.idempotencyKey}`,
      event: event(input.wire.id, 'runtime-channel.wired', input.wire.createdAt, 0, {
        sourceChannelId: input.wire.sourceChannelId,
        targetChannelId: input.wire.targetChannelId
      })
    }).resource
  }

  unwire(input: {
    wireId: string
    expectedRevision: number
    removedAt: number
    idempotencyKey: string
  }) {
    const wire = this.get(input.wireId)
    if (!wire) throw new Error('Runtime Channel wire not found.')
    return this.events.mutateResource<RuntimeChannelWireState>({
      operation: 'update',
      kind: WIRE,
      id: wire.id,
      expectedRevision: input.expectedRevision,
      state: { ...wire.state, enabled: false },
      createdAt: input.removedAt,
      idempotencyKey: `channel-wire:${wire.id}:remove:${input.idempotencyKey}`,
      event: event(
        wire.id,
        'runtime-channel.unwired',
        input.removedAt,
        input.expectedRevision + 1,
        {}
      )
    }).resource
  }

  private reaches(sourceChannelId: string, targetChannelId: string): boolean {
    const visited = new Set<string>()
    const pending = [sourceChannelId]
    while (pending.length) {
      const current = pending.shift()!
      if (current === targetChannelId) return true
      if (visited.has(current)) continue
      visited.add(current)
      for (const wire of this.targets(current)) pending.push(wire.state.targetChannelId)
    }
    return false
  }

  targets(sourceChannelId: string) {
    return this.list().filter(
      (wire) => wire.state.enabled && wire.state.sourceChannelId === sourceChannelId
    )
  }
}
