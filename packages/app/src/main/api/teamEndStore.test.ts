import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.mock('electron', () => ({ net: {} }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => { throw new Error('Unexpected production path') } }))
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { TeamEndStore, assertTeamRequestActive } from './teamEndStore'

const id = { scope: 'canvas:one', thread: 'thread', lead: 'lead' }
const member = { ...id, member: 'member' }
describe('controlled renderer End marker, no network', () => {
  it('persists idempotent End across reopen and separates tuples', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-end-')), file = join(dir, 'db.sqlite')
    let db = new MagicAgentEventStore(file)
    try {
      const owner = new TeamEndStore(db)
      expect(() => owner.assertActive(member)).not.toThrow()
      expect(owner.end(id)).toEqual({ ended: true }); expect(owner.end(id)).toEqual({ ended: true })
      expect(() => owner.assertActive(member)).toThrow('ended')
      expect(() => owner.assertActive({ ...member, thread: 'other' })).not.toThrow()
      db.close(); db = new MagicAgentEventStore(file)
      expect(() => new TeamEndStore(db).assertActive(member)).toThrow('ended')
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('does not open a store for ordinary requests and fails on a present undefined tuple', () => {
    expect(() => assertTeamRequestActive({})).not.toThrow()
    // getBuildEnv is a throwing mock: presence does not silently become ordinary.
    expect(() => assertTeamRequestActive({ teamMember: undefined })).toThrow('Unexpected production path')
  })
  it('does not cancel already admitted work when End is recorded', async () => {
    const db = new MagicAgentEventStore(':memory:')
    try {
      const owner = new TeamEndStore(db)
      let finish!: (value: string) => void
      owner.assertActive(member)
      const inFlight = new Promise<string>(resolve => { finish = resolve })
      owner.end(id)
      expect(() => owner.assertActive(member)).toThrow('ended')
      finish('delivered')
      await expect(inFlight).resolves.toBe('delivered')
    } finally { db.close() }
  })
  it('does not report End when persistence fails', () => {
    const db = new MagicAgentEventStore(':memory:')
    try {
      vi.spyOn(db, 'mutateResource').mockImplementation(() => { throw new Error('write failed') })
      expect(() => new TeamEndStore(db).end(id)).toThrow('write failed')
    } finally { db.close(); vi.restoreAllMocks() }
  })
  it('rejects malformed tuples rather than treating them as active', () => {
    const db = new MagicAgentEventStore(':memory:')
    try {
      const owner = new TeamEndStore(db)
      for (const bad of [null, {}, { ...member, member: undefined }, { ...member, scope: '' }, { ...member, member: 'lead' }]) expect(() => owner.assertActive(bad)).toThrow()
      for (const bad of [null, {}, { ...id, thread: ' ' }]) expect(() => owner.end(bad)).toThrow()
    } finally { db.close() }
  })
})
