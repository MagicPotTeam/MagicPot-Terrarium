import type {
  CooperativeExecutionKind,
  CooperativeOperationGate
} from '../magicAgentPlatform2/agents/cooperativeExecutionController'

/**
 * MAIN-owned result capture around the void-only callback gate. This never falls
 * back to split checkpoint/enter, and bounds callback settlement, not external
 * effects that outlive an abort/timeout wrapper.
 */
export async function withCooperativeOperation<T>(
  gate: CooperativeOperationGate | undefined,
  kind: CooperativeExecutionKind,
  signal: AbortSignal | undefined,
  operation: (children: CooperativeOperationGate | undefined) => Promise<T>
): Promise<T> {
  if (!gate) {
    signal?.throwIfAborted()
    return operation(undefined)
  }
  let result!: T
  await gate.run(kind, signal, async children => {
    // The controller checks ancestry/staleness first. Keep the local guard inside
    // admission so a defensive custom MAIN gate cannot dispatch after cancellation.
    signal?.throwIfAborted()
    result = await operation(children)
  })
  return result
}
