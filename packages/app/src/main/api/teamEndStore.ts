import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getBuildEnv } from '../config/buildEnv'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import type { LLMTeamIdentity, LLMTeamMember } from '@shared/api/svcLLMProxy'

const KIND = 'llm-team-ended-v1'
const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
function team(value: unknown): LLMTeamIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid team identity.')
  const input = value as LLMTeamIdentity
  if (!valid(input.scope) || !valid(input.thread) || !valid(input.lead)) throw new Error('Invalid team identity.')
  return { scope: input.scope, thread: input.thread, lead: input.lead }
}
function key(id: LLMTeamIdentity): string { return createHash('sha256').update(JSON.stringify([id.scope, id.thread, id.lead])).digest('hex') }

/** Functional gate for honest renderers, NOT IPC identity/authorization. Missing
 * marker means active. No cross-process fence, legacy migration or rollback defense. */
export class TeamEndStore {
  constructor(private readonly store: MagicAgentEventStore) {}
  assertActive(value: unknown): void {
    const id = team(value), member = (value as LLMTeamMember).member
    if (!valid(member) || member === id.lead) throw new Error('Invalid team member.')
    const row = this.store.getResource<unknown>(KIND, key(id), { includeDeleted: true })
    if (!row) return
    const state = row.state as (LLMTeamIdentity & { ended?: unknown }) | null
    if (row.deleted || !state || state.scope !== id.scope || state.thread !== id.thread || state.lead !== id.lead || state.ended !== true) throw new Error('Invalid team End state.')
    throw new Error('Team has ended.')
  }
  end(value: unknown): { ended: true } {
    const id = team(value), resourceId = key(id)
    const row = this.store.getResource<unknown>(KIND, resourceId, { includeDeleted: true })
    if (row) {
      const state = row.state as (LLMTeamIdentity & { ended?: unknown }) | null
      if (row.deleted || !state || state.scope !== id.scope || state.thread !== id.thread || state.lead !== id.lead || state.ended !== true) throw new Error('Invalid team End state.')
      return { ended: true }
    }
    const eventId = randomUUID(), createdAt = Date.now()
    const event = { protocolVersion: '2.0.0', id: eventId, type: 'team-ended', createdAt, payload: {}, envelopeKind: 'event' as const, streamId: `team-end:${resourceId}`, sequence: 0, resource: { kind: KIND, id: resourceId }, revision: 0 }
    this.store.mutateResource({ operation: 'create', kind: KIND, id: resourceId, state: { ...id, ended: true }, createdAt, idempotencyKey: `team-end:${eventId}`, event })
    return { ended: true }
  }
}
let singleton: TeamEndStore | undefined
export function getTeamEndStore(): TeamEndStore {
  if (!singleton) {
    const dir = join(getBuildEnv().pathMap.data, 'team-end')
    mkdirSync(dir, { recursive: true })
    singleton = new TeamEndStore(new MagicAgentEventStore(join(dir, 'ended.sqlite')))
  }
  return singleton
}
export function assertTeamRequestActive(req: { teamMember?: LLMTeamMember }): void {
  if (Object.hasOwn(req, 'teamMember')) getTeamEndStore().assertActive(req.teamMember)
}
