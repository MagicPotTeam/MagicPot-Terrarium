import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { AgentThreadIsolatedTriggerStore, ISOLATED_DEFINITION_KIND, ISOLATED_OCCURRENCE_KIND } from './agentThreadIsolatedTriggerStore'
vi.unmock('node:fs')
const target = { route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'thread' }, conversationId: 'session', storageScope: 'scope' } as const
const definition = { id: 'thread-delivery-v1-test', condition: { type: 'calendar', fireAt: 100 }, prompt: 'wake', consent: { confirmed: true, confirmedAt: 1, profileId: 'profile' } } as const
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-trigger-')), path = join(dir, 'test.sqlite'), stores: MagicAgentEventStore[] = []
  const open = () => { const db = new MagicAgentEventStore(path); stores.push(db); return { db, store: new AgentThreadIsolatedTriggerStore(db) } }
  return { open, path, close: () => { stores.forEach(db => db.close()); rmSync(dir, { recursive: true, force: true }) } }
}
describe('unwired isolated trigger storage', () => {
  it('creates staged scope isolated data and reopens without ordinary trigger writes', () => {
    const f = fixture(); try {
      const { db, store } = f.open(); db.mutateResource(store.prepareCreate(target, definition, 'create1', 1))
      expect(store.list(target)[0].status).toBe('staged'); expect(store.list({ ...target, conversationId: 'other' })).toEqual([])
      expect(db.listResources({ kind: 'trigger' })).toEqual([]); expect(db.listResources({ kind: 'trigger-occurrence' })).toEqual([])
      expect(f.open().store.list(target)).toEqual(store.list(target))
    } finally { f.close() }
  })
  it('atomically observes and replays original commands; stopped blocks observation', () => {
    const f = fixture(); try {
      const { db, store } = f.open(); db.mutateResource(store.prepareCreate(target, definition, 'create1', 1))
      const batch = vi.spyOn(db, 'mutateResourcesBatch')
      store.observe(target, definition.id, { type: 'calendar', at: 101 }, 'observe1', 101)
      const commands = batch.mock.calls[0][0]; db.mutateResourcesBatch(commands)
      expect(store.observe(target, definition.id, { type: 'calendar', at: 102 }, 'observe2', 102).kind).toBe('replay')
      expect(db.listResources({ kind: ISOLATED_OCCURRENCE_KIND })).toHaveLength(1)
      db.mutateResource(store.prepareStop(target, definition.id, 'stop1', 103))
      expect(() => store.observe(target, definition.id, { type: 'calendar', at: 103 }, 'observe3', 103)).toThrow()
    } finally { f.close() }
  })
  it('rejects stale concurrent batch without orphan occurrence and enforces capacity', () => {
    const f = fixture(); try {
      const a = f.open(), b = f.open(); a.db.mutateResource(a.store.prepareCreate(target, definition, 'create1', 1))
      const realBatch = a.db.mutateResourcesBatch.bind(a.db)
      vi.spyOn(a.db, 'mutateResourcesBatch').mockImplementationOnce(commands => {
        b.db.mutateResource(b.store.prepareStop(target, definition.id, 'stop1', 101))
        return realBatch(commands)
      })
      expect(() => a.store.observe(target, definition.id, { type: 'calendar', at: 100 }, 'observe1', 102)).toThrow()
      expect(a.db.listResources({ kind: ISOLATED_OCCURRENCE_KIND })).toHaveLength(0)
      for (let i = 1; i < 64; i++) a.db.mutateResource(a.store.prepareCreate(target, { ...definition, id: `id${i}` }, `create${i + 1}`, 101 + i))
      expect(() => a.store.prepareCreate(target, { ...definition, id: 'overflow' }, 'overflow', 200)).toThrow()
      expect(a.db.listResources({ kind: ISOLATED_DEFINITION_KIND })).toHaveLength(1)
    } finally { f.close() }
  })
  it('keeps first workflow event and rejects same identity with changed semantics', () => {
    const f = fixture(); try {
      const { db, store } = f.open(); db.mutateResource(store.prepareCreate(target, { ...definition, condition: { type: 'workflow', graphId: 'graph' } }, 'create1', 1))
      store.observe(target, definition.id, { type: 'workflow', graphId: 'graph', runId: 'run', at: 10 }, 'observe1', 10)
      expect(store.observe(target, definition.id, { type: 'workflow', graphId: 'graph', runId: 'other', at: 11 }, 'other', 11).kind).toBe('occupied')
      expect(() => store.observe(target, definition.id, { type: 'workflow', graphId: 'graph', runId: 'run', at: 11 }, 'again', 11)).toThrow('conflict')
    } finally { f.close() }
  })
  it('fails closed on malformed JSON and tombstoned collection', () => {
    const f = fixture(); try {
      const a = f.open(); a.db.mutateResource(a.store.prepareCreate(target, definition, 'create', 1))
      const raw = new DatabaseSync(f.path)
      raw.prepare('UPDATE resources SET state_json = ? WHERE resource_kind = ?').run('{bad', ISOLATED_DEFINITION_KIND)
      raw.close()
      expect(() => a.store.list(target)).toThrow()
      const raw2 = new DatabaseSync(f.path)
      raw2.prepare('UPDATE resources SET state_json = ?, deleted = 1 WHERE resource_kind = ?').run('{}', ISOLATED_DEFINITION_KIND)
      raw2.close()
      expect(() => a.store.prepareCreate(target, definition, 'again', 2)).toThrow()
    } finally { f.close() }
  })
  it('two connections race to observe without two occurrences', () => {
    const f = fixture(); try {
      const a=f.open(), b=f.open(); a.db.mutateResource(a.store.prepareCreate(target, definition, 'create', 1))
      const commit=a.db.mutateResourcesBatch.bind(a.db)
      vi.spyOn(a.db, 'mutateResourcesBatch').mockImplementationOnce(commands => {
        expect(b.store.observe(target, definition.id, {type:'calendar', at:100}, 'winner', 100).kind).toBe('new')
        return commit(commands)
      })
      expect(() => a.store.observe(target, definition.id, {type:'calendar', at:100}, 'loser', 101)).toThrow()
      expect(a.db.listResources({kind:ISOLATED_OCCURRENCE_KIND})).toHaveLength(1)
      expect(a.store.observe(target, definition.id, {type:'calendar', at:101}, 'retry', 102).kind).toBe('replay')
    } finally { f.close() }
  })
  it('reconciles a simulated post-commit exception and rejects mixed replay', () => {
    const f=fixture(); try {
      const a=f.open(); a.db.mutateResource(a.store.prepareCreate(target, definition, 'create', 1))
      const commit=a.db.mutateResourcesBatch.bind(a.db)
      let commands: Parameters<typeof a.db.mutateResourcesBatch>[0] = []
      vi.spyOn(a.db, 'mutateResourcesBatch').mockImplementationOnce(input => { commands=input; commit(input); throw Error('after commit') })
      expect(() => a.store.observe(target, definition.id, {type:'calendar',at:100}, 'observe', 100)).toThrow('after commit')
      expect(f.open().store.observe(target, definition.id, {type:'calendar',at:100}, 'retry', 101).kind).toBe('replay')
      expect(commit(commands)).toHaveLength(2)
      const other=a.store.prepareCreate({...target,conversationId:'other'}, {...definition,id:'other'}, 'other', 102)
      expect(() => commit([commands[0],other])).toThrow()
      expect(a.store.list({...target,conversationId:'other'})).toEqual([])
    } finally { f.close() }
  })
  it('does not modify a real ordinary trigger with the same id', () => {
    const f=fixture(); try {
      const a=f.open(), id=definition.id, kind='trigger'
      const event={protocolVersion:'2.0.0',id:'ordinary-event',type:'trigger.created',createdAt:1,payload:{},envelopeKind:'event' as const,streamId:'ordinary-stream',sequence:0}
      a.db.mutateResource({operation:'create',kind,id,state:{title:'ordinary'},createdAt:1,idempotencyKey:'ordinary',event})
      const before=a.db.getResource(kind,id)
      a.db.mutateResource(a.store.prepareCreate(target,definition,'isolated',2))
      a.store.observe(target,id,{type:'calendar',at:100},'observe',100)
      expect(a.db.getResource(kind,id)).toEqual(before)
    } finally { f.close() }
  })
})
