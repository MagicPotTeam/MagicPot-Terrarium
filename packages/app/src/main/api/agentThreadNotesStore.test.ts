import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const buildRoot = vi.hoisted(() => ({ data: '' }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: buildRoot.data } }) }))
import { AgentThreadNotesStore, getAgentThreadNotesStore, closeAgentThreadNotesStore } from './agentThreadNotesStore'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }
const events: AgentThreadNotesStore[] = []
const roots: string[] = []
const create = (database = ':memory:') => { const store = new AgentThreadNotesStore(database); events.push(store); return store }
const input = (revision = 0) => ({ ...scope, action: 'set' as const, key: 'preference', value: 'Blue', expectedRevision: revision, operationId: randomUUID() })
afterEach(async () => { await closeAgentThreadNotesStore(); vi.unstubAllEnvs(); for (const e of events.splice(0)) e.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('persistent conversation notes', () => {
  it('production factory resolves a tracked buildEnv import and actually persists under its isolated data root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-note-factory-')); roots.push(root)
    buildRoot.data = root
    vi.stubEnv('NODE_ENV', 'production')
    const store = await getAgentThreadNotesStore()
    store.mutate(input())
    await closeAgentThreadNotesStore()
    expect((await getAgentThreadNotesStore()).get(scope)).toMatchObject({ revision: 1, notes: [{ value: 'Blue' }] })
    expect(readFileSync(path.join(root, 'agent-thread-memory', 'notes-v1.sqlite')).length).toBeGreaterThan(0)
  })
  it('survives closing and reopening the actual SQLite store, preserving unrelated resources', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-notes-')); roots.push(root)
    const database = path.join(root, 'notes.sqlite')
    const first = create(database)
    const result = first.mutate(input())
    expect(result).toMatchObject({ revision: 1, notes: [{ key: 'preference', value: 'Blue' }] })
    events[0].close()
    const second = create(database)
    expect(second.get(scope)).toEqual(result)
    expect(second.mutate({ ...scope, action: 'delete', key: 'preference', expectedRevision: 1, operationId: randomUUID() })).toEqual({ revision: 2, notes: [] })
    expect(second.mutate(input(2)).revision).toBe(3)
  })
  it('does not retain old note values after overwrite/delete in its SQLite payload', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-note-purge-')); roots.push(root)
    const database = path.join(root, 'notes.sqlite')
    const store = create(database)
    store.mutate({ ...input(), value: 'UNIQUE_SENSITIVE_OLD_NOTE_XYZZY' })
    store.mutate({ ...input(1), value: 'Replacement' })
    store.mutate({ ...scope, action: 'delete', key: 'preference', expectedRevision: 2, operationId: randomUUID() })
    store.close()
    expect(readFileSync(database).includes(Buffer.from('UNIQUE_SENSITIVE_OLD_NOTE_XYZZY'))).toBe(false)
  })
  it.each(['trigger', 'extra-table', 'schema-change'])('refuses %s tampering without claiming a saved mutation', (tamper) => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-note-schema-')); roots.push(root)
    const database = path.join(root, 'notes.sqlite')
    const store = create(database); store.mutate(input()); store.close()
    const db = new DatabaseSync(database)
    if (tamper === 'trigger') db.exec('CREATE TRIGGER ignore_write BEFORE UPDATE ON notes BEGIN SELECT RAISE(IGNORE); END;')
    else if (tamper === 'extra-table') db.exec('CREATE TABLE old_values(value TEXT);')
    else db.exec('ALTER TABLE notes ADD COLUMN unexpected TEXT;')
    db.close()
    expect(() => create(database)).toThrow('schema')
  })
  it('rechecks schema when another connection installs a trigger after open', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-note-live-schema-')); roots.push(root)
    const database = path.join(root, 'notes.sqlite')
    const store = create(database); store.mutate(input())
    const db = new DatabaseSync(database)
    db.exec('CREATE TRIGGER ignore_write BEFORE UPDATE ON notes BEGIN SELECT RAISE(IGNORE); END;'); db.close()
    expect(() => store.mutate({ ...input(1), value: 'Should not report saved' })).toThrow('schema')
  })
  it('separates project/pane/conversation and returns detached data', () => {
    const store = create(); store.mutate(input())
    for (const other of [{ ...scope, conversationId: 'other' }, { ...scope, route: { ...route, threadId: 'other' } }, { ...scope, route: { ...route, scopeId: 'other' } }]) expect(store.get(other)).toEqual({ revision: 0, notes: [] })
    const read = store.get(scope); read.notes[0].value = 'forged'
    expect(store.get(scope).notes[0].value).toBe('Blue')
  })
  it('rejects stale writes and same-operation conflicting replay', () => {
    const store = create(), req = input()
    const saved = store.mutate(req)
    expect(store.mutate(req)).toEqual(saved)
    expect(() => store.mutate({ ...req, value: 'Red' })).toThrow('replay conflict')
    expect(() => store.mutate(input())).toThrow('revision conflict')
    expect(store.get(scope)).toEqual(saved)
  })
  it('clears only current conversation values durably without resetting revision or replay receipts', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-notes-clear-')); roots.push(root)
    const database = path.join(root, 'notes.sqlite'), store = create(database)
    const old = { ...input(), value: 'UNIQUE_CLEAR_NOTE_XYZZY' }
    store.mutate(old); store.mutate({ ...input(1), key: 'second' })
    const other = { ...scope, conversationId: 'other' }
    store.mutate({ ...input(), ...other, value: 'Other conversation' })
    const clear = { ...scope, action: 'clear' as const, expectedRevision: 2, operationId: randomUUID() }
    expect(store.mutate(clear)).toEqual({ revision: 3, notes: [] })
    expect(store.get(other).notes[0].value).toBe('Other conversation')
    expect(store.mutate(old)).toEqual({ revision: 3, notes: [] })
    expect(() => store.mutate({ ...old, value: 'Replay conflict' })).toThrow('replay conflict')
    store.mutate({ ...input(3), value: 'New after clear' })
    expect(store.mutate(clear)).toMatchObject({ revision: 4, notes: [{ value: 'New after clear' }] })
    expect(() => store.mutate({ ...clear, operationId: randomUUID() })).toThrow('revision conflict')
    expect(() => store.mutate({ ...clear, expectedRevision: 4 })).toThrow('replay conflict')
    store.close()
    expect(readFileSync(database).includes(Buffer.from('UNIQUE_CLEAR_NOTE_XYZZY'))).toBe(false)
    const reopened = create(database)
    expect(reopened.mutate(clear)).toMatchObject({ revision: 4, notes: [{ value: 'New after clear' }] })
    expect(reopened.get(other).notes).toHaveLength(1)
  })
  it('clear on an empty scope advances revision and rejects key/value selectors before any write', () => {
    const store = create(), clear = { ...scope, action: 'clear' as const, expectedRevision: 0, operationId: randomUUID() }
    for (const invalid of [{ ...clear, key: 'one' }, { ...clear, key: null }, { ...clear, value: '' }, { ...clear, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...clear, scope: 'all' }, { ...clear, clearAll: true }]) expect(() => store.mutate(invalid as unknown as typeof clear)).toThrow('Invalid')
    expect(store.get(scope)).toEqual({ revision: 0, notes: [] })
    expect(store.mutate(clear)).toEqual({ revision: 1, notes: [] })
    expect(store.mutate(clear)).toEqual({ revision: 1, notes: [] })
  })
  it('evicted clear receipts still cannot erase later values or reset their revision', () => {
    const store = create(), clear = { ...scope, action: 'clear' as const, expectedRevision: 0, operationId: 'old-clear' }
    store.mutate(clear)
    for (let revision = 1; revision <= 65; revision++) store.mutate({ ...input(revision), value: `Later value ${revision}` })
    expect(store.replay(clear)).toBeUndefined()
    expect(() => store.mutate(clear)).toThrow('revision conflict')
    expect(store.get(scope)).toMatchObject({ revision: 66, notes: [{ value: 'Later value 65' }] })
  })
  it('limits number/bytes of notes and rejects dangerous keys, missing values and oversized content', () => {
    const store = create()
    for (const req of [{ ...input(), key: '__proto__' }, { ...input(), value: undefined }, { ...input(), value: 'x'.repeat(4001) }, { ...input(), action: 'delete', value: 'not allowed' }, { ...input(), expectedRevision: -1 }]) expect(() => store.mutate(req as ReturnType<typeof input>)).toThrow('Invalid')
    for (let index = 0; index < 32; index++) store.mutate({ ...input(index), key: `key-${index}` })
    expect(() => store.mutate({ ...input(32), key: 'extra' })).toThrow('capacity')
    expect(store.get(scope).notes).toHaveLength(32)
    const bytes = create()
    for (let index = 0; index < 5; index++) bytes.mutate({ ...input(index), key: `bytes-${index}`, value: '文'.repeat(4000) })
    expect(() => bytes.mutate({ ...input(5), key: 'over-limit', value: '文'.repeat(4000) })).toThrow('capacity')
  })
})
