import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import { AgentThreadTriggerDeliveryStore } from '../../api/agentThreadTriggerDeliveryStore'
import { ProductionTriggerRuntime } from './productionTriggerRuntime'
import { createAgentThreadTriggerBridge } from './agentThreadTriggerBridge'

vi.unmock('node:fs')
const target = { route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }, conversationId: 'conversation', storageScope: 'scope' } as const
const consent = { confirmed: true, confirmedAt: 1, profileId: 'profile' } as const
const fireAt = Date.parse('2026-01-01T00:00:00Z')
function setup(withBridge = true) {
  const dir = mkdtempSync(join(tmpdir(), 'thread-bridge-')), db = new MagicAgentEventStore(join(dir, 'events.sqlite'))
  let now = fireAt
  const authorization = new MagicAgentPolicyAuthorizationService({ store: db, rules: [{ ruleId: 'allow', priority: 1, effect: 'allow', match: { origins: ['trigger'], actions: ['trigger.execute'], targetKinds: ['trigger'], actorKinds: ['system'], effectKinds: ['tool.invoke'], risks: ['high'] }, explanation: 'test' }], policyVersion: 'test', storeId: 'test', trustedApprovers: [{ kind: 'user', id: 'approver' }] })
  const delivery = new AgentThreadTriggerDeliveryStore(db), runAgent = vi.fn(async () => 'ok'), runGraph = vi.fn(async () => 'ok')
  const mapping = new Map<string, { target: typeof target; deliveryId: string }>()
  const resolve = vi.fn((id: string) => mapping.get(id))
  const bridge = createAgentThreadTriggerBridge({ resolve, store: delivery })
  const runtime = new ProductionTriggerRuntime({ eventStore: db, authorization, service: { runAgent, runGraph }, grantProvider: () => undefined, routeResolver: () => ({ kind: 'custom', value: 'test' }), now: () => now, ...(withBridge ? { occurrenceBridge: bridge } : {}) })
  const add = (platformId: string, deliveryId: string, condition: { type: 'calendar'; fireAt: number } | { type: 'workflow'; graphId: string }) => {
    delivery.create(target, { id: deliveryId, condition, prompt: 'wake', consent })
    mapping.set(platformId, { target, deliveryId })
    runtime.store.create({ id: platformId, type: 'event', title: platformId, enabled: true, config: condition.type === 'calendar' ? { sourceKind: 'calendar', startAt: new Date(condition.fireAt).toISOString() } : { graphId: condition.graphId } }, 1)
  }
  return { db, runtime, delivery, mapping, resolve, runAgent, runGraph, add, setNow: (n: number) => { now = n }, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
describe('unwired MAIN-owned production occurrence data bridge', () => {
  it('routes actual calendar and workflow sources once, including repeated callbacks', async () => {
    const f = setup()
    try {
      f.add('calendar', 'timer', { type: 'calendar', fireAt }); f.add('workflow', 'event', { type: 'workflow', graphId: 'graph' })
      expect(f.runtime.calendarCronSource.tick(fireAt)).toBe(1)
      expect(f.runtime.workflowCompletionSource.enqueue({ graphId: 'graph', runId: 'run-1', status: 'completed', completedAt: fireAt })).toBe(1)
      expect(await f.runtime.occurrenceScheduler.runOnce()).toBe(true)
      expect(await f.runtime.occurrenceScheduler.runOnce()).toBe(true)
      const first = f.delivery.list(target)
      expect(first.every(item => item.occurrence && item.status === 'pending')).toBe(true)
      expect(f.runtime.occurrences.list().every(row => row.state.status === 'completed')).toBe(true)
      const bridge = createAgentThreadTriggerBridge({ resolve: f.resolve, store: f.delivery })
      const row = f.runtime.occurrences.list().find(row => row.state.triggerId === 'workflow')!
      await bridge(f.runtime.store.get('workflow')!.state, row.state)
      expect(f.delivery.list(target)).toEqual(first)
      expect(f.runAgent).not.toHaveBeenCalled(); expect(f.runGraph).not.toHaveBeenCalled()
    } finally { f.close() }
  })
  it('late callback after stop never creates delivery', async () => {
    const f = setup()
    try {
      f.add('calendar', 'timer', { type: 'calendar', fireAt }); f.runtime.calendarCronSource.tick(fireAt)
      f.delivery.stop(target, 'timer'); await f.runtime.occurrenceScheduler.runOnce()
      expect(f.delivery.list(target)[0]).toMatchObject({ status: 'stopped' })
      expect(f.delivery.list(target)[0].occurrence).toBeUndefined()
      expect(f.runtime.occurrences.list()[0].state.status).toBe('completed')
      expect(f.runAgent).not.toHaveBeenCalled()
    } finally { f.close() }
  })
  it('fails closed on missing mapping target and retries after repair without a model', async () => {
    const f = setup()
    try {
      f.add('calendar', 'timer', { type: 'calendar', fireAt }); f.runtime.calendarCronSource.tick(fireAt)
      f.mapping.set('calendar', { target, deliveryId: 'missing' })
      await f.runtime.occurrenceScheduler.runOnce()
      expect(f.runtime.occurrences.list()[0].state.status).toBe('failed')
      expect(f.runAgent).not.toHaveBeenCalled(); expect(f.runGraph).not.toHaveBeenCalled()
      f.mapping.set('calendar', { target, deliveryId: 'timer' }); f.setNow(fireAt + 5000)
      await f.runtime.occurrenceScheduler.runOnce()
      expect(f.runtime.occurrences.list()[0].state.status).toBe('completed')
      expect(f.delivery.list(target)[0].occurrence).toBeDefined()
      expect(f.runAgent).not.toHaveBeenCalled()
    } finally { f.close() }
  })
  it('mapping lookup failure never falls back to the platform executor', async () => {
    const f = setup()
    try {
      f.add('calendar', 'timer', { type: 'calendar', fireAt }); f.runtime.calendarCronSource.tick(fireAt)
      f.resolve.mockImplementationOnce(() => { throw Error('Mapping unavailable') })
      const executor = vi.spyOn(f.runtime.executor, 'executeOccurrence')
      await f.runtime.occurrenceScheduler.runOnce()
      expect(f.runtime.occurrences.list()[0].state.status).toBe('failed')
      expect(executor).not.toHaveBeenCalled(); expect(f.runAgent).not.toHaveBeenCalled()
    } finally { f.close() }
  })
  it.each([false, true])('uses existing executor for ordinary unmapped trigger (bridge=%s)', async enabled => {
    const f = setup(enabled)
    try {
      f.runtime.store.create({ id: 'normal', type: 'event', title: 'normal', enabled: true, config: { graphId: 'graph', target: { kind: 'agent-run', agentId: 'agent', prompt: 'hello' } } }, 1)
      const executor = vi.spyOn(f.runtime.executor, 'executeOccurrence').mockResolvedValue('ordinary executor')
      f.runtime.workflowCompletionSource.enqueue({ graphId: 'graph', runId: 'normal-run', status: 'completed', completedAt: fireAt })
      await f.runtime.occurrenceScheduler.runOnce()
      expect(executor).toHaveBeenCalledOnce()
      expect(f.runtime.occurrences.list()[0].state.status).toBe('completed')
    } finally { f.close() }
  })
})
