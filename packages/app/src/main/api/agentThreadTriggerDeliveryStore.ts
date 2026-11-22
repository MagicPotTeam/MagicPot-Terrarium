import { createHash, randomUUID } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'

/** Unwired data contract: consent is a record, never authorization or a dispatch permit. */
export type ThreadTriggerTarget = AgentThreadInteractionScope & { storageScope: string }
export type ThreadTriggerCondition = { type: 'calendar'; fireAt: number } | { type: 'workflow'; graphId: string }
export type ThreadTriggerDelivery = {
  id: string; target: ThreadTriggerTarget; condition: ThreadTriggerCondition; prompt: string
  consent: { confirmed: true; confirmedAt: number; profileId: string }
  status: 'pending' | 'claimed' | 'unknown' | 'completed' | 'stopped'
  occurrence?: { id: string; at: number }; claimId?: string
}
type Collection = { version: 1; owner: string; items: ThreadTriggerDelivery[] }
const KIND = 'agent-thread-trigger-delivery-v1'
const LIMIT = 64
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))
function targetKey(target: ThreadTriggerTarget): string {
  if (!object(target) || !keys(target, ['route', 'conversationId', 'storageScope']) || !object(target.route) || !keys(target.route, ['channel', 'scopeType', 'scopeId', 'threadId']) || target.route.channel !== 'canvas' || target.route.scopeType !== 'thread' || !id(target.route.scopeId) || !id(target.route.threadId) || !id(target.conversationId) || typeof target.storageScope !== 'string' || !target.storageScope.trim() || target.storageScope.length > 512 || Array.from(target.storageScope).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw Error('Invalid trigger target.')
  return createHash('sha256').update(JSON.stringify([getAgentSessionKey(normalizeAgentRoute(target.route)), target.conversationId, target.storageScope])).digest('hex')
}
function validateItem(item: ThreadTriggerDelivery, owner: string): void {
  if (!object(item) || !keys(item, ['id', 'target', 'condition', 'prompt', 'consent', 'status', 'occurrence', 'claimId']) || !id(item.id) || targetKey(item.target) !== owner || typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 4000 || !object(item.consent) || !keys(item.consent, ['confirmed', 'confirmedAt', 'profileId']) || item.consent.confirmed !== true || !time(item.consent.confirmedAt) || !id(item.consent.profileId) || !object(item.condition)) throw Error('Invalid trigger delivery.')
  const c = item.condition
  if (c.type === 'calendar' ? !keys(c, ['type', 'fireAt']) || !time(c.fireAt) : c.type === 'workflow' ? !keys(c, ['type', 'graphId']) || !id(c.graphId) : true) throw Error('Invalid trigger condition.')
  if (!['pending', 'claimed', 'unknown', 'completed', 'stopped'].includes(item.status)) throw Error('Invalid trigger state.')
  if (item.occurrence !== undefined && (!object(item.occurrence) || !keys(item.occurrence, ['id', 'at']) || !id(item.occurrence.id) || !time(item.occurrence.at))) throw Error('Invalid occurrence.')
  if (item.status === 'pending' && item.claimId !== undefined || item.status === 'stopped' && item.claimId !== undefined || ['claimed', 'unknown', 'completed'].includes(item.status) && (!item.occurrence || !id(item.claimId))) throw Error('Invalid delivery state.')
}

/** Data-only durable one-shot delivery. No scheduler, IPC, approvals or execution. */
export class AgentThreadTriggerDeliveryStore {
  constructor(private readonly store: MagicAgentEventStore) {}
  private load(target: ThreadTriggerTarget): { owner: string; value: Collection; revision?: number } {
    const owner = targetKey(target), row = this.store.getResource<unknown>(KIND, owner, { includeDeleted: true })
    if (!row) {
      if (this.store.hasResourceEvidence(KIND, owner)) throw Error('Trigger delivery unavailable.')
      return { owner, value: { version: 1, owner, items: [] } }
    }
    const v = row.state as Collection
    if (row.deleted || !object(v) || v.version !== 1 || v.owner !== owner || !Array.isArray(v.items) || v.items.length > LIMIT || new Set(v.items.map(x => x.id)).size !== v.items.length) throw Error('Invalid trigger collection.')
    for (const item of v.items) validateItem(item, owner)
    return { owner, value: v, revision: row.revision }
  }
  private prepareWrite(owner: string, value: Collection, revision: number | undefined, eventId: string, createdAt: number) {
    for (const item of value.items) validateItem(item, owner)
    const next = revision === undefined ? 0 : revision + 1
    const event = { protocolVersion: '2.0.0', id: eventId, type: 'thread-trigger-delivery.changed', createdAt, payload: {}, envelopeKind: 'event' as const, streamId: `${KIND}:${owner}`, sequence: next, resource: { kind: KIND, id: owner }, revision: next }
    return { operation: revision === undefined ? 'create' as const : 'update' as const, kind: KIND, id: owner, ...(revision === undefined ? {} : { expectedRevision: revision }), state: value, createdAt, idempotencyKey: `thread-trigger-delivery:${eventId}`, event }
  }
  private write(owner: string, value: Collection, revision?: number): void {
    this.store.mutateResource(this.prepareWrite(owner, value, revision, randomUUID(), Date.now()))
  }
  list(target: ThreadTriggerTarget): ThreadTriggerDelivery[] { return structuredClone(this.load(target).value.items) }
  prepareCreate(target: ThreadTriggerTarget, input: Pick<ThreadTriggerDelivery, 'id' | 'condition' | 'prompt' | 'consent'>, eventId: string, createdAt: number) {
    if (!id(eventId) || !time(createdAt)) throw Error('Invalid creation identity.')
    const { owner, value, revision } = this.load(target)
    if (!object(input) || !keys(input, ['id', 'condition', 'prompt', 'consent'])) throw Error('Invalid trigger input.')
    if (value.items.length >= LIMIT || value.items.some(item => item.id === input.id)) throw Error('Trigger limit reached or ID already used.')
    const item: ThreadTriggerDelivery = { ...structuredClone(input), target: structuredClone(target), status: 'pending' }
    validateItem(item, owner)
    return this.prepareWrite(owner, { ...value, items: [...value.items, item] }, revision, eventId, createdAt)
  }
  create(target: ThreadTriggerTarget, input: Pick<ThreadTriggerDelivery, 'id' | 'condition' | 'prompt' | 'consent'>): void {
    this.store.mutateResource(this.prepareCreate(target, input, randomUUID(), Date.now()))
  }
  private change(target: ThreadTriggerTarget, triggerId: string, transition: (item: ThreadTriggerDelivery) => ThreadTriggerDelivery): void {
    const { owner, value, revision } = this.load(target), index = value.items.findIndex(item => item.id === triggerId)
    if (index < 0) throw Error('Unknown trigger.')
    const before = value.items[index], after = transition(structuredClone(before))
    if (JSON.stringify(after) === JSON.stringify(before)) return
    const items = [...value.items]; items[index] = after
    this.write(owner, { ...value, items }, revision)
  }
  /** Called by a host source adapter, not a timer. Replays cannot replace first occurrence. */
  observe(target: ThreadTriggerTarget, triggerId: string, source: { type: 'calendar'; at: number } | { type: 'workflow'; graphId: string; runId: string; at: number }): void {
    if (!object(source) || !time(source.at) || (source.type === 'calendar' ? !keys(source, ['type', 'at']) : source.type === 'workflow' ? !keys(source, ['type', 'graphId', 'runId', 'at']) || !id(source.graphId) || !id(source.runId) : true)) throw Error('Invalid trigger event.')
    this.change(target, triggerId, item => {
      if (item.status !== 'pending' || item.occurrence) return item
      if (source.type === 'calendar' && item.condition.type === 'calendar' && source.at >= item.condition.fireAt) return { ...item, occurrence: { id: `t-${item.condition.fireAt}`, at: item.condition.fireAt } }
      if (source.type === 'workflow' && item.condition.type === 'workflow' && source.graphId === item.condition.graphId) return { ...item, occurrence: { id: source.runId, at: source.at } }
      return item
    })
  }
  claim(target: ThreadTriggerTarget, triggerId: string): string {
    const claimId = randomUUID()
    this.change(target, triggerId, item => {
      if (item.status !== 'pending' || !item.occurrence) throw Error('Trigger is not claimable.')
      return { ...item, status: 'claimed', claimId }
    })
    return claimId
  }
  settle(target: ThreadTriggerTarget, triggerId: string, claimId: string, status: 'completed' | 'unknown'): void {
    if (!id(claimId) || !['completed', 'unknown'].includes(status)) throw Error('Invalid settlement.')
    this.change(target, triggerId, item => {
      if (item.status !== 'claimed' || item.claimId !== claimId) throw Error('Trigger claim mismatch.')
      return { ...item, status }
    })
  }
  /** Stop only before claim; claim is the conservative start boundary. */
  stop(target: ThreadTriggerTarget, triggerId: string): void {
    this.change(target, triggerId, item => {
      if (item.status === 'stopped') return item
      if (item.status !== 'pending') throw Error('Trigger already claimed or settled.')
      return { ...item, status: 'stopped' }
    })
  }
}
