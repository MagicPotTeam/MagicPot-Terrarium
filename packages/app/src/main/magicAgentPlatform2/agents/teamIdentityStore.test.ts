import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { TeamIdentityStore } from './teamIdentityStore'
vi.mock('node:fs', async actual => actual())
const dirs: string[] = [], stores: MagicAgentEventStore[] = []
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'team-identity-')); dirs.push(dir)
  const file = join(dir, 'events.sqlite')
  const open = () => { const store = new MagicAgentEventStore(file); stores.push(store); return store }
  const store = open()
  return { store, open, owner: new TeamIdentityStore(store) }
}
const team = { scope: 'canvas:project/one', thread: 'thread:1', lead: 'lead' }

describe('unwired MAIN identity store, controlled operations and normal reopen only', () => {
  it('persists full tuple and index atomically, retains End on reopen, never recreates', () => {
    const { owner, store, open } = setup()
    owner.create(team, 1, ['member', 'second'])
    expect(owner.lookup(team, 'member')).toMatchObject({ ...team, generation: 1, ended: false, members: ['member', 'second'] })
    owner.end(team, 1); store.close()
    const restored = new TeamIdentityStore(open())
    expect(restored.read(team)).toMatchObject({ generation: 1, ended: true })
    expect(restored.lookup(team, 'second').ended).toBe(true)
    expect(() => restored.create(team, 2, ['new'])).toThrow('exists')
    expect(() => restored.end(team, 2)).toThrow('Generation')
  })
  it('isolates identical lead/member in different scopes and threads', () => {
    const { owner } = setup(), second = { ...team, scope: 'canvas:project/two' }, third = { ...team, thread: 'thread:2' }
    owner.create(team, 1, ['member']); owner.create(second, 2, ['member']); owner.create(third, 3, ['member'])
    owner.end(team, 1)
    expect(owner.lookup(team, 'member').ended).toBe(true)
    expect(owner.lookup(second, 'member')).toMatchObject({ generation: 2, ended: false })
    expect(owner.lookup(third, 'member')).toMatchObject({ generation: 3, ended: false })
  })
  it('rejects malformed identities, duplicate or cross-team members and unknown data', () => {
    const { owner } = setup()
    expect(() => owner.create(team, 0, ['member'])).toThrow()
    expect(() => owner.create(team, 1, ['member', 'member'])).toThrow()
    expect(() => owner.create(team, 1, ['lead'])).toThrow()
    expect(() => owner.create({ ...team, scope: '' }, 1, ['member'])).toThrow()
    expect(() => owner.lookup(team, 'unknown')).toThrow()
    owner.create(team, 1, ['member'])
    expect(() => owner.create({ ...team, lead: 'other' }, 1, ['member'])).toThrow('assigned')
    expect(() => owner.read({ ...team, lead: 'other' })).toThrow('Unknown')
  })
  it('handles independent owners on same database without lost End or member alias', () => {
    const { owner, open } = setup(), other = new TeamIdentityStore(open())
    owner.create(team, 1, ['member'])
    expect(() => other.create({ ...team, lead: 'other' }, 1, ['member'])).toThrow('assigned')
    other.end(team, 1); owner.end(team, 1)
    expect(owner.lookup(team, 'member').ended).toBe(true)
  })
  it('CAS rejects stale concurrent End and keeps entire batch atomic', () => {
    const { owner, store, open } = setup(), other = new TeamIdentityStore(open())
    owner.create(team, 1, ['member', 'second'])
    const original = store.mutateResourcesBatch.bind(store)
    vi.spyOn(store, 'mutateResourcesBatch').mockImplementationOnce(commands => {
      other.end(team, 1)
      return original(commands)
    })
    expect(() => owner.end(team, 1)).toThrow()
    expect(() => owner.read(team)).toThrow('unavailable')
    expect(other.read(team).ended).toBe(true)
    expect(other.lookup(team, 'member').ended).toBe(true)
    expect(other.lookup(team, 'second').ended).toBe(true)
  })
  it.each(['member-first', 'lead-first'] as const)('rejects role swapping in %s order', order => {
    const { owner } = setup(), a = { ...team, lead: 'A' }, b = { ...team, lead: 'B' }
    if (order === 'member-first') { owner.create(a, 1, ['B']); expect(() => owner.create(b, 1, ['C'])).toThrow() }
    else { owner.create(b, 1, ['C']); expect(() => owner.create(a, 1, ['B'])).toThrow() }
  })
  it('atomically rejects competing roles after both owners pass prechecks', () => {
    const { owner, store, open } = setup(), otherStore = open(), other = new TeamIdentityStore(otherStore)
    const a = { ...team, lead: 'A' }, b = { ...team, lead: 'B' }
    const original = store.mutateResourcesBatch.bind(store)
    vi.spyOn(store, 'mutateResourcesBatch').mockImplementationOnce(commands => {
      other.create(b, 1, ['C'])
      return original(commands)
    })
    expect(() => owner.create(a, 1, ['B'])).toThrow()
    const verify = new TeamIdentityStore(open())
    expect(verify.read(b)).toMatchObject({ lead: 'B' })
    expect(() => verify.read(a)).toThrow('Unknown')
    expect(() => verify.lookup(a, 'B')).toThrow('Unknown')
  })
  it('fails closed for legacy teams without roles in both role directions', () => {
    const { store, open, owner } = setup(), original = store.mutateResourcesBatch.bind(store)
    vi.spyOn(store, 'mutateResourcesBatch').mockImplementationOnce(commands => original(commands.filter(x => x.kind !== 'team-participant-role-v1')))
    const a = { ...team, lead: 'A' }, b = { ...team, lead: 'B' }
    owner.create(a, 1, ['B'])
    const reader = new TeamIdentityStore(open())
    expect(() => reader.read(a)).toThrow('role')
    expect(() => reader.end(a, 1)).toThrow('role')
    expect(() => reader.create(b, 1, ['C'])).toThrow()
    expect(() => reader.create({ ...team, lead: 'Z' }, 1, ['A'])).toThrow()
  })
  it.each(['member-first', 'lead-first'] as const)('preserves legacy active evidence when rejecting %s role conflict', order => {
    const { store, open, owner } = setup(), original = store.mutateResourcesBatch.bind(store)
    let legacyCommands: Parameters<typeof store.mutateResourcesBatch>[0] = []
    vi.spyOn(store, 'mutateResourcesBatch').mockImplementationOnce(commands => {
      legacyCommands = commands.filter(x => x.kind !== 'team-participant-role-v1')
      return original(legacyCommands)
    })
    const a = { ...team, lead: 'A' }, b = { ...team, lead: 'B' }
    const legacy = order === 'member-first' ? a : b
    owner.create(legacy, 1, order === 'member-first' ? ['B'] : ['C'])
    const before = legacyCommands.map(x => store.getResource(x.kind, x.id, { includeDeleted: true }))
    const reader = new TeamIdentityStore(open())
    expect(() => reader.read(legacy)).toThrow('role')
    expect(() => reader.end(legacy, 1)).toThrow('role')
    expect(() => order === 'member-first' ? reader.create(b, 1, ['C']) : reader.create(a, 1, ['B'])).toThrow()
    expect(legacyCommands.map(x => store.getResource(x.kind, x.id, { includeDeleted: true }))).toEqual(before)
  })
  it('rejects an inconsistent stored role', () => {
    const { owner, store } = setup(); owner.create(team, 1, ['member'])
    const original = store.getResource.bind(store)
    vi.spyOn(store, 'getResource').mockImplementation((kind, id, options) => {
      const row = original(kind, id, options)
      return kind === 'team-participant-role-v1' && row ? { ...row, state: { ...(row.state as object), lead: 'wrong' } } : row
    })
    expect(() => owner.read(team)).toThrow('role')
    expect(() => owner.end(team, 1)).toThrow('role')
  })
  it('fails closed on invalid index and never partially ends', () => {
    const { owner, store } = setup(); owner.create(team, 1, ['member', 'second'])
    const actual = store.getResource.bind(store)
    vi.spyOn(store, 'getResource').mockImplementation((kind, id, options) => {
      const row = actual(kind, id, options)
      return kind === 'team-member-index-v1' && row ? { ...row, state: { ...(row.state as object), generation: 9 } } : row
    })
    expect(() => owner.end(team, 1)).toThrow('index')
    vi.restoreAllMocks()
    expect(owner.read(team).ended).toBe(false); expect(owner.lookup(team, 'second').ended).toBe(false)
  })
})
