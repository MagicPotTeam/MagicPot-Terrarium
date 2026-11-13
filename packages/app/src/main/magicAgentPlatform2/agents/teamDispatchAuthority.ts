import { createHash, randomUUID } from 'node:crypto'
import type { MagicAgentEventStore } from '../persistence/eventStore'

const KIND = 'team-dispatch-authority'
const owners = new WeakSet<MagicAgentEventStore>()
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
type Team = { version: 1; scope: string; generation: number; members: string[]; ended: boolean }
export type TeamMemberBinding = Readonly<{ scope: string; generation: number; member: string }>

function validId(value: unknown): value is string { return typeof value === 'string' && idPattern.test(value) }
function validGeneration(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function key(scope: string): string { return createHash('sha256').update(scope).digest('hex') }
function validateTeam(value: unknown, scope: string): asserts value is Team {
  if (!value || typeof value !== 'object') throw new Error('Invalid team authority state.')
  const t = value as Team
  if (t.version !== 1 || t.scope !== scope || !validGeneration(t.generation) || typeof t.ended !== 'boolean' || !Array.isArray(t.members) || t.members.length < 1 || t.members.length > 128 || !t.members.every(validId) || new Set(t.members).size !== t.members.length) throw new Error('Invalid team authority state.')
}

/**
 * Unwired MAIN-only building block, NOT IPC authorization. The owning trusted
 * runtime must be the sole authority writer and sole sender for this store in
 * the entire application, and must authenticate every lifecycle command and
 * binding. Do not expose these methods or a dispatch callback to a renderer.
 * The callback must synchronously START the actual transport before returning;
 * it must not queue an async preflight before sending. No detachable permit is
 * issued. Active callbacks are not aborted by end. Restored/rolled-back storage,
 * another process/writer, direct provider calls, and authorization are outside
 * this component's guarantees. Keep production members disabled until wired.
 */
export class TeamDispatchAuthority {
  private busy = false
  private poisoned = false
  constructor(private readonly store: MagicAgentEventStore) {
    if (owners.has(store)) throw new Error('Team authority store already owned.')
    owners.add(store)
  }

  private exclusive<T>(fn: () => T): T {
    if (this.busy || this.poisoned) throw new Error('Team authority unavailable.')
    this.busy = true
    try { return fn() } finally { this.busy = false }
  }

  private read(scope: string): { state: Team; revision: number } {
    if (!validId(scope)) throw new Error('Invalid team scope.')
    const resource = this.store.getResource<unknown>(KIND, key(scope), { includeDeleted: true })
    if (!resource || resource.deleted) throw new Error('Team authority missing.')
    validateTeam(resource.state, scope)
    return { state: resource.state, revision: resource.revision }
  }

  private write(state: Team, revision?: number): void {
    const id = key(state.scope), time = Date.now(), eventId = randomUUID()
    const event = { protocolVersion: '2.0.0', id: eventId, type: 'team-authority.changed', createdAt: time,
      payload: { ended: state.ended }, envelopeKind: 'event' as const, streamId: `team-authority:${id}`,
      sequence: revision === undefined ? 0 : revision + 1, resource: { kind: KIND, id },
      revision: revision === undefined ? 0 : revision + 1 }
    try {
      this.store.mutateResource({
        operation: revision === undefined ? 'create' : 'update', kind: KIND, id,
        ...(revision === undefined ? {} : { expectedRevision: revision }),
        idempotencyKey: `team-authority:${eventId}`, state, createdAt: time,
        event
      })
    } catch (error) { this.poisoned = true; throw error }
  }

  /** Trusted runtime only; deliberately no reset/reopen API for an ended scope. */
  create(scope: string, generation: number, members: readonly string[]): void {
    this.exclusive(() => {
      if (!validId(scope) || !validGeneration(generation) || !Array.isArray(members)) throw new Error('Invalid team authority input.')
      const state: Team = { version: 1, scope, generation, members: [...members], ended: false }
      validateTeam(state, scope)
      if (this.store.getResource(KIND, key(scope), { includeDeleted: true })) throw new Error('Team already exists.')
      this.write(state)
    })
  }

  end(scope: string, generation: number): void {
    this.exclusive(() => {
      const { state, revision } = this.read(scope)
      if (!validGeneration(generation) || state.generation !== generation) throw new Error('Team generation mismatch.')
      if (!state.ended) this.write({ ...state, ended: true }, revision)
    })
  }

  dispatch<T>(binding: TeamMemberBinding, startTransport: () => T): T {
    return this.exclusive(() => {
      if (!binding || !validId(binding.scope) || !validId(binding.member) || !validGeneration(binding.generation) || typeof startTransport !== 'function') throw new Error('Invalid member binding.')
      const { state } = this.read(binding.scope)
      if (state.ended || state.generation !== binding.generation || !state.members.includes(binding.member)) throw new Error('Team member dispatch denied.')
      return startTransport()
    })
  }
}
