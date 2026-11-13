import { AgentThreadTriggerDeliveryStore, type ThreadTriggerDelivery, type ThreadTriggerTarget } from '../../api/agentThreadTriggerDeliveryStore'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentTriggerStore } from './persistentTriggerStore'

/** Unwired data-only staging. Prepared commands must be retained unchanged for retry.
 * This is not registration, mapping, approval, activation or an execution permit. */
export function prepareThreadTriggerStage(store: MagicAgentEventStore, input: {
  target: ThreadTriggerTarget
  delivery: Pick<ThreadTriggerDelivery, 'id' | 'condition' | 'prompt' | 'consent'>
  platformId: string
  createdAt: number
  deliveryEventId: string
  triggerIdempotencyKey: string
}) {
  const delivery = new AgentThreadTriggerDeliveryStore(store).prepareCreate(input.target, input.delivery, input.deliveryEventId, input.createdAt)
  const condition = input.delivery.condition
  const config = condition.type === 'calendar'
    ? { sourceKind: 'calendar', startAt: new Date(condition.fireAt).toISOString() }
    : { graphId: condition.graphId }
  const trigger = new PersistentTriggerStore(store).prepareCreate({ id: input.platformId, type: 'event', title: 'Thread trigger staging', enabled: false, config }, input.createdAt, input.triggerIdempotencyKey).mutation
  return structuredClone([delivery, trigger] as const)
}

export function commitThreadTriggerStage(store: MagicAgentEventStore, prepared: ReturnType<typeof prepareThreadTriggerStage>) {
  return store.mutateResourcesBatch([...prepared])
}
