import type { AgentThreadInteractionScope } from './agentThreadInteraction'
import type { LLMTeamIdentity } from './svcLLMProxy'

/**
 * S6 team roster (KohakuTerrarium 2.2.3 graph manifest, MagicPot shape). MAIN owns it; it is data
 * only, never an authorization or a permission. Member conversations stay in the renderer's chat
 * storage: the roster only names them by session id.
 */

/** Same cap as the renderer's TEAM_MAX_MEMBERS (MagicPot decision: keep 6; KT's default is unlimited). */
export const AGENT_TEAM_MAX_MEMBERS = 6
export const AGENT_TEAM_MAX_CHANNELS = 16
export const AGENT_TEAM_MAX_WIRES = 32
export const AGENT_TEAM_ROSTER_VERSION = 1

/**
 * live: may run turns. paused / stopped: runs nothing and is shown as a dormant row. Who held it
 * decides who may undo it: a member the user held is resumed only by the user (S6-2/S6-3).
 * removed: no longer in the team; the conversation and its history stay.
 */
export type AgentTeamMemberState = 'live' | 'paused' | 'stopped' | 'removed'
/** restart: the app restarted (or the member came in by the legacy import) while the user had not held it. */
export type AgentTeamHolder = 'user' | 'agent' | 'restart'

export type AgentTeamMember = {
  /** The member's conversation (chat session) id. */
  id: string
  /** Display name and the name tools address it by: unique among the members still in the team. */
  name: string
  role: string
  /** A profile the user already has, by id; null uses the lead's model. */
  profileId: string | null
  state: AgentTeamMemberState
  /** Present exactly when state is paused or stopped. */
  heldBy?: AgentTeamHolder
  /** The member that spawned this one (group_spawn_child); absent for members the lead added. */
  parent?: string
  createdAt: number
}

export type AgentTeamChannel = { name: string; kind: 'queue' | 'broadcast'; description: string }
/** A group_wire output wire: from's turn output is delivered to `to`. A self-wire needs allowSelfTrigger. */
export type AgentTeamWire = { from: string; to: string; allowSelfTrigger: boolean }

export type AgentTeamRoster = {
  version: typeof AGENT_TEAM_ROSTER_VERSION
  team: LLMTeamIdentity
  /** The renderer's lead generation at import (teamGeneration). */
  generation: number
  ended: boolean
  members: AgentTeamMember[]
  channels: AgentTeamChannel[]
  wires: AgentTeamWire[]
  /** Where the roster came from: the one-time import of the renderer's chat storage fields, or MAIN. */
  origin: 'legacy-import' | 'main'
}

export type AgentTeamRosterView = { roster: AgentTeamRoster; revision: number }

/** Interaction scope (pane authorization) plus the team it asks about. */
export type AgentTeamScope = AgentThreadInteractionScope & { team: LLMTeamIdentity }

/**
 * The renderer's chat storage team fields of one lead and its members, as stored today
 * (chatStorage.ts teamLeadId / teamMemberName / teamRole / teamGeneration / teamMemberGeneration /
 * memberModelChoice / teamEnded). Read once into the roster; the fields themselves are not changed.
 */
export type AgentTeamLegacySnapshot = {
  lead: { id: string; teamGeneration?: number; teamEnded?: boolean }
  members: Array<{
    id: string
    teamLeadId: string
    title: string
    teamMemberName?: string
    teamRole?: string
    teamMemberGeneration?: number
    memberModelChoice?: { version: 1; profileId: string }
    archived?: boolean
    createdAt?: number
  }>
}
export type AgentTeamImportReq = AgentTeamScope & { snapshot: AgentTeamLegacySnapshot }
export type AgentTeamImportResp = AgentTeamRosterView & { imported: boolean }

const MEMBER_NAME = /^[\p{L}\p{N}_-]{1,32}$/u
const CHANNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const hasControl = (value: string) =>
  Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
export const isAgentTeamId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value &&
  !hasControl(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) < Number.MAX_SAFE_INTEGER
export const isAgentTeamMemberName = (value: unknown): value is string =>
  typeof value === 'string' && MEMBER_NAME.test(value)
const isRole = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 256 &&
  !hasControl(value)
const isProfileId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  !hasControl(value)

