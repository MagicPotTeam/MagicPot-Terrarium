import type { PolicyActorRef } from './policy'

export type MagicAgentTeamMemberRole = 'leader' | 'member'
export type MagicAgentTeamMember = Readonly<{
  memberId: string
  agentInstanceId: string
  role: MagicAgentTeamMemberRole
  joinedAt: number
  addedBy: PolicyActorRef
}>
export type MagicAgentTeamState = Readonly<{
  id: string
  name: string
  ownerId: string
  status: 'active' | 'removed'
  members: readonly MagicAgentTeamMember[]
  createdAt: number
  createdBy: PolicyActorRef
}>
