import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { AgentThreadSideStore } from './agentThreadSideStore'
import { sideTestCodec, sideScope as scope, sideDocument } from './agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
const roots: string[] = [], stores: AgentThreadSideStore[] = []
afterEach(() => { stores.splice(0).forEach((store) => store.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })
const setup = () => { const root = mkdtempSync(path.join(tmpdir(), 'side-store-')); roots.push(root); const file = path.join(root, 'side.sqlite'), codec = sideTestCodec(), store = new AgentThreadSideStore(codec, file); stores.push(store); return { file, codec, store } }
describe('encrypted private side checkpoints', () => {
  it('round-trips and reopens real SQLite without plaintext snapshots/transcripts or profile identifiers', () => {
    const t = setup(), doc = sideDocument(); t.store.save(scope, doc, 0)
    const disk = readFileSync(t.file).toString('latin1')
    for (const secret of ['PRIVATE_SNAPSHOT', 'PRIVATE_QUESTION', 'PRIVATE_SIDE_TITLE', 'profile', 'MODEL']) expect(disk).not.toContain(secret)
    t.store.close(); stores.splice(stores.indexOf(t.store), 1)
    const reopened = new AgentThreadSideStore(t.codec, t.file); stores.push(reopened)
    expect(reopened.read(scope, doc.id)).toEqual(doc)
    expect(reopened.read({ ...scope, conversationId: 'other' }, doc.id)).toBeUndefined()
    expect(reopened.list({ ...scope, route: { ...scope.route, threadId: 'other' } })).toEqual([])
  })
  it('checks revisions and refuses inconsistent/oversized checkpoints before persisting', () => {
    const { store } = setup(), doc = sideDocument(); store.save(scope, doc, 0)
    expect(() => store.save(scope, doc, 0)).toThrow('conflict')
    expect(() => store.save(scope, { ...doc, revision: 2, generation: 2 }, 1)).toThrow('budget')
    expect(() => store.save(scope, { ...doc, revision: 2, snapshot: [{ role: 'user', content: 'x'.repeat(24001) }] }, 1)).toThrow()
    expect(store.read(scope, doc.id)).toEqual(doc)
    store.delete(scope, doc.id, 1); expect(store.list(scope)).toEqual([])
    expect(() => store.save(scope, doc, 0)).toThrow('Deleted side identity')
  })
  it('authenticates owner/id/revision and rejects ciphertext swaps or corruption', () => {
    const { store, file } = setup(), a = sideDocument(), b = sideDocument(randomUUID()); store.save(scope, a, 0); store.save(scope, b, 0)
    const db = new NodeSQLiteAdapter(file)
    try { db.prepare('UPDATE branches SET cipher=(SELECT cipher FROM branches WHERE id=?) WHERE id=?').run(a.id, b.id); expect(() => store.read(scope, b.id)).toThrow('UNAVAILABLE'); expect(store.read(scope, a.id)).toEqual(a) }
    finally { db.close() }
  })
  it('rejects unexpected schema/triggers and ciphertext lengths before unbounded decryption', () => {
    const t = setup(), doc = sideDocument(); t.store.save(scope, doc, 0)
    const decrypt = vi.spyOn(t.codec, 'decryptBytes'), db = new NodeSQLiteAdapter(t.file)
    try {
      db.exec('UPDATE branches SET cipher=zeroblob(500000)'); expect(() => t.store.read(scope, doc.id)).toThrow('bounded'); expect(decrypt).not.toHaveBeenCalled()
      db.exec('CREATE TRIGGER surprise AFTER DELETE ON branches BEGIN SELECT 1; END;'); expect(() => t.store.list(scope)).toThrow('schema')
    } finally { db.close() }
  })
  it.each([4096, 65536])('caps actual database bytes for %i-byte pages rather than assuming4KiB', size => {
    const root = mkdtempSync(path.join(tmpdir(), 'side-page-budget-')); roots.push(root)
    const file = path.join(root, 'side.sqlite'), seed = new NodeSQLiteAdapter(file)
    seed.exec(`PRAGMA page_size=${size};VACUUM;`); seed.close()
    const store = new AgentThreadSideStore(sideTestCodec(), file); stores.push(store)
    store.save(scope, sideDocument(), 0)
    const internal = (store as unknown as { db: NodeSQLiteAdapter }).db
    expect(internal.get('PRAGMA max_page_count')?.max_page_count).toBe(Math.floor(96 * 1024 * 1024 / size))
  })
  it('subtracts current ciphertext when checking a near-capacity replacement', () => {
    const { store } = setup(), first = sideDocument(); store.save(scope, first, 0)
    const db = (store as unknown as { db: NodeSQLiteAdapter }).db, original = db.get.bind(db)
    // Synthetic aggregate edge: reachable fixtures stay below total64MiB under
    // default128×480KiB caps. This directly tests replacement arithmetic only.
    vi.spyOn(db, 'get').mockImplementation((sql, ...args) => sql.startsWith('SELECT count(*) AS n,coalesce(sum(length(cipher)),0)') ? { n: 128, bytes: 64 * 1024 * 1024 } : original(sql, ...args))
    expect(store.save(scope, { ...first, revision: 2 }, 1)).toMatchObject({ revision: 2 })
  })
  it('fails closed without encryption and bounds retained branches instead of silently deleting history', () => {
    const codec = sideTestCodec(); codec.available = () => false
    expect(() => new AgentThreadSideStore(codec)).toThrow('unavailable')
    const { store } = setup()
    for (let i = 0; i < 12; i++) store.save(scope, sideDocument(randomUUID()), 0)
    expect(() => store.save(scope, sideDocument(randomUUID()), 0)).toThrow('capacity')
    expect(store.list(scope)).toHaveLength(12)
  })
})