export function validateAgentTeamIdentity(value: unknown): asserts value is LLMTeamIdentity {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['scope', 'thread', 'lead']) ||
    ![value.scope, value.thread, value.lead].every(isAgentTeamId)
  )
    throw new Error('Invalid team identity.')
}

function validateMember(value: unknown, lead: string): asserts value is AgentTeamMember {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ['id', 'name', 'role', 'profileId', 'state', 'createdAt'],
      ['heldBy', 'parent']
    )
  )
    throw new Error('Invalid team member.')
  const held = value.state === 'paused' || value.state === 'stopped'
  if (
    !isAgentTeamId(value.id) ||
    value.id === lead ||
    !isAgentTeamMemberName(value.name) ||
    !isRole(value.role) ||
    (value.profileId !== null && !isProfileId(value.profileId)) ||
    !['live', 'paused', 'stopped', 'removed'].includes(value.state as string) ||
    held !== Object.hasOwn(value, 'heldBy') ||
    (held && !['user', 'agent', 'restart'].includes(value.heldBy as string)) ||
    (Object.hasOwn(value, 'parent') &&
      (!isAgentTeamId(value.parent) || value.parent === value.id)) ||
    !isCount(value.createdAt)
  )
    throw new Error('Invalid team member.')
}

/** Strict: own plain properties only, no extra keys, bounded, unique ids, unique names among members still in the team. */
export function validateAgentTeamRoster(value: unknown): asserts value is AgentTeamRoster {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'team',
      'generation',
      'ended',
      'members',
      'channels',
      'wires',
      'origin'
    ])
  )
    throw new Error('Invalid team roster.')
  if (
    value.version !== AGENT_TEAM_ROSTER_VERSION ||
    !isCount(value.generation) ||
    typeof value.ended !== 'boolean' ||
    !['legacy-import', 'main'].includes(value.origin as string)
  )
    throw new Error('Invalid team roster.')
  validateAgentTeamIdentity(value.team)
  const lead = value.team.lead
  if (
    !Array.isArray(value.members) ||
    !Array.isArray(value.channels) ||
    !Array.isArray(value.wires)
  )
    throw new Error('Invalid team roster.')
  // Removed members keep their row (history, names of past senders) but leave the cap; the total is bounded anyway.
  if (value.members.length > AGENT_TEAM_MAX_MEMBERS * 8) throw new Error('Invalid team roster.')
  for (const member of value.members) validateMember(member, lead)
  const members = value.members as AgentTeamMember[]
  const present = members.filter((member) => member.state !== 'removed')
  if (
    present.length > AGENT_TEAM_MAX_MEMBERS ||
    new Set(members.map((m) => m.id)).size !== members.length ||
    new Set(present.map((m) => m.name)).size !== present.length ||
    members.some((m) => m.parent !== undefined && !members.some((other) => other.id === m.parent))
  )
    throw new Error('Invalid team members.')
  if (value.channels.length > AGENT_TEAM_MAX_CHANNELS) throw new Error('Invalid team channels.')
  for (const channel of value.channels) {
    if (
      !isRecord(channel) ||
      !exactKeys(channel, ['name', 'kind', 'description']) ||
      typeof channel.name !== 'string' ||
      !CHANNEL_NAME.test(channel.name) ||
      !['queue', 'broadcast'].includes(channel.kind as string) ||
      typeof channel.description !== 'string' ||
      channel.description.length > 512 ||
      hasControl(channel.description)
    )
      throw new Error('Invalid team channels.')
  }
  if (
    new Set((value.channels as AgentTeamChannel[]).map((c) => c.name)).size !==
    value.channels.length
  )
    throw new Error('Invalid team channels.')
  if (value.wires.length > AGENT_TEAM_MAX_WIRES) throw new Error('Invalid team wires.')
  const ends = new Set([lead, ...members.map((m) => m.id)])
  for (const wire of value.wires) {
    if (
      !isRecord(wire) ||
      !exactKeys(wire, ['from', 'to', 'allowSelfTrigger']) ||
      !ends.has(wire.from as string) ||
      !ends.has(wire.to as string) ||
      typeof wire.allowSelfTrigger !== 'boolean' ||
      (wire.from === wire.to && wire.allowSelfTrigger !== true)
    )
      throw new Error('Invalid team wires.')
  }
  if (
    new Set((value.wires as AgentTeamWire[]).map((w) => `${w.from}\u0000${w.to}`)).size !==
    value.wires.length
  )
    throw new Error('Invalid team wires.')
}

