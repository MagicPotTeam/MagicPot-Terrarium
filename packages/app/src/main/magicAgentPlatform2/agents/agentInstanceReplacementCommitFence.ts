import {
  CooperativePauseSupersededError,
  type CooperativeExecutionController,
  type CooperativePauseTicket
} from './cooperativeExecutionController'

export type AgentInstanceReplacementOwner = Readonly<{
  controller: AbortController
  cooperativeExecution: CooperativeExecutionController
  phase: 'starting' | 'running' | 'finishing' | 'faulted'
  stopRequested: boolean
}>

export type AgentInstanceReplacementOwnership = {
  readonly active: ReadonlyMap<string, AgentInstanceReplacementOwner>
  closing: Promise<void> | undefined
}

type ReplacementFenceProof = Readonly<{
  ownership: AgentInstanceReplacementOwnership
  instanceId: string
  revision: number
  owner: AgentInstanceReplacementOwner | undefined
  ticket: CooperativePauseTicket | undefined
  idempotencyKey: string
}>

const proofs = new WeakMap<AgentInstanceReplacementCommitFence, ReplacementFenceProof>()

/**
 * MAIN-internal, concrete additional commit predicate, not policy authorization.
 * No arbitrary executable callback option is accepted by the store/transaction
 * layer. Construction is trusted MAIN-only: ownership/map/controller must be the
 * lifecycle's actual internal objects, not structurally supplied untrusted data.
 * This is not runtime validation of every possible MAIN-constructed backing map
 * or method. Lower persistence APIs already require trusted MAIN callers.
 * The WeakMap keeps the predicate independent of replaceable fence methods or
 * DTO fields; copies/proxies cannot manufacture a recognized fence.
 */
export class AgentInstanceReplacementCommitFence {
  constructor(proof: ReplacementFenceProof) {
    proofs.set(this, Object.freeze({ ...proof }))
    Object.freeze(this)
  }
}

/** Check after store callouts and again inside the transaction before COMMIT. */
export function assertAgentInstanceReplacementCommitFence(
  fence: AgentInstanceReplacementCommitFence,
  mutation: Readonly<{
    operation: string
    kind: string
    id: string
    expectedRevision?: number
    idempotencyKey: string
    event: Readonly<{ type: string }>
  }>
): void {
  const proof = proofs.get(fence)
  if (!proof || mutation.operation !== 'update' || mutation.kind !== 'agent-instance' ||
    mutation.event.type !== 'agent-instance.replaced' || mutation.id !== proof.instanceId ||
    mutation.expectedRevision !== proof.revision || mutation.idempotencyKey !== proof.idempotencyKey)
    throw new CooperativePauseSupersededError()
  const { ownership, instanceId, owner, ticket } = proof
  if (ownership.closing || ownership.active.get(instanceId) !== owner)
    throw new CooperativePauseSupersededError()
  if (owner && (owner.phase !== 'running' || owner.stopRequested || owner.controller.signal.aborted ||
    !ticket || !owner.cooperativeExecution.isPauseCurrent(ticket)))
    throw new CooperativePauseSupersededError()
}
