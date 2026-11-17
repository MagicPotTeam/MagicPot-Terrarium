import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from './chatStorage'
import { claimTeamTaskInDB, releaseTeamTaskClaimInDB } from './agentTeamTaskDispatch'

const db = vi.hoisted(() => ({ current: undefined as ChatSession | undefined, deleted: false, fail: false, queue: Promise.resolve() }))
vi.mock('./chatStorage', () => ({
  hasSessionDeleteTombstone: () => db.deleted,
  sameTeamLifecycle: (a: ChatSession, b: ChatSession) => a.teamGeneration === b.teamGeneration && a.teamLifecycleRevision === b.teamLifecycleRevision,
  compareAndUpdateSessionInDB: (_id: string, _scope: string, options: { expectedSession: ChatSession; shouldUpdate: (current: ChatSession) => boolean; update: (current: ChatSession) => ChatSession }) => {
    const operation = db.queue.then(() => {
      if (db.fail) throw new Error('commit failed')
      const current = structuredClone(db.current)
      if (!current || JSON.stringify(current) !== JSON.stringify(options.expectedSession) || !options.shouldUpdate(current)) return null
      db.current = structuredClone(options.update(current))
      return structuredClone(db.current)
    })
    db.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}))

const lead = (): ChatSession => ({ id: 'lead', title: 'lead', messages: [], teamGeneration: 0, teamLifecycleRevision: 0, teamTasks: [
  { id: 'a', title: 'a', ownerId: '', status: 'pending', dependsOn: [] },
  { id: 'b', title: 'b', ownerId: '', status: 'pending', dependsOn: ['a'] }
] })
const claim = (expectedLead: ChatSession, taskId = 'a') => claimTeamTaskInDB({ scope: 'test', leadId: 'lead', expectedLead, taskId })

beforeEach(() => { db.current = lead(); db.deleted = false; db.fail = false; db.queue = Promise.resolve() })

describe('persistent task claim adapter', () => {
  it('claims only a pending ready task and preserves the rest of the lead', async () => {
    const before = lead()
    const result = await claim(before)
    expect(result.teamTasks?.[0].status).toBe('running')
    expect(result.messages).toEqual(before.messages)
    expect(before.teamTasks?.[0].status).toBe('pending')
    expect(db.current).toEqual(result)
  })
  it('rejects blocked, invalid or missing tasks without changing storage', async () => {
    const before = lead()
    await expect(claim(before, 'b')).rejects.toThrow()
    await expect(claim(before, 'missing')).rejects.toThrow()
    db.current!.teamTasks![0].dependsOn = ['missing']
    const invalid = structuredClone(db.current!)
    await expect(claim(invalid)).rejects.toThrow()
    expect(db.current).toEqual(invalid)
  })
  it.each(['prerequisite becomes pending', 'new unfinished prerequisite'])('rejects a stale ready claim when %s before the transaction', async change => {
    const ready = lead()
    ready.teamTasks![0].status = 'done'
    db.current = structuredClone(ready)
    let release!: () => void
    db.queue = new Promise<void>(resolve => { release = resolve })
    const pending = claim(ready, 'b')
    if (change === 'prerequisite becomes pending') {
      db.current.teamTasks![0].status = 'pending'
    } else {
      db.current.teamTasks!.push({ id: 'c', title: 'c', ownerId: '', status: 'pending', dependsOn: [] })
      db.current.teamTasks![1].dependsOn.push('c')
    }
    const blocked = structuredClone(db.current)
    release()
    await expect(pending).rejects.toThrow('Team claim conflict')
    expect(db.current).toEqual(blocked)
    expect(db.current.teamTasks![1].status).toBe('pending')
    // Even a fresh snapshot cannot claim a task whose dependencies are unfinished.
    await expect(claim(blocked, 'b')).rejects.toThrow()
    expect(db.current).toEqual(blocked)
  })
  it('permits only one of two claims based on the same snapshot', async () => {
    const expected = lead()
    const results = await Promise.allSettled([claim(expected), claim(expected)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(results[1].status).toBe('rejected')
    if (results[1].status !== 'rejected') throw new Error('Expected the second claim to reject')
    expect(results[1].reason).toEqual(new Error('Team claim conflict'))
    expect(db.current?.teamTasks?.[0].status).toBe('running')
    expect(db.current).toEqual({ ...expected, teamTasks: [{ ...expected.teamTasks![0], status: 'running' }, ...expected.teamTasks!.slice(1)] })
  })
  it('rejects stale baselines, End revisions, tombstones and invalid identity', async () => {
    const expected = lead()
    db.current!.title = 'concurrent edit'
    await expect(claim(expected)).rejects.toThrow('conflict')
    db.current = { ...lead(), teamGeneration: 1, teamLifecycleRevision: 1 }
    await expect(claim(expected)).rejects.toThrow('conflict')
    db.current = lead(); db.deleted = true
    await expect(claim(expected)).rejects.toThrow()
    db.deleted = false
    for (const invalid of [{ ...lead(), id: 'other' }, { ...lead(), archived: true }, { ...lead(), teamLeadId: 'other' }, { ...lead(), teamLifecycleRevision: -1 }, { ...lead(), storageScope: 'other' }]) {
      await expect(claim(invalid)).rejects.toThrow()
    }
  })
  it('rejects a matching snapshot that is already ended', async () => {
    db.current = { ...lead(), teamEnded: true }
    await expect(claimTeamTaskInDB({ scope: 's', leadId: 'lead', expectedLead: db.current, taskId: 'a' })).rejects.toThrow('Invalid team claim')
    expect(db.current.teamTasks?.[0].status).toBe('pending')
  })

  it('propagates storage failure without a claim', async () => {
    db.fail = true
    await expect(claim(lead())).rejects.toThrow('commit failed')
    expect(db.current).toEqual(lead())
  })
})

describe('persistent task claim release', () => {
  const release = (claimedLead: ChatSession) => releaseTeamTaskClaimInDB({ scope: 'test', leadId: 'lead', claimedLead, taskBeforeClaim: lead().teamTasks![0] })
  it('restores the exact pre-claim record while the stored lead is still the claimed snapshot', async () => {
    const before = lead()
    const claimed = await claim(before)
    const released = await release(claimed)
    expect(released).toEqual(before)
    expect(db.current).toEqual(before)
    // The released task can be claimed again from the original snapshot.
    expect((await claim(before)).teamTasks?.[0].status).toBe('running')
  })
  it('changes nothing when another write landed after the claim', async () => {
    const claimed = await claim(lead())
    db.current!.title = 'concurrent edit'
    const concurrent = structuredClone(db.current)
    expect(await release(claimed)).toBeNull()
    expect(db.current).toEqual(concurrent)
    // The user marked it done in the meantime: still nothing to release.
    const done = { ...structuredClone(claimed), teamTasks: [{ ...claimed.teamTasks![0], status: 'done' as const }, claimed.teamTasks![1]] }
    db.current = structuredClone(done)
    expect(await release(claimed)).toBeNull()
    expect(db.current).toEqual(done)
  })
  it('does not touch an ended, archived or deleted lead, and refuses a release of a task that is not running', async () => {
    const claimed = await claim(lead())
    for (const stored of [{ ...claimed, teamEnded: true }, { ...claimed, archived: true }]) {
      db.current = structuredClone(stored)
      await expect(release(stored)).resolves.toBeNull()
      expect(db.current).toEqual(stored)
    }
    db.current = structuredClone(claimed); db.deleted = true
    await expect(release(claimed)).resolves.toBeNull()
    expect(db.current).toEqual(claimed)
    db.deleted = false
    await expect(releaseTeamTaskClaimInDB({ scope: 'test', leadId: 'lead', claimedLead: lead(), taskBeforeClaim: lead().teamTasks![0] })).rejects.toThrow('Invalid team claim release')
    await expect(releaseTeamTaskClaimInDB({ scope: 'test', leadId: 'lead', claimedLead: claimed, taskBeforeClaim: { ...lead().teamTasks![0], status: 'running' } })).rejects.toThrow('Invalid team claim release')
  })
})
