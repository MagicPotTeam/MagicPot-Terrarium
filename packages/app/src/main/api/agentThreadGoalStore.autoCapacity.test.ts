import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'

const roots: string[] = [], stores: AgentThreadGoalStore[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'goal-cap-')); roots.push(root)
  const file = path.join(root, 'goals.sqlite'), codec = sideTestCodec(), store = new AgentThreadGoalStore(codec, file); stores.push(store)
  const goalId = randomUUID()
  store.mutateUser(scope, { action: 'create', goalId, expectedRevision: 0, operationId: 'create', title: 'private title', spec: normalizeAgentGoalSpec({ objective: 'private objective' }) }, 1)
  store.mutateUser(scope, { action: 'control', goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'active', status: 'active', reason: 'active' }, 2)
  return { file, codec, store, goalId }
}
it('retains sixteen distinct records without eviction and fails closed at capacity after reopening', () => {
  const t = setup(), ids: string[] = []
  for (let i = 0; i < 16; i++) {
    const id = randomUUID(); ids.push(id)
    const armed = t.store.mutateAuto(scope, t.store.readAuto(scope).storageRevision, { action: 'arm', id, goalId: t.goalId, generation: 2, deadlineAt: 100 }, 3)
    t.store.mutateAuto(scope, armed.storageRevision, { action: 'stop', id }, 4)
  }
  const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
  const current = reopened.readAutoRecords(scope)
  expect(current.records.map(item => item.id)).toEqual(ids)
  expect(current.records.every(item => item.state === 'stopped')).toBe(true)
  expect(() => reopened.mutateAuto(scope, current.storageRevision, { action: 'arm', id: randomUUID(), goalId: t.goalId, generation: 2, deadlineAt: 100 }, 5)).toThrow('capacity')
  expect(reopened.readAutoRecords(scope)).toEqual(current)
  expect(reopened.read(scope).revision).toBe(2)
})
it('rejects a new arm while unknown is retained and stale competing claims cannot win', () => {
  const t = setup(), id = randomUUID(), other = new AgentThreadGoalStore(t.codec, t.file); stores.push(other)
  const armed = t.store.mutateAuto(scope, 2, { action: 'arm', id, goalId: t.goalId, generation: 2, deadlineAt: 100 }, 3)
  const claimed = other.mutateAuto(scope, armed.storageRevision, { action: 'claim', id }, 4)
  expect(() => t.store.mutateAuto(scope, armed.storageRevision, { action: 'claim', id }, 4)).toThrow('revision conflict')
  const unknown = t.store.mutateAuto(scope, claimed.storageRevision, { action: 'recover', id }, 5)
  expect(() => other.mutateAuto(scope, unknown.storageRevision, { action: 'arm', id: randomUUID(), goalId: t.goalId, generation: 2, deadlineAt: 100 }, 6)).toThrow('unresolved fence')
  expect(other.readAutoRecords(scope).records).toEqual([unknown.record])
})
it('rejects authenticated v3 ordering that hides an unknown fence', () => {
  const t = setup(), collection = t.store.read(scope)
  t.store.close(); stores.splice(stores.indexOf(t.store), 1)
  const db = new NodeSQLiteAdapter(t.file)
  try {
    const row = db.get('SELECT owner,revision FROM goals')!, revision = Number(row.revision) + 1
    const common = { goalId: t.goalId, generation: 2, deadlineAt: 100, stopRequested: false }
    const records = [{ ...common, id: randomUUID(), state: 'unknown' }, { ...common, id: randomUUID(), state: 'stopped' }]
    const plain = Buffer.from(JSON.stringify({ version: 3, storageRevision: revision, collection, records }))
    const cipher = t.codec.encryptBytes(plain, `magicpot-goals-v1:${row.owner}:${revision}`); plain.fill(0)
    db.prepare('UPDATE goals SET revision=?,cipher=? WHERE owner=?').run(revision, cipher, String(row.owner))
  } finally { db.close() }
  const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
  expect(() => reopened.readAuto(scope)).toThrow('fences')
})

