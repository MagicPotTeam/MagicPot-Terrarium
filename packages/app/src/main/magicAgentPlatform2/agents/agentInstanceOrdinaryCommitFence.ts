import type { MagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import { canonicalJson, type MagicAgentEventStore, type ResourceMutationInput } from '../persistence/eventStore'
import { assertAgentInstanceReplacementCommitFence, type AgentInstanceReplacementCommitFence } from './agentInstanceReplacementCommitFence'
import { hasManagedAgentInstanceEvidence, ManagedAgentOrdinaryAdmissionError } from './managedAgentInstanceIdentity'
import { assertManagedFirstRunCommitFence, isManagedFirstRunCommitFence, type ManagedFirstRunCommitFence } from './managedFirstRunCommitFence'

type MutationProof = Readonly<{
  events: MagicAgentEventStore
  canonical: string
  instanceIds: readonly string[]
  replacement?: AgentInstanceReplacementCommitFence
}>
const mutations = new WeakMap<AgentInstanceOrdinaryCommitFence, MutationProof>()
const receipts = new WeakMap<AgentInstanceOrdinaryEventCommitFence, Omit<MutationProof, 'replacement'>>()
const mutationMaterial = (input: ResourceMutationInput) => ({
  operation: input.operation, kind: input.kind, id: input.id, idempotencyKey: input.idempotencyKey,
  createdAt: input.createdAt, event: input.event,
  ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
  ...(input.operation === 'delete' ? {} : { state: input.state })
})
type IdentityRecord = Readonly<{ kind: string; id: string; state?: unknown }>
function idsFor(inputs: readonly IdentityRecord[]): readonly string[] {
  const ids = new Set<string>()
  for (const input of inputs) {
    if (input.kind !== 'agent-instance') throw new ManagedAgentOrdinaryAdmissionError()
    ids.add(input.id)
    if (input.state && typeof input.state === 'object') {
      const state = input.state as { id?: unknown; parentInstanceId?: unknown }
      for (const id of [state.id, state.parentInstanceId]) if (typeof id === 'string') ids.add(id)
    }
  }
  return Object.freeze([...ids])
}
function assertExcluded(proof: Omit<MutationProof, 'replacement'>, events: MagicAgentEventStore, canonical: string): void {
  if (proof.events !== events || proof.canonical !== canonical) throw new ManagedAgentOrdinaryAdmissionError()
  for (const id of proof.instanceIds)
    if (hasManagedAgentInstanceEvidence(events, id)) throw new ManagedAgentOrdinaryAdmissionError()
}

/** Concrete additional MAIN predicate, never authority or an executable callback. */
export class AgentInstanceOrdinaryCommitFence {
  constructor(events: MagicAgentEventStore, inputs: readonly ResourceMutationInput[], replacement?: AgentInstanceReplacementCommitFence) {
    const canonical = canonicalJson(inputs.map(mutationMaterial))
    // Only detached, already-materialized data is inspected for exclusion IDs.
    const instanceIds = idsFor(JSON.parse(canonical) as ResourceMutationInput[])
    mutations.set(this, Object.freeze({ events, canonical, instanceIds, replacement }))
    Object.freeze(this)
  }
}
export type AgentInstanceMutationCommitFence = AgentInstanceReplacementCommitFence | AgentInstanceOrdinaryCommitFence | ManagedFirstRunCommitFence
export function assertAgentInstanceMutationCommitFence(
  fence: AgentInstanceMutationCommitFence, events: MagicAgentEventStore, inputs: readonly ResourceMutationInput[]
): void {
  if (isManagedFirstRunCommitFence(fence)) {
    assertManagedFirstRunCommitFence(fence, events, inputs)
    return
  }
  const proof = mutations.get(fence as AgentInstanceOrdinaryCommitFence)
  if (proof) {
    assertExcluded(proof, events, canonicalJson(inputs.map(mutationMaterial)))
    if (proof.replacement) {
      if (inputs.length !== 1) throw new ManagedAgentOrdinaryAdmissionError()
      assertAgentInstanceReplacementCommitFence(proof.replacement, inputs[0])
    }
    return
  }
  // Preserve the existing direct replacement-fence API; unknown/copy/proxy
  // objects are rejected by its private identity map, never treated as no fence.
  if (inputs.length !== 1) throw new ManagedAgentOrdinaryAdmissionError()
  assertAgentInstanceReplacementCommitFence(fence as AgentInstanceReplacementCommitFence, inputs[0])
}

/** Post-COMMIT observation must not re-impose a consumed/live pause lease. */
export function assertAgentInstanceOrdinaryMutationResult(
  fence: AgentInstanceOrdinaryCommitFence, events: MagicAgentEventStore, inputs: readonly ResourceMutationInput[]
): void {
  const proof = mutations.get(fence)
  if (!proof) throw new ManagedAgentOrdinaryAdmissionError()
  assertExcluded(proof, events, canonicalJson(inputs.map(mutationMaterial)))
}

/** Only the immutable ordinary lifecycle-noop receipt may use this event fence. */
export class AgentInstanceOrdinaryEventCommitFence {
  constructor(events: MagicAgentEventStore, inputs: readonly MagicAgentEvent<unknown>[], instanceId: string) {
    const canonical = canonicalJson(inputs), detached = JSON.parse(canonical) as MagicAgentEvent<unknown>[]
    if (detached.length !== 1 || detached[0].type !== 'agent-instance.lifecycle-noop-completed' || detached[0].extensions?.instanceId !== instanceId)
      throw new ManagedAgentOrdinaryAdmissionError()
    const result = (detached[0].payload as { result?: IdentityRecord })?.result
    if (!result || result.id !== instanceId || (result.state as { id?: unknown } | undefined)?.id !== instanceId)
      throw new ManagedAgentOrdinaryAdmissionError()
    // The committed success snapshot is as important as its command identity.
    // Exclude its own and parent namespaces before append and final COMMIT too.
    receipts.set(this, Object.freeze({ events, canonical, instanceIds: idsFor([result]) }))
    Object.freeze(this)
  }
}
export function assertAgentInstanceOrdinaryEventCommitFence(
  fence: AgentInstanceOrdinaryEventCommitFence, events: MagicAgentEventStore, inputs: readonly MagicAgentEvent<unknown>[]
): void {
  const proof = receipts.get(fence)
  if (!proof) throw new ManagedAgentOrdinaryAdmissionError()
  assertExcluded(proof, events, canonicalJson(inputs))
}
