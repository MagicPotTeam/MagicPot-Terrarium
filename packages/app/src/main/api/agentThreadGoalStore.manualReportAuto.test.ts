import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideScope as scope, sideTestCodec } from './agentThreadSideTestUtils'

const roots: string[] = []
const stores = new Set<AgentThreadGoalStore>()
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each(['armed', 'claimed', 'unknown'] as const)('preserves %s auto record across manual report, replay, conflict and reopen', state => {
  const root = mkdtempSync(path.join(tmpdir(), 'goal-report-auto-'))
  roots.push(root)
  const file = path.join(root, 'goals.sqlite'), codec = sideTestCodec()
  const store = new AgentThreadGoalStore(codec, file); stores.add(store)
  const goalId = randomUUID(), autoId = randomUUID()
  store.mutateUser(scope, { action: 'create', goalId, title: 'Synthetic goal', spec: normalizeAgentGoalSpec({ objective: 'Synthetic objective' }), expectedRevision: 0, operationId: 'create' }, 10)
  store.mutateUser(scope, { action: 'control', goalId, status: 'active', reason: 'Synthetic activation', expectedGeneration: 1, expectedRevision: 1, operationId: 'activate' }, 11)
  store.mutateUser(scope, { action: 'report', goalId, expectedGeneration: 2, expectedRevision: 2, operationId: 'prior-report', summary: 'Before', evidence: [] }, 12)
  let auto = store.mutateAuto(scope, 3, { action: 'arm', id: autoId, goalId, generation: 2, deadlineAt: 100 }, 13)
  if (state !== 'armed') auto = store.mutateAuto(scope, auto.storageRevision, { action: 'claim', id: autoId }, 14)
  if (state === 'unknown') auto = store.mutateAuto(scope, auto.storageRevision, { action: 'recover', id: autoId }, 15)
  expect(auto.record.state).toBe(state)
  const before = store.readAutoRecords(scope)
  const report = { action: 'report' as const, goalId, expectedGeneration: 2, expectedRevision: 3, operationId: 'report', summary: 'After', evidence: [] }
  const updated = store.mutateUser(scope, report, 16)
  expect(updated).toMatchObject({ revision: 4, goals: [{ id: goalId, generation: 2, status: 'active', progress: { summary: 'After', evidence: [] } }] })
  expect(store.readAutoRecords(scope)).toEqual({ storageRevision: before.storageRevision + 1, records: before.records })
  const collection = store.read(scope), snapshot = store.readAutoRecords(scope)
  expect(store.mutateUser(scope, report, 17)).toEqual(collection)
  expect(store.readAutoRecords(scope)).toEqual(snapshot)
  expect(() => store.mutateUser(scope, { ...report, operationId: 'stale' }, 18)).toThrow('revision conflict')
  expect(store.read(scope)).toEqual(collection)
  expect(store.readAutoRecords(scope)).toEqual(snapshot)
  store.close(); stores.delete(store)
  const reopened = new AgentThreadGoalStore(codec, file); stores.add(reopened)
  expect(reopened.read(scope)).toEqual(collection)
  expect(reopened.readAutoRecords(scope)).toEqual(snapshot)
})
