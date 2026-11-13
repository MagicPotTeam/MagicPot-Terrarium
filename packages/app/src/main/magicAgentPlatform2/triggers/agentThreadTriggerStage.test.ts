import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { AgentThreadTriggerDeliveryStore } from '../../api/agentThreadTriggerDeliveryStore'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { prepareThreadTriggerStage, commitThreadTriggerStage } from './agentThreadTriggerStage'
import { ProductionTriggerRuntime } from './productionTriggerRuntime'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import { createAgentThreadTriggerBridge } from './agentThreadTriggerBridge'
vi.unmock('node:fs')
const target = { route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'thread' }, conversationId: 'session', storageScope: 'scope' } as const
const input = { target, delivery: { id: 'delivery', condition: { type: 'calendar', fireAt: 100 }, prompt: 'sensitive prompt', consent: { confirmed: true, confirmedAt: 1, profileId: 'profile' } }, platformId: 'platform', createdAt: 10, deliveryEventId: 'event-1', triggerIdempotencyKey: 'stage-1' } as const
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'trigger-stage-')), path = join(dir, 'events.sqlite')
  let db = new MagicAgentEventStore(path)
  return { get db() { return db }, reopen() { db.close(); db = new MagicAgentEventStore(path) }, close() { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
describe('unwired atomic thread trigger staging', () => {
  it('prepares stable commands without writing, atomically commits, replays and reopens', () => {
    const f = fixture()
    try {
      const prepared = prepareThreadTriggerStage(f.db, input), copy = structuredClone(prepared)
      expect(prepareThreadTriggerStage(f.db, input)).toEqual(prepared)
      expect(new AgentThreadTriggerDeliveryStore(f.db).list(target)).toEqual([])
      expect(new PersistentTriggerStore(f.db).get('platform')).toBeUndefined()
      const results = commitThreadTriggerStage(f.db, prepared)
      expect(commitThreadTriggerStage(f.db, prepared).map(x => x.resource)).toEqual(results.map(x => x.resource))
      expect(prepared).toEqual(copy)
      expect(JSON.stringify(prepared[1])).not.toContain(input.delivery.prompt)
      expect(new PersistentTriggerStore(f.db).get('platform')?.state).toMatchObject({ enabled: false, config: { sourceKind: 'calendar' } })
      f.reopen()
      expect(commitThreadTriggerStage(f.db, prepared).map(x => x.resource)).toEqual(results.map(x => x.resource))
      expect(new AgentThreadTriggerDeliveryStore(f.db).list(target)[0].prompt).toBe(input.delivery.prompt)
    } finally { f.close() }
  })
  it('rolls back delivery if trigger create conflicts and rejects changed command replay', () => {
    const f = fixture()
    try {
      const prepared = prepareThreadTriggerStage(f.db, input)
      new PersistentTriggerStore(f.db).create({ id: 'platform', type: 'event', title: 'ordinary', enabled: true }, 2)
      expect(() => commitThreadTriggerStage(f.db, prepared)).toThrow()
      expect(new AgentThreadTriggerDeliveryStore(f.db).list(target)).toEqual([])
      expect(new PersistentTriggerStore(f.db).get('platform')?.state.title).toBe('ordinary')
    } finally { f.close() }
    const g = fixture()
    try {
      const prepared = prepareThreadTriggerStage(g.db, input); commitThreadTriggerStage(g.db, prepared)
      const changed = structuredClone(prepared); changed[1].state.title = 'changed'
      expect(() => commitThreadTriggerStage(g.db, changed)).toThrow()
    } finally { g.close() }
  })
  it('rejects stale collection update atomically', () => {
    const f = fixture()
    try {
      const deliveries = new AgentThreadTriggerDeliveryStore(f.db)
      deliveries.create(target, { ...input.delivery, id: 'existing' })
      const prepared = prepareThreadTriggerStage(f.db, input)
      deliveries.create(target, { ...input.delivery, id: 'concurrent' })
      expect(() => commitThreadTriggerStage(f.db, prepared)).toThrow()
      expect(new PersistentTriggerStore(f.db).get('platform')).toBeUndefined()
      expect(deliveries.list(target).map(x => x.id)).toEqual(['existing', 'concurrent'])
    } finally { f.close() }
  })
  it('preserves old trigger create replay, conflict and validation behavior', () => {
    const f = fixture()
    try {
      const s = new PersistentTriggerStore(f.db)
      const trigger = { id: 'old', type: 'event', title: 'ordinary', enabled: true } as const
      const prepared = s.prepareCreate(trigger, 10, 'old-key')
      expect(s.create(trigger, 10, 'old-key')).toEqual(s.create(trigger, 10, 'old-key'))
      expect(f.db.getEvent(prepared.mutation.event.id)).toMatchObject(prepared.mutation.event)
      expect(() => s.create({ ...trigger, title: 'different' }, 10, 'old-key')).toThrow()
      expect(() => s.create({ ...trigger, id: '' }, 10)).toThrow()
    } finally { f.close() }
  })
  it('staged sources are disabled, enable by CAS, then use the same runtime scheduler', async () => {
    const f = fixture()
    try {
      const calendar = prepareThreadTriggerStage(f.db, input); commitThreadTriggerStage(f.db, calendar)
      const workflowInput = { ...input, platformId: 'workflow', deliveryEventId: 'event-2', triggerIdempotencyKey: 'stage-2', delivery: { ...input.delivery, id: 'workflow-delivery', condition: { type: 'workflow' as const, graphId: 'graph' } } }
      const workflow = prepareThreadTriggerStage(f.db, workflowInput); commitThreadTriggerStage(f.db, workflow)
      const deliveries = new AgentThreadTriggerDeliveryStore(f.db)
      const bridge = createAgentThreadTriggerBridge({ store: deliveries, resolve: id => id === 'platform' ? { target, deliveryId: 'delivery' } : id === 'workflow' ? { target, deliveryId: 'workflow-delivery' } : undefined })
      const runAgent = vi.fn(async () => 'no'), runGraph = vi.fn(async () => 'no')
      const authorization = new MagicAgentPolicyAuthorizationService({ store: f.db, rules: [], policyVersion: 'test', storeId: 'test', trustedApprovers: [{ kind: 'user', id: 'test' }] })
      const runtime = new ProductionTriggerRuntime({ eventStore: f.db, authorization, service: { runAgent, runGraph }, grantProvider: () => undefined, routeResolver: () => ({ kind: 'custom', value: 'test' }), now: () => 100, occurrenceBridge: bridge })
      expect(runtime.calendarCronSource.tick(100)).toBe(0)
      expect(runtime.workflowCompletionSource.enqueue({ graphId: 'graph', runId: 'before', status: 'completed', completedAt: 100 })).toBe(0)
      for (const id of ['platform', 'workflow']) {
        const row = runtime.store.get(id)!
        expect(() => runtime.store.setEnabled({ triggerId: id, enabled: true, expectedRevision: row.revision + 1, idempotencyKey: `bad-${id}`, changedAt: 20 })).toThrow()
        runtime.store.setEnabled({ triggerId: id, enabled: true, expectedRevision: row.revision, idempotencyKey: `enable-${id}`, changedAt: 20 })
      }
      expect(runtime.calendarCronSource.tick(100)).toBe(1)
      expect(runtime.workflowCompletionSource.enqueue({ graphId: 'wrong', runId: 'wrong', status: 'completed', completedAt: 100 })).toBe(0)
      expect(runtime.workflowCompletionSource.enqueue({ graphId: 'graph', runId: 'run', status: 'completed', completedAt: 100 })).toBe(1)
      expect(runtime.occurrences.list().find(x => x.state.triggerId === 'platform')?.state.scheduledAt).toBe(100)
      await runtime.occurrenceScheduler.runOnce(); await runtime.occurrenceScheduler.runOnce()
      expect(deliveries.list(target).map(x => x.occurrence?.at)).toEqual([100, 100])
      expect(runtime.occurrences.list().every(x => x.state.status === 'completed')).toBe(true)
      expect(runAgent).not.toHaveBeenCalled(); expect(runGraph).not.toHaveBeenCalled()
    } finally { f.close() }
  })
  it('after unknown commit outcome rereads both resources and replays original commands', () => {
    const f = fixture()
    try {
      const prepared = prepareThreadTriggerStage(f.db, input)
      const commit = f.db.mutateResourcesBatch.bind(f.db)
      const spy = vi.spyOn(f.db, 'mutateResourcesBatch').mockImplementationOnce((...args) => { commit(...args); throw Error('unknown after commit') })
      expect(() => commitThreadTriggerStage(f.db, prepared)).toThrow('unknown')
      spy.mockRestore(); f.reopen()
      expect(new PersistentTriggerStore(f.db).get('platform')?.state.enabled).toBe(false)
      expect(new AgentThreadTriggerDeliveryStore(f.db).list(target)).toHaveLength(1)
      expect(() => commitThreadTriggerStage(f.db, prepared)).not.toThrow()
    } finally { f.close() }
  })
})
