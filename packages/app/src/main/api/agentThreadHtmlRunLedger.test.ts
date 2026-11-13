import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { AgentThreadHtmlRunLedger } from './agentThreadHtmlRunLedger'
import { sideTestCodec } from './agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
const roots: string[] = [], ledgers: AgentThreadHtmlRunLedger[] = []
afterEach(() => { ledgers.splice(0).forEach(item => item.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })
const setup = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-run-ledger-')); roots.push(root)
  const file = path.join(root, 'runs.sqlite'), codec = sideTestCodec(), ledger = AgentThreadHtmlRunLedger.initialize(codec, file); ledgers.push(ledger)
  return { root, file, codec, ledger }
}
describe('durable HTML run quarantine and snapshot admission', () => {
  it('reserves durable slots before launch and only clears by exact runtime-owned ticket', () => {
    const t = setup(); expect(t.ledger.list().every(slot => slot.status === 'clear')).toBe(true)
    const ticket = t.ledger.reserve('a'.repeat(64))
    expect(t.ledger.list()[0]).toMatchObject({ status: 'unconfirmed', generation: 1, ownerHash: 'a'.repeat(64) })
    expect(() => t.ledger.confirmEmpty({ ...ticket })).toThrow('not owned')
    t.ledger.confirmEmpty(ticket); expect(t.ledger.list()[0]).toMatchObject({ status: 'clear', generation: 1, ownerHash: null })
    const successor = t.ledger.reserve('b'.repeat(64)); expect(successor).toMatchObject({ slot: 0, generation: 2 })
    expect(() => t.ledger.confirmEmpty(ticket)).toThrow('not owned'); expect(t.ledger.list()[0].status).toBe('unconfirmed')
    t.ledger.confirmEmpty(successor)
  })
  it('retains all four unknown slots through close/restart and blocks even a different saved ID', () => {
    const t = setup(), oldTicket = t.ledger.reserve('a'.repeat(64), randomUUID())
    for (let i = 0; i < 3; i++) t.ledger.reserve('a'.repeat(64))
    expect(() => t.ledger.reserve('c'.repeat(64), randomUUID())).toThrow('capacity')
    t.ledger.close(); ledgers.splice(ledgers.indexOf(t.ledger), 1)
    const restarted = new AgentThreadHtmlRunLedger(t.codec, t.file); ledgers.push(restarted)
    expect(restarted.list().filter(slot => slot.status === 'unconfirmed')).toHaveLength(4)
    expect(() => restarted.confirmEmpty(oldTicket)).toThrow('not owned')
    expect(() => restarted.reserve('d'.repeat(64), randomUUID())).toThrow('capacity')
  })
  it('serializes duplicate saved runs across independent database connections without giving second runtime clearing authority', () => {
    const t = setup(), second = new AgentThreadHtmlRunLedger(t.codec, t.file); ledgers.push(second)
    const id = randomUUID(), ticket = t.ledger.reserve('a'.repeat(64), id)
    expect(() => second.reserve('a'.repeat(64), id)).toThrow('unconfirmed')
    expect(() => second.confirmEmpty(ticket)).toThrow('not owned')
    t.ledger.confirmEmpty(ticket)
    expect(second.reserve('a'.repeat(64), id)).toMatchObject({ slot: 0, generation: 2 })
  })
  it('requires explicit fresh initialization and rejects missing/partial/truncated ledgers instead of resetting', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'html-run-init-')); roots.push(root)
    const file = path.join(root, 'runs.sqlite'), codec = sideTestCodec()
    expect(() => new AgentThreadHtmlRunLedger(codec, file)).toThrow('missing')
    writeFileSync(file + '.anchor', randomUUID() + '\n')
    expect(() => AgentThreadHtmlRunLedger.initialize(codec, file)).toThrow('incomplete')
    rmSync(file + '.anchor')
    const ledger = AgentThreadHtmlRunLedger.initialize(codec, file); ledgers.push(ledger); ledger.close(); ledgers.pop()
    writeFileSync(file, '')
    expect(() => new AgentThreadHtmlRunLedger(codec, file)).toThrow('schema')
    expect(() => new AgentThreadHtmlRunLedger(codec, file, { epoch: readFileSync(file + '.anchor', 'ascii').trim(), capability: Symbol('forged') } as never)).toThrow('initialization')
    expect(() => AgentThreadHtmlRunLedger.initialize(codec, file)).toThrow('incomplete')
  })
  it('does not expose owner/saved identity in database bytes and authenticates the anchor/record', () => {
    const t = setup(), owner = 'c'.repeat(64), savedId = randomUUID(); t.ledger.reserve(owner, savedId)
    const bytes = readFileSync(t.file); expect(bytes.includes(Buffer.from(owner))).toBe(false); expect(bytes.includes(Buffer.from(savedId))).toBe(false)
    t.ledger.close(); ledgers.splice(ledgers.indexOf(t.ledger), 1)
    writeFileSync(t.file + '.anchor', randomUUID() + '\n')
    expect(() => new AgentThreadHtmlRunLedger(t.codec, t.file)).toThrow('UNAVAILABLE')
  })
  it('rejects same-schema cipher tampering or extra database objects', () => {
    const t = setup(), db = new NodeSQLiteAdapter(t.file)
    try {
      const original = db.get('SELECT cipher FROM ledger WHERE id=1')!.cipher as Uint8Array, bad = Buffer.from(original); bad[bad.length - 1] ^= 1
      db.prepare('UPDATE ledger SET cipher=? WHERE id=1').run(bad); expect(() => t.ledger.list()).toThrow('UNAVAILABLE')
      db.prepare('UPDATE ledger SET cipher=? WHERE id=1').run(original)
      db.exec('CREATE TRIGGER unexpected AFTER UPDATE ON ledger BEGIN SELECT 1; END;'); expect(() => t.ledger.reserve('a'.repeat(64))).toThrow('schema')
    } finally { db.close() }
  })
  it('does not accept a replaced or deleted database/anchor while holding an open connection', () => {
    const t = setup(), backup = path.join(t.root, 'copy.sqlite'); copyFileSync(t.file, backup)
    try {
      rmSync(t.file); copyFileSync(backup, t.file)
      expect(() => t.ledger.list()).toThrow('identity changed')
    } catch (error) {
      // Windows SQLite denies deleting its open file. Assert that native fence,
      // then exercise replacement detection with the unlocked epoch anchor.
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      const anchor = t.file + '.anchor'; copyFileSync(anchor, anchor + '.copy'); rmSync(anchor); copyFileSync(anchor + '.copy', anchor)
      expect(() => t.ledger.list()).toThrow('identity changed')
    }
  })
  it('preflights oversized sidecars before SQLite can recover or checkpoint them', () => {
    const t = setup(); t.ledger.close(); ledgers.splice(ledgers.indexOf(t.ledger), 1)
    const original = readFileSync(t.file)
    writeFileSync(t.file + '-wal', Buffer.alloc(4 * 1024 * 1024 + 1))
    expect(() => new AgentThreadHtmlRunLedger(t.codec, t.file)).toThrow('Unsafe')
    expect(readFileSync(t.file)).toEqual(original)
    expect(() => AgentThreadHtmlRunLedger.initialize(t.codec, t.file)).toThrow('incomplete')
  })
  it('reads revision and bounded cipher in one snapshot even if another connection commits immediately after selection', () => {
    const t = setup(), second = new AgentThreadHtmlRunLedger(t.codec, t.file); ledgers.push(second)
    const db = (t.ledger as unknown as { db: NodeSQLiteAdapter }).db, all = db.all.bind(db)
    let committed = false
    vi.spyOn(db, 'all').mockImplementation((sql, ...args) => {
      const rows = all(sql, ...args)
      if (sql.startsWith('SELECT id,revision,length(cipher)') && !committed) { committed = true; second.reserve('a'.repeat(64)) }
      return rows
    })
    expect(t.ledger.list().every(slot => slot.status === 'clear')).toBe(true)
    expect(t.ledger.list()[0].status).toBe('unconfirmed')
  })
  it('serializes saved-id mutation with run reservations across connections and revalidates admission inside its lock', () => {
    const t = setup(), second = new AgentThreadHtmlRunLedger(t.codec, t.file); ledgers.push(second)
    const savedId = randomUUID(), owner = 'a'.repeat(64)
    expect(() => t.ledger.reserve(owner, savedId, () => { throw new Error('snapshot changed before admission') })).toThrow('snapshot changed')
    expect(t.ledger.list().every(slot => slot.status === 'clear')).toBe(true)
    const ticket = second.reserve(owner, savedId), change = vi.fn()
    expect(() => t.ledger.withSavedIdle(owner, savedId, change)).toThrow('unconfirmed'); expect(change).not.toHaveBeenCalled()
    second.confirmEmpty(ticket)
    expect(t.ledger.list().every(slot => slot.status === 'clear')).toBe(true)
    expect(t.ledger.withSavedIdle(owner, savedId, () => 'committed')).toBe('committed')
    expect(() => t.ledger.withSavedIdle(owner, savedId, () => { throw new Error('snapshot rollback') })).toThrow('snapshot rollback')
    const next = second.reserve(owner, savedId); second.confirmEmpty(next)
    expect(t.ledger.list().every(slot => slot.status === 'clear')).toBe(true)
  })
  it('refuses unavailable encryption and provides no user-confirm override for unknown', () => {
    const t = setup(); t.ledger.reserve('a'.repeat(64)); t.codec.available = () => false
    expect(() => t.ledger.list()).toThrow('unavailable')
    expect(() => AgentThreadHtmlRunLedger.initialize(t.codec, path.join(t.root, 'other.sqlite'))).toThrow('unavailable')
    expect(() => t.ledger.reserve('a'.repeat(64))).toThrow('unavailable')
  })
})
