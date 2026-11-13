import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { AgentThreadTriggerDeliveryStore } from '../../api/agentThreadTriggerDeliveryStore'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { CalendarCronTriggerSource } from './calendarCronTriggerSource'
import { TriggerOccurrenceStore } from './triggerOccurrenceStore'
import { prepareThreadTriggerStage } from './agentThreadTriggerStage'
import { classifyThreadTriggerCandidate, prepareThreadTriggerMapping, prepareThreadTriggerMappingTombstone, type ThreadTriggerMapping } from './agentThreadTriggerMapping'
import { THREAD_TRIGGER_CANDIDATE_PREFIX } from './threadTriggerNamespace'
vi.unmock('node:fs')
const target = { route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'thread' }, conversationId: 'session', storageScope: 'scope' } as const
const id = `${THREAD_TRIGGER_CANDIDATE_PREFIX}one`
const condition = { type: 'calendar', fireAt: 100 } as const
const delivery = { id: 'delivery', condition, prompt: 'private-prompt', consent: { confirmed: true, confirmedAt: 1, profileId: 'profile' } } as const
const mapping: ThreadTriggerMapping = { version: 1, platformId: id, target, deliveryId: delivery.id, condition, status: 'staged' }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mapping-test-')), path = join(dir, 'events.sqlite')
  let db = new MagicAgentEventStore(path)
  return { get db() { return db }, reopen() { db.close(); db = new MagicAgentEventStore(path) }, close() { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
function prepare(db: MagicAgentEventStore, m = mapping) {
  const stage = prepareThreadTriggerStage(db, { target: m.target, delivery: { ...delivery, id: m.deliveryId, condition: m.condition }, platformId: m.platformId, createdAt: 10, deliveryEventId: 'delivery-event', triggerIdempotencyKey: 'stage-key' })
  return [...stage, prepareThreadTriggerMapping(db, m, 'mapping-event', 10)] as const
}
describe('internal thread trigger candidate mapping (not an authority)', () => {
  it('prepares without writing, batches three records, reopens and replays original commands', () => {
    const f = fixture()
    try {
      const commands = prepare(f.db)
      expect(JSON.stringify(commands[2])).not.toContain(delivery.prompt)
      expect(classifyThreadTriggerCandidate(f.db, id)).toEqual({ kind: 'broken' })
      expect(f.db.mutateResourcesBatch([...commands]).every(x => x.inserted)).toBe(true)
      expect(classifyThreadTriggerCandidate(f.db, id)).toEqual({ kind: 'thread-candidate', mapping })
      f.reopen()
      expect(classifyThreadTriggerCandidate(f.db, id).kind).toBe('thread-candidate')
      expect(f.db.mutateResourcesBatch([...commands]).every(x => !x.inserted)).toBe(true)
    } finally { f.close() }
  })
  it('ordinary is only a candidate, and absent reserved or historically used id is broken', () => {
    const f = fixture()
    try {
      expect(classifyThreadTriggerCandidate(f.db, 'ordinary')).toEqual({ kind: 'ordinary-candidate' })
      expect(classifyThreadTriggerCandidate(f.db, id)).toEqual({ kind: 'broken' })
      new PersistentTriggerStore(f.db).create({ id, type: 'event', title: 'legacy', enabled: false }, 1)
      expect(() => prepareThreadTriggerMapping(f.db, mapping, 'event', 2)).toThrow()
      expect(classifyThreadTriggerCandidate(f.db, id).kind).toBe('broken')
    } finally { f.close() }
  })
  it('rejects malformed targets, extra fields, unsafe times and invalid mapping statuses', () => {
    const f = fixture()
    try {
      for (const bad of [{ ...mapping, prompt: 'leak' }, { ...mapping, status: 'deleted' }, { ...mapping, target: { ...target, extra: 1 } }, { ...mapping, condition: { type: 'calendar', fireAt: Number.MAX_SAFE_INTEGER } }, { ...mapping, condition: { type: 'workflow', graphId: '../bad' } }])
        expect(() => prepareThreadTriggerMapping(f.db, bad as ThreadTriggerMapping, 'event', 1)).toThrow()
      expect(() => prepareThreadTriggerMapping(f.db, mapping, '', 1)).toThrow()
    } finally { f.close() }
  })
  it('batch rolls back on competing trigger; does not trust independently missing records', () => {
    const f = fixture()
    try {
      const commands = prepare(f.db)
      new PersistentTriggerStore(f.db).create({ id, type: 'event', title: 'rival', enabled: false }, 1)
      expect(() => f.db.mutateResourcesBatch([...commands])).toThrow()
      expect(new AgentThreadTriggerDeliveryStore(f.db).list(target)).toEqual([])
      expect(classifyThreadTriggerCandidate(f.db, id).kind).toBe('broken')
    } finally { f.close() }
  })
  it('tombstone is CAS protected and permanently prevents reuse', () => {
    const f = fixture()
    try {
      f.db.mutateResourcesBatch([...prepare(f.db)])
      expect(() => prepareThreadTriggerMappingTombstone(f.db, id, 1, 'delete', 20)).toThrow()
      const tomb = prepareThreadTriggerMappingTombstone(f.db, id, 0, 'delete', 20)
      f.db.mutateResourcesBatch([tomb]); f.reopen()
      expect(classifyThreadTriggerCandidate(f.db, id).kind).toBe('broken')
      expect(() => prepareThreadTriggerMapping(f.db, mapping, 'new', 21)).toThrow()
      expect(() => prepareThreadTriggerMappingTombstone(f.db, id, 1, 'again', 21)).toThrow()
    } finally { f.close() }
  })
  it('source cursor is mutable; claimed delivery is deliberately not a routing candidate', () => {
    const f = fixture()
    try {
      f.db.mutateResourcesBatch([...prepare(f.db)])
      const triggers = new PersistentTriggerStore(f.db)
      const row = triggers.get(id)!
      triggers.setEnabled({ triggerId: id, enabled: true, expectedRevision: row.revision, idempotencyKey: 'enable', changedAt: 20 })
      const source = new CalendarCronTriggerSource(triggers, new TriggerOccurrenceStore(f.db))
      expect(source.tick(100)).toBe(1)
      expect(triggers.get(id)?.state.config).toHaveProperty('sourceCursorAt')
      expect(classifyThreadTriggerCandidate(f.db, id).kind).toBe('thread-candidate')
      const s = new AgentThreadTriggerDeliveryStore(f.db)
      s.observe(target, delivery.id, { type: 'calendar', at: 100 }); s.claim(target, delivery.id)
      expect(classifyThreadTriggerCandidate(f.db, id).kind).toBe('broken')
    } finally { f.close() }
  })
  it('stopped delivery and conflicting condition/target fail closed', () => {
    const f = fixture()
    try {
      f.db.mutateResourcesBatch([...prepare(f.db)])
      new AgentThreadTriggerDeliveryStore(f.db).stop(target, delivery.id)
      expect(classifyThreadTriggerCandidate(f.db, id).kind).toBe('broken')
    } finally { f.close() }
    const g = fixture()
    try {
      const commands = prepare(g.db, { ...mapping, condition: { type: 'calendar', fireAt: 101 } })
      const staged = prepareThreadTriggerStage(g.db, { target, delivery, platformId: id, createdAt: 10, deliveryEventId: 'other-event', triggerIdempotencyKey: 'other-key' })
      g.db.mutateResourcesBatch([...staged, commands[2]])
      expect(classifyThreadTriggerCandidate(g.db, id).kind).toBe('broken')
    } finally { g.close() }
  })
})
