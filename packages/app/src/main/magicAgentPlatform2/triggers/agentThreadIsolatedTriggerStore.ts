import { createHash } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import { canonicalJson, type MagicAgentEventStore, type ResourceMutationInput } from '../persistence/eventStore'
import type { ThreadTriggerTarget, ThreadTriggerCondition } from '../../api/agentThreadTriggerDeliveryStore'

// Isolated persistence only. A staged record and its consent are not authorization.
export const ISOLATED_DEFINITION_KIND = 'agent-thread-isolated-definition-v1'
export const ISOLATED_OCCURRENCE_KIND = 'agent-thread-isolated-occurrence-v1'
const LIMIT = 64
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
export type IsolatedDefinition = { id: string; target: ThreadTriggerTarget; condition: ThreadTriggerCondition; prompt: string; consent: { confirmed: true; confirmedAt: number; profileId: string }; status: 'staged' | 'stopped'; firstOccurrenceId?: string }
type Collection = { version: 1; owner: string; items: IsolatedDefinition[] }
export type IsolatedSource = { type: 'calendar'; at: number } | { type: 'workflow'; graphId: string; runId: string; at: number }
type Occurrence = { version: 1; owner: string; definitionId: string; source: IsolatedSource }
function ownerOf(target: ThreadTriggerTarget): string {
  if (!obj(target) || !keys(target, ['route', 'conversationId', 'storageScope']) || !obj(target.route) || !keys(target.route, ['channel', 'scopeType', 'scopeId', 'threadId']) || target.route.channel !== 'canvas' || target.route.scopeType !== 'thread' || !id(target.route.scopeId) || !id(target.route.threadId) || !id(target.conversationId) || typeof target.storageScope !== 'string' || !target.storageScope.trim() || target.storageScope.length > 512 || Array.from(target.storageScope).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw Error('Invalid target.')
  return hash([getAgentSessionKey(normalizeAgentRoute(target.route)), target.conversationId, target.storageScope])
}
function validateDefinition(item: IsolatedDefinition, owner: string): void {
  if (!obj(item) || !keys(item, ['id', 'target', 'condition', 'prompt', 'consent', 'status', 'firstOccurrenceId']) || !id(item.id) || ownerOf(item.target) !== owner || typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 4000 || !obj(item.consent) || !keys(item.consent, ['confirmed', 'confirmedAt', 'profileId']) || item.consent.confirmed !== true || !time(item.consent.confirmedAt) || !id(item.consent.profileId) || !obj(item.condition)) throw Error('Invalid definition.')
  const c = item.condition
  if (c.type === 'calendar' ? !keys(c, ['type', 'fireAt']) || !time(c.fireAt) : c.type === 'workflow' ? !keys(c, ['type', 'graphId']) || !id(c.graphId) : true) throw Error('Invalid condition.')
  if (!['staged', 'stopped'].includes(item.status) || (item.firstOccurrenceId !== undefined && !/^o-[a-f0-9]{64}$/.test(item.firstOccurrenceId))) throw Error('Invalid definition state.')
}
function validateSource(source: IsolatedSource): void {
  if (!obj(source) || !time(source.at) || (source.type === 'calendar' ? !keys(source, ['type', 'at']) : source.type === 'workflow' ? !keys(source, ['type', 'graphId', 'runId', 'at']) || !id(source.graphId) || !id(source.runId) : true)) throw Error('Invalid source.')
}
function mutation(kind: string, resourceId: string, state: unknown, revision: number | undefined, eventId: string, at: number): ResourceMutationInput {
  if (!id(eventId) || !time(at)) throw Error('Invalid mutation identity.')
  const next = revision === undefined ? 0 : revision + 1
  const event = { protocolVersion: '2.0.0', id: `${kind}:${eventId}`, type: `${kind}.changed`, createdAt: at, payload: {}, envelopeKind: 'event' as const, streamId: `${kind}:${resourceId}:stream`, sequence: next, resource: { kind, id: resourceId }, revision: next }
  return { operation: revision === undefined ? 'create' : 'update', kind, id: resourceId, ...(revision === undefined ? {} : { expectedRevision: revision }), state, createdAt: at, idempotencyKey: `${kind}:${eventId}`, event }
}
export class AgentThreadIsolatedTriggerStore {
  constructor(private readonly store: MagicAgentEventStore) {}
  private load(target: ThreadTriggerTarget): { owner: string; value: Collection; revision?: number } {
    const owner = ownerOf(target), row = this.store.getResource<unknown>(ISOLATED_DEFINITION_KIND, owner, { includeDeleted: true })
    if (!row) { if (this.store.hasResourceEvidence(ISOLATED_DEFINITION_KIND, owner)) throw Error('Definition unavailable.'); return { owner, value: { version: 1, owner, items: [] } } }
    const v = row.state as Collection
    if (row.deleted || !obj(v) || !keys(v, ['version', 'owner', 'items']) || v.version !== 1 || v.owner !== owner || !Array.isArray(v.items) || v.items.length > LIMIT || new Set(v.items.map(x => x?.id)).size !== v.items.length) throw Error('Invalid collection.')
    for (const item of v.items) validateDefinition(item, owner)
    return { owner, value: v, revision: row.revision }
  }
  list(target: ThreadTriggerTarget): IsolatedDefinition[] { return structuredClone(this.load(target).value.items) }
  prepareCreate(target: ThreadTriggerTarget, input: Pick<IsolatedDefinition, 'id' | 'condition' | 'prompt' | 'consent'>, eventId: string, at: number): ResourceMutationInput {
    const { owner, value, revision } = this.load(target)
    if (!obj(input) || !keys(input, ['id', 'condition', 'prompt', 'consent']) || value.items.length >= LIMIT || value.items.some(x => x.id === input.id)) throw Error('Definition limit or duplicate ID.')
    const item: IsolatedDefinition = { ...structuredClone(input), target: structuredClone(target), status: 'staged' }
    validateDefinition(item, owner)
    return mutation(ISOLATED_DEFINITION_KIND, owner, { ...value, items: [...value.items, item] }, revision, eventId, at)
  }
  prepareStop(target: ThreadTriggerTarget, definitionId: string, eventId: string, at: number): ResourceMutationInput {
    const { owner, value, revision } = this.load(target), item = value.items.find(x => x.id === definitionId)
    if (!item || item.status !== 'staged') throw Error('Definition not stoppable.')
    return mutation(ISOLATED_DEFINITION_KIND, owner, { ...value, items: value.items.map(x => x.id === definitionId ? { ...x, status: 'stopped' } : x) }, revision, eventId, at)
  }
  observe(target: ThreadTriggerTarget, definitionId: string, source: IsolatedSource, eventId: string, at: number): { kind: 'new' | 'replay' | 'occupied'; occurrenceId: string } {
    const prepared = this.prepareObserve(target, definitionId, source, eventId, at)
    if (prepared.kind !== 'new') return prepared
    this.store.mutateResourcesBatch(prepared.commands)
    return { kind: 'new', occurrenceId: prepared.commands[1].id }
  }
  private prepareObserve(target: ThreadTriggerTarget, definitionId: string, source: IsolatedSource, eventId: string, at: number): { kind: 'new'; commands: ResourceMutationInput[] } | { kind: 'replay' | 'occupied'; occurrenceId: string } {
    validateSource(source)
    const { owner, value, revision } = this.load(target), item = value.items.find(x => x.id === definitionId)
    if (!item || item.status !== 'staged') throw Error('Definition unavailable.')
    if (source.type !== item.condition.type || (source.type === 'calendar' && item.condition.type === 'calendar' && source.at < item.condition.fireAt) || (source.type === 'workflow' && item.condition.type === 'workflow' && source.graphId !== item.condition.graphId)) throw Error('Source mismatch.')
    const normalized: IsolatedSource = source.type === 'calendar' && item.condition.type === 'calendar' ? { type: 'calendar', at: item.condition.fireAt } : structuredClone(source)
    const occurrenceId = `o-${hash(source.type === 'calendar' ? [1, owner, definitionId, 'calendar', (item.condition as { fireAt: number }).fireAt] : [1, owner, definitionId, 'workflow', source.graphId, source.runId])}`
    const occurrence: Occurrence = { version: 1, owner, definitionId, source: normalized }
    if (item.firstOccurrenceId) {
      const existing = this.store.getResource<Occurrence>(ISOLATED_OCCURRENCE_KIND, item.firstOccurrenceId, { includeDeleted: true })
      if (!existing || existing.deleted || !obj(existing.state) || !keys(existing.state, ['version', 'owner', 'definitionId', 'source']) || existing.state.version !== 1 || existing.state.owner !== owner || existing.state.definitionId !== definitionId) throw Error('Occurrence unavailable.')
      validateSource(existing.state.source)
      const prior = existing.state.source
      if (prior.type !== item.condition.type || (prior.type === 'calendar' && item.condition.type === 'calendar' && prior.at !== item.condition.fireAt) || (prior.type === 'workflow' && item.condition.type === 'workflow' && prior.graphId !== item.condition.graphId)) throw Error('Invalid occurrence condition.')
      const expectedId = `o-${hash(prior.type === 'calendar' ? [1, owner, definitionId, 'calendar', prior.at] : [1, owner, definitionId, 'workflow', prior.graphId, prior.runId])}`
      if (item.firstOccurrenceId !== expectedId) throw Error('Invalid occurrence identity.')
      if (item.firstOccurrenceId !== occurrenceId) return { kind: 'occupied', occurrenceId: item.firstOccurrenceId }
      if (canonicalJson(existing.state.source) !== canonicalJson(normalized)) throw Error('Occurrence conflict.')
      return { kind: 'replay', occurrenceId }
    }
    if (this.store.getResource(ISOLATED_OCCURRENCE_KIND, occurrenceId, { includeDeleted: true }) || this.store.hasResourceEvidence(ISOLATED_OCCURRENCE_KIND, occurrenceId)) throw Error('Occurrence identity already used.')
    return { kind: 'new', commands: [mutation(ISOLATED_DEFINITION_KIND, owner, { ...value, items: value.items.map(x => x.id === definitionId ? { ...x, firstOccurrenceId: occurrenceId } : x) }, revision, `${eventId}-d`, at), mutation(ISOLATED_OCCURRENCE_KIND, occurrenceId, occurrence, undefined, `${eventId}-o`, at)] }
  }
}
