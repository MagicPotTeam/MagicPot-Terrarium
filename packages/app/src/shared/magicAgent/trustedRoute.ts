import type { AgentRouteLike } from '@shared/agent'

export const MAGIC_AGENT_TRUSTED_ROUTE_SESSION_ID = 'agent-studio'
export const MAGIC_AGENT_TRUSTED_ROUTE_HASH_PATH = `/${MAGIC_AGENT_TRUSTED_ROUTE_SESSION_ID}`
export const MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE: AgentRouteLike = {
  channel: 'generic',
  scopeType: 'dm',
  scopeId: MAGIC_AGENT_TRUSTED_ROUTE_SESSION_ID
}
export type MagicAgentTrustedRouteBinding = {
  route: AgentRouteLike
  hashPath: string
  trustedUrl: string
  createdAt: number
}
