import type { ResourceMutationInput, MagicAgentEventStore } from '../persistence/eventStore'
import { AgentThreadTriggerDeliveryStore, type ThreadTriggerTarget, type ThreadTriggerCondition } from '../../api/agentThreadTriggerDeliveryStore'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { THREAD_TRIGGER_CANDIDATE_PREFIX } from './threadTriggerNamespace'

const PREFIX = THREAD_TRIGGER_CANDIDATE_PREFIX
const KIND = 'agent-thread-trigger-mapping-v1'
const safe = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x)
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype
const exact = (x: Record<string, unknown>, names: string[]) => Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x, k))
const validTime = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0
export type ThreadTriggerMapping = Readonly<{ version: 1; platformId: string; target: ThreadTriggerTarget; deliveryId: string; condition: ThreadTriggerCondition; status: 'staged' | 'deleted' }>
export type ThreadTriggerCandidate = { kind: 'ordinary-candidate' } | { kind: 'thread-candidate'; mapping: ThreadTriggerMapping } | { kind: 'broken' }

function validate(mapping: unknown): asserts mapping is ThreadTriggerMapping {
  if (!obj(mapping) || !exact(mapping, ['version', 'platformId', 'target', 'deliveryId', 'condition', 'status']) || mapping.version !== 1 || !safe(mapping.platformId) || !mapping.platformId.startsWith(PREFIX) || mapping.platformId.length <= PREFIX.length || !safe(mapping.deliveryId) || !['staged', 'deleted'].includes(String(mapping.status))) throw Error('Invalid mapping.')
  const t = mapping.target
  if (!obj(t) || !exact(t, ['route', 'conversationId', 'storageScope']) || !safe(t.conversationId) || typeof t.storageScope !== 'string' || !t.storageScope.trim() || t.storageScope.length > 512 || Array.from(t.storageScope).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || !obj(t.route) || !exact(t.route, ['channel', 'scopeType', 'scopeId', 'threadId']) || t.route.channel !== 'canvas' || t.route.scopeType !== 'thread' || !safe(t.route.scopeId) || !safe(t.route.threadId)) throw Error('Invalid mapping target.')
  const c = mapping.condition
  if (!obj(c) || (c.type === 'calendar' ? !exact(c, ['type', 'fireAt']) || !validTime(c.fireAt) || !Number.isFinite(new Date(c.fireAt).getTime()) : c.type === 'workflow' ? !exact(c, ['type', 'graphId']) || !safe(c.graphId) : true)) throw Error('Invalid mapping condition.')
}
function mutation(mapping: ThreadTriggerMapping, revision: number | undefined, eventId: string, at: number): ResourceMutationInput {
  validate(mapping)
  if (!safe(eventId) || !validTime(at)) throw Error('Invalid mapping event identity.')
  const next = revision === undefined ? 0 : revision + 1
  const event = { protocolVersion: '2.0.0', id: eventId, type: 'thread-trigger-mapping.changed', createdAt: at, payload: {}, envelopeKind: 'event' as const, streamId: `${KIND}:${mapping.platformId}`, sequence: next, resource: { kind: KIND, id: mapping.platformId }, revision: next }
  return { operation: revision === undefined ? 'create' : 'update', kind: KIND, id: mapping.platformId, ...(revision === undefined ? {} : { expectedRevision: revision }), state: structuredClone(mapping), createdAt: at, idempotencyKey: `thread-trigger-mapping:${eventId}`, event }
}
/** Prepare only; caller must atomically batch with BOTH disabled trigger and delivery mutations. */
export function prepareThreadTriggerMapping(store: MagicAgentEventStore, mapping: ThreadTriggerMapping, eventId: string, at: number): ResourceMutationInput {
  validate(mapping)
  if (mapping.status !== 'staged') throw Error('Invalid initial mapping status.')
  if (store.getResource(KIND, mapping.platformId, { includeDeleted: true }) || store.hasResourceEvidence(KIND, mapping.platformId) || store.getResource('trigger', mapping.platformId, { includeDeleted: true }) || store.hasResourceEvidence('trigger', mapping.platformId)) throw Error('Mapping or trigger ID already used.')
  return mutation(mapping, undefined, eventId, at)
}
/** Prepare a permanent tombstone. Not an authorization, stop, or platform disable. */
export function prepareThreadTriggerMappingTombstone(store: MagicAgentEventStore, platformId: string, expectedRevision: number, eventId: string, at: number): ResourceMutationInput {
  const row = store.getResource<unknown>(KIND, platformId, { includeDeleted: true })
  if (!row || row.deleted || row.revision !== expectedRevision || !store.hasResourceEvidence(KIND, platformId)) throw Error('Mapping unavailable or revision conflict.')
  validate(row.state)
  if (row.state.platformId !== platformId || row.state.status !== 'staged') throw Error('Mapping cannot be tombstoned.')
  return mutation({ ...row.state, status: 'deleted' }, row.revision, eventId, at)
}
/** Candidate only; ordinary TriggerCommandService currently has no prefix guard. Internal writes,
 * historical collisions and scheduler execution are not isolated. Never use this as authorization
 * or a trusted production resolver. Deliberately pending-only: claimed/settled deliveries are
 * broken here, not routing decisions. Source-owned cursor fields may change after a tick. */
export function classifyThreadTriggerCandidate(store: MagicAgentEventStore, platformId: string): ThreadTriggerCandidate {
  if (!safe(platformId)) return { kind: 'broken' }
  if (!platformId.startsWith(PREFIX)) return { kind: 'ordinary-candidate' }
  try {
    const row = store.getResource<unknown>(KIND, platformId, { includeDeleted: true })
    if (!row || row.deleted || !store.hasResourceEvidence(KIND, platformId)) return { kind: 'broken' }
    validate(row.state)
    const mapping = row.state
    if (mapping.platformId !== platformId || mapping.status !== 'staged') return { kind: 'broken' }
    const trigger = new PersistentTriggerStore(store).get(platformId)
    if (!trigger || !store.hasResourceEvidence('trigger', platformId) || trigger.state.type !== 'event') return { kind: 'broken' }
    const c = mapping.condition, config = trigger.state.config
    if (c.type === 'calendar' ? config?.sourceKind !== 'calendar' || config.startAt !== new Date(c.fireAt).toISOString() : config?.graphId !== c.graphId || config.sourceKind !== undefined) return { kind: 'broken' }
    const delivery = new AgentThreadTriggerDeliveryStore(store).list(mapping.target).find(x => x.id === mapping.deliveryId)
    if (!delivery || delivery.status !== 'pending' || (c.type === 'calendar' ? delivery.condition.type !== 'calendar' || delivery.condition.fireAt !== c.fireAt : delivery.condition.type !== 'workflow' || delivery.condition.graphId !== c.graphId)) return { kind: 'broken' }
    return { kind: 'thread-candidate', mapping: structuredClone(mapping) }
  } catch { return { kind: 'broken' } }
}