it.each(['claimed', 'unknown'] as const)('retains encrypted v2 %s fence across v3 migration and reopening', state => {
  const t = setup(), id = randomUUID(), collection = t.store.read(scope)
  t.store.close(); stores.splice(stores.indexOf(t.store), 1)
  const db = new NodeSQLiteAdapter(t.file)
  try {
    const row = db.get('SELECT owner,revision FROM goals')!, revision = Number(row.revision) + 1
    const record = { id, goalId: t.goalId, generation: 2, deadlineAt: 100, state, stopRequested: false }
    const plain = Buffer.from(JSON.stringify({ version: 2, storageRevision: revision, collection, auto: record }))
    const cipher = t.codec.encryptBytes(plain, `magicpot-goals-v1:${row.owner}:${revision}`); plain.fill(0)
    db.prepare('UPDATE goals SET revision=?,cipher=? WHERE owner=?').run(revision, cipher, String(row.owner))
  } finally { db.close() }
  const store = new AgentThreadGoalStore(t.codec, t.file); stores.push(store)
  expect(store.read(scope)).toEqual(collection)
  expect(store.readAutoRecords(scope)).toMatchObject({ storageRevision: 3, records: [{ id, state }] })
  expect(() => store.mutateAuto(scope, 3, { action: 'arm', id: randomUUID(), goalId: t.goalId, generation: 2, deadlineAt: 100 }, 4)).toThrow('unresolved fence')
  const next = state === 'claimed'
    ? store.mutateAuto(scope, 3, { action: 'recover', id }, 4)
    : store.mutateAuto(scope, 3, { action: 'stop', id }, 4)
  expect(next.record).toMatchObject({ id, state: 'unknown' })
  store.close(); stores.splice(stores.indexOf(store), 1)
  const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
  expect(reopened.read(scope)).toEqual(collection)
  expect(reopened.readAutoRecords(scope)).toMatchObject({ storageRevision: 4, records: [{ id, state: 'unknown' }] })
  expect(() => reopened.mutateAuto(scope, 4, { action: 'claim', id }, 5)).toThrow('consumed')
  expect(() => reopened.mutateAuto(scope, 4, { action: 'arm', id: randomUUID(), goalId: t.goalId, generation: 2, deadlineAt: 100 }, 5)).toThrow('unresolved fence')
  expect(reopened.readAutoRecords(scope).records).toHaveLength(1)
})

it('reads an actual encrypted v2 payload and upgrades it without losing its original ID or collection', () => {
  const t = setup(), id = randomUUID(), collection = t.store.read(scope)
  t.store.close(); stores.splice(stores.indexOf(t.store), 1)
  const db = new NodeSQLiteAdapter(t.file)
  try {
    const row = db.get('SELECT owner,revision,cipher FROM goals')!
    const revision = Number(row.revision) + 1
    const record = { id, goalId: t.goalId, generation: 2, deadlineAt: 100, state: 'stopped', stopRequested: true }
    const plain = Buffer.from(JSON.stringify({ version: 2, storageRevision: revision, collection, auto: record }))
    const cipher = t.codec.encryptBytes(plain, `magicpot-goals-v1:${row.owner}:${revision}`); plain.fill(0)
    db.prepare('UPDATE goals SET revision=?,cipher=? WHERE owner=?').run(revision, cipher, String(row.owner))
  } finally { db.close() }
  const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
  expect(reopened.read(scope)).toEqual(collection)
  expect(reopened.readAutoRecords(scope).records).toMatchObject([{ id, state: 'stopped' }])
  const fresh = randomUUID()
  reopened.mutateAuto(scope, 3, { action: 'arm', id: fresh, goalId: t.goalId, generation: 2, deadlineAt: 100 }, 4)
  expect(reopened.readAutoRecords(scope).records.map(item => item.id)).toEqual([id, fresh])
  const stopped = reopened.mutateAuto(scope, 4, { action: 'stop', id: fresh }, 5)
  expect(() => reopened.mutateAuto(scope, stopped.storageRevision, { action: 'arm', id, goalId: t.goalId, generation: 2, deadlineAt: 100 }, 6)).toThrow('already used')
  expect(reopened.read(scope)).toEqual(collection)
})
