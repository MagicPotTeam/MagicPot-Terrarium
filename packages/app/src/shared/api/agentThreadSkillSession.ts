import type { AgentThreadInteractionScope } from './agentThreadInteraction'

/** User preference only. Enabling never overrides global registration or grants tools. */
export type AgentSkillPreferenceRecord = {
  owner: string
  revision: number
  disabledIds: string[]
  receipts: Array<{ operationId: string; digest: string }>
}
export type AgentSkillSessionEntry = { id: string; name: string; description: string; paths: string[]; hidden: boolean; enabled: boolean }
export type AgentSkillSessionList = { revision: number; skills: AgentSkillSessionEntry[]; truncated: boolean; staleDisabledIds: string[]; grantsPermission: false }
export type AgentSkillPreferenceResult = AgentSkillSessionList | { status: 'not-applied'; operationId: string; reason: 'revision-conflict'; currentRevision: number }
export type AgentSkillScope = AgentThreadInteractionScope & { documentToken: string }
export type AgentSkillScopeReq = AgentThreadInteractionScope & { active: boolean; lifecycleRevision: number }
export type AgentSkillShowReq = AgentSkillScope & { name: string }
export type AgentSkillUserDetail = { id: string; name: string; description: string; instructions: string; baseDirectory: string; paths: string[]; enabled: boolean; revision: number; untrustedData: true; grantsPermission: false; executed: false }
export type AgentSkillPreferenceReq = AgentSkillScope & { id: string; enabled: boolean; expectedRevision: number; operationId: string }
