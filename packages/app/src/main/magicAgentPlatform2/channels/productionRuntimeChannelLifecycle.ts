import type { MagicAgentPolicyAuthorizationService } from '../policy'
import type { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentRuntimeChannelForwardingStore } from './persistentRuntimeChannelForwardingStore'
import { PersistentRuntimeChannelWireStore } from './persistentRuntimeChannelWireStore'
import { PersistentRuntimeChannelStore } from './persistentRuntimeChannelStore'
import { RuntimeChannelWireCommandService } from './runtimeChannelWireCommandService'
import { RuntimeChannelCommandService } from './runtimeChannelCommandService'

export type RuntimeChannelWakeEvent = Readonly<{
  channelId: string
  pendingMessageIds: readonly string[]
}>

export class ProductionRuntimeChannelLifecycle {
  readonly store: PersistentRuntimeChannelStore
  readonly forwarding: PersistentRuntimeChannelForwardingStore
  readonly wires: PersistentRuntimeChannelWireStore
  readonly wireCommands: RuntimeChannelWireCommandService
  readonly commands: RuntimeChannelCommandService
  private readonly listeners = new Set<(event: RuntimeChannelWakeEvent) => void>()
  private readonly forwardInFlight = new Set<string>()
  private timer?: NodeJS.Timeout
  private readonly now: () => number
  private readonly pollIntervalMs: number

  constructor(options: {
    eventStore: MagicAgentEventStore
    authorization: MagicAgentPolicyAuthorizationService
    now?: () => number
    pollIntervalMs?: number
  }) {
    this.now = options.now ?? Date.now
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.store = new PersistentRuntimeChannelStore(options.eventStore)
    this.forwarding = new PersistentRuntimeChannelForwardingStore(options.eventStore)
    this.wires = new PersistentRuntimeChannelWireStore(options.eventStore, this.store)
    this.wireCommands = new RuntimeChannelWireCommandService(
      this.wires,
      options.authorization,
      this.now
    )
    this.commands = new RuntimeChannelCommandService(
      this.store,
      options.authorization,
      this.now,
      (channelId) => {
        const now = this.now()
        this.forward(channelId, now)
        this.wake(channelId, now)
      }
    )
  }

  start(): void {
    if (this.timer) return
    this.recoverWakeups(this.now())
    this.retryForwarding(this.now())
    this.timer = setInterval(() => this.retryForwarding(this.now()), this.pollIntervalMs)
    this.timer.unref?.()
  }

  subscribeWake(listener: (event: RuntimeChannelWakeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  recoverWakeups(now = Date.now()): readonly RuntimeChannelWakeEvent[] {
    const events = this.store
      .listChannels()
      .map((channel) => ({
        channelId: channel.id,
        pendingMessageIds: this.store.listPending(channel.id, now).map((message) => message.id)
      }))
      .filter((event) => event.pendingMessageIds.length > 0)
    for (const event of events) for (const listener of this.listeners) listener(event)
    return events
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }

  retryForwarding(now = Date.now()): number {
    let completed = 0
    for (const attempt of this.forwarding.listPending(now)) {
      const source = this.store.getMessage(attempt.state.sourceMessageId)
      const wire = this.wires.get(attempt.state.wireId)
      if (!source || !wire?.state.enabled) continue
      if (this.forwardOne(source.state.channelId, source, wire, now)) completed += 1
    }
    return completed
  }

  private forward(channelId: string, now: number): void {
    for (const message of this.store.listPending(channelId, now)) {
      if (this.forwardInFlight.has(message.id)) continue
      this.forwardInFlight.add(message.id)
      try {
        for (const wire of this.wires.targets(channelId))
          this.forwardOne(channelId, message, wire, now)
      } finally {
        this.forwardInFlight.delete(message.id)
      }
    }
  }

  private forwardOne(
    _channelId: string,
    message: ReturnType<PersistentRuntimeChannelStore['getMessage']> & object,
    wire: ReturnType<PersistentRuntimeChannelWireStore['get']> & object,
    now: number
  ): boolean {
    const path = [...(message.state.wirePath ?? []), wire.id]
    if (path.length > wire.state.maxHops || new Set(path).size !== path.length) return false
    const attemptId = `${wire.id}:${message.id}`
    const attempt = this.forwarding.ensure({
      state: {
        id: attemptId,
        wireId: wire.id,
        sourceMessageId: message.id,
        targetMessageId: `wire:${wire.id}:${message.id}`,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now
      },
      createdAt: now,
      idempotencyKey: `wire-forward:${wire.id}:${message.id}`
    })
    try {
      const {
        acknowledgedAt: _acknowledgedAt,
        acknowledgedBy: _acknowledgedBy,
        queueClaim: _queueClaim,
        deliveries: _deliveries,
        ...forwardable
      } = message.state
      this.store.publish({
        message: {
          ...forwardable,
          id: attempt.state.targetMessageId,
          channelId: wire.state.targetChannelId,
          publisherMemberId: wire.state.targetPublisherMemberId,
          publishedAt: attempt.createdAt,
          wirePath: path
        },
        expectedChannelRevision: this.store.getChannel(wire.state.targetChannelId)!.revision,
        idempotencyKey: `wire-forward:${wire.id}:${message.id}`
      })
      this.forwarding.succeed({
        id: attempt.id,
        expectedRevision: attempt.revision,
        completedAt: now,
        idempotencyKey: `wire-forward:${wire.id}:${message.id}`
      })
      this.wake(wire.state.targetChannelId, now)
      this.forward(wire.state.targetChannelId, now)
      return true
    } catch (error) {
      const existingTarget = this.store.getMessage(attempt.state.targetMessageId)
      if (existingTarget) {
        this.forwarding.succeed({
          id: attempt.id,
          expectedRevision: attempt.revision,
          completedAt: now,
          idempotencyKey: `wire-forward:${wire.id}:${message.id}:recovered`
        })
        this.wake(wire.state.targetChannelId, now)
        this.forward(wire.state.targetChannelId, now)
        return true
      }
      this.forwarding.fail({
        id: attempt.id,
        expectedRevision: attempt.revision,
        failedAt: now,
        reason: error instanceof Error ? error.message : String(error),
        retryDelayMs: 1_000,
        idempotencyKey: `wire-forward:${wire.id}:${message.id}:${attempt.state.attemptCount}`
      })
      return false
    }
  }

  private wake(channelId: string, now: number): void {
    const event = {
      channelId,
      pendingMessageIds: this.store.listPending(channelId, now).map((message) => message.id)
    }
    if (!event.pendingMessageIds.length) return
    for (const listener of this.listeners) listener(event)
  }
}

let active: ProductionRuntimeChannelLifecycle | undefined
export const getProductionRuntimeChannelLifecycle = () => active
export const startProductionRuntimeChannelLifecycle = (
  options: ConstructorParameters<typeof ProductionRuntimeChannelLifecycle>[0]
) => {
  if (active) return active
  active = new ProductionRuntimeChannelLifecycle(options)
  active.start()
  return active
}
export const closeProductionRuntimeChannelLifecycle = (): void => {
  const current = active
  active = undefined
  current?.close()
}
