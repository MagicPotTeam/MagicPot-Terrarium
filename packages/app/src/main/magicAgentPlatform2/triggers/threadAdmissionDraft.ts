import { createHash } from 'node:crypto'
import type { MagicAgentEventStore, ResourceMutationInput } from '../persistence/eventStore'

/** TEST-ONLY unwired domain sketch: owner and approval verifier are NOT production authority. */
export const DRAFT_KIND = 'agent-thread-admission-draft-v1'
type State = { version: 1; owner: string; task: string; fireAt: number; approval: 'staged' | 'active' | 'revoked'; paused: boolean; delivery: 'none' | 'claimed' | 'unknown'; claimId?: string }
type Verifier = (owner: string, task: string, fireAt: number) => boolean
const valid = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512 && s.trim() === s
const timestamp = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0
const key = (owner: string) => createHash('sha256').update(JSON.stringify(['draft-v1', owner])).digest('hex')
function check(state: unknown, owner: string): asserts state is State {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('Invalid draft.')
  const s = state as State
  if (Object.keys(s).some(k => !['version', 'owner', 'task', 'fireAt', 'approval', 'paused', 'delivery', 'claimId'].includes(k)) || s.version !== 1 || s.owner !== owner || !valid(s.task) || !timestamp(s.fireAt) || !['staged','active','revoked'].includes(s.approval) || typeof s.paused !== 'boolean' || !['none','claimed','unknown'].includes(s.delivery) || (s.delivery === 'none' ? s.claimId !== undefined : !valid(s.claimId))) throw Error('Invalid draft.')
}
export class ThreadAdmissionDraft {
  constructor(private readonly db: MagicAgentEventStore, private readonly verifyFakeApproval: Verifier) {}
  private read(owner: string) {
    if (!valid(owner)) throw Error('Invalid owner.')
    const id = key(owner), row = this.db.getResource<unknown>(DRAFT_KIND, id, { includeDeleted: true })
    if (!row) { if (this.db.hasResourceEvidence(DRAFT_KIND, id)) throw Error('Unavailable draft.'); return { id } }
    if (row.deleted) throw Error('Unavailable draft.')
    check(row.state, owner)
    return { id, state: row.state, revision: row.revision }
  }
  private write(id: string, state: State, revision: number | undefined, eventId: string, at: number): void {
    if (!valid(eventId) || !timestamp(at)) throw Error('Invalid mutation.')
    const next = revision === undefined ? 0 : revision + 1
    const event = { protocolVersion: '2.0.0', id: `draft:${eventId}`, type: 'thread-admission-draft.changed', createdAt: at, payload: {}, envelopeKind: 'event' as const, streamId: `${DRAFT_KIND}:${id}:stream`, sequence: next, resource: { kind: DRAFT_KIND, id }, revision: next }
    const command: ResourceMutationInput = { operation: revision === undefined ? 'create' : 'update', kind: DRAFT_KIND, id, state, ...(revision === undefined ? {} : { expectedRevision: revision }), idempotencyKey: `draft:${eventId}`, createdAt: at, event }
    this.db.mutateResource(command)
  }
  stage(owner: string, task: string, fireAt: number, eventId: string, at: number): void {
    const current = this.read(owner)
    if (current.state || !valid(task) || !timestamp(fireAt)) throw Error('Invalid or existing draft.')
    this.write(current.id, { version: 1, owner, task, fireAt, approval: 'staged', paused: false, delivery: 'none' }, undefined, eventId, at)
  }
  inspect(owner: string): Readonly<State> | undefined { return this.read(owner).state }
  approve(owner: string, eventId: string, at: number): void {
    const current = this.read(owner), state = current.state
    if (!state || state.approval !== 'staged' || !this.verifyFakeApproval(owner, state.task, state.fireAt)) throw Error('Approval unavailable.')
    this.write(current.id, { ...state, approval: 'active' }, current.revision, eventId, at)
  }
  setPaused(owner: string, paused: boolean, eventId: string, at: number): void {
    const current = this.read(owner), state = current.state
    if (!state || state.approval !== 'active' || typeof paused !== 'boolean') throw Error('Draft unavailable.')
    this.write(current.id, { ...state, paused }, current.revision, eventId, at)
  }
  revoke(owner: string, eventId: string, at: number): void {
    const current = this.read(owner), state = current.state
    if (!state || state.approval === 'revoked') throw Error('Draft unavailable.')
    this.write(current.id, { ...state, approval: 'revoked' }, current.revision, eventId, at)
  }
  admit(owner: string, mode: 'manual' | 'tick', claimId: string, eventId: string, at: number): void {
    const current = this.read(owner), state = current.state
    if (!state || !['manual','tick'].includes(mode) || !timestamp(at) || !valid(claimId) || state.approval !== 'active' || state.paused || state.delivery !== 'none' || (mode === 'tick' && at < state.fireAt)) throw Error('Admission denied.')
    this.write(current.id, { ...state, delivery: 'claimed', claimId }, current.revision, eventId, at)
  }
  markUnknown(owner: string, claimId: string, eventId: string, at: number): void {
    const current = this.read(owner), state = current.state
    if (!state || state.delivery !== 'claimed' || state.claimId !== claimId) throw Error('Claim mismatch.')
    this.write(current.id, { ...state, delivery: 'unknown' }, current.revision, eventId, at)
  }
}
