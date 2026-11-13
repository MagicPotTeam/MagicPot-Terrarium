import { getAgentSessionKey } from '@shared/agent'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, linkSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { AgentThreadHtmlStore, HTML_CHECKPOINT_LIMITS as LIMITS, type HtmlCheckpointContent } from './agentThreadHtmlStore'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
const roots: string[] = [], stores: AgentThreadHtmlStore[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })
const contents = (): HtmlCheckpointContent => ({ title: 'SAVED_HTML_TITLE', html: '<script>PRIVATE_HTML_BODY</script>', data: { key: 'PRIVATE_DATA_VALUE' }, state: { tab: 'PRIVATE_STATE' }, documentRevision: 7, surface: 'canvas' })
const setup = (pageSize?: number) => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-checkpoint-')); roots.push(root)
  const file = path.join(root, 'apps.sqlite'), codec = sideTestCodec()
  if (pageSize) { const db = new NodeSQLiteAdapter(file); db.exec(`PRAGMA page_size=${pageSize};VACUUM;`); db.close() }
  const store = new AgentThreadHtmlStore(codec, file); stores.push(store)
  const request = { id: randomUUID(), operationId: 'save-operation', expectedRevision: 0, content: contents() }
  return { root, file, codec, store, request }
}
describe('encrypted HTML checkpoints', () => {
  it('reopens actual SQLite with ciphertext only and separates storage CAS from document revision', () => {
    const t = setup(), first = t.store.save(scope, t.request)
    expect(first).toMatchObject({ documentRevision: 7, storageRevision: 1 })
    const disk = readFileSync(t.file).toString('latin1')
    for (const text of ['SAVED_HTML_TITLE', 'PRIVATE_HTML_BODY', 'PRIVATE_DATA_VALUE', 'PRIVATE_STATE', 'save-operation']) expect(disk).not.toContain(text)
    t.store.close(); stores.splice(stores.indexOf(t.store), 1)
    const reopened = new AgentThreadHtmlStore(t.codec, t.file); stores.push(reopened)
    expect(reopened.read(scope, t.request.id)).toEqual(first)
    expect(reopened.read({ ...scope, conversationId: 'other' }, t.request.id)).toBeUndefined()
    expect(reopened.list({ ...scope, route: { ...scope.route, threadId: 'other' } })).toEqual([])
    expect(() => reopened.save(scope, { ...t.request, expectedRevision: 0, operationId: 'stale' })).toThrow('revision conflict')
    expect(reopened.save(scope, { ...t.request, expectedRevision: 1, operationId: 'next', content: { ...contents(), documentRevision: 8 } })).toMatchObject({ storageRevision: 2, documentRevision: 8 })
  })
  it('reads revision and bounded ciphertext from one snapshot while another connection replaces the checkpoint', () => {
    const t = setup(), first = t.store.save(scope, t.request)
    const second = new AgentThreadHtmlStore(t.codec, t.file); stores.push(second)
    const db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, get = db.get.bind(db)
    let committed = false
    vi.spyOn(db, 'get').mockImplementation((sql, ...args) => {
      const row = get(sql, ...args)
      if (sql.startsWith('SELECT revision,length(cipher)') && !committed) {
        committed = true; second.save(scope, { ...t.request, expectedRevision: 1, operationId: 'concurrent', content: { ...contents(), html: '<p>new snapshot</p>' } })
      }
      return row
    })
    expect(t.store.read(scope, t.request.id)).toEqual(first)
    expect(t.store.read(scope, t.request.id)).toMatchObject({ html: '<p>new snapshot</p>', storageRevision: 2 })
  })
  it('replays exact operations but never replaces the current checkpoint with older data', () => {
    const t = setup(), first = t.store.save(scope, t.request)
    expect(t.store.save(scope, t.request)).toEqual(first)
    expect(() => t.store.save(scope, { ...t.request, content: { ...contents(), html: 'changed' } })).toThrow('replay conflict')
    const second = t.store.save(scope, { ...t.request, operationId: 'second', expectedRevision: 1, content: { ...contents(), html: '<p>NEW</p>' } })
    expect(t.store.save(scope, t.request)).toEqual(second)
    expect(second.receipts[0]).toHaveProperty('operationHash', createHash('sha256').update(t.request.operationId).digest('hex'))
  })
  it('atomically deletes current content and refuses all delayed save/recreate attempts for retired IDs', () => {
    const t = setup(); t.store.save(scope, t.request)
    expect(() => t.store.delete(scope, t.request.id, 2)).toThrow('revision conflict')
    expect(t.store.read(scope, t.request.id)).toBeTruthy()
    t.store.delete(scope, t.request.id, 1); t.store.delete(scope, t.request.id, 1)
    expect(t.store.list(scope)).toEqual([])
    expect(() => t.store.save(scope, t.request)).toThrow('Deleted HTML identity')
    expect(() => t.store.save(scope, { ...t.request, expectedRevision: 0, operationId: 'new' })).toThrow('Deleted HTML identity')
  })
  it('authenticates owner AAD independently from ID and storage revision', () => {
    const t = setup(), other = { ...scope, conversationId: 'different-owner' }
    t.store.save(scope, t.request); t.store.save(other, { ...t.request, content: { ...contents(), title: 'Other owner' } })
    const db = new NodeSQLiteAdapter(t.file)
    try {
      const rows = db.all('SELECT owner,cipher FROM apps WHERE id=?', t.request.id)
      expect(rows).toHaveLength(2)
      const firstKey = createHash('sha256').update(JSON.stringify([getAgentSessionKey(scope.route), scope.conversationId])).digest('hex')
      const originalOwner = rows.find(row => row.owner === firstKey)!
      const target = rows.find(row => row.owner !== firstKey)!
      db.prepare('UPDATE apps SET cipher=? WHERE owner=? AND id=?').run(originalOwner.cipher as Uint8Array, String(target.owner), t.request.id)
      expect(t.store.read(scope, t.request.id)).toMatchObject({ title: 'SAVED_HTML_TITLE' })
      expect(() => t.store.read(other, t.request.id)).toThrow('UNAVAILABLE')
    } finally { db.close() }
  })
  it.each(['id', 'revision', 'cipher'] as const)('binds ciphertext to %s and refuses tampered records', kind => {
    const t = setup(); t.store.save(scope, t.request); const second = { ...t.request, id: randomUUID() }; t.store.save(scope, second)
    const db = new NodeSQLiteAdapter(t.file)
    try {
      if (kind === 'id') db.prepare('UPDATE apps SET cipher=(SELECT cipher FROM apps WHERE id=?) WHERE id=?').run(t.request.id, second.id)
      else if (kind === 'revision') db.prepare('UPDATE apps SET revision=2 WHERE id=?').run(second.id)
      else { const row = db.get('SELECT cipher FROM apps WHERE id=?', second.id)!; const bad = Buffer.from(row.cipher as Uint8Array); bad[bad.length - 1] ^= 1; db.prepare('UPDATE apps SET cipher=? WHERE id=?').run(bad, second.id) }
      expect(() => t.store.read(scope, second.id)).toThrow('UNAVAILABLE')
    } finally { db.close() }
  })
  it('refuses oversized ciphers before decrypt and refuses altered schema/triggers', () => {
    const t = setup(); t.store.save(scope, t.request); const decrypt = vi.spyOn(t.codec, 'decryptBytes'), db = new NodeSQLiteAdapter(t.file)
    try {
      db.exec(`UPDATE apps SET cipher=zeroblob(${LIMITS.cipherBytes + 1})`)
      expect(() => t.store.read(scope, t.request.id)).toThrow('size'); expect(decrypt).not.toHaveBeenCalled()
      db.exec('CREATE TRIGGER unexpected AFTER DELETE ON apps BEGIN SELECT 1; END;')
      expect(() => t.store.list(scope)).toThrow('schema')
    } finally { db.close() }
  })
  it('has no plaintext fallback on missing/changed keys and rejects foreign persisted authority fields', () => {
    const t = setup(); t.store.save(scope, t.request)
    t.store.close(); stores.splice(stores.indexOf(t.store), 1)
    const wrong = new AgentThreadHtmlStore(sideTestCodec(), t.file); stores.push(wrong)
    expect(() => wrong.read(scope, t.request.id)).toThrow('UNAVAILABLE')
    t.codec.available = () => false
    expect(() => new AgentThreadHtmlStore(t.codec)).toThrow('unavailable')
    expect(() => wrong.save(scope, { ...t.request, content: { ...contents(), sender: 71, processId: 99, grantsPermission: true } as never })).toThrow('content')
  })
  it('rolls back at owner capacity and never evicts replay receipts silently outside their64 limit', () => {
    const t = setup(); t.store.save(scope, t.request)
    for (let i = 1; i < LIMITS.perScope; i++) t.store.save(scope, { ...t.request, id: randomUUID() })
    expect(() => t.store.save(scope, { ...t.request, id: randomUUID() })).toThrow('capacity')
    expect(t.store.list(scope)).toHaveLength(LIMITS.perScope)
    let revision = 1
    for (let i = 0; i < 66; i++) revision = t.store.save(scope, { ...t.request, expectedRevision: revision, operationId: `op-${i}` }).storageRevision
    expect(t.store.read(scope, t.request.id)?.receipts).toHaveLength(64)
    expect(() => t.store.save(scope, t.request)).toThrow('revision conflict')
  })
  it('fails deletion at a full retired ledger and leaves the encrypted checkpoint intact', () => {
    const t = setup(); const saved = t.store.save(scope, t.request), db = new NodeSQLiteAdapter(t.file)
    try {
      db.exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<${LIMITS.retired}) INSERT INTO retired(owner,id) SELECT 'fixed-owner',printf('%036d',n) FROM seq;`)
      expect(() => t.store.delete(scope, t.request.id, 1)).toThrow('ledger capacity')
      expect(t.store.read(scope, t.request.id)).toEqual(saved)
      expect(db.get('SELECT count(*) AS n FROM retired')?.n).toBe(LIMITS.retired)
    } finally { db.close() }
  })
  it('accounts replacement as total-old+new and rolls back new inserts above the global byte budget', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'html-capacity-')); roots.push(root)
    const real = sideTestCodec(), codec = { ...real,
      encryptBytes(bytes: Uint8Array, aad: string) { const cipher = real.encryptBytes(bytes, aad), wrapped = Buffer.alloc(LIMITS.cipherBytes); wrapped.writeUInt32LE(cipher.length); cipher.copy(wrapped, 4); return wrapped },
      decryptBytes(bytes: Uint8Array, aad: string, max: number) { const buffer = Buffer.from(bytes); return real.decryptBytes(buffer.subarray(4, 4 + buffer.readUInt32LE(0)), aad, max) }
    }
    const store = new AgentThreadHtmlStore(codec, path.join(root, 'budget.sqlite')); stores.push(store)
    let first!: { id: string; operationId: string; expectedRevision: number; content: HtmlCheckpointContent }
    const count = Math.floor(LIMITS.totalCipherBytes / LIMITS.cipherBytes)
    for (let i = 0; i < count; i++) {
      const request = { id: randomUUID(), operationId: 'save', expectedRevision: 0, content: contents() }; if (!i) first = request
      store.save({ ...scope, conversationId: `scope-${Math.floor(i / 8)}` }, request)
    }
    expect(store.save({ ...scope, conversationId: 'scope-0' }, { ...first, expectedRevision: 1, operationId: 'replace' })).toMatchObject({ storageRevision: 2 })
    const overflow = { ...first, id: randomUUID(), expectedRevision: 0 }
    expect(() => store.save({ ...scope, conversationId: 'new-scope' }, overflow)).toThrow('storage budget')
    expect(store.read({ ...scope, conversationId: 'new-scope' }, overflow.id)).toBeUndefined()
  })
  it.each([4096, 65536])('derives its96MiB physical page ceiling for %i-byte SQLite pages', size => {
    const t = setup(size), db = new NodeSQLiteAdapter(t.file)
    try { expect(db.get('PRAGMA page_size')?.page_size).toBe(size) } finally { db.close() }
    t.store.save(scope, t.request)
    // Verify on the owned connection: max_page_count is connection-local.
    const internal = (t.store as unknown as { db: NodeSQLiteAdapter }).db
    expect(internal.get('PRAGMA max_page_count')?.max_page_count).toBe(Math.floor(LIMITS.databaseBytes / size))
  })
  it('refuses linked database files/directories and relative paths without touching originals', () => {
    const t = setup(), alias = path.join(t.root, 'alias.sqlite'); linkSync(t.file, alias)
    expect(() => new AgentThreadHtmlStore(t.codec, alias)).toThrow('Unsafe')
    rmSync(alias)
    const real = path.join(t.root, 'real'); mkdirSync(real); const junction = path.join(t.root, 'junction'); symlinkSync(real, junction, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => new AgentThreadHtmlStore(t.codec, path.join(junction, 'linked.sqlite'))).toThrow('Unsafe')
    expect(() => new AgentThreadHtmlStore(t.codec, 'relative.sqlite')).toThrow('absolute')
  })
})
