import { createHash, randomUUID } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'

const KIND = 'agent-thread-trigger-draft-v1'
const MAX = 64
const safeId = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x)
type TriggerSpec = { type: 'schedule'; intervalMs: number; prompt: string } | { type: 'event'; eventName: string; prompt: string }
type Trigger = TriggerSpec & { id: string; deleted: boolean }
type Collection = { version: 1; owner: string; items: Trigger[] }
function owner(scope: AgentThreadInteractionScope): string {
  const route = normalizeAgentRoute(scope.route)
  if (route.channel !== 'canvas' || route.scopeType !== 'thread' || !safeId(route.scopeId) || !safeId(route.threadId) || !safeId(scope.conversationId)) throw Error('Invalid trigger scope.')
  return createHash('sha256').update(JSON.stringify([getAgentSessionKey(route), scope.conversationId])).digest('hex')
}
function spec(value: unknown): asserts value is TriggerSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid trigger spec.')
  const v = value as Record<string, unknown>
  if (typeof v.prompt !== 'string' || !v.prompt.trim() || v.prompt.length > 4000) throw Error('Invalid trigger prompt.')
  if (v.type === 'schedule') {
    if (Object.keys(v).some(k => !['type', 'intervalMs', 'prompt'].includes(k)) || !Number.isSafeInteger(v.intervalMs) || Number(v.intervalMs) < 60_000 || Number(v.intervalMs) > 31_536_000_000) throw Error('Invalid trigger schedule.')
  } else if (v.type === 'event') {
    if (Object.keys(v).some(k => !['type', 'eventName', 'prompt'].includes(k)) || !safeId(v.eventName)) throw Error('Invalid trigger event.')
  } else throw Error('Invalid trigger type.')
}
function validate(value: unknown, key: string): asserts value is Collection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid trigger collection.')
  const collection = value as Collection
  if (collection.version !== 1 || collection.owner !== key || !Array.isArray(collection.items) || collection.items.length > MAX) throw Error('Invalid trigger collection.')
  const seen = new Set<string>()
  for (const item of collection.items) {
    if (!item || !safeId(item.id) || typeof item.deleted !== 'boolean' || seen.has(item.id)) throw Error('Invalid trigger entry.')
    seen.add(item.id)
    const { id: _id, deleted: _deleted, ...rest } = item
    spec(rest)
  }
}
/** Data only: no authorization, scheduler, firing or model execution. Caller must
 * authorize route and conversation; renderer-reported identity is not trusted.
 * Bounded tombstones never recycle IDs. SQLite CAS does not defend DB rollback. */
export class AgentThreadTriggerStore {
  constructor(private readonly store: MagicAgentEventStore) {}
  private load(scope: AgentThreadInteractionScope): { key: string; collection: Collection; revision?: number } {
    const key = owner(scope), row = this.store.getResource<unknown>(KIND, key, { includeDeleted: true })
    if (!row) {
      if (this.store.hasResourceEvidence(KIND, key)) throw Error('Trigger collection unavailable.')
      return { key, collection: { version: 1, owner: key, items: [] } }
    }
    if (row.deleted) throw Error('Trigger collection unavailable.')
    validate(row.state, key)
    return { key, collection: row.state, revision: row.revision }
  }
  list(scope: AgentThreadInteractionScope): ReadonlyArray<Trigger> {
    return structuredClone(this.load(scope).collection.items.filter(item => !item.deleted))
  }
  private write(key: string, collection: Collection, revision?: number): void {
    validate(collection, key)
    const createdAt = Date.now(), eventId = randomUUID(), next = revision === undefined ? 0 : revision + 1
    const event = { protocolVersion: '2.0.0', id: eventId, type: 'agent-thread-trigger.changed', createdAt, payload: {}, envelopeKind: 'event' as const, streamId: `${KIND}:${key}`, sequence: next, resource: { kind: KIND, id: key }, revision: next }
    this.store.mutateResource({ operation: revision === undefined ? 'create' : 'update', kind: KIND, id: key, ...(revision === undefined ? {} : { expectedRevision: revision }), state: collection, createdAt, idempotencyKey: `thread-trigger:${eventId}`, event })
  }
  create(scope: AgentThreadInteractionScope, id: string, input: TriggerSpec): void {
    if (!safeId(id)) throw Error('Invalid trigger ID.')
    spec(input)
    const { key, collection, revision } = this.load(scope)
    if (collection.items.length >= MAX || collection.items.some(item => item.id === id)) throw Error('Trigger limit reached or ID already used.')
    this.write(key, { ...collection, items: [...collection.items, { ...structuredClone(input), id, deleted: false }] }, revision)
  }
  update(scope: AgentThreadInteractionScope, id: string, input: TriggerSpec): void {
    if (!safeId(id)) throw Error('Invalid trigger ID.')
    spec(input)
    const { key, collection, revision } = this.load(scope), existing = collection.items.find(item => item.id === id)
    if (!existing || existing.deleted) throw Error('Unknown trigger.')
    this.write(key, { ...collection, items: collection.items.map(item => item.id === id ? { ...structuredClone(input), id, deleted: false } : item) }, revision)
  }
  delete(scope: AgentThreadInteractionScope, id: string): void {
    if (!safeId(id)) throw Error('Invalid trigger ID.')
    const { key, collection, revision } = this.load(scope), existing = collection.items.find(item => item.id === id)
    if (!existing) throw Error('Unknown trigger.')
    if (existing.deleted) return
    this.write(key, { ...collection, items: collection.items.map(item => item.id === id ? { ...item, deleted: true } : item) }, revision)
  }
}
