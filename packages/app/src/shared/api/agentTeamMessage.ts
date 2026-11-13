import type { LLMTeamMember } from './svcLLMProxy'
import type { AgentThreadInteractionScope } from './agentThreadInteraction'

/** MAIN-owned, process-local intent; not evidence of delivery or model processing. */
export type AgentTeamMessageIntent = {
  id: string
  source: LLMTeamMember
  kind: 'message' | 'channel'
  /** Host-assigned delivery depth; bounded to two to prevent automatic loops. */
  hop: 1 | 2
  recipient?: string
  text: string
  expiresAt: number
}
export type AgentTeamMessageQueueScope = AgentThreadInteractionScope & { storageScope: string }
export type AgentTeamMessageClaim = AgentTeamMessageQueueScope & { id: string }
