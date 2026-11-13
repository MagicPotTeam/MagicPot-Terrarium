import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'

const roots: string[] = [], stores: AgentThreadGoalStore[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'goal-auto-')); roots.push(root)
  const file = path.join(root, 'goals.sqlite'), codec = sideTestCodec(), store = new AgentThreadGoalStore(codec, file); stores.push(store)
  const goalId = randomUUID(), id = randomUUID()
  store.mutateUser(scope, { action: 'create', goalId, expectedRevision: 0, operationId: 'create', title: 'PRIVATE_GOAL_TITLE', spec: normalizeAgentGoalSpec({ objective: 'PRIVATE_GOAL_OBJECTIVE' }) }, 10)
  store.mutateUser(scope, { action: 'control', goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'active', status: 'active', reason: 'active' }, 11)
  return { root, file, codec, store, goalId, id }
}
function arm(t: ReturnType<typeof setup>) {
  return t.store.mutateAuto(scope, 2, { action: 'arm', id: t.id, goalId: t.goalId, generation: 2, deadlineAt: 100 }, 12)
}
it('migrates v1 without changing the collection, persists encrypted state, and recovers claimed as unknown', () => {
  const t = setup(), before = t.store.read(scope)
  expect(t.store.readAuto(scope)).toEqual({ storageRevision: 2, record: null })
  const a = arm(t); expect(a.record.state).toBe('armed'); expect(t.store.read(scope)).toEqual(before)
  const second = new AgentThreadGoalStore(t.codec, t.file); stores.push(second)
  expect(second.mutateAuto(scope, 3, { action: 'claim', id: t.id }, 20).record.state).toBe('claimed')
  expect(() => t.store.mutateAuto(scope, 3, { action: 'claim', id: t.id }, 20)).toThrow('revision conflict')
  expect(() => t.store.mutateAuto(scope, 4, { action: 'claim', id: t.id }, 20)).toThrow('consumed')
  second.close(); stores.splice(stores.indexOf(second), 1)
  const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
  expect(reopened.mutateAuto(scope, 4, { action: 'recover', id: t.id }, 30).record.state).toBe('unknown')
  expect(() => reopened.mutateAuto(scope, 5, { action: 'claim', id: t.id }, 30)).toThrow('consumed')
  for (const value of ['PRIVATE_GOAL_TITLE', 'PRIVATE_GOAL_OBJECTIVE', t.id, t.goalId]) expect(readFileSync(t.file).toString('latin1')).not.toContain(value)
})
it('expires at the deadline and allows a fresh distinct record', () => {
  const t = setup(); arm(t)
  expect(t.store.mutateAuto(scope, 3, { action: 'claim', id: t.id }, 100).record.state).toBe('expired')
  expect(() => t.store.mutateAuto(scope, 4, { action: 'arm', id: t.id, goalId: t.goalId, generation: 2, deadlineAt: 200 }, 101)).toThrow('already used')
  expect(t.store.mutateAuto(scope, 4, { action: 'arm', id: randomUUID(), goalId: t.goalId, generation: 2, deadlineAt: 200 }, 101).record.state).toBe('armed')
})
it('persists completed and stops a claimed record conservatively', () => {
  const a = setup(); arm(a); a.store.mutateAuto(scope, 3, { action: 'claim', id: a.id }, 20)
  expect(a.store.mutateAuto(scope, 4, { action: 'complete', id: a.id }, 200).record.state).toBe('completed')
  const b = setup(); arm(b); b.store.mutateAuto(scope, 3, { action: 'claim', id: b.id }, 20)
  expect(b.store.mutateAuto(scope, 4, { action: 'stop', id: b.id }, 21).record).toMatchObject({ state: 'unknown', stopRequested: true })
  expect(() => b.store.mutateAuto(scope, 5, { action: 'complete', id: b.id }, 22)).toThrow('cannot complete')
})
it('preserves unknown fence on manual proposal and old collection revision semantics', () => {
  const t = setup(); arm(t); t.store.mutateAuto(scope, 3, { action: 'claim', id: t.id }, 20)
  const proposal = { action: 'propose' as const, goalId: t.goalId, expectedRevision: 2, expectedGeneration: 2, operationId: 'proposal', outcome: 'completed' as const, summary: 'done', evidence: ['evidence'] }
  expect(t.store.mutateUser(scope, proposal, 21).revision).toBe(3)
  expect(t.store.readAuto(scope)).toMatchObject({ storageRevision: 5, record: { state: 'unknown' } })
  expect(t.store.mutateUser(scope, proposal, 22).revision).toBe(3)
  expect(t.store.readAuto(scope).storageRevision).toBe(5)
})
it.each(['armed', 'claimed'] as const)('reopens a closed store with %s intact and requires explicit recovery', state => {
  const t = setup(); arm(t)
  if (state === 'claimed') t.store.mutateAuto(scope, 3, { action: 'claim', id: t.id }, 20)
  const before = t.store.readAuto(scope), collection = t.store.read(scope)
  t.store.close(); stores.splice(stores.indexOf(t.store), 1)
  const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
  expect(reopened.readAuto(scope)).toEqual(before)
  expect(reopened.read(scope)).toEqual(collection)
  if (state === 'claimed') {
    const recovered = reopened.mutateAuto(scope, before.storageRevision, { action: 'recover', id: t.id }, 30)
    expect(recovered.record.state).toBe('unknown')
    expect(() => reopened.mutateAuto(scope, recovered.storageRevision, { action: 'claim', id: t.id }, 31)).toThrow('consumed')
    expect(() => reopened.mutateAuto(scope, recovered.storageRevision, { action: 'arm', id: randomUUID(), goalId: t.goalId, generation: 2, deadlineAt: 100 }, 31)).toThrow('unresolved fence')
    expect(reopened.read(scope)).toEqual(collection)
  } else {
    expect(() => reopened.mutateAuto(scope, before.storageRevision, { action: 'recover', id: t.id }, 30)).toThrow('no transition')
    expect(reopened.readAuto(scope)).toEqual(before)
  }
})

it('stops an armed record when an active goal edit changes its generation', () => {
  const t = setup(); arm(t)
  const edited = t.store.mutateUser(scope, { action: 'update', goalId: t.goalId, expectedRevision: 2, expectedGeneration: 2, operationId: 'edit-generation', title: 'updated', spec: normalizeAgentGoalSpec({ objective: 'updated objective' }) }, 20)
  expect(edited).toMatchObject({ revision: 3, goals: [{ id: t.goalId, generation: 3, status: 'active' }] })
  expect(t.store.readAuto(scope)).toMatchObject({ storageRevision: 4, record: { id: t.id, generation: 2, state: 'stopped' } })
  expect(() => t.store.mutateAuto(scope, 4, { action: 'claim', id: t.id }, 21)).toThrow('consumed')
})

it('manual pause stops armed without changing manual revision', () => {
  const t = setup(); arm(t)
  expect(t.store.mutateUser(scope, { action: 'control', goalId: t.goalId, expectedRevision: 2, expectedGeneration: 2, operationId: 'pause', status: 'paused', reason: 'pause' }, 20).revision).toBe(3)
  expect(t.store.readAuto(scope)).toMatchObject({ storageRevision: 4, record: { state: 'stopped' } })
})
