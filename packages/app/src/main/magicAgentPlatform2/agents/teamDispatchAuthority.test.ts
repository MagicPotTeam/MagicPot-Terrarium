import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { TeamDispatchAuthority } from './teamDispatchAuthority'

vi.mock('node:fs', async importActual => importActual())
const directories: string[] = []
const stores: MagicAgentEventStore[] = []
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'team-dispatch-')); directories.push(dir)
  const file = join(dir, 'events.sqlite')
  const open = () => { const store = new MagicAgentEventStore(file); stores.push(store); return store }
  const store = open()
  return { store, open, authority: new TeamDispatchAuthority(store) }
}
const binding = { scope: 'team_a', generation: 1, member: 'worker' }

describe('isolated team authority building block (not production admission)', () => {
  it('starts before End, leaves in-flight work untouched, and rejects subsequent sends', async () => {
    const { authority } = setup(); authority.create('team_a', 1, ['worker'])
    let finish!: (value: string) => void
    const started = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const pending = authority.dispatch(binding, started)
    authority.end('team_a', 1)
    expect(() => authority.dispatch(binding, started)).toThrow('denied')
    expect(started).toHaveBeenCalledTimes(1)
    finish('response'); await expect(pending).resolves.toBe('response')
  })
  it('orders queued operations in both directions without issuing deferred permits', async () => {
    const { authority } = setup(); authority.create('team_a', 1, ['worker'])
    const send = vi.fn(() => 'started')
    const results = await Promise.allSettled([
      Promise.resolve().then(() => authority.end('team_a', 1)),
      Promise.resolve().then(() => authority.dispatch(binding, send))
    ])
    expect(results.map(x => x.status)).toEqual(['fulfilled', 'rejected']); expect(send).not.toHaveBeenCalled()
    authority.create('team_b', 1, ['worker'])
    const other = { ...binding, scope: 'team_b' }
    const second = await Promise.allSettled([
      Promise.resolve().then(() => authority.dispatch(other, send)),
      Promise.resolve().then(() => authority.end('team_b', 1))
    ])
    expect(second.map(x => x.status)).toEqual(['fulfilled', 'fulfilled']); expect(send).toHaveBeenCalledTimes(1)
  })
  it('persists End on reopen and cannot recreate ended scope', () => {
    const { authority, store, open } = setup(); authority.create('team_a', 1, ['worker']); authority.end('team_a', 1); store.close()
    const reopened = new TeamDispatchAuthority(open())
    expect(() => reopened.dispatch(binding, () => 'bad')).toThrow('denied')
    expect(() => reopened.create('team_a', 2, ['worker'])).toThrow('exists')
    expect(() => reopened.end('team_a', 2)).toThrow('generation')
  })
  it('fails closed on unknown scope, generation, member, invalid input, and closed store', () => {
    const { authority, store } = setup(); authority.create('team_a', 1, ['worker'])
    const send = vi.fn()
    for (const b of [{ ...binding, scope: 'other' }, { ...binding, generation: 2 }, { ...binding, member: 'other' }, { ...binding, generation: 0 }, { ...binding, scope: '../bad' }]) expect(() => authority.dispatch(b, send)).toThrow()
    expect(() => authority.end('team_a', 2)).toThrow(); expect(send).not.toHaveBeenCalled()
    store.close(); expect(() => authority.dispatch(binding, send)).toThrow(); expect(send).not.toHaveBeenCalled()
  })
  it('blocks reentrant End while transport is synchronously starting', () => {
    const { authority } = setup(); authority.create('team_a', 1, ['worker'])
    authority.dispatch(binding, () => { expect(() => authority.end('team_a', 1)).toThrow('unavailable') })
    authority.end('team_a', 1)
    expect(() => authority.dispatch(binding, () => {})).toThrow('denied')
  })
  it('poisons authority after a failed mutation rather than granting new dispatches', () => {
    const { authority, store } = setup(); authority.create('team_a', 1, ['worker'])
    vi.spyOn(store, 'mutateResource').mockImplementation(() => { throw new Error('disk failure') })
    expect(() => authority.end('team_a', 1)).toThrow('disk failure')
    expect(() => authority.dispatch(binding, () => {})).toThrow('unavailable')
  })
})
