import type { MagicAgentEventStore, ResourceMutationInput, StoredResource } from '../persistence/eventStore'
import type { ManagedExecutionIdentity } from './persistentManagedAgentExecutionStore'
import { captureManagedData, invalidManagedRecording as invalid, managedCanonical as canonical, managedDigest } from './managedRuntimeSnapshot'

export const MANAGED_RUNTIME_INGRESS_KIND = 'managed-runtime-ingress'
export type ManagedRuntimeIngressRecord = Readonly<{
  protocolVersion: 1
  identity: ManagedExecutionIdentity
  runtimeRunId: string
  ingressProtocol: 'assistant-ingress/v1'
  ingressDigest: string
  routeCanonical: string
  sessionKey: string
}>
export const managedRuntimeIngressId = (identity: ManagedExecutionIdentity): string => `managed-runtime-ingress:${managedDigest('managed-runtime-ingress-key/v1', [identity.instanceId, identity.generation, identity.attemptId])}`
const plan = (state: ManagedRuntimeIngressRecord, at: number): ResourceMutationInput => {
  const id = managedRuntimeIngressId(state.identity)
  return { operation: 'create', kind: MANAGED_RUNTIME_INGRESS_KIND, id, state, createdAt: at, idempotencyKey: `${id}:create`, event: {
    protocolVersion: '2.0.0', id: `${id}:event`, type: 'managed-runtime.ingress-recorded', createdAt: at,
    envelopeKind: 'event', streamId: `${id}:stream`, sequence: 0, payload: { recordDigest: managedDigest('managed-runtime-ingress-record/v1', state) }
  } }
}
/** Exact receipt evidence only. Never reconstructs any runnable in-memory lease. */
export function readManagedRuntimeIngress(events: MagicAgentEventStore, identity: ManagedExecutionIdentity): StoredResource<ManagedRuntimeIngressRecord> | undefined {
  const id = managedRuntimeIngressId(identity), row = events.getResource<ManagedRuntimeIngressRecord>(MANAGED_RUNTIME_INGRESS_KIND, id, { includeDeleted: true })
  if (!row) return undefined
  const state = captureManagedData(row.state)
  if (row.deleted || row.revision !== 0 || row.updatedAt !== row.createdAt || canonical(Object.keys(state).sort()) !== canonical(['protocolVersion', 'identity', 'runtimeRunId', 'ingressProtocol', 'ingressDigest', 'routeCanonical', 'sessionKey'].sort()) || state.protocolVersion !== 1 || canonical(state.identity) !== canonical(identity) || state.ingressProtocol !== 'assistant-ingress/v1' || !/^[a-f0-9]{64}$/.test(state.ingressDigest) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(state.runtimeRunId) || typeof state.routeCanonical !== 'string' || !state.routeCanonical || state.routeCanonical.length > 16384 || state.sessionKey !== identity.sessionKey) invalid('runtime ingress record identity')
  const recipe = plan(state, row.createdAt), receipt = events.getResourceMutation(recipe.idempotencyKey), event = events.getEvent(recipe.event.id)
  if (!receipt || receipt.operation !== 'create' || receipt.expectedRevision !== undefined || receipt.eventId !== recipe.event.id || receipt.createdAt !== row.createdAt || canonical(receipt.resource) !== canonical(row) || canonical(event) !== canonical(recipe.event)) invalid('runtime ingress exact receipt conflict')
  return row
}
/** Coordinator already checks concrete exact fresh attempt + dirty coverage before and after. */
export function insertManagedRuntimeIngress(events: MagicAgentEventStore, state: ManagedRuntimeIngressRecord): StoredResource<ManagedRuntimeIngressRecord> {
  state = captureManagedData(state)
  if (readManagedRuntimeIngress(events, state.identity)) invalid('runtime ingress already recorded; replay is not execution permission')
  const results = events.mutateResourcesBatch([plan(state, Date.now())])
  if (!results[0].inserted) invalid('runtime ingress fresh insert required')
  const saved = readManagedRuntimeIngress(events, state.identity)
  if (!saved || canonical(saved.state) !== canonical(state)) invalid('runtime ingress publication conflict')
  return saved
}
