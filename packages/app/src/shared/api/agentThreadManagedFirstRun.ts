import type { AgentThreadInteractionScope } from './agentThreadInteraction'

/** Pane identity DATA only. No token, revision or DTO grants execution/approval. */
export type ManagedFirstRunPaneScope = AgentThreadInteractionScope & { documentToken: string }
export type ManagedFirstRunPaneScopeReq = AgentThreadInteractionScope & { active: boolean; lifecycleRevision: number }
/** Execution request DATA remains deliberately absent from public service definitions.
 * Only the separate pane identity revision/set endpoints may be registered. */
export type ManagedFirstRunPaneRequest = ManagedFirstRunPaneScope & {
  text: string
  profileId: string
  maxOutputTokens: number
  systemPrompt?: string
  temperature?: number
}
