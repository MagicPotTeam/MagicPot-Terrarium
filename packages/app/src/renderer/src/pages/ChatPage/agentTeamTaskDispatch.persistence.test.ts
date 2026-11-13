import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from './chatStorage'
import { claimTeamTaskInDB } from './agentTeamTaskDispatch'

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
