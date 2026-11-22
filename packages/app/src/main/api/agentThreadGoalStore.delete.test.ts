import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { AGENT_GOAL_LIMITS as LIMITS, type AgentGoalMutation, type AgentGoalStatus } from '@shared/api/agentThreadGoal'
import { AgentThreadGoalStore, type GoalAutoRecord } from './agentThreadGoalStore'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'

type Command = AgentGoalMutation extends infer M ? M extends unknown ? Omit<M, 'expectedRevision' | 'operationId'> : never : never
type Fixture = { file: string; codec: ReturnType<typeof sideTestCodec>; store: AgentThreadGoalStore }
const roots: string[] = [], stores: AgentThreadGoalStore[] = []
let now = 0
beforeEach(() => { now = 100 })
afterEach(() => { vi.restoreAllMocks(); stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const spec = normalizeAgentGoalSpec({ objective: 'synthetic objective' })
const open = (t: Pick<Fixture, 'file' | 'codec'>) => { const store = new AgentThreadGoalStore(t.codec, t.file); stores.push(store); return store }
const close = (store: AgentThreadGoalStore) => { store.close(); stores.splice(stores.indexOf(store), 1) }
function setup(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'goal-delete-')); roots.push(root)
  const t = { file: path.join(root, 'goals.sqlite'), codec: sideTestCodec() }
  return { ...t, store: open(t) }
}
/** A user mutation at the store's current collection revision, with a fixed clock. */
const apply = (store: AgentThreadGoalStore, command: Command, operationId: string = randomUUID()) =>
  store.mutateUser(scope, { ...command, expectedRevision: store.read(scope).revision, operationId } as AgentGoalMutation, now++)
const goalOf = (store: AgentThreadGoalStore, goalId: string) => store.read(scope).goals.find(goal => goal.id === goalId)!
const create = (store: AgentThreadGoalStore, title: string) => { const goalId = randomUUID(); apply(store, { action: 'create', goalId, title, spec }); return goalId }
const control = (store: AgentThreadGoalStore, goalId: string, status: 'active' | 'waiting' | 'blocked' | 'paused' | 'cancelled') =>
  apply(store, { action: 'control', goalId, expectedGeneration: goalOf(store, goalId).generation, status, reason: 'synthetic' })
const remove = (store: AgentThreadGoalStore, goalId: string, operationId?: string) =>
  apply(store, { action: 'delete', goalId, expectedGeneration: goalOf(store, goalId).generation }, operationId)
const record = (goalId: string, generation: number, state: GoalAutoRecord['state'], stopRequested = false): GoalAutoRecord =>
  ({ id: randomUUID(), goalId, generation, deadlineAt: 10_000, state, stopRequested })
/** Writes an authenticated row the way an older or future build could have left it, then reopens the store. */
function writeRow(t: Fixture, document: (storageRevision: number) => unknown): void {
  close(t.store)
  const db = new NodeSQLiteAdapter(t.file)
  try {
    const row = db.get('SELECT owner,revision FROM goals')!, revision = Number(row.revision) + 1
    const plain = Buffer.from(JSON.stringify(document(revision)))
    const cipher = t.codec.encryptBytes(plain, `magicpot-goals-v1:${row.owner}:${revision}`); plain.fill(0)
    db.prepare('UPDATE goals SET revision=?,cipher=? WHERE owner=?').run(revision, cipher, String(row.owner))
  } finally { db.close() }
  t.store = open(t)
}
function readRow(t: Fixture): { revision: number; cipher: Buffer; document: Record<string, unknown> } {
  const db = new NodeSQLiteAdapter(t.file)
  try {
    const row = db.get('SELECT owner,revision,cipher FROM goals')!
    const plain = t.codec.decryptBytes(row.cipher as Uint8Array, `magicpot-goals-v1:${row.owner}:${row.revision}`, LIMITS.plainBytes)
    try { return { revision: Number(row.revision), cipher: Buffer.from(row.cipher as Uint8Array), document: JSON.parse(plain.toString('utf8')) } } finally { plain.fill(0) }
  } finally { db.close() }
}

