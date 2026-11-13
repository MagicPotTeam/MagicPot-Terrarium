import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, linkSync, mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import type { AgentGoalMutation, AgentModelGoalMutation } from '@shared/api/agentThreadGoal'
import { AGENT_GOAL_LIMITS as LIMITS } from '@shared/api/agentThreadGoal'
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
const roots: string[] = [], stores: AgentThreadGoalStore[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })
const create = (goalId: string = randomUUID(), expectedRevision = 0, operationId = 'CREATE_PRIVATE_OP'): AgentGoalMutation => ({ action: 'create', goalId, expectedRevision, operationId, title: 'PRIVATE_GOAL_TITLE', spec: normalizeAgentGoalSpec({ objective: 'PRIVATE_GOAL_OBJECTIVE' }) })
const setup = (pageSize?: number) => {
  const root = mkdtempSync(path.join(tmpdir(), 'goal-data-')); roots.push(root)
  const file = path.join(root, 'goals.sqlite'), codec = sideTestCodec()
  if (pageSize) { const db = new NodeSQLiteAdapter(file); db.exec(`PRAGMA page_size=${pageSize};VACUUM;`); db.close() }
  const store = new AgentThreadGoalStore(codec, file); stores.push(store)
  return { file, root, codec, store }
}
describe('bounded encrypted conversation goal checkpoints (no runtime admission)', () => {
  it('persists ciphertext only and reopens exact data without widening canonical conversation ownership', () => {
    const t = setup(), req = create(), saved = t.store.mutateUser(scope, req, 100)
    expect(saved).toMatchObject({ revision: 1, goals: [{ id: req.goalId, status: 'draft', generation: 1 }] })
    const disk = readFileSync(t.file).toString('latin1')
    for (const secret of ['PRIVATE_GOAL_TITLE', 'PRIVATE_GOAL_OBJECTIVE', req.operationId]) expect(disk).not.toContain(secret)
    t.store.close(); stores.splice(stores.indexOf(t.store), 1)
    const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
    expect(reopened.read(scope)).toEqual(saved)
    expect(reopened.read({ ...scope, conversationId: 'other' })).toMatchObject({ revision: 0, goals: [] })
    expect(reopened.read({ ...scope, route: { ...scope.route, threadId: 'other' } })).toMatchObject({ revision: 0, goals: [] })
    expect(() => reopened.read({ ...scope, route: { ...scope.route, scopeId: 'bad:collision' } })).toThrow('scope')
  })
  it('recovers exact retained receipts as current state, rejects changed payload or actor, and canonicalizes object order', () => {
    const t = setup(), req = create(); t.store.mutateUser(scope, req, 100)
    const active: AgentGoalMutation = { action: 'control', goalId: req.goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'activate', status: 'active', reason: 'User activation, no execution' }
    const current = t.store.mutateUser(scope, active, 101)
    expect(t.store.mutateUser(scope, req, 102)).toEqual(current)
    const reordered = Object.fromEntries(Object.entries(req).reverse()) as AgentGoalMutation
    expect(t.store.mutateUser(scope, reordered, 102)).toEqual(current)
    expect(() => t.store.mutateUser(scope, { ...req, title: 'changed' } as AgentGoalMutation, 103)).toThrow('replay conflict')
    const report: AgentModelGoalMutation = { action: 'report', goalId: req.goalId, expectedRevision: 2, expectedGeneration: 2, operationId: 'report-op', summary: 'Progress', evidence: [] }
    const model = t.store.mutateModel(scope, report, { goalId: req.goalId, generation: 2 }, 104)
    expect(t.store.mutateModel(scope, report, { generation: 2, goalId: req.goalId }, 105)).toEqual(model)
    expect(() => t.store.mutateUser(scope, report, 105)).toThrow('revision conflict')
    expect(() => t.store.mutateModel(scope, { ...report, expectedRevision: 3, expectedGeneration: 1 }, { goalId: req.goalId, generation: 1 }, 106)).toThrow('binding')
    expect(() => t.store.mutateModel(scope, active as unknown as AgentModelGoalMutation, { goalId: req.goalId, generation: 2 }, 106)).toThrow('binding')
  })
  it('keeps empty-owner revisions and retired IDs after deletion, including after receipt eviction', () => {
    const t = setup(), req = create(); t.store.mutateUser(scope, req, 100)
    const removed = t.store.mutateUser(scope, { action: 'delete', goalId: req.goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'delete' }, 101)
    expect(removed).toMatchObject({ revision: 2, goals: [], retiredIds: [req.goalId] })
    expect(t.store.mutateUser(scope, req, 102)).toEqual(removed)
    expect(() => t.store.mutateUser(scope, create(req.goalId, 2, 'recreate'), 103)).toThrow('retired')
    const next = create(randomUUID(), 2, 'next'); t.store.mutateUser(scope, next, 104)
    for (let revision = 3; revision < 70; revision++) t.store.mutateUser(scope, { action: 'update', goalId: next.goalId, expectedRevision: revision, expectedGeneration: revision - 2, operationId: `update-${revision}`, title: 'new', spec: normalizeAgentGoalSpec({ objective: 'x' }) }, 104 + revision)
    expect(t.store.read(scope).receipts).toHaveLength(64)
    expect(() => t.store.mutateUser(scope, req, 200)).toThrow('revision conflict')
    expect(() => t.store.mutateUser(scope, create(req.goalId, 70, 'try-retired'), 201)).toThrow('retired')
  })
  it('performs CAS across two real database connections and rejects stale mutations without lost updates', () => {
    const t = setup(), req = create(); t.store.mutateUser(scope, req, 100)
    const other = new AgentThreadGoalStore(t.codec, t.file); stores.push(other)
    const command: AgentGoalMutation = { action: 'update', goalId: req.goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'one', title: 'one', spec: normalizeAgentGoalSpec({ objective: 'one' }) }
    t.store.mutateUser(scope, command, 101)
    expect(() => other.mutateUser(scope, { ...command, operationId: 'two', title: 'two' }, 102)).toThrow('revision conflict')
    expect(other.read(scope).goals[0].title).toBe('one')
  })
  it('reads revision and bounded ciphertext from one snapshot during a concurrent replacement', () => {
    const t = setup(), req = create(), first = t.store.mutateUser(scope, req, 100)
    const other = new AgentThreadGoalStore(t.codec, t.file); stores.push(other)
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, get = db.get.bind(db); let committed = false
    vi.spyOn(db, 'get').mockImplementation((sql, ...args) => {
      const result = get(sql, ...args)
      if (sql.startsWith('SELECT revision,length(cipher)') && !committed) { committed = true; other.mutateUser(scope, { action: 'update', goalId: req.goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'replace', title: 'new', spec: normalizeAgentGoalSpec({ objective: 'new' }) }, 101) }
      return result
    })
    expect(t.store.read(scope)).toEqual(first); expect(t.store.read(scope).revision).toBe(2)
  })
  it.each(['owner', 'revision', 'cipher'] as const)('authenticates %s and rolls back when a checkpoint is tampered', kind => {
    const t = setup(), req = create(), secondScope = { ...scope, conversationId: 'second' }
    t.store.mutateUser(scope, req, 100); t.store.mutateUser(secondScope, create(), 100)
    const db = new NodeSQLiteAdapter(t.file)
    try {
      const rows = db.all('SELECT owner,cipher FROM goals ORDER BY rowid'), first = String(rows[0].owner)
      if (kind === 'owner') db.prepare('UPDATE goals SET cipher=? WHERE owner=?').run(rows[1].cipher as Uint8Array, first)
      else if (kind === 'revision') db.prepare('UPDATE goals SET revision=2 WHERE owner=?').run(first)
      else { const bytes = Buffer.from(rows[0].cipher as Uint8Array); bytes[bytes.length - 1] ^= 1; db.prepare('UPDATE goals SET cipher=? WHERE owner=?').run(bytes, first) }
      expect(() => t.store.read(scope)).toThrow('UNAVAILABLE')
      expect(() => t.store.mutateUser(scope, create(randomUUID(), 1, 'tampered'), 101)).toThrow('UNAVAILABLE')
      expect(db.get('SELECT count(*) AS n FROM goals')?.n).toBe(2)
    } finally { db.close() }
  })
  it('refuses foreign schema, codecs without OS availability and unsafe database paths', () => {
    const t = setup(), db = new NodeSQLiteAdapter(t.file)
    try { db.exec('CREATE TABLE foreign_table(value TEXT)'); expect(() => t.store.read(scope)).toThrow('schema') } finally { db.close() }
    expect(() => new AgentThreadGoalStore({ ...t.codec, available: () => false }, ':memory:')).toThrow('unavailable')
    expect(() => new AgentThreadGoalStore(t.codec, 'relative.sqlite')).toThrow('absolute')
    const hardlink = path.join(t.root, 'alias.sqlite'); linkSync(t.file, hardlink)
    expect(() => new AgentThreadGoalStore(t.codec, hardlink)).toThrow('Unsafe')
    const dir = path.join(t.root, 'real'); mkdirSync(dir)
    const junction = path.join(t.root, 'junction'); symlinkSync(dir, junction, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => new AgentThreadGoalStore(t.codec, path.join(junction, 'new.sqlite'))).toThrow('Unsafe')
  })
  it.each([1024, 4096, 8192])('enforces actual %s-byte pages and subtracts replacement ciphertext from quota', pageSize => {
    const t = setup(pageSize), req = create()
    if (req.action === 'create') req.spec.objective = 'x'.repeat(8000)
    t.store.mutateUser(scope, req, 100)
    const db = new NodeSQLiteAdapter(t.file)
    try { expect(Number(db.get('PRAGMA page_size')?.page_size)).toBe(pageSize); expect(Number(db.get('PRAGMA page_count')?.page_count) * pageSize).toBeLessThanOrEqual(LIMITS.databaseBytes) } finally { db.close() }
    const reader = (t.store as unknown as { db: NodeSQLiteAdapter }).db, get = reader.get.bind(reader)
    vi.spyOn(reader, 'get').mockImplementation((sql, ...args) => sql.startsWith('SELECT count(*) AS n,coalesce(sum(length(cipher))') ? { n: 1, bytes: LIMITS.totalCipherBytes } : get(sql, ...args))
    const updated = t.store.mutateUser(scope, { action: 'update', goalId: req.goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'small', title: 'x', spec: normalizeAgentGoalSpec({ objective: 'x' }) }, 101)
    expect(updated.revision).toBe(2)
  })
  it('rolls back failed writes/verification and permits exact operation recovery after reopening', () => {
    const t = setup(), req = create(); t.store.mutateUser(scope, req, 100)
    const command: AgentGoalMutation = { action: 'update', goalId: req.goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'second', title: 'new', spec: normalizeAgentGoalSpec({ objective: 'new' }) }
    const read = t.store.read.bind(t.store)
    const spy = vi.spyOn(t.store, 'read'); let calls = 0
    spy.mockImplementation((scope) => { const value = read(scope); if (++calls === 2) throw new Error('Simulated post-write verification loss'); return value })
    expect(() => t.store.mutateUser(scope, command, 101)).toThrow('verification loss'); spy.mockRestore()
    expect(t.store.read(scope)).toMatchObject({ revision: 1, goals: [{ title: 'PRIVATE_GOAL_TITLE' }] })
    const committed = t.store.mutateUser(scope, command, 102)
    t.store.close(); stores.splice(stores.indexOf(t.store), 1)
    const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
    expect(reopened.mutateUser(scope, command, 103)).toEqual(committed)
  })
  it('explicitly does not claim antirollback for an older authenticated owner row', () => {
    const t = setup(), req = create(); t.store.mutateUser(scope, req, 100)
    const db = new NodeSQLiteAdapter(t.file)
    try {
      const old = db.get('SELECT owner,revision,cipher FROM goals')!
      t.store.mutateUser(scope, { action: 'update', goalId: req.goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'later', title: 'later', spec: normalizeAgentGoalSpec({ objective: 'later' }) }, 101)
      db.prepare('UPDATE goals SET revision=?,cipher=? WHERE owner=?').run(old.revision as number, old.cipher as Uint8Array, String(old.owner))
      expect(t.store.read(scope).revision).toBe(1)
      // No runtime capability or automatic run exists to resurrect from this data.
      expect(Object.keys(t.store.read(scope).goals[0])).not.toContain('ticket')
    } finally { db.close() }
  })
  it('refuses goal/owner/retirement capacity without discarding replay domains', () => {
    const t = setup()
    for (let i = 0; i < 8; i++) t.store.mutateUser(scope, create(randomUUID(), i, `create-${i}`), 100 + i)
    expect(() => t.store.mutateUser(scope, create(randomUUID(), 8, 'too-many'), 109)).toThrow('capacity')
    expect(t.store.read(scope).revision).toBe(8)
    const otherScope = { ...scope, conversationId: 'retire' }
    for (let i = 0; i < 64; i++) { const req = create(randomUUID(), i * 2, `c${i}`); t.store.mutateUser(otherScope, req, 100 + i); t.store.mutateUser(otherScope, { action: 'delete', goalId: req.goalId, expectedRevision: i * 2 + 1, expectedGeneration: 1, operationId: `d${i}` }, 100 + i) }
    const last = create(randomUUID(), 128, 'last'); t.store.mutateUser(otherScope, last, 200)
    expect(() => t.store.mutateUser(otherScope, { action: 'delete', goalId: last.goalId, expectedRevision: 129, expectedGeneration: 1, operationId: 'refused' }, 201)).toThrow('retirement capacity')
    expect(t.store.read(otherScope)).toMatchObject({ revision: 129, retiredIds: expect.any(Array) })
    const reader = (t.store as unknown as { db: NodeSQLiteAdapter }).db, get = reader.get.bind(reader)
    vi.spyOn(reader, 'get').mockImplementation((sql, ...args) => sql.startsWith('SELECT count(*) AS n,coalesce(sum(length(cipher))') ? { n: LIMITS.owners, bytes: 100000 } : get(sql, ...args))
    expect(() => t.store.mutateUser({ ...scope, conversationId: 'new-owner' }, create(), 202)).toThrow('owner capacity')
  })
})
