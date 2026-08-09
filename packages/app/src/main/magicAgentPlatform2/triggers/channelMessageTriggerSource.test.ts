import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { ChannelMessageTriggerSource } from './channelMessageTriggerSource'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { TriggerOccurrenceStore } from './triggerOccurrenceStore'

const channelTrigger = (id: string, channelId: string, enabled = true) => ({
  id,
  type: 'message' as const,
  title: id,
  enabled,
  config: {
    channelId,
    target: { kind: 'agent-run', agentId: 'agent', prompt: id }
  }
})

describe('ChannelMessageTriggerSource', () => {
  it('durably enqueues matching enabled channel triggers with replay-safe event identity', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const triggers = new PersistentTriggerStore(eventStore)
      const occurrences = new TriggerOccurrenceStore(eventStore)
      triggers.create(channelTrigger('matching', 'channel-1'), 1, 'matching-create')
      triggers.create(channelTrigger('other', 'channel-2'), 1, 'other-create')
      triggers.create(channelTrigger('disabled', 'channel-1', false), 1, 'disabled-create')
      const source = new ChannelMessageTriggerSource(triggers, occurrences)
      const event = {
        eventId: 'channel-event-1',
        channelId: 'channel-1',
        messageId: 'message-1',
        receivedAt: 10,
        payloadDigest: 'a'.repeat(64)
      }
      expect(source.enqueue(event)).toBe(1)
      expect(source.enqueue(event)).toBe(1)
      expect(occurrences.list()).toHaveLength(1)
      expect(occurrences.list()[0]?.state).toMatchObject({
        occurrenceId: 'channel-message:channel-event-1:matching',
        triggerId: 'matching',
        source: 'channel-message',
        status: 'pending',
        payloadDigest: 'a'.repeat(64)
      })
    } finally {
      eventStore.close()
    }
  })
})
