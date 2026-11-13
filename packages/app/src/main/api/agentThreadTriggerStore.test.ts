import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { AgentThreadTriggerStore } from './agentThreadTriggerStore'
const scope = { route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }, conversationId: 'lead' } as const
const schedule = { type: 'schedule', intervalMs: 60_000, prompt: 'remind' } as const
const event = { type: 'event', eventName: 'on_update', prompt: 'react' } as const
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'thread-trigger-')), file = join(dir, 'db.sqlite'), stores: MagicAgentEventStore[] = []
  const open = () => { const db = new MagicAgentEventStore(file); stores.push(db); return db }
  return { open, close: () => { for (const db of stores) db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
describe('unwired thread-scoped trigger data', () => {
  it('persists, updates, tombstones and isolates scope across reopen', () => {
    const f = fixture()
    try {
      const store = new AgentThreadTriggerStore(f.open())
      store.create(scope, 'timer', schedule); store.create(scope, 'event', event)
      store.update(scope, 'timer', { ...schedule, prompt: 'updated' }); store.delete(scope, 'event'); store.delete(scope, 'event')
      const other = new AgentThreadTriggerStore(f.open())
      expect(other.list(scope)).toEqual([{ ...schedule, prompt: 'updated', id: 'timer', deleted: false }])
      expect(other.list({ ...scope, conversationId: 'other' })).toEqual([])
      expect(other.list({ ...scope, route: { ...scope.route, threadId: 'other' } })).toEqual([])
      expect(() => other.create(scope, 'event', event)).toThrow()
      expect(() => other.update(scope, 'event', event)).toThrow()
    } finally { f.close() }
  })
  it('rejects malformed input and maintains bounded tombstones', () => {
    const f = fixture()
    try {
      const store = new AgentThreadTriggerStore(f.open())
      expect(() => store.create(scope, 'x', { ...schedule, intervalMs: 1 })).toThrow()
      expect(() => store.create(scope, 'x', { ...event, eventName: '' })).toThrow()
      expect(() => store.create(scope, 'x', { ...event, prompt: 'x'.repeat(4001) })).toThrow()
      expect(() => store.create(scope, 'x', { ...event, extra: true } as never)).toThrow()
      for (let i = 0; i < 64; i++) store.create(scope, `id${i}`, event)
      store.delete(scope, 'id0')
      expect(() => store.create(scope, 'new', event)).toThrow('limit')
      expect(store.list(scope)).toHaveLength(63)
    } finally { f.close() }
  })
  it('uses SQLite CAS to reject stale cross-owner writes without partial changes', () => {
    const f = fixture()
    try {
      const db = f.open(), one = new AgentThreadTriggerStore(db), two = new AgentThreadTriggerStore(f.open())
      one.create(scope, 'a', event)
      const original = db.mutateResource.bind(db)
      vi.spyOn(db, 'mutateResource').mockImplementationOnce(command => { two.create(scope, 'b', event); return original(command) })
      expect(() => one.create(scope, 'c', schedule)).toThrow()
      expect(two.list(scope).map(item => item.id)).toEqual(['a', 'b'])
    } finally { vi.restoreAllMocks(); f.close() }
  })
})
