export type AgentRouteLike = {
  channel: string
  scopeType: string
  scopeId: string
  threadId?: string
  senderId?: string
  senderName?: string
}

export type AgentSessionIdentity = {
  sessionKey: string
  route: AgentRouteLike
  channel: string
  scopeType: 'dm' | 'group' | 'channel' | 'thread' | 'topic'
  scopeId: string
  threadId?: string
  senderId?: string
  senderName?: string
  workspaceId?: string
  aliases: string[]
  createdAt: number
  updatedAt: number
}

export type BuildAgentSessionIdentityOptions = {
  workspaceId?: string
  aliases?: string[]
  createdAt?: number
  updatedAt?: number
}

export type BuildAgentRouteOptions = {
  channel?: string | null
  scopeType?: string | null
  scopeId?: string | null
  scopeIdCandidates?: Array<string | null | undefined>
  fallbackScopeId?: string | null
  threadId?: string | null
  senderId?: string | null
  senderName?: string | null
}

const AGENT_SCOPE_TYPES = new Set<AgentSessionIdentity['scopeType']>([
  'dm',
  'group',
  'channel',
  'thread',
  'topic'
])

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

export const resolveAgentRouteScopeId = (
  scopeIdCandidates: Array<string | null | undefined>,
  fallbackScopeId?: string | null
): string =>
  scopeIdCandidates
    .map((value) => cleanString(value))
    .find((value): value is string => Boolean(value)) ||
  cleanString(fallbackScopeId) ||
  'default'

export const buildAgentRoute = (options?: BuildAgentRouteOptions): AgentRouteLike =>
  normalizeAgentRoute({
    channel: cleanString(options?.channel) || 'generic',
    scopeType: cleanString(options?.scopeType) || 'dm',
    scopeId: resolveAgentRouteScopeId(
      [options?.scopeId, ...(options?.scopeIdCandidates || [])],
      options?.fallbackScopeId
    ),
    ...(cleanString(options?.threadId) ? { threadId: cleanString(options?.threadId) } : {}),
    ...(cleanString(options?.senderId) ? { senderId: cleanString(options?.senderId) } : {}),
    ...(cleanString(options?.senderName) ? { senderName: cleanString(options?.senderName) } : {})
  })

export const normalizeAgentRoute = (route: AgentRouteLike): AgentRouteLike => ({
  channel: cleanString(route.channel) || 'generic',
  scopeType: AGENT_SCOPE_TYPES.has(route.scopeType as AgentSessionIdentity['scopeType'])
    ? (route.scopeType as AgentSessionIdentity['scopeType'])
    : 'dm',
  scopeId: cleanString(route.scopeId) || 'default',
  ...(cleanString(route.threadId) ? { threadId: cleanString(route.threadId) } : {}),
  ...(cleanString(route.senderId) ? { senderId: cleanString(route.senderId) } : {}),
  ...(cleanString(route.senderName) ? { senderName: cleanString(route.senderName) } : {})
})

export const getAgentSessionKey = (route: AgentRouteLike): string => {
  const normalized = normalizeAgentRoute(route)
  const parts = [normalized.channel, normalized.scopeType, normalized.scopeId]
  if (normalized.threadId) {
    parts.push(`thread:${normalized.threadId}`)
  }
  return parts.join(':')
}

export const buildAgentSessionIdentity = (
  route: AgentRouteLike,
  options?: BuildAgentSessionIdentityOptions
): AgentSessionIdentity => {
  const normalized = normalizeAgentRoute(route)
  const sessionKey = getAgentSessionKey(normalized)
  const createdAt = Number.isFinite(options?.createdAt) ? Number(options?.createdAt) : Date.now()
  const updatedAt = Number.isFinite(options?.updatedAt) ? Number(options?.updatedAt) : createdAt

  return {
    sessionKey,
    route: normalized,
    channel: normalized.channel,
    scopeType: normalized.scopeType as AgentSessionIdentity['scopeType'],
    scopeId: normalized.scopeId,
    ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
    ...(normalized.senderId ? { senderId: normalized.senderId } : {}),
    ...(normalized.senderName ? { senderName: normalized.senderName } : {}),
    ...(cleanString(options?.workspaceId)
      ? { workspaceId: cleanString(options?.workspaceId) }
      : {}),
    aliases: [
      ...new Set([
        sessionKey,
        ...(options?.aliases || [])
          .map((alias) => cleanString(alias))
          .filter((alias): alias is string => Boolean(alias))
      ])
    ],
    createdAt,
    updatedAt
  }
}
