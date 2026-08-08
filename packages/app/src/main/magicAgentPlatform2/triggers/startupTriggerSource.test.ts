import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { StartupTriggerSource } from './startupTriggerSource'
import { TriggerOccurrenceStore } from './triggerOccurrenceStore'

const startup = (id: string, enabled = true, paused = false) => ({
  id,
  type: 'startup' as const,
  title: id,
  enabled,
  ...(paused ? { paused: true } : {}),
  config: { executionTarget: { type: 'agent-run', agentId: 'agent', prompt: id } }
})

describe('StartupTriggerSource', () => {
  it('enqueues enabled startup triggers once per boot and again for a new boot', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const triggers = new PersistentTriggerStore(eventStore)
      const occurrences = new TriggerOccurrenceStore(eventStore)
      triggers.create(startup('enabled'), 1, 'enabled-create')
      triggers.create(startup('disabled', false), 1, 'disabled-create')
      triggers.create(startup('paused', true, true), 1, 'paused-create')
      const bootOne = new StartupTriggerSource(triggers, occurrences, 'boot-one', () => 10)
      expect(bootOne.enqueue()).toBe(1)
      expect(bootOne.enqueue()).toBe(1)
      expect(occurrences.list()).toHaveLength(1)
      expect(occurrences.list()[0]?.state).toMatchObject({
        occurrenceId: 'startup:boot-one:enabled',
        source: 'startup',
        triggerId: 'enabled',
        status: 'pending'
      })
      expect(new StartupTriggerSource(triggers, occurrences, 'boot-two', () => 20).enqueue()).toBe(
        1
      )
      expect(occurrences.list()).toHaveLength(2)
    } finally {
      eventStore.close()
    }
  })
})