describe('a goal delete rewrites only the chosen goal', () => {
  it('leaves a stale claimed record of another goal as it was stored', () => {
    const t = setup(), a = create(t.store, 'A')
    control(t.store, a, 'active'); control(t.store, a, 'paused')
    const b = create(t.store, 'B'), collection = t.store.read(scope)
    expect(collection.goals.map(goal => [goal.id, goal.status, goal.generation])).toEqual([[a, 'paused', 3], [b, 'draft', 1]])
    const stored = record(a, 2, 'claimed')
    writeRow(t, storageRevision => ({ version: 3, storageRevision, collection, records: [stored] }))
    const before = t.store.readAutoRecords(scope), goalA = goalOf(t.store, a)
    remove(t.store, b)
    const after = t.store.readAutoRecords(scope)
    expect(after.records).toEqual([stored])
    expect(after.storageRevision).toBe(before.storageRevision + 1)
    expect(t.store.read(scope)).toMatchObject({ revision: collection.revision + 1, goals: [goalA], retiredIds: [b] })
  })

  it('marks unknown exactly the stale claimed record of the deleted goal', () => {
    const t = setup(), a = create(t.store, 'A')
    control(t.store, a, 'active'); control(t.store, a, 'paused')
    const b = create(t.store, 'B')
    control(t.store, b, 'active'); control(t.store, b, 'paused')
    const collection = t.store.read(scope)
    const records = [record(a, 2, 'stopped', true), record(a, 2, 'completed'), record(b, 2, 'expired'), record(b, 2, 'claimed')]
    writeRow(t, storageRevision => ({ version: 3, storageRevision, collection, records }))
    remove(t.store, b)
    expect(t.store.readAutoRecords(scope).records).toEqual([...records.slice(0, 3), { ...records[3], state: 'unknown' }])
    expect(t.store.read(scope).goals).toEqual([goalOf(t.store, a)])
    close(t.store)
    expect(open(t).readAutoRecords(scope).records.map(item => item.state)).toEqual(['stopped', 'completed', 'expired', 'unknown'])
  })

  it.each(['armed', 'claimed'] as const)('keeps an %s record of an active goal when a draft is deleted, also after reopening', state => {
    const t = setup(), a = create(t.store, 'A')
    control(t.store, a, 'active')
    const b = create(t.store, 'B'), id = randomUUID()
    const armed = t.store.mutateAuto(scope, t.store.readAuto(scope).storageRevision, { action: 'arm', id, goalId: a, generation: 2, deadlineAt: 10_000 }, now++)
    if (state === 'claimed') t.store.mutateAuto(scope, armed.storageRevision, { action: 'claim', id }, now++)
    const before = t.store.readAutoRecords(scope), goalA = goalOf(t.store, a)
    expect(before.records).toMatchObject([{ id, goalId: a, state }])
    const removed = remove(t.store, b)
    expect(removed.goals).toEqual([goalA])
    expect(t.store.readAutoRecords(scope)).toEqual({ storageRevision: before.storageRevision + 1, records: before.records })
    close(t.store)
    const reopened = open(t)
    expect(reopened.read(scope)).toEqual(removed)
    expect(reopened.readAutoRecords(scope)).toEqual({ storageRevision: before.storageRevision + 1, records: before.records })
  })

  it('keeps seven goals of every other status in place, frees the slot and retires only the deleted id', () => {
    const t = setup(), ids: Record<AgentGoalStatus, string> = {} as Record<AgentGoalStatus, string>
    for (const status of ['draft', 'active', 'waiting', 'blocked', 'paused', 'cancelled', 'completed', 'failed'] as const) ids[status] = create(t.store, status)
    for (const status of ['active', 'waiting', 'blocked', 'paused', 'completed', 'failed'] as const) control(t.store, ids[status], 'active')
    control(t.store, ids.waiting, 'waiting'); control(t.store, ids.blocked, 'blocked'); control(t.store, ids.paused, 'paused'); control(t.store, ids.cancelled, 'cancelled')
    apply(t.store, { action: 'report', goalId: ids.waiting, expectedGeneration: goalOf(t.store, ids.waiting).generation, summary: 'synthetic progress', evidence: [] })
    apply(t.store, { action: 'propose', goalId: ids.waiting, expectedGeneration: goalOf(t.store, ids.waiting).generation, outcome: 'completed', summary: 'synthetic proposal', evidence: ['synthetic evidence'] })
    for (const outcome of ['completed', 'failed'] as const) {
      apply(t.store, { action: 'propose', goalId: ids[outcome], expectedGeneration: goalOf(t.store, ids[outcome]).generation, outcome, summary: outcome, evidence: ['synthetic evidence'] })
      apply(t.store, { action: 'confirm', goalId: ids[outcome], expectedGeneration: goalOf(t.store, ids[outcome]).generation, outcome })
    }
    const before = t.store.read(scope)
    expect(before.goals.map(goal => goal.status)).toEqual(['draft', 'active', 'waiting', 'blocked', 'paused', 'cancelled', 'completed', 'failed'])
    expect(goalOf(t.store, ids.waiting)).toMatchObject({ progress: { summary: 'synthetic progress' }, proposal: { summary: 'synthetic proposal' } })
    expect(() => create(t.store, 'ninth')).toThrow('capacity')
    const removed = remove(t.store, ids.draft)
    expect(removed.goals).toEqual(before.goals.slice(1))
    expect(removed).toMatchObject({ revision: before.revision + 1, retiredIds: [ids.draft] })
    expect(removed.receipts.slice(0, -1)).toEqual(before.receipts)
    const ninth = create(t.store, 'ninth')
    expect(t.store.read(scope).goals.map(goal => goal.id)).toEqual([...before.goals.slice(1).map(goal => goal.id), ninth])
    expect(() => apply(t.store, { action: 'create', goalId: ids.draft, title: 'again', spec })).toThrow('retired')
  })

  it('keeps a format 1 row in format 1 and a version 2 envelope in version 2 with its record', () => {
    const plain = setup(), a = create(plain.store, 'A'), b = create(plain.store, 'B')
    remove(plain.store, b)
    const row = readRow(plain)
    expect(Object.keys(row.document).sort()).toEqual(['goals', 'receipts', 'retiredIds', 'revision', 'version'])
    expect(row.document).toMatchObject({ version: 1, revision: 3, retiredIds: [b], goals: [{ id: a }] })
    expect(plain.store.readAutoRecords(scope)).toEqual({ storageRevision: 3, records: [] })

    const t = setup(), c = create(t.store, 'C')
    control(t.store, c, 'active')
    const d = create(t.store, 'D'), collection = t.store.read(scope), auto = record(c, 2, 'armed')
    writeRow(t, storageRevision => ({ version: 2, storageRevision, collection, auto }))
    const before = readRow(t)
    remove(t.store, d)
    const after = readRow(t)
    expect(Object.keys(after.document).sort()).toEqual(['auto', 'collection', 'storageRevision', 'version'])
    expect(after.document).toMatchObject({ version: 2, storageRevision: before.revision + 1, auto })
    expect(after.document.auto).toEqual(auto)
  })

  it.each(['encryption', 'read-back verification'] as const)('leaves no partial delete after a %s failure and applies the same operation once later', failure => {
    const t = setup(), a = create(t.store, 'A')
    control(t.store, a, 'active')
    const b = create(t.store, 'B'), id = randomUUID()
    t.store.mutateAuto(scope, t.store.readAuto(scope).storageRevision, { action: 'arm', id, goalId: a, generation: 2, deadlineAt: 10_000 }, now++)
    const collection = t.store.read(scope), records = t.store.readAutoRecords(scope), row = readRow(t)
    const command: AgentGoalMutation = { action: 'delete', goalId: b, expectedGeneration: 1, expectedRevision: collection.revision, operationId: 'synthetic-delete' }
    if (failure === 'encryption') vi.spyOn(t.codec, 'encryptBytes').mockImplementationOnce(() => { throw new Error('Simulated encryption failure') })
    else {
      const read = t.store.read.bind(t.store); let calls = 0
      vi.spyOn(t.store, 'read').mockImplementation(value => { const result = read(value); if (++calls === 2) throw new Error('Simulated read-back failure'); return result })
    }
    expect(() => t.store.mutateUser(scope, command, now++)).toThrow('Simulated')
    vi.restoreAllMocks()
    expect(t.store.read(scope)).toEqual(collection)
    expect(t.store.readAutoRecords(scope)).toEqual(records)
    expect(readRow(t).cipher.equals(row.cipher)).toBe(true)
    close(t.store)
    t.store = open(t)
    expect(t.store.read(scope)).toEqual(collection)
    expect(t.store.readAutoRecords(scope)).toEqual(records)
    const applied = t.store.mutateUser(scope, command, now++)
    expect(applied).toMatchObject({ revision: collection.revision + 1, goals: [goalOf(t.store, a)], retiredIds: [b] })
    expect(t.store.readAutoRecords(scope)).toEqual({ storageRevision: records.storageRevision + 1, records: records.records })
    const written = readRow(t)
    expect(t.store.mutateUser(scope, command, now++)).toEqual(applied)
    expect(readRow(t).cipher.equals(written.cipher)).toBe(true)
    expect(t.store.readAutoRecords(scope).storageRevision).toBe(records.storageRevision + 1)
  })

  it.each(['active', 'waiting', 'blocked'] as const)('refuses to delete a %s goal and writes nothing', status => {
    const t = setup(), a = create(t.store, 'A')
    control(t.store, a, 'active')
    if (status !== 'active') control(t.store, a, status)
    const before = readRow(t), collection = t.store.read(scope)
    expect(() => remove(t.store, a)).toThrow('Pause the goal before deleting it')
    const after = readRow(t)
    expect(after.revision).toBe(before.revision)
    expect(after.cipher.equals(before.cipher)).toBe(true)
    expect(t.store.read(scope)).toEqual(collection)
  })

  // BEGIN IMMEDIATE serialises the two stores, so the loser fails the revision check of the reducer; the
  // conditional write on the storage revision cannot be the deciding refusal without stubbing the read.
  it('refuses a delete from a second store that holds a stale revision and keeps the first delete', () => {
    const t = setup(), other = open(t), a = create(t.store, 'A'), b = create(t.store, 'B')
    const stale = other.read(scope)
    t.store.mutateUser(scope, { action: 'delete', goalId: a, expectedGeneration: 1, expectedRevision: stale.revision, operationId: 'first' }, now++)
    expect(() => other.mutateUser(scope, { action: 'delete', goalId: b, expectedGeneration: 1, expectedRevision: stale.revision, operationId: 'second' }, now++)).toThrow('revision conflict')
    expect(other.read(scope)).toMatchObject({ goals: [{ id: b }], retiredIds: [a] })
  })

  it.each(['create', 'update'] as const)('keeps the conversation-wide record rule for a %s of another goal', action => {
    const t = setup(), a = create(t.store, 'A')
    control(t.store, a, 'active'); control(t.store, a, 'paused')
    const b = create(t.store, 'B'), collection = t.store.read(scope), stored = record(a, 2, 'claimed')
    writeRow(t, storageRevision => ({ version: 3, storageRevision, collection, records: [stored] }))
    if (action === 'create') create(t.store, 'C')
    else apply(t.store, { action: 'update', goalId: b, expectedGeneration: 1, title: 'B2', spec })
    expect(t.store.readAutoRecords(scope).records).toEqual([{ ...stored, state: 'unknown' }])
  })
})
