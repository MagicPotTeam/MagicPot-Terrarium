import type { LLMTeamMember } from './svcLLMProxy'
import type { AgentThreadInteractionScope } from './agentThreadInteraction'

/** MAIN-owned, durable intent; not evidence of delivery or model processing. */
export type AgentTeamMessageIntent = {
  id: string
  source: LLMTeamMember
  kind: 'message' | 'channel'
  /** Host-assigned delivery depth; bounded to two to prevent automatic loops. */
  hop: 1 | 2
  recipient?: string
  text: string
  /** No longer sent: queued messages do not expire. */
  expiresAt?: number
  /** Queued before this document or process: delivered only after the user's next send to the recipient. */
  carriedOver?: true
  /** Claim only: the lease token, given out once; a delivery request presents it as teamMessageDelivery. */
  lease?: string
}
export type AgentTeamMessageQueueScope = AgentThreadInteractionScope & { storageScope: string }
export type AgentTeamMessageClaim = AgentTeamMessageQueueScope & { id: string }
