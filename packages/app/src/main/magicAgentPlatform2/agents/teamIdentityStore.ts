import { createHash, randomUUID } from 'node:crypto'
import type { MagicAgentEventStore, ResourceMutationInput, StoredResource } from '../persistence/eventStore'

const TEAM = 'team-identity-v1'
const MEMBER = 'team-member-index-v1'
const ROLE = 'team-participant-role-v1'
const validId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 512 && x.trim() === x && !Array.from(x).some(c => c.charCodeAt(0) < 32)
const hash = (tuple: readonly string[]): string => createHash('sha256').update(JSON.stringify(tuple)).digest('hex')
export type TeamIdentity = Readonly<{ scope: string; thread: string; lead: string }>
type State = { version: 1; scope: string; thread: string; lead: string; generation: number; members: string[]; ended: boolean }
type Index = { version: 1; scope: string; thread: string; lead: string; generation: number; member: string; ended: boolean }
type Role = { version: 1; scope: string; thread: string; lead: string; generation: number; participant: string; role: 'lead' | 'member' }
const teamKey = (x: TeamIdentity) => hash([x.scope, x.thread, x.lead])
const memberKey = (x: TeamIdentity, member: string) => hash([x.scope, x.thread, member])
function identity(x: TeamIdentity): TeamIdentity {
  if (!x || !validId(x.scope) || !validId(x.thread) || !validId(x.lead)) throw Error('Invalid team identity.')
  return { scope: x.scope, thread: x.thread, lead: x.lead }
}
function generation(n: unknown): n is number { return Number.isSafeInteger(n) && Number(n) > 0 }
function validateState(value: unknown, id: TeamIdentity): asserts value is State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid team state.')
  const s = value as State
  if (s.version !== 1 || s.scope !== id.scope || s.thread !== id.thread || s.lead !== id.lead || !generation(s.generation) || typeof s.ended !== 'boolean' || !Array.isArray(s.members) || s.members.length < 1 || s.members.length > 128 || !s.members.every(validId) || s.members.includes(s.lead) || new Set(s.members).size !== s.members.length) throw Error('Invalid team state.')
}
function validateIndex(value: unknown, s: State, member: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid member index.')
  const i = value as Index
  if (i.version !== 1 || i.scope !== s.scope || i.thread !== s.thread || i.lead !== s.lead || i.member !== member || i.generation !== s.generation || i.ended !== s.ended) throw Error('Invalid member index.')
}
function mutation(kind: string, id: string, state: State | Index | Role, revision?: number): ResourceMutationInput {
  const eventId = randomUUID(), createdAt = Date.now(), next = revision === undefined ? 0 : revision + 1
  const event = { protocolVersion: '2.0.0', id: eventId, type: 'team-identity.changed', createdAt, payload: {}, envelopeKind: 'event' as const, streamId: `${kind}:${id}:stream`, sequence: next, resource: { kind, id }, revision: next }
  return { operation: revision === undefined ? 'create' : 'update', kind, id, ...(revision === undefined ? {} : { expectedRevision: revision }), state, createdAt, idempotencyKey: `team-identity:${eventId}`, event }
}

/**
 * Unwired MAIN storage only: caller MUST independently authenticate and own all
 * identity inputs; renderer data is not authority. No IPC, dispatch or permission.
 * Single batch/CAS protects controlled API operations and normal reopen only.
 * A restored/deleted/rolled-back database, arbitrary writers, and cross-process
 * ownership are NOT protected. The host must enforce a single trusted owner.
 * Membership is immutable and ended teams cannot be recreated by this API.
 * Existing v1 rows without matching role reservations cannot be read or ended;
 * no automatic legacy migration is attempted. All old writers MUST be retired
 * before use: legacy-key prechecks are not atomic against old or bypass writers.
 * Permanent reservations also prevent re-team after End and member additions.
 */
