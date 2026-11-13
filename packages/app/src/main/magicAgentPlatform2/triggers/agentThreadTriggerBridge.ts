import { createHash } from 'node:crypto'
import type { AgentThreadTriggerDeliveryStore, ThreadTriggerTarget } from '../../api/agentThreadTriggerDeliveryStore'
import type { PersistentTriggerState } from './persistentTriggerStore'
import type { TriggerOccurrenceState } from './triggerOccurrenceStore'

/** MAIN-owned mapping is the only routing authority; trigger config cannot opt in.
 * Undefined means an ordinary platform trigger. Mapping errors must throw, not fall back.
 * This bridge records data only; it does not authorize or start a model request. */
export type ThreadTriggerBridgeMapping = Readonly<{ target: ThreadTriggerTarget; deliveryId: string }>
export function createAgentThreadTriggerBridge(options: {
  resolve: (triggerId: string) => ThreadTriggerBridgeMapping | undefined | Promise<ThreadTriggerBridgeMapping | undefined>
  store: Pick<AgentThreadTriggerDeliveryStore, 'list' | 'observe'>
}): (trigger: PersistentTriggerState, occurrence: TriggerOccurrenceState) => Promise<boolean> {
  return async (trigger, occurrence) => {
    const mapping = await options.resolve(trigger.id)
    if (mapping === undefined) return false
    if (!mapping || typeof mapping !== 'object' || typeof mapping.deliveryId !== 'string' || !mapping.deliveryId || !mapping.target || occurrence.triggerId !== trigger.id) throw Error('Invalid thread trigger mapping.')
    const item = options.store.list(mapping.target).find(entry => entry.id === mapping.deliveryId)
    if (!item) throw Error('Thread trigger delivery is unavailable.')
    if (occurrence.source === 'calendar' && item.condition.type === 'calendar') {
      if (occurrence.scheduledAt !== item.condition.fireAt) throw Error('Thread trigger calendar occurrence mismatch.')
      options.store.observe(mapping.target, mapping.deliveryId, { type: 'calendar', at: occurrence.scheduledAt })
    } else if (occurrence.source === 'workflow-completion' && item.condition.type === 'workflow') {
      if (trigger.type !== 'event' || trigger.config?.graphId !== item.condition.graphId) throw Error('Thread trigger workflow source mismatch.')
      const runId = `o-${createHash('sha256').update(occurrence.occurrenceId).digest('hex')}`
      options.store.observe(mapping.target, mapping.deliveryId, { type: 'workflow', graphId: item.condition.graphId, runId, at: occurrence.scheduledAt })
    } else throw Error('Unsupported thread trigger occurrence source.')
    return true
  }
}
