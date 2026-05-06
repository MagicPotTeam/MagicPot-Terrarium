import { buildAgentRoute, getAgentSessionKey } from '@shared/agent'

type BuildQAppSessionIdentityOptions = {
  qAppKey?: string | null
  projectId?: string | null
}

type ResolveQAppSessionKeyOptions = BuildQAppSessionIdentityOptions & {
  generationSessionId?: string | null
  submitSessionKey?: string | null
}

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

export const buildQAppAgentRoute = (options?: BuildQAppSessionIdentityOptions) => {
  const qAppKey = cleanString(options?.qAppKey)
  const projectId = cleanString(options?.projectId)

  if (projectId && qAppKey) {
    return buildAgentRoute({
      channel: 'quickapp',
      scopeType: 'thread',
      scopeId: projectId,
      threadId: qAppKey
    })
  }

  return buildAgentRoute({
    channel: 'quickapp',
    scopeType: 'topic',
    scopeIdCandidates: [qAppKey, projectId],
    fallbackScopeId: 'default'
  })
}

export const getQAppSessionKey = (options?: BuildQAppSessionIdentityOptions): string =>
  getAgentSessionKey(buildQAppAgentRoute(options))

export const resolveQAppSessionKey = (options: ResolveQAppSessionKeyOptions): string =>
  cleanString(options.generationSessionId) ||
  cleanString(options.submitSessionKey) ||
  getQAppSessionKey(options)