export class TeamIdentityStore {
  private busy = false
  private poisoned = false
  constructor(private readonly store: MagicAgentEventStore) {}
  private run<T>(fn: () => T): T {
    if (this.busy || this.poisoned) throw Error('Team identity store unavailable.')
    this.busy = true
    try { return fn() } finally { this.busy = false }
  }
  private load(id: TeamIdentity): { team: StoredResource<unknown>; state: State; indices: StoredResource<unknown>[] } {
    const team = this.store.getResource(TEAM, teamKey(id), { includeDeleted: true })
    if (!team || team.deleted) throw Error('Unknown team.')
    validateState(team.state, id)
    const state = team.state
    for (const participant of [state.lead, ...state.members]) {
      const role = this.store.getResource<unknown>(ROLE, memberKey(id, participant), { includeDeleted: true })
      const expected = participant === state.lead ? 'lead' : 'member'
      if (!role || role.deleted || !role.state || typeof role.state !== 'object' || Array.isArray(role.state)) throw Error('Missing participant role.')
      const value = role.state as Role
      if (value.version !== 1 || value.scope !== state.scope || value.thread !== state.thread || value.lead !== state.lead || value.generation !== state.generation || value.participant !== participant || value.role !== expected) throw Error('Invalid participant role.')
    }
    const indices = state.members.map(member => {
      const row = this.store.getResource(MEMBER, memberKey(id, member), { includeDeleted: true })
      if (!row || row.deleted) throw Error('Missing member index.')
      validateIndex(row.state, state, member)
      return row
    })
    return { team, state, indices }
  }
  private commit(commands: ResourceMutationInput[]): void {
    try { this.store.mutateResourcesBatch(commands) } catch (error) { this.poisoned = true; throw error }
  }
  create(input: TeamIdentity, epoch: number, memberIds: readonly string[]): void {
    this.run(() => {
      const id = identity(input)
      if (!Array.isArray(memberIds)) throw Error('Invalid members.')
      const state: State = { version: 1, ...id, generation: epoch, members: [...memberIds], ended: false }
      validateState(state, id)
      if (this.store.hasResourceEvidence(TEAM, teamKey(id))) throw Error('Team already exists.')
      for (const member of state.members) if (this.store.hasResourceEvidence(MEMBER, memberKey(id, member))) throw Error('Member already assigned.')
      // Legacy rows lack role reservations: check their old keys as well. These
      // checks only cover immutable v1 history; the ROLE creates in the same
      // batch, not these checks, arbitrate concurrent controlled new writers.
      if (this.store.hasResourceEvidence(MEMBER, memberKey(id, id.lead))) throw Error('Lead already assigned as member.')
      for (const member of state.members) if (this.store.hasResourceEvidence(TEAM, teamKey({ ...id, lead: member }))) throw Error('Member already assigned as lead.')
      const roles: ResourceMutationInput[] = [id.lead, ...state.members].map(participant => mutation(ROLE, memberKey(id, participant), { version: 1, ...id, generation: epoch, participant, role: participant === id.lead ? 'lead' : 'member' }))
      this.commit([mutation(TEAM, teamKey(id), state), ...state.members.map(member => mutation(MEMBER, memberKey(id, member), { version: 1, ...id, generation: epoch, member, ended: false })), ...roles])
    })
  }
  read(input: TeamIdentity): Readonly<State> {
    return this.run(() => { const { state } = this.load(identity(input)); return { ...state, members: [...state.members] } })
  }
  lookup(input: Pick<TeamIdentity, 'scope' | 'thread'>, member: string): Readonly<State> {
    return this.run(() => {
      if (!input || !validId(input.scope) || !validId(input.thread) || !validId(member)) throw Error('Invalid member identity.')
      const candidate = this.store.getResource(MEMBER, memberKey({ ...input, lead: '' }, member), { includeDeleted: true })
      if (!candidate || candidate.deleted || !candidate.state || typeof candidate.state !== 'object') throw Error('Unknown member.')
      const index = candidate.state as Index
      const id = identity({ ...input, lead: index.lead })
      const { state } = this.load(id)
      if (!state.members.includes(member)) throw Error('Invalid member index.')
      validateIndex(candidate.state, state, member)
      return { ...state, members: [...state.members] }
    })
  }
  end(input: TeamIdentity, expectedGeneration: number): void {
    this.run(() => {
      const id = identity(input), { team, state, indices } = this.load(id)
      if (!generation(expectedGeneration) || state.generation !== expectedGeneration) throw Error('Generation mismatch.')
      if (state.ended) return
      const next = { ...state, ended: true }
      this.commit([mutation(TEAM, teamKey(id), next, team.revision), ...state.members.map((member, i) => mutation(MEMBER, memberKey(id, member), { version: 1, ...id, generation: state.generation, member, ended: true }, indices[i].revision))])
    })
  }
}
