import type { PersistentTriggerStore } from './persistentTriggerStore'
import type { TriggerOccurrenceStore } from './triggerOccurrenceStore'
import type { WorkflowCompletionEvent } from './workflowCompletionEvents'

const configuredGraph = (config: Readonly<Record<string, unknown>>): string | undefined => {
  const graphId = config['graphId']
  return typeof graphId === 'string' && graphId.trim() ? graphId : undefined
}

export class WorkflowCompletionTriggerSource {
  constructor(
    private readonly triggers: PersistentTriggerStore,
    private readonly occurrences: TriggerOccurrenceStore
  ) {}

  enqueue(event: WorkflowCompletionEvent): number {
    let count = 0
    for (const trigger of this.triggers.list()) {
      if (
        trigger.state.type !== 'event' ||
        !trigger.state.enabled ||
        trigger.state.paused ||
        configuredGraph(trigger.state.config ?? {}) !== event.graphId
      )
        continue
      const occurrenceId = `workflow-completion:${event.runId}:${trigger.id}`
      this.occurrences.enqueue({
        occurrenceId,
        triggerId: trigger.id,
        source: 'workflow-completion',
        scheduledAt: event.completedAt,
        requestedAt: event.completedAt,
        idempotencyKey: occurrenceId,
        ...(event.outputDigest ? { payloadDigest: event.outputDigest } : {})
      })
      count += 1
    }
    return count
  }
}
