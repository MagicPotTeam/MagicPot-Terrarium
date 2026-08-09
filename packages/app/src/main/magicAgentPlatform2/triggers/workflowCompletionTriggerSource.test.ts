import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { TriggerOccurrenceStore } from './triggerOccurrenceStore'
import { WorkflowCompletionTriggerSource } from './workflowCompletionTriggerSource'

describe('WorkflowCompletionTriggerSource', () => {
  it('durably enqueues matching graph completion events', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const triggers = new PersistentTriggerStore(eventStore)
      const occurrences = new TriggerOccurrenceStore(eventStore)
      triggers.create(
        {
          id: 'workflow-trigger',
          type: 'event',
          title: 'Workflow trigger',
          enabled: true,
          config: {
            graphId: 'graph-1',
            target: { kind: 'agent-run', agentId: 'agent-1' }
          }
        },
        0,
        'workflow-create'
      )
      const source = new WorkflowCompletionTriggerSource(triggers, occurrences)
      const event = {
        runId: 'run-1',
        graphId: 'graph-1',
        status: 'completed' as const,
        completedAt: 10,
        outputDigest: 'b'.repeat(64)
      }
      expect(source.enqueue(event)).toBe(1)
      expect(source.enqueue(event)).toBe(1)
      expect(occurrences.list()).toHaveLength(1)
      expect(occurrences.list()[0]?.state).toMatchObject({
        occurrenceId: 'workflow-completion:run-1:workflow-trigger',
        source: 'workflow-completion',
        payloadDigest: 'b'.repeat(64)
      })
    } finally {
      eventStore.close()
    }
  })
})
