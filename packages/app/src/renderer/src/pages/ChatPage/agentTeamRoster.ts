import { useEffect } from 'react'
import type { AgentRouteLike } from '@shared/agent'
import type { AgentTeamLegacySnapshot } from '@shared/api/agentTeam'
import { api } from '@renderer/utils/windowUtils'
import type { ChatSession } from './chatStorage'

/**
 * The legacy team fields of one lead and the sessions that name it as their lead, exactly as chat
 * storage holds them. Only reads: the sessions are not changed (MagicPot: the old fields stay in
 * place until S6-5 is merged and proven). Undefined when no session names this lead (no team).
 */
export function legacyTeamSnapshot(
  lead: ChatSession,
  sessions: readonly ChatSession[]
): AgentTeamLegacySnapshot | undefined {
  const members = sessions.filter(
    (session) => session.teamLeadId === lead.id && session.id !== lead.id
  )
  if (!members.length) return undefined
  return {
    lead: {
      id: lead.id,
      ...(lead.teamGeneration !== undefined ? { teamGeneration: lead.teamGeneration } : {}),
      ...(lead.teamEnded !== undefined ? { teamEnded: lead.teamEnded } : {})
    },
    members: members.map((member) => ({
      id: member.id,
      teamLeadId: lead.id,
      title: member.title,
      ...(member.teamMemberName !== undefined ? { teamMemberName: member.teamMemberName } : {}),
      ...(member.teamRole !== undefined ? { teamRole: member.teamRole } : {}),
      ...(member.teamMemberGeneration !== undefined
        ? { teamMemberGeneration: member.teamMemberGeneration }
        : {}),
      ...(member.memberModelChoice !== undefined
        ? { memberModelChoice: member.memberModelChoice }
        : {}),
      ...(member.archived !== undefined ? { archived: member.archived } : {}),
      ...(member.createdAt !== undefined ? { createdAt: member.createdAt } : {})
    }))
  }
}

type RosterImportInput = {
  enabled: boolean
  storageScope: string
  route: AgentRouteLike | null | undefined
  lead: ChatSession | undefined
  sessions: readonly ChatSession[]
}

/** Teams this page already handed to MAIN, by request key: each is sent once per page session. */
const imported = new Set<string>()
let warned = false

/**
 * S6-1: hands the open thread's stored team (when it has members) to MAIN once, for MAIN's roster.
 * MAIN's import is idempotent and non-destructive: once a roster exists, later imports change
 * nothing. Nothing on this page reads the roster yet, and any failure leaves everything as it is.
 */
export function useAgentTeamRosterImport({
  enabled,
  storageScope,
  route,
  lead,
  sessions
}: RosterImportInput): void {
  const threadRoute =
    enabled &&
    lead &&
    !lead.teamLeadId &&
    route?.channel === 'canvas' &&
    route.scopeType === 'thread' &&
    route.scopeId &&
    route.threadId
      ? {
          channel: route.channel,
          scopeType: route.scopeType,
          scopeId: route.scopeId,
          threadId: route.threadId
        }
      : undefined
  const snapshot = threadRoute && lead ? legacyTeamSnapshot(lead, sessions) : undefined
  // Sent again only when the team's identity, its stored membership or its end changes.
  const key =
    threadRoute && lead && snapshot
      ? JSON.stringify([
          storageScope,
          threadRoute,
          lead.id,
          snapshot.members.map((member) => member.id),
          lead.teamEnded ?? false
        ])
      : ''
  useEffect(() => {
    if (!key || !threadRoute || !lead || !snapshot || imported.has(key)) return
    imported.add(key)
    const team = { scope: storageScope, thread: threadRoute.threadId, lead: lead.id }
    // A synchronous failure (no such service method) is a rejection like any other.
    Promise.resolve()
      .then(() =>
        api().svcLLMProxy.importAgentTeam({
          route: threadRoute,
          conversationId: lead.id,
          team,
          snapshot
        })
      )
      .catch(() => {
        // Unavailable, or a stored field MAIN does not accept: nothing is changed; a later change retries.
        imported.delete(key)
        if (!warned) console.warn('[TeamRoster] The stored team could not be handed to MAIN.')
        warned = true
      })
    // The key covers every input the request reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