/**
 * The roster a legacy snapshot describes, exactly as the renderer shows the team today: members of
 * this lead, not archived, of the lead's current generation. Members come in held by 'restart'
 * (dormant): nothing ran before the import and nothing runs because of it. Throws on any field the
 * renderer could not have stored; the import then does nothing and the old fields stay in use.
 */
export function agentTeamRosterFromLegacy(
  team: LLMTeamIdentity,
  snapshot: unknown,
  now: number
): AgentTeamRoster {
  validateAgentTeamIdentity(team)
  if (
    !isRecord(snapshot) ||
    !exactKeys(snapshot, ['lead', 'members']) ||
    !isRecord(snapshot.lead) ||
    !Array.isArray(snapshot.members)
  )
    throw new Error('Invalid legacy team.')
  const lead = snapshot.lead
  if (
    !exactKeys(lead, ['id'], ['teamGeneration', 'teamEnded']) ||
    lead.id !== team.lead ||
    (lead.teamGeneration !== undefined && !isCount(lead.teamGeneration)) ||
    (lead.teamEnded !== undefined && typeof lead.teamEnded !== 'boolean') ||
    snapshot.members.length > 256
  )
    throw new Error('Invalid legacy team.')
  const generation = (lead.teamGeneration as number | undefined) ?? 0
  const members: AgentTeamMember[] = []
  for (const raw of snapshot.members) {
    if (
      !isRecord(raw) ||
      !exactKeys(
        raw,
        ['id', 'teamLeadId', 'title'],
        [
          'teamMemberName',
          'teamRole',
          'teamMemberGeneration',
          'memberModelChoice',
          'archived',
          'createdAt'
        ]
      ) ||
      !isAgentTeamId(raw.id) ||
      raw.teamLeadId !== team.lead ||
      typeof raw.title !== 'string' ||
      (raw.teamMemberGeneration !== undefined && !isCount(raw.teamMemberGeneration)) ||
      (raw.archived !== undefined && typeof raw.archived !== 'boolean') ||
      (raw.createdAt !== undefined && !isCount(raw.createdAt)) ||
      (raw.teamRole !== undefined && typeof raw.teamRole !== 'string')
    )
      throw new Error('Invalid legacy team member.')
    if (raw.archived || ((raw.teamMemberGeneration as number | undefined) ?? 0) !== generation)
      continue
    const choice = raw.memberModelChoice
    if (
      choice !== undefined &&
      (!isRecord(choice) ||
        !exactKeys(choice, ['version', 'profileId']) ||
        choice.version !== 1 ||
        !isProfileId(choice.profileId))
    )
      throw new Error('Invalid legacy team member.')
    const name = raw.teamMemberName ?? raw.title
    // The renderer checks only trim and length (a pasted tab passes): the roster's copy turns control
    // characters into spaces, so every role the renderer could have stored imports.
    const cleanRole =
      typeof raw.teamRole === 'string'
        ? Array.from(raw.teamRole, (c) =>
            c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c
          )
            .join('')
            .replace(/ {2,}/g, ' ')
            .trim()
        : ''
    const role = cleanRole || 'team member'
    if (!isAgentTeamMemberName(name) || !isRole(role))
      throw new Error('Invalid legacy team member.')
    members.push({
      id: raw.id,
      name,
      role,
      profileId: choice ? (choice.profileId as string) : null,
      state: 'stopped',
      heldBy: 'restart',
      createdAt: (raw.createdAt as number | undefined) ?? now
    })
  }
  const ended = lead.teamEnded === true
  const roster: AgentTeamRoster = {
    version: AGENT_TEAM_ROSTER_VERSION,
    team: { scope: team.scope, thread: team.thread, lead: team.lead },
    generation,
    ended,
    members: ended ? [] : members,
    channels: [],
    wires: [],
    origin: 'legacy-import'
  }
  validateAgentTeamRoster(roster)
  return roster
}
