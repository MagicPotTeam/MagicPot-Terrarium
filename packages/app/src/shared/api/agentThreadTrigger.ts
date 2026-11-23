import type { AgentThreadInteractionScope } from './agentThreadInteraction'

/**
 * One installed trigger as the user's /triggers command lists it (KohakuTerrarium 2.2.3 /triggers:
 * id, type, state and creation time; read-only). Listing never fires, edits or removes a trigger.
 */
export type AgentThreadTriggerView = {
  id: string
  type: 'TimerTrigger' | 'SchedulerTrigger'
  running: boolean
  createdAt: number
  nextFireAt: number
  prompt: string
}
/** The user's own canvas thread conversation (route + conversationId). */
export type AgentThreadTriggerListScope = AgentThreadInteractionScope
