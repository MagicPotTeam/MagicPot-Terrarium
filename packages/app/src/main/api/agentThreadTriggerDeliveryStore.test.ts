import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { AgentThreadTriggerDeliveryStore } from './agentThreadTriggerDeliveryStore'
vi.unmock('node:fs')
const target = { route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'thread' }, conversationId: 'session', storageScope: 'scope' } as const
const consent = { confirmed: true, confirmedAt: 10, profileId: 'profile' } as const
const calendar = { id: 'timer', condition: { type: 'calendar', fireAt: 100 }, prompt: 'hello', consent } as const
const workflow = { id: 'event', condition: { type: 'workflow', graphId: 'graph' }, prompt: 'wake', consent } as const
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'trigger-delivery-')), path = join(dir, 'events.sqlite'), stores: MagicAgentEventStore[] = []
  const open = () => { const db = new MagicAgentEventStore(path); stores.push(db); return new AgentThreadTriggerDeliveryStore(db) }
  return { open, close: () => { for (const db of stores) db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
describe('unwired one-shot trigger delivery data', () => {
  it('matches absolute time and workflow once and scopes delivery', () => {
    const f = fixture()
    try {
      const s = f.open(); s.create(target, calendar); s.create(target, workflow)
      s.observe(target, 'timer', { type: 'calendar', at: 99 })
      s.observe(target, 'event', { type: 'workflow', graphId: 'other', runId: 'run1', at: 100 })
      expect(s.list(target).every(x => !x.occurrence)).toBe(true)
      s.observe(target, 'timer', { type: 'calendar', at: 101 })
      s.observe(target, 'event', { type: 'workflow', graphId: 'graph', runId: 'run1', at: 102 })
      s.observe(target, 'event', { type: 'workflow', graphId: 'graph', runId: 'run2', at: 103 })
      expect(s.list(target).map(x => x.occurrence)).toEqual([{ id: 't-100', at: 100 }, { id: 'run1', at: 102 }])
      expect(s.list({ ...target, conversationId: 'other' })).toEqual([])
      expect(s.list({ ...target, storageScope: 'other' })).toEqual([])
      expect(s.list({ ...target, route: { ...target.route, threadId: 'other' } })).toEqual([])
    } finally { f.close() }
  })
  it('does not reclaim a persisted claim after reopen; only its claimant may settle', () => {
    const f = fixture()
    try {
      const a = f.open(); a.create(target, calendar); a.observe(target, 'timer', { type: 'calendar', at: 100 }); const claim = a.claim(target, 'timer')
      const b = f.open(); expect(b.list(target)[0].status).toBe('claimed')
      expect(() => b.claim(target, 'timer')).toThrow(); expect(() => b.stop(target, 'timer')).toThrow()
      expect(() => b.settle(target, 'timer', 'wrong', 'completed')).toThrow()
      b.settle(target, 'timer', claim, 'unknown'); expect(b.list(target)[0].status).toBe('unknown')
      expect(() => b.claim(target, 'timer')).toThrow(); expect(() => b.settle(target, 'timer', claim, 'completed')).toThrow()
    } finally { f.close() }
  })
  it('stops only pending and completes only an owned claim', () => {
    const f = fixture()
    try {
      const s = f.open(); s.create(target, calendar); s.stop(target, 'timer'); s.stop(target, 'timer')
      s.observe(target, 'timer', { type: 'calendar', at: 100 }); expect(() => s.claim(target, 'timer')).toThrow()
      s.create(target, workflow); s.observe(target, 'event', { type: 'workflow', graphId: 'graph', runId: 'run', at: 100 })
      const token = s.claim(target, 'event'); s.settle(target, 'event', token, 'completed')
      expect(s.list(target).map(x => x.status)).toEqual(['stopped', 'completed'])
      expect(() => s.stop(target, 'event')).toThrow()
    } finally { f.close() }
  })
  it('rejects malformed target, missing consent and invalid conditions and enforces capacity', () => {
    const f = fixture()
    try {
      const s = f.open()
      expect(() => s.create({ ...target, route: { ...target.route, threadId: '../bad' } }, calendar)).toThrow()
      expect(() => s.create(target, { ...calendar, consent: { ...consent, confirmed: false } } as never)).toThrow()
      expect(() => s.create(target, { ...calendar, condition: { type: 'calendar', fireAt: -1 } })).toThrow()
      expect(() => s.create(target, { ...workflow, condition: { type: 'workflow', graphId: '' } })).toThrow()
      for (let i = 0; i < 64; i++) s.create(target, { ...workflow, id: `id${i}` })
      s.stop(target, 'id0'); expect(() => s.create(target, calendar)).toThrow('limit')
    } finally { f.close() }
  })
})
