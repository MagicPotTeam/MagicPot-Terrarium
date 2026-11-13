import type { ChatSession } from './chatStorage'
export function memberActivity(member: ChatSession, running: boolean) {
  const tool = member.messages.flatMap(message=>message.toolHistory??[]).at(-1)
  return { tool:tool?.toolName??'', failed:tool?.status==='failed'&&!running,
    status:running ? tool?.status==='running' ? tool.toolName : '运行中' : tool?.status==='failed' ? '出错' : '空闲' }
}
export const TEAM_MAX_MEMBERS = 6

/** Legacy defaultModel has never authorized member routing; require an explicit, bound selection. */
export function resolveMemberModelSelection(lead: ChatSession): string | null {
  const settings = lead.teamSettings
  if (settings === undefined) return null
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid team settings.')
  if (!Object.hasOwn(settings, 'memberModelSelection')) return null
  const choice = settings.memberModelSelection as unknown
  if (!choice || typeof choice !== 'object' || Array.isArray(choice) ||
      Object.keys(choice).length !== 2 || !Object.hasOwn(choice, 'version') || !Object.hasOwn(choice, 'profileId')) throw new Error('Invalid team model selection.')
  const { version, profileId } = choice as { version: unknown; profileId: unknown }
  const hasControlCharacter = typeof profileId === 'string' && Array.from(profileId).some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (version !== 1 || typeof profileId !== 'string' || !profileId.trim() || profileId !== profileId.trim() || profileId.length > 256 || hasControlCharacter) throw new Error('Invalid team model selection.')
  return profileId
}

/** Parse only a versioned explicit member-owned model choice. */
export function readMemberModelChoice(member: ChatSession): string | null {
  if (!Object.hasOwn(member, 'memberModelChoice')) return null
  const value: unknown = member.memberModelChoice
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'profileId')) throw new Error('Invalid member model choice.')
  const { version, profileId } = value as { version: unknown; profileId: unknown }
  if (version !== 1 || typeof profileId !== 'string' || !profileId || profileId !== profileId.trim() || profileId.length > 256 || Array.from(profileId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid member model choice.')
  return profileId
}

/** Preserve lead lifecycle/skill and use only an explicitly selected member model. */
export function resolveTeamRequestSettings(member: ChatSession, lead: ChatSession | undefined) {
  if (!member.teamLeadId || !lead || lead.id !== member.teamLeadId || lead.teamLeadId || lead.archived || lead.teamEnded || member.archived ||
      (member.teamMemberGeneration ?? 0) !== (lead.teamGeneration ?? 0)) {
    throw new Error('Team owner unavailable.')
  }
  const confirmedProfile = resolveMemberModelSelection(lead)
  if (confirmedProfile) throw new Error('Team model selection is not available yet.')
  return {
    skillId: lead.skillId ?? null,
    profileId: readMemberModelChoice(member) ?? lead.profileId ?? null
  }
}
export function resolveTeamRecipient(text: string, members: readonly ChatSession[]) {
  const match = /^@([^\s]+)\s+([\s\S]+)$/.exec(text)
  if (!match) return undefined
  const matching = members.filter(member => member.teamMemberName === match[1])
  if (matching.length !== 1 || !match[2].trim()) throw new Error('Choose one exact member name and a non-empty message.')
  return { session: matching[0], text: match[2] }
}
export function createTeamMember(lead: ChatSession, name: string, role: string, id: string, now: number): ChatSession {
  if (lead.teamLeadId || lead.teamEnded) throw new Error('Team unavailable.')
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name) || !role.trim() || role.length > 256) throw new Error('Invalid member name or role.')
  return { id, title:name, messages:[], profileId:lead.profileId, skillId:lead.skillId, createdAt:now,
    teamLeadId:lead.id, teamMemberName:name, teamRole:role.trim() }
}
