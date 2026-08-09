import { sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import type { PersistentTriggerStore } from './persistentTriggerStore'
import type { TriggerOccurrenceStore } from './triggerOccurrenceStore'

export type ChannelMessageTriggerEvent = Readonly<{
  eventId: string
  channelId: string
  messageId: string
  receivedAt: number
  payloadDigest?: string
}>

const configuredChannel = (config: Readonly<Record<string, unknown>>): string | undefined => {
  const channelId = config['channelId']
  return typeof channelId === 'string' && channelId.trim() ? channelId : undefined
}

export class ChannelMessageTriggerSource {
  constructor(
    private readonly triggers: PersistentTriggerStore,
    private readonly occurrences: TriggerOccurrenceStore
  ) {}

  enqueue(event: ChannelMessageTriggerEvent): number {
    if (!event.eventId.trim() || !event.channelId.trim() || !event.messageId.trim())
      throw new Error('Channel message event identity is required.')
    if (!Number.isFinite(event.receivedAt) || event.receivedAt < 0)
      throw new Error('Channel message receivedAt must be non-negative and finite.')
    const payloadDigest = event.payloadDigest ?? sha256PolicyText(event.messageId)
    let count = 0
    for (const trigger of this.triggers.list()) {
      if (
        trigger.state.type !== 'message' ||
        !trigger.state.enabled ||
        trigger.state.paused ||
        configuredChannel(trigger.state.config ?? {}) !== event.channelId
      )
        continue
      const occurrenceId = `channel-message:${event.eventId}:${trigger.id}`
      this.occurrences.enqueue({
        occurrenceId,
        triggerId: trigger.id,
        source: 'channel-message',
        scheduledAt: event.receivedAt,
        requestedAt: event.receivedAt,
        idempotencyKey: occurrenceId,
        payloadDigest
      })
      count += 1
    }
    return count
  }
}
